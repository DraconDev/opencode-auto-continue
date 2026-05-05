import type { Plugin } from "@opencode-ai/plugin";
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join, dirname } from "path";

interface SessionState {
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
}

interface PluginConfig {
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
  nudgeTimeoutMs: number;
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
}

const DEFAULT_CONFIG: PluginConfig = {
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
  reviewMessage: "All tasks in this session have been completed. Please perform a final review: summarize what was accomplished, note any technical decisions or trade-offs made, flag anything that should be documented, and list any follow-up tasks or improvements for next time.",
  reviewDebounceMs: 500,
  showToasts: false,
  nudgeEnabled: true,
  nudgeTimeoutMs: 300000,
  nudgeMessage: "You have {pending} open task(s). Send a message when you're ready to continue.",
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
};

function validateConfig(config: PluginConfig): PluginConfig {
  const errors: string[] = [];
  
  if (config.stallTimeoutMs <= 0) {
    errors.push(`stallTimeoutMs must be > 0, got ${config.stallTimeoutMs}`);
  }
  if (config.waitAfterAbortMs <= 0) {
    errors.push(`waitAfterAbortMs must be > 0, got ${config.waitAfterAbortMs}`);
  }
  if (config.stallTimeoutMs <= config.waitAfterAbortMs) {
    errors.push(`stallTimeoutMs (${config.stallTimeoutMs}) must be > waitAfterAbortMs (${config.waitAfterAbortMs})`);
  }
  if (config.maxRecoveries < 0) {
    errors.push(`maxRecoveries must be >= 0, got ${config.maxRecoveries}`);
  }
  if (config.cooldownMs < 0) {
    errors.push(`cooldownMs must be >= 0, got ${config.cooldownMs}`);
  }
  if (config.abortPollIntervalMs <= 0) {
    errors.push(`abortPollIntervalMs must be > 0, got ${config.abortPollIntervalMs}`);
  }
  if (config.abortPollMaxTimeMs < 0) {
    errors.push(`abortPollMaxTimeMs must be >= 0, got ${config.abortPollMaxTimeMs}`);
  }
  if (config.abortPollMaxFailures <= 0) {
    errors.push(`abortPollMaxFailures must be > 0, got ${config.abortPollMaxFailures}`);
  }

  if (config.maxBackoffMs < config.stallTimeoutMs) {
    errors.push(`maxBackoffMs (${config.maxBackoffMs}) must be >= stallTimeoutMs (${config.stallTimeoutMs})`);
  }
  if (config.maxAutoSubmits < 0) {
    errors.push(`maxAutoSubmits must be >= 0, got ${config.maxAutoSubmits}`);
  }
  if (!config.continueMessage || typeof config.continueMessage !== 'string') {
    errors.push(`continueMessage must be a non-empty string`);
  }
  if (!config.reviewMessage || typeof config.reviewMessage !== 'string') {
    errors.push(`reviewMessage must be a non-empty string`);
  }
  if (config.reviewDebounceMs < 0) {
    errors.push(`reviewDebounceMs must be >= 0, got ${config.reviewDebounceMs}`);
  }

  if (config.proactiveCompactAtTokens < 0) {
    errors.push(`proactiveCompactAtTokens must be >= 0, got ${config.proactiveCompactAtTokens}`);
  }
  if (config.proactiveCompactAtPercent < 0 || config.proactiveCompactAtPercent > 100) {
    errors.push(`proactiveCompactAtPercent must be between 0 and 100, got ${config.proactiveCompactAtPercent}`);
  }
  if (config.compactRetryDelayMs < 0) {
    errors.push(`compactRetryDelayMs must be >= 0, got ${config.compactRetryDelayMs}`);
  }
  if (config.compactMaxRetries < 0) {
    errors.push(`compactMaxRetries must be >= 0, got ${config.compactMaxRetries}`);
  }
  if (!config.shortContinueMessage || typeof config.shortContinueMessage !== 'string') {
    errors.push(`shortContinueMessage must be a non-empty string`);
  }
  if (!Array.isArray(config.tokenLimitPatterns) || config.tokenLimitPatterns.length === 0) {
    errors.push(`tokenLimitPatterns must be a non-empty array`);
  }
  if (config.timerToastIntervalMs < 10000) {
    errors.push(`timerToastIntervalMs must be >= 10000, got ${config.timerToastIntervalMs}`);
  }

  if (errors.length > 0) {
    try {
      const vLogDir = join(process.env.HOME || "/tmp", ".opencode", "logs");
      const vLogFile = join(vLogDir, "auto-force-resume.log");
      if (!existsSync(vLogDir)) mkdirSync(vLogDir, { recursive: true });
      appendFileSync(vLogFile, `[${new Date().toISOString()}] [auto-force-resume] Config validation failed, using defaults: ${errors.join(', ')}\n`);
    } catch {
      // ignore
    }
    return { ...DEFAULT_CONFIG };
  }
  
  return config;
}

