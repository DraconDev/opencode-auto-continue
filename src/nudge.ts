import type { PluginConfig } from "./config.js";
import type { SessionState } from "./session-state.js";
import { formatMessage, shouldBlockPrompt, todoMdInstruction } from "./shared.js";
import type { TypedPluginInput } from "./types.js";
import type { TestRunner } from "./test-runner.js";
import type { TodoMdReader } from "./todo-md-reader.js";

export interface NudgeDeps {
  config: Pick<PluginConfig, 
    "nudgeEnabled" | "nudgeIdleDelayMs" | "nudgeMaxSubmits" | 
    "nudgeMessage" | "nudgeCooldownMs" | "includeTodoContext" | 
    "showToasts" | "todoMdPath" | "todoMdSync" | "todoMdSyncMessage">;
  sessions: Map<string, SessionState>;
  log: (...args: unknown[]) => void;
  isDisposed: () => boolean;
  input: TypedPluginInput;
  maybeHardCompact?: (sessionId: string) => Promise<boolean>;
  testRunner?: TestRunner;
  todoMdReader?: TodoMdReader;
}

/**
 * Create the nudge module. Sends gentle reminders when the session is idle
 * with open todos, encouraging the AI to continue working.
 * Nudges use progressively stronger messages and respect:
 * - Max nudge count per session
 * - Pause during compaction/planning
 * - Cooldown between nudges
 */
