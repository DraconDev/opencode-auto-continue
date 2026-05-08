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

  // === Compaction (compaction.ts) ===
  estimatedTokens: number;
  lastCompactionAt: number;
  tokenLimitHits: number;

  // === Nudge (nudge.ts) ===
  nudgeTimer: ReturnType<typeof setTimeout> | null;
  lastNudgeAt: number;
  nudgeCount: number;
  lastTodoSnapshot: string;
  nudgePaused: boolean;
  hasOpenTodos: boolean;
  lastKnownTodos: Array<{ id: string; status: string; content?: string; title?: string }>;

  // === Continue Queue (recovery.ts, review.ts) ===
  needsContinue: boolean;
  continueMessageText: string;

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

    estimatedTokens: 0,
    lastCompactionAt: 0,
    tokenLimitHits: 0,

    nudgeTimer: null,
    lastNudgeAt: 0,
    nudgeCount: 0,
    lastTodoSnapshot: '',
    nudgePaused: false,
    hasOpenTodos: false,
    lastKnownTodos: [],

    needsContinue: false,
    continueMessageText: '',

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
