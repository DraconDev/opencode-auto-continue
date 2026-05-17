/**
 * Typed helpers to eliminate `as any` casts.
 * All timer-related utilities, error inspectors, and message shape accessors
 * live here so callers can use type-safe helpers instead of casting.
 */

import type { TypedPluginInput } from "./types.js";
import type { SessionState } from "./session-state.js";

// ─── Timer helpers ───────────────────────────────────────────────────────────

/**
 * Call .unref() on a timer if it supports it.
 * Node.js timers have .unref() to prevent the process from staying alive,
 * but the ReturnType<typeof setTimeout> type doesn't include it.
 * This helper avoids `as any` at every call site.
 */
export function safeUnref(timer: ReturnType<typeof setTimeout> | null): void {
  if (timer === null) return;
  // Check via bracket notation to avoid TS's narrower type
  if ("unref" in timer && typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref(): void }).unref();
  }
}

// ─── Error helpers ────────────────────────────────────────────────────────────

/**
 * Extract error name from an unknown error value.
 * Handles: Error instance, Axios-style { name, message }, { data: { info: { error: { name } } } }
 */
export function getErrorName(e: unknown): string {
  if (e instanceof Error) return e.name;
  if (typeof e === "object" && e !== null) {
    // Axios-like: { name: string }
    if ("name" in e) return String((e as { name?: unknown }).name);
    // Deep path: { data: { info: { error: { name } } } }
    try {
      const d = (e as Record<string, unknown>);
      const info = d.data as Record<string, unknown> | undefined;
      const err = info?.info as Record<string, unknown> | undefined;
      const error = err?.error as Record<string, unknown> | undefined;
      if (error && "name" in error) return String(error.name);
    } catch {
      // fall through to empty
    }
  }
  return "";
}

/**
 * Get the inner error object from a rejected promise / thrown error.
 * Handles: Error instance, Axios-like { response: { data: { info: { error } } } }
 */
export function getResponseError(e: unknown): Record<string, unknown> | null {
  if (e === null || e === undefined) return null;
  if (typeof e !== "object") return null;

  const obj = e as Record<string, unknown>;

  // { response: { data: { info: { error } } } }
  const response = obj.response as Record<string, unknown> | undefined;
  if (response) {
    const data = response.data as Record<string, unknown> | undefined;
    if (data) {
      const info = data.info as Record<string, unknown> | undefined;
      if (info && "error" in info) return info as Record<string, unknown>;
    }
  }

  // Already a direct error object
  if ("error" in obj) return obj as Record<string, unknown>;
  return null;
}

/**
 * Check if an error (or error-like object) is a MessageAbortedError.
 * Used to detect when the AI aborted the continue/nudge message.
 */
export function isMessageAbortedError(e: unknown): boolean {
  if (e instanceof Error) return e.name === "MessageAbortedError";
  return getErrorName(e) === "MessageAbortedError";
}

// ─── Message shape helpers ────────────────────────────────────────────────────

/**
 * Extract the message role from a message object.
 * Handles: { role: string } or { info: { role: string } }
 */
export function getMessageRole(msg: Record<string, unknown>): string {
  if ("role" in msg && typeof msg.role === "string") return msg.role;
  const info = msg.info as Record<string, unknown> | undefined;
  if (info && "role" in info && typeof info.role === "string") return info.role;
  return "";
}

/**
 * Extract the parts array from a message object.
 * Handles: { parts: [...] } or { info: { parts: [...] } }
 */
export function getMessageParts(msg: Record<string, unknown>): Array<Record<string, unknown>> {
  if (Array.isArray(msg.parts)) return msg.parts as Array<Record<string, unknown>>;
  const info = msg.info as Record<string, unknown> | undefined;
  if (info && Array.isArray(info.parts)) return info.parts as Array<Record<string, unknown>>;
  return [];
}

// ─── Client type helpers ──────────────────────────────────────────────────────

/**
 * Check if the plugin input has a $ method (test-runner check).
 * This is a plugin-internal API not exposed in the public types.
 */
export function hasDollarMethod(input: TypedPluginInput): boolean {
  return typeof (input as unknown as { $?: unknown }).$ === "function";
}

/**
 * Access the underlying HTTP client from input.client.
 * The _client property is internal to the OpenCode SDK.
 * Returns undefined if unavailable.
 */
export function getHttpClient(input: TypedPluginInput): { post(opts: { url: string; headers?: Record<string, string>; body: unknown }): Promise<unknown> } | undefined {
  // Cast through unknown to access the internal _client property
  const client = (input.client as unknown as Record<string, unknown>)._client as
    | { post(opts: { url: string; headers?: Record<string, string>; body: unknown }): Promise<unknown> }
    | undefined;
  return client;
}

// ─── Prompt guard log helper ──────────────────────────────────────────────────

/**
 * A logger compatible with shouldBlockPrompt's log parameter.
 * Wraps the plugin's log function for use in the prompt guard.
 */
export function createPromptGuardLogger(log: (...args: unknown[]) => void) {
  // Return a function that matches (...args: unknown[]) => void by delegating directly
  return (...args: unknown[]) => log(...args);
}