// Model context limit detection from opencode.json
function getModelContextLimit(opencodeConfigPath: string): number | null {
  try {
    if (!existsSync(opencodeConfigPath)) return null;
    const content = readFileSync(opencodeConfigPath, 'utf-8');
    const config = JSON.parse(content);
    
    // Extract all model context limits from provider configurations
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
    
    // Return the smallest context limit (most restrictive)
    if (limits.length > 0) {
      return Math.min(...limits);
    }
    
    return null;
  } catch (e) {
    return null;
  }
}

// Calculate adaptive compaction threshold based on model context limit
function getCompactionThreshold(modelContextLimit: number | null, config: PluginConfig): number {
  if (!modelContextLimit || modelContextLimit <= 0) {
    // Fallback to fixed token threshold if no model limit detected
    return config.proactiveCompactAtTokens;
  }
  
  const thresholdPercent = modelContextLimit * (config.proactiveCompactAtPercent / 100);
  
  // For large models (>= 200k): use min(fixed, percentage)
  // For small models (< 200k): use min(fixed_small, percentage)
  if (modelContextLimit >= 200000) {
    return Math.min(config.proactiveCompactAtTokens, thresholdPercent);
  } else {
    // For smaller models, use a more conservative fixed threshold
    const smallModelThreshold = Math.min(75000, config.proactiveCompactAtTokens);
    return Math.min(smallModelThreshold, thresholdPercent);
  }
}

