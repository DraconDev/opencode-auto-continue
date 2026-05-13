import type { PluginConfig } from "./config.js";
import type { SessionState } from "./session-state.js";
import { formatMessage, shouldBlockPrompt } from "./shared.js";
import type { TypedPluginInput } from "./types.js";

export interface NudgeDeps {
  config: Pick<PluginConfig, 
    "nudgeEnabled" | "nudgeIdleDelayMs" | "nudgeMaxSubmits" | 
    "nudgeMessage" | "nudgeCooldownMs" | "includeTodoContext" | 
    "showToasts">;
  sessions: Map<string, SessionState>;
  log: (...args: unknown[]) => void;
  isDisposed: () => boolean;
  input: TypedPluginInput;
}

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
  }

  // Reset nudge state on user activity
  function resetNudge(sessionId: string): void {
    const s = sessions.get(sessionId);
    if (!s) return;
    cancelNudge(sessionId);
    s.nudgeCount = 0;
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

    // Skip if session was aborted
    if (s.nudgePaused) {
      log("nudge skipped - session paused after abort", sessionId);
      return;
    }

    if (s.needsContinue || s.aborting) {
      log("nudge skipped - continue/recovery already pending", sessionId);
      return;
    }

    if (s.planning || s.compacting) {
      log("nudge skipped - planning or compacting", sessionId);
      return;
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
      log("nudge skipped - session is not idle", { sessionId, statusType });
      return;
    }

    // Fetch todos from API if not provided
    let todos: Array<{ id: string; status: string; content?: string; title?: string }>;
    if (knownTodos) {
      todos = knownTodos;
      log("using provided todos for nudge", { count: knownTodos.length });
    } else {
      try {
        const resp = await input.client.session.todo({ path: { id: sessionId } });
        todos = Array.isArray(resp.data) ? resp.data : [];
      } catch (e) {
        log("error fetching todos for nudge, falling back to cached", String(e));
        // FIX 6: Fallback to cached todos instead of abandoning
        if (s.hasOpenTodos && s.lastKnownTodos.length > 0) {
          todos = s.lastKnownTodos;
          log("using cached todos for nudge fallback", { count: todos.length });
        } else {
          log("no cached todos available, abandoning nudge");
          return;
        }
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

    // No pending todos = nothing to do
    if (pending.length === 0) {
      log("no pending todos, nudge done");
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

      messageText = formatMessage(config.nudgeMessage, templateVars);

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
        pauseNudge(sessionId);
        return;
      }

      s.nudgeCount++;
      s.nudgeFailureCount = 0; // FIX 8: Reset failure count on success
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
        pauseNudge(sessionId);
        return;
      }

      // Check response data for server-side errors
      const responseError = (e as any)?.response?.data?.info?.error;
      if (responseError) {
        log("nudge response error", { sessionId, error: responseError });
        if (responseError.name === "MessageAbortedError") {
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
        } catch (e) {
          log("nudge failure toast error (ignored)", String(e));
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

    log("scheduling nudge", { sessionId, delayMs: config.nudgeIdleDelayMs });
    s.nudgeTimer = setTimeout(() => {
      const session = sessions.get(sessionId);
      if (session) {
        session.nudgeTimer = null;
      }
      injectNudge(sessionId, knownTodos).catch((e) => log("nudge inject error", String(e)));
    }, config.nudgeIdleDelayMs);
    (s.nudgeTimer as any).unref?.();
  }

  return {
    scheduleNudge,
    cancelNudge,
    resetNudge,
    pauseNudge,
    injectNudge,
  };
}
