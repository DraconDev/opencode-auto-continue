/**
 * Timer State — stall timer, progress tracking, terminal timer.
 */

export interface TimerState {
  timer: ReturnType<typeof setTimeout> | null;
  lastProgressAt: number;
  actionStartedAt: number;
}

export function createTimerDefaults(now: number): TimerState {
  return {
    timer: null,
    lastProgressAt: now,
    actionStartedAt: 0,
  };
}