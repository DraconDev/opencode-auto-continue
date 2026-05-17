/**
 * Barrel re-export for all shared utilities.
 *
 * This file re-exports from focused utility modules plus the typed-helpers
 * module. Import from here for convenience, or import directly from the
 * specific module for better tree-shaking.
 *
 * Modules:
 * - utils.ts           — formatDuration, estimateTokens, parseTokensFromError, formatMessage, updateProgress
 * - plan-detection.ts — isPlanContent, PLAN_PATTERNS, TOOL_TEXT_PATTERNS, containsToolCallAsText
 * - prompt-guard.ts    — shouldBlockPrompt, clearMessagesCache
 * - typed-helpers.ts  — safeUnref, getErrorName, getResponseError, isMessageAbortedError,
 *                       getMessageRole, getMessageParts, hasDollarMethod, getHttpClient,
 *                       createPromptGuardLogger
 */

// ─── Type re-exports ─────────────────────────────────────────────────────────

import type { TypedPluginInput } from "./types.js";
export type { TypedPluginInput };
import type { PluginConfig, ConfigValidationResult } from "./config.js";
export type { PluginConfig, ConfigValidationResult };
import type { SessionState } from "./session-state.js";
export type { SessionState };

// ─── Config re-exports ───────────────────────────────────────────────────────

import { DEFAULT_CONFIG, validateConfig, validateConfigDetailed } from "./config.js";
export { DEFAULT_CONFIG, validateConfig, validateConfigDetailed };
import { createSession } from "./session-state.js";
export { createSession };

// ─── Utils ──────────────────────────────────────────────────────────────────

export {
  estimateTokens,
  parseTokensFromError,
  formatDuration,
  formatMessage,
  updateProgress,
  getMessageText,
} from "./utils.js";

// ─── Plan detection ──────────────────────────────────────────────────────────

export {
  PLAN_PATTERNS,
  TOOL_TEXT_PATTERNS,
  TRUNCATED_XML_PATTERNS,
  isPlanContent,
  containsToolCallAsText,
  isSessionPlanning,
  estimateIsPlan,
} from "./plan-detection.js";

// ─── Presets re-export ─────────────────────────────────────────────────────────

export { getPreset, PRESETS, DEFAULT_PRESET } from "./presets.js";

// ─── Prompt guard ────────────────────────────────────────────────────────────

export { shouldBlockPrompt, clearMessagesCache } from "./prompt-guard.js";

// ─── Typed helpers ───────────────────────────────────────────────────────────

export {
  safeUnref,
  getErrorName,
  getResponseError,
  isMessageAbortedError,
  getMessageRole,
  getMessageParts,
  hasDollarMethod,
  getHttpClient,
  createPromptGuardLogger,
} from "./typed-helpers.js";

// ─── todoMdInstruction (stays in shared.ts — used by nudge, review, index) ───

/**
 * Build the instruction snippet for reading todos from todo.md.
 * Returns empty string when todoMdPath is not configured.
 *
 * @param todoMdPath - Path to the todo.md file (from config)
 * @returns Instruction snippet or empty string
 */
export function todoMdInstruction(todoMdPath: string): string {
  if (!todoMdPath) return "";
  return ` Also maintain \`${todoMdPath}\` in the project root — update it when tasks are created, completed, or discovered. This file persists across sessions.`;
}

// ─── getCompactionThreshold (stays in shared.ts — used by status-file) ───────

/**
 * Get the compaction threshold from the plugin config.
 * @param config - The plugin configuration
 * @returns The proactive compaction token threshold
 */
export function getCompactionThreshold(config: PluginConfig): number {
  return config.proactiveCompactAtTokens;
}

// ─── Model context limit cache (file I/O — lives in shared.ts) ─────────────────

import { existsSync, readFileSync, statSync } from "fs";

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

      if (
        this.cache.path === opencodeConfigPath &&
        this.cache.mtime === mtime &&
        this.cache.limit !== null
      ) {
        return this.cache.limit;
      }

      const content = readFileSync(opencodeConfigPath, "utf-8");
      const config = JSON.parse(content) as Record<string, unknown>;

      const limits: number[] = [];
      if (config.provider) {
        for (const provider of Object.values(config.provider as Record<string, unknown>)) {
          const p = provider as Record<string, unknown>;
          if (p.models) {
            for (const model of Object.values(p.models as Record<string, unknown>)) {
              const m = model as Record<string, unknown>;
              const limit = m.limit as Record<string, unknown> | undefined;
              if (limit && typeof limit.context === "number") {
                limits.push(limit.context);
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

// ─── safeHook (lives here to avoid circular deps) ─────────────────────────

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

// ─── scheduleRecoveryWithGeneration ─────────────────────────────────────────

/**
 * Schedule a recovery timer with a generation counter to prevent stale timer races.
 * If the session's generation counter has advanced since the timer was scheduled,
 * the timer callback is a no-op.
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

  if (s.timer) {
    clearTimeout(s.timer);
  }

  s.timerGeneration++;
  const currentGeneration = s.timerGeneration;

  const timer = setTimeout(() => {
    const current = sessions.get(sessionId);
    if (current && current.timer === timer && current.timerGeneration === currentGeneration) {
      current.timer = null;
      recover(sessionId);
    } else {
      log?.("stale recovery timer ignored, generation mismatch:", sessionId);
    }
  }, delayMs);

  import("./typed-helpers.js").then(({ safeUnref }) => {
    safeUnref(timer);
  }).catch(() => {});

  s.timer = timer;
}