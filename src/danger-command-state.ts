/**
 * Dangerous Command State — policy injection, hook tracking.
 */

export interface DangerCommandState {
  systemTransformHookCalled: boolean;
  dangerousCommandPromptTimer: ReturnType<typeof setTimeout> | null;
}

export function createDangerCommandDefaults(): DangerCommandState {
  return {
    systemTransformHookCalled: false,
    dangerousCommandPromptTimer: null,
  };
}