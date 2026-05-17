/**
 * Prompt guard — prevents duplicate nudge/continue injections within a time window.
 * Checks if a similar prompt was recently sent to the same session
 * by fetching recent messages and comparing text similarity.
 */

import type { TypedPluginInput } from "./types.js";
import { getMessageRole } from "./typed-helpers.js";

// ─── Cache for recent messages ────────────────────────────────────────────────

interface CacheEntry {
  data: unknown[];
  ts: number;
  sid: string;
}

// Plain Map keyed by input.client — clearable for testing
const _messagesCache = new Map<object, CacheEntry>();
const MESSAGES_CACHE_TTL = 5000; // 5 seconds

/**
 * Clear all cached messages — useful for testing.
 */
export function clearMessagesCache(): void {
  _messagesCache.clear();
}

// ─── Timestamp extraction ──────────────────────────────────────────────────────

function getMessageTimestamp(msg: Record<string, unknown>): number | null {
  const info = msg.info as Record<string, unknown> | undefined;
  const ts = msg.createdAt ?? msg.time ?? msg.timestamp ?? info?.createdAt ?? info?.time ?? info?.timestamp ?? null;
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") {
    const ms = Date.parse(ts);
    if (!isNaN(ms)) return ms;
  }
  if (ts instanceof Date) return ts.getTime();
  return null;
}

// ─── Text similarity ───────────────────────────────────────────────────────────

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

// ─── Message fetching ─────────────────────────────────────────────────────────

async function fetchRecentMessages(
  sessionId: string,
  input: TypedPluginInput
): Promise<unknown[]> {
  // Key by the session API object (same pattern as original)
  const cacheKey = (input.client as object) ?? {};
  const cached = _messagesCache.get(cacheKey);
  if (cached && cached.sid === sessionId && Date.now() - cached.ts < MESSAGES_CACHE_TTL) {
    return cached.data;
  }

  const resp = await input.client.session.messages({
    path: { id: sessionId },
    query: { limit: 15 },
  });
  const data = Array.isArray(resp.data) ? resp.data : [];

  _messagesCache.set(cacheKey, { data, ts: Date.now(), sid: sessionId });
  return data;
}

/**
 * Check if a prompt should be blocked as a duplicate injection.
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
      const msg = messages[i] as Record<string, unknown>;
      const role = getMessageRole(msg);
      if (role !== "assistant" && role !== "user") continue;

      const msgTime = getMessageTimestamp(msg);
      if (msgTime === null) continue;
      if (now - msgTime > effectiveWindow) continue;

      const { getMessageText } = await import("./utils.js");
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