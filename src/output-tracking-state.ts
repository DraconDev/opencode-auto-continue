/**
 * Output Tracking State — busy-but-dead detection, tool loop detection.
 */

export interface OutputTrackingState {
  lastOutputAt: number;
  lastOutputLength: number;
  lastToolExecutionAt: number;
  toolRepeatCount: number;
  lastToolName: string;
}

export function createOutputTrackingDefaults(now: number): OutputTrackingState {
  return {
    lastOutputAt: now,
    lastOutputLength: 0,
    lastToolExecutionAt: now,
    toolRepeatCount: 0,
    lastToolName: '',
  };
}