import type { PluginInput } from "@opencode-ai/plugin";
import { existsSync, readFileSync, statSync } from "fs";

import type { TypedPluginInput } from "./types.js";
export type { TypedPluginInput };
import type { PluginConfig, ConfigValidationResult } from "./config.js";
import { DEFAULT_CONFIG, validateConfig, validateConfigDetailed } from "./config.js";
import type { SessionState } from "./session-state.js";
import { createSession } from "./session-state.js";

// Re-exports for backward compatibility — import directly from ./config.js or ./session-state.js
export type { PluginConfig, SessionState, ConfigValidationResult };
export { DEFAULT_CONFIG, validateConfig, validateConfigDetailed, createSession };

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

/**
 * Get the model context limit from the cache.
 * Results are cached and auto-invalidated when the file changes.
 *
 * @param opencodeConfigPath - Path to the OpenCode config file
 * @returns The context limit in tokens, or null if unavailable
 */
export function getModelContextLimit(opencodeConfigPath: string): number | null {
  return modelContextCache.get(opencodeConfigPath);
}

/** Invalidate the cached model context limit, forcing a re-read on next access. */
export function invalidateModelLimitCache(): void {
  modelContextCache.invalidate();
}

/**
 * Get the compaction threshold from the plugin config.
 * @param config - The plugin configuration
 * @returns The proactive compaction token threshold
 */
export function getCompactionThreshold(config: PluginConfig): number {
  return config.proactiveCompactAtTokens;
}

/**
 * Patterns that indicate the AI is outputting a plan rather than acting.
 * Used by the nudge module to detect when the AI is planning
 * (and should not be interrupted).
 */
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
  /^let\s+me\s+plan/i,
  /^here'?s?\s+(what i|what we|how i|how we)/i,
  /^my\s+plan\s+is/i,
  /^step\s+\d+[\:\.]/i,
  /^##\s+steps?/i,
  /^##\s+tasks?/i,
  /^##\s+approach/i,
];

/**
 * Check if text content indicates the AI is creating a plan.
 * Plans are detected via common patterns like "Here is my plan", "## Plan", etc.
 *
 * @param text - The text content to check
 * @returns true if the text matches a plan-content pattern
 */
export function isPlanContent(text: string): boolean {
  return PLAN_PATTERNS.some(pattern => pattern.test(text.trim()));
}

/**
 * Check whether text contains tool calls written as plain text
 * (e.g., XML-formatted tool calls in reasoning output).
 * Used by text-only stall detection.
 */
export const TOOL_TEXT_PATTERNS = [
  /<function\s*=/i,
  /<function>/i,
  /<\/function>/i,
  /<parameter\s*=/i,
  /<parameter>/i,
  /<\/parameter>/i,
  /<tool_call[\s>]/i,
  /<\/tool_call>/i,
  /<tool[\s_]name\s*=/i,
  /<invoke\s+/i,
  /<invoke>/i,
  /<\/invoke>/i,
  /<(?:edit|write|read|bash|grep|glob|search|replace|execute|run|cat|ls|npm|pip|docker)\s*(?:\s[^>]*)?\s*(?:\/>|>)/i,
  /<system[\s_-]reminder/i,
];

/**
 * Patterns that indicate truncated XML output, which suggests
 * the AI was cut off mid-tool-call and needs recovery.
 */
export const TRUNCATED_XML_PATTERNS = [
  { open: /<function[^>]*>/i, close: /<\/function>/i },
  { open: /<parameter[^>]*>/i, close: /<\/parameter>/i },
  { open: /<tool_call[^>]*>/i, close: /<\/tool_call>/i },
  { open: /<invoke[^>]*>/i, close: /<\/invoke>/i },
];

/**
 * Check if text content contains a tool call written as raw text/XML rather than
 * being executed as an actual tool. This detects hallucinated tool calls where the
 * AI outputs tool syntax in a text or reasoning part instead of using the tool system.
 *
 * @param text - The text content to check
 * @returns true if tool-call-as-text patterns are found
 */
export function containsToolCallAsText(text: string): boolean {
  if (text.length <= 10) return false;
  if (TOOL_TEXT_PATTERNS.some((pat) => pat.test(text))) return true;
  for (const { open, close } of TRUNCATED_XML_PATTERNS) {
    if (open.test(text) && !close.test(text)) return true;
  }
  return false;
}

/**
 * Estimate the token count for a string based on character composition.
 * Uses weighted ratios: English ~0.35 tokens/char, code ~0.50, digits ~0.25.
 *
 * @param text - The text to estimate tokens for
 * @param multiplier - Optional scaling factor (default: 1.0)
 * @returns Estimated token count (minimum 1)
 */
