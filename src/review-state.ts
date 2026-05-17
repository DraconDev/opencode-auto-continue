/**
 * Review State — review on completion, debounce, retry timers.
 */

export interface ReviewState {
  reviewFired: boolean;
  reviewDebounceTimer: ReturnType<typeof setTimeout> | null;
  reviewRetryTimer: ReturnType<typeof setTimeout> | null;
  lastReviewAt: number;
  reviewCount: number;
}

export function createReviewDefaults(now: number): ReviewState {
  return {
    reviewFired: false,
    reviewDebounceTimer: null,
    reviewRetryTimer: null,
    lastReviewAt: 0,
    reviewCount: 0,
  };
}