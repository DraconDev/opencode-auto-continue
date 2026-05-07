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

  // Question phrases that indicate the AI is asking the user something
const QUESTION_PHRASES = [
  "would you like", "should i", "do you want", "please review",
  "let me know", "what do you think", "can you confirm",
  "would you prefer", "shall i", "any thoughts", "could you",
  "do you agree", "are you sure", "would you mind",
];

function isQuestion(text: string): boolean {
  const lowerText = text.toLowerCase().trim();
  if (/\?\s*$/.test(lowerText)) return true;
  return QUESTION_PHRASES.some((phrase) => lowerText.includes(phrase));
}

// Check if the last assistant message is a question
async function checkLastMessageIsQuestion(sessionId: string): Promise<boolean> {
  try {
    const resp = await input.client.session.messages({
      path: { id: sessionId },
      query: { limit: 5 },
    });
    const messages = Array.isArray(resp.data) ? resp.data : [];
    
    // Find last assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant" || msg.info?.role === "assistant") {
        const text = msg.text || msg.parts?.map((p: any) => p.text).join(" ") || "";
        if (isQuestion(text)) {
          log("last assistant message is a question, skipping nudge", { sessionId, text: text.substring(0, 100) });
          return true;
        }
        break; // Only check the most recent assistant message
      }
    }
  } catch (e) {
    log("error checking last message for questions (ignored)", String(e));
  }
  return false;
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

    // Check cooldown
    if (Date.now() - s.lastNudgeAt < config.nudgeCooldownMs) {
      log("nudge skipped - cooldown active", sessionId);
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
        log("error fetching todos for nudge", String(e));
        return;
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

    // Check if the last assistant message is a question
    // This prevents nudging when the AI is explicitly asking the user for input
    const lastMessageIsQuestion = await checkLastMessageIsQuestion(sessionId);
    if (lastMessageIsQuestion) {
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
      injectNudge(sessionId, knownTodos).catch((e) => log("nudge inject error", String(e)));
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
