/**
 * Todo event handlers.
 * Handles: todo.updated
 */

import type { TodoItem } from "./types.js";
import type { PluginEvent } from "./types.js";
import type { HandlerContext } from "./event-handlers.js";

// ─── todo.updated ─────────────────────────────────────────────────────────────

export function handleTodoUpdated(
  ctx: HandlerContext,
  sid: string,
  e: PluginEvent,
): void {
  const props = e.properties as Record<string, unknown>;
  const todos = props.todos as TodoItem[] | undefined;
  if (!Array.isArray(todos)) return;
  ctx.todoPoller.markEventTodoReceived(sid);
  ctx.todoPoller.processTodos(sid, todos);
}