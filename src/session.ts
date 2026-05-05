import type { SessionState } from "../config.js";

export function createSession(id: string): SessionState {
  return {
    timer: null,
    attempts: 0,
    lastRecoveryTime: 0,
    lastProgressAt: Date.now(),
    aborting: false,
    userCancelled: false,
    planning: false,
    planBuffer: "",
    compacting: false,
    backoffAttempts: 0,
    autoSubmitCount: 0,
    lastUserMessageId: "",
    sentMessageAt: 0,
    reviewFired: false,
    reviewDebounceTimer: null,
    nudgeTimer: null,
    lastNudgeAt: 0,
    hasOpenTodos: false,
    needsContinue: false,
    continueMessageText: "",
    sessionCreatedAt: Date.now(),
    messageCount: 0,
    estimatedTokens: 0,
    lastCompactionAt: 0,
    tokenLimitHits: 0,
    actionStartedAt: 0,
    toastTimer: null,
    stallDetections: 0,
    recoverySuccessful: 0,
    recoveryFailed: 0,
    lastRecoverySuccess: 0,
    totalRecoveryTimeMs: 0,
    recoveryStartTime: 0,
    statusHistory: [],
    recoveryTimes: [],
    lastStallPartType: "",
    stallPatterns: {},
    wasBusy: false,
  };
}

export function updateProgress(s: SessionState) {
  s.lastProgressAt = Date.now();
  s.lastIdleSeen = Date.now();
}

export function formatMessage(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

export function estimateTokens(text: string): number {
  const englishRatio = 0.75;
  const codeRatio = 1.0;
  const digitRatio = 0.5;
  const codeChars = new Set("{}[]();+-*/=<>!&||^~%@#$");
  const digitChars = new Set("0123456789");

  let english = 0, code = 0, digits = 0;
  for (const ch of text) {
    if (digitChars.has(ch)) digits++;
    else if (codeChars.has(ch)) code++;
    else english++;
  }
  return Math.ceil((english * englishRatio + code * codeRatio + digits * digitRatio) / 4);
}
