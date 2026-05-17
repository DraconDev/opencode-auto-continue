/**
 * Shared HandlerContext interface — the dependency bundle passed to all handlers.
 * Extracted from event-handlers.ts to avoid circular imports during the refactor.
 */

import type { PluginConfig } from "./config.js";
import type { SessionState } from "./session-state.js";
import type { TypedPluginInput } from "./types.js";
import type { createTerminalModule } from "./terminal.js";
import type { createCompactionModule } from "./compaction.js";
import type { createNudgeModule } from "./nudge.js";
import type { createReviewModule } from "./review.js";
import type { createSessionMonitor } from "./session-monitor.js";
import type { createStopConditionsModule } from "./stop-conditions.js";
import type { createTestRunner } from "./test-runner.js";
import type { createTodoPoller } from "./todo-poller.js";

/** Bundles all dependencies needed by event handlers */
export interface HandlerContext {
  input: TypedPluginInput;
  config: PluginConfig;
  sessions: Map<string, SessionState>;
  log: (...args: unknown[]) => void;
  isDisposed: () => boolean;

  // Session helpers
  getSession: (id: string) => SessionState;
  refreshRealTokens: (id: string) => Promise<number>;
  clearTimer: (id: string) => void;
  resetSession: (id: string) => void;

  // Sub-modules
  terminal: ReturnType<typeof createTerminalModule>;
  writeStatusFile: (sessionId: string) => void;
  clearPendingWrites: () => void;
  compaction: ReturnType<typeof createCompactionModule>;
  nudge: ReturnType<typeof createNudgeModule>;
  review: ReturnType<typeof createReviewModule>;
  sessionMonitor: ReturnType<typeof createSessionMonitor>;
  stopConditions: ReturnType<typeof createStopConditionsModule>;
  testRunner: ReturnType<typeof createTestRunner>;
  todoPoller: ReturnType<typeof createTodoPoller>;

  // Recovery scheduling
  scheduleRecovery: (sessionId: string, delayMs: number) => void;
  recover: (sessionId: string) => Promise<void>;
}