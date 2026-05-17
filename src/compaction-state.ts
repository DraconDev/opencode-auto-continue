/**
 * Compaction State — token tracking, compaction triggers, safety timers.
 */

export interface CompactionState {
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
  compacting: boolean;
  // Fields from other states that compaction logic reads
  planning: boolean;
  stoppedByCondition: string | null;
}

export function createCompactionDefaults(now: number): CompactionState {
  return {
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
    compacting: false,
    planning: false,
    stoppedByCondition: null,
  };
}