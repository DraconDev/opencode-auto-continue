import type { Plugin } from "@opencode-ai/plugin";

interface SessionState {
  timer: ReturnType<typeof setTimeout> | null;
}

const STALL_TIMEOUT = 30000;
const WAIT_AFTER_ABORT = 1500;

export const AutoForceResumePlugin: Plugin = async (input, options) => {
  console.log("[force-resume] PLUGIN LOADED");
  console.log("[force-resume] Options:", options);

  const sessions = new Map<string, SessionState>();

  function getSession(id: string): SessionState {
    if (!sessions.has(id)) {
      sessions.set(id, { timer: null });
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
    console.log("[force-resume] Reset session:", id);
    clearTimer(id);
    sessions.delete(id);
  }

  async function recover(sessionId: string) {
    console.log("[force-resume] RECOVERY for:", sessionId);

    // Step 1: abort
    console.log("[force-resume] Calling abort()...");
    try {
      const result = await (input.client.session as any).abort({ path: { id: sessionId } });
      console.log("[force-resume] abort result:", JSON.stringify(result));
    } catch (e: any) {
      console.error("[force-resume] abort failed:", e?.message);
    }

    // Step 2: wait
    await new Promise(r => setTimeout(r, WAIT_AFTER_ABORT));

    // Step 3: continue
    console.log("[force-resume] Sending continue...");
    try {
      const result = await input.client.session.prompt({
        body: { parts: [{ type: "text", text: "continue" }], noReply: true },
        path: { id: sessionId }
      });
      console.log("[force-resume] continue result:", JSON.stringify(result));
    } catch (e: any) {
      console.error("[force-resume] continue failed:", e?.message);
    }
  }

  return {
    event: async ({ event }: { event: any }) => {
      const e = event as any;
      const sid = e?.properties?.sessionID || e?.properties?.info?.sessionID || e?.properties?.part?.sessionID || "default";

      console.log("[force-resume] EVENT:", event?.type, "session:", sid);

      // Activity events reset timer
      const activityTypes = [
        "message.part.updated",
        "message.part.added",
        "message.updated",
        "message.created",
        "step.finish",
        "session.status"
      ];

      // Stale events clear session
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
          console.log("[force-resume] STALL TIMER FIRED for:", sid);
          recover(sid);
        }, STALL_TIMEOUT);
      } else if (staleTypes.includes(event?.type)) {
        resetSession(sid);
      }
    }
  };
};