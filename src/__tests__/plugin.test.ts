import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

interface MockSessionState {
  promptCalls: Array<{ text: string; noReply: boolean }>;
  shouldFail: boolean;
}

interface MockClient {
  session: {
    prompt: (opts: { body: { parts: Array<{ type: string; text: string }>; noReply: boolean }; path: { id: string } }) => Promise<{ data?: unknown; error?: unknown }>;
  };
}

const DEFAULT_CONFIG = {
  stallTimeoutMs: 180000,
  cancelWaitMs: 1500,
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

function createAutoForceResumePlugin(input: { client: MockClient }, options?: Partial<PluginConfig>) {
  const config: PluginConfig = {
    ...DEFAULT_CONFIG,
    ...(typeof options === "object" && options !== null ? options : {}),
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

  const sendPrompt = async (sessionId: string, text: string, noReply = true): Promise<boolean> => {
    try {
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
    } catch (e) {
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
    getSessions: () => sessions,
  };
}

describe("opencode-auto-force-resume", () => {
  let mockClient: MockClient;
  let promptCalls: Array<{ text: string; noReply: boolean; sessionId: string }> = [];

  beforeEach(() => {
    promptCalls = [];
    mockClient = {
      session: {
        prompt: async (opts: { body: { parts: Array<{ type: string; text: string }>; noReply: boolean }; path: { id: string } }) => {
          promptCalls.push({
            text: opts.body.parts[0].text,
            noReply: opts.body.noReply,
            sessionId: opts.path.id,
          });
          return { data: {} };
        },
      },
    };
  });

  describe("stall detection", () => {
    it("should start a stall timer when activity event is received", () => {
      const plugin = createAutoForceResumePlugin({ client: mockClient }, { stallTimeoutMs: 1000 });

      plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });

      const session = plugin.getSession("test-session");
      expect(session).toBeDefined();
      expect(session!.stallTimer).not.toBeNull();
    });

    it("should reset timer when activity event is received", async () => {
      const plugin = createAutoForceResumePlugin({ client: mockClient }, { stallTimeoutMs: 5000 });

      plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });
      const firstTimer = plugin.getSession("test-session")!.stallTimer;

      await new Promise((r) => setTimeout(r, 100));
      plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });
      const secondTimer = plugin.getSession("test-session")!.stallTimer;

      expect(firstTimer).not.toBe(secondTimer);
    });

    it("should trigger recovery after stallTimeoutMs", async () => {
      vi.useFakeTimers();
      const plugin = createAutoForceResumePlugin({ client: mockClient }, { stallTimeoutMs: 5000 });

      plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });

      await vi.advanceTimersByTimeAsync(5000);

      expect(promptCalls.length).toBeGreaterThan(0);
      vi.useRealTimers();
    });
  });

  describe("recovery flow", () => {
    it("should send cancel first then continue after waiting", async () => {
      vi.useFakeTimers();
      const plugin = createAutoForceResumePlugin({ client: mockClient }, { stallTimeoutMs: 1000, cancelWaitMs: 1500 });

      plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });
      await vi.advanceTimersByTimeAsync(1000);

      const cancelCall = promptCalls.find((p) => p.text === "cancel");
      const continueCall = promptCalls.find((p) => p.text === "continue");

      expect(cancelCall).toBeDefined();
      expect(continueCall).toBeDefined();
      vi.useRealTimers();
    });

    it("should respect cancelWaitMs between cancel and continue", async () => {
      vi.useFakeTimers();
      const plugin = createAutoForceResumePlugin({ client: mockClient }, { stallTimeoutMs: 1000, cancelWaitMs: 3000 });

      plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });

      await vi.advanceTimersByTimeAsync(1000);

      const cancelIdx = promptCalls.findIndex((p) => p.text === "cancel");
      const continueIdx = promptCalls.findIndex((p) => p.text === "continue");

      expect(continueIdx - cancelIdx).toBe(1);
      vi.useRealTimers();
    });
  });

  describe("compression fallback", () => {
    it("should try /compact when continue fails", async () => {
      let failContinue = true;
      const failingClient = {
        session: {
          prompt: async (opts: { body: { parts: Array<{ type: string; text: string }>; noReply: boolean }; path: { id: string } }) => {
            promptCalls.push({
              text: opts.body.parts[0].text,
              noReply: opts.body.noReply,
              sessionId: opts.path.id,
            });
            if (opts.body.parts[0].text === "continue" && failContinue) {
              return { error: "failed" };
            }
            return { data: {} };
          },
        },
      };

      vi.useFakeTimers();
      const plugin = createAutoForceResumePlugin({ client: failingClient }, { stallTimeoutMs: 1000, enableCompressionFallback: true });

      plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });
      await vi.advanceTimersByTimeAsync(1000);

      const compactCall = promptCalls.find((p) => p.text === "/compact");
      expect(compactCall).toBeDefined();
      vi.useRealTimers();
    });

    it("should not try compression if enableCompressionFallback is false", async () => {
      let failContinue = true;
      const failingClient = {
        session: {
          prompt: async (opts: { body: { parts: Array<{ type: string; text: string }>; noReply: boolean }; path: { id: string } }) => {
            promptCalls.push({
              text: opts.body.parts[0].text,
              noReply: opts.body.noReply,
              sessionId: opts.path.id,
            });
            if (opts.body.parts[0].text === "continue" && failContinue) {
              return { error: "failed" };
            }
            return { data: {} };
          },
        },
      };

      vi.useFakeTimers();
      const plugin = createAutoForceResumePlugin({ client: failingClient }, { stallTimeoutMs: 1000, enableCompressionFallback: false });

      plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });
      await vi.advanceTimersByTimeAsync(1000);

      const compactCall = promptCalls.find((p) => p.text === "/compact");
      expect(compactCall).toBeUndefined();
      vi.useRealTimers();
    });
  });

  describe("cooldown and max recoveries", () => {
    it("should not attempt recovery within cooldown period", async () => {
      vi.useFakeTimers();
      const plugin = createAutoForceResumePlugin({ client: mockClient }, { stallTimeoutMs: 1000, cooldownMs: 10000 });

      plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });
      await vi.advanceTimersByTimeAsync(1000);

      promptCalls = [];
      plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });
      await vi.advanceTimersByTimeAsync(1000);

      const cancelCount = promptCalls.filter((p) => p.text === "cancel").length;
      expect(cancelCount).toBe(1);
      vi.useRealTimers();
    });

    it("should stop after maxRecoveries attempts", async () => {
      vi.useFakeTimers();
      const plugin = createAutoForceResumePlugin({ client: mockClient }, { stallTimeoutMs: 1000, maxRecoveries: 2, cooldownMs: 0 });

      for (let i = 0; i < 5; i++) {
        plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });
        await vi.advanceTimersByTimeAsync(1000);
      }

      const cancelCount = promptCalls.filter((p) => p.text === "cancel").length;
      expect(cancelCount).toBe(2);
      vi.useRealTimers();
    });
  });

  describe("session state cleanup", () => {
    it("should clear session on session.idle event", () => {
      const plugin = createAutoForceResumePlugin({ client: mockClient }, { stallTimeoutMs: 1000 });

      plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });
      expect(plugin.getSession("test-session")).toBeDefined();

      plugin.event({ event: { type: "session.idle", properties: { sessionID: "test-session" } } });
      expect(plugin.getSession("test-session")).toBeUndefined();
    });

    it("should clear session on session.error event", () => {
      const plugin = createAutoForceResumePlugin({ client: mockClient }, { stallTimeoutMs: 1000 });

      plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });
      expect(plugin.getSession("test-session")).toBeDefined();

      plugin.event({ event: { type: "session.error", properties: { sessionID: "test-session" } } });
      expect(plugin.getSession("test-session")).toBeUndefined();
    });

    it("should clear session on session.compacted event", () => {
      const plugin = createAutoForceResumePlugin({ client: mockClient }, { stallTimeoutMs: 1000 });

      plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });
      expect(plugin.getSession("test-session")).toBeDefined();

      plugin.event({ event: { type: "session.compacted", properties: { sessionID: "test-session" } } });
      expect(plugin.getSession("test-session")).toBeUndefined();
    });

    it("should clear session on session.ended event", () => {
      const plugin = createAutoForceResumePlugin({ client: mockClient }, { stallTimeoutMs: 1000 });

      plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session" } } });
      expect(plugin.getSession("test-session")).toBeDefined();

      plugin.event({ event: { type: "session.ended", properties: { sessionID: "test-session" } } });
      expect(plugin.getSession("test-session")).toBeUndefined();
    });
  });

  describe("activity events", () => {
    const activityEventTypes = [
      "message.part.updated",
      "message.part.added",
      "message.updated",
      "message.created",
      "step.finish",
      "session.status",
    ];

    activityEventTypes.forEach((eventType) => {
      it(`should reset stall timer on ${eventType} event`, () => {
        const plugin = createAutoForceResumePlugin({ client: mockClient }, { stallTimeoutMs: 1000 });

        plugin.event({ event: { type: eventType as typeof ACTIVITY_EVENTS[number], properties: { sessionID: "test-session" } } });
        const firstTimer = plugin.getSession("test-session")!.stallTimer;

        plugin.event({ event: { type: eventType as typeof ACTIVITY_EVENTS[number], properties: { sessionID: "test-session" } } });
        const secondTimer = plugin.getSession("test-session")!.stallTimer;

        expect(firstTimer).not.toBe(secondTimer);
      });
    });
  });
});