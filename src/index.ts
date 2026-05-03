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
  stallTimeoutMs: 30000,
  continueWaitMs: 1500,
  maxRecoveries: 3,
  cooldownMs: 60000,
  enableCompressionFallback: false,
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
  console.log("[auto-force-resume] Plugin loading with options:", JSON.stringify(options));

  const config: PluginConfig = {
    ...DEFAULT_CONFIG,
    ...(typeof options === "object" && options !== null ? options as Partial<PluginConfig> : {}),
  };

  console.log("[auto-force-resume] Merged config:", JSON.stringify(config));

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
    console.log(`[auto-force-resume] Reset session: ${sessionId}`);
    clearStallTimer(sessionId);
    sessions.delete(sessionId);
  };

  const sendContinue = async (sessionId: string): Promise<boolean> => {
    try {
      console.log(`[auto-force-resume] Sending continue to session: ${sessionId}`);
      const result = await input.client.session.prompt({
        body: {
          parts: [{ type: "text", text: "continue" }],
          noReply: true,
        },
        path: { id: sessionId },
      });
      if ("error" in result) {
        console.error(`[auto-force-resume] Continue returned error:`, result.error);
        return false;
      }
      console.log(`[auto-force-resume] Continue sent successfully`);
      return true;
    } catch (e) {
      console.error(`[auto-force-resume] Failed to send continue:`, e);
      return false;
    }
  };

  const performRecovery = async (sessionId: string): Promise<void> => {
    const state = getOrCreateSession(sessionId);
    const now = Date.now();

    console.log(`[auto-force-resume] Recovery triggered for ${sessionId}, attempts: ${state.attempts}, recoveryInProgress: ${state.recoveryInProgress}`);

    if (state.recoveryInProgress) {
      console.log(`[auto-force-resume] Recovery already in progress, skipping`);
      return;
    }

    if (state.attempts >= config.maxRecoveries) {
      console.log(`[auto-force-resume] Max recoveries (${config.maxRecoveries}) reached for ${sessionId}`);
      return;
    }

    if (now - state.lastRecoveryTime < config.cooldownMs && state.attempts > 0) {
      console.log(`[auto-force-resume] Within cooldown period, skipping`);
      return;
    }

    state.recoveryInProgress = true;
    state.attempts++;
    state.lastRecoveryTime = now;

    console.log(`[auto-force-resume] Session ${sessionId} stalled — recovery attempt ${state.attempts}`);

    // Try session.abort() first
    console.log(`[auto-force-resume] Calling session.abort() for ${sessionId}`);
    try {
      const abortResult = await input.client.session.abort({
        path: { id: sessionId },
      });
      console.log(`[auto-force-resume] abort() result:`, JSON.stringify(abortResult));
      if ("error" in abortResult && abortResult.error) {
        console.error(`[auto-force-resume] abort() returned error:`, abortResult.error);
      }
    } catch (e) {
      console.error(`[auto-force-resume] abort() failed:`, e);
    }

    await new Promise((r) => setTimeout(r, config.continueWaitMs));

    const continued = await sendContinue(sessionId);
    if (continued) {
      console.log(`[auto-force-resume] Recovery sent for ${sessionId}`);
    } else {
      console.error(`[auto-force-resume] Continue failed for ${sessionId}`);
    }

    state.recoveryInProgress = false;
  };

  const handleActivity = (sessionId: string): void => {
    const state = getOrCreateSession(sessionId);

    console.log(`[auto-force-resume] Activity for ${sessionId}, resetting timer`);

    clearStallTimer(sessionId);

    if (state.recoveryInProgress) {
      console.log(`[auto-force-resume] Recovery in progress, not starting new timer`);
      return;
    }

    state.stallTimer = setTimeout(() => {
      console.log(`[auto-force-resume] Stall timer fired for ${sessionId}`);
      performRecovery(sessionId);
    }, config.stallTimeoutMs);
  };

  return {
    event: async ({ event }) => {
      const sessionId = (event as { properties?: { sessionID?: string } }).properties?.sessionID || "default";

      console.log(`[auto-force-resume] Event received: ${event.type} for session: ${sessionId}`);

      if (ACTIVITY_EVENTS.includes(event.type as typeof ACTIVITY_EVENTS[number])) {
        handleActivity(sessionId);
      } else if (STALE_EVENTS.includes(event.type as typeof STALE_EVENTS[number])) {
        resetSession(sessionId);
      }
    },

    config: async () => {
      console.log("[auto-force-resume] Config hook called");
    },
  };
};