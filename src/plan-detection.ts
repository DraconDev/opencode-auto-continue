/**
 * Plan detection — patterns for identifying AI plan content.
 * Used by nudge and recovery modules to detect when the AI is planning
 * (and should not be interrupted with nudges or continue prompts).
 */

import type { SessionState } from "./session-state.js";
import { estimateTokens } from "./utils.js";

// ─── Pattern definitions ───────────────────────────────────────────────────────

/**
 * Patterns that indicate the AI is outputting a plan rather than acting.
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
 * Patterns that indicate tool call output appearing as text (hallucination signal).
 * Matches XML-style tool tags that the AI might output as raw text.
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
 * Patterns that match truncated XML tool tags (after the AI has already
 * produced one complete set of tags and the system truncated the message).
 * Used with containsToolCallAsText for open-without-close detection.
 */
export const TRUNCATED_XML_PATTERNS: Array<{ open: RegExp; close: RegExp }> = [
  { open: /<function[^>]*>/i, close: /<\/function>/i },
  { open: /<parameter[^>]*>/i, close: /<\/parameter>/i },
  { open: /<tool_call[^>]*>/i, close: /<\/tool_call>/i },
  { open: /<invoke[^>]*>/i, close: /<\/invoke>/i },
];

/**
 * Check if text content indicates the AI is creating a plan.
 *
 * @param text - The text content to check
 * @returns true if the text matches a plan-content pattern
 */
export function isPlanContent(text: string): boolean {
  const trimmed = text.trim();
  return PLAN_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Check if text content looks like tool call output appearing as raw text.
 * This is used as a hallucination detection signal.
 *
 * @param text - The text content to check
 * @returns true if the text appears to be tool call output as text
 */
export function containsToolCallAsText(text: string): boolean {
  // Check XML-style tool tag patterns
  if (TOOL_TEXT_PATTERNS.some((pat) => pat.test(text))) return true;
  // Check truncated XML patterns (open without close)
  for (const { open, close } of TRUNCATED_XML_PATTERNS) {
    if (open.test(text) && !close.test(text)) return true;
  }
  return false;
}

// ─── Session-level plan detection ──────────────────────────────────────────────

/**
 * Check if the session is currently in a planning state.
 * Returns true if the session has the planning flag set AND
 * the planning has been going on for less than the timeout.
 *
 * @param s - The session state
 * @param planningTimeoutMs - Maximum time to allow planning (default: 10 minutes)
 * @returns true if the AI is actively planning
 */
export function isSessionPlanning(
  s: SessionState,
  planningTimeoutMs: number = 10 * 60 * 1000
): boolean {
  if (!s.planning) return false;
  const elapsed = Date.now() - s.planningStartedAt;
  return elapsed < planningTimeoutMs;
}

/**
 * Estimate whether a session message appears to be a plan.
 * Uses plan detection patterns plus a rough token threshold.
 *
 * @param text - The message text
 * @param maxTokens - Maximum token count for a plan-only message (default: 150)
 * @returns true if the text looks like a plan
 */
export function estimateIsPlan(
  text: string,
  maxTokens: number = 150
): boolean {
  if (!isPlanContent(text)) return false;
  const tokenEstimate = estimateTokens(text);
  return tokenEstimate <= maxTokens;
}