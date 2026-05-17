/**
 * Session State Module
 *
 * Contains SessionState interface, Todo interface, createSession, and updateProgress.
 * SessionState is composed from focused sub-interfaces for better maintainability.
 * Sub-interfaces are defined in separate files for modularity.
 */

// Re-export Todo from nudge-state.ts (singleton definition)
export type { Todo } from "./nudge-state.js";

// Sub-state interfaces — re-exported for consumers who want typed sub-states
export type { TimerState, createTimerDefaults } from "./timer-state.js";
export type { RecoveryState, createRecoveryDefaults } from "./recovery-state.js";
export type { CompactionState, createCompactionDefaults } from "./compaction-state.js";
export type { PlanningState, createPlanningDefaults } from "./planning-state.js";
export type { NudgeState, createNudgeDefaults } from "./nudge-state.js";
export type { ContinueState, createContinueDefaults } from "./continue-state.js";
export type { ReviewState, createReviewDefaults } from "./review-state.js";
export type { OutputTrackingState, createOutputTrackingDefaults } from "./output-tracking-state.js";
export type { MessageTrackingState, createMessageTrackingDefaults } from "./message-tracking-state.js";
export type { TestState, createTestDefaults } from "./test-state.js";
export type { DangerCommandState, createDangerCommandDefaults } from "./danger-command-state.js";

/**
 * SessionState is composed from focused sub-interfaces.
 * Each sub-interface represents a distinct feature domain.
 * @deprecated Use individual sub-state interfaces when possible for better decoupling.
 */
export interface SessionState {
  // === Timer & Progress (terminal.ts, index.ts) ===
  timer: ReturnType<typeof setTimeout> | null;
  lastProgressAt: number;
  actionStartedAt: number;

  // === Output Tracking (busy-but-dead detection) ===
  lastOutputAt: number;
  lastOutputLength: number;
  lastToolExecutionAt: number;
  toolRepeatCount: number;
  lastToolName: string;

  // === Test-Driven Quality Gate (test-runner.ts) ===
  lastTestRunAt: number;
  testRunInProgress: boolean;

  // === Recovery (recovery.ts) ===
  attempts: number;
  lastRecoveryTime: number;
  backoffAttempts: number;
  autoSubmitCount: number;
  aborting: boolean;
  recoveryStartTime: number;
  stallDetections: number;
  recoverySuccessful: number;
  recoveryFailed: number;
  lastRecoverySuccess: number;
  totalRecoveryTimeMs: number;
  recoveryTimes: number[];
  lastStallPartType: string;
  stallPatterns: Record<string, number>;
  continueTimestamps: number[];

  // === Session Control (index.ts) ===
  userCancelled: boolean;
  planning: boolean;
  planBuffer: string;
  compacting: boolean;
  sessionCreatedAt: number;
  messageCount: number;
  lastKnownStatus: string;

  // === Compaction (compaction.ts) ===
  estimatedTokens: number;
  realTokens: number;
  lastRealTokenRefreshAt: number;
  lastCompactionAt: number;
  tokenLimitHits: number;
  hardCompactionInProgress: boolean;
  lastHardCompactionAt: number;
  compactionSafetyTimer: ReturnType<typeof setTimeout> | null;
  compactionTimedOut: boolean;
  lastCompactionFailedAt: number;
  lastCompactionTimeoutAt: number;
  lastCompactionCheckAt: number;
  realTokensBaseline: number;
  proactiveCompactCount: number;
  hardCompactCount: number;

  // === Nudge (nudge.ts) ===
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
  lastKnownTodos: Array<{ id: string; content?: string; title?: string; status: string }>;

  // === Concurrency Guard (recovery.ts) ===
  recoveryInProgress: boolean;

  // === Continue Queue (recovery.ts, review.ts) ===
  needsContinue: boolean;
  continueMessageText: string;
  continueRetryCount: number;
  lastContinueRetryAt: number;
  continueInProgress: boolean;
  lastContinueAt: number;

  // === Timer Generation (Fix 4: Prevent stale timer races) ===
  timerGeneration: number;

  // === Planning Timeout (Fix 3: Track when planning started) ===
  planningStartedAt: number;

  // === Review (review.ts) ===
  reviewFired: boolean;
  reviewDebounceTimer: ReturnType<typeof setTimeout> | null;
  reviewRetryTimer: ReturnType<typeof setTimeout> | null;
  lastReviewAt: number;
  reviewCount: number;

  // === Message Tracking (index.ts) ===
  lastUserMessageId: string;
  sentMessageAt: number;

  // === Recovery Intent (recovery.ts) ===
  lastFileEdited: string;
  lastToolCall: string;
  lastToolSummary: string;

  // === Status File (status-file.ts) ===
  statusHistory: Array<{ timestamp: string; status: string; actionDuration: string; progressAgo: string }>;

