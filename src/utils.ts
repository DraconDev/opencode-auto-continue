/**
 * Utility functions: formatting, token estimation, and message formatting.
 * These are pure utility functions with no dependencies on plugin state.
 */

import type { TypedPluginInput } from "./types.js";
import type { SessionState } from "./session-state.js";

// ─── Token estimation ─────────────────────────────────────────────────────────

/**
 * Rough token estimate: ~4 characters per token for English text.
 * This is used as a fallback when real token counts are unavailable.
 *
 * @param text - The text to estimate tokens for
 * @param multiplier - A multiplier to adjust the estimate (default: 1.0)
 * @returns Estimated token count
 */
export function estimateTokens(text: string, multiplier: number = 1.0): number {
  return Math.ceil(text.length / 4 * multiplier);
}

/**
 * Parse token counts from an error message.
 * OpenCode sometimes includes token info in error messages.
 * Handles three patterns:
 *   1. "total of N tokens: X input ... and Y completion"
 *   2. "You requested N tokens"
 *   3. Any standalone "NNNN tokens" (uses last match)
 *
 * @param error - The error object
 * @returns Token breakdown or null if not found
 */
export function parseTokensFromError(
  error: unknown
): { total: number; input: number; output: number } | null {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);


  // Pattern 1: "total of 264230 tokens: 232230 tokens from the input messages and 32000 tokens for the completion."
  const detailedMatch = message.match(
    /total of (\d+)\s+tokens[:\s]+(\d+)\s+tokens.*?input.*?and (\d+)\s+tokens.*?completion/i
  );
  if (detailedMatch) {
    return {
      total: parseInt(detailedMatch[1], 10),
      input: parseInt(detailedMatch[2], 10),
      output: parseInt(detailedMatch[3], 10),
    };
  }


  // Pattern 2: "You requested 264230 tokens"
  const simpleMatch = message.match(/requested (\d+)\s+tokens/i);
  if (simpleMatch) {
    const total = parseInt(simpleMatch[1], 10);
    return { total, input: total, output: 0 };
  }

  // Pattern 3: extract the LAST number near "tokens" to avoid matching limits
  const looseMatches = [...message.matchAll(/(\d{4,})\s+tokens?/gi)];
  if (looseMatches.length > 0) {
    const last = looseMatches[looseMatches.length - 1];
    const total = parseInt(last[1], 10);
    return { total, input: total, output: 0 };
  }

  return null;
}

// ─── Duration formatting ──────────────────────────────────────────────────────

/**
 * Format a duration in milliseconds as a human-readable string.
 *
 * @param ms - Duration in milliseconds
 * @returns Human-readable duration string (e.g., "2h 30m", "45s", "1m 30s")
 */
export function formatDuration(ms: number): string {
  if (ms < 0) return "0s";
  if (ms < 1000) return `${ms}ms`;

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes > 0) {
    return `${hours}h ${remainingMinutes}m`;
  }
  return `${hours}h`;
}

// ─── Message formatting ───────────────────────────────────────────────────────

/**
 * Fill in template variables in a message string.
 * Supports: {sessionId}, {todoMdInstruction}, and any top-level string keys in vars.
 *
 * @param template - The template string
 * @param vars - Variables to substitute
 * @returns The filled-in string
 */
export function formatMessage(
  template: string,
  vars: Record<string, string>
): string {
  const unresolved: string[] = [];
  const result = template.replace(/\{(\w+)\}/g, (_, key) => {
    if (key in vars) return vars[key];
    unresolved.push(key);
    return `{${key}}`;
  });

  if (unresolved.length > 0) {
    console.warn(
      `[opencode-auto-continue] Unresolved template variables in message: ${unresolved.join(", ")}`
    );
  }

  return result;
}

// ─── Progress tracking ────────────────────────────────────────────────────────

/**
 * Update progress tracking fields on a session state object.
 * These fields are used to track AI output activity across events.
 *
 * @param s - The session state to update
 */
export function updateProgress(s: SessionState): void {
  s.lastProgressAt = Date.now();
}

// ─── Message text extraction ─────────────────────────────────────────────────

/**
 * Extract the text content from a message object.
 * Tries direct `content`/`text` fields first, then falls back to
 * concatenating text from the message's `parts` array.
 *
 * @param message - The message object (may have various shapes depending on event type)
 * @returns The extracted text content, or an empty string
 */
export function getMessageText(message: Record<string, unknown>): string {
  const direct =
    message?.content ??
    message?.text ??
    (message?.info as Record<string, unknown>)?.content ??
    (message?.info as Record<string, unknown>)?.text;
  if (typeof direct === "string" && direct.length > 0) return direct;

  const parts = [
    ...(Array.isArray(message?.parts) ? (message.parts as Array<Record<string, unknown>>) : []),
    ...(Array.isArray((message?.info as Record<string, unknown>)?.parts)
      ? ((message.info as Record<string, unknown>).parts as Array<Record<string, unknown>>)
      : []),
  ];

  return parts
    .map((part) => {
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.content === "string") return part.content;
      if (typeof part?.reasoning === "string") return part.reasoning;
      return "";
    })
    .filter(Boolean)
    .join(" ");
}