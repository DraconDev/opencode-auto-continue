import type { Plugin } from "@opencode-ai/plugin";

export interface SessionState {
  timer: ReturnType<typeof setTimeout> | null;
  attempts: number;
  lastRecoveryTime: number;
  lastProgressAt: number;
  aborting: boolean;
  userCancelled: boolean;
  planning: boolean;
  planBuffer: string;
  compacting: boolean;
  backoffAttempts: number;
  autoSubmitCount: number;
  lastUserMessageId: string;
  sentMessageAt: number;
  reviewFired: boolean;
  reviewDebounceTimer: ReturnType<typeof setTimeout> | null;
  nudgeTimer: ReturnType<typeof setTimeout> | null;
  lastNudgeAt: number;
  hasOpenTodos: boolean;
  needsContinue: boolean;
  continueMessageText: string;
  sessionCreatedAt: number;
  messageCount: number;
  estimatedTokens: number;
  lastCompactionAt: number;
  tokenLimitHits: number;
  actionStartedAt: number;
  toastTimer: ReturnType<typeof setInterval> | null;
  stallDetections: number;
  recoverySuccessful: number;
  recoveryFailed: number;
  lastRecoverySuccess: number;
  totalRecoveryTimeMs: number;
  recoveryStartTime: number;
  statusHistory: Array<{ timestamp: string; status: string; actionDuration: string; progressAgo: string }>;
  recoveryTimes: number[];
  lastStallPartType: string;
  stallPatterns: Record<string, number>;
  wasBusy: boolean;
}

export interface PluginConfig {
  stallTimeoutMs: number;
  waitAfterAbortMs: number;
  maxRecoveries: number;
  cooldownMs: number;
  maxBackoffMs: number;
  autoCompact: boolean;
  shortContinueMessage: string;
  maxAutoSubmits: number;
  maxSessionAgeMs: number;
  includeTodoContext: boolean;
  reviewOnComplete: boolean;
  reviewMessage: string;
  reviewDebounceMs: number;
  nudgeEnabled: boolean;
  nudgeTimeoutMs: number;
  nudgeMessage: string;
  nudgeCooldownMs: number;
  stallTimeoutDisabled: boolean;
  waitAfterAbortDisabled: boolean;
  tokenLimitPatterns: string[];
  proactiveCompactAtTokens: number;
  proactiveCompactAtPercent: number;
  compactRetryDelayMs: number;
  compactMaxRetries: number;
  compactionVerifyWaitMs: number;
  compactCooldownMs: number;
  timerToastEnabled: boolean;
  timerToastIntervalMs: number;
  terminalTitleEnabled: boolean;
  terminalProgressEnabled: boolean;
  showToasts: boolean;
  debug: boolean;
  statusFileEnabled: boolean;
  statusFilePath: string;
  maxStatusHistory: number;
  statusFileRotate: number;
  recoveryHistogramEnabled: boolean;
  stallPatternDetection: boolean;
}

