import type { PluginInput } from "@opencode-ai/plugin";

/**
 * Typed alias for the OpenCode PluginInput.
 * Use this instead of `any` for plugin input parameters.
 */
export type TypedPluginInput = PluginInput;

// ─── Event Types ───────────────────────────────────────────────────────────────
// These types mirror the OpenCode SDK's discriminated event unions.
// We define them locally to avoid a direct dependency on @opencode-ai/sdk,
// which is a transitive dependency via @opencode-ai/plugin.

/**
 * The base event shape dispatched by the OpenCode event system.
 * The `type` field discriminates which properties are available.
 */
export type PluginEvent = {
  type: string;
  properties: Record<string, unknown>;
};

// ─── Specific Event Types ──────────────────────────────────────────────────────

/** Error information from a session.error event */
export interface SessionErrorProperties {
  sessionID?: string;
  error?: {
    name: string;
    message?: string;
    data?: Record<string, unknown>;
    statusCode?: number;
    isRetryable?: boolean;
  };
}

/** Properties for session.created / session.updated / session.deleted events */
export interface SessionInfoProperties {
  info: SessionInfo;
}

/** Properties for session.status events */
export interface SessionStatusProperties {
  sessionID: string;
  status: SessionStatusType;
}

/** Properties for session.idle events */
export interface SessionIdOnlyProperties {
  sessionID: string;
}

/** Properties for session.compacted events */
export type SessionCompactedProperties = SessionIdOnlyProperties;

/** Properties for session.diff events */
export interface SessionDiffProperties {
  sessionID: string;
  diff: Array<unknown>;
}

// ─── Message Event Types ──────────────────────────────────────────────────────

/** Properties for message.updated events */
export interface MessageUpdatedProperties {
  info: MessageInfo;
}

/** Properties for message.part.updated events */
export interface MessagePartUpdatedProperties {
  part: PartInfo;
  delta?: string;
}

// ─── Todo Event Types ──────────────────────────────────────────────────────────

/** Properties for todo.updated events */
export interface TodoUpdatedProperties {
  sessionID: string;
  todos: TodoItem[];
}

// ─── Model Types ───────────────────────────────────────────────────────────────

/** Session status types from the SDK */
export type SessionStatusType =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number };

/** Session info from session.created/updated/deleted events */
export interface SessionInfo {
  id: string;
  sessionID?: string;
  projectID: string;
  directory: string;
  title: string;
  version: string;
  time: {
    created: number;
    updated: number;
    compacting?: number;
  };
}

/** Message info from message.updated events */
export interface MessageInfo {
  id: string;
  sessionID: string;
  role: "user" | "assistant" | "system";
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
  };
  content?: string;
  text?: string;
  parts?: PartInfo[];
  synthetic?: boolean;
  time?: {
    created: number;
  };
}

/** Part info from message.part.updated events */
export interface PartInfo {
  id: string;
  sessionID: string;
  messageID: string;
  type: PartType;
  text?: string;
  synthetic?: boolean;
  name?: string;
  toolName?: string;
  input?: unknown;
  url?: string;
  mime?: string;
  prompt?: string;
  description?: string;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: {
      read?: number;
      write?: number;
    };
  };
}

/** All known part types from the SDK */
export type PartType =
  | "text"
  | "reasoning"
  | "tool"
  | "file"
  | "subtask"
  | "step-start"
  | "step-finish"
  | "compaction"
  | "snapshot"
  | "patch"
  | "agent"
  | "retry";

/** Todo item from todo.updated events */
export interface TodoItem {
  id: string;
  content?: string;
  title?: string;
  status: string;
  priority?: string;
}

// ─── Type Guards ───────────────────────────────────────────────────────────────

/** Type guard: checks if a part is a text part */
export function isTextPart(part: PartInfo): part is PartInfo & { type: "text"; text: string } {
  return part.type === "text";
}

/** Type guard: checks if a part is a reasoning part */
export function isReasoningPart(part: PartInfo): part is PartInfo & { type: "reasoning"; text: string } {
  return part.type === "reasoning";
}

/** Type guard: checks if a part is a tool part */
export function isToolPart(part: PartInfo): part is PartInfo & { type: "tool" } {
  return part.type === "tool";
}

/** Type guard: checks if a part is a step-finish part */
export function isStepFinishPart(part: PartInfo): part is PartInfo & { type: "step-finish"; tokens: NonNullable<PartInfo["tokens"]> } {
  return part.type === "step-finish";
}

/** Type guard: checks if a part is a file part */
export function isFilePart(part: PartInfo): part is PartInfo & { type: "file" } {
  return part.type === "file";
}

/** Type guard: checks if a part is a compaction part */
export function isCompactionPart(part: PartInfo): part is PartInfo & { type: "compaction" } {
  return part.type === "compaction";
}

/** Type guard: checks if a part is a step-start part */
export function isStepStartPart(part: PartInfo): part is PartInfo & { type: "step-start" } {
  return part.type === "step-start";
}

// ─── Utility Functions ─────────────────────────────────────────────────────────

/**
 * Extract the sessionID from any event.
 * The SDK Event types nest sessionID at different paths depending on the event type.
 * This helper extracts it safely.
 */
export function extractSessionId(event: PluginEvent): string | undefined {
  const props = event.properties;
  if (!props) return undefined;

  // Most events have sessionID at the top level of properties
  if (typeof props.sessionID === "string") return props.sessionID;

  // Session events nest it in .info
  const info = props.info as Record<string, unknown> | undefined;
  if (info && typeof info.sessionID === "string") return info.sessionID;

  // Part events nest it in .part
  const part = props.part as Record<string, unknown> | undefined;
  if (part && typeof part.sessionID === "string") return part.sessionID;

  return undefined;
}

/**
 * Check if an event was generated by this plugin (synthetic).
 * Synthetic events should be ignored to prevent infinite loops.
 */
export function isSyntheticEvent(event: PluginEvent): boolean {
  const props = event.properties || {};
  const info = (props.info as Record<string, unknown>) || {};
  const part = (props.part as Record<string, unknown>) || {};

  if (props.synthetic === true || info.synthetic === true || part.synthetic === true) {
    return true;
  }

  const parts = [
    ...(Array.isArray(props.parts) ? props.parts : []),
    ...(Array.isArray(info.parts) ? (info.parts as unknown[]) : []),
    ...(Array.isArray((props.message as Record<string, unknown>)?.parts) ? (props.message as Record<string, unknown>).parts as unknown[] : []),
  ];

  return parts.some((p: unknown) => typeof p === "object" && p !== null && (p as Record<string, unknown>).synthetic === true);
}
