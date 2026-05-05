import type { Plugin } from "@opencode-ai/plugin";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

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
  nudgeCount: number;
  lastTodoSnapshot: string;
  nudgePaused: boolean;
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
  abortPollIntervalMs: number;
  abortPollMaxTimeMs: number;
  abortPollMaxFailures: number;
  debug: boolean;
  maxBackoffMs: number;
  maxAutoSubmits: number;
  continueMessage: string;
  continueWithTodosMessage: string;
  maxAttemptsMessage: string;
  includeTodoContext: boolean;
  reviewOnComplete: boolean;
  reviewMessage: string;
  reviewDebounceMs: number;
  showToasts: boolean;
  nudgeEnabled: boolean;
  nudgeIdleDelayMs: number;
  nudgeMaxSubmits: number;
  nudgeMessage: string;
  nudgeCooldownMs: number;
  autoCompact: boolean;
  maxSessionAgeMs: number;
  proactiveCompactAtTokens: number;
  proactiveCompactAtPercent: number;
  compactRetryDelayMs: number;
  compactMaxRetries: number;
  shortContinueMessage: string;
  tokenLimitPatterns: string[];
  timerToastEnabled: boolean;
  timerToastIntervalMs: number;
  terminalTitleEnabled: boolean;
  statusFileEnabled: boolean;
  statusFilePath: string;
  maxStatusHistory: number;
  statusFileRotate: number;
  recoveryHistogramEnabled: boolean;
  stallPatternDetection: boolean;
  terminalProgressEnabled: boolean;
  compactionVerifyWaitMs: number;
  compactCooldownMs: number;
}

export const DEFAULT_CONFIG: PluginConfig = {
  stallTimeoutMs: 180000,
  waitAfterAbortMs: 1500,
  maxRecoveries: 3,
  cooldownMs: 60000,
  abortPollIntervalMs: 200,
  abortPollMaxTimeMs: 5000,
  abortPollMaxFailures: 3,
  debug: false,
  maxBackoffMs: 1800000,
  maxAutoSubmits: 3,
  continueMessage: "Please continue from where you left off.",
  continueWithTodosMessage: "Please continue from where you left off. You have {pending} open task(s): {todoList}.",
  maxAttemptsMessage: "I've tried to continue several times but haven't seen progress. Please send a new message when you're ready to continue.",
  includeTodoContext: true,
  reviewOnComplete: true,
  reviewMessage: "All tasks in this session have been completed. Please perform a final review: summarize what was accomplished, note any technical decisions or trade-offs made, flag anything that should be documented, check for any oversights or edge cases that might have been missed, suggest tests that should be added or run to verify the changes, and list any follow-up tasks or improvements for next time. If you find anything that needs fixing, please create appropriate todos.",
  reviewDebounceMs: 500,
  showToasts: false,
  nudgeEnabled: true,
  nudgeIdleDelayMs: 500,
  nudgeMaxSubmits: 3,
  nudgeMessage: "The session has {pending} open task(s) that still need to be completed: {todoList}. Please continue working on these tasks.",
  nudgeCooldownMs: 60000,
  autoCompact: true,
  maxSessionAgeMs: 7200000,
  proactiveCompactAtTokens: 100000,
  proactiveCompactAtPercent: 50,
  compactRetryDelayMs: 3000,
  compactMaxRetries: 3,
  shortContinueMessage: "Continue.",
  tokenLimitPatterns: [
    'context length',
    'maximum context length',
    'token count exceeds',
    'too many tokens',
    'tokens exceeds',
    'exceeds maximum token limit',
    'payload too large',
    'request too large',
    'context window',
    'input length',
    'message too long',
    'token limit',
    'exceeds token',
  ],
  timerToastEnabled: true,
  timerToastIntervalMs: 60000,
  terminalTitleEnabled: true,
  statusFileEnabled: true,
  statusFilePath: "",
  maxStatusHistory: 10,
  statusFileRotate: 5,
  recoveryHistogramEnabled: true,
  stallPatternDetection: true,
  terminalProgressEnabled: true,
  compactionVerifyWaitMs: 10000,
  compactCooldownMs: 120000,
};

