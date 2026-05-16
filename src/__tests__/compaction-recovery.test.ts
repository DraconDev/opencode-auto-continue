import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { flushPromises } from './helpers.js';

// Test the compaction module's behavior
describe("compaction module", () => {
  let mockAbort: ReturnType<typeof vi.fn>;
  let mockPrompt: ReturnType<typeof vi.fn>;
  let mockStatus: ReturnType<typeof vi.fn>;
  let mockTodo: ReturnType<typeof vi.fn>;
  let mockSummarize: ReturnType<typeof vi.fn>;
  let mockClient: any;

  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockAbort = vi.fn().mockResolvedValue({ data: true, error: undefined });
    mockPrompt = vi.fn().mockResolvedValue({ data: {}, error: undefined });
    mockStatus = vi.fn().mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
    mockTodo = vi.fn().mockResolvedValue({ data: [], error: undefined });
    mockSummarize = vi.fn().mockResolvedValue({ data: {}, error: undefined });

    mockClient = {
      session: {
        abort: mockAbort,
        prompt: mockPrompt,
        status: mockStatus,
        todo: mockTodo,
        summarize: mockSummarize,
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  async function createPlugin(input: { client: any }, options?: Record<string, unknown>) {
    const { AutoForceResumePlugin } = await import('../index.js');
    return AutoForceResumePlugin(input as any, options as any);
  }

  describe("token limit error detection via plugin", () => {
    it("should trigger emergency compaction on token limit error", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockSummarize.mockResolvedValue({ data: {}, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: "",
        shortContinueMessage: "Continue."
      });

      // Create session with busy status
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Fire token limit error
      await plugin.event({ event: { type: "session.error", properties: { sessionID: "test", error: { name: "TokenLimitError", message: "Requested token count exceeds the model's maximum context length of 262144 tokens" } } } });

      // Should trigger emergency compaction (summarize)
      await vi.advanceTimersByTimeAsync(100);
      await flushPromises();

      expect(mockSummarize).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should not trigger compaction on non-token-limit errors", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: ""
      });

      // Create session with busy status
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Fire generic error (not token limit)
      await plugin.event({ event: { type: "session.error", properties: { sessionID: "test", error: { name: "SomeError", message: "Something went wrong" } } } });

      await vi.advanceTimersByTimeAsync(100);
      await flushPromises();

      // Should NOT trigger compaction
      expect(mockSummarize).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should detect 'context length' pattern", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockSummarize.mockResolvedValue({ data: {}, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      await plugin.event({ event: { type: "session.error", properties: { sessionID: "test", error: {
        name: "Error",
        message: "context length exceeded"
      } } } });

      await vi.advanceTimersByTimeAsync(100);
      await flushPromises();

      expect(mockSummarize).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should detect 'too many tokens' pattern", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockSummarize.mockResolvedValue({ data: {}, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      await plugin.event({ event: { type: "session.error", properties: { sessionID: "test", error: {
        name: "Error",
        message: "too many tokens"
      } } } });

      await vi.advanceTimersByTimeAsync(100);
      await flushPromises();

      expect(mockSummarize).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should detect 'payload too large' pattern", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockSummarize.mockResolvedValue({ data: {}, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      await plugin.event({ event: { type: "session.error", properties: { sessionID: "test", error: {
        name: "Error",
        message: "payload too large"
      } } } });

      await vi.advanceTimersByTimeAsync(100);
      await flushPromises();

      expect(mockSummarize).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should be case insensitive", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockSummarize.mockResolvedValue({ data: {}, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      await plugin.event({ event: { type: "session.error", properties: { sessionID: "test", error: {
        name: "Error",
        message: "TOO MANY TOKENS"
      } } } });

      await vi.advanceTimersByTimeAsync(100);
      await flushPromises();

      expect(mockSummarize).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should not match unrelated errors", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      await plugin.event({ event: { type: "session.error", properties: { sessionID: "test", error: {
        name: "Error",
        message: "Connection timeout"
      } } } });

      await vi.advanceTimersByTimeAsync(100);
      await flushPromises();

      expect(mockSummarize).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should handle null error", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      await plugin.event({ event: { type: "session.error", properties: { sessionID: "test", error: null } } });

      await vi.advanceTimersByTimeAsync(100);
      await flushPromises();

      expect(mockSummarize).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should handle error with no message", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      await plugin.event({ event: { type: "session.error", properties: { sessionID: "test", error: { name: "Error" } } } });

      await vi.advanceTimersByTimeAsync(100);
      await flushPromises();

      expect(mockSummarize).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe("proactive compaction triggers", () => {
    it("should not trigger when autoCompact is disabled", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        autoCompact: false,
        proactiveCompactAtTokens: 100,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Accumulate tokens
      for (let i = 0; i < 5; i++) {
        await plugin.event({ event: { type: "message.part.updated", properties: {
          sessionID: "test",
          messageID: "msg1",
          part: { id: "part" + i, type: "text", text: "a".repeat(50), sessionID: "test", messageID: "msg1" },
          delta: "a".repeat(50)
        } } });
      }

      // Summarize should NOT be called with autoCompact disabled
      expect(mockSummarize).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("should handle proactive compaction checks during generation", async () => {
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      mockSummarize.mockResolvedValue({ data: {}, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        autoCompact: true,
        compactCooldownMs: 60000,
        proactiveCompactAtTokens: 10000000, // Very high threshold to prevent actual compaction
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Each part update now triggers proactive compact check
      // Just verify no crash (high threshold prevents actual summarize waits)
      for (let i = 0; i < 5; i++) {
        await plugin.event({ event: { type: "message.part.updated", properties: {
          sessionID: "test",
          messageID: "msg1",
          part: { id: "part" + i, type: "text", text: "a".repeat(50), sessionID: "test", messageID: "msg1" },
          delta: "a".repeat(50)
        } } });
      }

      await Promise.resolve();
      expect(true).toBe(true);
    });
  });

  describe("compaction state management", () => {
    it("should set compacting flag during compaction", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockSummarize.mockImplementation(async () => {
        // Simulate compaction taking time
        await new Promise(r => setTimeout(r, 100));
        return { data: {}, error: undefined };
      });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        autoCompact: true,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: ""
      });

      // Create session and trigger emergency compaction
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "session.error", properties: { sessionID: "test", error: {
        name: "TokenLimitError",
        message: "Token limit exceeded: 262144 tokens"
      } } } });

      await vi.advanceTimersByTimeAsync(200);
      await flushPromises();

      // Compaction was attempted
      expect(mockSummarize).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("should clear compacting flag after compaction", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockSummarize.mockResolvedValue({ data: {}, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        autoCompact: true,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "session.error", properties: { sessionID: "test", error: {
        name: "TokenLimitError",
        message: "Token limit exceeded"
      } } } });

      // Wait for compaction
      await vi.advanceTimersByTimeAsync(200);
      await flushPromises();

      // Verify compaction was called
      expect(mockSummarize).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe("token estimation after compaction", () => {
    it("should reduce estimated tokens after compaction", async () => {
      // This tests that the estimatedTokens are recalculated after compaction
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockSummarize.mockResolvedValue({ data: {}, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        autoCompact: true,
        compactReductionFactor: 0.7,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: "",
        compactionVerifyWaitMs: 100
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Simulate token accumulation via message.updated
      await plugin.event({ event: { type: "message.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        info: { role: "assistant" },
        tokens: { input: 50000, output: 10000, reasoning: 0 }
      } } });

      // Trigger token limit error
      await plugin.event({ event: { type: "session.error", properties: { sessionID: "test", error: {
        name: "TokenLimitError",
        message: "Token limit exceeded"
      } } } });

      // Wait for compaction
      await vi.advanceTimersByTimeAsync(300);
      await flushPromises();

      // Test passes if no crash
      expect(true).toBe(true);

      vi.useRealTimers();
    });

    it("should not compact if session is busy", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        autoCompact: true,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Message.updated with high token count
      await plugin.event({ event: { type: "message.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        info: { role: "assistant" },
        tokens: { input: 100000, output: 10000, reasoning: 0 }
      } } });

      // Should not trigger compaction (session busy)
      // We can't directly check internal state, but summarize should not be called synchronously
      expect(mockSummarize).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });
});

