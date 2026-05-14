import type { PluginInput } from "@opencode-ai/plugin";

// Re-export autonomy types for convenience
export * from "./autonomy-types.js";

/**
 * Typed client interface for OpenCode plugin modules.
 * 
 * This extracts the client type from PluginInput to avoid casting through `any`.
 * Usage: `(input as TypedPluginInput).client.session.status(...)`
 */
export type TypedPluginInput = PluginInput;

/**
 * Helper type for session method options.
 * Most session methods accept { path: { id: string }, query?: { directory?: string }, body?: unknown }
 */
export interface SessionMethodOptions {
  path?: { id?: string };
  query?: { directory?: string };
  body?: unknown;
}

/**
 * Helper to extract data from a RequestResult response.
 */
export function getResponseData<T>(result: { data?: T; error?: unknown }): T | undefined {
  return result.data;
}