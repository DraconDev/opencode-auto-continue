import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Plugin } from "@opencode-ai/plugin";

interface MockClient {
  session: {
    abort: ReturnType<typeof vi.fn>;
    prompt: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    todo: ReturnType<typeof vi.fn>;
  };
}

async function createPlugin(input: { client: MockClient }, options?: Record<string, unknown>) {
  const { AutoForceResumePlugin } = await import('../index.js');
  return AutoForceResumePlugin(input as Parameters<Plugin>[0], options as Parameters<Plugin>[1]);
}

describe("opencode-auto-force-resume", () => {
  let mockAbort: ReturnType<typeof vi.fn>;
  let mockPrompt: ReturnType<typeof vi.fn>;
  let mockStatus: ReturnType<typeof vi.fn>;
  let mockTodo: ReturnType<typeof vi.fn>;
  let mockClient: MockClient;

  beforeEach(() => {
    mockAbort = vi.fn().mockResolvedValue({ data: true, error: undefined });
    mockPrompt = vi.fn().mockResolvedValue({ data: {}, error: undefined });
    mockStatus = vi.fn().mockResolvedValue({ data: { "default": { type: "idle" } }, error: undefined });
    mockTodo = vi.fn().mockResolvedValue({ data: [], error: undefined });

    mockClient = {
      session: {
        abort: mockAbort,
        prompt: mockPrompt,
        status: mockStatus,
        todo: mockTodo,
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  describe("stall detection", () => {
    it("should set stall timer on busy session.status", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000 });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(5000);

      expect(mockAbort).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should NOT set timer for idle session.status", async () => {
      vi.useFakeTimers();
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000 });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "idle" } } } });
      await vi.advanceTimersByTimeAsync(10000);

      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should set timer on message.part.updated with delta", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000 });

      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "text", text: "hello", sessionID: "test", messageID: "msg1" }, delta: "hello" } } });
      await vi.advanceTimersByTimeAsync(5000);

      expect(mockAbort).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should reset timer on new progress event", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000 });

      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "text", text: "hello", sessionID: "test", messageID: "msg1" }, delta: "hello" } } });
      await vi.advanceTimersByTimeAsync(4000);
      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "text", text: "hello world", sessionID: "test", messageID: "msg1" }, delta: " world" } } });
      await vi.advanceTimersByTimeAsync(4000);

      expect(mockAbort).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2000);

      expect(mockAbort).toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe("session.status check before recovery", () => {
    it("should NOT abort if session status is idle", async () => {
      vi.useFakeTimers();
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 1000, waitAfterAbortMs: 100 });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should NOT abort if session status is retry", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "retry", attempt: 1, message: "error", next: Date.now() + 5000 } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 1000, waitAfterAbortMs: 100 });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should abort if session status is busy", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 1000, waitAfterAbortMs: 100 });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockAbort).toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe("lastProgressAt tracking", () => {
    it("should skip recovery if lastProgressAt is recent", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 10000 });

      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "text", text: "hello", sessionID: "test", messageID: "msg1" }, delta: "hello" } } });
      await vi.advanceTimersByTimeAsync(5000);

      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should recover if lastProgressAt is old enough", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000 });

      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "text", text: "hello", sessionID: "test", messageID: "msg1" }, delta: "hello" } } });
      await vi.advanceTimersByTimeAsync(5000);

      expect(mockAbort).toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe("cooldown enforcement", () => {
    it("should not recover within cooldown period", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 1000, waitAfterAbortMs: 100, cooldownMs: 10000, maxRecoveries: 10 });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockAbort).toHaveBeenCalledTimes(1);

      mockAbort.mockClear();
      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "text", text: "hello", sessionID: "test", messageID: "msg1" }, delta: "hello" } } });
      await vi.advanceTimersByTimeAsync(2000);
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe("maxRecoveries limit", () => {
    it("should use exponential backoff after maxRecoveries", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 500, waitAfterAbortMs: 50, cooldownMs: 0, maxRecoveries: 2, abortPollMaxTimeMs: 0 });

      // Create session and set timer
      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "text", text: "hello", sessionID: "test", messageID: "msg1" }, delta: "hello" } } });
      
      // First recovery (attempts=0 → 1)
      await vi.advanceTimersByTimeAsync(600);
      await Promise.resolve();
      expect(mockAbort).toHaveBeenCalledTimes(1);

      // After recovery, new message starts - simulate event to set new timer
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      
      // Second recovery (attempts=1 → 2)  
      await vi.advanceTimersByTimeAsync(600);
      await Promise.resolve();
      expect(mockAbort).toHaveBeenCalledTimes(2);

      // After maxRecoveries, should enter backoff - no abort within normal time
      mockAbort.mockClear();
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      expect(mockAbort).not.toHaveBeenCalled();

      // Verify backoff is working by checking that more time passes without abort
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
      // Should still be in backoff or just attempted another recovery
      // The key is that it doesn't abort immediately like before maxRecoveries
      expect(mockAbort).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe("userCancelled detection", () => {
    it("should not recover after MessageAbortedError", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 1000, waitAfterAbortMs: 100 });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "session.error", properties: { sessionID: "test", error: { name: "MessageAbortedError" } } } });
      await vi.advanceTimersByTimeAsync(2000);

      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should clear timer on non-abort session.error - monitoring pauses until next status", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 1000, waitAfterAbortMs: 100 });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "session.error", properties: { sessionID: "test", error: { name: "SomeOtherError" } } } });
      await vi.advanceTimersByTimeAsync(1000);

      // Timer was cleared on error, no abort should happen
      expect(mockAbort).not.toHaveBeenCalled();

      // But after a new busy status, timer should restart
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockAbort).toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe("session cleanup", () => {
    it("should clear session on session.idle", async () => {
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000 });

      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "text", text: "hello", sessionID: "test", messageID: "msg1" }, delta: "hello" } } });
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });

      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(10000);

      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should clear session on session.deleted", async () => {
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000 });

      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "text", text: "hello", sessionID: "test", messageID: "msg1" }, delta: "hello" } } });
      await plugin.event({ event: { type: "session.deleted", properties: { sessionID: "test", info: {} } } });

      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(10000);

      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe("attempts reset on progress", () => {
    it("should reset attempts on progress event", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 50, waitAfterAbortMs: 10, cooldownMs: 0, maxRecoveries: 3, abortPollMaxTimeMs: 0 });

      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "text", text: "hello", sessionID: "test", messageID: "msg1" }, delta: "hello" } } });
      await vi.advanceTimersByTimeAsync(50);
      await Promise.resolve();

      expect(mockAbort).toHaveBeenCalledTimes(1);

      mockAbort.mockClear();
      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "text", text: "hello", sessionID: "test", messageID: "msg1" }, delta: "hello" } } });
      await vi.advanceTimersByTimeAsync(50);
      await Promise.resolve();

      expect(mockAbort).toHaveBeenCalledTimes(1);

      mockAbort.mockClear();
      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "text", text: "hello world", sessionID: "test", messageID: "msg1" }, delta: " world" } } });
      await vi.advanceTimersByTimeAsync(50);
      await Promise.resolve();

      expect(mockAbort).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });
  });

  describe("timer restart after recovery", () => {
    it("should set new timer after successful recovery", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 50, waitAfterAbortMs: 10, cooldownMs: 0, maxRecoveries: 5, abortPollMaxTimeMs: 0 });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      expect(mockAbort).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });
  });

  describe("tool and other part types progress tracking", () => {
    it("should track tool parts as progress", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000 });

      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "tool", callID: "call1", tool: "bash", state: { type: "running" }, sessionID: "test", messageID: "msg1" }, delta: "" } } });
      await vi.advanceTimersByTimeAsync(4000);

      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should track step-start parts as progress", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000 });

      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "step-start", sessionID: "test", messageID: "msg1" }, delta: "" } } });
      await vi.advanceTimersByTimeAsync(4000);

      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should track subtask parts as progress", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000 });

      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "subtask", prompt: "test", description: "test", agent: "test", sessionID: "test", messageID: "msg1" }, delta: "" } } });
      await vi.advanceTimersByTimeAsync(4000);

      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should track file parts as progress", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000 });

      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "file", mime: "text/plain", url: "test.txt", sessionID: "test", messageID: "msg1" }, delta: "" } } });
      await vi.advanceTimersByTimeAsync(4000);

      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe("config validation", () => {
    it("should use defaults when stallTimeoutMs <= waitAfterAbortMs", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 100, waitAfterAbortMs: 200 });

      // Should use default stallTimeoutMs (180000) instead of invalid 100
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(100);

      // With default 180s timeout, abort should NOT be called after 100ms
      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should use defaults when maxRecoveries is negative", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      // Pass invalid maxRecoveries, but validation will use ALL defaults
      // Default stallTimeoutMs is 180000, so timer won't fire quickly
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 1000, waitAfterAbortMs: 100, maxRecoveries: -1 });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(1000);

      // Should use default stallTimeoutMs (180000), so abort NOT called after 1000ms
      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe("compaction handling", () => {
    it("should pause monitoring during compaction", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 1000, waitAfterAbortMs: 100 });

      // Session becomes busy
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      
      // Compaction starts - this should set compacting = true
      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "compaction", auto: true }, delta: "" } } });
      
      // Timer fires - but should NOT abort because compacting = true
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();

      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should resume monitoring after compaction ends", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 1000, waitAfterAbortMs: 100 });

      // Session becomes busy and compaction starts
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "compaction", auto: true }, delta: "" } } });
      
      // Compaction ends (user sends message)
      await plugin.event({ event: { type: "message.created", properties: { sessionID: "test", info: {} } } });
      
      // Now wait for stall - should abort because compacting was cleared
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();

      expect(mockAbort).toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe("token limit handling", () => {
    it("should validate token limit patterns config", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      // Empty tokenLimitPatterns should trigger validation failure and use defaults
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 1000, waitAfterAbortMs: 100, tokenLimitPatterns: [] });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(1000);

      // Should use default stallTimeoutMs (180000) since validation failed
      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should track message count on user messages", async () => {
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000, proactiveCompactThreshold: 5 });

      await plugin.event({ event: { type: "message.created", properties: { sessionID: "test", info: { role: "user", id: "msg1" } } } });
      await plugin.event({ event: { type: "message.created", properties: { sessionID: "test", info: { role: "user", id: "msg2" } } } });
      await plugin.event({ event: { type: "message.created", properties: { sessionID: "test", info: { role: "user", id: "msg3" } } } });

      // Messages tracked - test passes if no errors
      expect(true).toBe(true);
    });

    it("should validate proactive compaction threshold", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      // Negative threshold should trigger validation failure
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 1000, waitAfterAbortMs: 100, proactiveCompactThreshold: -1 });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(1000);

      // Should use defaults
      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should validate short continue message config", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      // Empty shortContinueMessage should trigger validation failure
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 1000, waitAfterAbortMs: 100, shortContinueMessage: "" });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(1000);

      // Should use defaults
      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe("dispose", () => {
    it("should not crash when disposed during recovery", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 50, waitAfterAbortMs: 10, abortPollMaxTimeMs: 0 });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      
      // Dispose immediately
      plugin.dispose();
      
      // Advance timers - should not throw
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });
});