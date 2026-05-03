import type { Plugin } from "@opencode-ai/plugin";

interface SessionState {
  timer: ReturnType<typeof setTimeout> | null;
  attempts: number;
  lastRecoveryTime: number;
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
      sessions.set(id, { timer: null, attempts: 0, lastRecoveryTime: 0 });
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

  async function recover(sessionId: string) {
    // Step 1: abort
    try {
      await (input.client.session as any).abort({ path: { id: sessionId } });
    } catch {
      // abort failed, continue anyway
    }

    // Step 2: wait
    await new Promise(r => setTimeout(r, config.waitAfterAbortMs));

    // Step 3: continue
    try {
      await input.client.session.prompt({
        body: { parts: [{ type: "text", text: "continue" }], noReply: true },
        path: { id: sessionId }
      });
    } catch {
      // continue failed
    }
  }

  return {
    event: async ({ event }: { event: any }) => {
      const e = event as any;
      const sid = e?.properties?.sessionID || e?.properties?.info?.sessionID || e?.properties?.part?.sessionID || "default";

      const activityTypes = [
        "message.part.updated",
        "message.part.added",
        "message.updated",
        "message.created",
        "step.finish",
        "session.status"
      ];

      const staleTypes = [
        "session.idle",
        "session.error",
        "session.compacted",
        "session.ended"
      ];

      if (activityTypes.includes(event?.type)) {
        const s = getSession(sid);
        clearTimer(sid);
        s.timer = setTimeout(() => {
          recover(sid);
        }, config.stallTimeoutMs);
      } else if (staleTypes.includes(event?.type)) {
        resetSession(sid);
      }
    }
  };
};