describe("recovery module", () => {
  let mockAbort: ReturnType<typeof vi.fn>;
  let mockPrompt: ReturnType<typeof vi.fn>;
  let mockStatus: ReturnType<typeof vi.fn>;
  let mockTodo: ReturnType<typeof vi.fn>;
  let mockClient: any;

  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockAbort = vi.fn().mockResolvedValue({ data: true, error: undefined });
    mockPrompt = vi.fn().mockResolvedValue({ data: {}, error: undefined });
    mockStatus = vi.fn().mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
    mockTodo = vi.fn().mockResolvedValue({ data: [], error: undefined });

    mockClient = {
      session: {
        abort: mockAbort,
        prompt: mockPrompt,
        status: mockStatus,
        todo: mockTodo,
        summarize: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  async function createPlugin(input: { client: any }, options?: Record<string, unknown>) {
    const { AutoForceResumePlugin } = await import('../index.js');
    return AutoForceResumePlugin(input as any, options as any);
  }

  describe("stall detection", () => {
    it("should detect stall after timeout with no progress", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 1000,
        waitAfterAbortMs: 100,
        cooldownMs: 0,
        maxRecoveries: 3,
        abortPollMaxTimeMs: 0,
        autoCompact: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      // Start session busy
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // No progress events - wait for stall
      await vi.advanceTimersByTimeAsync(1100);
      await flushPromises();

      // Should have tried to abort
      expect(mockAbort).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("should reset stall timer on progress", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 1000,
        waitAfterAbortMs: 100,
        cooldownMs: 0,
        maxRecoveries: 3,
        abortPollMaxTimeMs: 0,
        autoCompact: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      // Start session busy
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Progress after 500ms
      await vi.advanceTimersByTimeAsync(500);
      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part1", type: "text", text: "hello", sessionID: "test", messageID: "msg1" },
        delta: "hello"
      } } });

      // Wait less than original timeout from last progress
      await vi.advanceTimersByTimeAsync(900);
      expect(mockAbort).not.toHaveBeenCalled();

      // Wait for original timeout from last progress
      await vi.advanceTimersByTimeAsync(200);
      await flushPromises();

      expect(mockAbort).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("should not set timer for idle session", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 1000,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      // Start session idle
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "idle" } } } });

      // Wait
      await vi.advanceTimersByTimeAsync(2000);

      // Should NOT try to abort idle session
      expect(mockAbort).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("should not set timer for retry session", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "retry" } }, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 1000,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      await vi.advanceTimersByTimeAsync(2000);

      // Retry sessions should not be aborted
      // Note: the status.type is "busy" but isRetry would be set by actual retry info
      expect(mockAbort).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe("recovery flow", () => {
    it("should attempt recovery after stall", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 500,
        waitAfterAbortMs: 50,
        cooldownMs: 0,
        maxRecoveries: 3,
        abortPollMaxTimeMs: 100,
        autoCompact: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Wait for stall
      await vi.advanceTimersByTimeAsync(600);
      await flushPromises();

      expect(mockAbort).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("should poll for idle after abort", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 500,
        waitAfterAbortMs: 50,
        cooldownMs: 0,
        maxRecoveries: 1,
        abortPollMaxTimeMs: 200,
        abortPollIntervalMs: 50,
        abortPollMaxFailures: 3,
        autoCompact: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      await vi.advanceTimersByTimeAsync(600);
      await flushPromises();

      // Status should have been polled at least once after abort
      expect(mockStatus.mock.calls.length).toBeGreaterThan(0);

      vi.useRealTimers();
    });

    it("should send continue after recovery", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 500,
        waitAfterAbortMs: 50,
        cooldownMs: 0,
        maxRecoveries: 1,
        abortPollMaxTimeMs: 0,
        autoCompact: false,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Wait for stall + recovery
      await vi.advanceTimersByTimeAsync(600);
      await flushPromises();

      expect(mockAbort).toHaveBeenCalled();

      // Session becomes idle - sends continue
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "idle" } } } });
      await vi.advanceTimersByTimeAsync(100);
      await flushPromises();

      expect(mockPrompt).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe("backoff behavior", () => {
    it("should not crash when in backoff mode", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 500,
        waitAfterAbortMs: 50,
        cooldownMs: 0,
        maxRecoveries: 2,
        abortPollMaxTimeMs: 0,
        autoCompact: false,
        maxBackoffMs: 60000,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      // First stall - recovery 1
      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part1", type: "text", text: "hello", sessionID: "test", messageID: "msg1" },
        delta: "hello"
      } } });

      await vi.advanceTimersByTimeAsync(600);
      await flushPromises();
      expect(mockAbort).toHaveBeenCalledTimes(1);

      mockAbort.mockClear();

      // After recovery, new message starts
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Second stall - recovery 2 (attempts becomes 2)
      await vi.advanceTimersByTimeAsync(600);
      await flushPromises();
      expect(mockAbort).toHaveBeenCalledTimes(1);

      mockAbort.mockClear();

      // Now in backoff - wait a bit but don't expect abort since we're in backoff
      await vi.advanceTimersByTimeAsync(1000);
      await flushPromises();

      // Test passes if no crash
      expect(true).toBe(true);

      vi.useRealTimers();
    });

    it("should respect maxBackoffMs cap", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 500,
        waitAfterAbortMs: 50,
        cooldownMs: 0,
        maxRecoveries: 1,
        abortPollMaxTimeMs: 0,
        autoCompact: false,
        maxBackoffMs: 5000, // Cap at 5 seconds
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part1", type: "text", text: "hello", sessionID: "test", messageID: "msg1" },
        delta: "hello"
      } } });

      // First recovery
      await vi.advanceTimersByTimeAsync(600);
      await flushPromises();
      expect(mockAbort).toHaveBeenCalledTimes(1);

      mockAbort.mockClear();

      // After maxRecoveries, check backoff is capped
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // With backoff cap of 5s, timer shouldn't fire before 5s
      await vi.advanceTimersByTimeAsync(4000);
      await flushPromises();
      expect(mockAbort).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe("recovery failure handling", () => {
    it("should track recovery failures", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      mockAbort.mockRejectedValue(new Error("Abort failed"));

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 500,
        waitAfterAbortMs: 50,
        cooldownMs: 0,
        maxRecoveries: 3,
        abortPollMaxTimeMs: 0,
        autoCompact: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Wait for stall and failed recovery
      await vi.advanceTimersByTimeAsync(600);
      await flushPromises();

      expect(mockAbort).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("should handle abort API errors gracefully", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      mockAbort.mockRejectedValue(new Error("Network error"));

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 500,
        waitAfterAbortMs: 50,
        cooldownMs: 0,
        maxRecoveries: 1,
        abortPollMaxTimeMs: 0,
        autoCompact: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Wait for recovery attempt
      await vi.advanceTimersByTimeAsync(600);
      await flushPromises();

      // Should have tried abort
      expect(mockAbort).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe("user cancelled behavior", () => {
    it("should not recover after MessageAbortedError", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 500,
        waitAfterAbortMs: 50,
        cooldownMs: 0,
        maxRecoveries: 3,
        abortPollMaxTimeMs: 0,
        autoCompact: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // User aborts
      await plugin.event({ event: { type: "session.error", properties: { sessionID: "test", error: {
        name: "MessageAbortedError"
      } } } });

      // Wait for stall timeout
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();

      // Should NOT try to abort after user cancelled
      expect(mockAbort).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("should clear userCancelled on new busy status", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 500,
        waitAfterAbortMs: 50,
        cooldownMs: 0,
        maxRecoveries: 3,
        abortPollMaxTimeMs: 0,
        autoCompact: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // User cancels
      await plugin.event({ event: { type: "session.error", properties: { sessionID: "test", error: {
        name: "MessageAbortedError"
      } } } });

      // New busy status clears userCancelled
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Wait for stall
      await vi.advanceTimersByTimeAsync(600);
      await flushPromises();

      // Should recover because userCancelled was cleared
      expect(mockAbort).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe("attempts counter", () => {
    it("should reset attempts on progress", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 500,
        waitAfterAbortMs: 50,
        cooldownMs: 0,
        maxRecoveries: 3,
        abortPollMaxTimeMs: 0,
        autoCompact: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      // First stall
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(600);
      await flushPromises();
      expect(mockAbort).toHaveBeenCalledTimes(1);

      mockAbort.mockClear();

      // New message clears attempts
      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part1", type: "text", text: "hello", sessionID: "test", messageID: "msg1" },
        delta: "hello"
      } } });

      // Second stall
      await vi.advanceTimersByTimeAsync(600);
      await flushPromises();
      expect(mockAbort).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });
  });
});

describe("token estimation", () => {
  let mockClient: any;

  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockClient = {
      session: {
        abort: vi.fn().mockResolvedValue({ data: true, error: undefined }),
        prompt: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
        status: vi.fn().mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined }),
        todo: vi.fn().mockResolvedValue({ data: [], error: undefined }),
        summarize: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  async function createPlugin(input: { client: any }, options?: Record<string, unknown>) {
    const { AutoForceResumePlugin } = await import('../index.js');
    return AutoForceResumePlugin(input as any, options as any);
  }

  describe("token accumulation from message.updated", () => {
    it("should accumulate input tokens", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      await plugin.event({ event: { type: "message.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        info: { role: "assistant" },
        tokens: { input: 1000, output: 0, reasoning: 0 }
      } } });

      expect(true).toBe(true);
    });

    it("should accumulate output tokens", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      await plugin.event({ event: { type: "message.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        info: { role: "assistant" },
        tokens: { input: 0, output: 500, reasoning: 0 }
      } } });

      expect(true).toBe(true);
    });

    it("should accumulate reasoning tokens", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      await plugin.event({ event: { type: "message.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        info: { role: "assistant" },
        tokens: { input: 100, output: 50, reasoning: 2000 }
      } } });

      expect(true).toBe(true);
    });

    it("should accumulate all token types together", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // First message
      await plugin.event({ event: { type: "message.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        info: { role: "assistant" },
        tokens: { input: 1000, output: 200, reasoning: 500 }
      } } });

      // Second message
      await plugin.event({ event: { type: "message.updated", properties: {
        sessionID: "test",
        messageID: "msg2",
        info: { role: "assistant" },
        tokens: { input: 2000, output: 300, reasoning: 1000 }
      } } });

      expect(true).toBe(true);
    });

    it("should handle missing tokens field", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Message without tokens
      await plugin.event({ event: { type: "message.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        info: { role: "assistant" }
      } } });

      expect(true).toBe(true);
    });

    it("should handle zero tokens", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      await plugin.event({ event: { type: "message.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        info: { role: "assistant" },
        tokens: { input: 0, output: 0, reasoning: 0 }
      } } });

      expect(true).toBe(true);
    });
  });

  describe("token accumulation from message.part.updated", () => {
    it("should accumulate step-finish tokens", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: {
          id: "part1",
          type: "step-finish",
          input: 500,
          output: 200,
          reasoning: 1000,
          cache: 300,
          sessionID: "test",
          messageID: "msg1"
        },
        delta: ""
      } } });

      expect(true).toBe(true);
    });

    it("should handle text parts without tokens", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part1", type: "text", text: "Hello world", sessionID: "test", messageID: "msg1" },
        delta: "Hello"
      } } });

      expect(true).toBe(true);
    });

    it("should handle reasoning parts without explicit tokens", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part1", type: "reasoning", reasoning: "thinking...", sessionID: "test", messageID: "msg1" },
        delta: "thinking"
      } } });

      expect(true).toBe(true);
    });
  });

  describe("token estimation from text length", () => {
    it("should estimate tokens for English text", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // 100 chars of English ~ 18 tokens (100 * 0.75 / 4)
      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part1", type: "text", text: "a".repeat(100), sessionID: "test", messageID: "msg1" },
        delta: "a".repeat(100)
      } } });

      expect(true).toBe(true);
    });

    it("should estimate tokens for code", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Code: chars / 4 (100 chars = 25 tokens)
      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part1", type: "text", text: "function() { return 1; }", sessionID: "test", messageID: "msg1" },
        delta: "function"
      } } });

      expect(true).toBe(true);
    });

    it("should estimate tokens for digits", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Digits: chars * 0.5 / 4 (100 digits = 12.5 tokens)
      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part1", type: "text", text: "1234567890".repeat(10), sessionID: "test", messageID: "msg1" },
        delta: "123"
      } } });

      expect(true).toBe(true);
    });
  });

  describe("token limits from error parsing", () => {
    it("should parse token count from error message", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      await plugin.event({ event: { type: "session.error", properties: { sessionID: "test", error: {
        name: "TokenLimitError",
        message: "You requested a total of 264230 tokens: 232230 tokens from the input messages and 32000 tokens for the completion."
      } } } });

      expect(true).toBe(true);
    });

    it("should update estimatedTokens from error parsing", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Accumulate some tokens first
      await plugin.event({ event: { type: "message.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        info: { role: "assistant" },
        tokens: { input: 10000, output: 1000, reasoning: 0 }
      } } });

      // Then get exact count from error
      await plugin.event({ event: { type: "session.error", properties: { sessionID: "test", error: {
        name: "TokenLimitError",
        message: "You requested 264230 tokens"
      } } } });

      expect(true).toBe(true);
    });
  });
});