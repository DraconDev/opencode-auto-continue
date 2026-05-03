import { vi, describe, it, expect, beforeEach } from 'vitest';

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

interface SessionState {
  stallTimer: ReturnType<typeof setTimeout> | null;
  attempts: number;
  lastRecoveryTime: number;
  recoveryInProgress: boolean;
}

interface PluginConfig {
  stallTimeoutMs: number;
  cancelWaitMs: number;
  maxRecoveries: number;
  cooldownMs: number;
  enableCompressionFallback: boolean;
}

const DEFAULT_CONFIG = {
  stallTimeoutMs: 180000,
  cancelWaitMs: 1500,
  maxRecoveries: 10,
  cooldownMs: 300000,
  enableCompressionFallback: true,
};

interface MockClient {
  session: {
    prompt: (opts: { body: { parts: Array<{ type: string; text: string }>; noReply: boolean }; path: { id: string } }) => Promise<{ data?: unknown; error?: unknown }>;
  };
}

function createAutoForceResumePlugin(input: { client: MockClient }, options?: Partial<PluginConfig>) {
  const config: PluginConfig = {
    ...DEFAULT_CONFIG,
    ...(typeof options === "object" && options !== null ? options : {}),
  };

  const sessions = new Map<string, SessionState>();
  let promptCalls: Array<{ text: string; noReply: boolean; sessionId: string }> = [];

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

  const sendPrompt = async (sessionId: string, text: string, noReply = true): Promise<boolean> => {
    try {
      promptCalls.push({ text, noReply, sessionId });
      const result = await input.client.session.prompt({
        body: {
          parts: [{ type: "text", text }],
          noReply,
        },
        path: { id: sessionId },
      });
      if ("error" in result && result.error) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  const compressAndResume = async (sessionId: string): Promise<boolean> => {
    const sent = await sendPrompt(sessionId, "/compact", true);
    if (sent) {
      await new Promise((r) => setTimeout(r, 2000));
      const resumed = await sendPrompt(sessionId, "continue", true);
      return resumed;
    }
    return false;
  };

  const performRecovery = async (sessionId: string): Promise<void> => {
    const state = getOrCreateSession(sessionId);
    const now = Date.now();

    if (state.recoveryInProgress) {
      return;
    }

    if (state.attempts >= config.maxRecoveries) {
      return;
    }

    if (now - state.lastRecoveryTime < config.cooldownMs && state.attempts > 0) {
      return;
    }

    state.recoveryInProgress = true;
    state.attempts++;
    state.lastRecoveryTime = now;

    const cancelSent = await sendPrompt(sessionId, "cancel", true);
    if (!cancelSent) {
      state.recoveryInProgress = false;
      return;
    }

    await new Promise((r) => setTimeout(r, config.cancelWaitMs));

    const continueSent = await sendPrompt(sessionId, "continue", true);
    state.recoveryInProgress = false;

    if (!continueSent && config.enableCompressionFallback) {
      await compressAndResume(sessionId);
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
    event: async ({ event }: { event: { type: string; properties?: { sessionID?: string } } }) => {
      const sessionId = event.properties?.sessionID || "default";

      if (ACTIVITY_EVENTS.includes(event.type as typeof ACTIVITY_EVENTS[number])) {
        handleActivity(sessionId);
      } else if (STALE_EVENTS.includes(event.type as typeof STALE_EVENTS[number])) {
        resetSession(sessionId);
      }
    },
    getSession: (sessionId: string) => sessions.get(sessionId),
    getPromptCalls: () => promptCalls,
    resetPromptCalls: () => { promptCalls = []; },
  };
}

describe("opencode-auto-force-resume", () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = {
      session: {
        prompt: async () => ({ data: {} }),
      },
    };
  });

  describe("stall detection", () => {
    it("should create session with stall timer on activity event", () => {
      const plugin = createAutoForceResumePlugin({ client: mockClient }, { stallTimeoutMs: 1000 });

      plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });

      const session = plugin.getSession("test-session");
      expect(session).toBeDefined();
      expect(session!.stallTimer).not.toBeNull();
    });

    it("should reset stall timer on new activity", () => {
      const plugin = createAutoForceResumePlugin({ client: mockClient }, { stallTimeoutMs: 5000 });

      plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });
      const firstTimer = plugin.getSession("test-session")!.stallTimer;

      plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });
      const secondTimer = plugin.getSession("test-session")!.stallTimer;

      expect(firstTimer).not.toBe(secondTimer);
    });

    it("should not start timer for stale events", () => {
      const plugin = createAutoForceResumePlugin({ client: mockClient }, { stallTimeoutMs: 1000 });

      plugin.event({ event: { type: "session.idle", properties: { sessionID: "test-session" } } });

      const session = plugin.getSession("test-session");
      expect(session).toBeUndefined();
    });
  });

  describe("recovery flow", () => {
    it("should send cancel when stall timer fires", async () => {
      vi.useFakeTimers();
      const plugin = createAutoForceResumePlugin({ client: mockClient }, { stallTimeoutMs: 1000, cancelWaitMs: 100 });

      plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });
      await vi.advanceTimersByTimeAsync(1000);

      const calls = plugin.getPromptCalls();
      expect(calls.some((c) => c.text === "cancel")).toBe(true);
      vi.useRealTimers();
    });

    it("should send continue after cancel", async () => {
      vi.useFakeTimers();
      const plugin = createAutoForceResumePlugin({ client: mockClient }, { stallTimeoutMs: 1000, cancelWaitMs: 100 });

      plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });
      await vi.advanceTimersByTimeAsync(1500);

      const calls = plugin.getPromptCalls();
      expect(calls.some((c) => c.text === "continue")).toBe(true);
      vi.useRealTimers();
    });

    it("should send cancel before continue in order", async () => {
      vi.useFakeTimers();
      const plugin = createAutoForceResumePlugin({ client: mockClient }, { stallTimeoutMs: 1000, cancelWaitMs: 100 });

      plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });
      await vi.advanceTimersByTimeAsync(1500);

      const calls = plugin.getPromptCalls();
      const cancelIdx = calls.findIndex((c) => c.text === "cancel");
      const continueIdx = calls.findIndex((c) => c.text === "continue");
      expect(cancelIdx).toBeLessThan(continueIdx);
      vi.useRealTimers();
    });
  });

  describe("compression fallback", () => {
    it("should trigger /compact when continue fails and fallback enabled", async () => {
      let callCount = 0;
      const failingClient = {
        session: {
          prompt: async () => {
            callCount++;
            if (callCount === 2) return { error: "failed" };
            return { data: {} };
          },
        },
      };

      vi.useFakeTimers();
      const plugin = createAutoForceResumePlugin({ client: failingClient }, { stallTimeoutMs: 1000, cancelWaitMs: 100 });

      plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });
      await vi.advanceTimersByTimeAsync(5000);

      const calls = plugin.getPromptCalls();
      expect(calls.some((c) => c.text === "/compact")).toBe(true);
      vi.useRealTimers();
    });

    it("should not trigger /compact when fallback is disabled", async () => {
      let callCount = 0;
      const failingClient = {
        session: {
          prompt: async () => {
            callCount++;
            if (callCount === 2) return { error: "failed" };
            return { data: {} };
          },
        },
      };

      vi.useFakeTimers();
      const plugin = createAutoForceResumePlugin({ client: failingClient }, { stallTimeoutMs: 1000, cancelWaitMs: 100, enableCompressionFallback: false });

      plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });
      await vi.advanceTimersByTimeAsync(5000);

      const calls = plugin.getPromptCalls();
      expect(calls.some((c) => c.text === "/compact")).toBe(false);
      vi.useRealTimers();
    });
  });

  describe("cooldown and max recoveries", () => {
    it("should block recovery within cooldown period", async () => {
      vi.useFakeTimers();
      const plugin = createAutoForceResumePlugin({ client: mockClient }, { stallTimeoutMs: 1000, cooldownMs: 10000, maxRecoveries: 10 });

      plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });
      await vi.advanceTimersByTimeAsync(1000);

      const firstCancelCalls = plugin.getPromptCalls().filter((c) => c.text === "cancel");
      expect(firstCancelCalls.length).toBe(1);

      plugin.resetPromptCalls();

      plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });
      await vi.advanceTimersByTimeAsync(1000);

      const secondCancelCalls = plugin.getPromptCalls().filter((c) => c.text === "cancel");
      expect(secondCancelCalls.length).toBe(0);
      vi.useRealTimers();
    });

    it("should respect maxRecoveries limit", async () => {
      vi.useFakeTimers();
      const plugin = createAutoForceResumePlugin({ client: mockClient }, { stallTimeoutMs: 500, cooldownMs: 0, maxRecoveries: 3 });

      for (let i = 0; i < 10; i++) {
        plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });
        await vi.advanceTimersByTimeAsync(500);
        plugin.resetPromptCalls();
      }

      const session = plugin.getSession("test-session");
      expect(session!.attempts).toBeLessThanOrEqual(3);
      vi.useRealTimers();
    });
  });

  describe("session cleanup", () => {
    it("should clear session on session.idle", () => {
      const plugin = createAutoForceResumePlugin({ client: mockClient });

      plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });
      expect(plugin.getSession("test-session")).toBeDefined();

      plugin.event({ event: { type: "session.idle", properties: { sessionID: "test-session" } } });
      expect(plugin.getSession("test-session")).toBeUndefined();
    });

    it("should clear session on session.error", () => {
      const plugin = createAutoForceResumePlugin({ client: mockClient });

      plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });
      expect(plugin.getSession("test-session")).toBeDefined();

      plugin.event({ event: { type: "session.error", properties: { sessionID: "test-session" } } });
      expect(plugin.getSession("test-session")).toBeUndefined();
    });

    it("should clear session on session.compacted", () => {
      const plugin = createAutoForceResumePlugin({ client: mockClient });

      plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });
      expect(plugin.getSession("test-session")).toBeDefined();

      plugin.event({ event: { type: "session.compacted", properties: { sessionID: "test-session" } } });
      expect(plugin.getSession("test-session")).toBeUndefined();
    });

    it("should clear session on session.ended", () => {
      const plugin = createAutoForceResumePlugin({ client: mockClient });

      plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });
      expect(plugin.getSession("test-session")).toBeDefined();

      plugin.event({ event: { type: "session.ended", properties: { sessionID: "test-session" } } });
      expect(plugin.getSession("test-session")).toBeUndefined();
    });
  });

  describe("activity event types", () => {
    const eventTypes = [
      "message.part.updated",
      "message.part.added",
      "message.updated",
      "message.created",
      "step.finish",
      "session.status",
    ];

    eventTypes.forEach((eventType) => {
      it(`should handle ${eventType} as activity`, () => {
        const plugin = createAutoForceResumePlugin({ client: mockClient }, { stallTimeoutMs: 1000 });

        plugin.event({ event: { type: eventType as typeof ACTIVITY_EVENTS[number], properties: { sessionID: "test-session" } } });
        expect(plugin.getSession("test-session")).toBeDefined();
        expect(plugin.getSession("test-session")!.stallTimer).not.toBeNull();
      });
    });
  });

  describe("stale event types", () => {
    const eventTypes = [
      "session.idle",
      "session.error",
      "session.compacted",
      "session.ended",
    ];

    eventTypes.forEach((eventType) => {
      it(`should handle ${eventType} as stale`, () => {
        const plugin = createAutoForceResumePlugin({ client: mockClient }, { stallTimeoutMs: 1000 });

        plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });
        expect(plugin.getSession("test-session")).toBeDefined();

        plugin.event({ event: { type: eventType as typeof STALE_EVENTS[number], properties: { sessionID: "test-session" } } });
        expect(plugin.getSession("test-session")).toBeUndefined();
      });
    });
  });
});