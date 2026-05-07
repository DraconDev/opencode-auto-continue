import type { PluginInput } from "@opencode-ai/plugin";
import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";

export type TypedPluginInput = PluginInput;

export interface SessionState {
  // === Timer & Progress (terminal.ts, index.ts) ===
  timer: ReturnType<typeof setTimeout> | null;
  lastProgressAt: number;
  actionStartedAt: number;

  // === Recovery (recovery.ts) ===
  attempts: number;
  lastRecoveryTime: number;
  backoffAttempts: number;
  autoSubmitCount: number;
  aborting: boolean;
  recoveryStartTime: number;
  stallDetections: number;
  recoverySuccessful: number;
  recoveryFailed: number;
  lastRecoverySuccess: number;
  totalRecoveryTimeMs: number;
  recoveryTimes: number[];
  lastStallPartType: string;
  stallPatterns: Record<string, number>;
  continueTimestamps: number[]; // Hallucination loop detection

  // === Session Control (index.ts) ===
  userCancelled: boolean;
  planning: boolean;
  planBuffer: string;
  compacting: boolean;
  sessionCreatedAt: number;
  messageCount: number;

  // === Compaction (compaction.ts) ===
  estimatedTokens: number;
  lastCompactionAt: number;
  tokenLimitHits: number;

  // === Nudge (nudge.ts) ===
  nudgeTimer: ReturnType<typeof setTimeout> | null;
  lastNudgeAt: number;
  nudgeCount: number;
  lastTodoSnapshot: string;
  nudgePaused: boolean;
  hasOpenTodos: boolean;
  lastKnownTodos: Array<{ id: string; status: string; content?: string; title?: string }>;

  // === Continue Queue (recovery.ts, review.ts) ===
  needsContinue: boolean;
  continueMessageText: string;

  // === Review (review.ts) ===
  reviewFired: boolean;
  reviewDebounceTimer: ReturnType<typeof setTimeout> | null;

  // === Message Tracking (index.ts) ===
  lastUserMessageId: string;
  sentMessageAt: number;

  // === Advisory (ai-advisor.ts, recovery.ts, nudge.ts) ===
  lastAdvisoryAdvice: { action: string; confidence: number; reasoning: string; stallPattern?: string; customPrompt?: string; contextSummary?: string } | null;

  // === Status File (status-file.ts) ===
  statusHistory: Array<{ timestamp: string; status: string; actionDuration: string; progressAgo: string }>;
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
  
  // === AI Advisory (ai-advisor.ts) ===
  enableAdvisory: boolean;
  advisoryModel: string;
  advisoryTimeoutMs: number;
  advisoryMaxTokens: number;
  advisoryTemperature: number;

  // === Session Monitor (session-monitor.ts) ===
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
  reviewMessage: "All tasks in this session have been completed. Please perform a final review: summarize what was accomplished, note any technical decisions or trade-offs made, flag anything that should be documented, check for any oversights or edge cases that might have been missed, suggest tests that should be added or run to verify the changes, and list any follow-up tasks or improvements for next time. If you find anything that needs fixing, please create appropriate todos.",
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

  if (errors.length > 0) {
    return { ...DEFAULT_CONFIG };
  }
  
  return config;
}

// Cache for model context limit to avoid re-reading opencode.json
// Encapsulated in a class to avoid module-level state pollution and improve testability
interface ModelCache {
  path: string | null;
  mtime: number;
  limit: number | null;
}

class ModelContextCache {
  private cache: ModelCache = { path: null, mtime: 0, limit: null };

  get(opencodeConfigPath: string): number | null {
    try {
      if (!existsSync(opencodeConfigPath)) return null;

      const stats = statSync(opencodeConfigPath, { throwIfNoEntry: false });
      const mtime = stats?.mtimeMs || 0;

      if (this.cache.path === opencodeConfigPath && this.cache.mtime === mtime && this.cache.limit !== null) {
        return this.cache.limit;
      }

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
  // === Session Monitor (session-monitor.ts) ===
  subagentWaitMs: number;
  sessionDiscoveryIntervalMs: number;
  idleSessionTimeoutMs: number;
  maxSessions: number;
  orphanParentDetection: boolean;
  sessionDiscovery: boolean;
  idleCleanup: boolean;
}
            }
          }
        }
      }

      this.cache.path = opencodeConfigPath;
      this.cache.mtime = mtime;
      this.cache.limit = limits.length > 0 ? Math.min(...limits) : null;

      return this.cache.limit;
    } catch {
      return null;
    }
  }

  invalidate(): void {
    this.cache = { path: null, mtime: 0, limit: null };
  }
}

