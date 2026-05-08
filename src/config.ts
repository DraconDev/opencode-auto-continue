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
  sessionDiscoveryIntervalMs: number;
  idleSessionTimeoutMs: number;
  maxSessions: number;
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
  sessionDiscoveryIntervalMs: 60000,
  idleSessionTimeoutMs: 600000,
  maxSessions: 50,
  orphanParentDetection: true,
  sessionDiscovery: true,
  idleCleanup: true,
};

export function validateConfig(config: PluginConfig): PluginConfig {
  const errors: string[] = [];
  
  if (config.stallTimeoutMs <= 0) errors.push(`stallTimeoutMs must be > 0, got ${config.stallTimeoutMs}`);
  if (config.waitAfterAbortMs <= 0) errors.push(`waitAfterAbortMs must be > 0, got ${config.waitAfterAbortMs}`);
  if (config.stallTimeoutMs < config.waitAfterAbortMs) errors.push(`stallTimeoutMs (${config.stallTimeoutMs}) must be >= waitAfterAbortMs (${config.waitAfterAbortMs})`);
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
  if (config.proactiveCompactAtTokens < 0) errors.push(`proactiveCompactAtTokens must be >= 0, got ${config.proactiveCompactAtTokens}`);
  if (config.proactiveCompactAtPercent < 0 || config.proactiveCompactAtPercent > 100) errors.push(`proactiveCompactAtPercent must be between 0 and 100, got ${config.proactiveCompactAtPercent}`);
  if (config.compactRetryDelayMs < 0) errors.push(`compactRetryDelayMs must be >= 0, got ${config.compactRetryDelayMs}`);
  if (config.compactMaxRetries < 0) errors.push(`compactMaxRetries must be >= 0, got ${config.compactMaxRetries}`);
  if (config.compactCooldownMs < 0) errors.push(`compactCooldownMs must be >= 0, got ${config.compactCooldownMs}`);
  if (typeof config.compactReductionFactor !== 'number' || config.compactReductionFactor <= 0 || config.compactReductionFactor >= 1) errors.push(`compactReductionFactor must be between 0 and 1 (exclusive), got ${config.compactReductionFactor}`);
  if (config.nudgeIdleDelayMs < 0) errors.push(`nudgeIdleDelayMs must be >= 0, got ${config.nudgeIdleDelayMs}`);
  if (config.nudgeMaxSubmits < 0) errors.push(`nudgeMaxSubmits must be >= 0, got ${config.nudgeMaxSubmits}`);
  if (!config.shortContinueMessage || config.shortContinueMessage.trim().length === 0) errors.push(`shortContinueMessage must be non-empty`);
  if (!config.continueWithPlanMessage || config.continueWithPlanMessage.trim().length === 0) errors.push(`continueWithPlanMessage must be non-empty`);
  if (!Array.isArray(config.tokenLimitPatterns) || config.tokenLimitPatterns.length === 0) errors.push(`tokenLimitPatterns must be a non-empty array`);

  if (config.subagentWaitMs < 0) errors.push(`subagentWaitMs must be >= 0, got ${config.subagentWaitMs}`);
  if (config.sessionDiscoveryIntervalMs < 0) errors.push(`sessionDiscoveryIntervalMs must be >= 0, got ${config.sessionDiscoveryIntervalMs}`);
  if (config.idleSessionTimeoutMs < 0) errors.push(`idleSessionTimeoutMs must be >= 0, got ${config.idleSessionTimeoutMs}`);
  if (config.maxSessions < 0) errors.push(`maxSessions must be >= 0, got ${config.maxSessions}`);

  // Plan-driven continue validation
  if (config.planMaxItemsPerContinue < 1) errors.push(`planMaxItemsPerContinue must be >= 1, got ${config.planMaxItemsPerContinue}`);
  if (config.planFilePath !== null && (typeof config.planFilePath !== 'string' || config.planFilePath.trim().length === 0)) errors.push(`planFilePath must be null or a non-empty string`);

  if (errors.length > 0) {
    return { ...DEFAULT_CONFIG };
  }
  
  return config;
}
