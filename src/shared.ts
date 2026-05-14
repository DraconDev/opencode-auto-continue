import type { PluginInput } from "@opencode-ai/plugin";
import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";

export type TypedPluginInput = PluginInput;

// Import canonical types/values for local use, then re-export for downstream.
// Canonical definitions live in config.ts and session-state.ts.
import type { PluginConfig } from "./config.js";
import { DEFAULT_CONFIG, validateConfig } from "./config.js";
import type { SessionState } from "./session-state.js";
import { createSession } from "./session-state.js";

// Re-exports for backward compatibility — import directly from ./config.js or ./session-state.js
export type { PluginConfig, SessionState };
export { DEFAULT_CONFIG, validateConfig, createSession };

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

export function getModelContextLimit(opencodeConfigPath: string): number | null {
  return modelContextCache.get(opencodeConfigPath);
}

export function invalidateModelLimitCache(): void {
  modelContextCache.invalidate();
}

export function getCompactionThreshold(config: PluginConfig): number {
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
  /^let\s+me\s+plan/i,
  /^here'?s?\s+(what i|what we|how i|how we)/i,
  /^my\s+plan\s+is/i,
  /^step\s+\d+[\:\.]/i,
  /^##\s+steps?/i,
  /^##\s+tasks?/i,
  /^##\s+approach/i,
];

export function isPlanContent(text: string): boolean {
  return PLAN_PATTERNS.some(pattern => pattern.test(text.trim()));
}

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
  
  // Pattern 3: "... 264230 tokens ..." (extract the LAST number near "tokens" to avoid matching limits)
  const looseMatches = [...message.matchAll(/(\d{4,})\s+tokens?/ig)];
  if (looseMatches.length > 0) {
    const last = looseMatches[looseMatches.length - 1];
    const total = parseInt(last[1], 10);
    return { total, input: total, output: 0 };
  }
  
  return null;
}

export function updateProgress(s: SessionState) {
  s.lastProgressAt = Date.now();
}

export function formatMessage(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
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

  return (
    leftNeedle.length >= 20 &&
    rightNeedle.length >= 20 &&
    (left.includes(rightNeedle) || right.includes(leftNeedle))
  );
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

export async function shouldBlockPrompt(
  sessionId: string,
  promptText: string,
  input: TypedPluginInput,
  log?: (...args: unknown[]) => void
): Promise<boolean> {
  try {
    const messages = await fetchRecentMessages(sessionId, input);
    const now = Date.now();
    
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as any;
      const role = msg.role || msg.info?.role;
      if (role !== "assistant" && role !== "user") continue;
      
      const msgTime = getMessageTimestamp(msg);
      if (msgTime === null) continue;
      if (now - msgTime > 30000) continue;
      
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

/**
 * Detect if Dynamic Context Pruning (DCP) plugin is installed.
 * DCP handles context optimization better than our naive compaction,
 * so we should disable our proactive compaction when it's present.
 */
let dcpDetectedCached: boolean | null = null;

export function detectDCP(bypassCache: boolean = false): boolean {
  if (!bypassCache && dcpDetectedCached !== null) return dcpDetectedCached;
  try {
    const home = process.env.HOME || "/tmp";
    
    const globalConfigPath = join(home, ".config", "opencode", "opencode.json");
    if (existsSync(globalConfigPath)) {
      const content = readFileSync(globalConfigPath, "utf-8");
      const cfg = JSON.parse(content);
      if (cfg.plugin && Array.isArray(cfg.plugin)) {
        for (const p of cfg.plugin) {
          const pluginName = Array.isArray(p) ? p[0] : p;
          if (typeof pluginName === "string" && 
              (pluginName.includes("dcp") || pluginName.includes("dynamic-context-pruning"))) {
            dcpDetectedCached = true;
            return true;
          }
        }
      }
    }
    
    const dcpPaths = [
      join(home, ".config", "opencode", "plugins", "opencode-dynamic-context-pruning"),
      join(home, ".cache", "opencode", "node_modules", "@tarquinen", "opencode-dcp"),
      join(home, ".cache", "opencode", "node_modules", "opencode-dynamic-context-pruning"),
    ];
    
    for (const p of dcpPaths) {
      if (existsSync(p)) {
        dcpDetectedCached = true;
        return true;
      }
    }
    
    dcpDetectedCached = false;
    return false;
  } catch {
    dcpDetectedCached = false;
    return false;
  }
}

export function invalidateDCPCache(): void {
  dcpDetectedCached = null;
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