export function createNudgeModule(deps: NudgeDeps) {
  const { config, sessions, log, isDisposed, input } = deps;

  // Snapshot string from todos (to detect changes)
  function snapshot(todos: Array<{ id: string; status: string }>): string {
    return todos
      .map((t) => `${t.id}:${t.status}`)
      .sort()
      .join(",");
  }

  async function getSessionStatusType(sessionId: string): Promise<string | null> {
    try {
      const statusResult = await input.client.session.status({});
      const statusData = statusResult.data as Record<string, { type: string }>;
      return statusData[sessionId]?.type || null;
    } catch (e) {
      log("error checking session status before nudge (ignored)", String(e));
      return null;
    }
  }

  function cancelNudge(sessionId: string): void {
    const s = sessions.get(sessionId);
    if (s?.nudgeTimer) {
      clearTimeout(s.nudgeTimer);
      s.nudgeTimer = null;
      log("nudge cancelled for session:", sessionId);
    }
    if (s?.nudgeRetryTimer) {
      clearTimeout(s.nudgeRetryTimer);
      s.nudgeRetryTimer = null;
      log("nudge retry cancelled for session:", sessionId);
    }
    if (s) s.nudgeRetryCount = 0;
  }

  // Reset nudge state on user activity
  function resetNudge(sessionId: string): void {
    const s = sessions.get(sessionId);
    if (!s) return;
    cancelNudge(sessionId);
    s.nudgeCount = 0;
    s.nudgeRetryCount = 0;
    s.nudgePaused = false;
    s.nudgeFailureCount = 0;
    s.lastNudgeFailureAt = 0;
    s.lastTodoSnapshot = "";
    log("nudge reset for session:", sessionId);
  }

  // Pause nudge after user abort (ESC key)
  function pauseNudge(sessionId: string): void {
    const s = sessions.get(sessionId);
    if (!s) return;
    cancelNudge(sessionId);
    s.nudgePaused = true;
    log("nudge paused for session:", sessionId);
  }

  // Main nudge injection — called after idle delay
  async function injectNudge(
    sessionId: string,
    knownTodos?: Array<{ id: string; status: string; content?: string; title?: string }>
  ): Promise<void> {
    if (isDisposed()) return;

    const s = sessions.get(sessionId);
    if (!s) return;

    if (!config.nudgeEnabled) {
      log("nudge disabled, skip");
      return;
    }

    if (s.nudgePaused) {
      log("nudge skipped - session paused after abort", sessionId);
      return;
    }

    if (s.needsContinue || s.aborting) {
      log("nudge deferred — continue/recovery already pending, scheduling retry, session:", sessionId);
      scheduleNudgeRetry(sessionId, knownTodos);
      return;
    }

    if (s.planning || s.compacting || s.hardCompactionInProgress) {
      log("nudge deferred — session busy (planning:", s.planning, "compacting:", s.compacting, "hardCompaction:", s.hardCompactionInProgress, ") schedule retry, session:", sessionId);
      if (config.showToasts) {
        try {
          await input.client.tui.showToast({
            query: { directory: input.directory || "" },
            body: {
              title: "Compacting",
              message: s.compacting ? "Context compaction in progress — nudge deferred." : "Session busy — nudge deferred.",
              variant: "info",
            },
          });
        } catch (e) {
          log("nudge deferred toast error (ignored)", String(e));
        }
      }
      scheduleNudgeRetry(sessionId, knownTodos);
      return;
    }

    if (deps.maybeHardCompact) {
      try {
        const compacted = await deps.maybeHardCompact(sessionId);
        if (compacted) {
          log('hard compaction succeeded before nudge:', sessionId);
        }
      } catch (e) {
        log('hard compaction before nudge failed (proceeding anyway):', e);
      }
    }

    // FIX 8: Check failure backoff before proceeding
    const NUDGE_FAILURE_BACKOFF_MS = 5000;
    if (s.nudgeFailureCount > 0 && Date.now() - s.lastNudgeFailureAt < NUDGE_FAILURE_BACKOFF_MS) {
      log("nudge failure backoff active, skipping:", sessionId, "failures:", s.nudgeFailureCount);
      return;
    }

    // Check cooldown
    if (Date.now() - s.lastNudgeAt < config.nudgeCooldownMs) {
      log("nudge skipped - cooldown active", sessionId);
      return;
    }

    const statusType = await getSessionStatusType(sessionId);
    if (statusType === "busy" || statusType === "retry") {
      log("nudge skipped - session is not idle, scheduling retry", { sessionId, statusType });
      scheduleNudgeRetry(sessionId, knownTodos);
      return;
    }

    // Todo source priority:
    // 1. Cached from todo.updated events (instant, but events may not arrive)
    // 2. Provided by caller (e.g., todo poller on session.idle)
    // 3. Fallback: fetch from session.todo() API
    let todos: Array<{ id: string; status: string; content?: string; title?: string }>;
    if (s.lastKnownTodos && s.lastKnownTodos.length > 0) {
      todos = s.lastKnownTodos;
      log("using cached todos for nudge", { count: todos.length });
    } else if (knownTodos && knownTodos.length > 0) {
      todos = knownTodos;
      log("using provided todos for nudge", { count: knownTodos.length });
    } else {
      try {
        const resp = await input.client.session.todo({ path: { id: sessionId }, query: { directory: input.directory || "" } });
        todos = Array.isArray(resp.data) ? resp.data : [];
        log("fetched todos from API for nudge", { count: todos.length });
      } catch (e) {
        log("error fetching todos for nudge", String(e));
        todos = [];
      }
    }

    // Which todos are still pending?
    const pending = todos.filter(
      (t) => t.status === "in_progress" || t.status === "pending"
    );
    const completed = todos.filter(
      (t) => t.status === "completed" || t.status === "cancelled"
    );

    log("nudge todo check", {
      total: todos.length,
      pending: pending.length,
      completed: completed.length,
    });

    if (pending.length === 0) {
      log("no pending todos after fetch, checking TODO.md sync", { sessionId, total: todos.length, completed: completed.length });

      if (config.todoMdSync && config.todoMdPath && deps.todoMdReader && !s.todoMdSyncFired) {
        const TODO_MD_SYNC_COOLDOWN_MS = 30000;
        if (s.lastTodoMdSyncAt > 0 && Date.now() - s.lastTodoMdSyncAt < TODO_MD_SYNC_COOLDOWN_MS) {
          log("TODO.md sync: cooldown active, skipping:", sessionId);
        } else {
          try {
            const mdResult = await deps.todoMdReader.readAndParse(input.directory || "", todos);
            if (mdResult && mdResult.pending.length > 0) {
              log("TODO.md sync: found pending tasks, sending sync message:", { sessionId, tasks: mdResult.pending.length });

              const todoMdTaskList = mdResult.pending.map((t, i) => `${i + 1}. ${t}`).join("\n");
              const syncMessage = formatMessage(config.todoMdSyncMessage, {
                todoMdPath: config.todoMdPath,
                todoMdTaskList,
                todoMdInstruction: todoMdInstruction(config.todoMdPath, config.todoMdSync),
              });

              const isDuplicate = await shouldBlockPrompt(sessionId, syncMessage, input, log as any);
              if (!isDuplicate) {
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
                  log("TODO.md sync message sent successfully:", { sessionId, tasks: mdResult.pending.length });
                } catch (e) {
                  log("TODO.md sync message send failed:", String(e));
                }
              } else {
                log("TODO.md sync message blocked by prompt guard:", sessionId);
              }
            }
          } catch (e) {
            log("TODO.md sync read error in nudge:", String(e));
          }
        }
      }

      s.nudgeCount = 0;
      s.lastTodoSnapshot = "";
      return;
    }

    // Check if todos changed since last time
    const currentSnapshot = snapshot(todos);
    if (s.lastTodoSnapshot && s.lastTodoSnapshot !== currentSnapshot) {
      log("todo change detected - resetting nudge counter", {
        was: s.lastTodoSnapshot,
        now: currentSnapshot,
      });
      s.nudgeCount = 0;
    }
    s.lastTodoSnapshot = currentSnapshot;

    // Loop protection: don't nudge too many times without progress
    if (s.nudgeCount >= config.nudgeMaxSubmits) {
      log("loop protection - too many nudges without progress", {
        count: s.nudgeCount,
      });

      // Show warning toast
      if (config.showToasts) {
        try {
          await input.client.tui.showToast({
            query: { directory: input.directory || "" },
            body: {
              title: "Nudge Paused",
              message: `No progress after ${s.nudgeCount} nudges. Complete a task to resume.`,
              variant: "warning",
            },
          });
        } catch (e) {
          log("nudge toast error (ignored)", String(e));
        }
      }
      return;
    }

    // Run tests before nudge (test-on-idle quality gate)
    // testRunner.runTests() checks config.testOnIdle internally
    let testFailureOutput = "";
    if (deps.testRunner && s && !s.testRunInProgress) {
      s.testRunInProgress = true;
      try {
        const results = await deps.testRunner.runTests();
        s.lastTestRunAt = Date.now();
        if (deps.testRunner.hasRealResults(results)) {
          testFailureOutput = deps.testRunner.formatFailures(results);
          if (testFailureOutput) {
            log("test failures detected before nudge, session:", sessionId);
          } else {
            log("all tests passing before nudge, session:", sessionId);
          }
        } else {
          log("no real test results (all skipped), AI will not be prompted about tests, session:", sessionId);
        }
      } catch (e) {
        log("test runner error before nudge (non-fatal):", e);
      } finally {
        s.testRunInProgress = false;
      }
    }

    // Build the reminder message
    let messageText: string;
    const templateVars: Record<string, string> = {
        total: String(todos.length),
        completed: String(completed.length),
        pending: String(pending.length),
        remaining: String(pending.length),
      };

      if (config.includeTodoContext && pending.length > 0) {
        const todoList = pending
          .slice(0, 5)
          .map((t) => t.content || t.title || t.id)
          .join(", ");
        templateVars.todoList = todoList + (pending.length > 5 ? "..." : "");
      }

      messageText = formatMessage(config.nudgeMessage, { ...templateVars, todoMdInstruction: todoMdInstruction(config.todoMdPath, config.todoMdSync) });

    // If tests failed, override nudge message with fix directive
    if (testFailureOutput) {
      messageText = `Tests are failing. Fix these before continuing with other tasks:\n\n${testFailureOutput}\n\n**Create fix-todos for each failure before attempting fixes.** Do not continue to other tasks until these tests pass.`;
    }

    // Prompt guard: prevent duplicate injections
    const isDuplicate = await shouldBlockPrompt(sessionId, messageText, input, log as any);
    if (isDuplicate) {
      log("prompt guard blocked duplicate nudge", { sessionId });
      return;
    }

    // Send it!
    log("sending nudge prompt", { sessionId, messageText });
    try {
      const promptResponse = await input.client.session.prompt({
        path: { id: sessionId },
        query: { directory: input.directory || "" },
        body: {
          parts: [
            {
              type: "text",
              text: messageText,
              synthetic: true,
            },
          ],
        },
      });

      // Check if prompt was aborted
      const promptError = (promptResponse as any)?.data?.info?.error;
      if (promptError?.name === "MessageAbortedError") {
        log("nudge prompt aborted", sessionId);
        if (!s.aborting) pauseNudge(sessionId);
        return;
      }

      s.nudgeCount++;
      s.nudgeFailureCount = 0;
      s.nudgeRetryCount = 0; // Reset retry count on success
      s.lastNudgeAt = Date.now();
      s.messageCount++;
      log("nudge sent successfully", { newCount: s.nudgeCount });
      // Note: We intentionally do NOT show a toast here because we don't know
      // if the AI will actually respond. The toast would be misleading.
      // Instead, we show "Session Resumed" when progress is detected.
    } catch (e: unknown) {
      const errorStr = String(e);
      const errorName = (e as any)?.name || "";

      // Check for MessageAbortedError via multiple paths
      const isAborted =
        errorName === "MessageAbortedError" ||
        errorStr.includes("MessageAbortedError") ||
        (e as any)?.data?.info?.error?.name === "MessageAbortedError";

      if (isAborted) {
        log("nudge prompt aborted", sessionId);
        if (!s.aborting) pauseNudge(sessionId);
        return;
      }

      // Check response data for server-side errors
      const responseError = (e as any)?.response?.data?.info?.error;
      if (responseError) {
        log("nudge response error", { sessionId, error: responseError });
        if (responseError.name === "MessageAbortedError" && !s.aborting) {
          pauseNudge(sessionId);
          return;
        }
      }

      log("error sending nudge", errorStr);
      
      // FIX 8: Track failures and use backoff to prevent tight nudge loops
      s.nudgeFailureCount++;
      s.lastNudgeFailureAt = Date.now();
      const failureBackoff = Math.min(30000, 2000 * Math.pow(2, s.nudgeFailureCount - 1));
      log("nudge failure tracked, count:", s.nudgeFailureCount, "next backoff:", failureBackoff, "ms");

      // Show failure toast
      if (config.showToasts) {
        try {
          await input.client.tui.showToast({
            query: { directory: input.directory || "" },
            body: {
              title: "Nudge Failed",
              message: `Failed to send nudge. Will retry in ${Math.round(failureBackoff / 1000)}s.`,
              variant: "warning",
            },
          });
        } catch (toastErr) {
          log("nudge failure toast error (ignored)", String(toastErr));
        }
      }
    }
  }

  // Schedule a nudge after idle delay
  function scheduleNudge(
    sessionId: string,
    knownTodos?: Array<{ id: string; status: string; content?: string; title?: string }>
  ): void {
    cancelNudge(sessionId);

    const s = sessions.get(sessionId);
    if (!s || !config.nudgeEnabled) return;

    if (config.nudgeIdleDelayMs <= 0) {
      log("scheduling nudge immediately (next tick)", { sessionId });
      s.nudgeTimer = setTimeout(() => {
        const session = sessions.get(sessionId);
        if (session) {
          session.nudgeTimer = null;
        }
        injectNudge(sessionId, knownTodos).catch((e) => log("nudge inject error", String(e)));
      }, 0);
      if ((s.nudgeTimer as any).unref) (s.nudgeTimer as any).unref();
      return;
    }

    log("scheduling nudge", { sessionId, delayMs: config.nudgeIdleDelayMs });
    s.nudgeTimer = setTimeout(() => {
      const session = sessions.get(sessionId);
      if (session) {
        session.nudgeTimer = null;
      }
      injectNudge(sessionId, knownTodos).catch((e) => log("nudge inject error", String(e)));
    }, config.nudgeIdleDelayMs);
    if (s.nudgeTimer && (s.nudgeTimer as any).unref) (s.nudgeTimer as any).unref();
  }

  // Retry nudge when blocked by compaction/planning — retries every 5s up to 12 times (1 minute)
  const NUDGE_RETRY_INTERVAL_MS = 5000;
  const NUDGE_MAX_RETRY_COUNT = 12;

  function scheduleNudgeRetry(
    sessionId: string,
    knownTodos?: Array<{ id: string; status: string; content?: string; title?: string }>
  ): void {
    const s = sessions.get(sessionId);
    if (!s || !config.nudgeEnabled) return;

    // Cancel any existing retry timer
    if (s.nudgeRetryTimer) {
      clearTimeout(s.nudgeRetryTimer);
      s.nudgeRetryTimer = null;
    }

    // Enforce max retry count to prevent infinite retries
    if (s.nudgeRetryCount >= NUDGE_MAX_RETRY_COUNT) {
      log("nudge max retry count reached, giving up:", sessionId, "retries:", s.nudgeRetryCount);
      return;
    }

    s.nudgeRetryCount++;
    log("scheduling nudge retry", { sessionId, retryCount: s.nudgeRetryCount, maxRetries: NUDGE_MAX_RETRY_COUNT });

    s.nudgeRetryTimer = setTimeout(() => {
      const session = sessions.get(sessionId);
      if (session) {
        session.nudgeRetryTimer = null;
      }
      injectNudge(sessionId, knownTodos).catch((e) => log("nudge retry inject error", String(e)));
    }, NUDGE_RETRY_INTERVAL_MS);
    if (s.nudgeRetryTimer && (s.nudgeRetryTimer as any).unref) (s.nudgeRetryTimer as any).unref();
  }

  return {
    scheduleNudge,
    cancelNudge,
    resetNudge,
    pauseNudge,
    injectNudge,
  };
}
