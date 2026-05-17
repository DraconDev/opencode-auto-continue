import type { Plugin } from "@opencode-ai/plugin";
import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { TypedPluginInput, PluginEvent } from "./types.js";
import { type PluginConfig, DEFAULT_CONFIG, validateConfig } from "./config.js";
import { type SessionState, createSession, getTokenCount, clearAllSessionTimers } from "./session-state.js";
import {
  formatMessage,
  shouldBlockPrompt,
  todoMdInstruction,
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
import { createTodoMdReader } from "./todo-md-reader.js";
import { getSessionTokens, getDbLastError, closeDb, warmupSqlite } from "./tokens.js";
import { type HandlerContext, handleEvent, handleSystemTransform, handleSessionCompacting, handleCompactionAutocontinue } from "./event-handlers.js";

import type { Todo } from "./session-state.js";

/** Options for the {@link sendCustomPrompt} function. */
export interface CustomPromptOptions {
  message: string;
  includeTodoContext?: boolean;
  includeContextSummary?: boolean;
  customPrompt?: string;
}

/** Result returned by {@link sendCustomPrompt}. */
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

/**
 * Send a custom prompt to an active OpenCode session.
 *
 * @param sessionId - The ID of the target session
 * @param options - Prompt options including message text and context inclusion flags
 * @returns Result indicating success/failure and the rendered message
 *
 * @example
 * ```ts
 * const result = await sendCustomPrompt("ses_abc123", {
 *   message: "Continue working on {todoList}",
 *   includeTodoContext: true,
 * });
 * ```
 */
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

/**
 * The main OpenCode plugin. Auto-recovers stalled AI coding sessions with
 * multi-layer compaction, dangerous command blocking, nudge reminders,
 * review-on-completion, and session monitoring.
 */
export const AutoForceResumePlugin: Plugin = async (input, options) => {
  const REAL_TOKEN_REFRESH_INTERVAL_MS = 10000;

  let config: PluginConfig = {
    ...DEFAULT_CONFIG,
    ...(typeof options === "object" && options !== null ? options as Partial<PluginConfig> : {}),
  };
  
  config = validateConfig(config);

  // Pre-load SQLite module so first getSessionTokens call is fast
  warmupSqlite().catch(() => {});

  const sessions = new Map<string, SessionState>();
  let disposed = false;
  const isDisposed = () => disposed;

  function getSession(id: string): SessionState {
    if (!sessions.has(id)) {
      sessions.set(id, createSession());
    }
    return sessions.get(id)!;
  }

  async function refreshRealTokens(id: string): Promise<number> {
    const s = getSession(id);
    const now = Date.now();
    if (s.realTokens > 0 && now - s.lastRealTokenRefreshAt < REAL_TOKEN_REFRESH_INTERVAL_MS) {
      return getTokenCount(s);
    }
    s.lastRealTokenRefreshAt = now;
    try {
      const tokens = await getSessionTokens(id);
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
  const logFile = join(logDir, "auto-continue.log");

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
      const message = `[${timestamp}] [auto-continue] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`;
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

  const todoMdReader = createTodoMdReader({ todoMdPath: config.todoMdPath, log });

  async function sendTodoMdSync(sessionId: string, tasks: string[]): Promise<void> {
    const s = sessions.get(sessionId);
    if (!s || isDisposed()) return;

    const todoMdTaskList = tasks.map((t, i) => `${i + 1}. ${t}`).join("\n");
    const syncMessage = formatMessage(config.todoMdSyncMessage, {
      todoMdPath: config.todoMdPath,
      todoMdTaskList,
      todoMdInstruction: todoMdInstruction(config.todoMdPath, config.todoMdSync),
    });

    const isDuplicate = await shouldBlockPrompt(sessionId, syncMessage, input, log);
    if (isDuplicate) {
      log('todo.md sync: prompt guard blocked duplicate:', sessionId);
      return;
    }

    try {
      await input.client.session.prompt({
        path: { id: sessionId },
        query: { directory: input.directory || "" },
        body: {
          parts: [{
            type: "text",
            text: syncMessage,
            synthetic: true,
          }],
        },
      });
      s.todoMdSyncFired = true;
      s.lastTodoMdSyncAt = Date.now();
      s.messageCount++;
      log('todo.md sync message sent:', { sessionId, tasks: tasks.length });
    } catch (e) {
      log('todo.md sync message send failed:', String(e));
    }
  }

  const nudge = createNudgeModule({ config, sessions, log, isDisposed: isDisposed, input, maybeHardCompact: compaction.maybeHardCompact, testRunner, todoMdReader });

  const review = createReviewModule({ config, sessions, log, input, isDisposed: isDisposed, writeStatusFile, isTokenLimitError: compaction.isTokenLimitError, forceCompact: compaction.forceCompact, maybeHardCompact: compaction.maybeHardCompact, testRunner });

  const todoPoller = createTodoPoller({ config, sessions, log, isDisposed: isDisposed, input, writeStatusFile, triggerReview: review.triggerReview, maybeOpportunisticCompact: compaction.maybeOpportunisticCompact, scheduleNudge: nudge.scheduleNudge, todoMdReader, sendTodoMdSync });
  todoPoller.startPeriodicPoll();

  const { recover } = createRecoveryModule({ config, sessions, log, input, isDisposed: isDisposed, writeStatusFile, cancelNudge: nudge.cancelNudge, scheduleRecovery, sendContinue: review.sendContinue, maybeHardCompact: compaction.maybeHardCompact, forceCompact: compaction.forceCompact });
  recoverFn = recover;

  const stopConditions = createStopConditionsModule({ config, sessions, log });
  const sessionMonitor = createSessionMonitor({ config, sessions, log, isDisposed: isDisposed, recover, checkStopConditions: stopConditions.checkStopConditions });
  sessionMonitor.start();

  const ctx: HandlerContext = {
    input,
    config,
    sessions,
    log,
    isDisposed,
    getSession,
    refreshRealTokens,
    clearTimer,
    resetSession,
    terminal,
    writeStatusFile,
    clearPendingWrites,
    compaction,
    nudge,
    review,
    sessionMonitor,
    stopConditions,
    testRunner,
    todoPoller,
    scheduleRecovery,
    recover,
  };

  return {
    event: async ({ event }: { event: PluginEvent }) => {
      await handleEvent(ctx, event);
    },
    "experimental.chat.system.transform": async (_input, output) => {
      handleSystemTransform(ctx, _input, output);
    },
    "experimental.session.compacting": async (_input, output) => {
      handleSessionCompacting(ctx, _input, output);
    },
    "experimental.compaction.autocontinue": async (_input, output) => {
      handleCompactionAutocontinue(ctx, _input, output);
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
