import type { PluginInput } from "@opencode-ai/plugin";
import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";

// Re-exports for backward compatibility
export type { Todo, SessionState } from "./session-state.js";
export type { PluginConfig } from "./config.js";
export { DEFAULT_CONFIG, validateConfig } from "./config.js";
export { createSession, updateProgress } from "./session-state.js";

export type TypedPluginInput = PluginInput;

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
          const p = provider as Record<string, unknown>;
          if (p.models) {
            for (const model of Object.values(p.models)) {
              const m = model as Record<string, unknown>;
              if (m.limit && typeof m.limit === 'object' && m.limit !== null) {
                const limit = m.limit as Record<string, unknown>;
                if (typeof limit.context === 'number') {
                  limits.push(limit.context);
                }
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

export function getCompactionThreshold(modelContextLimit: number | null, config: { proactiveCompactAtTokens: number }): number {
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
export function parseTokensFromError(error: { message?: string } | null): { total: number; input: number; output: number } | null {
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
      const msg = messages[i] as Record<string, unknown>;
      const role = msg.role || (msg.info as Record<string, unknown>)?.role;
      if (role !== "assistant") continue;
      
      const msgTime = (msg.createdAt as number) || ((msg.info as Record<string, unknown>)?.createdAt as number) || 0;
      if (now - msgTime > 30000) continue; // Only check last 30s
      
      const parts = msg.parts as Array<Record<string, unknown>> | undefined;
      const text = (msg.text as string) || (parts?.map(p => p.text as string).join(" ")) || "";
      // Check if the recent message contains similar content
      if (text && promptText && (
        text.includes(promptText.substring(0, 50)) ||
        promptText.includes(text.substring(0, 50))
      )) {
        log?.("prompt guard blocked duplicate injection", { sessionId, text: text.substring(0, 100) });
        return true;
      }
    }
  } catch {
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
