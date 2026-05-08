import type { SessionState } from "./session-state.js";
import { createSession } from "./session-state.js";

export interface SessionManager {
  getSession(id: string): SessionState;
  clearTimer(id: string): void;
  resetSession(id: string): void;
}

export function createSessionManager(
  sessions: Map<string, SessionState>
): SessionManager {
  function getSession(id: string): SessionState {
    if (!sessions.has(id)) {
      sessions.set(id, createSession());
    }
    return sessions.get(id)!;
  }

  function clearTimer(id: string) {
    const s = sessions.get(id);
    if (s?.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
  }

  function resetSession(id: string) {
    clearTimer(id);
    const s = sessions.get(id);
    if (s) {
      s.planBuffer = "";
      s.planning = false;
      s.compacting = false;
      s.backoffAttempts = 0;
      s.autoSubmitCount = 0;
      s.lastUserMessageId = "";
      s.sentMessageAt = 0;
      s.reviewFired = false;
      if (s.reviewDebounceTimer) {
        clearTimeout(s.reviewDebounceTimer);
        s.reviewDebounceTimer = null;
      }
      if (s.nudgeTimer) {
        clearTimeout(s.nudgeTimer);
        s.nudgeTimer = null;
      }
      s.lastNudgeAt = 0;
      s.nudgeCount = 0;
      s.nudgePaused = false;
      s.hasOpenTodos = false;
      s.lastKnownTodos = [];
      s.lastTodoSnapshot = "";
      s.needsContinue = false;
      s.continueMessageText = "";
      s.messageCount = 0;
      s.estimatedTokens = 0;
      s.lastCompactionAt = 0;
      s.tokenLimitHits = 0;
      s.actionStartedAt = 0;
      s.stallDetections = 0;
      s.recoverySuccessful = 0;
      s.recoveryFailed = 0;
      s.lastRecoverySuccess = 0;
      s.totalRecoveryTimeMs = 0;
      s.recoveryStartTime = 0;
      s.recoveryTimes = [];
      s.statusHistory = [];
      s.lastStallPartType = "";
      s.stallPatterns = {};
      s.continueTimestamps = [];
      s.lastAdvisoryAdvice = null;
      s.lastPlanItemDescription = "";
    }
    sessions.delete(id);
  }

  return { getSession, clearTimer, resetSession };
}
