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
  tokenEstimateMultiplier: number;

  // Opportunistic compaction
  opportunisticCompactAtTokens: number;
  opportunisticCompactAfterRecovery: boolean;
  opportunisticCompactOnIdle: boolean;
  opportunisticCompactBeforeNudge: boolean;
  opportunisticCompactAfterReview: boolean;
  nudgeCompactThreshold: number;

  // Hard compaction (blocking gate)
  hardCompactAtTokens: number;
  hardCompactMaxWaitMs: number;
  hardCompactBypassCooldown: boolean;

  // Compaction safety timeout
  compactionSafetyTimeoutMs: number;

  // Compaction grace period — prevents re-compaction immediately after session.compacted
  // while DB token counts may still be stale. All layers respect this, including hard.
  compactionGracePeriodMs: number;

  // Stop conditions
  stopFilePath: string;
  maxRuntimeMs: number;
  untilMarker: string;

  // Planning timeout
  planningTimeoutMs: number;

  // Busy-but-dead detection (session busy but no actual output)
  busyStallTimeoutMs: number;

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

  // Question auto-answer
  autoAnswerQuestions: boolean;

  // Test-Driven Quality Gate
  testOnIdle: boolean;
  testCommands: string[];
  testCommandTimeoutMs: number;
  testCommandGates: Record<string, string>;
  reviewWithoutTestsMessage: string;
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
  shortContinueMessage: "Continue. Create todos for any untracked work before starting it.",
  continueWithPlanMessage: "You were creating a plan. Finish the plan, **create todos for each planned item**, then start executing the first one. Do not stop to ask for confirmation.",
  continueMessage: "Continue from where you left off. Do not ask for permission — just proceed with the next step. For each task, write a test FIRST that defines the expected outcome, then implement the code to make it pass. Run `cargo test` to verify after each implementation. If you discover new work, create a todo for it before starting.",
  continueWithTodosMessage: "Continue from where you left off. You have {pending} open task(s): {todoList}. Work through these tasks. **Write a test first for each task, then implement the code.** Run `cargo test` to verify after each implementation. You must create todos for any new work you discover before starting it — do not do untracked work. Do not ask for permission or confirmation.",
  maxAttemptsMessage: "I've tried to continue several times but haven't seen progress. Please send a new message when you're ready to continue.",
  includeTodoContext: true,
  reviewOnComplete: true,
  reviewMessage: "All tracked tasks are marked complete. Running final verification:\n\n{testOutput}\n\n## Review Instructions\nAnalyze the test output above:\n- **If tests failed**: Create fix-todos for EACH failure (one per test name) before fixing.\n- **If tests passed**: Verify the scope is correct — did we only change what was asked? Are there new functions without corresponding tests?\n- **Check for warnings**: Build warnings, unused imports, dead code.\n\n**Create fix-todos for any bugs or failures before fixing them.** Keep working until all tests are green. Do not stop until everything passes.",
  reviewWithoutTestsMessage: "All tracked tasks are marked complete. Review the changes for correctness and completeness. Verify the scope is correct — did we only change what was asked? Are there new functions without corresponding tests? Check for warnings, unused imports, and dead code.",
  reviewDebounceMs: 500,
  showToasts: true,
  nudgeEnabled: true,
  nudgeIdleDelayMs: 0,
  nudgeMaxSubmits: 10,
  nudgeMessage: "You have {pending} unfinished task(s): {todoList}. Continue working on them and mark each as completed when done. **You must create todos for any new work you discover before starting it** — do not do untracked work. Do not ask for permission — act autonomously.",
  nudgeCooldownMs: 30000,
  tokenLimitPatterns: ["context length", "maximum context length", "token count exceeds", "too many tokens", "payload too large", "token limit exceeded"],
  terminalTitleEnabled: true,
  statusFileEnabled: true,
  autoCompact: true,
  maxSessionAgeMs: 7200000,
  proactiveCompactAtTokens: 80000,
  proactiveCompactAtPercent: 50,
  compactRetryDelayMs: 3000,
  compactMaxRetries: 3,
  statusFilePath: "",
  maxStatusHistory: 10,
  statusFileRotate: 5,
  recoveryHistogramEnabled: true,
  stallPatternDetection: true,
  terminalProgressEnabled: true,
  compactionVerifyWaitMs: 30000,
  compactCooldownMs: 60000,
  compactReductionFactor: 0.7,
  tokenEstimateMultiplier: 1.0,

  // Opportunistic compaction
  opportunisticCompactAtTokens: 60000,
  opportunisticCompactAfterRecovery: true,
  opportunisticCompactOnIdle: true,
  opportunisticCompactBeforeNudge: true,
  opportunisticCompactAfterReview: true,
  nudgeCompactThreshold: 80000,

  // Hard compaction (blocking gate)
  hardCompactAtTokens: 100000,
  hardCompactMaxWaitMs: 30000,
  hardCompactBypassCooldown: true,

  // Compaction safety timeout
  compactionSafetyTimeoutMs: 15000,

  // Compaction grace period — all layers skip if lastCompactionAt is within this window
  compactionGracePeriodMs: 10000,

  // Stop conditions
  stopFilePath: "",
  maxRuntimeMs: 0,
  untilMarker: "",

  // Planning timeout (default 5 minutes)
  planningTimeoutMs: 300000,

  // Busy-but-dead detection (default 1 minute — session busy but no real output)
  busyStallTimeoutMs: 60000,

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

  // Question auto-answer
  autoAnswerQuestions: false,

  // Test-Driven Quality Gate
  testOnIdle: true,
  testCommands: ["cargo test"],
  testCommandTimeoutMs: 300000,
  testCommandGates: {
    cargo: "Cargo.toml",
    pnpm: "package.json",
    npm: "package.json",
    yarn: "package.json",
    npx: "package.json",
    pnpx: "package.json",
    bun: "package.json",
    deno: "deno.json",
    make: "Makefile",
    just: "justfile",
    go: "go.mod",
    pip: "pyproject.toml",
    pip3: "pyproject.toml",
    pytest: "pyproject.toml",
    python: "setup.py",
    gradle: "build.gradle",
    mvn: "pom.xml",
  },
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

  // Track invalid fields explicitly rather than parsing error messages
  const invalidFields = new Set<string>();
  const errors: string[] = [];
  
  const addError = (field: keyof PluginConfig, message: string) => {
    invalidFields.add(String(field));
    errors.push(message);
  };
  
  if (normalized.stallTimeoutMs <= 0) addError('stallTimeoutMs', `stallTimeoutMs must be > 0, got ${normalized.stallTimeoutMs}`);
  if (normalized.waitAfterAbortMs <= 0) addError('waitAfterAbortMs', `waitAfterAbortMs must be > 0, got ${normalized.waitAfterAbortMs}`);
  if (normalized.stallTimeoutMs < normalized.waitAfterAbortMs) addError('stallTimeoutMs', `stallTimeoutMs (${normalized.stallTimeoutMs}) must be >= waitAfterAbortMs (${normalized.waitAfterAbortMs})`);
  if (normalized.maxRecoveries < 0) addError('maxRecoveries', `maxRecoveries must be >= 0, got ${normalized.maxRecoveries}`);
  if (normalized.cooldownMs < 0) addError('cooldownMs', `cooldownMs must be >= 0, got ${normalized.cooldownMs}`);
  if (normalized.abortPollIntervalMs <= 0) addError('abortPollIntervalMs', `abortPollIntervalMs must be > 0, got ${normalized.abortPollIntervalMs}`);
  if (normalized.abortPollMaxTimeMs < 0) addError('abortPollMaxTimeMs', `abortPollMaxTimeMs must be >= 0, got ${normalized.abortPollMaxTimeMs}`);
  if (normalized.abortPollMaxFailures <= 0) addError('abortPollMaxFailures', `abortPollMaxFailures must be > 0, got ${normalized.abortPollMaxFailures}`);
  if (normalized.maxBackoffMs < normalized.stallTimeoutMs) addError('maxBackoffMs', `maxBackoffMs (${normalized.maxBackoffMs}) must be >= stallTimeoutMs (${normalized.stallTimeoutMs})`);
  if (!normalized.continueMessage || typeof normalized.continueMessage !== 'string') addError('continueMessage', `continueMessage must be a non-empty string`);
  if (!normalized.reviewMessage || typeof normalized.reviewMessage !== 'string') addError('reviewMessage', `reviewMessage must be a non-empty string`);
  if (!normalized.reviewWithoutTestsMessage || typeof normalized.reviewWithoutTestsMessage !== 'string') addError('reviewWithoutTestsMessage', `reviewWithoutTestsMessage must be a non-empty string`);
  if (normalized.reviewDebounceMs < 0) addError('reviewDebounceMs', `reviewDebounceMs must be >= 0, got ${normalized.reviewDebounceMs}`);
  if (normalized.proactiveCompactAtTokens < 0) addError('proactiveCompactAtTokens', `proactiveCompactAtTokens must be >= 0, got ${normalized.proactiveCompactAtTokens}`);
  if (normalized.proactiveCompactAtPercent < 0 || normalized.proactiveCompactAtPercent > 100) addError('proactiveCompactAtPercent', `proactiveCompactAtPercent must be between 0 and 100, got ${normalized.proactiveCompactAtPercent}`);
  if (normalized.compactRetryDelayMs < 0) addError('compactRetryDelayMs', `compactRetryDelayMs must be >= 0, got ${normalized.compactRetryDelayMs}`);
  if (normalized.compactMaxRetries < 0) addError('compactMaxRetries', `compactMaxRetries must be >= 0, got ${normalized.compactMaxRetries}`);
  if (normalized.compactCooldownMs < 0) addError('compactCooldownMs', `compactCooldownMs must be >= 0, got ${normalized.compactCooldownMs}`);
  if (typeof normalized.compactReductionFactor !== 'number' || normalized.compactReductionFactor <= 0 || normalized.compactReductionFactor >= 1) addError('compactReductionFactor', `compactReductionFactor must be between 0 and 1 (exclusive), got ${normalized.compactReductionFactor}`);
  
  // New config options validation
  if (normalized.planningTimeoutMs < 0) addError('planningTimeoutMs', `planningTimeoutMs must be >= 0, got ${normalized.planningTimeoutMs}`);
  if (normalized.busyStallTimeoutMs < 0) addError('busyStallTimeoutMs', `busyStallTimeoutMs must be >= 0, got ${normalized.busyStallTimeoutMs}`);
  if (typeof normalized.tokenEstimateMultiplier !== 'number' || normalized.tokenEstimateMultiplier <= 0) addError('tokenEstimateMultiplier', `tokenEstimateMultiplier must be a positive number, got ${normalized.tokenEstimateMultiplier}`);
  if (normalized.nudgeIdleDelayMs < 0) addError('nudgeIdleDelayMs', `nudgeIdleDelayMs must be >= 0, got ${normalized.nudgeIdleDelayMs}`);
  if (normalized.nudgeMaxSubmits < 0) addError('nudgeMaxSubmits', `nudgeMaxSubmits must be >= 0, got ${normalized.nudgeMaxSubmits}`);
  if (!normalized.shortContinueMessage || normalized.shortContinueMessage.trim().length === 0) addError('shortContinueMessage', `shortContinueMessage must be non-empty`);
  if (!normalized.continueWithPlanMessage || normalized.continueWithPlanMessage.trim().length === 0) addError('continueWithPlanMessage', `continueWithPlanMessage must be non-empty`);
  if (!Array.isArray(normalized.tokenLimitPatterns) || normalized.tokenLimitPatterns.length === 0) addError('tokenLimitPatterns', `tokenLimitPatterns must be a non-empty array`);

  if (normalized.subagentWaitMs < 0) addError('subagentWaitMs', `subagentWaitMs must be >= 0, got ${normalized.subagentWaitMs}`);
  if (normalized.sessionDiscoveryIntervalMs < 0) addError('sessionDiscoveryIntervalMs', `sessionDiscoveryIntervalMs must be >= 0, got ${normalized.sessionDiscoveryIntervalMs}`);
  if (normalized.idleSessionTimeoutMs < 0) addError('idleSessionTimeoutMs', `idleSessionTimeoutMs must be >= 0, got ${normalized.idleSessionTimeoutMs}`);
  if (normalized.maxSessions < 0) addError('maxSessions', `maxSessions must be >= 0, got ${normalized.maxSessions}`);

  if (normalized.opportunisticCompactAtTokens < 0) addError('opportunisticCompactAtTokens', `opportunisticCompactAtTokens must be >= 0, got ${normalized.opportunisticCompactAtTokens}`);
  if (normalized.nudgeCompactThreshold < 0) addError('nudgeCompactThreshold', `nudgeCompactThreshold must be >= 0, got ${normalized.nudgeCompactThreshold}`);
  if (normalized.hardCompactAtTokens < 0) addError('hardCompactAtTokens', `hardCompactAtTokens must be >= 0, got ${normalized.hardCompactAtTokens}`);
  if (normalized.hardCompactMaxWaitMs < 0) addError('hardCompactMaxWaitMs', `hardCompactMaxWaitMs must be >= 0, got ${normalized.hardCompactMaxWaitMs}`);
  if (normalized.compactionSafetyTimeoutMs < 0) addError('compactionSafetyTimeoutMs', `compactionSafetyTimeoutMs must be >= 0, got ${normalized.compactionSafetyTimeoutMs}`);
  if (normalized.compactionGracePeriodMs < 0) addError('compactionGracePeriodMs', `compactionGracePeriodMs must be >= 0, got ${normalized.compactionGracePeriodMs}`);
  if (normalized.maxRuntimeMs < 0) addError('maxRuntimeMs', `maxRuntimeMs must be >= 0, got ${normalized.maxRuntimeMs}`);

  if (typeof normalized.autoAnswerQuestions !== 'boolean') addError('autoAnswerQuestions', `autoAnswerQuestions must be a boolean, got ${typeof normalized.autoAnswerQuestions}`);

  if (typeof normalized.testOnIdle !== 'boolean') addError('testOnIdle', `testOnIdle must be a boolean, got ${typeof normalized.testOnIdle}`);
  if (!Array.isArray(normalized.testCommands) || normalized.testCommands.length === 0 || !normalized.testCommands.every((c: unknown) => typeof c === 'string')) addError('testCommands', `testCommands must be a non-empty array of strings`);
  // Warn about shell injection risk in testCommands
  const SHELL_META_RE = /[;&|`$]/;
  if (Array.isArray(normalized.testCommands)) {
    for (const cmd of normalized.testCommands) {
      if (typeof cmd === 'string' && SHELL_META_RE.test(cmd)) {
        console.warn(`[opencode-auto-continue] WARNING: testCommand "${cmd}" contains shell metacharacters (;&|$\`). This runs via shell — ensure commands are from a trusted config.`);
      }
    }
  }
  if (normalized.testCommandTimeoutMs <= 0) addError('testCommandTimeoutMs', `testCommandTimeoutMs must be > 0, got ${normalized.testCommandTimeoutMs}`);
  if (normalized.testCommandGates && typeof normalized.testCommandGates !== 'object') addError('testCommandGates', `testCommandGates must be an object, got ${typeof normalized.testCommandGates}`);

  if (errors.length > 0) {
    console.warn(`[opencode-auto-continue] Config validation errors:\n${errors.map(e => `  - ${e}`).join('\n')}`);
    const result = { ...DEFAULT_CONFIG };
    
    (Object.keys(normalized) as Array<keyof PluginConfig>).forEach((key) => {
      if (!invalidFields.has(String(key))) {
        (result as any)[key] = normalized[key];
      }
    });
    
    return result;
  }
  
  return normalized;
}
