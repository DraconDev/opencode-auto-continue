import { type PluginConfig, type SessionState, formatMessage } from "./shared.js";
import type { TypedPluginInput } from "./types.js";

export interface NudgeDeps {
  config: Pick<PluginConfig, 
    "nudgeEnabled" | "nudgeIdleDelayMs" | "nudgeMaxSubmits" | 
    "nudgeMessage" | "nudgeCooldownMs" | "includeTodoContext" | 
    "showToasts">;
  sessions: Map<string, SessionState>;
  log: (message: string, ...args: unknown[]) => void;
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

  // Cancel any pending nudge timer
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
  async function injectNudge(sessionId: string): Promise<void> {
    if (isDisposed()) return;

    const s = sessions.get(sessionId);
    if (!s) return;

    s.nudgeTimer = null;

    if (!config.nudgeEnabled) {
      log("nudge disabled, skip");
      return;
    }

    // Skip if session was aborted
    if (s.nudgePaused) {
      log("nudge skipped - session paused after abort", sessionId);
      return;
    }

    // Check cooldown
    if (Date.now() - s.lastNudgeAt < config.nudgeCooldownMs) {
      log("nudge skipped - cooldown active", sessionId);
      return;
    }

    // Fetch todos from API
    let todos: Array<{ id: string; status: string; content?: string; title?: string }>;
    try {
      const resp = await input.client.session.todo({ path: { id: sessionId } });
      todos = Array.isArray(resp.data) ? resp.data : [];
    } catch (e) {
      log("error fetching todos for nudge", String(e));
      return;
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

    const messageText = formatMessage(config.nudgeMessage, templateVars);

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
      s.lastNudgeAt = Date.now();
      s.messageCount++;
      log("nudge sent successfully", { newCount: s.nudgeCount });

      // Show info toast
      if (config.showToasts) {
        try {
          await input.client.tui.showToast({
            query: { directory: input.directory || "" },
            body: {
              title: "Nudge Sent",
              message: `${pending.length} task(s) remaining`,
              variant: "info",
            },
          });
        } catch (e) {
          log("nudge toast error (ignored)", String(e));
        }
      }
    } catch (e) {
      log("error sending nudge", String(e));
    }
  }

  // Schedule a nudge after idle delay
  function scheduleNudge(sessionId: string): void {
    cancelNudge(sessionId);

    const s = sessions.get(sessionId);
    if (!s || !config.nudgeEnabled) return;

    log("scheduling nudge", { sessionId, delayMs: config.nudgeIdleDelayMs });
    s.nudgeTimer = setTimeout(() => {
      injectNudge(sessionId).catch((e) => log("nudge inject error", String(e)));
    }, config.nudgeIdleDelayMs);
  }

  return {
    scheduleNudge,
    cancelNudge,
    resetNudge,
    pauseNudge,
    injectNudge,
  };
}
