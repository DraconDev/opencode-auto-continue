import { existsSync } from "fs";
import type { PluginConfig } from "./config.js";
import type { SessionState, Todo } from "./session-state.js";

export interface StopConditionResult {
  shouldStop: boolean;
  reason: string;
}

export interface StopConditionsDeps {
  config: PluginConfig;
  sessions: Map<string, SessionState>;
  log: (...args: unknown[]) => void;
}

export function createStopConditionsModule(deps: StopConditionsDeps) {
  const { config, sessions, log } = deps;

  function checkStopConditions(sessionId: string): StopConditionResult {
    const s = sessions.get(sessionId);
    if (!s) return { shouldStop: false, reason: "" };
    if (s.stoppedByCondition) return { shouldStop: true, reason: s.stoppedByCondition };

    if (config.maxRuntimeMs > 0) {
      const elapsed = Date.now() - s.sessionCreatedAt;
      if (elapsed >= config.maxRuntimeMs) {
        const reason = `maxRuntimeMs: session ran for ${elapsed}ms (limit: ${config.maxRuntimeMs}ms)`;
        log('[StopConditions] STOP —', reason);
        s.stoppedByCondition = reason;
        return { shouldStop: true, reason };
      }
    }

    if (config.stopFilePath) {
      if (existsSync(config.stopFilePath)) {
        const reason = `stopFile: ${config.stopFilePath} exists`;
        log('[StopConditions] STOP —', reason);
        s.stoppedByCondition = reason;
        return { shouldStop: true, reason };
      }
    }

    if (config.untilMarker) {
      const marker = config.untilMarker;
      // Search todo content/title, not the id:status snapshot format
      const todos = s.lastKnownTodos as Todo[] | undefined;
      if (todos && todos.length > 0) {
        const found = todos.some(t =>
          (t.content && t.content.includes(marker)) ||
          (t.title && t.title.includes(marker))
        );
        if (found) {
          const reason = `untilMarker: "${marker}" found in todo content`;
          log('[StopConditions] STOP —', reason);
          s.stoppedByCondition = reason;
          return { shouldStop: true, reason };
        }
      }
    }

    return { shouldStop: false, reason: "" };
  }

  return { checkStopConditions };
}