export const AutoForceResumePlugin: Plugin = async (input, options) => {
  let config: PluginConfig = {
    ...DEFAULT_CONFIG,
    ...(typeof options === "object" && options !== null ? options as Partial<PluginConfig> : {}),
  };
  config = validateConfig(config);

  const sessions = new Map<string, SessionState>();
  let isDisposed = false;

  function getSession(id: string): SessionState {
    if (!sessions.has(id)) {
      sessions.set(id, {
        timer: null,
        attempts: 0,
        lastRecoveryTime: 0,
        lastProgressAt: Date.now(),
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
      });
    }
    return sessions.get(id)!;
  }

  function clearTimer(id: string) {
    const s = sessions.get(id);
    if (s?.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
  }

  function resetSession(id: string) {
    clearTimer(id);
    const s = sessions.get(id);
    if (s) {
      s.planBuffer = '';
      s.planning = false;
      s.compacting = false;
      s.backoffAttempts = 0;
      s.autoSubmitCount = 0;
      s.lastUserMessageId = '';
      s.sentMessageAt = 0;
      s.reviewFired = false;
      if (s.reviewDebounceTimer) {
        clearTimeout(s.reviewDebounceTimer);
        s.reviewDebounceTimer = null;
      }
      if (s.nudgeTimer) {
        clearTimeout(s.nudgeTimer);
        s.nudgeTimer = null;
      }
      s.lastNudgeAt = 0;
      s.hasOpenTodos = false;
      s.needsContinue = false;
      s.continueMessageText = '';
      s.messageCount = 0;
      s.estimatedTokens = 0;
      s.lastCompactionAt = 0;
      s.tokenLimitHits = 0;
      s.actionStartedAt = 0;
      s.stallDetections = 0;
      s.recoverySuccessful = 0;
      s.recoveryFailed = 0;
      s.lastRecoverySuccess = 0;
      if (s.toastTimer) {
        clearInterval(s.toastTimer);
        s.toastTimer = null;
      }
    }
    sessions.delete(id);
  }

  function updateProgress(s: SessionState) {
    s.lastProgressAt = Date.now();
  }

  const PLAN_PATTERNS = [
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
    /^here'?s?\s+(my|the)\s+approach/i,
    /^i('ll|'m going to| will)\s+start\s+by/i,
    /^(first|to start|initially),?\s+(i('ll|'m)|we('ll|'re))/i,
    /^here'?s?\s+(what i|what we|how i|how we)/i,
    /^my\s+plan\s+is/i,
    /^step\s+\d+[\:\.]/i,
    /^\d+\.\s+[A-Z]/i,
    /^-\s+[A-Z][^\.]*$/im,
    /^\*\s+[A-Z][^\.]*$/im,
  ];

  function isPlanContent(text: string): boolean {
    const trimmed = text.trim();
    return PLAN_PATTERNS.some(p => p.test(trimmed));
  }

  const logDir = join(process.env.HOME || "/tmp", ".opencode", "logs");
  const logFile = join(logDir, "auto-force-resume.log");

  function ensureLogDir() {
    try {
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }
    } catch {
      // ignore
    }
  }

  function log(...args: unknown[]) {
    if (!config.debug) return;
    try {
      ensureLogDir();
      const timestamp = new Date().toISOString();
      const message = `[${timestamp}] [auto-force-resume] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`;
      appendFileSync(logFile, message);
    } catch {
      // ignore file errors silently
    }
  }

  // ── Status File ────────────────────────────────────────────────────────

  const statusFile = join(logDir, "auto-force-resume.status");

  function writeStatusFile(sessionId: string) {
    try {
      ensureLogDir();
      const s = sessions.get(sessionId);
      if (!s) return;

      const now = Date.now();
      const elapsed = now - s.sessionCreatedAt;
      const actionDuration = s.actionStartedAt > 0 ? now - s.actionStartedAt : 0;
      const lastProgressAgo = now - s.lastProgressAt;
      const nextRetryIn = s.attempts >= config.maxRecoveries && s.backoffAttempts > 0
        ? Math.min(config.stallTimeoutMs * Math.pow(2, s.backoffAttempts), config.maxBackoffMs)
        : 0;

      const data = {
        version: "3.85.0",
        timestamp: new Date().toISOString(),
        sessions: {
          [sessionId]: {
            elapsed: formatDuration(elapsed),
            status: s.aborting ? "recovering" : (s.compacting ? "compacting" : (s.planning ? "planning" : "active")),
            recovery: {
              attempts: s.attempts,
              successful: s.recoverySuccessful,
              failed: s.recoveryFailed,
              lastAttempt: s.lastRecoveryTime > 0 ? new Date(s.lastRecoveryTime).toISOString() : null,
              lastSuccess: s.lastRecoverySuccess > 0 ? new Date(s.lastRecoverySuccess).toISOString() : null,
              inBackoff: s.attempts >= config.maxRecoveries,
              backoffAttempts: s.backoffAttempts,
              nextRetryIn: nextRetryIn > 0 ? formatDuration(nextRetryIn) : null,
            },
            stall: {
              detections: s.stallDetections,
              lastDetectionAt: s.lastRecoveryTime > 0 ? new Date(s.lastRecoveryTime).toISOString() : null,
            },
            compaction: {
              proactiveTriggers: 0, // tracked separately if needed
              tokenLimitTriggers: s.tokenLimitHits,
              successful: s.lastCompactionAt > 0 ? 1 : 0,
              lastCompactAt: s.lastCompactionAt > 0 ? new Date(s.lastCompactionAt).toISOString() : null,
              estimatedTokens: s.estimatedTokens,
              threshold: getCompactionThreshold(
                getModelContextLimit(join(process.env.HOME || "/tmp", ".config", "opencode", "opencode.json")),
                config
              ),
            },
            timer: {
              actionDuration: actionDuration > 0 ? formatDuration(actionDuration) : "idle",
              lastProgressAgo: formatDuration(lastProgressAgo),
            },
            nudge: {
              sent: s.lastNudgeAt > 0 ? 1 : 0,
              lastNudgeAt: s.lastNudgeAt > 0 ? new Date(s.lastNudgeAt).toISOString() : null,
            },
            todos: {
              hasOpenTodos: s.hasOpenTodos,
            },
            autoSubmits: s.autoSubmitCount,
            userCancelled: s.userCancelled,
            planning: s.planning,
            compacting: s.compacting,
            sessionCreatedAt: new Date(s.sessionCreatedAt).toISOString(),
          },
        },
      };

      const tmpFile = statusFile + ".tmp";
      writeFileSync(tmpFile, JSON.stringify(data, null, 2) + "\n");
      renameSync(tmpFile, statusFile);
    } catch {
      // Silently ignore file system errors
    }
  }

  // ── Terminal Title (OSC sequences) ────────────────────────────────────

  function updateTerminalTitle(sessionId: string) {
    const s = sessions.get(sessionId);
    if (!s || s.actionStartedAt === 0) return;

    const now = Date.now();
    const actionDuration = now - s.actionStartedAt;
    const progressAgo = now - s.lastProgressAt;
    const title = `⏱️ ${formatDuration(actionDuration)} | Last: ${formatDuration(progressAgo)} ago`;

    try {
      // OSC 0: set icon name and window title
      process.stdout.write(`\x1b]0;${title}\x07`);
      // OSC 2: set window title (fallback for some terminals)
      process.stdout.write(`\x1b]2;${title}\x07`);
    } catch {
      // ignore
    }
  }

  function clearTerminalTitle() {
    try {
      process.stdout.write('\x1b]0;opencode\x07');
      process.stdout.write('\x1b]2;opencode\x07');
    } catch {
      // ignore
    }
  }

  // ── StatusLine Hook (future-proof) ────────────────────────────────────

  function registerStatusLineHook() {
    try {
      // Check if the plugin system supports statusLine hooks
      const pluginSystem = input as any;
      if (typeof pluginSystem.hook === 'function') {
        pluginSystem.hook("tui.statusLine.variables", async (_input: any, result: any) => {
          // Provide timer variables for each active session
          sessions.forEach((s, sid) => {
            if (s.actionStartedAt > 0) {
              const now = Date.now();
              const actionDuration = now - s.actionStartedAt;
              const progressAgo = now - s.lastProgressAt;
              result.variables[`afr_timer_${sid.slice(0, 8)}`] = formatDuration(actionDuration);
              result.variables[`afr_progress_${sid.slice(0, 8)}`] = formatDuration(progressAgo);
            }
          });
          return result;
        });
        log('statusLine hook registered');
      }
    } catch {
      // Hook not available in this OpenCode version
    }
  }

  function formatMessage(template: string, vars: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] || '');
  }

  function formatDuration(ms: number): string {
    if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
    return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
  }

  async function showTimerToast(sessionId: string) {
    if (isDisposed) return;
    if (!config.timerToastEnabled) return;
    
    const s = sessions.get(sessionId);
    if (!s || s.actionStartedAt === 0) return;
    
    const now = Date.now();
    const actionDuration = now - s.actionStartedAt;
    const lastProgressDuration = now - s.lastProgressAt;
    
    const actionStr = formatDuration(actionDuration);
    const progressStr = formatDuration(lastProgressDuration);
    
    const message = `⏱️ Action: ${actionStr} | Last progress: ${progressStr} ago`;
    
    try {
      log('showing timer toast for session:', sessionId, message);
      await (input.client as any).tui.showToast({
        query: { directory: (input as any).directory || "" },
        body: {
          title: "Session Timer",
          message: message,
          variant: "info",
        },
      });
    } catch (e) {
      log('timer toast error (ignored):', e);
    }
  }

  function startTimerToast(sessionId: string) {
    const s = sessions.get(sessionId);
    if (!s) return;
    
    // Clear existing timer
    if (s.toastTimer) {
      clearInterval(s.toastTimer);
      s.toastTimer = null;
    }
    
    if (!config.timerToastEnabled) return;
    
    s.actionStartedAt = Date.now();
    
    // Show first toast immediately
    showTimerToast(sessionId);
    
    // Set up recurring timer
    s.toastTimer = setInterval(() => {
      showTimerToast(sessionId);
    }, config.timerToastIntervalMs);
    
    log('timer toast started for session:', sessionId, 'interval:', config.timerToastIntervalMs);
  }

  function stopTimerToast(sessionId: string) {
    const s = sessions.get(sessionId);
    if (!s) return;
    
    if (s.toastTimer) {
      clearInterval(s.toastTimer);
      s.toastTimer = null;
      log('timer toast stopped for session:', sessionId);
    }
    
    s.actionStartedAt = 0;
  }

  // Rough token estimation: code ≈ 0.5 tokens/char, English ≈ 0.25 tokens/char
  // This is a conservative estimate for proactive compaction
  function estimateTokens(text: string): number {
    if (!text) return 0;
    const codeRatio = 0.5;
    const englishRatio = 0.25;
    
    // Detect if text is mostly code (contains common code patterns)
    const codePatterns = /[{};\[\]()=<>+\-*/%|&!^~]/;
    const isCode = codePatterns.test(text);
    
    const ratio = isCode ? codeRatio : englishRatio;
    return Math.ceil(text.length * ratio);
  }

  async function triggerReview(sessionId: string) {
    if (isDisposed) return;
    const s = sessions.get(sessionId);
    if (!s || s.reviewFired) return;
    
    s.reviewFired = true;
    log('triggering review for session:', sessionId);
    
    try {
      // Show toast if enabled
      if (config.showToasts) {
        try {
          await (input.client as any).tui.showToast({
            query: { directory: (input as any).directory || "" },
            body: {
              title: "Session Complete",
              message: "All tasks completed. Initiating review...",
              variant: "info",
            },
          });
        } catch (e) {
          log('toast error (ignored):', e);
        }
      }
      
      // Send review prompt
      s.messageCount++;
      await (input.client.session as any).prompt({
        path: { id: sessionId },
        query: { directory: (input as any).directory || "" },
        body: {
          parts: [{
            type: "text",
            text: config.reviewMessage,
            synthetic: true,
          }],
        },
      });
      
      log('review sent successfully');
    } catch (e: any) {
      log('review failed:', e);
      if (isTokenLimitError(e)) {
        log('token limit error in review, forcing compaction');
        await forceCompact(sessionId);
      }
    }
  }

  async function sendNudge(sessionId: string) {
    if (isDisposed) return;
    const s = sessions.get(sessionId);
    if (!s) return;
    
    // Don't nudge if user recently engaged
    if (s.lastUserMessageId) return;
    
    // Don't nudge if recently nudged
    if (Date.now() - s.lastNudgeAt < config.nudgeCooldownMs) return;
    
    // Don't nudge if no open todos
    if (!s.hasOpenTodos) return;
    
    log('sending nudge for session:', sessionId);
    s.lastNudgeAt = Date.now();
    
    try {
      const messageText = formatMessage(config.nudgeMessage, {
        pending: s.hasOpenTodos ? 'some' : '0',
      });
      
      s.messageCount++;
      await (input.client.session as any).prompt({
        path: { id: sessionId },
        query: { directory: (input as any).directory || "" },
        body: {
          parts: [{
            type: "text",
            text: messageText,
            synthetic: true,
          }],
        },
      });
      
      log('nudge sent successfully');
    } catch (e: any) {
      log('nudge failed:', e);
      if (isTokenLimitError(e)) {
        log('token limit error in nudge, forcing compaction');
        await forceCompact(sessionId);
      }
    }
  }

  async function sendContinue(sessionId: string) {
    if (isDisposed) return;
    const s = sessions.get(sessionId);
    if (!s || !s.needsContinue) return;
    
    const messageText = s.continueMessageText;
    s.needsContinue = false;
    s.continueMessageText = '';
    
    log('sending continue prompt from event handler');
    
    try {
      s.messageCount++;
      await (input.client.session as any).prompt({
        path: { id: sessionId },
        query: { directory: (input as any).directory || "" },
        body: {
          parts: [{
            type: "text",
            text: messageText,
            synthetic: true,
          }],
        },
      });
      
      log('continue sent successfully');
    } catch (e: any) {
      log('continue failed:', e);
      
      // Handle token limit error
      if (isTokenLimitError(e)) {
        s.tokenLimitHits++;
        log('token limit error detected (hit #' + s.tokenLimitHits + '), forcing compaction');
        const compacted = await forceCompact(sessionId);
        if (compacted) {
          log('compaction succeeded, retrying continue with short message');
          // Retry after compaction with very short message
          await new Promise(r => setTimeout(r, 2000));
          try {
            s.messageCount++;
            await (input.client.session as any).prompt({
              path: { id: sessionId },
              query: { directory: (input as any).directory || "" },
              body: {
                parts: [{
                  type: "text",
                  text: config.shortContinueMessage,
                  synthetic: true,
                }],
              },
            });
            log('retry after compaction succeeded');
          } catch (e2) {
            log('retry after compaction failed:', e2);
          }
        } else {
          log('compaction failed, giving up on this recovery');
        }
      }
    }
  }

  function isTokenLimitError(error: any): boolean {
    if (!error) return false;
    const message = error.message || String(error);
    return config.tokenLimitPatterns.some(pattern => 
      message.toLowerCase().includes(pattern.toLowerCase())
    );
  }

  async function attemptCompact(sessionId: string): Promise<boolean> {
    try {
      log('attempting compaction for session:', sessionId);
      await (input.client.session as any).summarize({
        path: { id: sessionId },
        query: { directory: (input as any).directory || "" }
      });
      // Wait for compaction
      await new Promise(r => setTimeout(r, 2000));
      
      // Verify it worked
      const status = await input.client.session.status({});
      const data = status.data as Record<string, { type: string }>;
      const isBusy = data[sessionId]?.type === "busy";
      
      if (!isBusy) {
        log('compaction successful for session:', sessionId);
        const s = sessions.get(sessionId);
        if (s) {
          s.lastCompactionAt = Date.now();
          s.compacting = false;
        }
        return true;
      }
      
      log('compaction did not clear busy state for session:', sessionId);
      return false;
    } catch (e) {
      log('compaction attempt failed:', e);
      return false;
    }
  }

  async function forceCompact(sessionId: string): Promise<boolean> {
    const s = sessions.get(sessionId);
    if (!s) return false;
    
    s.compacting = true;
    
    // Try compaction with retries
    for (let attempt = 0; attempt < config.compactMaxRetries; attempt++) {
      if (attempt > 0) {
        log(`compaction retry ${attempt + 1}/${config.compactMaxRetries} for session:`, sessionId);
        await new Promise(r => setTimeout(r, config.compactRetryDelayMs * attempt));
      }
      
      const success = await attemptCompact(sessionId);
      if (success) {
        s.tokenLimitHits = 0;
        return true;
      }
    }
    
    log('compaction failed after all retries for session:', sessionId);
    s.compacting = false;
    return false;
  }

  async function maybeProactiveCompact(sessionId: string) {
    const s = sessions.get(sessionId);
    if (!s) return;
    if (!config.autoCompact) return;
    if (s.compacting) return;
    
    // Don't compact too frequently
    if (Date.now() - s.lastCompactionAt < 300000) return; // 5 min cooldown
    
    // Detect model context limit from opencode.json
    const opencodeConfigPath = join(process.env.HOME || "/tmp", ".config", "opencode", "opencode.json");
    const modelLimit = getModelContextLimit(opencodeConfigPath);
    const threshold = getCompactionThreshold(modelLimit, config);
    
    if (s.estimatedTokens >= threshold) {
      log('proactive compaction triggered for session:', sessionId, 'estimated tokens:', s.estimatedTokens, 'threshold:', threshold, 'model limit:', modelLimit);
      await attemptCompact(sessionId);
    }
  }

  async function recover(sessionId: string) {
    if (isDisposed) return;
    const s = sessions.get(sessionId);
    if (!s) return;

    if (s.aborting) return;
    if (s.userCancelled) return;
    if (s.planning) return;
    if (s.compacting) return;
    if (s.attempts >= config.maxRecoveries) {
      const backoffDelay = Math.min(
        config.stallTimeoutMs * Math.pow(2, s.backoffAttempts),
        config.maxBackoffMs
      );
      s.backoffAttempts++;
      log('max recoveries reached, using exponential backoff:', backoffDelay, 'ms (attempt', s.backoffAttempts, ')');
      s.timer = setTimeout(() => recover(sessionId), backoffDelay);
      return;
    }

    const now = Date.now();

    if (now - s.lastRecoveryTime < config.cooldownMs) return;

    // Check session age
    if (config.maxSessionAgeMs > 0 && now - s.sessionCreatedAt > config.maxSessionAgeMs) {
      log('session too old, giving up:', sessionId, 'age:', now - s.sessionCreatedAt, 'ms');
      s.aborting = false;
      return;
    }

    s.aborting = true;

    try {
      const statusResult = await input.client.session.status({});
      const statusData = statusResult.data as Record<string, { type: string }>;
      const sessionStatus = statusData[sessionId];

      if (!sessionStatus || sessionStatus.type !== "busy") {
        s.aborting = false;
        return;
      }

      // Recalculate now after async operations
      const currentTime = Date.now();

      if (currentTime - s.lastProgressAt < config.stallTimeoutMs) {
        s.aborting = false;
        const remaining = config.stallTimeoutMs - (currentTime - s.lastProgressAt);
        s.timer = setTimeout(() => recover(sessionId), Math.max(remaining, 100));
        return;
      }

      // Try auto-compaction before aborting
      if (config.autoCompact) {
        try {
          log('attempting auto-compaction for session:', sessionId);
          await (input.client.session as any).summarize({
            path: { id: sessionId },
            query: { directory: (input as any).directory || "" }
          });
          log('auto-compaction successful, waiting for session to resume');
          // Wait a bit for compaction to complete
          await new Promise(r => setTimeout(r, 3000));
          
          // Check if session recovered
          const postCompactStatus = await input.client.session.status({});
          const postData = postCompactStatus.data as Record<string, { type: string }>;
          if (postData[sessionId]?.type === "busy") {
            log('session still busy after compaction, proceeding with abort');
          } else {
            log('session recovered after compaction');
            s.aborting = false;
            return;
          }
        } catch (e) {
          log('auto-compaction failed:', e);
        }
      }

      try {
        await (input.client.session as any).abort({
          path: { id: sessionId },
          query: { directory: (input as any).directory || "" }
        });
      } catch (e) {
        log('abort failed:', e);
        s.aborting = false;
        s.timer = setTimeout(() => recover(sessionId), config.stallTimeoutMs * 2);
        return;
      }

      // Poll for session to become idle
      const startTime = Date.now();
      let isIdle = false;
      let statusFailures = 0;

      if (config.abortPollMaxTimeMs > 0) {
        while (!isIdle && Date.now() - startTime < config.abortPollMaxTimeMs && statusFailures < config.abortPollMaxFailures) {
          await new Promise(r => setTimeout(r, config.abortPollIntervalMs));
          try {
            const pollResult = await input.client.session.status({});
            const pollData = pollResult.data as Record<string, { type: string }>;
            const pollStatus = pollData[sessionId];
            if (pollStatus?.type === "idle") {
              isIdle = true;
            }
            statusFailures = 0;
          } catch (e) {
            statusFailures++;
            log('status poll failed:', e);
          }
        }
      }

      // Also wait the minimum time even if idle
      const remainingWait = config.waitAfterAbortMs - (Date.now() - startTime);
      if (remainingWait > 0) {
        await new Promise(r => setTimeout(r, remainingWait));
      }

      // Loop protection: check auto-submit count
      if (s.autoSubmitCount >= config.maxAutoSubmits) {
        log('loop protection: max auto-submits reached:', s.autoSubmitCount);
        s.aborting = false;
        return;
      }

      // Fetch todos if enabled
      let messageText = config.continueMessage;
      const templateVars: Record<string, string> = {
        attempts: String(s.attempts + 1),
        maxAttempts: String(config.maxRecoveries),
      };
      
      if (config.includeTodoContext) {
        try {
          const todoResult = await (input.client.session as any).todo({ path: { id: sessionId } });
          const todos = Array.isArray(todoResult.data) ? todoResult.data : [];
          const pending = todos.filter((t: any) => t.status === 'in_progress' || t.status === 'pending');
          const completed = todos.filter((t: any) => t.status === 'completed' || t.status === 'cancelled');
          
          templateVars.total = String(todos.length);
          templateVars.completed = String(completed.length);
          templateVars.pending = String(pending.length);
          
          if (pending.length > 0) {
            const todoList = pending.slice(0, 5).map((t: any) => t.content || t.title || t.id).join(', ');
            templateVars.todoList = todoList + (pending.length > 5 ? '...' : '');
            messageText = formatMessage(config.continueWithTodosMessage, templateVars);
            log('todo context added:', pending.length, 'pending tasks');
          } else {
            log('no pending todos');
          }
        } catch (e) {
          log('todo fetch failed:', e);
        }
      }

      // If still using default message, apply template vars
      if (messageText === config.continueMessage) {
        messageText = formatMessage(config.continueMessage, templateVars);
      }

      // Use short message if we've hit token limits before
      if (s.tokenLimitHits > 0) {
        log('using short continue message due to previous token limit hits:', s.tokenLimitHits);
        messageText = config.shortContinueMessage;
      }

      // Store message for later delivery (from event handler, not timer)
      s.needsContinue = true;
      s.continueMessageText = messageText;
      log('queued continue message, waiting for stable state');

      s.attempts++;
      s.autoSubmitCount++;
      s.lastRecoveryTime = Date.now();
      s.backoffAttempts = 0;
      s.messageCount++;

      // Don't set timer here - event handlers will set it when new activity starts
    } catch (e) {
      // Recovery failed, retry with longer delay
      log('recovery failed:', e);
      s.timer = setTimeout(() => recover(sessionId), config.stallTimeoutMs * 2);
    } finally {
      s.aborting = false;
    }
  }

  return {
    event: async ({ event }: { event: any }) => {
      const e = event as any;
      const sid = e?.properties?.sessionID || e?.properties?.info?.sessionID || e?.properties?.part?.sessionID || "default";

      const progressTypes = [
        "message.part.updated",
      ];

      const staleTypes = [
        "session.idle",
        "session.error",
        "session.compacted",
        "session.ended",
        "session.deleted"
      ];

      if (event?.type === "session.error") {
        const err = e?.properties?.error;
        log('session.error:', err?.name);
        if (err?.name === "MessageAbortedError") {
          const s = sessions.get(sid);
          if (s) s.userCancelled = true;
          log('user cancelled session:', sid);
        }
        clearTimer(sid);
        writeStatusFile(sid);
        return;
      }

      if (event?.type === "session.created") {
        log('session.created:', sid);
        getSession(sid);
        writeStatusFile(sid);
        return;
      }

      if (event?.type === "message.updated") {
        const info = e?.properties?.info;
        if (info?.role === "user" && info?.id) {
          const s = getSession(sid);
          if (s.lastUserMessageId !== info.id) {
            s.lastUserMessageId = info.id;
            s.autoSubmitCount = 0;
            s.attempts = 0;
            s.backoffAttempts = 0;
            // Reset nudge timer on user activity
            if (s.nudgeTimer) {
              clearTimeout(s.nudgeTimer);
              s.nudgeTimer = null;
            }
            log('user message detected, resetting counters:', sid);
          }
        }
        writeStatusFile(sid);
        return;
      }

      if (event?.type === "session.status") {
        const status = e?.properties?.status;
        log('session.status:', sid, status?.type);
        const s = getSession(sid);
        if (status?.type === "busy" || status?.type === "retry") {
          updateProgress(s);
          s.userCancelled = false;
          if (s.planning) {
            log('session busy, clearing plan flag');
            s.planning = false;
          }
          if (s.compacting) {
            log('session busy, clearing compacting flag (compaction likely finished)');
            s.compacting = false;
          }
          // Start timer toast if not already running
          if (s.actionStartedAt === 0) {
            startTimerToast(sid);
          }
          // Update terminal title
          updateTerminalTitle(sid);
        }
        // Send queued continue when session becomes idle/stable
        if (status?.type === "idle" && s.needsContinue) {
          log('session idle, sending queued continue for:', sid);
          await sendContinue(sid);
        }
        // Proactive compaction when idle and message count is high
        if (status?.type === "idle" && !s.needsContinue) {
          await maybeProactiveCompact(sid);
        }
        // Stop timer toast and clear terminal title when session becomes idle
        if (status?.type === "idle") {
          stopTimerToast(sid);
          clearTerminalTitle();
        }
        clearTimer(sid);
        if (status?.type === "busy" || status?.type === "retry") {
          s.timer = setTimeout(() => {
            recover(sid);
          }, config.stallTimeoutMs);
        }
        writeStatusFile(sid);
        return;
      }

      if (progressTypes.includes(event?.type)) {
        log('progress event:', event?.type, sid);
        const s = getSession(sid);

        if (event?.type === "message.part.updated") {
          const part = e?.properties?.part;
          const partType = part?.type;
          
          // CRITICAL: Ignore synthetic messages to prevent infinite loops
          if (part?.synthetic === true) {
            log('ignoring synthetic message part');
            return;
          }
          
          const isRealProgress = partType === "text" || partType === "step-finish" || partType === "reasoning" || partType === "tool" || partType === "step-start" || partType === "subtask" || partType === "file";
          log('message.part.updated:', partType, isRealProgress ? '(progress)' : '(ignored)');
          if (isRealProgress) {
            updateProgress(s);
            s.attempts = 0;
            s.userCancelled = false;
          }
          if (partType === "compaction") {
            log('compaction started, pausing stall monitoring');
            s.compacting = true;
          }
          if (partType === "text") {
            const partText = e?.properties?.part?.text as string | undefined;
            if (partText) {
              // Estimate tokens from text content
              const estimatedTokens = estimateTokens(partText);
              s.estimatedTokens += estimatedTokens;
              
              if (isPlanContent(partText)) {
                log('plan detected in updated text part, pausing stall monitoring');
                s.planning = true;
              }
            }
          }
        }

        // Check if this is a delta update containing plan content
        const deltaText = e?.properties?.delta as string | undefined;
        if (deltaText) {
          s.planBuffer = (s.planBuffer + deltaText).slice(-200);
          if (isPlanContent(s.planBuffer)) {
            log('plan detected in delta, pausing stall monitoring — user must address');
            s.planning = true;
            s.planBuffer = '';
          }
        }

        clearTimer(sid);
        if (!s.planning && !s.compacting) {
          s.timer = setTimeout(() => {
            recover(sid);
          }, config.stallTimeoutMs);
        }
        return;
      }

      if (event?.type === "message.created" || event?.type === "message.part.added") {
        // Check if this is a real user message (not our synthetic prompt)
        const msgRole = e?.properties?.info?.role;
        const isUserMessage = msgRole === "user";
        
        if (isUserMessage) {
          // User sent a message - cancel any queued continue and process normally
          const s = sessions.get(sid);
          if (s && s.needsContinue) {
            log('user message during recovery, cancelling queued continue');
            s.needsContinue = false;
            s.continueMessageText = '';
          }
        } else {
          // Non-user message (likely our synthetic prompt) - check if we're recovering
          const s = sessions.get(sid);
          if (s && s.needsContinue) {
            log('ignoring synthetic message event during recovery:', event?.type);
            return;
          }
        }
        
        log('activity event:', event?.type, sid, 'role:', msgRole);
        const s = getSession(sid);
        
        // Track message count and estimate tokens for proactive compaction
        if (isUserMessage) {
          s.messageCount++;
          // Estimate tokens from message text
          const msgText = e?.properties?.info?.content || e?.properties?.info?.text || '';
          const estimatedTokens = estimateTokens(msgText);
          s.estimatedTokens += estimatedTokens;
          log('message count incremented:', s.messageCount, 'estimated tokens added:', estimatedTokens, 'total:', s.estimatedTokens);
        } else {
          // Also estimate tokens from assistant/tool responses
          const msgText = e?.properties?.info?.content || e?.properties?.info?.text || '';
          if (msgText) {
            const estimatedTokens = estimateTokens(msgText);
            s.estimatedTokens += estimatedTokens;
          }
        }
        
        updateProgress(s);
        s.attempts = 0;
        s.userCancelled = false;
        if (s.planning) {
          log('user sent message, clearing plan flag');
          s.planning = false;
        }
        if (s.compacting) {
          log('user sent message, clearing compacting flag');
          s.compacting = false;
        }
        clearTimer(sid);
        if (!s.planning && !s.compacting) {
          s.timer = setTimeout(() => {
            recover(sid);
          }, config.stallTimeoutMs);
        }
        return;
      }

      if (event?.type === "todo.updated") {
        const todos = e?.properties?.todos;
        if (!Array.isArray(todos)) return;
        
        const s = getSession(sid);
        const allCompleted = todos.length > 0 && todos.every((t: any) => t.status === 'completed' || t.status === 'cancelled');
        const hasPending = todos.some((t: any) => t.status === 'in_progress' || t.status === 'pending');
        
        // Track open todos for nudging
        s.hasOpenTodos = hasPending;
        
        // Handle review on completion
        if (allCompleted && !s.reviewFired && config.reviewOnComplete) {
          if (s.reviewDebounceTimer) {
            clearTimeout(s.reviewDebounceTimer);
          }
          s.reviewDebounceTimer = setTimeout(() => {
            s.reviewDebounceTimer = null;
            triggerReview(sid);
          }, config.reviewDebounceMs);
        } else if (!allCompleted && s.reviewDebounceTimer) {
          clearTimeout(s.reviewDebounceTimer);
          s.reviewDebounceTimer = null;
        }
        
        // Handle nudge timer
        if (hasPending && config.nudgeEnabled) {
          // Start or reset nudge timer
          if (s.nudgeTimer) {
            clearTimeout(s.nudgeTimer);
          }
          s.nudgeTimer = setTimeout(() => {
            s.nudgeTimer = null;
            sendNudge(sid);
          }, config.nudgeTimeoutMs);
        } else if (!hasPending && s.nudgeTimer) {
          // Cancel nudge if no pending todos
          clearTimeout(s.nudgeTimer);
          s.nudgeTimer = null;
        }
        return;
      }

      if (staleTypes.includes(event?.type)) {
        log('stale event:', event?.type, sid);
        resetSession(sid);
        return;
      }
    },
    dispose: () => {
      log('disposing plugin');
      isDisposed = true;
      sessions.forEach((s) => {
        if (s.timer) {
          clearTimeout(s.timer);
          s.timer = null;
        }
        if (s.reviewDebounceTimer) {
          clearTimeout(s.reviewDebounceTimer);
          s.reviewDebounceTimer = null;
        }
        if (s.nudgeTimer) {
          clearTimeout(s.nudgeTimer);
          s.nudgeTimer = null;
        }
        if (s.toastTimer) {
          clearInterval(s.toastTimer);
          s.toastTimer = null;
        }
      });
      sessions.clear();
    }
  };
};

