import type { Plugin } from "@opencode-ai/plugin";

interface SessionState {
  timer: ReturnType<typeof setTimeout> | null;
  attempts: number;
  lastRecoveryTime: number;
  lastProgressAt: number;
  aborting: boolean;
  userCancelled: boolean;
}

interface PluginConfig {
  stallTimeoutMs: number;
  waitAfterAbortMs: number;
  maxRecoveries: number;
  cooldownMs: number;
}

const DEFAULT_CONFIG: PluginConfig = {
  stallTimeoutMs: 180000,
  waitAfterAbortMs: 1500,
  maxRecoveries: 3,
  cooldownMs: 60000,
};

export const AutoForceResumePlugin: Plugin = async (input, options) => {
  const config: PluginConfig = {
    ...DEFAULT_CONFIG,
    ...(typeof options === "object" && options !== null ? options as Partial<PluginConfig> : {}),
  };

  const sessions = new Map<string, SessionState>();

  function getSession(id: string): SessionState {
    if (!sessions.has(id)) {
      sessions.set(id, {
        timer: null,
        attempts: 0,
        lastRecoveryTime: 0,
        lastProgressAt: Date.now(),
        aborting: false,
        userCancelled: false,
      });
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
    sessions.delete(id);
  }

  function updateProgress(s: SessionState) {
    s.lastProgressAt = Date.now();
  }

  async function recover(sessionId: string) {
    const s = sessions.get(sessionId);
    if (!s) return;

    if (s.aborting) return;
    if (s.userCancelled) return;
    if (s.attempts >= config.maxRecoveries) return;

    const now = Date.now();
    if (now - s.lastRecoveryTime < config.cooldownMs) return;

    s.aborting = true;

    try {
      const statusResult = await input.client.session.status({});
      const statusData = statusResult.data as Record<string, { type: string }>;
      const sessionStatus = statusData[sessionId];

      if (!sessionStatus || sessionStatus.type !== "busy") {
        s.aborting = false;
        return;
      }

      if (now - s.lastProgressAt < config.stallTimeoutMs) {
        s.aborting = false;
        return;
      }

      await (input.client.session as any).abort({ 
        path: { id: sessionId },
        query: { directory: (input as any).directory }
      });

      // Poll for session to become idle (max 5 seconds)
      const pollInterval = 200;
      const maxPollTime = 5000;
      const startTime = Date.now();
      let isIdle = false;
      let statusFailures = 0;
      const maxStatusFailures = 3;

      while (!isIdle && Date.now() - startTime < maxPollTime && statusFailures < maxStatusFailures) {
        await new Promise(r => setTimeout(r, pollInterval));
        try {
          const pollResult = await input.client.session.status({});
          const pollData = pollResult.data as Record<string, { type: string }>;
          const pollStatus = pollData[sessionId];
          if (pollStatus?.type === "idle") {
            isIdle = true;
          }
          statusFailures = 0; // Reset on success
        } catch {
          statusFailures++;
        }
      }

      // Also wait the minimum time even if idle
      const remainingWait = config.waitAfterAbortMs - (Date.now() - startTime);
      if (remainingWait > 0) {
        await new Promise(r => setTimeout(r, remainingWait));
      }

      const promptOptions = {
        body: { parts: [{ type: "text", text: "continue" }] as any[] },
        path: { id: sessionId },
        query: { directory: (input as any).directory }
      };

      try {
        if (typeof (input.client.session as any).promptAsync === "function") {
          await (input.client.session as any).promptAsync(promptOptions);
        } else {
          await input.client.session.prompt(promptOptions as any);
        }
      } catch {
        // prompt failed
      }

      s.attempts++;
      s.lastRecoveryTime = now;

      s.timer = setTimeout(() => {
        recover(sessionId);
      }, config.stallTimeoutMs);
    } catch {
      // recovery failed
    } finally {
      s.aborting = false;
    }
  }

  return {
    event: async ({ event }: { event: any }) => {
      const e = event as any;
      const sid = e?.properties?.sessionID || e?.properties?.info?.sessionID || e?.properties?.part?.sessionID || "default";

      const progressTypes = [
        "message.part.delta",
        "message.part.updated",
        "session.status"
      ];

      const staleTypes = [
        "session.idle",
        "session.error",
        "session.compacted",
        "session.ended",
        "session.deleted"
      ];

      if (event?.type === "session.error") {
        const err = e?.properties?.error;
        if (err?.name === "MessageAbortedError") {
          const s = sessions.get(sid);
          if (s) s.userCancelled = true;
          clearTimer(sid);
        }
        return;
      }

      if (event?.type === "session.created") {
        const s = getSession(sid);
        clearTimer(sid);
        s.timer = setTimeout(() => {
          recover(sid);
        }, config.stallTimeoutMs);
        return;
      }

      if (event?.type === "session.status") {
        const status = e?.properties?.status;
        const s = getSession(sid);
        if (status?.type === "busy") {
          updateProgress(s);
          s.attempts = 0;
          s.userCancelled = false;
        }
        clearTimer(sid);
        s.timer = setTimeout(() => {
          recover(sid);
        }, config.stallTimeoutMs);
        return;
      }

      if (progressTypes.includes(event?.type)) {
        const s = getSession(sid);

        if (event?.type === "message.part.updated") {
          const partType = e?.properties?.part?.type;
          const isRealProgress = partType === "text" || partType === "step-finish" || partType === "reasoning";
          if (isRealProgress) {
            updateProgress(s);
            s.attempts = 0;
            s.userCancelled = false;
          }
        } else {
          updateProgress(s);
          s.attempts = 0;
          s.userCancelled = false;
        }

        clearTimer(sid);
        s.timer = setTimeout(() => {
          recover(sid);
        }, config.stallTimeoutMs);
        return;
      }

      if (event?.type === "message.created" || event?.type === "message.part.added") {
        const s = getSession(sid);
        s.attempts = 0;
        s.userCancelled = false;
        clearTimer(sid);
        s.timer = setTimeout(() => {
          recover(sid);
        }, config.stallTimeoutMs);
        return;
      }

      if (staleTypes.includes(event?.type)) {
        resetSession(sid);
      }
    },
    dispose: () => {
      sessions.forEach((s) => {
        if (s.timer) {
          clearTimeout(s.timer);
          s.timer = null;
        }
      });
      sessions.clear();
    }
  };
};