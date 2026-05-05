import { type PluginConfig, type SessionState, formatMessage } from "./shared.js";

export interface NudgeDeps {
  config: Pick<PluginConfig, 
    "nudgeEnabled" | "nudgeIdleDelayMs" | "nudgeMaxSubmits" | 
    "nudgeMessage" | "nudgeCooldownMs" | "includeTodoContext" | 
    "showToasts" | "timerToastEnabled" | "timerToastIntervalMs">;
  sessions: Map<string, SessionState>;
  log: (message: string, ...args: unknown[]) => void;
  isDisposed: boolean;
  input: unknown;
}

// Trigger statuses for todos (same as opencode-todo-reminder)
const TRIGGER_STATUSES = new Set(["pending", "in_progress", "open"]);

// Create a snapshot string from todos for change detection
function snapshot(todos: Array<{ id: string; status: string }>): string {
  return todos
    .map((t) => `${t.id}:${t.status}`)
    .sort()
    .join(",");
}

export function createNudgeModule(deps: NudgeDeps) {
  const { config, sessions, log, isDisposed, input } = deps;

  // Cancel any pending nudge timer
  function cancelTimer(sessionId: string): void {
    const s = sessions.get(sessionId);
    if (s?.nudgeTimer) {
      clearTimeout(s.nudgeTimer);
      s.nudgeTimer = null;
      log("nudge timer cancelled:", sessionId);
    }
  }

  // Schedule a nudge after idle delay
  function scheduleNudge(sessionId: string): void {
    if (!config.nudgeEnabled) return;
    
    cancelTimer(sessionId);
    
    const s = sessions.get(sessionId);
    if (!s) return;

    // Skip if session is paused after abort
    if (s.nudgePaused) {
      log("nudge skipped - session paused after abort:", sessionId);
      return;
    }

    log("scheduling nudge:", sessionId, "delay:", config.nudgeIdleDelayMs);
    s.nudgeTimer = setTimeout(() => {
      s.nudgeTimer = null;
      nudge(sessionId).catch((e) => log("nudge error:", String(e)));
    }, config.nudgeIdleDelayMs);
  }

  // The main nudge function - runs when session is idle
  async function nudge(sessionId: string): Promise<void> {
    if (isDisposed) return;
    
    const s = sessions.get(sessionId);
    if (!s) return;

    // Skip if session is paused after abort
    if (s.nudgePaused) {
      log("nudge skipped - session paused:", sessionId);
      return;
    }

    // Check cooldown
    if (Date.now() - s.lastNudgeAt < config.nudgeCooldownMs) {
      log("nudge skipped - cooldown active:", sessionId);
      return;
    }

    // Fetch todos from API
    let todos: Array<{ id: string; status: string; content?: string; title?: string }>;
    try {
      const resp = await (input as any).client.session.todo({ path: { id: sessionId } });
      todos = Array.isArray(resp.data) ? resp.data : [];
    } catch (e) {
      log("error fetching todos:", String(e));
      return;
    }

    // Filter pending todos
    const pending = todos.filter((t) => TRIGGER_STATUSES.has(t.status));
    const completed = todos.filter((t) => t.status === "completed" || t.status === "cancelled");

    log("todos:", {
      total: todos.length,
      pending: pending.length,
      completed: completed.length,
    });

    // No pending todos = nothing to do
    if (pending.length === 0) {
      log("no pending todos, resetting nudge state");
      s.nudgeCount = 0;
      s.lastTodoSnapshot = "";
      s.hasOpenTodos = false;
      return;
    }

    s.hasOpenTodos = true;

    // Check if todos changed since last nudge
    const currentSnapshot = snapshot(todos);
    if (s.lastTodoSnapshot && s.lastTodoSnapshot !== currentSnapshot) {
      log("todo change detected - resetting loop counter");
      s.nudgeCount = 0;
    }
    s.lastTodoSnapshot = currentSnapshot;

    // Loop protection: don't nudge too many times without progress
    if (s.nudgeCount >= config.nudgeMaxSubmits) {
      log("loop protection - too many nudges without progress:", s.nudgeCount);
      
      // Show warning toast if enabled
      if (config.showToasts) {
        try {
          await (input as any).client.tui.showToast({
            query: { directory: (input as any).directory || "" },
            body: {
              title: "Nudge Paused",
              message: `No progress after ${s.nudgeCount} nudges. Complete a task to resume.`,
              variant: "warning",
            },
          });
        } catch (e) {
          log("toast error (ignored):", String(e));
        }
      }
      return;
    }

    // Build reminder message
    let messageText = config.nudgeMessage;
    
    if (config.includeTodoContext && pending.length > 0) {
      const todoList = pending
        .slice(0, 5)
        .map((t) => t.content || t.title || t.id)
        .join(", ");
      
      const templateVars: Record<string, string> = {
        pending: String(pending.length),
        total: String(todos.length),
        completed: String(completed.length),
        todoList: todoList + (pending.length > 5 ? "..." : ""),
      };
      
      messageText = formatMessage(config.nudgeMessage, templateVars);
    }

    // Send nudge
    log("sending nudge:", sessionId, messageText.substring(0, 100));
    try {
      // Show toast if enabled
      if (config.showToasts || config.timerToastEnabled) {
        try {
          await (input as any).client.tui.showToast({
            query: { directory: (input as any).directory || "" },
            body: {
              title: "Continue Working",
              message: `${pending.length} task(s) remaining`,
              variant: "info",
            },
          });
        } catch (e) {
          log("toast error (ignored):", String(e));
        }
      }

      await (input as any).client.session.prompt({
        path: { id: sessionId },
        query: { directory: (input as any).directory || "" },
        body: {
          parts: [{
            type: "text",
            text: messageText,
            synthetic: true,
          }],
        },
      });

      s.nudgeCount++;
      s.lastNudgeAt = Date.now();
      s.messageCount++;
      log("nudge sent successfully, count:", s.nudgeCount);
    } catch (e) {
      log("nudge failed:", String(e));
    }
  }

  // Reset nudge state (called on user message)
  function resetNudgeState(sessionId: string): void {
    const s = sessions.get(sessionId);
    if (!s) return;
    
    cancelTimer(sessionId);
    s.nudgeCount = 0;
    s.nudgePaused = false;
    s.lastTodoSnapshot = "";
    log("nudge state reset:", sessionId);
  }

  // Pause nudge (called on abort)
  function pauseNudge(sessionId: string): void {
    const s = sessions.get(sessionId);
    if (!s) return;
    
    cancelTimer(sessionId);
    s.nudgePaused = true;
    log("nudge paused after abort:", sessionId);
  }

  // Cleanup on session end
  function cleanup(sessionId: string): void {
    cancelTimer(sessionId);
    const s = sessions.get(sessionId);
    if (s) {
      s.nudgeCount = 0;
      s.lastTodoSnapshot = "";
      s.nudgePaused = false;
    }
  }

  return {
    scheduleNudge,
    cancelTimer,
    resetNudgeState,
    pauseNudge,
    cleanup,
  };
}