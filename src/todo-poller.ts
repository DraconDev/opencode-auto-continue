import type { PluginConfig } from "./config.js";
import type { SessionState, Todo } from "./session-state.js";
import { getTokenCount } from "./session-state.js";
import type { TypedPluginInput } from "./types.js";

export interface TodoPollerDeps {
  config: Pick<PluginConfig, "todoPollIntervalMs" | "reviewOnComplete" | "reviewDebounceMs" | "opportunisticCompactAfterReview" | "opportunisticCompactAtTokens">;
  sessions: Map<string, SessionState>;
  log: (...args: unknown[]) => void;
  isDisposed: () => boolean;
  input: TypedPluginInput;
  writeStatusFile: (sessionId: string) => void;
  triggerReview?: (sessionId: string) => void;
  maybeOpportunisticCompact?: (sessionId: string, trigger: string) => Promise<void>;
}

const MIN_POLL_INTERVAL_MS = 5000;

export function createTodoPoller(deps: TodoPollerDeps) {
  const { config, sessions, log, isDisposed, input } = deps;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPollAt = 0;

  function processTodos(sessionId: string, todos: Todo[]): void {
    const s = sessions.get(sessionId);
    if (!s) return;

    const hasPending = todos.some((t) => t.status === "in_progress" || t.status === "pending");
    const allCompleted = todos.length > 0 && todos.every((t) => t.status === "completed" || t.status === "cancelled");

    const prevHasOpenTodos = s.hasOpenTodos;

    s.hasOpenTodos = hasPending;
    s.lastKnownTodos = todos;

    log("todo poll result", {
      sessionId,
      total: todos.length,
      hasPending,
      allCompleted,
      prevHasOpenTodos,
    });

    if (allCompleted && !s.reviewFired && config.reviewOnComplete) {
      log("todo poll detected all completed, triggering review:", sessionId);
      if (config.opportunisticCompactAfterReview && deps.maybeOpportunisticCompact) {
        if (getTokenCount(s) >= config.opportunisticCompactAtTokens) {
          deps.maybeOpportunisticCompact(sessionId, "post-review").catch((e: unknown) => log("opportunistic compact post-review failed:", e));
        }
      }
      if (s.reviewDebounceTimer) {
        clearTimeout(s.reviewDebounceTimer);
      }
      s.reviewDebounceTimer = setTimeout(() => {
        s.reviewDebounceTimer = null;
        if (deps.triggerReview) deps.triggerReview(sessionId);
      }, config.reviewDebounceMs);
    } else if (!allCompleted && s.reviewDebounceTimer) {
      clearTimeout(s.reviewDebounceTimer);
      s.reviewDebounceTimer = null;
    }

    if (hasPending && s.reviewFired) {
      log("todo poll: new pending todos after review, resetting review flag:", sessionId);
      s.reviewFired = false;
    }

    deps.writeStatusFile(sessionId);
  }

  async function pollSession(sessionId: string): Promise<Todo[] | null> {
    if (isDisposed()) return null;
    try {
      const resp = await input.client.session.todo({
        path: { id: sessionId },
        query: { directory: input.directory || "" },
      });
      const todos = Array.isArray(resp.data) ? (resp.data as Todo[]) : [];
      log("todo poll fetched", { sessionId, count: todos.length });
      return todos;
    } catch (e) {
      log("todo poll fetch error:", String(e));
      return null;
    }
  }

  async function pollAndProcess(sessionId: string): Promise<Todo[] | null> {
    const todos = await pollSession(sessionId);
    if (todos !== null && todos.length > 0) {
      processTodos(sessionId, todos);
    }
    return todos;
  }

  async function pollAllActive(): Promise<void> {
    if (isDisposed()) return;

    const now = Date.now();
    if (now - lastPollAt < MIN_POLL_INTERVAL_MS) return;
    lastPollAt = now;

    const activeSessionIds: string[] = [];
    for (const [id, s] of sessions) {
      if (!s.userCancelled && !s.compacting && !s.planning) {
        activeSessionIds.push(id);
      }
    }

    if (activeSessionIds.length === 0) return;

    log("todo poll: polling", activeSessionIds.length, "active sessions");

    for (const sid of activeSessionIds) {
      if (isDisposed()) break;
      await pollAndProcess(sid);
    }
  }

  function startPeriodicPoll(): void {
    if (pollTimer) return;
    if (isDisposed()) return;

    const interval = config.todoPollIntervalMs;
    if (interval <= 0) return;

    pollTimer = setTimeout(() => {
      pollTimer = null;
      if (!isDisposed()) {
        pollAllActive().catch((e) => log("todo poll error:", e)).finally(() => startPeriodicPoll());
      }
    }, interval);
  }

  function stopPeriodicPoll(): void {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  return {
    pollAndProcess,
    pollAllActive,
    processTodos,
    startPeriodicPoll,
    stopPeriodicPoll,
  };
}
