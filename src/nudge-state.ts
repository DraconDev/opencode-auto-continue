/**
 * Nudge State — idle reminder tracking, retry counts, pause flags.
 */

/**
 * Minimal Todo type — used for tracking todo snapshots in nudge state.
 */
export interface Todo {
  id: string;
  content?: string;
  title?: string;
  status: string;
}

export interface NudgeState {
  nudgeTimer: ReturnType<typeof setTimeout> | null;
  nudgeRetryTimer: ReturnType<typeof setTimeout> | null;
  nudgeRetryCount: number;
  lastNudgeAt: number;
  nudgeCount: number;
  nudgeFailureCount: number;
  lastNudgeFailureAt: number;
  lastTodoSnapshot: string;
  nudgePaused: boolean;
  hasOpenTodos: boolean;
  lastKnownTodos: Todo[];
}

export function createNudgeDefaults(now: number): NudgeState {
  return {
    nudgeTimer: null,
    nudgeRetryTimer: null,
    nudgeRetryCount: 0,
    lastNudgeAt: 0,
    nudgeCount: 0,
    nudgeFailureCount: 0,
    lastNudgeFailureAt: 0,
    lastTodoSnapshot: '',
    nudgePaused: false,
    hasOpenTodos: false,
    lastKnownTodos: [],
  };
}