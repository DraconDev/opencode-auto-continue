import type { Plugin } from "@opencode-ai/plugin";
import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { TypedPluginInput } from "./types.js";
import { type PluginConfig, DEFAULT_CONFIG, validateConfig } from "./config.js";
import { type SessionState, createSession } from "./session-state.js";
import {
  PLAN_PATTERNS,
  isPlanContent,
  estimateTokens,
  formatDuration,
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
import { createAIAdvisor } from "./ai-advisor.js";
import { createSessionMonitor } from "./session-monitor.js";

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
  let config: PluginConfig = {
    ...DEFAULT_CONFIG,
    ...(typeof options === "object" && options !== null ? options as Partial<PluginConfig> : {}),
  };
  
  config = validateConfig(config);

  const sessions = new Map<string, SessionState>();
  let isDisposed = false;

  function getSession(id: string): SessionState {
    if (!sessions.has(id)) {
      sessions.set(id, createSession());
    }
    return sessions.get(id)!;
  }

  function clearTimer(id: string) {
    const s = sessions.get(id);
    if (!s) return;
    // FIX 6: Clear all timers, not just recovery timer
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    if (s.nudgeTimer) {
      clearTimeout(s.nudgeTimer);
      s.nudgeTimer = null;
    }
    if (s.reviewDebounceTimer) {
      clearTimeout(s.reviewDebounceTimer);
      s.reviewDebounceTimer = null;
    }
  }

  function resetSession(id: string) {
    clearTimer(id);
    const s = sessions.get(id);
    if (s) {
      s.planBuffer = '';
      s.planning = false;
      s.compacting = false;
      s.backoffAttempts = 0;
      s.autoSubmitCount = 0;
      s.lastUserMessageId = '';
      s.sentMessageAt = 0;
      s.reviewFired = false;
      if (s.reviewDebounceTimer) {
        clearTimeout(s.reviewDebounceTimer);
        s.reviewDebounceTimer = null;
      }
      if (s.nudgeTimer) {
        clearTimeout(s.nudgeTimer);
        s.nudgeTimer = null;
      }
      s.lastNudgeAt = 0;
      s.nudgeCount = 0;
      s.nudgePaused = false;
      s.hasOpenTodos = false;
      s.lastKnownTodos = [];
      s.lastTodoSnapshot = "";
      s.needsContinue = false;
      s.continueMessageText = '';
      s.continueRetryCount = 0;
      s.lastContinueRetryAt = 0;
      s.timerGeneration = 0;
      s.planningStartedAt = 0;
      s.messageCount = 0;
      s.estimatedTokens = 0;
      s.lastCompactionAt = 0;
      s.tokenLimitHits = 0;
      s.actionStartedAt = 0;
      s.stallDetections = 0;
      s.recoverySuccessful = 0;
      s.recoveryFailed = 0;
      s.lastRecoverySuccess = 0;
      s.totalRecoveryTimeMs = 0;
      s.recoveryStartTime = 0;
      s.recoveryTimes = [];
      s.lastStallPartType = '';
      s.continueTimestamps = [];
      s.lastAdvisoryAdvice = null;
      s.stallPatterns = {};
      s.lastPlanItemDescription = "";
      s.nudgeFailureCount = 0;
      s.lastNudgeFailureAt = 0;
      s.continueInProgress = false;
      s.lastContinueAt = 0;
      s.lastOutputAt = Date.now();
      s.lastOutputLength = 0;
      s.statusHistory = [];
    }
    sessions.delete(id);
  }

  const logDir = join(process.env.HOME || "/tmp", ".opencode", "logs");
  const logFile = join(logDir, "auto-force-resume.log");

  function ensureLogDir() {
    try {
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }
    } catch {
      // ignore
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
      // ignore file errors silently
    }
  }
  
  const customPromptRuntime = registerCustomPromptRuntime({
    input,
    config,
    sessions,
    log,
  });

  const terminal = createTerminalModule({ config, sessions, log, input });
  const aiAdvisor = createAIAdvisor({ config, log, input });
  const nudge = createNudgeModule({ config, sessions, log, isDisposed: () => isDisposed, input });

  const { writeStatusFile, clearPendingWrites } = createStatusFileModule({ config, sessions, log });

  const compaction = createCompactionModule({ config, sessions, log, input });

  const review = createReviewModule({ config, sessions, log, input, isDisposed: () => isDisposed, writeStatusFile, isTokenLimitError: compaction.isTokenLimitError, forceCompact: compaction.forceCompact });

  function scheduleRecovery(sessionId: string, delayMs: number): void {
    scheduleRecoveryWithGeneration(sessions, sessionId, delayMs, (id) => recover(id), log);
  }

  const { recover } = createRecoveryModule({ config, sessions, log, input, isDisposed: () => isDisposed, writeStatusFile, cancelNudge: nudge.cancelNudge, scheduleRecovery, aiAdvisor, sendContinue: review.sendContinue });

  const sessionMonitor = createSessionMonitor({ config, sessions, log, input, isDisposed: () => isDisposed, recover });
  sessionMonitor.start();

  terminal.registerStatusLineHook();

  const staleTypes = [
    "session.ended",
    "session.deleted"
  ];

  return {
    event: async ({ event }: { event: any }) => {
      await safeHook("event", async () => {
        const e = event as any;
        const sid = e?.properties?.sessionID || e?.properties?.info?.sessionID || e?.properties?.part?.sessionID || "default";

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
                // Show compaction failure toast
                if (config.showToasts) {
                  try {
                    input.client.tui.showToast({
                      query: { directory: input.directory || "" },
                      body: {
                        title: "Compaction Failed",
                        message: "Could not free up tokens. Session may be stuck.",
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
        getSession(sid);
        sessionMonitor.touchSession(sid);
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
          }
          // NOTE: s.planning is NOT cleared here — session.status(busy) fires
          // during plan generation too (the session IS busy). Clearing it would
          // cause plan-aware continue messages to use the generic message instead.
          // Instead, s.planning is cleared by message.part.updated when non-plan
          // progress parts (tool, file, subtask, step-start, step-finish) arrive.
          if (s.compacting) {
            log('session busy, clearing compacting flag (compaction likely finished)');
            s.compacting = false;
          }
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
        // Nudge is always scheduled on idle — injectNudge fetches todos from API
        // and decides whether to send based on actual pending count
        if (status?.type === "idle" && !s.needsContinue && config.nudgeEnabled) {
          nudge.scheduleNudge(sid);
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
            updateProgress(s);
            sessionMonitor.touchSession(sid);
            s.attempts = 0;
            s.userCancelled = false;
            // Track part type for stall pattern detection
            s.lastStallPartType = partType || "unknown";
            
            // Track actual output for busy-but-dead detection
            s.lastOutputAt = Date.now();
            
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
            // Extract actual tokens from step-finish parts (most accurate source)
            if (partType === "step-finish" && part?.tokens) {
              const stepTokens = part.tokens;
              const totalStepTokens = (stepTokens.input || 0) + (stepTokens.output || 0) + (stepTokens.reasoning || 0);
              if (totalStepTokens > 0) {
                // step-finish tokens represent the actual tokens used in this completion step
                // This is the most accurate token count available
                s.estimatedTokens = Math.max(s.estimatedTokens, totalStepTokens);
                log('step-finish tokens:', totalStepTokens, 'input:', stepTokens.input, 'output:', stepTokens.output, 'reasoning:', stepTokens.reasoning, 'session:', sid);
              }
            }
          }

          compaction.maybeProactiveCompact(sid).catch((e: unknown) => log('proactive compact check failed:', e));

          // Handle compaction parts (outside isRealProgress check - compaction is always tracked)
          if (partType === "compaction") {
            log('compaction started, pausing stall monitoring');
            s.compacting = true;
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
        }
        if (s.compacting) {
          log('activity after compaction, clearing compacting flag');
          s.compacting = false;
        }
        clearTimer(sid);
        if (!s.planning && !s.compacting) {
          scheduleRecovery(sid, config.stallTimeoutMs);
        }
        writeStatusFile(sid);
        return;
      }

      if (event?.type === "todo.updated") {
        const todos = e?.properties?.todos;
        if (!Array.isArray(todos)) return;
        
        const s = getSession(sid);
        const allCompleted = todos.length > 0 && todos.every((t: any) => t.status === 'completed' || t.status === 'cancelled');
        const hasPending = todos.some((t: any) => t.status === 'in_progress' || t.status === 'pending');
        
        // Track open todos for nudging
        s.hasOpenTodos = hasPending;
        s.lastKnownTodos = todos;
        
        // Handle review on completion
        if (allCompleted && !s.reviewFired && config.reviewOnComplete) {
          if (s.reviewDebounceTimer) {
            clearTimeout(s.reviewDebounceTimer);
          }
          s.reviewDebounceTimer = setTimeout(() => {
            s.reviewDebounceTimer = null;
            review.triggerReview(sid);
          }, config.reviewDebounceMs);
        } else if (!allCompleted && s.reviewDebounceTimer) {
          clearTimeout(s.reviewDebounceTimer);
          s.reviewDebounceTimer = null;
        }

        // FIX 7: Reset reviewFired when new pending todos appear after review was fired
        // This enables the test-fix loop: review creates fix todos → review fires again
        if (hasPending && s.reviewFired) {
          log('new pending todos detected after review, resetting review flag:', sid);
          s.reviewFired = false;
        }

        // Nudge is triggered by session.idle — todo.updated just sets hasOpenTodos flag
        writeStatusFile(sid);
        return;
      }

      // session.idle fires when the model stops generating and goes idle
      // Schedule a nudge after delay (nudge module handles cooldown, loop protection, etc.)
      if (event?.type === "session.idle") {
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
        compaction.maybeProactiveCompact(sid).catch((e: unknown) => log('proactive compact check failed:', e));
         return;
        }
        nudge.scheduleNudge(sid);
        writeStatusFile(sid);
        return;
      }

      // session.compacted fires when context compaction completes
      // The session is still active after compaction, so preserve state
      if (event?.type === "session.compacted") {
        const s = getSession(sid);
        log('session compacted, clearing compacting flag:', sid);
        s.compacting = false;
        s.lastCompactionAt = Date.now();
        s.estimatedTokens = Math.floor(s.estimatedTokens * (1 - config.compactReductionFactor));
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
        s.needsContinue = true;
        s.continueMessageText = s.planning ? config.continueWithPlanMessage : config.shortContinueMessage;
        review.sendContinue(sid).catch((e) => log('continue after compaction failed:', e));
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
    "experimental.session.compacting": async (_input, output) => {
      // Inject session state into compaction to preserve important context
      const sid = (_input as any)?.sessionID || "default";
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
      
      const sid = (_input as any)?.sessionID || "default";
      const s = sessions.get(sid);
      if (s && s.needsContinue) {
        // Our recovery flow already queued a continue, let it handle it
        log('autocontinue disabled for session:', sid, '- using custom continue');
      }
    },
    dispose: () => {
      log('disposing plugin');
      isDisposed = true;
      sessionMonitor.stop();
      clearPendingWrites();
      clearMessagesCache();
      invalidateModelLimitCache();
      unregisterCustomPromptRuntime(customPromptRuntime);
      customPromptRuntimes.clear();
      latestCustomPromptRuntime = null;
      sessions.forEach((s) => {
        if (s.timer) {
          clearTimeout(s.timer);
          s.timer = null;
        }
        if (s.reviewDebounceTimer) {
          clearTimeout(s.reviewDebounceTimer);
          s.reviewDebounceTimer = null;
        }
        if (s.nudgeTimer) {
          clearTimeout(s.nudgeTimer);
          s.nudgeTimer = null;
        }
      });
      sessions.clear();
    }
  };
};
