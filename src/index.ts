import type { Plugin } from "@opencode-ai/plugin";
import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { TypedPluginInput } from "./types.js";
import { type PluginConfig, DEFAULT_CONFIG, validateConfig } from "./config.js";
import { type SessionState, createSession, getTokenCount, clearAllSessionTimers } from "./session-state.js";
import {
  isPlanContent,
  containsToolCallAsText,
  estimateTokens,
  parseTokensFromError,
  updateProgress,
  formatMessage,
  safeHook,
  shouldBlockPrompt,
  scheduleRecoveryWithGeneration,
  getMessageText,
  clearMessagesCache,
  invalidateModelLimitCache,
} from "./shared.js";
import { createTerminalModule } from "./terminal.js";
import { createNudgeModule } from "./nudge.js";
import { createStatusFileModule } from "./status-file.js";
import { createRecoveryModule } from "./recovery.js";
import { createCompactionModule } from "./compaction.js";
import { createReviewModule } from "./review.js";
import { createSessionMonitor } from "./session-monitor.js";
import { createStopConditionsModule } from "./stop-conditions.js";
import { createTestRunner } from "./test-runner.js";
import { createTodoPoller } from "./todo-poller.js";
import { getSessionTokens, getDbLastError, closeDb } from "./tokens.js";
import { containsDangerousCommand, formatDangerousBlocklist } from "./dangerous-commands.js";

import type { Todo } from "./session-state.js";

export interface CustomPromptOptions {
  message: string;
  includeTodoContext?: boolean;
  includeContextSummary?: boolean;
  customPrompt?: string;
}

export interface CustomPromptResult {
  success: boolean;
  message: string;
  todos?: Todo[];
  customPrompt?: string;
  contextSummary?: string;
  error?: string;
}

interface CustomPromptRuntime {
  input: TypedPluginInput;
  config: PluginConfig;
  sessions: Map<string, SessionState>;
  log: (...args: unknown[]) => void;
}

const customPromptRuntimes = new Set<CustomPromptRuntime>();
let latestCustomPromptRuntime: CustomPromptRuntime | null = null;

function registerCustomPromptRuntime(runtime: CustomPromptRuntime): CustomPromptRuntime {
  // Prune stale references to prevent leaks on hot reload
  for (const existing of customPromptRuntimes) {
    if (existing.sessions === runtime.sessions || existing.input === runtime.input) {
      customPromptRuntimes.delete(existing);
    }
  }
  customPromptRuntimes.add(runtime);
  latestCustomPromptRuntime = runtime;
  return runtime;
}

function unregisterCustomPromptRuntime(runtime: CustomPromptRuntime): void {
  customPromptRuntimes.delete(runtime);
  if (latestCustomPromptRuntime === runtime) {
    latestCustomPromptRuntime = Array.from(customPromptRuntimes).at(-1) || null;
  }
}

function getCustomPromptRuntime(sessionId: string): CustomPromptRuntime | null {
  for (const runtime of customPromptRuntimes) {
    if (runtime.sessions.has(sessionId)) return runtime;
  }
  return latestCustomPromptRuntime;
}

function buildContextSummary(pending: Todo[], recentMessages: any[]): string {
  if (pending.length > 0) {
    const todoList = pending
      .slice(0, 5)
      .map((todo) => todo.content || todo.title || todo.id)
      .join(", ");
    return `Working on ${pending.length} open task(s): ${todoList}${pending.length > 5 ? "..." : ""}.`;
  }

  for (let i = recentMessages.length - 1; i >= 0; i--) {
    const msg = recentMessages[i] as any;
    const role = msg?.role || msg?.info?.role;
    if (role !== "assistant") continue;
    const text = getMessageText(msg).replace(/\s+/g, " ").slice(0, 180);
    if (text) return `Recent assistant activity: ${text}${text.length === 180 ? "..." : ""}`;
  }

  return "No recent session context is available.";
}

function isSyntheticMessageEvent(e: any): boolean {
  const props = e?.properties || {};
  const info = props.info || {};
  const part = props.part || {};

  if (props.synthetic === true || info.synthetic === true || part.synthetic === true) {
    return true;
  }

  const parts = [
    ...(Array.isArray(props.parts) ? props.parts : []),
    ...(Array.isArray(info.parts) ? info.parts : []),
    ...(Array.isArray(props.message?.parts) ? props.message.parts : []),
  ];

  return parts.some((p: any) => p?.synthetic === true);
}