export const defaultConfig: PluginConfig = {
  stallTimeoutMs: 180000,
  waitAfterAbortMs: 2000,
  maxRecoveries: 3,
  cooldownMs: 60000,
  maxBackoffMs: 1800000,
  autoCompact: true,
  shortContinueMessage: "Continue.",
  maxAutoSubmits: 3,
  maxSessionAgeMs: 7200000,
  includeTodoContext: true,
  reviewOnComplete: true,
  reviewMessage: "All tasks in this session have been completed. Please perform a final review: summarize what was accomplished, note any technical decisions or trade-offs made, flag anything that should be documented, check for any oversights or edge cases that might have been missed, suggest tests that should be added or run to verify the changes, and list any follow-up tasks or improvements for next time. If you find anything that needs fixing, please create appropriate todos.",
  reviewDebounceMs: 500,
  nudgeEnabled: true,
  nudgeTimeoutMs: 300000,
  nudgeMessage: "The session has {pending} open task(s) that still need to be completed: {todoList}. Please continue working on these tasks.",
  nudgeCooldownMs: 60000,
  stallTimeoutDisabled: false,
  waitAfterAbortDisabled: false,
  tokenLimitPatterns: [
    "context_length_exceeded",
    "context limit",
    "maximum context length",
    "token limit",
    "too many tokens",
    "context window",
    "exceeds model context",
    "context is too large",
    "message too long",
    "maximum tokens",
    "exceeds the maximum",
    "context overflow",
    "input too long",
  ],
  proactiveCompactAtTokens: 100000,
  proactiveCompactAtPercent: 50,
  compactRetryDelayMs: 3000,
  compactMaxRetries: 3,
  compactionVerifyWaitMs: 10000,
  compactCooldownMs: 120000,
  timerToastEnabled: true,
  timerToastIntervalMs: 60000,
  terminalTitleEnabled: true,
  terminalProgressEnabled: true,
  showToasts: false,
  debug: false,
  statusFileEnabled: true,
  statusFilePath: "",
  maxStatusHistory: 10,
  statusFileRotate: 5,
  recoveryHistogramEnabled: true,
  stallPatternDetection: true,
};

