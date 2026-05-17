/**
 * Event dispatcher — routes OpenCode plugin events to focused handler modules.
 *
 * Handler modules:
 *   session-handlers.ts  — session.created/updated/diff/error/status/idle/compacted/ended/deleted
 *   message-handlers.ts — message.updated/part.updated/created/part.added
 *   todo-handlers.ts    — todo.updated
 *   question-handlers.ts — question.asked
 */

import { safeHook } from "./shared.js";
import { extractSessionId } from "./types.js";
import type { PluginEvent } from "./types.js";
import type { HandlerContext } from "./event-handlers.js";

// Re-export for backwards compatibility — all existing imports continue to work
export { type HandlerContext } from "./handler-context.js";
export { handleSystemTransform } from "./system-transform.js";
export { handleSessionCompacting, handleCompactionAutocontinue } from "./system-transform.js";

import {
  handleSessionError,
  handleSessionCreated,
  handleSessionUpdated,
  handleSessionStatus,
  handleSessionIdle,
  handleSessionCompacted,
  handleSessionEnded,
} from "./session-handlers.js";

import {
  handleMessageUpdated,
  handleMessagePartUpdated,
  handleMessageActivity,
} from "./message-handlers.js";

import { handleTodoUpdated } from "./todo-handlers.js";
import { handleQuestionAsked } from "./question-handlers.js";

// ─── Dispatcher ───────────────────────────────────────────────────────────────

/**
 * Main event dispatcher. Routes events to the appropriate handler function.
 */
export async function handleEvent(ctx: HandlerContext, event: PluginEvent): Promise<void> {
  if (ctx.isDisposed()) {
    ctx.log('[handleEvent] plugin is disposed, skipping event:', event.type);
    return;
  }

  await safeHook("event", async () => {
    const sid = extractSessionId(event);
    if (!sid) {
      ctx.log('event received without sessionID, skipping:', event.type);
      return;
    }

    const type = event.type;

    if (type === "session.error") {
      await handleSessionError(ctx, sid, event);
    } else if (type === "session.created") {
      await handleSessionCreated(ctx, sid);
    } else if (type === "session.updated") {
      handleSessionUpdated(ctx, sid);
    } else if (type === "session.diff") {
      ctx.log('session.diff:', sid);
    } else if (type === "message.updated") {
      await handleMessageUpdated(ctx, sid, event);
    } else if (type === "session.status") {
      await handleSessionStatus(ctx, sid, event);
    } else if (type === "message.part.updated") {
      await handleMessagePartUpdated(ctx, sid, event);
    } else if (type === "message.created" || type === "message.part.added") {
      await handleMessageActivity(ctx, sid, event, type);
    } else if (type === "todo.updated") {
      handleTodoUpdated(ctx, sid, event);
    } else if (type === "question.asked") {
      await handleQuestionAsked(ctx, sid, event);
    } else if (type === "session.idle") {
      await handleSessionIdle(ctx, sid);
    } else if (type === "session.compacted") {
      handleSessionCompacted(ctx, sid);
    } else if (type === "session.ended" || type === "session.deleted") {
      handleSessionEnded(ctx, sid, type);
    }
  });
}