export async function sendCustomPrompt(
  sessionId: string,
  options: CustomPromptOptions
): Promise<CustomPromptResult> {
  const runtime = getCustomPromptRuntime(sessionId);
  const template = options.message || options.customPrompt || "";
  if (!runtime) {
    return {
      success: false,
      message: template,
      customPrompt: options.customPrompt,
      error: "No active opencode-auto-continue plugin runtime is available.",
    };
  }

  const { input, config, sessions, log } = runtime;
  const state = sessions.get(sessionId);
  let todos: Todo[] | undefined;
  let recentMessages: any[] = [];

  const vars: Record<string, string> = {
    attempts: String((state?.attempts || 0) + 1),
    maxAttempts: String(config.maxRecoveries),
    pending: "0",
    total: "0",
    completed: "0",
    todoList: "",
    contextSummary: "",
    customPrompt: options.customPrompt || "",
  };

  if (options.includeTodoContext) {
    try {
      const todoResult = await input.client.session.todo({ path: { id: sessionId } });
      todos = Array.isArray(todoResult.data) ? todoResult.data as Todo[] : [];
      const pending = todos.filter((todo) => todo.status === "in_progress" || todo.status === "pending");
      const completed = todos.filter((todo) => todo.status === "completed" || todo.status === "cancelled");

      vars.total = String(todos.length);
      vars.completed = String(completed.length);
      vars.pending = String(pending.length);
      vars.todoList = pending
        .slice(0, 5)
        .map((todo) => todo.content || todo.title || todo.id)
        .join(", ") + (pending.length > 5 ? "..." : "");
    } catch (e) {
      log("custom prompt todo fetch failed:", e);
      todos = [];
    }
  }

  if (options.includeContextSummary) {
    try {
      const messagesResult = await input.client.session.messages({
        path: { id: sessionId },
        query: { limit: 5 },
      });
      recentMessages = Array.isArray(messagesResult.data) ? messagesResult.data : [];
    } catch (e) {
      log("custom prompt message fetch failed:", e);
    }

    const pending = (todos || []).filter((todo) => todo.status === "in_progress" || todo.status === "pending");
    vars.contextSummary = buildContextSummary(pending, recentMessages);
  }

  let messageText = formatMessage(template, vars).trim();
  if (options.customPrompt && !template.includes("{customPrompt}")) {
    messageText = `${messageText}\n\nAdditional instruction: ${options.customPrompt}`.trim();
  }

  if (!messageText) {
    return {
      success: false,
      message: "",
      todos,
      customPrompt: options.customPrompt,
      contextSummary: vars.contextSummary || undefined,
      error: "Custom prompt message is empty.",
    };
  }

  try {
    const isDuplicate = await shouldBlockPrompt(sessionId, messageText, input, log);
    if (isDuplicate) {
      return {
        success: false,
        message: messageText,
        todos,
        customPrompt: options.customPrompt,
        contextSummary: vars.contextSummary || undefined,
        error: "Duplicate prompt blocked.",
      };
    }

    await input.client.session.prompt({
      path: { id: sessionId },
      query: { directory: input.directory || "" },
      body: {
        parts: [{
          type: "text",
          text: messageText,
          synthetic: true,
        }],
      },
    });

    if (state) {
      state.messageCount++;
      state.sentMessageAt = Date.now();
      state.lastNudgeAt = Date.now(); // Prevent immediate nudge after custom prompt
    }

    return {
      success: true,
      message: messageText,
      todos,
      customPrompt: options.customPrompt,
      contextSummary: vars.contextSummary || undefined,
    };
  } catch (e) {
    log("custom prompt send failed:", e);
    return {
      success: false,
      message: messageText,
      todos,
      customPrompt: options.customPrompt,
      contextSummary: vars.contextSummary || undefined,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export const AutoForceResumePlugin: Plugin = async (input, options) => {
  const REAL_TOKEN_REFRESH_INTERVAL_MS = 10000;

  let config: PluginConfig = {
    ...DEFAULT_CONFIG,
    ...(typeof options === "object" && options !== null ? options as Partial<PluginConfig> : {}),
  };
  
  config = validateConfig(config);

  const sessions = new Map<string, SessionState>();
  let disposed = false;
  const isDisposed = () => disposed;

  function getSession(id: string): SessionState {
    if (!sessions.has(id)) {
      sessions.set(id, createSession());
    }
    return sessions.get(id)!;
  }

  function refreshRealTokens(id: string): number {
    const s = getSession(id);
    const now = Date.now();
    if (s.realTokens > 0 && now - s.lastRealTokenRefreshAt < REAL_TOKEN_REFRESH_INTERVAL_MS) {
      return getTokenCount(s);
    }
    s.lastRealTokenRefreshAt = now;
    try {
      const tokens = getSessionTokens(id);
      if (tokens.total > 0) {
        s.realTokens = tokens.total;
        log('refreshRealTokens:', id, 'real=', s.realTokens, 'baseline=', s.realTokensBaseline, 'estimated=', s.estimatedTokens, 'effective=', getTokenCount(s));
      } else {
        log('refreshRealTokens: no real tokens for', id, '(dbErr:', getDbLastError() || 'session has 0 tokens', ')', 'falling back to estimated=', s.estimatedTokens);
      }
    } catch (e) {
      log('refreshRealTokens FAILED for', id, ':', e);
    }
    return getTokenCount(s);
  }

  function clearTimer(id: string) {
    const s = sessions.get(id);
    if (!s) return;
    clearAllSessionTimers(s);
  }

  function resetSession(id: string) {
    const s = sessions.get(id);
    if (s) {
      clearAllSessionTimers(s);
      Object.assign(s, createSession());
    }
    sessions.delete(id);
    todoPoller.cleanupSession(id);
    sessionMonitor.cleanupSession(id);
  }

  const logDir = join(process.env.HOME || "/tmp", ".opencode", "logs");
  const logFile = join(logDir, "auto-force-resume.log");

  function ensureLogDir() {
    try {
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }
    } catch {
      // Cannot log here — log function depends on this directory
    }
  }

  function log(...args: unknown[]) {
    if (!config.debug) return;
    try {
      ensureLogDir();
      const timestamp = new Date().toISOString();
      const message = `[${timestamp}] [auto-force-resume] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`;
      appendFileSync(logFile, message);
    } catch {
      // Logging itself failed — nothing we can do
    }
  }
  
  const customPromptRuntime = registerCustomPromptRuntime({
    input,
    config,
    sessions,
    log,
  });

  const terminal = createTerminalModule({ config, sessions, log });
  const { writeStatusFile, clearPendingWrites } = createStatusFileModule({ config, sessions, log });

  const compaction = createCompactionModule({ config, sessions, log, input });

  // Forward declaration — recovery module sets the actual implementation after creation
  let recoverFn: (sessionId: string) => Promise<void> = async () => {};
  function scheduleRecovery(sessionId: string, delayMs: number): void {
    scheduleRecoveryWithGeneration(sessions, sessionId, delayMs, (id) => recoverFn(id), log);
  }

  const testRunner = createTestRunner({ config, log, input });

  const nudge = createNudgeModule({ config, sessions, log, isDisposed: isDisposed, input, maybeHardCompact: compaction.maybeHardCompact, testRunner });

  const review = createReviewModule({ config, sessions, log, input, isDisposed: isDisposed, writeStatusFile, isTokenLimitError: compaction.isTokenLimitError, forceCompact: compaction.forceCompact, maybeHardCompact: compaction.maybeHardCompact, testRunner });

  const todoPoller = createTodoPoller({ config, sessions, log, isDisposed: isDisposed, input, writeStatusFile, triggerReview: review.triggerReview, maybeOpportunisticCompact: compaction.maybeOpportunisticCompact });
  todoPoller.startPeriodicPoll();

  const { recover } = createRecoveryModule({ config, sessions, log, input, isDisposed: isDisposed, writeStatusFile, cancelNudge: nudge.cancelNudge, scheduleRecovery, sendContinue: review.sendContinue, maybeHardCompact: compaction.maybeHardCompact, forceCompact: compaction.forceCompact });
  recoverFn = recover;

  const stopConditions = createStopConditionsModule({ config, sessions, log });
  const sessionMonitor = createSessionMonitor({ config, sessions, log, isDisposed: isDisposed, recover, checkStopConditions: stopConditions.checkStopConditions });
  sessionMonitor.start();

  const staleTypes = [
    "session.ended",
    "session.deleted"
  ];

  return {
    event: async ({ event }: { event: any }) => {
      await safeHook("event", async () => {
        const e = event as any;
        const sid = e?.properties?.sessionID || e?.properties?.info?.sessionID || e?.properties?.part?.sessionID;
        if (!sid) {
          log('event received without sessionID, skipping:', event?.type);
          return;
        }

        if (event?.type === "session.error") {
        const err = e?.properties?.error;
        log('session.error:', err?.name, err?.message);
        if (err?.name === "MessageAbortedError") {
          const s = sessions.get(sid);
          if (s?.aborting) {
            log('session abort was plugin-initiated, keeping recovery enabled:', sid);
            clearTimer(sid);
            writeStatusFile(sid);
            return;
          }
          if (s) {
            s.userCancelled = true;
            s.lastKnownStatus = 'error';
            nudge.pauseNudge(sid);
          }
          log('user cancelled session:', sid);
        } else if (compaction.isTokenLimitError(err)) {
          const s = sessions.get(sid);
          if (s) {
            s.tokenLimitHits++;
            
            // Parse exact token counts from error message
            const parsedTokens = parseTokensFromError(err);
            if (parsedTokens) {
              s.estimatedTokens = Math.max(s.estimatedTokens, parsedTokens.total);
              log('parsed tokens from error:', parsedTokens.total, 'input:', parsedTokens.input, 'output:', parsedTokens.output, 'session:', sid);
            }
            
            log('token limit error detected (hit #' + s.tokenLimitHits + ') for session:', sid);
            
            // Show token limit toast
            if (config.showToasts) {
              try {
                input.client.tui.showToast({
                  query: { directory: input.directory || "" },
                  body: {
                    title: "Token Limit Reached",
                    message: `Compacting context to free up tokens (hit #${s.tokenLimitHits})...`,
                    variant: "warning",
                  },
                }).catch(() => {});
              } catch (e) {
                // ignore toast errors
              }
            }
            
            // Attempt emergency compaction asynchronously
            compaction.forceCompact(sid).then(async (compacted) => {
              // FIX 4: Check session still exists before accessing state
              if (!sessions.has(sid)) {
                log('session deleted during emergency compaction, skipping continue:', sid);
                return;
              }
              const currentSession = sessions.get(sid)!;
              if (compacted) {
                log('emergency compaction succeeded for session:', sid);
                // Queue a short continue after emergency compaction
                // Use plan-aware message if session was planning
                currentSession.needsContinue = true;
                currentSession.continueMessageText = currentSession.planning ? config.continueWithPlanMessage : config.shortContinueMessage;
                await review.sendContinue(sid);
              } else {
                log('emergency compaction failed for session:', sid);
                // Schedule recovery with backoff instead of abandoning session
                currentSession.backoffAttempts++;
                const backoffDelay = Math.min(
                  config.stallTimeoutMs * Math.pow(2, currentSession.backoffAttempts),
                  config.maxBackoffMs
                );
                log('scheduling recovery after emergency compaction failure, backoff:', backoffDelay, 'ms');
                scheduleRecovery(sid, backoffDelay);
                // Show compaction failure toast
                if (config.showToasts) {
                  try {
                    input.client.tui.showToast({
                      query: { directory: input.directory || "" },
                      body: {
                        title: "Compaction Failed",
                        message: `Could not free up tokens. Will retry recovery in ${Math.round(backoffDelay / 1000)}s.`,
                        variant: "error",
                      },
                    }).catch(() => {});
                  } catch (e) {
                    // ignore toast errors
                  }
                }
              }
            }).catch((e) => {
              log('emergency compaction error:', e);
            });
          }
        }
        clearTimer(sid);
        writeStatusFile(sid);
        return;
      }

      if (event?.type === "session.created") {
        log('session.created:', sid);
        const s = getSession(sid);
        refreshRealTokens(sid);
        sessionMonitor.touchSession(sid);

        // Schedule delayed fallback for dangerous command policy injection.
        // Primary mechanism: experimental.chat.system.transform hook (no wasted turn).
        // If that hook is never called by the runtime, this fallback fires after
        // DANGEROUS_CMD_FALLBACK_MS to inject the policy via session.prompt.
        if (config.dangerousCommandBlocking && config.dangerousCommandInjection) {
          const DANGEROUS_CMD_FALLBACK_MS = 30000;
          s.dangerousCommandPromptTimer = setTimeout(() => {
            s.dangerousCommandPromptTimer = null;
            if (s.systemTransformHookCalled) {
              log('dangerous command policy already injected via system transform hook, skipping session.prompt fallback, session:', sid);
              return;
            }
            if (disposed || !sessions.has(sid)) return;
            log('system transform hook not called after', DANGEROUS_CMD_FALLBACK_MS, 'ms, falling back to session.prompt injection, session:', sid);
            input.client.session.prompt({
              path: { id: sid },
              query: { directory: input.directory || "" },
              body: {
                parts: [{
                  type: "text",
                  text: `## ⚠️ Dangerous Commands Policy\n\nThe following commands are blocked by policy and must never be used:\n\n${formatDangerousBlocklist()}\n\nIf you need one of these for a legitimate reason, explain why and it can be approved manually.`,
                  synthetic: true,
                }],
              },
            }).catch((e: any) => log('dangerous command fallback injection failed:', e));
          }, DANGEROUS_CMD_FALLBACK_MS);
          if (s.dangerousCommandPromptTimer && (s.dangerousCommandPromptTimer as any).unref) {
            (s.dangerousCommandPromptTimer as any).unref();
          }
        }

        writeStatusFile(sid);
        return;
      }

      if (event?.type === "session.updated") {
        log('session.updated:', sid);
        // Session was modified (e.g., model/provider change) — preserve state
        writeStatusFile(sid);
        return;
      }

      if (event?.type === "session.diff") {
        // Session diff events are informational — no action needed
        log('session.diff:', sid);
        return;
      }

      if (event?.type === "message.updated") {
        const info = e?.properties?.info;
        const isSynthetic = isSyntheticMessageEvent(e);
        if (info?.role === "user" && isSynthetic) {
          log('ignoring synthetic user message update:', sid);
          writeStatusFile(sid);
          return;
        }
        if (info?.role === "user" && info?.id) {
          const s = getSession(sid);
          if (s.lastUserMessageId !== info.id) {
            s.lastUserMessageId = info.id;
            s.autoSubmitCount = 0;
            s.attempts = 0;
            s.backoffAttempts = 0;
            s.lastNudgeAt = 0; // Prevent false "Session Resumed" toast
            s.lastContinueAt = 0; // Prevent false "Recovery Successful" toast
            // Reset output timestamps so text-only stall timer gives AI fresh start
            s.lastOutputAt = Date.now();
            s.lastToolExecutionAt = Date.now();
            nudge.resetNudge(sid);
            log('user message detected, resetting counters:', sid);
          }
        }
        // Track actual tokens from assistant messages
        if (info?.role === "assistant" && info?.tokens) {
          const s = getSession(sid);
          const msgTokens = info.tokens;
          const totalMsgTokens = (msgTokens.input || 0) + (msgTokens.output || 0) + (msgTokens.reasoning || 0);
          if (totalMsgTokens > 0) {
            // AssistantMessage.tokens represents tokens for this specific message
            // We accumulate to get a rough total (this will be an overestimate since
            // it counts all messages, not just the ones in context window)
            s.estimatedTokens += totalMsgTokens;
            log('assistant message tokens:', totalMsgTokens, 'input:', msgTokens.input, 'output:', msgTokens.output, 'reasoning:', msgTokens.reasoning, 'session:', sid);
          }

        }
        writeStatusFile(sid);
        return;
      }

      if (event?.type === "session.status") {
        const status = e?.properties?.status;
        log('session.status:', sid, status?.type);
        const s = getSession(sid);
        
        if (status?.type === "busy" || status?.type === "retry") {
          // NOTE: We do NOT call updateProgress() here because "busy" status
          // pings don't mean actual progress. Only real output (text, tools, etc.)
          // should reset the progress timer. This prevents the "busy but dead"
          // stall where the AI is stuck but keeps reporting busy.
          sessionMonitor.touchSession(sid);
          s.userCancelled = false;
          if (s.actionStartedAt === 0) {
            s.actionStartedAt = Date.now();
          }
          
          // Schedule recovery timer for normal stall detection
          // (lastProgressAt is NOT updated, so timer will fire based on actual output time)
          if (!s.planning && !s.compacting) {
            scheduleRecovery(sid, config.stallTimeoutMs);
          }
          
          // Check for busy-but-dead: session claims busy but no actual output for too long
          const timeSinceOutput = Date.now() - s.lastOutputAt;
          if (timeSinceOutput > config.busyStallTimeoutMs) {
            const stop = stopConditions.checkStopConditions(sid);
            if (stop.shouldStop) {
              log('[StopConditions] session stopped, skipping busy-but-dead recovery:', stop.reason);
              clearTimer(sid);
            } else {
              const timeSinceToolExecution = Date.now() - s.lastToolExecutionAt;
              // If tool execution is recent, the session may be running long tools (e.g., subagents, long builds).
              // Reschedule recovery instead of aborting — don't interrupt legitimate work.
              if (timeSinceToolExecution < config.busyStallTimeoutMs) {
                log('busy-but-dead rescheduling: no output for', timeSinceOutput, 'ms but tool execution recent (' + timeSinceToolExecution + 'ms), session may be running long tools');
                scheduleRecovery(sid, config.stallTimeoutMs);
              } else {
                log('busy-but-dead detected: no output for', timeSinceOutput, 'ms, forcing recovery');
                if (config.showToasts) {
                  try {
                    input.client.tui.showToast({
                      query: { directory: input.directory || "" },
                      body: {
                        title: "Session Stuck",
                        message: `Session busy but no output for ${Math.round(timeSinceOutput / 1000)}s. Forcing recovery...`,
                        variant: "warning",
                      },
                    }).catch(() => {});
                  } catch (e) {
                    // ignore toast errors
                  }
                }
                recover(sid).catch((e: unknown) => log('busy-but-dead recovery failed:', e));
              }
            }
          }

          // Check for text-only stall: session outputting text/reasoning but no tool execution
          // This catches the "stuck toolcalling" scenario where the model generates
          // tool calls as text/reasoning instead of actually executing them.
          const timeSinceToolExecution = Date.now() - s.lastToolExecutionAt;
          if (config.textOnlyStallTimeoutMs > 0 && timeSinceToolExecution > config.textOnlyStallTimeoutMs && timeSinceOutput <= config.busyStallTimeoutMs) {
            const stop = stopConditions.checkStopConditions(sid);
            if (stop.shouldStop) {
              log('[StopConditions] session stopped, skipping text-only stall recovery:', stop.reason);
            } else {
              log('text-only stall detected: no tool execution for', timeSinceToolExecution, 'ms (output is recent), forcing recovery');
              if (config.showToasts) {
                try {
                  input.client.tui.showToast({
                    query: { directory: input.directory || "" },
                    body: {
                      title: "Text-Only Stall",
                      message: `No tool execution for ${Math.round(timeSinceToolExecution / 1000)}s — recovering session.`,
                      variant: "warning",
                    },
                  }).catch(() => {});
                } catch (e) {}
              }
              recover(sid).catch((e: unknown) => log('text-only stall recovery failed:', e));
            }
          }
          
          // Check for tool loop: same tool called N times without progress
          if (s.toolRepeatCount >= config.toolLoopMaxRepeats) {
            const stop = stopConditions.checkStopConditions(sid);
            if (stop.shouldStop) {
              log('[StopConditions] session stopped, skipping tool loop recovery:', stop.reason);
            } else {
              log('tool loop recovery: tool', s.lastToolName, 'repeated', s.toolRepeatCount, 'times, forcing recovery');
              s.toolRepeatCount = 0;
              recover(sid).catch((e: unknown) => log('tool loop recovery failed:', e));
            }
          }
          
          // Show "Session Resumed" toast if progress detected after recent nudge
          if (s.lastNudgeAt > 0 && Date.now() - s.lastNudgeAt < 30000) {
            if (config.showToasts) {
              try {
                input.client.tui.showToast({
                  query: { directory: input.directory || "" },
                  body: {
                    title: "Session Resumed",
                    message: "The AI has resumed working after the nudge.",
                    variant: "info",
                  },
                }).catch(() => {});
              } catch (e) {
                // ignore toast errors
              }
            }
            s.lastNudgeAt = 0; // Reset to avoid duplicate toasts
          }
          // Show recovery success toast if AI resumes after continue
          if (s.lastContinueAt > 0 && Date.now() - s.lastContinueAt < 30000) {
            if (config.showToasts) {
              try {
                input.client.tui.showToast({
                  query: { directory: input.directory || "" },
                  body: {
                    title: "Recovery Successful",
                    message: "The AI has resumed working after recovery.",
                    variant: "success",
                  },
                }).catch(() => {});
              } catch (e) {
                // ignore toast errors
              }
            }
            s.lastContinueAt = 0; // Reset to avoid duplicate toasts
            // Opportunistic compaction after recovery
            if (config.opportunisticCompactAfterRecovery && getTokenCount(s) >= config.opportunisticCompactAtTokens) {
              compaction.maybeOpportunisticCompact(sid, 'post-recovery').catch((e: unknown) => log('opportunistic compact post-recovery failed:', e));
            }
          }
          // NOTE: s.planning and s.compacting are NOT cleared here.
          // session.status(busy) fires during compaction/plan generation too.
          // Clearing these flags prematurely would break:
          //   - compacting: attemptCompact() polls s.compacting to detect completion
          //   - planning: plan-aware continue messages need the flag
          // These flags are cleared by their respective event handlers:
          //   - s.compacting → session.compacted event or safety timeout
          //   - s.planning → message.part.updated (non-plan progress parts)
          // Update terminal title and progress
          terminal.updateTerminalTitle(sid);
          terminal.updateTerminalProgress(sid);
        }
        if (status?.type === "idle") {
          s.actionStartedAt = 0;
          clearTimer(sid);
        }
        // Send queued continue when session becomes idle/stable
        if (status?.type === "idle" && s.needsContinue) {
          if (s.aborting) {
            log('session idle while recovery is finalizing, recovery will send queued continue for:', sid);
          } else {
            log('session idle, sending queued continue for:', sid);
            await review.sendContinue(sid);
          }
        }
        // Auto-continue when transitioning busy→idle with pending todos
        // Nudge scheduling is handled ONLY by session.idle event to avoid
        // cancel-schedule-cancel race with session.status(idle).
        if (status?.type === "idle" && !s.needsContinue) {
          // Opportunistic compaction on idle
          if (config.opportunisticCompactOnIdle && getTokenCount(s) >= config.opportunisticCompactAtTokens) {
            compaction.maybeOpportunisticCompact(sid, 'idle').catch((e: unknown) => log('opportunistic compact on idle failed:', e));
          }
        }
        // Clear terminal title/progress when session becomes idle
        if (status?.type === "idle") {
          terminal.clearTerminalTitle();
          terminal.clearTerminalProgress();
        }

        // Only set recovery timer for busy/retry sessions, not for idle
        // Idle sessions should not have a stall recovery timer running
        // NOTE: Recovery timer is already scheduled above in the busy/retry branch (lines 609-611)
        // This duplicate scheduling has been removed to prevent timer cascade.

        writeStatusFile(sid);
        return;
      }

      // FIX 19: Replace single-element array with direct comparison
      if (event?.type === "message.part.updated") {
        log('progress event:', event?.type, sid);
        const s = getSession(sid);
        const part = e?.properties?.part;
        const partType = part?.type;
          
          // CRITICAL: Ignore synthetic messages to prevent infinite loops
          if (part?.synthetic === true) {
            log('ignoring synthetic message part');
            return;
          }
          
          const isRealProgress = partType === "text" || partType === "step-finish" || partType === "reasoning" || partType === "tool" || partType === "step-start" || partType === "subtask" || partType === "file";
          log('message.part.updated:', partType, isRealProgress ? '(progress)' : '(ignored)');
          if (isRealProgress) {
            // Detect tool-call-as-text: if text/reasoning contains XML tool call patterns,
            // do NOT reset progress tracking — this is stuck toolcalling, not real progress.
            let isToolCallAsText = false;
            if (partType === "text" || partType === "reasoning") {
              const partText = e?.properties?.part?.text || "";
              if (containsToolCallAsText(partText)) {
                isToolCallAsText = true;
                log('tool-call-as-text detected in', partType, 'part — NOT resetting progress, session:', sid);
              }
            }

            if (!isToolCallAsText) {
              updateProgress(s);
              sessionMonitor.touchSession(sid);
              s.attempts = 0;
              s.userCancelled = false;
            }
            // Track part type for stall pattern detection
            s.lastStallPartType = partType || "unknown";
            
            // Track actual output for busy-but-dead detection
            // Tool-call-as-text does NOT count as real output — session is stuck
            if (!isToolCallAsText) {
              s.lastOutputAt = Date.now();
            }
            
            // Track text content length to detect even small changes
            if (partType === "text" || partType === "reasoning") {
              const text = e?.properties?.part?.text || "";
              if (text.length > s.lastOutputLength) {
                s.lastOutputLength = text.length;
                log('output tracked: text length', text.length, 'session:', sid);
              }
            } else if (partType === "tool" || partType === "file" || partType === "subtask" || partType === "step-start" || partType === "step-finish") {
              // Non-text output also counts
              s.lastOutputLength++;
              s.lastToolExecutionAt = Date.now();
              // Track tool loop: if same tool called repeatedly, increment counter
              if (partType === "tool") {
                const toolName = part?.name || part?.toolName || "";
                if (toolName === s.lastToolName && toolName) {
                  s.toolRepeatCount++;
                  if (s.toolRepeatCount >= config.toolLoopMaxRepeats) {
                    log('tool loop detected:', toolName, 'repeated', s.toolRepeatCount, 'times, session:', sid);
                  }
                } else {
                  s.toolRepeatCount = 0;
                  s.lastToolName = toolName;
                }

                // Layer 2: Dangerous command detection — fire-and-forget abort
                if (config.dangerousCommandBlocking && (toolName === "bash" || toolName === "shell" || toolName === "execute")) {
                  const partInput = e?.properties?.part?.input;
                  const cmdText = (typeof partInput?.command === 'string' && partInput.command)
                    || (Array.isArray(partInput) && typeof partInput[0] === 'string' && partInput[0])
                    || (typeof partInput === 'string' && partInput)
                    || "";
                  if (cmdText && containsDangerousCommand(cmdText)) {
                    log('DANGEROUS COMMAND BLOCKED — aborting session:', sid, 'tool:', toolName);
                    input.client.session.abort({
                      path: { id: sid },
                      query: { directory: input.directory || "" },
                    }).catch((ae: any) => log('dangerous command abort failed:', ae));
                    input.client.session.prompt({
                      path: { id: sid },
                      query: { directory: input.directory || "" },
                      body: {
                        parts: [{
                          type: "text",
                          text: `The previous command was blocked by the dangerous command policy. Do not attempt to run it again.`,
                          synthetic: true,
                        }],
                      },
                    }).catch((pe: any) => log('dangerous command prompt failed:', pe));
                  }
                }
              } else {
                // Non-tool progress resets tool loop counter
                s.toolRepeatCount = 0;
                s.lastToolName = '';
              }
              // Reset nudge count on real progress — AI is responding to nudge
              if (s.nudgeCount > 0) {
                log('resetting nudge count after real progress:', partType, 'was:', s.nudgeCount);
                s.nudgeCount = 0;
              }
              // Resume nudging after recovery — if AI is executing tools again,
              // it's safe to nudge on the next idle cycle
              if (s.nudgePaused) {
                log('resuming nudge after post-recovery progress:', partType, 'session:', sid);
                s.nudgePaused = false;
              }
              log('output tracked:', partType, 'session:', sid);
            }
            
            // FIX 5: Estimate tokens only for parts without actual token counts.
            // Text/reasoning parts are counted via message.updated (actual tokens).
            // Tool/file/subtask/step-start parts need estimation since they lack token metadata.
            let partText = "";
            if (partType === "tool") {
              partText = JSON.stringify(e?.properties?.part) || "";
            } else if (partType === "file") {
              partText = (e?.properties?.part?.url || "") + " " + (e?.properties?.part?.mime || "");
            } else if (partType === "subtask") {
              partText = (e?.properties?.part?.prompt || "") + " " + (e?.properties?.part?.description || "");
            } else if (partType === "step-start") {
              partText = e?.properties?.part?.name || "";
            }
            
            if (partText) {
              // FIX 5: Use configurable multiplier instead of hardcoded ×2
              const estimatedTokens = estimateTokens(partText, config.tokenEstimateMultiplier);
              s.estimatedTokens += estimatedTokens;
            }
            
            // Track recovery intent — what was the AI doing before it stalled?
            if (partType === "tool") {
              const toolName = part?.name || part?.toolName || "";
              if (toolName) {
                s.lastToolCall = toolName;
                s.lastToolSummary = `ran ${toolName}`;
              }
            } else if (partType === "file") {
              const fileUrl = part?.url || "";
              if (fileUrl) {
                s.lastFileEdited = fileUrl;
                s.lastToolSummary = `edited ${fileUrl.split("/").pop()}`;
              }
            } else if (partType === "subtask") {
              const subtaskName = part?.name || part?.description || part?.prompt || "";
              if (subtaskName) {
                s.lastToolSummary = `working on subtask: ${subtaskName.slice(0, 80)}`;
              }
            } else if (partType === "step-start") {
              const stepName = part?.name || "";
              if (stepName) {
                s.lastToolSummary = `step: ${stepName.slice(0, 80)}`;
              }
            }
            // Extract actual tokens from step-finish parts (most accurate source)
            if (partType === "step-finish" && part?.tokens) {
              const stepTokens = part.tokens;
              const totalStepTokens = (stepTokens.input || 0) + (stepTokens.output || 0) + (stepTokens.reasoning || 0);
              if (totalStepTokens > 0) {
                if (s.realTokensBaseline > 0 && totalStepTokens > s.estimatedTokens) {
                  log('step-finish tokens ignored (post-compaction, tokens likely pre-compaction):', totalStepTokens, 'estimated:', s.estimatedTokens, 'session:', sid);
                } else {
                  s.estimatedTokens = Math.max(s.estimatedTokens, totalStepTokens);
                  log('step-finish tokens:', totalStepTokens, 'input:', stepTokens.input, 'output:', stepTokens.output, 'reasoning:', stepTokens.reasoning, 'session:', sid);
                }
              }
            }
          }

          refreshRealTokens(sid);
          log('[Compaction] token check:', sid, 'effective=', getTokenCount(s), 'real=', s.realTokens, 'baseline=', s.realTokensBaseline, 'estimated=', s.estimatedTokens, 'proactiveThreshold=', config.proactiveCompactAtTokens, 'hardThreshold=', config.hardCompactAtTokens);
          compaction.maybeProactiveCompact(sid).then((proactiveOk) => {
            if (!proactiveOk) compaction.maybeHardCompact(sid).catch((e: unknown) => log('hard compact escalation failed:', e));
          }).catch((e: unknown) => log('proactive compact check failed:', e));

          // Handle compaction parts (outside isRealProgress check - compaction is always tracked)
          if (partType === "compaction") {
            log('compaction started, pausing stall monitoring');
            clearTimer(sid);
            s.compacting = true;
            // Safety timeout: if session.compacted never fires (event dropped or
            // compaction failed silently), force-clear the flag so the session
            // isn't stuck forever. Only start if attemptCompact() hasn't already
            // started one.
            if (config.compactionSafetyTimeoutMs > 0 && !s.compactionSafetyTimer) {
              s.compactionSafetyTimer = setTimeout(() => {
                if (s.compacting) {
                  log('[Compaction] SAFETY TIMEOUT — compacting flag stuck for', sid, ', force-clearing after', config.compactionSafetyTimeoutMs, 'ms');
                  s.compactionTimedOut = true;
                  s.compacting = false;
                  s.hardCompactionInProgress = false;
                  if (s.hasOpenTodos && config.nudgeEnabled && !s.planning) {
                    s.nudgeRetryCount = 0;
                    log('[Compaction] re-scheduling nudge after safety timeout, session:', sid);
                    nudge.scheduleNudge(sid);
                  }
                }
              }, config.compactionSafetyTimeoutMs);
              if (s.compactionSafetyTimer.unref) s.compactionSafetyTimer.unref();
            }
          }

          // Handle text parts for plan detection
          if (partType === "text") {
            const partText = e?.properties?.part?.text as string | undefined;
            if (partText) {
              if (isPlanContent(partText)) {
                log('plan detected in updated text part, pausing stall monitoring');
                s.planning = true;
                s.planningStartedAt = Date.now(); // FIX 3: Track when planning started
                // Schedule planning timeout recovery
                clearTimer(sid);
                scheduleRecovery(sid, config.planningTimeoutMs);
              }
            }
          }

          // Clear plan flag on non-plan progress (tool calls, file ops, step transitions).
          // These indicate the model has moved from planning to execution, so:
          // 1. Stall monitoring resumes (planning pauses it)
          // 2. Continue messages use generic text instead of plan-aware message
          if (s.planning && (partType === "tool" || partType === "file" || partType === "subtask" || partType === "step-start" || partType === "step-finish")) {
            log('non-plan progress detected, clearing plan flag');
            s.planning = false;
            s.planBuffer = '';
            // Schedule normal recovery now that planning is done
            scheduleRecovery(sid, config.stallTimeoutMs);
          }

        // Check if this is a delta update containing plan content
        const deltaText = e?.properties?.delta as string | undefined;
        if (deltaText) {
          s.planBuffer = (s.planBuffer + deltaText).slice(-200);
          if (isPlanContent(s.planBuffer)) {
            log('plan detected in delta, pausing stall monitoring — user must address');
            s.planning = true;
            s.planningStartedAt = Date.now(); // FIX 3: Track when planning started
            s.planBuffer = '';
            // Schedule planning timeout recovery instead of leaving timer cleared
            clearTimer(sid);
            scheduleRecovery(sid, config.planningTimeoutMs);
          }
        }

        // Only schedule normal recovery if not planning
        if (!s.planning && !s.compacting) {
          clearTimer(sid);
          scheduleRecovery(sid, config.stallTimeoutMs);
        } else if (s.planning && !s.timer) {
          // Ensure planning has a timeout timer
          scheduleRecovery(sid, config.planningTimeoutMs);
        }
        writeStatusFile(sid);
        return;
      }

      if (event?.type === "message.created" || event?.type === "message.part.added") {
        // Check if this is a real user message (not our synthetic prompt)
        const msgRole = e?.properties?.info?.role;
        const isSynthetic = isSyntheticMessageEvent(e);
        const isUserMessage = msgRole === "user" && !isSynthetic;

        if (isSynthetic) {
          log('ignoring synthetic message activity event:', event?.type, sid);
          writeStatusFile(sid);
          return;
        }
        
        if (isUserMessage) {
          // User sent a message - cancel any queued continue and process normally
          const s = sessions.get(sid);
          if (s && s.needsContinue) {
            log('user message during recovery, cancelling queued continue');
            s.needsContinue = false;
            s.continueMessageText = '';
          }
        } else {
          // Non-user message (likely our synthetic prompt) - check if we're recovering
          const s = sessions.get(sid);
          if (s && s.needsContinue) {
            log('ignoring synthetic message event during recovery:', event?.type);
            return;
          }
        }
        
        log('activity event:', event?.type, sid, 'role:', msgRole);
        const s = getSession(sid);
        
        // Track message count and estimate tokens for proactive compaction
        if (isUserMessage) {
          s.messageCount++;
          // Estimate tokens from message text (only when actual tokens not available)
          const msgText = e?.properties?.info?.content || e?.properties?.info?.text || '';
          const estimatedTokens = estimateTokens(msgText, config.tokenEstimateMultiplier);
          s.estimatedTokens += estimatedTokens;
          log('message count incremented:', s.messageCount, 'estimated tokens added:', estimatedTokens, 'total:', s.estimatedTokens);
        } else {
          // Also estimate tokens from assistant/tool responses (only when actual tokens not available)
          const msgText = e?.properties?.info?.content || e?.properties?.info?.text || '';
          if (msgText && msgRole !== 'assistant') {
            const estimatedTokens = estimateTokens(msgText, config.tokenEstimateMultiplier);
            s.estimatedTokens += estimatedTokens;
          }
          // Track actual output for busy-but-dead detection (assistant messages are real output)
          s.lastOutputAt = Date.now();
          if (msgText && msgText.length > s.lastOutputLength) {
            s.lastOutputLength = msgText.length;
          }
        }
        
        updateProgress(s);
        s.attempts = 0;
        s.userCancelled = false;
        if (s.planning && isUserMessage) {
          log('user sent message, clearing plan flag');
          s.planning = false;
          s.planBuffer = '';
        }
        if (s.compacting) {
          // NOTE: Do NOT clear s.compacting here. Compaction produces message events,
          // but the flag must stay true until session.compacted fires or safety timeout.
          // Clearing it prematurely breaks attemptCompact()'s flag-based polling.
          log('activity after compaction (not clearing flag — session.compacted event will clear it)');
        }
        clearTimer(sid);
        if (!s.planning && !s.compacting) {
          scheduleRecovery(sid, config.stallTimeoutMs);
        }
        writeStatusFile(sid);
        refreshRealTokens(sid);
        compaction.maybeProactiveCompact(sid).then((proactiveOk) => {
          if (!proactiveOk) compaction.maybeHardCompact(sid).catch((e: unknown) => log('hard compact escalation failed:', e));
        }).catch((e: unknown) => log('proactive compact check failed:', e));
                 return;
      }

      if (event?.type === "todo.updated") {
        const todos = e?.properties?.todos;
        if (!Array.isArray(todos)) return;
        
        todoPoller.markEventTodoReceived(sid);
        todoPoller.processTodos(sid, todos);
        return;
      }

      if (event?.type === "question.asked" && config.autoAnswerQuestions) {
        const props = e?.properties;
        const requestID = props?.id;
        const questions = props?.questions || [];
        log('question.asked:', requestID, 'session:', sid, 'questions:', questions.length);

        if (requestID && questions.length > 0) {
          const SAFE_PATTERNS = /^(yes|ok|okay|confirm|continue|proceed|accept|agree|got it|sure|y)$/i;
          const answers: string[][] = [];
          let allSafe = true;
          for (const q of questions) {
            const opts = q.options || [];
            if (opts.length === 0) { allSafe = false; break; }
            if (opts.length === 1) {
              answers.push([opts[0].label || ""]);
            } else if (config.autoAnswerSafeOnly) {
              const safeOpt = opts.find((o: any) => SAFE_PATTERNS.test(o.label?.trim() || ""));
              if (safeOpt) {
                answers.push([safeOpt.label]);
              } else {
                allSafe = false;
                break;
              }
            } else {
              answers.push([opts[0]?.label || ""]);
            }
          }

          if (!allSafe) {
            log('skipping auto-answer: multi-option question without safe default');
            writeStatusFile(sid);
            return;
          }

          for (let i = 0; i < questions.length; i++) {
            log('auto-answering question:', questions[i].header || questions[i].question, '→', answers[i][0]);
          }

          try {
            const httpClient = (input.client as any)._client;
            if (httpClient) {
              await httpClient.post({
                url: `/question/${requestID}/reply`,
                headers: { "Content-Type": "application/json" },
                body: { answers },
              });
              log('auto-replied to question:', requestID);
            } else {
              log('no HTTP client available for question reply');
            }

            const s = getSession(sid);
            s.lastOutputAt = Date.now();
            s.lastProgressAt = Date.now();
            nudge.cancelNudge(sid);
          } catch (err) {
            log('question auto-reply FAILED:', err);
          }
        }

        writeStatusFile(sid);
        return;
      }

      // session.idle fires when the model stops generating and goes idle
      // Schedule a nudge after delay (nudge module handles cooldown, loop protection, etc.)
      if (event?.type === "session.idle") {
        if (disposed) return;
        const s = getSession(sid);
        clearTimer(sid);
        if (s.needsContinue) {
          if (s.aborting) {
            log('session.idle while recovery is finalizing, recovery will send queued continue for:', sid);
          } else {
            log('session.idle, sending queued continue for:', sid);
            await review.sendContinue(sid);
         }
         writeStatusFile(sid);
         refreshRealTokens(sid);
         compaction.maybeProactiveCompact(sid).then((proactiveOk) => {
           if (!proactiveOk) compaction.maybeHardCompact(sid).catch((e: unknown) => log('hard compact escalation failed:', e));
         }).catch((e: unknown) => log('proactive compact check failed:', e));
          return;
        }

         // Poll todos before deciding nudge — plugin event stream may not
         // have received todo.updated events (confirmed missing in v1.14.51).
         await todoPoller.pollAndProcess(sid);

          const stopCheck = stopConditions.checkStopConditions(sid);
          if (!stopCheck.shouldStop) {
            // Safety net: re-check proactive compact threshold during idle
            // (proactive compact normally only runs during message events, so idle
            // periods after long silent gaps could miss the threshold without this)
            refreshRealTokens(sid);
            compaction.maybeProactiveCompact(sid).catch((e: unknown) => log('proactive compact failed during idle:', e));
            if (config.opportunisticCompactBeforeNudge && getTokenCount(s) >= config.nudgeCompactThreshold) {
              compaction.maybeOpportunisticCompact(sid, 'pre-nudge').catch((e: unknown) => log('opportunistic compact pre-nudge failed:', e));
            }
            nudge.scheduleNudge(sid);
          }
          writeStatusFile(sid);
        return;
      }

      // session.compacted fires when context compaction completes
      // The session is still active after compaction, so preserve state
      if (event?.type === "session.compacted") {
        const s = getSession(sid);
        log('session compacted, clearing compacting flag:', sid);
        s.compacting = false;
        s.compactionTimedOut = false;
        s.lastCompactionFailedAt = 0;
        s.hardCompactionInProgress = false;
        if (s.compactionSafetyTimer) { clearTimeout(s.compactionSafetyTimer); s.compactionSafetyTimer = null; }
        s.lastCompactionAt = Date.now();
        s.estimatedTokens = Math.floor(s.estimatedTokens * config.compactReductionFactor);
        s.realTokensBaseline = s.realTokens;
        // Reset recovery counters since we just freed context space
        s.attempts = 0;
        s.backoffAttempts = 0;
        // Restart stall timer since we just freed context
        clearTimer(sid);
        if (!s.planning && !s.compacting) {
          // FIX 8: Use stallTimeoutMs instead of 0 to avoid aborting legitimately resumed work
          scheduleRecovery(sid, config.stallTimeoutMs);
        }
        // FIX 3: Queue and send continue after compaction to resume work
        // NOTE: Don't check s.aborting — compaction can happen during recovery,
        // and recovery needs the continue to resume after compaction completes.
        if (!s.userCancelled && !disposed) {
          s.needsContinue = true;
          s.continueMessageText = s.planning ? config.continueWithPlanMessage : config.shortContinueMessage;
          review.sendContinue(sid).catch((e) => log('continue after compaction failed:', e));
        }

        // Re-schedule nudge after compaction if there are open todos.
        // Handles the case where nudge retries gave up during compaction
        // (e.g., compaction took >60s or a status check race dropped the retry).
        // The nudge module's cooldown and duplicate guards prevent double-sends.
        if (s.hasOpenTodos && config.nudgeEnabled && !s.planning) {
          s.nudgeRetryCount = 0;
          log('re-scheduling nudge after compaction, session:', sid);
          nudge.scheduleNudge(sid);
        }

        writeStatusFile(sid);
        return;
      }

      if (staleTypes.includes(event?.type)) {
        log('stale event:', event?.type, sid);
        nudge.cancelNudge(sid);
        resetSession(sid);
        writeStatusFile(sid);
        return;
      }
      }, log);
    },
    "experimental.chat.system.transform": async (_input, output) => {
      const sid = (_input as any)?.sessionID;
      if (config.dangerousCommandBlocking && config.dangerousCommandInjection) {
        output.system = output.system || [];
        const policy = `## ⚠️ Dangerous Commands Policy\n\nThe following commands are blocked by policy and must never be used:\n\n${formatDangerousBlocklist()}\n\nIf you need one of these for a legitimate reason, explain why and it can be approved manually.`;
        output.system.push(policy);
        if (sid) {
          const s = sessions.get(sid);
          if (s) s.systemTransformHookCalled = true;
        }
        log('dangerous commands policy injected via system transform hook, session:', sid);
      }
    },
    "experimental.session.compacting": async (_input, output) => {
      // Inject session state into compaction to preserve important context
      const sid = (_input as any)?.sessionID;
      if (!sid) {
        log('experimental.session.compacting hook called without sessionID, skipping');
        return;
      }
      const s = sessions.get(sid);
      
      if (s) {
        const contextLines: string[] = [];
        
        // Preserve active todos
        if (s.lastKnownTodos && s.lastKnownTodos.length > 0) {
          const pending = s.lastKnownTodos.filter(t => t.status === 'in_progress' || t.status === 'pending');
          if (pending.length > 0) {
            contextLines.push(`## Active Tasks`);
            for (const t of pending.slice(0, 5)) {
              contextLines.push(`- ${t.content || t.title || 'Task'} (${t.status})`);
            }
          }
        }
        
        // Preserve planning state
        if (s.planning) {
          contextLines.push(`## Currently Creating Plan`);
          contextLines.push(`The agent was in the middle of creating a plan when compaction occurred.`);
        }
        
        // Add recovery context
        if (s.attempts > 0) {
          contextLines.push(`## Recovery Context`);
          contextLines.push(`Recovery attempts: ${s.attempts}`);
          if (s.recoveryTimes.length > 0) {
            contextLines.push(`Recent recovery durations: ${s.recoveryTimes.slice(-3).map(t => Math.round(t/1000)+'s').join(', ')}`);
          }
        }
        
        // Add token context
        if (getTokenCount(s) > 0) {
          contextLines.push(`## Token Context`);
          contextLines.push(s.realTokens > 0 ? `Tokens: ${s.realTokens.toLocaleString()} (actual)` : `Estimated tokens: ~${s.estimatedTokens}`);
          if (s.tokenLimitHits > 0) {
            contextLines.push(`Token limit hits: ${s.tokenLimitHits}`);
          }
        }
        
        // Add stall pattern context
        if (s.stallDetections > 0) {
          contextLines.push(`## Stall Context`);
          contextLines.push(`Stall detections: ${s.stallDetections}`);
          const patterns = Object.entries(s.stallPatterns);
          if (patterns.length > 0) {
            contextLines.push(`Stall patterns: ${patterns.slice(0, 5).map(([k,v]) => `${k}: ${v}`).join(', ')}`);
          }
        }
        
        // Add nudge context
        if (s.nudgeCount > 0) {
          contextLines.push(`## Nudge Context`);
          contextLines.push(`Nudges sent: ${s.nudgeCount}`);
        }
        
        if (contextLines.length > 0) {
          output.context = output.context || [];
          output.context.push(contextLines.join("\n"));
          log('injected session context into compaction:', sid, 'lines:', contextLines.length);
        }
      }
    },
    "experimental.compaction.autocontinue": async (_input, output) => {
      // Disable OpenCode's generic synthetic continue after compaction
      // We handle our own continue with todo context via the recovery flow
      output.enabled = false;

      const sid = (_input as any)?.sessionID;
      if (!sid) {
        log('experimental.compaction.autocontinue hook called without sessionID, skipping');
        return;
      }
      const s = sessions.get(sid);
      if (s && s.needsContinue) {
        // Our recovery flow already queued a continue, let it handle it
        log('autocontinue disabled for session:', sid, '- using custom continue');
      }
    },
    dispose: () => {
      log('disposing plugin');
      disposed = true;
      sessionMonitor.stop();
      todoPoller.stopPeriodicPoll();
      clearPendingWrites();
      clearMessagesCache();
      invalidateModelLimitCache();
      unregisterCustomPromptRuntime(customPromptRuntime);
      customPromptRuntimes.clear();
      latestCustomPromptRuntime = null;
      sessions.forEach((s) => {
        clearAllSessionTimers(s);
      });
      sessions.clear();
      closeDb();
    }
  };
};
