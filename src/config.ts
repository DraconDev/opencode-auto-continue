/**
 * Configuration module
 * 
 * Contains PluginConfig interface, DEFAULT_CONFIG, and validation.
 * Extracted from shared.ts to reduce file size.
 */

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
  continueWithPlanMessage: string;
  tokenLimitPatterns: string[];
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
  compactReductionFactor: number;
  compactAtMessageCount: number;
  tokenEstimateMultiplier: number; // FIX 5: Configurable multiplier for token estimation
  dcpDetected: boolean;
  dcpVersion: string | null;
  
  // Plan-Driven Continue
  planDrivenContinue: boolean;
  planFilePath: string | null;
  planAutoMarkComplete: boolean;
  planMaxItemsPerContinue: number;

  // AI Advisory
  enableAdvisory: boolean;
  advisoryModel: string;
  advisoryTimeoutMs: number;
  advisoryMaxTokens: number;
  advisoryTemperature: number;

  // Session Monitor
  subagentWaitMs: number;
  orphanWaitMs?: number;
  sessionDiscoveryIntervalMs: number;
  idleSessionTimeoutMs: number;
  idleCleanupMs?: number;
  maxSessions: number;
  sessionMonitorEnabled?: boolean;
  orphanParentDetection: boolean;
  sessionDiscovery: boolean;
  idleCleanup: boolean;
}

export const DEFAULT_CONFIG: PluginConfig = {
  stallTimeoutMs: 180000,
  waitAfterAbortMs: 5000,
  maxRecoveries: 3,
  cooldownMs: 60000,
  abortPollIntervalMs: 200,
  abortPollMaxTimeMs: 5000,
  abortPollMaxFailures: 3,
  debug: false,
  maxBackoffMs: 1800000,
  maxAutoSubmits: 3,
  shortContinueMessage: "Continue.",
  continueWithPlanMessage: "Please continue with your plan. You were in the middle of creating a plan — pick up where you left off.",
  continueMessage: "Please continue from where you left off.",
  continueWithTodosMessage: "Please continue from where you left off. You have {pending} open task(s): {todoList}.",
  maxAttemptsMessage: "I've tried to continue several times but haven't seen progress. Please send a new message when you're ready to continue.",
  includeTodoContext: true,
  reviewOnComplete: true,
  reviewMessage: "All tasks have been completed. Please run the test suite (e.g., `npm test`, `cargo test`, `go test`) and verify everything passes. If you find any failing tests, bugs, or issues that need fixing, create appropriate todos for them. Also check if there are any lint errors or build issues. Report the results: how many tests passed/failed, and what fixes are needed.",
  reviewDebounceMs: 500,
  showToasts: true,
  nudgeEnabled: true,
  nudgeIdleDelayMs: 500,
  nudgeMaxSubmits: 3,
  nudgeMessage: "The session has {pending} open task(s) that still need to be completed: {todoList}. Please continue working on these tasks.",
  nudgeCooldownMs: 60000,
  tokenLimitPatterns: ["context length", "maximum context length", "token count exceeds", "too many tokens", "payload too large", "token limit exceeded"],
  terminalTitleEnabled: true,
  statusFileEnabled: true,
  autoCompact: true,
  maxSessionAgeMs: 7200000,
  proactiveCompactAtTokens: 100000,
  proactiveCompactAtPercent: 50,
  compactRetryDelayMs: 3000,
  compactMaxRetries: 3,
  statusFilePath: "",
  maxStatusHistory: 10,
  statusFileRotate: 5,
  recoveryHistogramEnabled: true,
  stallPatternDetection: true,
  terminalProgressEnabled: true,
  compactionVerifyWaitMs: 10000,
  compactCooldownMs: 60000,
  compactReductionFactor: 0.7,
  compactAtMessageCount: 50,
  tokenEstimateMultiplier: 1.0, // FIX 5: Default to 1.0 (no arbitrary inflation)
  dcpDetected: false,
  dcpVersion: null,
  
  // Plan-Driven Continue defaults
  planDrivenContinue: false,
  planFilePath: null,
  planAutoMarkComplete: true,
  planMaxItemsPerContinue: 3,

  // AI Advisory defaults
  enableAdvisory: false,
  advisoryModel: "",
  advisoryTimeoutMs: 5000,
  advisoryMaxTokens: 500,
  advisoryTemperature: 0.1,

  // Session Monitor defaults
  subagentWaitMs: 15000,
  orphanWaitMs: 15000,
  sessionDiscoveryIntervalMs: 60000,
  idleSessionTimeoutMs: 600000,
  idleCleanupMs: 600000,
  maxSessions: 50,
  sessionMonitorEnabled: true,
  orphanParentDetection: true,
  sessionDiscovery: true,
  idleCleanup: true,
};

