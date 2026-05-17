/**
 * Continue State — queued continue after stall recovery.
 */

export interface ContinueState {
  needsContinue: boolean;
  continueMessageText: string;
  continueRetryCount: number;
  lastContinueRetryAt: number;
  continueInProgress: boolean;
  lastContinueAt: number;
}

export function createContinueDefaults(): ContinueState {
  return {
    needsContinue: false,
    continueMessageText: '',
    continueRetryCount: 0,
    lastContinueRetryAt: 0,
    continueInProgress: false,
    lastContinueAt: 0,
  };
}