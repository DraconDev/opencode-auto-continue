/**
 * Recovery State — stall recovery tracking, backoff, hallucination detection.
 */

export interface RecoveryState {
  // Core recovery tracking
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

  // Concurrency guard
  recoveryInProgress: boolean;

  // Timer race prevention
  timerGeneration: number;

  // Recovery intent (last action before stall)
  lastFileEdited: string;
  lastToolCall: string;
  lastToolSummary: string;

  // Hallucination loop detection
  continueTimestamps: number[];

  // User cancellation
  userCancelled: boolean;
}

export function createRecoveryDefaults(now: number): RecoveryState {
  return {
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
    recoveryInProgress: false,
    timerGeneration: 0,
    lastFileEdited: "",
    lastToolCall: "",
    lastToolSummary: "",
    continueTimestamps: [],
    userCancelled: false,
  };
}