const modelContextCache = new ModelContextCache();

export function getModelContextLimit(opencodeConfigPath: string): number | null {
  return modelContextCache.get(opencodeConfigPath);
}

export function invalidateModelLimitCache(): void {
  modelContextCache.invalidate();
}

export function getCompactionThreshold(modelContextLimit: number | null, config: PluginConfig): number {
  // Always compact at proactiveCompactAtTokens (default 100k)
  // The proactiveCompactAtPercent and 200k model distinction were over-engineered
  return config.proactiveCompactAtTokens;
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
  // More aggressive estimation: multiply by 2 to account for system prompt,
  // previous messages, and other context we can't see
  return Math.ceil((english * englishRatio + code * codeRatio + digits * digitRatio) / 4 * 2);
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Parse token counts from error messages.
 * OpenCode includes exact token counts in token limit error messages.
 * 
 * Examples:
 * - "You requested a total of 264230 tokens: 232230 tokens from the input messages and 32000 tokens for the completion."
 * - "This model's maximum context length is 128000 tokens. You requested 150000 tokens."
 * 
 * Returns: { total: number, input: number, output: number } or null if not found
 */
export function parseTokensFromError(error: any): { total: number; input: number; output: number } | null {
  if (!error) return null;
  const message = error.message || String(error);
  
  // Pattern 1: "You requested a total of 264230 tokens: 232230 tokens from the input messages and 32000 tokens for the completion."
  const detailedMatch = message.match(/total of (\d+) tokens[:\s]+(\d+) tokens.*?input.*?and (\d+) tokens.*?completion/i);
  if (detailedMatch) {
    return {
      total: parseInt(detailedMatch[1], 10),
      input: parseInt(detailedMatch[2], 10),
      output: parseInt(detailedMatch[3], 10),
    };
  }
  
  // Pattern 2: "You requested 264230 tokens" (simpler form)
  const simpleMatch = message.match(/requested (\d+) tokens/i);
  if (simpleMatch) {
    const total = parseInt(simpleMatch[1], 10);
    return { total, input: total, output: 0 };
  }
  
  // Pattern 3: "... 264230 tokens ..." (just extract the largest number near "tokens")
  const looseMatch = message.match(/(\d{4,})\s+tokens?/i);
  if (looseMatch) {
    const total = parseInt(looseMatch[1], 10);
    return { total, input: total, output: 0 };
  }
  
  return null;
}

export function createSession(): SessionState {
  const now = Date.now();
  return {
    // Timer & Progress
    timer: null,
    lastProgressAt: now,
    actionStartedAt: 0,

    // Recovery
    attempts: 0,
    lastRecoveryTime: 0,
    backoffAttempts: 0,
    autoSubmitCount: 0,
    aborting: false,
    recoveryStartTime: 0,
    stallDetections: 0,
    recoverySuccessful: 0,
    recoveryFailed: 0,
    lastRecoverySuccess: 0,
    totalRecoveryTimeMs: 0,
    recoveryTimes: [],
    lastStallPartType: "",
    stallPatterns: {},
    continueTimestamps: [],

    // Session Control
    userCancelled: false,
    planning: false,
    planBuffer: '',
    compacting: false,
    sessionCreatedAt: now,
    messageCount: 0,

    // Compaction
    estimatedTokens: 0,
    lastCompactionAt: 0,
    tokenLimitHits: 0,

    // Nudge
    nudgeTimer: null,
    lastNudgeAt: 0,
    nudgeCount: 0,
    lastTodoSnapshot: '',
    nudgePaused: false,
    hasOpenTodos: false,
    lastKnownTodos: [],

    // Continue Queue
    needsContinue: false,
    continueMessageText: '',

    // Review
    reviewFired: false,
    reviewDebounceTimer: null,

    // Message Tracking
    lastUserMessageId: '',
    sentMessageAt: 0,

    // Advisory
    lastAdvisoryAdvice: null,

    // Status File
    statusHistory: [],
  };
}

export function updateProgress(s: SessionState) {
  s.lastProgressAt = Date.now();
}

export function formatMessage(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

/**
 * Prompt guard — prevents duplicate injections within a time window.
 * Checks if a similar prompt was recently sent to the same session.
 */
export async function shouldBlockPrompt(
  sessionId: string,
  promptText: string,
  input: TypedPluginInput,
  log?: (...args: unknown[]) => void
): Promise<boolean> {
  try {
    const resp = await input.client.session.messages({
      path: { id: sessionId },
      query: { limit: 5 },
    });
    const messages = Array.isArray(resp.data) ? resp.data : [];
    const now = Date.now();
    
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as any;
      const role = msg.role || msg.info?.role;
      if (role !== "assistant") continue;
      
      const msgTime = msg.createdAt || msg.info?.createdAt || 0;
      if (now - msgTime > 30000) continue; // Only check last 30s
      
      const text = msg.text || msg.parts?.map((p: any) => p.text).join(" ") || "";
      // Check if the recent message contains similar content
      if (text && promptText && (
        text.includes(promptText.substring(0, 50)) ||
        promptText.includes(text.substring(0, 50))
      )) {
        log?.("prompt guard blocked duplicate injection", { sessionId, text: text.substring(0, 100) });
        return true;
      }
    }
  } catch (e) {
    // Fail-open: allow prompt if check fails
  }
  return false;
}
export async function safeHook(
  name: string,
  fn: () => Promise<void>,
  log?: (...args: unknown[]) => void
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log?.(`[${name}] hook failed:`, err);
  }
}

