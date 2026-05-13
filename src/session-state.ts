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
  lastCompactionAt: number;
  tokenLimitHits: number;

  // === Nudge (nudge.ts) ===
  nudgeTimer: ReturnType<typeof setTimeout> | null;
  lastNudgeAt: number;
  nudgeCount: number;
  nudgeFailureCount: number; // Track nudge failure count for backoff
  lastNudgeFailureAt: number; // Track last nudge failure timestamp
  lastTodoSnapshot: string;
  nudgePaused: boolean;
  hasOpenTodos: boolean;
  lastKnownTodos: Array<{ id: string; status: string; content?: string; title?: string }>;

  // === Continue Queue (recovery.ts, review.ts) ===
  needsContinue: boolean;
  continueMessageText: string;
  continueRetryCount: number; // Track continue retry count
  lastContinueRetryAt: number; // Track last continue retry timestamp
  continueInProgress: boolean; // Prevent concurrent sendContinue calls
  lastContinueAt: number; // Track when continue was sent for success toast

  // === Timer Generation (Fix 4: Prevent stale timer races) ===
  timerGeneration: number;

  // === Planning Timeout (Fix 3: Track when planning started) ===
  planningStartedAt: number;

  // === Review (review.ts) ===
  reviewFired: boolean;
  reviewDebounceTimer: ReturnType<typeof setTimeout> | null;

  // === Message Tracking (index.ts) ===
  lastUserMessageId: string;
  sentMessageAt: number;

  // === Advisory (ai-advisor.ts, recovery.ts, nudge.ts) ===
  lastAdvisoryAdvice: { action: string; confidence: number; reasoning: string; stallPattern?: string; customPrompt?: string; contextSummary?: string } | null;

  // === Plan-Driven Continue (plan.ts) ===
  lastPlanItemDescription: string;

  // === Status File (status-file.ts) ===
  statusHistory: Array<{ timestamp: string; status: string; actionDuration: string; progressAgo: string }>;
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
    lastCompactionAt: 0,
    tokenLimitHits: 0,

    nudgeTimer: null,
    lastNudgeAt: 0,
    nudgeCount: 0,
    nudgeFailureCount: 0, // 
    lastNudgeFailureAt: 0, // 
    lastTodoSnapshot: '',
    nudgePaused: false,
    hasOpenTodos: false,
    lastKnownTodos: [],

    needsContinue: false,
    continueMessageText: '',
    continueRetryCount: 0,
    lastContinueRetryAt: 0,
    continueInProgress: false, // 
    lastContinueAt: 0,

    // Timer Generation (Fix 4)
    timerGeneration: 0,

    // Planning Timeout (Fix 3)
    planningStartedAt: 0,

    reviewFired: false,
    reviewDebounceTimer: null,

    lastUserMessageId: '',
    sentMessageAt: 0,

    lastAdvisoryAdvice: null,

    lastPlanItemDescription: '',

    statusHistory: [],
  };
}

export function updateProgress(s: SessionState) {
  s.lastProgressAt = Date.now();
}
