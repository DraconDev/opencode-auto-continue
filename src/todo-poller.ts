import type { PluginConfig } from "./config.js";
import type { SessionState, Todo } from "./session-state.js";
import { getTokenCount } from "./session-state.js";
import type { TypedPluginInput } from "./types.js";
import type { TodoMdReader } from "./todo-md-reader.js";

export interface TodoPollerDeps {
  config: Pick<PluginConfig, "todoPollIntervalMs" | "reviewOnComplete" | "reviewDebounceMs" | "reviewCooldownMs" | "opportunisticCompactAfterReview" | "opportunisticCompactAtTokens" | "todoMdPath">;
  sessions: Map<string, SessionState>;
  log: (...args: unknown[]) => void;
  isDisposed: () => boolean;
  input: TypedPluginInput;
  writeStatusFile: (sessionId: string) => void;
  triggerReview?: (sessionId: string) => void;
  maybeOpportunisticCompact?: (sessionId: string, trigger: string) => Promise<boolean>;
  scheduleNudge?: (sessionId: string) => void;
  todoMdReader?: TodoMdReader;
}

const MIN_POLL_INTERVAL_MS = 5000;
const TODO_EVENT_FRESH_MS = 10000;

/**
 * Create the todo poller module. Periodically fetches the latest todo
 * state from the OpenCode API when event-driven updates are stale.
 * Prevents missed todo updates by polling at a configurable interval
 * with debouncing against recent events.
 */
export function createTodoPoller(deps: TodoPollerDeps) {
  const { config, sessions, log, isDisposed, input } = deps;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPollAt = 0;
  const lastEventTodoAt = new Map<string, number>();

  function markEventTodoReceived(sessionId: string): void {
    lastEventTodoAt.set(sessionId, Date.now());
  }

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

    if (allCompleted && s.reviewFired) {
      const now = Date.now();
      const inCooldown = s.lastReviewAt > 0 && (now - s.lastReviewAt) < config.reviewCooldownMs;
      if (!inCooldown) {
        log("todo poll: all completed with stale reviewFired flag, resetting:", sessionId);
        s.reviewFired = false;

        if (config.todoMdSync && config.todoMdPath && deps.todoMdReader && deps.sendTodoMdSync && !s.todoMdSyncFired) {
          deps.todoMdReader.readAndParse(input.directory || "", todos).then((mdResult) => {
            if (mdResult && mdResult.pending.length > 0) {
              log("todo.md sync: found pending tasks after review reset, firing sync:", mdResult.pending.length, "tasks");
              deps.sendTodoMdSync!(sessionId, mdResult.pending).catch((e: unknown) => log("todo.md sync send error:", e));
            }
          }).catch((e: unknown) => log("todo.md sync read error:", e));
        }
      }
    }

    if (allCompleted && !s.reviewFired && config.reviewOnComplete) {
      const now = Date.now();
      const inCooldown = s.lastReviewAt > 0 && (now - s.lastReviewAt) < config.reviewCooldownMs;
      if (inCooldown) {
        log("todo poll: all completed but review cooldown active, skipping:", {
          sessionId,
          lastReviewAt: s.lastReviewAt,
          cooldownMs: config.reviewCooldownMs,
          elapsed: now - s.lastReviewAt,
        });
      } else {
        log("todo poll detected all completed, triggering review:", sessionId);
        if (config.opportunisticCompactAfterReview && deps.maybeOpportunisticCompact) {
          if (getTokenCount(s) >= config.opportunisticCompactAtTokens) {
            deps.maybeOpportunisticCompact(sessionId, "post-review").catch((e: unknown) => log("opportunistic compact post-review failed:", e));
          }
        }
        if (config.reviewDebounceMs <= 0) {
          log("todo poll detected all completed, triggering review immediately:", sessionId);
          if (deps.triggerReview) deps.triggerReview(sessionId);
        } else {
          if (s.reviewDebounceTimer) {
            clearTimeout(s.reviewDebounceTimer);
          }
          s.reviewDebounceTimer = setTimeout(() => {
            s.reviewDebounceTimer = null;
            if (deps.triggerReview) deps.triggerReview(sessionId);
          }, config.reviewDebounceMs);
        }
      }
    } else if (!allCompleted && s.reviewDebounceTimer) {
      clearTimeout(s.reviewDebounceTimer);
      s.reviewDebounceTimer = null;
    }

    if (hasPending && s.reviewFired) {
      const now = Date.now();
      const inCooldown = s.lastReviewAt > 0 && (now - s.lastReviewAt) < config.reviewCooldownMs;
      if (inCooldown) {
        log("todo poll: new pending todos after review, but cooldown active — NOT resetting reviewFired:", sessionId);
      } else {
        log("todo poll: new pending todos after review, resetting review flag:", sessionId);
        s.reviewFired = false;
      }
      s.todoMdSyncFired = false;
    }

    if (hasPending && deps.scheduleNudge && !s.nudgePaused) {
      deps.scheduleNudge(sessionId);
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
    const lastEvent = lastEventTodoAt.get(sessionId);
    if (lastEvent && Date.now() - lastEvent < TODO_EVENT_FRESH_MS) {
      log("todo poll skipped — recent todo.updated event:", sessionId);
      const s = sessions.get(sessionId);
      if (s && s.lastKnownTodos && s.lastKnownTodos.length > 0) {
        log("todo poll skipped but reprocessing cached todos:", sessionId);
        processTodos(sessionId, s.lastKnownTodos);
      }
      return null;
    }

    const todos = await pollSession(sessionId);
    if (todos !== null) {
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

  function cleanupSession(sessionId: string): void {
    lastEventTodoAt.delete(sessionId);
    const s = sessions.get(sessionId);
    if (s?.reviewDebounceTimer) {
      clearTimeout(s.reviewDebounceTimer);
      s.reviewDebounceTimer = null;
    }
    if (s?.reviewRetryTimer) {
      clearTimeout(s.reviewRetryTimer);
      s.reviewRetryTimer = null;
    }
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
    markEventTodoReceived,
    cleanupSession,
    startPeriodicPoll,
    stopPeriodicPoll,
  };
}