export function estimateTokens(text: string, multiplier: number = 1.0): number {
  const codeChars = new Set("{}[]();+-*/=<>!&||^~%@#$'\"`");
  const digitChars = new Set("0123456789");

  let code = 0, digits = 0;
  for (const ch of text) {
    if (digitChars.has(ch)) digits++;
    else if (codeChars.has(ch)) code++;
  }
  const english = text.length - code - digits;
  // Weighted char-to-token ratios: English ~0.35, code ~0.50, digits ~0.25
  return Math.max(1, Math.ceil((english * 0.35 + code * 0.50 + digits * 0.25) * multiplier));
}

/**
 * Format a duration in milliseconds into a human-readable string.
 * Examples: "5s", "2m 30s", "1h 15m"
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted duration string
 */
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
 * Tries three patterns in order: detailed, simple, and loose.
 *
 * @param error - The error object or message string
 * @returns Parsed token counts or null if no pattern matched
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
  
  // Pattern 3: "... 264230 tokens ..." (extract the LAST number near "tokens" to avoid matching limits)
  const looseMatches = [...message.matchAll(/(\d{4,})\s+tokens?/ig)];
  if (looseMatches.length > 0) {
    const last = looseMatches[looseMatches.length - 1];
    const total = parseInt(last[1], 10);
    return { total, input: total, output: 0 };
  }
  
  return null;
}

/**
 * Update the progress timestamp on a session state.
 * Called whenever real activity is detected to reset stall detection timers.
 *
 * @param s - The session state to update
 */
export function updateProgress(s: SessionState) {
  s.lastProgressAt = Date.now();
}

/**
 * Format a template string by replacing `{variable}` placeholders with values.
 * Unresolved variables are left as-is and a warning is logged.
 *
 * @param template - The template string with `{key}` placeholders
 * @param vars - Key-value pairs to substitute into the template
 * @returns The formatted string with placeholders replaced
 */
export function formatMessage(template: string, vars: Record<string, string>): string {
  const unresolved: string[] = [];
  const result = template.replace(/\{(\w+)\}/g, (_, key) => {
    if (key in vars) return vars[key];
    unresolved.push(key);
    return `{${key}}`;
  });
  if (unresolved.length > 0) {
    console.warn(`[opencode-auto-continue] formatMessage: unresolved template variables: ${unresolved.join(', ')}`);
  }
  return result;
}

export function todoMdInstruction(todoMdPath: string, todoMdSync?: boolean): string {
  if (!todoMdPath) return "";
  const syncNote = todoMdSync ? " Remaining tasks in this file will be picked up automatically." : "";
  return ` Also maintain \`${todoMdPath}\` in the project root — update it when tasks are created, completed, or discovered. This file persists across sessions.${syncNote}`;
}

function getMessageTimestamp(message: any): number | null {
  const raw =
    message?.createdAt ??
    message?.time ??
    message?.timestamp ??
    message?.info?.createdAt ??
    message?.info?.time ??
    message?.info?.timestamp ??
    null;

  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (raw instanceof Date) return raw.getTime();
  return null;
}

/**
 * Extract the text content from a message object.
 * Tries direct `content`/`text` fields first, then falls back to
 * concatenating text from the message's `parts` array.
 *
 * @param message - The message object (may have various shapes depending on event type)
 * @returns The extracted text content, or an empty string
 */