export function validateConfig(config: PluginConfig): PluginConfig {
  const normalized: PluginConfig = { ...config };
  if (typeof normalized.orphanWaitMs === "number") {
    normalized.subagentWaitMs = normalized.orphanWaitMs;
  }
  if (typeof normalized.idleCleanupMs === "number") {
    normalized.idleSessionTimeoutMs = normalized.idleCleanupMs;
  }
  if (normalized.sessionMonitorEnabled === false) {
    normalized.orphanParentDetection = false;
    normalized.sessionDiscovery = false;
    normalized.idleCleanup = false;
  }

  const errors: string[] = [];
  
  if (normalized.stallTimeoutMs <= 0) errors.push(`stallTimeoutMs must be > 0, got ${normalized.stallTimeoutMs}`);
  if (normalized.waitAfterAbortMs <= 0) errors.push(`waitAfterAbortMs must be > 0, got ${normalized.waitAfterAbortMs}`);
  if (normalized.stallTimeoutMs < normalized.waitAfterAbortMs) errors.push(`stallTimeoutMs (${normalized.stallTimeoutMs}) must be >= waitAfterAbortMs (${normalized.waitAfterAbortMs})`);
  if (normalized.maxRecoveries < 0) errors.push(`maxRecoveries must be >= 0, got ${normalized.maxRecoveries}`);
  if (normalized.cooldownMs < 0) errors.push(`cooldownMs must be >= 0, got ${normalized.cooldownMs}`);
  if (normalized.abortPollIntervalMs <= 0) errors.push(`abortPollIntervalMs must be > 0, got ${normalized.abortPollIntervalMs}`);
  if (normalized.abortPollMaxTimeMs < 0) errors.push(`abortPollMaxTimeMs must be >= 0, got ${normalized.abortPollMaxTimeMs}`);
  if (normalized.abortPollMaxFailures <= 0) errors.push(`abortPollMaxFailures must be > 0, got ${normalized.abortPollMaxFailures}`);
  if (normalized.maxBackoffMs < normalized.stallTimeoutMs) errors.push(`maxBackoffMs (${normalized.maxBackoffMs}) must be >= stallTimeoutMs (${normalized.stallTimeoutMs})`);
  if (normalized.maxAutoSubmits < 0) errors.push(`maxAutoSubmits must be >= 0, got ${normalized.maxAutoSubmits}`);
  if (!normalized.continueMessage || typeof normalized.continueMessage !== 'string') errors.push(`continueMessage must be a non-empty string`);
  if (!normalized.reviewMessage || typeof normalized.reviewMessage !== 'string') errors.push(`reviewMessage must be a non-empty string`);
  if (normalized.reviewDebounceMs < 0) errors.push(`reviewDebounceMs must be >= 0, got ${normalized.reviewDebounceMs}`);
  if (normalized.proactiveCompactAtTokens < 0) errors.push(`proactiveCompactAtTokens must be >= 0, got ${normalized.proactiveCompactAtTokens}`);
  if (normalized.proactiveCompactAtPercent < 0 || normalized.proactiveCompactAtPercent > 100) errors.push(`proactiveCompactAtPercent must be between 0 and 100, got ${normalized.proactiveCompactAtPercent}`);
  if (normalized.compactRetryDelayMs < 0) errors.push(`compactRetryDelayMs must be >= 0, got ${normalized.compactRetryDelayMs}`);
  if (normalized.compactMaxRetries < 0) errors.push(`compactMaxRetries must be >= 0, got ${normalized.compactMaxRetries}`);
  if (normalized.compactCooldownMs < 0) errors.push(`compactCooldownMs must be >= 0, got ${normalized.compactCooldownMs}`);
  if (typeof normalized.compactReductionFactor !== 'number' || normalized.compactReductionFactor <= 0 || normalized.compactReductionFactor >= 1) errors.push(`compactReductionFactor must be between 0 and 1 (exclusive), got ${normalized.compactReductionFactor}`);
  if (normalized.nudgeIdleDelayMs < 0) errors.push(`nudgeIdleDelayMs must be >= 0, got ${normalized.nudgeIdleDelayMs}`);
  if (normalized.nudgeMaxSubmits < 0) errors.push(`nudgeMaxSubmits must be >= 0, got ${normalized.nudgeMaxSubmits}`);
  if (!normalized.shortContinueMessage || normalized.shortContinueMessage.trim().length === 0) errors.push(`shortContinueMessage must be non-empty`);
  if (!normalized.continueWithPlanMessage || normalized.continueWithPlanMessage.trim().length === 0) errors.push(`continueWithPlanMessage must be non-empty`);
  if (!Array.isArray(normalized.tokenLimitPatterns) || normalized.tokenLimitPatterns.length === 0) errors.push(`tokenLimitPatterns must be a non-empty array`);

  if (normalized.subagentWaitMs < 0) errors.push(`subagentWaitMs must be >= 0, got ${normalized.subagentWaitMs}`);
  if (normalized.sessionDiscoveryIntervalMs < 0) errors.push(`sessionDiscoveryIntervalMs must be >= 0, got ${normalized.sessionDiscoveryIntervalMs}`);
  if (normalized.idleSessionTimeoutMs < 0) errors.push(`idleSessionTimeoutMs must be >= 0, got ${normalized.idleSessionTimeoutMs}`);
  if (normalized.maxSessions < 0) errors.push(`maxSessions must be >= 0, got ${normalized.maxSessions}`);

  // Plan-driven continue validation
  if (normalized.planMaxItemsPerContinue < 1) errors.push(`planMaxItemsPerContinue must be >= 1, got ${normalized.planMaxItemsPerContinue}`);
  if (normalized.planFilePath !== null && (typeof normalized.planFilePath !== 'string' || normalized.planFilePath.trim().length === 0)) errors.push(`planFilePath must be null or a non-empty string`);

  if (errors.length > 0) {
    return { ...DEFAULT_CONFIG };
  }
  
  return normalized;
}