  // === Stop Conditions (stop-conditions) ===
  stoppedByCondition: string | null;

  // === Dangerous Commands Policy Injection ===
  systemTransformHookCalled: boolean;
  dangerousCommandPromptTimer: ReturnType<typeof setTimeout> | null;

  // === Idle Dedup (event-handlers.ts) ===
  idleProcessingDone: boolean;
}

/**
 * Create a fresh session state with default values.
 * All timestamps are initialized to `Date.now()` at creation time.
 *
 * @returns A new SessionState object with sensible defaults
 */
export function createSession(): SessionState {
  const now = Date.now();
  return {
    // Timer & Progress
    timer: null,
    lastProgressAt: now,
    actionStartedAt: 0,

    // Output Tracking
    lastOutputAt: now,
    lastOutputLength: 0,
    lastToolExecutionAt: now,
    toolRepeatCount: 0,
    lastToolName: '',

    // Test-Driven Quality Gate
    lastTestRunAt: 0,
    testRunInProgress: false,

    // Recovery
    attempts: 0,
    lastRecoveryTime: 0,
    backoffAttempts: 0,
    autoSubmitCount: 0,
    aborting: false,
    recoveryStartTime: 0,
    stallDetections: 0,
    recoverySuccessful: 0,
    recoveryFailed: 0,
    lastRecoverySuccess: 0,
    totalRecoveryTimeMs: 0,
    recoveryTimes: [],
    lastStallPartType: "",
    stallPatterns: {},
    continueTimestamps: [],

    // Session Control
    userCancelled: false,
    planning: false,
    planBuffer: '',
    compacting: false,
    sessionCreatedAt: now,
    messageCount: 0,
    lastKnownStatus: 'unknown',

    // Compaction
    estimatedTokens: 0,
    realTokens: 0,
    lastRealTokenRefreshAt: 0,
    lastCompactionAt: 0,
    tokenLimitHits: 0,
    hardCompactionInProgress: false,
    lastHardCompactionAt: 0,
    compactionSafetyTimer: null,
    compactionTimedOut: false,
    lastCompactionFailedAt: 0,
    lastCompactionTimeoutAt: 0,
    lastCompactionCheckAt: 0,
    realTokensBaseline: 0,
    proactiveCompactCount: 0,
    hardCompactCount: 0,

    // Nudge
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

    // Concurrency Guard
    recoveryInProgress: false,

    // Continue Queue
    needsContinue: false,
    continueMessageText: '',
    continueRetryCount: 0,
    lastContinueRetryAt: 0,
    continueInProgress: false,
    lastContinueAt: 0,

    // Timer Generation
    timerGeneration: 0,

    // Planning Timeout
    planningStartedAt: 0,

    // Review
    reviewFired: false,
    reviewDebounceTimer: null,
    reviewRetryTimer: null,
    lastReviewAt: 0,
    reviewCount: 0,

    // Message Tracking
    lastUserMessageId: '',
    sentMessageAt: 0,

    // Recovery Intent
    lastFileEdited: '',
    lastToolCall: '',
    lastToolSummary: '',

    // Status File
    statusHistory: [],

    // Stop Conditions
    stoppedByCondition: null,

    // Dangerous Commands
    systemTransformHookCalled: false,
    dangerousCommandPromptTimer: null,

    // Idle Dedup
    idleProcessingDone: false,
  };
}

/**
 * Get the effective token count for a session.
 *
 * After compaction, the estimated tokens are reduced by the compaction reduction factor,
 * but they can drift low if accumulation undershoots. This function uses the actual
 * DB growth since last compaction as a floor to prevent underestimating by more than
 * ~80k tokens between compactions.
 *
 * @param s - The session state to query
 * @returns The effective token count (the higher of estimated or real growth since baseline)
 */
export function getTokenCount(s: SessionState): number {
  if (s.realTokensBaseline > 0 && s.realTokens > 0) {
    const growth = Math.max(0, s.realTokens - s.realTokensBaseline);
    return Math.max(s.estimatedTokens, growth);
  }
  return s.realTokens > 0 ? s.realTokens : s.estimatedTokens;
}

/**
 * Timer fields in SessionState that need to be cleared.
 */
const SESSION_TIMER_FIELDS = [
  'timer',
  'nudgeTimer',
  'nudgeRetryTimer',
  'reviewDebounceTimer',
  'reviewRetryTimer',
  'compactionSafetyTimer',
  'dangerousCommandPromptTimer',
] as const;

/**
 * Clear all timer references in a session state and call clearTimeout on each.
 *
 * @param s - The session state whose timers should be cleared
 */
export function clearAllSessionTimers(s: SessionState): void {
  for (const field of SESSION_TIMER_FIELDS) {
    const t = s[field] as ReturnType<typeof setTimeout> | null;
    if (t) {
      clearTimeout(t);
      s[field] = null as unknown as ReturnType<typeof setTimeout>;
    }
  }
}