export function validateConfig(config: PluginConfig): PluginConfig {
  const errors: string[] = [];
  
  if (config.stallTimeoutMs <= 0) errors.push(`stallTimeoutMs must be > 0, got ${config.stallTimeoutMs}`);
  if (config.waitAfterAbortMs <= 0) errors.push(`waitAfterAbortMs must be > 0, got ${config.waitAfterAbortMs}`);
  if (config.stallTimeoutMs <= config.waitAfterAbortMs) errors.push(`stallTimeoutMs (${config.stallTimeoutMs}) must be > waitAfterAbortMs (${config.waitAfterAbortMs})`);
  if (config.maxRecoveries < 0) errors.push(`maxRecoveries must be >= 0, got ${config.maxRecoveries}`);
  if (config.cooldownMs < 0) errors.push(`cooldownMs must be >= 0, got ${config.cooldownMs}`);
  if (config.abortPollIntervalMs <= 0) errors.push(`abortPollIntervalMs must be > 0, got ${config.abortPollIntervalMs}`);
  if (config.abortPollMaxTimeMs < 0) errors.push(`abortPollMaxTimeMs must be >= 0, got ${config.abortPollMaxTimeMs}`);
  if (config.abortPollMaxFailures <= 0) errors.push(`abortPollMaxFailures must be > 0, got ${config.abortPollMaxFailures}`);
  if (config.maxBackoffMs < config.stallTimeoutMs) errors.push(`maxBackoffMs (${config.maxBackoffMs}) must be >= stallTimeoutMs (${config.stallTimeoutMs})`);
  if (config.maxAutoSubmits < 0) errors.push(`maxAutoSubmits must be >= 0, got ${config.maxAutoSubmits}`);
  if (!config.continueMessage || typeof config.continueMessage !== 'string') errors.push(`continueMessage must be a non-empty string`);
  if (!config.reviewMessage || typeof config.reviewMessage !== 'string') errors.push(`reviewMessage must be a non-empty string`);
  if (config.reviewDebounceMs < 0) errors.push(`reviewDebounceMs must be >= 0, got ${config.reviewDebounceMs}`);
  if (config.timerToastIntervalMs < 10000) errors.push(`timerToastIntervalMs must be >= 10000, got ${config.timerToastIntervalMs}`);
  if (config.proactiveCompactAtTokens < 0) errors.push(`proactiveCompactAtTokens must be >= 0, got ${config.proactiveCompactAtTokens}`);
  if (config.proactiveCompactAtPercent < 0 || config.proactiveCompactAtPercent > 100) errors.push(`proactiveCompactAtPercent must be between 0 and 100, got ${config.proactiveCompactAtPercent}`);
  if (config.compactRetryDelayMs < 0) errors.push(`compactRetryDelayMs must be >= 0, got ${config.compactRetryDelayMs}`);
  if (config.compactMaxRetries < 0) errors.push(`compactMaxRetries must be >= 0, got ${config.compactMaxRetries}`);
  if (config.compactCooldownMs < 0) errors.push(`compactCooldownMs must be >= 0, got ${config.compactCooldownMs}`);
  if (!config.shortContinueMessage || config.shortContinueMessage.trim().length === 0) errors.push(`shortContinueMessage must be non-empty`);
  if (!Array.isArray(config.tokenLimitPatterns) || config.tokenLimitPatterns.length === 0) errors.push(`tokenLimitPatterns must be a non-empty array`);

  if (errors.length > 0) {
    return { ...DEFAULT_CONFIG };
  }
  
  return config;
}

export function getModelContextLimit(opencodeConfigPath: string): number | null {
  try {
    if (!existsSync(opencodeConfigPath)) return null;
    const content = readFileSync(opencodeConfigPath, 'utf-8');
    const config = JSON.parse(content);
    
    const limits: number[] = [];
    if (config.provider) {
      for (const provider of Object.values(config.provider)) {
        const p = provider as any;
        if (p.models) {
          for (const model of Object.values(p.models)) {
            const m = model as any;
            if (m.limit?.context && typeof m.limit.context === 'number') {
              limits.push(m.limit.context);
            }
          }
        }
      }
    }
    
    if (limits.length > 0) {
      return Math.min(...limits);
    }
    
    return null;
  } catch {
    return null;
  }
}

export function getCompactionThreshold(modelContextLimit: number | null, config: PluginConfig): number {
  if (!modelContextLimit || modelContextLimit <= 0) {
    return config.proactiveCompactAtTokens;
  }
  
  const thresholdPercent = modelContextLimit * (config.proactiveCompactAtPercent / 100);
  
  if (modelContextLimit >= 200000) {
    return Math.min(config.proactiveCompactAtTokens, thresholdPercent);
  } else {
    const smallModelThreshold = Math.min(75000, config.proactiveCompactAtTokens);
    return Math.min(smallModelThreshold, thresholdPercent);
  }
}

export const PLAN_PATTERNS = [
  /^here\s+is\s+(my|the)\s+plan/i,
  /^here'[rs]\s+(my|the)\s+plan/i,
  /^##\s*plan\b/i,
  /^\*\*plan:\*\*$/i,
  /^##\s*proposed\s+plan/i,
  /^##\s*implementation\s+plan/i,
  /^plan:\s*/i,
  /^\d+[\.\)]\s*step\s+\d+/i,
  /^-\s*\[x\]\s/i,
  /^-\s*\[\s\]\s/i,
  /^let\s+me\s+outline/i,
  /^here'?s?\s+(what i|what we|how i|how we)/i,
  /^my\s+plan\s+is/i,
  /^step\s+\d+[\:\.]/i,
  /^\d+\.\s+[A-Z]/i,
  /^-\s+[A-Z][^\.]*$/im,
  /^\*\s+[A-Z][^\.]*$/im,
];

export function isPlanContent(text: string): boolean {
  return PLAN_PATTERNS.some(pattern => pattern.test(text.trim()));
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

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function createSession(): SessionState {
  const now = Date.now();
  return {
    timer: null,
    attempts: 0,
    lastRecoveryTime: 0,
    lastProgressAt: now,
    aborting: false,
    userCancelled: false,
    planning: false,
    planBuffer: '',
    compacting: false,
    backoffAttempts: 0,
    autoSubmitCount: 0,
    lastUserMessageId: '',
    sentMessageAt: 0,
    reviewFired: false,
    reviewDebounceTimer: null,
    nudgeTimer: null,
    lastNudgeAt: 0,
    hasOpenTodos: false,
    needsContinue: false,
    continueMessageText: '',
    sessionCreatedAt: now,
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
}

export function formatMessage(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}
