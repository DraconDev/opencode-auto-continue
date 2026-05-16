/**
 * Session State Module
 * 
 * Contains SessionState interface, Todo interface, createSession, and updateProgress.
 * Extracted from shared.ts to reduce file size.
 */

export interface Todo {
  id: string;
  content?: string;
  title?: string;
  status: string;
}

export interface SessionState {
  // === Timer & Progress (terminal.ts, index.ts) ===
  timer: ReturnType<typeof setTimeout> | null;
  lastProgressAt: number;
  actionStartedAt: number;
  
  // === Output Tracking (busy-but-dead detection) ===
  lastOutputAt: number;      // Last actual output (text/tool/file), not status ping
  lastOutputLength: number;  // Total content length to detect even small changes
  lastToolExecutionAt: number; // Last time a tool/file/subtask/step part was seen (text-only stall detection)
  toolRepeatCount: number;   // How many times the same tool was called consecutively
  lastToolName: string;     // Name of last tool executed (for loop detection)

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
  continueTimestamps: number[]; // Hallucination loop detection

  // === Session Control (index.ts) ===
  userCancelled: boolean;
  planning: boolean;
  planBuffer: string;
  compacting: boolean;
  sessionCreatedAt: number;
  messageCount: number;
  lastKnownStatus: string; // 'busy' | 'retry' | 'idle' | 'unknown'

  // === Compaction (compaction.ts) ===
  estimatedTokens: number;
  realTokens: number;
  lastRealTokenRefreshAt: number; // Throttle DB reads — only refresh every 10s
  lastCompactionAt: number;
  tokenLimitHits: number;
  hardCompactionInProgress: boolean;
  lastHardCompactionAt: number;
  compactionSafetyTimer: ReturnType<typeof setTimeout> | null;
  compactionTimedOut: boolean;
  lastCompactionFailedAt: number; // Timestamp of last compaction failure — backoff period
  realTokensBaseline: number; // Set to realTokens on compaction — signals DB values are cumulative, prefer estimatedTokens
  proactiveCompactCount: number;
  hardCompactCount: number;

  // === Nudge (nudge.ts) ===
  nudgeTimer: ReturnType<typeof setTimeout> | null;
  nudgeRetryTimer: ReturnType<typeof setTimeout> | null; // Retries nudge when blocked by compaction/planning
  nudgeRetryCount: number; // Count of nudge retries due to compaction blocking
  lastNudgeAt: number;
  nudgeCount: number;
  nudgeFailureCount: number; // FIX 8: Track nudge failures
  lastNudgeFailureAt: number; // FIX 8: Track last nudge failure time
  lastTodoSnapshot: string;
  nudgePaused: boolean;
  hasOpenTodos: boolean;
  lastKnownTodos: Array<{ id: string; status: string; content?: string; title?: string }>;

  // === Continue Queue (recovery.ts, review.ts) ===
  needsContinue: boolean;
  continueMessageText: string;
  continueRetryCount: number; // FIX 1: Track continue retry attempts
  lastContinueRetryAt: number; // FIX 1: Track last continue retry time
  continueInProgress: boolean; // FIX 2: Concurrency guard for sendContinue
  lastContinueAt: number; // Track when continue was sent for success toast

  // === Timer Generation (Fix 4: Prevent stale timer races) ===
  timerGeneration: number;

  // === Planning Timeout (Fix 3: Track when planning started) ===
  planningStartedAt: number;

  // === Review (review.ts) ===
  reviewFired: boolean;
  reviewDebounceTimer: ReturnType<typeof setTimeout> | null;
  lastReviewAt: number;
  reviewCount: number;

  // === Message Tracking (index.ts) ===
  lastUserMessageId: string;
  sentMessageAt: number;

  // === Plan-Driven Continue ===
  lastPlanItemDescription: string;

  // === Recovery Intent (recovery.ts) ===
  lastFileEdited: string;  // Last file URL edited before stall
  lastToolCall: string;    // Last tool call name before stall
  lastToolSummary: string; // Brief description of last action

  // === Status File (status-file.ts) ===
  statusHistory: Array<{ timestamp: string; status: string; actionDuration: string; progressAgo: string }>;

  // === Stop Conditions (stop-conditions) ===
  stoppedByCondition: string | null;
}

export function createSession(): SessionState {
  const now = Date.now();
  return {
    timer: null,
    lastProgressAt: now,
    actionStartedAt: 0,
    
    // Output Tracking (busy-but-dead detection)
    lastOutputAt: now,
    lastOutputLength: 0,
    lastToolExecutionAt: now,
    toolRepeatCount: 0,
    lastToolName: '',

    // Test-Driven Quality Gate
    lastTestRunAt: 0,
    testRunInProgress: false,

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

    userCancelled: false,
    planning: false,
    planBuffer: '',
    compacting: false,
    sessionCreatedAt: now,
    messageCount: 0,
    lastKnownStatus: 'unknown',

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
    realTokensBaseline: 0,
    proactiveCompactCount: 0,
    hardCompactCount: 0,

    nudgeTimer: null,
    nudgeRetryTimer: null,
    nudgeRetryCount: 0,
    lastNudgeAt: 0,
    nudgeCount: 0,
    nudgeFailureCount: 0, // FIX 8
    lastNudgeFailureAt: 0, // FIX 8
    lastTodoSnapshot: '',
    nudgePaused: false,
    hasOpenTodos: false,
    lastKnownTodos: [],

    needsContinue: false,
    continueMessageText: '',
    continueRetryCount: 0,
    lastContinueRetryAt: 0,
    continueInProgress: false, // FIX 2
    lastContinueAt: 0,

    // Timer Generation (Fix 4)
    timerGeneration: 0,

    // Planning Timeout (Fix 3)
    planningStartedAt: 0,

    reviewFired: false,
    reviewDebounceTimer: null,
    lastReviewAt: 0,
    reviewCount: 0,

    lastUserMessageId: '',
    sentMessageAt: 0,

    lastPlanItemDescription: '',

    lastFileEdited: '',
    lastToolCall: '',
    lastToolSummary: '',

    statusHistory: [],

    stoppedByCondition: null,
  };
}

export function getTokenCount(s: SessionState): number {
  if (s.realTokensBaseline > 0) {
    return s.estimatedTokens;
  }
  return s.realTokens > 0 ? s.realTokens : s.estimatedTokens;
}
