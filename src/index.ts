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
  detectDCP,
  getDCPVersion,
  shouldBlockPrompt,
  scheduleRecoveryWithGeneration,
  getMessageText,
  clearMessagesCache,
  invalidateModelLimitCache,
  invalidateDCPCache,
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
  
  // Detect DCP and auto-adjust compaction settings
  const hasDCP = detectDCP();
  if (hasDCP) {
    config.dcpDetected = true;
    config.dcpVersion = getDCPVersion();
    if (config.autoCompact) {
      config.autoCompact = false;
      // We'll log this after log function is defined
    }
  }
  
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
  
  // Log DCP detection after log function is available
  if (config.dcpDetected) {
    log('DCP (Dynamic Context Pruning) detected — proactive compaction disabled, DCP handles context optimization');
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
        await handleSessionError(e, sid);
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
        await handleMessageUpdated(e, sid);
        return;
      }

      if (event?.type === "session.status") {
        await handleSessionStatus(e, sid);
        return;
      }

      // FIX 19: Replace single-element array with direct comparison
      if (event?.type === "message.part.updated") {
        await handleMessagePartUpdated(e, sid);
        return;
      }

      if (event?.type === "message.created" || event?.type === "message.part.added") {
        await handleMessageCreated(e, sid);
        return;
      }

      if (event?.type === "todo.updated") {
        await handleTodoUpdated(e, sid);
        return;
      }

      // session.idle fires when the model stops generating and goes idle
      // Schedule a nudge after delay (nudge module handles cooldown, loop protection, etc.)
      if (event?.type === "session.idle") {
        await handleSessionIdle(e, sid);
        return;
      }

      // session.compacted fires when context compaction completes
      // The session is still active after compaction, so preserve state
      if (event?.type === "session.compacted") {
        await handleSessionCompacted(e, sid);
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
      invalidateDCPCache();
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
