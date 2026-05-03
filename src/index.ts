import type { Plugin } from "@opencode-ai/plugin";

interface SessionState {
  stallTimer: ReturnType<typeof setTimeout> | null;
  attempts: number;
  lastRecoveryTime: number;
  recoveryInProgress: boolean;
}

interface PluginConfig {
  stallTimeoutMs: number;
  continueWaitMs: number;
  maxRecoveries: number;
  cooldownMs: number;
  enableCompressionFallback: boolean;
}

const DEFAULT_CONFIG: PluginConfig = {
  stallTimeoutMs: 180000,
  continueWaitMs: 1500,
  maxRecoveries: 10,
  cooldownMs: 300000,
  enableCompressionFallback: true,
};

const ACTIVITY_EVENTS = [
  "message.part.updated",
  "message.part.added",
  "message.updated",
  "message.created",
  "step.finish",
  "session.status",
] as const;

const STALE_EVENTS = [
  "session.idle",
  "session.error",
  "session.compacted",
  "session.ended",
] as const;

export const AutoForceResumePlugin: Plugin = async (input, options) => {
  const config: PluginConfig = {
    ...DEFAULT_CONFIG,
    ...(typeof options === "object" && options !== null ? options as Partial<PluginConfig> : {}),
  };

  const sessions = new Map<string, SessionState>();

  const getOrCreateSession = (sessionId: string): SessionState => {
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, {
        stallTimer: null,
        attempts: 0,
        lastRecoveryTime: 0,
        recoveryInProgress: false,
      });
    }
    return sessions.get(sessionId)!;
  };

  const clearStallTimer = (sessionId: string): void => {
    const state = sessions.get(sessionId);
    if (state?.stallTimer) {
      clearTimeout(state.stallTimer);
      state.stallTimer = null;
    }
  };

  const resetSession = (sessionId: string): void => {
    clearStallTimer(sessionId);
    sessions.delete(sessionId);
  };

  const abortSession = async (sessionId: string): Promise<boolean> => {
    try {
      const result = await input.client.session.abort({
        path: { id: sessionId },
      });
      if ("error" in result) {
        console.error(`[auto-force-resume] Abort returned error for ${sessionId}`);
        return false;
      }
      return true;
    } catch (e) {
      console.error(`[auto-force-resume] Failed to abort session ${sessionId}:`, e);
      return false;
    }
  };

  const sendContinue = async (sessionId: string): Promise<boolean> => {
    try {
      const result = await input.client.session.prompt({
        body: {
          parts: [{ type: "text", text: "continue" }],
          noReply: true,
        },
        path: { id: sessionId },
      });
      if ("error" in result) {
        return false;
      }
      return true;
    } catch (e) {
      console.error(`[auto-force-resume] Failed to send continue:`, e);
      return false;
    }
  };

  const compressAndResume = async (sessionId: string): Promise<boolean> => {
    console.log(`[auto-force-resume] Attempting context compression for session ${sessionId}`);
    try {
      const compactResult = await input.client.session.prompt({
        body: {
          parts: [{ type: "text", text: "/compact" }],
          noReply: true,
        },
        path: { id: sessionId },
      });
      if ("error" in compactResult) {
        console.error(`[auto-force-resume] Compact failed for ${sessionId}`);
        return false;
      }
    } catch (e) {
      console.error(`[auto-force-resume] Failed to send /compact:`, e);
      return false;
    }

    await new Promise((r) => setTimeout(r, 2000));

    const resumed = await sendContinue(sessionId);
    if (resumed) {
      console.log(`[auto-force-resume] Compression recovery succeeded for ${sessionId}`);
      return true;
    }
    console.error(`[auto-force-resume] Compression recovery failed for ${sessionId}`);
    return false;
  };

  const performRecovery = async (sessionId: string): Promise<void> => {
    const state = getOrCreateSession(sessionId);
    const now = Date.now();

    if (state.recoveryInProgress) {
      return;
    }

    if (state.attempts >= config.maxRecoveries) {
      console.log(`[auto-force-resume] Max recoveries (${config.maxRecoveries}) reached for ${sessionId}`);
      return;
    }

    if (now - state.lastRecoveryTime < config.cooldownMs && state.attempts > 0) {
      return;
    }

    state.recoveryInProgress = true;
    state.attempts++;
    state.lastRecoveryTime = now;

    console.log(`[auto-force-resume] Session ${sessionId} stalled — recovery attempt ${state.attempts}`);

    const aborted = await abortSession(sessionId);
    if (!aborted) {
      console.error(`[auto-force-resume] Abort failed for ${sessionId}, aborting recovery`);
      state.recoveryInProgress = false;
      return;
    }

    await new Promise((r) => setTimeout(r, config.continueWaitMs));

    const continued = await sendContinue(sessionId);
    if (continued) {
      console.log(`[auto-force-resume] Recovery sent for ${sessionId}`);
    } else {
      console.error(`[auto-force-resume] Continue failed for ${sessionId}`);
    }

    state.recoveryInProgress = false;

    if (!continued && config.enableCompressionFallback) {
      console.log(`[auto-force-resume] Standard recovery failed, trying compression fallback`);
      const compressed = await compressAndResume(sessionId);
      if (!compressed) {
        console.error(`[auto-force-resume] All recovery methods exhausted for ${sessionId}`);
      }
    }
  };

  const handleActivity = (sessionId: string): void => {
    const state = getOrCreateSession(sessionId);

    clearStallTimer(sessionId);

    if (state.recoveryInProgress) {
      return;
    }

    state.stallTimer = setTimeout(() => {
      performRecovery(sessionId);
    }, config.stallTimeoutMs);
  };

  return {
    event: async ({ event }) => {
      const sessionId = (event as { properties?: { sessionID?: string } }).properties?.sessionID || "default";

      if (ACTIVITY_EVENTS.includes(event.type as typeof ACTIVITY_EVENTS[number])) {
        handleActivity(sessionId);
      } else if (STALE_EVENTS.includes(event.type as typeof STALE_EVENTS[number])) {
        resetSession(sessionId);
      }
    },

    config: async () => {
      console.log("[auto-force-resume] Plugin loaded with config:", JSON.stringify(config));
    },
  };
};