/**
 * Detect if Dynamic Context Pruning (DCP) plugin is installed.
 * DCP handles context optimization better than our naive compaction,
 * so we should disable our proactive compaction when it's present.
 */
export function detectDCP(): boolean {
  try {
    const home = process.env.HOME || "/tmp";
    
    // Check global config for DCP in plugins array
    const globalConfigPath = join(home, ".config", "opencode", "opencode.json");
    if (existsSync(globalConfigPath)) {
      const content = readFileSync(globalConfigPath, "utf-8");
      const cfg = JSON.parse(content);
      if (cfg.plugin && Array.isArray(cfg.plugin)) {
        for (const p of cfg.plugin) {
          const pluginName = Array.isArray(p) ? p[0] : p;
          if (typeof pluginName === "string" && 
              (pluginName.includes("dcp") || pluginName.includes("dynamic-context-pruning"))) {
            return true;
          }
        }
      }
    }
    
    // Check if DCP npm package is installed in opencode's plugin cache
    const dcpPaths = [
      join(home, ".config", "opencode", "plugins", "opencode-dynamic-context-pruning"),
      join(home, ".cache", "opencode", "node_modules", "@tarquinen", "opencode-dcp"),
      join(home, ".cache", "opencode", "node_modules", "opencode-dynamic-context-pruning"),
    ];
    
    for (const p of dcpPaths) {
      if (existsSync(p)) {
        return true;
      }
    }
    
    return false;
  } catch {
    return false;
  }
}

/**
 * Get the installed DCP version, or null if DCP is not installed.
 * Reads the package.json from known DCP installation paths.
 */
export function getDCPVersion(): string | null {
  try {
    const home = process.env.HOME || "/tmp";
    const dcpPkgPaths = [
      join(home, ".config", "opencode", "plugins", "opencode-dynamic-context-pruning", "package.json"),
      join(home, ".cache", "opencode", "node_modules", "@tarquinen", "opencode-dcp", "package.json"),
      join(home, ".cache", "opencode", "node_modules", "opencode-dynamic-context-pruning", "package.json"),
    ];
    
    for (const pkgPath of dcpPkgPaths) {
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        return (pkg.version as string) || null;
      }
    }
    
    return null;
  } catch {
    return null;
  }
}