export function validateConfig(input: Partial<PluginConfig>): { config: PluginConfig; errors: string[] } {
  const config: PluginConfig = { ...defaultConfig };
  const errors: string[] = [];

  if (input.stallTimeoutMs !== undefined) config.stallTimeoutMs = input.stallTimeoutMs;
  if (input.waitAfterAbortMs !== undefined) config.waitAfterAbortMs = input.waitAfterAbortMs;
  if (input.maxRecoveries !== undefined) config.maxRecoveries = input.maxRecoveries;
  if (input.cooldownMs !== undefined) config.cooldownMs = input.cooldownMs;
  if (input.maxBackoffMs !== undefined) config.maxBackoffMs = input.maxBackoffMs;
  if (input.autoCompact !== undefined) config.autoCompact = input.autoCompact;
  if (input.shortContinueMessage !== undefined) config.shortContinueMessage = input.shortContinueMessage;
  if (input.maxAutoSubmits !== undefined) config.maxAutoSubmits = input.maxAutoSubmits;
  if (input.maxSessionAgeMs !== undefined) config.maxSessionAgeMs = input.maxSessionAgeMs;
  if (input.includeTodoContext !== undefined) config.includeTodoContext = input.includeTodoContext;
  if (input.reviewOnComplete !== undefined) config.reviewOnComplete = input.reviewOnComplete;
  if (input.reviewMessage !== undefined) config.reviewMessage = input.reviewMessage;
  if (input.reviewDebounceMs !== undefined) config.reviewDebounceMs = input.reviewDebounceMs;
  if (input.nudgeEnabled !== undefined) config.nudgeEnabled = input.nudgeEnabled;
  if (input.nudgeTimeoutMs !== undefined) config.nudgeTimeoutMs = input.nudgeTimeoutMs;
  if (input.nudgeMessage !== undefined) config.nudgeMessage = input.nudgeMessage;
  if (input.nudgeCooldownMs !== undefined) config.nudgeCooldownMs = input.nudgeCooldownMs;
  if (input.stallTimeoutDisabled !== undefined) config.stallTimeoutDisabled = input.stallTimeoutDisabled;
  if (input.waitAfterAbortDisabled !== undefined) config.waitAfterAbortDisabled = input.waitAfterAbortDisabled;
  if (input.tokenLimitPatterns !== undefined) config.tokenLimitPatterns = input.tokenLimitPatterns;
  if (input.proactiveCompactAtTokens !== undefined) config.proactiveCompactAtTokens = input.proactiveCompactAtTokens;
  if (input.proactiveCompactAtPercent !== undefined) config.proactiveCompactAtPercent = input.proactiveCompactAtPercent;
  if (input.compactRetryDelayMs !== undefined) config.compactRetryDelayMs = input.compactRetryDelayMs;
  if (input.compactMaxRetries !== undefined) config.compactMaxRetries = input.compactMaxRetries;
  if (input.compactionVerifyWaitMs !== undefined) config.compactionVerifyWaitMs = input.compactionVerifyWaitMs;
  if (input.compactCooldownMs !== undefined) config.compactCooldownMs = input.compactCooldownMs;
  if (input.timerToastEnabled !== undefined) config.timerToastEnabled = input.timerToastEnabled;
  if (input.timerToastIntervalMs !== undefined) config.timerToastIntervalMs = input.timerToastIntervalMs;
  if (input.terminalTitleEnabled !== undefined) config.terminalTitleEnabled = input.terminalTitleEnabled;
  if (input.terminalProgressEnabled !== undefined) config.terminalProgressEnabled = input.terminalProgressEnabled;
  if (input.showToasts !== undefined) config.showToasts = input.showToasts;
  if (input.debug !== undefined) config.debug = input.debug;
  if (input.statusFileEnabled !== undefined) config.statusFileEnabled = input.statusFileEnabled;
  if (input.statusFilePath !== undefined) config.statusFilePath = input.statusFilePath;
  if (input.maxStatusHistory !== undefined) config.maxStatusHistory = input.maxStatusHistory;
  if (input.statusFileRotate !== undefined) config.statusFileRotate = input.statusFileRotate;
  if (input.recoveryHistogramEnabled !== undefined) config.recoveryHistogramEnabled = input.recoveryHistogramEnabled;
  if (input.stallPatternDetection !== undefined) config.stallPatternDetection = input.stallPatternDetection;

  if (config.stallTimeoutMs <= config.waitAfterAbortMs) {
    errors.push(`stallTimeoutMs (${config.stallTimeoutMs}) must be > waitAfterAbortMs (${config.waitAfterAbortMs}) — using defaults`);
  }
  if (config.maxRecoveries < 0) {
    errors.push(`maxRecoveries (${config.maxRecoveries}) must be >= 0 — using defaults`);
  }
  if (config.cooldownMs < 0) {
    errors.push(`cooldownMs (${config.cooldownMs}) must be >= 0 — using defaults`);
  }
  if (config.maxBackoffMs < 0) {
    errors.push(`maxBackoffMs (${config.maxBackoffMs}) must be >= 0 — using defaults`);
  }
  if (!Array.isArray(config.tokenLimitPatterns) || config.tokenLimitPatterns.length === 0) {
    errors.push(`tokenLimitPatterns must be a non-empty array — using defaults`);
  }
  if (config.proactiveCompactAtTokens < 0) {
    errors.push(`proactiveCompactAtTokens (${config.proactiveCompactAtTokens}) must be >= 0 — using defaults`);
  }
  if (config.proactiveCompactAtPercent < 0 || config.proactiveCompactAtPercent > 100) {
    errors.push(`proactiveCompactAtPercent (${config.proactiveCompactAtPercent}) must be 0-100 — using defaults`);
  }
  if (config.compactRetryDelayMs < 0) {
    errors.push(`compactRetryDelayMs must be >= 0, got ${config.compactRetryDelayMs} — using defaults`);
  }
  if (config.compactMaxRetries < 0) {
    errors.push(`compactMaxRetries must be >= 0, got ${config.compactMaxRetries} — using defaults`);
  }
  if (config.compactionVerifyWaitMs < 0) {
    errors.push(`compactionVerifyWaitMs must be >= 0, got ${config.compactionVerifyWaitMs} — using defaults`);
  }
  if (config.compactCooldownMs < 0) {
    errors.push(`compactCooldownMs must be >= 0, got ${config.compactCooldownMs} — using defaults`);
  }
  if (!config.shortContinueMessage || config.shortContinueMessage.trim().length === 0) {
    errors.push(`shortContinueMessage must be non-empty — using defaults`);
  }

  if (errors.length > 0) {
    return { config: defaultConfig, errors };
  }

  return { config, errors: [] };
}