export function getMessageText(message: any): string {
  const direct = message?.content ?? message?.text ?? message?.info?.content ?? message?.info?.text;
  if (typeof direct === "string" && direct.length > 0) return direct;

  const parts = [
    ...(Array.isArray(message?.parts) ? message.parts : []),
    ...(Array.isArray(message?.info?.parts) ? message.info.parts : []),
  ];

  return parts
    .map((part: any) => {
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.content === "string") return part.content;
      if (typeof part?.reasoning === "string") return part.reasoning;
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function normalizeForSimilarity(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function hasSimilarPrompt(a: string, b: string): boolean {
  const left = normalizeForSimilarity(a);
  const right = normalizeForSimilarity(b);
  if (!left || !right) return false;

  if (left === right) return true;

  const leftNeedle = left.slice(0, Math.min(80, left.length));
  const rightNeedle = right.slice(0, Math.min(80, right.length));

  if (leftNeedle.length < 20 || rightNeedle.length < 20) return false;

  if (!left.includes(rightNeedle) && !right.includes(leftNeedle)) return false;

  const lengthRatio = Math.min(left.length, right.length) / Math.max(left.length, right.length);
  if (lengthRatio < 0.5) return false;

  return true;
}

/**
 * Prompt guard — prevents duplicate injections within a time window.
 * Checks if a similar prompt was recently sent to the same session.
 * Results are cached per (input, sessionId) with a TTL to avoid redundant API calls.
 */
const messagesCache = new WeakMap<any, { data: any[]; ts: number; sid: string }>();
const MESSAGES_CACHE_TTL = 300;

async function fetchRecentMessages(sessionId: string, input: TypedPluginInput): Promise<any[]> {
  const key = input.client?.session;
  if (key) {
    const cached = messagesCache.get(key);
    if (cached && cached.sid === sessionId && Date.now() - cached.ts < MESSAGES_CACHE_TTL) {
      return cached.data;
    }
  }
  
  const resp = await input.client.session.messages({
    path: { id: sessionId },
    query: { limit: 15 },
  });
  const data = Array.isArray(resp.data) ? resp.data : [];
  if (key) messagesCache.set(key, { data, ts: Date.now(), sid: sessionId });
  return data;
}

export function clearMessagesCache(): void {
  /* WeakMap clears itself — no manual cleanup needed */
}

/**
 * Prompt guard — prevents duplicate injections within a time window.
 * Checks if a similar prompt was recently sent to the same session
 * by fetching recent messages and comparing text similarity.
 * Results are cached per (input, sessionId) with a TTL to avoid redundant API calls.
 *
 * @param sessionId - The session to check
 * @param promptText - The proposed prompt text
 * @param input - The plugin input for API access
 * @param log - Optional log function for debug output
 * @param windowMs - Time window in ms to check for duplicates (default: 30000)
 * @param minWindowMs - Minimum time window for hard-match checks (default: 0)
 * @returns true if the prompt should be blocked as a duplicate
 */
export async function shouldBlockPrompt(
  sessionId: string,
  promptText: string,
  input: TypedPluginInput,
  log?: (...args: unknown[]) => void,
  windowMs: number = 30000,
  minWindowMs: number = 0
): Promise<boolean> {
  try {
    const messages = await fetchRecentMessages(sessionId, input);
    const now = Date.now();
    const effectiveWindow = Math.max(windowMs, minWindowMs);
    
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as any;
      const role = msg.role || msg.info?.role;
      if (role !== "assistant" && role !== "user") continue;
      
      const msgTime = getMessageTimestamp(msg);
      if (msgTime === null) continue;
      if (now - msgTime > effectiveWindow) continue;
      
      const text = getMessageText(msg);
      if (hasSimilarPrompt(text, promptText)) {
        log?.("prompt guard blocked duplicate injection", { sessionId, text: text.substring(0, 100) });
        return true;
      }
    }
  } catch (e) {
    log?.("prompt guard check failed, allowing prompt:", String(e));
  }
  return false;
}
/**
 * Execute an async hook safely, catching and logging any errors.
 * Used to wrap event handlers and hooks so that failures don't crash the plugin.
 *
 * @param name - Identifier for the hook (used in error logging)
 * @param fn - The async function to execute
 * @param log - Optional log function for error output
 */
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
 * Unified scheduleRecovery with generation counter.
 * Prevents stale timers from firing after being overwritten.
 * 
 * Usage: Call this from any module that needs to schedule recovery.
 * The generation counter ensures only the most recent timer fires.
 */
/**
 * Schedule a recovery timer with a generation counter to prevent stale timer races.
 * If the session's generation counter has advanced since the timer was scheduled,
 * the timer callback is a no-op. This prevents recovery from firing after
 * a session reset or manual recovery has already occurred.
 *
 * @param sessions - The session map
 * @param sessionId - The session to schedule recovery for
 * @param delayMs - Delay in milliseconds before recovery fires
 * @param recoverFn - The recovery function to call
 * @param log - Optional log function
 */
export function scheduleRecoveryWithGeneration(
  sessions: Map<string, SessionState>,
  sessionId: string,
  delayMs: number,
  recover: (sessionId: string) => void,
  log?: (...args: unknown[]) => void
): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  
  // Clear old timer to prevent memory leak
  if (s.timer) {
    clearTimeout(s.timer);
  }
  
  // Increment generation to invalidate previous timers
  s.timerGeneration++;
  const currentGeneration = s.timerGeneration;
  
  const timer = setTimeout(() => {
    const current = sessions.get(sessionId);
    // Only proceed if this timer is still the current one (not overwritten)
    if (current && current.timer === timer && current.timerGeneration === currentGeneration) {
      current.timer = null;
      recover(sessionId);
    } else {
      log?.('stale recovery timer ignored, generation mismatch:', sessionId);
    }
  }, delayMs);
  
  (timer as any).unref?.();
  s.timer = timer;
}

