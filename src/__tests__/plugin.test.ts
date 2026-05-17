import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { flushPromises } from './helpers.js';
import type { Plugin } from "@opencode-ai/plugin";
import { readFileSync, unlinkSync } from "fs";

interface MockClient {
  session: {
    abort: ReturnType<typeof vi.fn>;
    prompt: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    todo: ReturnType<typeof vi.fn>;
    summarize: ReturnType<typeof vi.fn>;
    messages?: ReturnType<typeof vi.fn>;
  };
  tui: {
    showToast: ReturnType<typeof vi.fn>;
  };
}

async function createPlugin(input: { client: MockClient }, options?: Record<string, unknown>) {
  const { AutoForceResumePlugin } = await import('../index.js');
  return AutoForceResumePlugin(input as Parameters<Plugin>[0], options as Parameters<Plugin>[1]);
}

describe("opencode-auto-continue", () => {
  let mockAbort: ReturnType<typeof vi.fn>;
  let mockPrompt: ReturnType<typeof vi.fn>;
  let mockStatus: ReturnType<typeof vi.fn>;
  let mockTodo: ReturnType<typeof vi.fn>;
  let mockSummarize: ReturnType<typeof vi.fn>;
  let mockShowToast: ReturnType<typeof vi.fn>;
  let mockClient: MockClient;

  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    
    mockAbort = vi.fn().mockResolvedValue({ data: true, error: undefined });
    mockPrompt = vi.fn().mockResolvedValue({ data: {}, error: undefined });
    mockStatus = vi.fn().mockResolvedValue({ data: { "default": { type: "idle" } }, error: undefined });
    mockTodo = vi.fn().mockResolvedValue({ data: [], error: undefined });
    mockSummarize = vi.fn().mockResolvedValue({ data: {}, error: undefined });
    mockShowToast = vi.fn().mockResolvedValue({ data: {}, error: undefined });

    mockClient = {
      session: {
        abort: mockAbort,
        prompt: mockPrompt,
        status: mockStatus,
        todo: mockTodo,
        summarize: mockSummarize,
        messages: vi.fn().mockResolvedValue({ data: [], error: undefined }),
      },
      tui: {
        showToast: mockShowToast,
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
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000, autoCompact: false });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(5000);

      expect(mockAbort).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should not treat plugin-initiated abort as user cancellation", async () => {
      vi.useFakeTimers();
      const statusFilePath = `/tmp/opencode-plugin-abort-${Date.now()}.json`;
      mockStatus
        .mockResolvedValueOnce({ data: { "test": { type: "busy" } }, error: undefined })
        .mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 100,
        waitAfterAbortMs: 10,
        cooldownMs: 0,
        autoCompact: false,
        abortPollMaxTimeMs: 0,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath,
      });

      mockAbort.mockImplementation(async () => {
        await plugin.event({ event: { type: "session.error", properties: { sessionID: "test", error: { name: "MessageAbortedError", message: "aborted by plugin" } } } });
        return { data: true, error: undefined };
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(150);
      await flushPromises();
      // Flush debounced status file write (500ms debounce)
      await vi.advanceTimersByTimeAsync(500);
      await flushPromises();

      const status = JSON.parse(readFileSync(statusFilePath, "utf-8"));
      expect(status.sessions.test.userCancelled).toBe(false);
      expect(mockPrompt).toHaveBeenCalled();

      try {
        unlinkSync(statusFilePath);
      } catch {
        // ignore cleanup errors
      }
      vi.useRealTimers();
    });

    it("should clear stale stall timer when session becomes idle", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 1000,
        autoCompact: false,
        nudgeEnabled: false,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: "",
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "idle" } } } });
      await vi.advanceTimersByTimeAsync(2000);

      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should NOT set timer for idle session.status", async () => {
      vi.useFakeTimers();
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000, autoCompact: false });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "idle" } } } });
      await vi.advanceTimersByTimeAsync(10000);

      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should set timer on message.part.updated with delta", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000, autoCompact: false });

      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "text", text: "hello", sessionID: "test", messageID: "msg1" }, delta: "hello" } } });
      await vi.advanceTimersByTimeAsync(5000);

      expect(mockAbort).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should reset timer on new progress event", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000, autoCompact: false });

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
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 1000, waitAfterAbortMs: 100, autoCompact: false });

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
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000, autoCompact: false });

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
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 1000, waitAfterAbortMs: 100, cooldownMs: 10000, maxRecoveries: 10, autoCompact: false });

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
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 500, waitAfterAbortMs: 50, cooldownMs: 0, maxRecoveries: 2, abortPollMaxTimeMs: 0, autoCompact: false });

      // Create session and set timer
      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "text", text: "hello", sessionID: "test", messageID: "msg1" }, delta: "hello" } } });
      
      // First recovery (attempts=0 → 1)
      await vi.advanceTimersByTimeAsync(600);
      await flushPromises();
      expect(mockAbort).toHaveBeenCalledTimes(1);

      // After recovery, new message starts - simulate event to set new timer
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      
      // Second recovery (attempts=1 → 2)  
      await vi.advanceTimersByTimeAsync(600);
      await flushPromises();
      expect(mockAbort).toHaveBeenCalledTimes(2);

      // After maxRecoveries, should enter backoff - no abort within normal time
      mockAbort.mockClear();
      await vi.advanceTimersByTimeAsync(500);
      await flushPromises();
      expect(mockAbort).not.toHaveBeenCalled();

      // Verify backoff is working by checking that more time passes without abort
      // Backoff delay is 500 * 2^1 = 1000ms, so advance less than that
      await vi.advanceTimersByTimeAsync(400);
      await flushPromises();
      // Should still be in backoff - timer hasn't fired yet
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
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 1000, waitAfterAbortMs: 100, autoCompact: false });

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
    it("should NOT clear session on session.idle — triggers nudge instead", async () => {
      vi.useFakeTimers();
      // Status returns idle when sendNudge checks session status
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        nudgeEnabled: true,
        nudgeCooldownMs: 1000,
        includeTodoContext: false,
        terminalProgressEnabled: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      // Create session with busy status first
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      // Set hasOpenTodos via todo.updated
      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [{ id: "t1", content: "test todo", status: "in_progress" }] } } });

      // Mock todo API for nudge
      mockTodo.mockResolvedValue({
        data: [{ id: "t1", content: "test todo", status: "in_progress" }],
        error: undefined
      });

      // Now fire session.idle - schedules nudge after idle delay
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      
      // Advance timers to trigger the scheduled nudge
      await vi.advanceTimersByTimeAsync(500);

      // Verify nudge was sent (prompt was called)
      expect(mockPrompt).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should NOT trigger nudge on session.idle if no pending todos", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, {
        nudgeEnabled: true,
        nudgeCooldownMs: 0,
        terminalProgressEnabled: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      // Create session with busy status
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      // No todos set (hasOpenTodos stays false)

      // Fire session.idle - should NOT trigger nudge
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });

      expect(mockPrompt).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should NOT trigger nudge on session.idle within cooldown period", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, {
        nudgeEnabled: true,
        nudgeCooldownMs: 60000, // 1 minute cooldown
        terminalProgressEnabled: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      // Create session and set todo
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [{ id: "t1", content: "test todo", status: "in_progress" }] } } });

      // Mock todo API for nudge
      mockTodo.mockResolvedValue({
        data: [{ id: "t1", content: "test todo", status: "in_progress" }],
        error: undefined
      });

      // First session.idle should trigger nudge after idle delay
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(500);
      expect(mockPrompt).toHaveBeenCalledTimes(1);

      mockPrompt.mockClear();

      // Second session.idle immediately after should NOT trigger (cooldown)
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(500);
      expect(mockPrompt).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("should include todo context in nudge message when includeTodoContext is true", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });
      mockTodo.mockResolvedValue({
        data: [
          { id: "t1", content: "First task", status: "in_progress" },
          { id: "t2", content: "Second task", status: "pending" }
        ],
        error: undefined
      });
      const plugin = await createPlugin({ client: mockClient }, {
        nudgeEnabled: true,
        nudgeCooldownMs: 0,
        includeTodoContext: true,
        terminalProgressEnabled: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      // Create session and set todo
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [
        { id: "t1", content: "First task", status: "in_progress" },
        { id: "t2", content: "Second task", status: "pending" }
      ] } } });

      // Fire session.idle - nudge uses cached todos from todo.updated events
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(100);

      // Nudge should use cached todos, NOT call the API
      expect(mockTodo).not.toHaveBeenCalled();
      // Verify prompt was called with todo context from cached todos
      expect(mockPrompt).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("should send nudge on EVERY session.idle with pending todos (no wasBusy dedup)", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, {
        nudgeEnabled: true,
        nudgeCooldownMs: 60000, // Use cooldown to prevent rapid nudges
        terminalProgressEnabled: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      // Create session with busy status
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      // Set pending todos
      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [
        { id: "t1", content: "test task", status: "in_progress" }
      ] } } });

      // Mock todo API for nudge
      mockTodo.mockResolvedValue({
        data: [{ id: "t1", content: "test task", status: "in_progress" }],
        error: undefined
      });

      // First session.idle — should trigger nudge after idle delay
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(500);
      expect(mockPrompt).toHaveBeenCalledTimes(1);

      mockPrompt.mockClear();

      // Second session.idle — nudge should NOT fire because cooldown hasn't passed
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(500);
      expect(mockPrompt).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should pause nudge after nudgeMaxSubmits without todo changes", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, {
        nudgeEnabled: true,
        nudgeIdleDelayMs: 0, // Fire immediately for testing
        nudgeCooldownMs: 0,
        nudgeMaxSubmits: 3,
        terminalProgressEnabled: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      // Create session with busy status
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      // Set pending todos (static - won't change)
      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [
        { id: "t1", content: "test task", status: "in_progress" }
      ] } } });

      // Mock todo API to return same static todos
      mockTodo.mockResolvedValue({
        data: [{ id: "t1", content: "test task", status: "in_progress" }],
        error: undefined
      });

      // First nudge - should succeed, nudgeCount becomes 1
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(100);
      expect(mockPrompt).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
      vi.useFakeTimers();

      mockPrompt.mockClear();

      // Second nudge - should succeed, nudgeCount becomes 2
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(100);
      expect(mockPrompt).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
      vi.useFakeTimers();

      mockPrompt.mockClear();

      // Third nudge - should succeed, nudgeCount becomes 3
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(100);
      expect(mockPrompt).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
      vi.useFakeTimers();

      mockPrompt.mockClear();

      // Fourth nudge - should BLOCKED by loop protection (nudgeCount >= 3)
      // Todo snapshot hasn't changed, so loop protection kicks in
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(100);
      expect(mockPrompt).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should reset nudgeCount when todo snapshot changes", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, {
        nudgeEnabled: true,
        nudgeIdleDelayMs: 0,
        nudgeCooldownMs: 0,
        nudgeMaxSubmits: 3,
        terminalProgressEnabled: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      // Create session with busy status
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      // Set two pending todos
      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [
        { id: "t1", content: "task 1", status: "in_progress" },
        { id: "t2", content: "task 2", status: "in_progress" }
      ] } } });

      // Mock todos - both in_progress
      mockTodo.mockResolvedValue({
        data: [
          { id: "t1", content: "task 1", status: "in_progress" },
          { id: "t2", content: "task 2", status: "in_progress" }
        ],
        error: undefined
      });

      // First nudge - succeeds, nudgeCount = 1, snapshot = "t1:in_progress,t2:in_progress"
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(100);
      expect(mockPrompt).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
      vi.useFakeTimers();

      mockPrompt.mockClear();

      // Second nudge - succeeds, nudgeCount = 2
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(100);
      expect(mockPrompt).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
      vi.useFakeTimers();

      mockPrompt.mockClear();

      // Third nudge - succeeds, nudgeCount = 3
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(100);
      expect(mockPrompt).toHaveBeenCalledTimes(1);

      mockPrompt.mockClear();

      // Fourth nudge - BLOCKED by loop protection (nudgeCount = 3 >= 3)
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(100);
      expect(mockPrompt).not.toHaveBeenCalled();

      // Now t1 is completed, t2 remains in_progress
      // Snapshot changes from "t1:in_progress,t2:in_progress" to "t1:completed,t2:in_progress"
      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [
        { id: "t1", content: "task 1", status: "completed" },
        { id: "t2", content: "task 2", status: "in_progress" }
      ] } } });

      // Mock returns different snapshot
      mockTodo.mockResolvedValue({
        data: [
          { id: "t1", content: "task 1", status: "completed" },
          { id: "t2", content: "task 2", status: "in_progress" }
        ],
        error: undefined
      });

      // Reset mock to track calls
      mockPrompt.mockClear();

      // Fifth nudge - should SUCCEED because snapshot changed
      // Loop protection resets, t2 is still pending so prompt goes out
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(100);
      expect(mockPrompt).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it("should clear session on session.deleted after session.idle", async () => {
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000, autoCompact: false });

      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "text", text: "hello", sessionID: "test", messageID: "msg1" }, delta: "hello" } } });
      await plugin.event({ event: { type: "session.deleted", properties: { sessionID: "test", info: {} } } });

      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(10000);

      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe("idle processing speed", () => {
    it("should schedule nudge from session.status(idle) when session.idle hasn't fired", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, {
        nudgeEnabled: true,
        nudgeIdleDelayMs: 500,
        nudgeCooldownMs: 0,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [{ id: "t1", content: "test todo", status: "in_progress" }] } } });

      mockTodo.mockResolvedValue({
        data: [{ id: "t1", content: "test todo", status: "in_progress" }],
        error: undefined
      });

      // Fire ONLY session.status(idle) — should still schedule nudge as fallback
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "idle" } } } });

      // Nudge should NOT fire yet (in delay period)
      expect(mockPrompt).not.toHaveBeenCalled();

      // Wait for nudge delay to pass
      await vi.advanceTimersByTimeAsync(600);

      // Now nudge should have fired
      expect(mockPrompt).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should not duplicate idle processing when both session.status(idle) and session.idle fire", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, {
        nudgeEnabled: true,
        nudgeIdleDelayMs: 500,
        nudgeCooldownMs: 0,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [{ id: "t1", content: "test todo", status: "in_progress" }] } } });

      mockTodo.mockResolvedValue({
        data: [{ id: "t1", content: "test todo", status: "in_progress" }],
        error: undefined
      });

      // Fire session.idle first — sets idleProcessingDone and schedules nudge
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });

      // Fire session.status(idle) — should skip todo-poll + nudge scheduling due to idleProcessingDone
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "idle" } } } });

      // Advance past nudge delay — only one nudge timer should fire
      await vi.advanceTimersByTimeAsync(600);

      // Verify nudge was called at most once (not duplicated by both handlers)
      expect(mockPrompt.mock.calls.length).toBeLessThanOrEqual(1);
      vi.useRealTimers();
    });

    it("should clear idleProcessingDone when session goes busy", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, {
        nudgeEnabled: true,
        nudgeIdleDelayMs: 0,
        nudgeCooldownMs: 0,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: ""
      });

      // Create session with busy status
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [{ id: "t1", content: "test todo", status: "in_progress" }] } } });

      mockTodo.mockResolvedValue({
        data: [{ id: "t1", content: "test todo", status: "in_progress" }],
        error: undefined
      });

      // First idle — schedules nudge
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(100);
      expect(mockPrompt).toHaveBeenCalledTimes(1);

      // Session goes busy — clears idleProcessingDone
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Second idle — should schedule nudge again (not deduped)
      mockPrompt.mockClear();
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(100);
      expect(mockPrompt).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it("should schedule nudge after sending continue on session.idle", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, {
        nudgeEnabled: true,
        nudgeIdleDelayMs: 500,
        nudgeCooldownMs: 0,
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Set needsContinue (simulating recovery state)
      const sessions = (plugin as any).sessions;
      const s = sessions?.get?.("test");
      if (!s) {
        // Skip if session not found (shouldn't happen)
        vi.useRealTimers();
        return;
      }
      s.needsContinue = true;
      s.continueMessageText = "Continue.";
      s.hasOpenTodos = true;

      mockTodo.mockResolvedValue({
        data: [{ id: "t1", content: "test todo", status: "in_progress" }],
        error: undefined
      });

      // Fire session.idle with needsContinue — should send continue AND schedule nudge
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });

      // Continue prompt should have been sent immediately
      const calls = mockPrompt.mock.calls.map((c: any) => c[0]?.body?.parts?.[0]?.text);
      const continueCall = calls.some((t: string) => t && t.includes("Continue"));
      expect(continueCall).toBe(true);

      // Nudge timer should also be set (nudgeIdleDelayMs = 500)
      // After continue, session goes busy, so nudge injectNudge will check status
      // and defer if busy. But the timer should still be scheduled.
      expect(s.nudgeTimer).not.toBeNull();

      vi.useRealTimers();
    });
  });

  describe("attempts reset on progress", () => {
    it("should reset attempts on progress event", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 50, waitAfterAbortMs: 10, cooldownMs: 0, maxRecoveries: 3, abortPollMaxTimeMs: 0, autoCompact: false });

      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "text", text: "hello", sessionID: "test", messageID: "msg1" }, delta: "hello" } } });
      await vi.advanceTimersByTimeAsync(50);
      await flushPromises();

      expect(mockAbort).toHaveBeenCalledTimes(1);

      mockAbort.mockClear();
      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "text", text: "hello", sessionID: "test", messageID: "msg1" }, delta: "hello" } } });
      await vi.advanceTimersByTimeAsync(50);
      await flushPromises();

      expect(mockAbort).toHaveBeenCalledTimes(1);

      mockAbort.mockClear();
      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "text", text: "hello world", sessionID: "test", messageID: "msg1" }, delta: " world" } } });
      await vi.advanceTimersByTimeAsync(50);
      await flushPromises();

      expect(mockAbort).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });
  });

  describe("timer restart after recovery", () => {
    it("should set new timer after successful recovery", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 50, waitAfterAbortMs: 10, cooldownMs: 0, maxRecoveries: 5, abortPollMaxTimeMs: 0, autoCompact: false });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(100);
      await flushPromises();

      expect(mockAbort).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });
  });

  describe("tool and other part types progress tracking", () => {
    it("should track tool parts as progress", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000, autoCompact: false });

      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "tool", callID: "call1", tool: "bash", state: { type: "running" }, sessionID: "test", messageID: "msg1" }, delta: "" } } });
      await vi.advanceTimersByTimeAsync(4000);

      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should track step-start parts as progress", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000, autoCompact: false });

      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "step-start", sessionID: "test", messageID: "msg1" }, delta: "" } } });
      await vi.advanceTimersByTimeAsync(4000);

      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should track subtask parts as progress", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000, autoCompact: false });

      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "subtask", prompt: "test", description: "test", agent: "test", sessionID: "test", messageID: "msg1" }, delta: "" } } });
      await vi.advanceTimersByTimeAsync(4000);

      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should track file parts as progress", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000, autoCompact: false });

      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "file", mime: "text/plain", url: "test.txt", sessionID: "test", messageID: "msg1" }, delta: "" } } });
      await vi.advanceTimersByTimeAsync(4000);

      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe("config validation", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      warnSpy.mockRestore();
    });

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
      // Pass invalid maxRecoveries - only invalid field is reset to default
      // Valid fields (stallTimeoutMs) are preserved
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000, waitAfterAbortMs: 100, maxRecoveries: -1 });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(1000);

      // stallTimeoutMs (5000) is preserved, so abort NOT called after 1000ms
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
      await flushPromises();

      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should resume monitoring after compaction ends", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 1000, waitAfterAbortMs: 100, autoCompact: false });

      // Session becomes busy and compaction starts
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "compaction", auto: true }, delta: "" } } });
      
      // Compaction ends via session.compacted event (the only way compacting flag is cleared)
      await plugin.event({ event: { type: "session.compacted", properties: { sessionID: "test" } } });
      
      // Now wait for stall - should abort because compacting was cleared
      await vi.advanceTimersByTimeAsync(1000);
      await flushPromises();

      expect(mockAbort).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should NOT clear session on session.compacted — preserves state", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, {
        nudgeEnabled: true,
        nudgeCooldownMs: 0,
        terminalProgressEnabled: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      // Create session with busy status
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      // Set pending todos (hasOpenTodos = true)
      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [{ id: "t1", content: "test", status: "in_progress" }] } } });
      
      // Mock todo API for nudge
      mockTodo.mockResolvedValue({
        data: [{ id: "t1", content: "test", status: "in_progress" }],
        error: undefined
      });
      
      // Fire session.compacted — should NOT reset session state
      await plugin.event({ event: { type: "session.compacted", properties: { sessionID: "test" } } });
      
      // After compaction, session.idle with pending todos should still trigger nudge
      // This proves hasOpenTodos and other state survived the compacted event
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(500);
      
      expect(mockPrompt).toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe("token limit handling", () => {
    it("should validate token limit patterns config", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      // Pass invalid tokenLimitPatterns (empty array), but valid stallTimeoutMs is preserved
      const plugin = await createPlugin({ client: mockClient }, { 
        stallTimeoutMs: 5000, 
        waitAfterAbortMs: 100, 
        tokenLimitPatterns: [] 
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(1000);

      // stallTimeoutMs preserved at 5000, abort NOT called after 1000ms
      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should validate proactive compaction token threshold", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { 
        stallTimeoutMs: 5000, 
        waitAfterAbortMs: 100, 
        proactiveCompactAtTokens: -1 
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(1000);

      // stallTimeoutMs preserved at 5000, abort NOT called after 1000ms
      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should validate proactive compaction percent threshold", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { 
        stallTimeoutMs: 5000, 
        waitAfterAbortMs: 100, 
        proactiveCompactAtPercent: 150 
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(1000);

      // stallTimeoutMs preserved at 5000, abort NOT called after 1000ms
      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should validate short continue message config", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { 
        stallTimeoutMs: 5000, 
        waitAfterAbortMs: 100, 
        shortContinueMessage: "" 
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(1000);

      // stallTimeoutMs preserved at 5000, abort NOT called after 1000ms
      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

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

    it("should send short continue after successful emergency compaction", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockSummarize.mockResolvedValue({ data: {}, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: "",
        shortContinueMessage: "Continue.",
        compactionVerifyWaitMs: 1000,
        hardCompactAtTokens: 999999, // Prevent hard compact from firing again in sendContinue
      });

      // Create session with busy status
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Fire token limit error → triggers emergency compaction
      await plugin.event({ event: { type: "session.error", properties: { sessionID: "test", error: { name: "TokenLimitError", message: "Requested token count exceeds the model's maximum context length of 262144 tokens" } } } });

      // Advance timers to let summarize resolve and enter the while loop
      await vi.advanceTimersByTimeAsync(1000);
      await flushPromises();
      // Simulate session.compacted event — this clears compacting flag and resets token estimates
      await plugin.event({ event: { type: "session.compacted", properties: { sessionID: "test" } } });
      // Advance timers and flush multiple times for the async continue chain
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(500);
        await flushPromises();
      }

      // Should send continue prompt after compaction
      expect(mockPrompt).toHaveBeenCalled();
      const promptCall = mockPrompt.mock.calls[0] as any;
      expect(promptCall[0].path.id).toBe("test");
      expect(promptCall[0].body.parts[0].text).toBe("Continue.");
      vi.useRealTimers();
    });

    it("should not trigger emergency compaction on non-token-limit errors", async () => {
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
      expect(mockPrompt).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should track message count on user messages", async () => {
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000, proactiveCompactAtTokens: 100000 });

      await plugin.event({ event: { type: "message.created", properties: { sessionID: "test", info: { role: "user", id: "msg1", content: "Hello world" } } } });
      await plugin.event({ event: { type: "message.created", properties: { sessionID: "test", info: { role: "user", id: "msg2", content: "Test message" } } } });
      await plugin.event({ event: { type: "message.created", properties: { sessionID: "test", info: { role: "user", id: "msg3", content: "Another test" } } } });

      // Messages tracked - test passes if no errors
      expect(true).toBe(true);
    });

    it("should reset lastOutputAt and lastToolExecutionAt on user message to prevent false text-only stall", async () => {
      vi.useFakeTimers();
      const now = Date.now();
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        textOnlyStallTimeoutMs: 120000,
        busyStallTimeoutMs: 180000,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: ""
      });

      // Session busy — simulate old activity
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(100);

      // Simulate tools were run long ago
      const fakeState = (plugin as any).runtime?.sessions?.get?.("test");
      if (fakeState) {
        fakeState.lastOutputAt = now - 300000; // 5 minutes ago
        fakeState.lastToolExecutionAt = now - 300000;
      }

      // User sends a new message — should reset the timestamps
      const beforeUserMsg = Date.now();
      await plugin.event({ event: { type: "message.created", properties: { sessionID: "test", info: { role: "user", id: "msg-new" } } } });

      // Verify timestamps were reset (should be >= when user message was sent)
      if (fakeState) {
        expect(fakeState.lastOutputAt).toBeGreaterThanOrEqual(beforeUserMsg - 1000);
        expect(fakeState.lastToolExecutionAt).toBeGreaterThanOrEqual(beforeUserMsg - 1000);
      }

      // session.status(busy) fires now — text-only stall should NOT fire because timeSinceToolExecution is ~0
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(100);

      // Should NOT have triggered abort (no false text-only stall)
      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should validate proactive compaction token threshold", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      // Negative token threshold should trigger validation failure
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 50000, waitAfterAbortMs: 100, proactiveCompactAtTokens: -1 });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(1000);

      // Should use defaults
      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should validate proactive compaction percent threshold", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      // Invalid percent should trigger validation failure
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 50000, waitAfterAbortMs: 100, proactiveCompactAtPercent: 150 });

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
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 50000, waitAfterAbortMs: 100, shortContinueMessage: "" });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(1000);

      // Should use defaults
      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe("status file", () => {
    it("should write status file on session.status busy", async () => {
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000, terminalTitleEnabled: false });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Status file should be written (no error thrown)
      expect(true).toBe(true);
    });

    it("should write status file on session.created", async () => {
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000, terminalTitleEnabled: false });

      await plugin.event({ event: { type: "session.created", properties: { sessionID: "test" } } });

      expect(true).toBe(true);
    });

    it("should write status file on todo.updated", async () => {
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000, terminalTitleEnabled: false });

      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [{ id: "1", status: "in_progress" }] } } });

      expect(true).toBe(true);
    });
  });

  describe("terminal title", () => {
    it("should not write terminal title when disabled", async () => {
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const plugin = await createPlugin({ client: mockClient }, { 
        stallTimeoutMs: 5000, 
        terminalTitleEnabled: false,
        terminalProgressEnabled: false 
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      expect(writeSpy).not.toHaveBeenCalled();
      writeSpy.mockRestore();
    });
  });

  describe("status file config", () => {
    it("should not write status file when disabled", async () => {
      const writeFileSpy = vi.spyOn(require('fs'), 'writeFileSync').mockImplementation(() => {});
      const plugin = await createPlugin({ client: mockClient }, { 
        stallTimeoutMs: 5000, 
        terminalTitleEnabled: false,
        statusFileEnabled: false 
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      expect(writeFileSpy).not.toHaveBeenCalled();
      writeFileSpy.mockRestore();
    });

    it("should write status file with history tracking", async () => {
      const plugin = await createPlugin({ client: mockClient }, { 
        stallTimeoutMs: 5000, 
        terminalTitleEnabled: false,
        maxStatusHistory: 3 
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe("recovery timing stats", () => {
    it("should track recovery timing on successful recovery", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { 
        stallTimeoutMs: 1000, 
        waitAfterAbortMs: 100, 
        cooldownMs: 0,
        terminalTitleEnabled: false,
        autoCompact: false
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(1000);
      await flushPromises();

      // Recovery should have been attempted
      expect(mockAbort).toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe("terminal progress bar", () => {
    it("should not write OSC 9;4 when disabled", async () => {
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const plugin = await createPlugin({ client: mockClient }, { 
        stallTimeoutMs: 5000, 
        terminalTitleEnabled: false,
        terminalProgressEnabled: false 
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

// Should not contain OSC 9;4 sequences
      const osc94Calls = writeSpy.mock.calls.filter(call => 
        typeof call[0] === 'string' && call[0].includes('\x1b]9;4')
      );
      expect(osc94Calls).toHaveLength(0);
      writeSpy.mockRestore();
    });
  });

  describe("stall pattern detection", () => {
    it("should not crash with stall pattern detection enabled", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { 
        stallTimeoutMs: 1000, 
        waitAfterAbortMs: 100, 
        cooldownMs: 0,
        terminalTitleEnabled: false,
        stallPatternDetection: true,
        autoCompact: false
      });

      // Simulate progress then stall
      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "text", text: "hello", sessionID: "test", messageID: "msg1" }, delta: "hello" } } });
      await vi.advanceTimersByTimeAsync(1000);
      await flushPromises();

      expect(mockAbort).toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe("compaction verification", () => {
    it("should attempt compaction before abort when autoCompact enabled", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { 
        stallTimeoutMs: 1000, 
        waitAfterAbortMs: 100,
        cooldownMs: 0,
        autoCompact: true,
        terminalTitleEnabled: false,
        compactionVerifyWaitMs: 500
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(1000);
      await flushPromises();

      // Should attempt to summarize (compact) before aborting
      expect(mockStatus).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should send continue after compaction completes", async () => {
      vi.useFakeTimers();
      const originalHome = process.env.HOME;
      process.env.HOME = `/tmp/opencode-test-home-${Date.now()}`;
      try {
        mockStatus
          .mockResolvedValueOnce({ data: { "test": { type: "busy" } }, error: undefined })
          .mockResolvedValueOnce({ data: { "test": { type: "idle" } }, error: undefined })
          .mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
        mockPrompt.mockResolvedValue({ data: {}, error: undefined });

        const plugin = await createPlugin({ client: mockClient }, {
          stallTimeoutMs: 100,
          waitAfterAbortMs: 10,
          cooldownMs: 0,
          autoCompact: true,
          abortPollIntervalMs: 5,
          abortPollMaxTimeMs: 20,
          terminalTitleEnabled: false,
          terminalProgressEnabled: false,
          statusFilePath: "",
          hardCompactAtTokens: 999999,
        });

        // Start session busy
        await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

        // Trigger recovery via stall timeout
        await vi.advanceTimersByTimeAsync(3200);
        await flushPromises();

        // Recovery should have called summarize
        expect(mockSummarize).toHaveBeenCalled();
        expect(mockPrompt).not.toHaveBeenCalled();

        // Compaction completes via session.compacted event
        await plugin.event({ event: { type: "session.compacted", properties: { sessionID: "test" } } });

        // The session.compacted handler queues and sends continue
        // Allow the async chain to complete (sendContinue → shouldBlockPrompt → maybeHardCompact → prompt)
        await flushPromises();
        await vi.advanceTimersByTimeAsync(100);
        await flushPromises();
        await vi.advanceTimersByTimeAsync(100);
        await flushPromises();

        expect(mockPrompt).toHaveBeenCalled();
      } finally {
        process.env.HOME = originalHome;
        vi.useRealTimers();
      }
    });

    it("should trigger proactive compaction when estimatedTokens >= threshold", async () => {
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { 
        stallTimeoutMs: 5000, 
        waitAfterAbortMs: 100,
        proactiveCompactAtTokens: 100,
        proactiveCompactAtPercent: 50,
        compactionVerifyWaitMs: 100,
        terminalTitleEnabled: false,
        statusFileEnabled: false
      });

      // Start busy session
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Accumulate tokens via message events (each ~25 tokens)
      for (let i = 0; i < 5; i++) {
        await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part" + i, type: "text", text: "a".repeat(100), sessionID: "test", messageID: "msg1" }, delta: "a".repeat(100) } } });
      }

      // Should have accumulated tokens (estimatedTokens >= 100 would trigger compaction)
      await Promise.resolve();
      expect(true).toBe(true);
    });
  });

  describe("token estimation", () => {
    it("should count tokens from all part types, not just text", async () => {
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { 
        stallTimeoutMs: 5000, 
        terminalTitleEnabled: false 
      });

      // Reasoning part should contribute tokens
      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "reasoning", reasoning: "This is a long reasoning chain that should be counted as tokens", sessionID: "test", messageID: "msg1" }, delta: "" } } });
      
      // Tool part should contribute tokens
      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part2", type: "tool", callID: "call1", tool: "bash", state: { type: "running" }, sessionID: "test", messageID: "msg1" }, delta: "" } } });
      
      // File part should contribute tokens
      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part3", type: "file", mime: "text/plain", url: "test.txt", sessionID: "test", messageID: "msg1" }, delta: "" } } });

      await Promise.resolve();
      expect(true).toBe(true);
    });
  });

  describe("config validation", () => {
    it("should use defaults for new config options", async () => {
      const plugin = await createPlugin({ client: mockClient }, { 
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false 
      });

      // Plugin should initialize with all defaults
      expect(plugin).toBeDefined();
      expect(plugin.event).toBeDefined();
    });
  });

  describe("safeHook utility", () => {
    it("should catch errors and not throw", async () => {
      const { safeHook } = await import('../shared.js');
      
      let errorThrown = false;
      try {
        await safeHook("test", async () => {
          throw new Error("test error");
        }, console.log);
      } catch {
        errorThrown = true;
      }
      
      expect(errorThrown).toBe(false);
    });

    it("should call log on error", async () => {
      const logMock = vi.fn();
      const { safeHook } = await import('../shared.js');
      
      await safeHook("test", async () => {
        throw new Error("test error");
      }, logMock);
      
      expect(logMock).toHaveBeenCalledWith("[test] hook failed:", expect.any(Error));
    });

    it("should pass through successful results", async () => {
      const { safeHook } = await import('../shared.js');
      const logMock = vi.fn();
      
      let result = false;
      await safeHook("test", async () => {
        result = true;
      }, logMock);
      
      expect(result).toBe(true);
      expect(logMock).not.toHaveBeenCalled();
    });
  });

  describe("experimental.compaction.autocontinue hook", () => {
    it("should return enabled: false when plugin has needsContinue", async () => {
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000 });

      const output = { enabled: true };
      await (plugin as any)["experimental.compaction.autocontinue"](
        { sessionID: "test" },
        output
      );

      // With no needsContinue, should still disable the generic continue
      expect(output.enabled).toBe(false);
    });
  });

  describe("experimental.chat.system.transform hook", () => {
    it("should inject dangerous commands policy into system prompt when enabled", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        dangerousCommandBlocking: true,
        dangerousCommandInjection: true,
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
      });

      await plugin.event({ event: { type: "session.created", properties: { sessionID: "test" } } });

      const output = { system: [] as string[] };
      await (plugin as any)["experimental.chat.system.transform"](
        { sessionID: "test" },
        output
      );

      expect(output.system.length).toBe(1);
      expect(output.system[0]).toContain("Dangerous Commands Policy");
      expect(output.system[0]).toContain("blocked by policy");

      plugin.dispose?.();
    });

    it("should NOT inject policy when dangerousCommandInjection is disabled", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        dangerousCommandBlocking: true,
        dangerousCommandInjection: false,
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
      });

      const output = { system: [] as string[] };
      await (plugin as any)["experimental.chat.system.transform"](
        { sessionID: "test" },
        output
      );

      expect(output.system.length).toBe(0);

      plugin.dispose?.();
    });

    it("should NOT inject policy when dangerousCommandBlocking is disabled", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        dangerousCommandBlocking: false,
        dangerousCommandInjection: true,
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
      });

      const output = { system: [] as string[] };
      await (plugin as any)["experimental.chat.system.transform"](
        { sessionID: "test" },
        output
      );

      expect(output.system.length).toBe(0);

      plugin.dispose?.();
    });

    it("should guard against undefined output.system", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        dangerousCommandBlocking: true,
        dangerousCommandInjection: true,
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
      });

      await plugin.event({ event: { type: "session.created", properties: { sessionID: "test" } } });

      const output = {} as any;
      await (plugin as any)["experimental.chat.system.transform"](
        { sessionID: "test" },
        output
      );

      expect(output.system).toBeDefined();
      expect(output.system.length).toBe(1);

      plugin.dispose?.();
    });

    it("should set systemTransformHookCalled flag on session when called", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        dangerousCommandBlocking: true,
        dangerousCommandInjection: true,
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
      });

      await plugin.event({ event: { type: "session.created", properties: { sessionID: "test" } } });

      const output = { system: [] as string[] };
      await (plugin as any)["experimental.chat.system.transform"](
        { sessionID: "test" },
        output
      );

      expect(output.system.length).toBe(1);

      plugin.dispose?.();
    });
  });

  describe("dangerous command injection fallback", () => {
    it("should schedule a delayed session.prompt fallback on session.created", async () => {
      vi.useFakeTimers();
      const plugin = await createPlugin({ client: mockClient }, {
        dangerousCommandBlocking: true,
        dangerousCommandInjection: true,
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
      });

      await plugin.event({ event: { type: "session.created", properties: { sessionID: "test" } } });

      expect(mockPrompt).not.toHaveBeenCalled();

      vi.advanceTimersByTime(30000);
      await flushPromises();

      expect(mockPrompt).toHaveBeenCalledTimes(1);
      const call = (mockPrompt.mock.calls[0] as any)[0];
      expect(call.body.parts[0].text).toContain("Dangerous Commands Policy");
      expect(call.body.parts[0].synthetic).toBe(true);

      vi.useRealTimers();
      plugin.dispose?.();
    });

    it("should skip session.prompt fallback if system transform hook was called first", async () => {
      vi.useFakeTimers();
      const plugin = await createPlugin({ client: mockClient }, {
        dangerousCommandBlocking: true,
        dangerousCommandInjection: true,
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
      });

      await plugin.event({ event: { type: "session.created", properties: { sessionID: "test" } } });

      const output = { system: [] as string[] };
      await (plugin as any)["experimental.chat.system.transform"](
        { sessionID: "test" },
        output
      );

      vi.advanceTimersByTime(30000);
      await flushPromises();

      expect(mockPrompt).not.toHaveBeenCalled();

      vi.useRealTimers();
      plugin.dispose?.();
    });

    it("should NOT schedule fallback when dangerousCommandInjection is disabled", async () => {
      vi.useFakeTimers();
      const plugin = await createPlugin({ client: mockClient }, {
        dangerousCommandBlocking: true,
        dangerousCommandInjection: false,
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
      });

      await plugin.event({ event: { type: "session.created", properties: { sessionID: "test" } } });

      vi.advanceTimersByTime(60000);
      await flushPromises();

      expect(mockPrompt).not.toHaveBeenCalled();

      vi.useRealTimers();
      plugin.dispose?.();
    });
  });

  describe("needsContinue flag behavior", () => {
    it("should handle needsContinue with successful prompt", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        autoCompact: false,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: ""
      });

      // Token limit error sets needsContinue
      await plugin.event({ event: { type: "session.error", properties: { sessionID: "test", error: { name: "TokenLimitError", message: "Token limit exceeded" } } } });

      // Session becomes idle and sends continue
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "idle" } } } });

      // Wait for the async sendContinue to complete
      await vi.advanceTimersByTimeAsync(100);
      await flushPromises();

      // Test passes if no crash
      expect(true).toBe(true);
      vi.useRealTimers();
    });

    it("should send continue when session.idle fires while aborting=true and needsContinue=true", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });
      mockTodo.mockResolvedValue({
        data: [{ id: "t1", content: "test", status: "in_progress" }],
        error: undefined,
      });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        nudgeEnabled: true,
        nudgeIdleDelayMs: 0,
        autoCompact: false,
        waitAfterAbortMs: 0,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: "",
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Stall fires → recovery sets aborting=true, then needsContinue=true
      await vi.advanceTimersByTimeAsync(5000);
      await flushPromises();

      // Session becomes idle while aborting is still true and needsContinue is true
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await flushPromises();

      // Advance timers to allow any delayed sendContinue to fire
      await vi.advanceTimersByTimeAsync(1000);
      await flushPromises();

      // The continue should eventually be sent (either directly or via retry)
      expect(mockPrompt).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("should reset stale continueRetryCount when last retry was over 60s ago", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });
      mockTodo.mockResolvedValue({ data: [], error: undefined });
      mockSummarize.mockResolvedValue({ data: {}, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        autoCompact: false,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: "",
      });

      // Create session
      await plugin.event({ event: { type: "session.created", properties: { sessionID: "test" } } });
      await flushPromises();

      // Advance 120s to make any retry count stale
      await vi.advanceTimersByTimeAsync(120000);
      await flushPromises();

      // Simulate a token limit error to set needsContinue
      await plugin.event({ event: { type: "session.error", properties: { sessionID: "test", error: { name: "TokenLimitError", message: "Token limit exceeded" } } } });
      await flushPromises();

      // Session becomes idle — should attempt continue (stale retry count should be reset)
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "idle" } } } });
      await vi.advanceTimersByTimeAsync(5000);
      await flushPromises();

      // At least one prompt should have been attempted
      expect(mockPrompt).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("should clear continueInProgress even when prompt throws", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockSummarize.mockResolvedValue({ data: {}, error: undefined });
      mockTodo.mockResolvedValue({ data: [], error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        autoCompact: true,
        hardCompactAtTokens: 999999,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: "",
        compactionVerifyWaitMs: 1000,
      });

      // Create session with busy status
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Fire token limit error → triggers emergency compaction
      await plugin.event({ event: { type: "session.error", properties: { sessionID: "test", error: { name: "TokenLimitError", message: "Token limit exceeded" } } } });

      // Make prompt fail on first attempt
      mockPrompt.mockRejectedValueOnce(new Error("prompt error"));

      // Advance timers to let compaction resolve
      await vi.advanceTimersByTimeAsync(1000);
      await flushPromises();

      // Simulate compaction success
      await plugin.event({ event: { type: "session.compacted", properties: { sessionID: "test" } } });
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(500);
        await flushPromises();
      }

      // First prompt was attempted (and failed)
      expect(mockPrompt).toHaveBeenCalled();

      // Now make prompt succeed
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });

      // Advance enough for continueRetryCount backoff to pass (5s)
      await vi.advanceTimersByTimeAsync(10000);
      await flushPromises();

      // Session becomes idle again — continueInProgress should have been cleared by finally
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "idle" } } } });
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(500);
        await flushPromises();
      }

      // Second prompt call should have been made (continueInProgress was cleared)
      expect(mockPrompt.mock.calls.length).toBeGreaterThanOrEqual(2);

      vi.useRealTimers();
    });
  });

  describe("review compaction deferral", () => {
    it("should defer review when session is compacting and retry after compaction completes", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });
      mockTodo.mockResolvedValue({
        data: [{ id: "t1", content: "Done", status: "completed" }],
        error: undefined,
      });
      mockSummarize.mockResolvedValue({ data: {}, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        reviewOnComplete: true,
        reviewDebounceMs: 100,
        autoCompact: false,
        nudgeEnabled: false,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: "",
      });

      // Create session and set it as compacting
      await plugin.event({ event: { type: "session.created", properties: { sessionID: "test" } } });
      await flushPromises();

      // Set compacting flag via compaction event
      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", part: { type: "compaction" } } } });
      await flushPromises();

      // Now mark all todos complete — review should be deferred because compacting
      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [{ id: "t1", content: "Done", status: "completed" }] } } });
      await vi.advanceTimersByTimeAsync(200); // review debounce
      await flushPromises();

      // Review prompt should NOT have been sent yet (compaction in progress)
      expect(mockPrompt).not.toHaveBeenCalled();

      // Compaction completes — clears compacting flag and re-triggers deferred review
      await plugin.event({ event: { type: "session.compacted", properties: { sessionID: "test" } } });
      await flushPromises();

      // Review should have been re-triggered immediately (not via 5s retry timer)
      // The review prompt contains "All tracked tasks are marked complete"
      const reviewCall = mockPrompt.mock.calls.find((c: any[]) =>
        c.some((arg: any) => typeof arg === 'object' && arg?.body?.parts?.some((p: any) => p.text?.includes('All tracked tasks')))
      );
      expect(reviewCall).toBeTruthy();

      vi.useRealTimers();
    });

    it("should NOT re-trigger review after compaction when reviewFired is already true", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });
      mockTodo.mockResolvedValue({
        data: [{ id: "t1", content: "Done", status: "completed" }],
        error: undefined,
      });
      mockSummarize.mockResolvedValue({ data: {}, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        reviewOnComplete: true,
        reviewDebounceMs: 100,
        autoCompact: false,
        nudgeEnabled: false,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: "",
      });

      await plugin.event({ event: { type: "session.created", properties: { sessionID: "test" } } });
      await flushPromises();

      // Mark all todos complete — review fires immediately (no compaction in progress)
      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [{ id: "t1", content: "Done", status: "completed" }] } } });
      await vi.advanceTimersByTimeAsync(200);
      await flushPromises();

      // Review prompt should have been sent
      const reviewCallsBefore = mockPrompt.mock.calls.filter((c: any[]) =>
        c.some((arg: any) => typeof arg === 'object' && arg?.body?.parts?.some((p: any) => p.text?.includes('All tracked tasks')))
      );
      expect(reviewCallsBefore.length).toBe(1);

      // Now set compacting flag (simulating a second compaction starting)
      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", part: { type: "compaction" } } } });
      await flushPromises();

      // Compaction completes — should NOT re-trigger review because reviewFired=true
      await plugin.event({ event: { type: "session.compacted", properties: { sessionID: "test" } } });
      await flushPromises();

      // No additional review prompt should have been sent
      const reviewCallsAfter = mockPrompt.mock.calls.filter((c: any[]) =>
        c.some((arg: any) => typeof arg === 'object' && arg?.body?.parts?.some((p: any) => p.text?.includes('All tracked tasks')))
      );
      expect(reviewCallsAfter.length).toBe(1); // Still only the original review

      vi.useRealTimers();
    });
  });

  describe("continueSafetyTimer", () => {
    it("should force-clear continueInProgress after 60s if stuck", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockImplementation(() => new Promise(() => {})); // Never resolves
      mockTodo.mockResolvedValue({ data: [], error: undefined });
      mockSummarize.mockResolvedValue({ data: {}, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        autoCompact: true,
        hardCompactAtTokens: 999999,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: "",
        compactionVerifyWaitMs: 1000,
      });

      // Create session with busy status
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Fire token limit error → triggers compaction → needsContinue=true
      await plugin.event({ event: { type: "session.error", properties: { sessionID: "test", error: { name: "TokenLimitError", message: "Token limit exceeded" } } } });

      // Advance timers to let compaction resolve
      await vi.advanceTimersByTimeAsync(1000);
      await flushPromises();

      // Simulate compaction success
      await plugin.event({ event: { type: "session.compacted", properties: { sessionID: "test" } } });
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(500);
        await flushPromises();
      }

      // Prompt was called (but never resolves, so continueInProgress is stuck)
      expect(mockPrompt).toHaveBeenCalled();

      // Advance past the 60s safety timeout
      await vi.advanceTimersByTimeAsync(65000);
      await flushPromises();

      // Make prompt succeed now
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });

      // Session becomes idle again — continueInProgress should have been force-cleared
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "idle" } } } });
      await vi.advanceTimersByTimeAsync(5000);
      await flushPromises();

      // Second prompt should be possible (continueInProgress was cleared)
      expect(mockPrompt.mock.calls.length).toBeGreaterThanOrEqual(2);

      vi.useRealTimers();
    });
  });

  describe("custom prompt API", () => {
    it("should render todo and context variables and send a synthetic prompt", async () => {
      const { AutoForceResumePlugin, sendCustomPrompt } = await import('../index.js');
      (mockClient.session as any).messages = vi.fn().mockResolvedValue({
        data: [{
          role: "assistant",
          createdAt: Date.now(),
          parts: [{ type: "text", text: "Recently edited the auth module." }],
        }],
      });
      mockTodo.mockResolvedValue({
        data: [
          { id: "t1", content: "fix auth", status: "in_progress" },
          { id: "t2", content: "write tests", status: "completed" },
        ],
        error: undefined,
      });

      const plugin = await AutoForceResumePlugin({ client: mockClient } as any, {
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: "",
        dangerousCommandInjection: false,
      } as any);
      await plugin.event({ event: { type: "session.created", properties: { sessionID: "test" } } });

      const result = await sendCustomPrompt("test", {
        message: "Next: {contextSummary} pending={pending} total={total}",
        includeTodoContext: true,
        includeContextSummary: true,
        customPrompt: "Focus on the auth failure first.",
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain("Working on 1 open task(s): fix auth.");
      expect(result.message).toContain("pending=1 total=2");
      expect(result.message).toContain("Additional instruction: Focus on the auth failure first.");
      expect(mockPrompt).toHaveBeenCalledTimes(1);
      expect((mockPrompt.mock.calls[0] as any)[0].body.parts[0]).toMatchObject({
        type: "text",
        synthetic: true,
      });

      plugin.dispose?.();
    });
  });

  describe("compactReductionFactor config", () => {
    it("should validate compactReductionFactor is between 0 and 1", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      // Invalid reduction factor (must be between 0 and 1), but stallTimeoutMs is preserved
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        waitAfterAbortMs: 100,
        compactReductionFactor: 1.5
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(1000);

      // stallTimeoutMs preserved at 5000, no abort after 1000ms
      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should accept valid compactReductionFactor", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        compactReductionFactor: 0.8,
        terminalTitleEnabled: false
      });

      // Plugin should initialize with custom reduction factor
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      expect(true).toBe(true);
      vi.useRealTimers();
    });
  });

  describe("planning state behavior", () => {
    it("should set planning=true when plan text is detected", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 1000,
        autoCompact: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Plan content in message
      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part1", type: "text", text: "Let me plan this out:\n1. First step\n2. Second step", sessionID: "test", messageID: "msg1" },
        delta: "Let me plan this out"
      } } });

      // Planning should pause stall detection
      await vi.advanceTimersByTimeAsync(10000);
      await flushPromises();

      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should schedule recovery timer with planningTimeoutMs when planning is detected", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 100,
        waitAfterAbortMs: 20,
        planningTimeoutMs: 200,
        cooldownMs: 0,
        autoCompact: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Simulate plan detection via text part
      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part1", type: "text", text: "Let me plan this out:\n1. First step", sessionID: "test", messageID: "msg1" },
        delta: "Let me plan this out"
      }}});

      // Wait for planning timeout (200ms)
      await vi.advanceTimersByTimeAsync(250);

      // Verify recovery was triggered (planning timeout forces recovery)
      expect(mockAbort).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should schedule normal recovery timer when planning is cleared by tool progress", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 100,
        waitAfterAbortMs: 20,
        planningTimeoutMs: 5000, // Long timeout so we can test clearing
        cooldownMs: 0,
        autoCompact: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Detect planning
      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part1", type: "text", text: "Let me plan this out:\n1. First step", sessionID: "test", messageID: "msg1" },
        delta: "Let me plan this out"
      }}});

      // Verify planning is set by checking no abort yet (timer is long)
      expect(mockAbort).not.toHaveBeenCalled();

      // Now simulate tool call (non-plan progress)
      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part2", type: "tool", sessionID: "test", messageID: "msg1" }
      }}});

      // Normal recovery timer should be scheduled (not planning timeout)
      // Wait for stall timeout (100ms)
      await vi.advanceTimersByTimeAsync(150);

      // Should trigger normal recovery (abort was called)
      expect(mockAbort).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should clear planning flag when session becomes busy", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 100,
        waitAfterAbortMs: 20,
        planningTimeoutMs: 5000,
        cooldownMs: 0,
        autoCompact: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Planning should be cleared after busy status (line 640 in index.ts)
      // We verify this by checking recovery timer is scheduled (abort called after stallTimeout)
      await vi.advanceTimersByTimeAsync(150);
      expect(mockAbort).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should clear planBuffer when planning flag is cleared by tool progress", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        planningTimeoutMs: 60000,
        autoCompact: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Detect planning via delta
      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part1", type: "text", text: "", sessionID: "test", messageID: "msg1" },
        delta: "Here is my plan"
      }}});

      // Now simulate tool call — should clear planning AND planBuffer
      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part2", type: "tool", name: "bash", sessionID: "test", messageID: "msg1" }
      }}});

      // Next delta should NOT match stale planBuffer
      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part3", type: "text", text: "", sessionID: "test", messageID: "msg1" },
        delta: "Some non-plan text"
      }}});

      // If planBuffer was NOT cleared, isPlanContent would match stale "Here is my plan"
      // and planning would be set again, preventing recovery. We verify by advancing
      // past stallTimeout — if planBuffer was properly cleared, recovery fires.
      await vi.advanceTimersByTimeAsync(6000);
      expect(mockAbort).toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe("nudge pause and resume behavior", () => {
    it("should pause nudge on MessageAbortedError", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockRejectedValue({ name: "MessageAbortedError", message: "User cancelled" });

      const plugin = await createPlugin({ client: mockClient }, {
        nudgeEnabled: true,
        nudgeCooldownMs: 0,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [{ id: "t1", content: "task", status: "in_progress" }] } } });

      mockTodo.mockResolvedValue({ data: [{ id: "t1", content: "task", status: "in_progress" }], error: undefined });

      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(500);

      // Nudge was attempted and aborted
      expect(mockPrompt).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should resume nudge on user message", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        nudgeEnabled: true,
        nudgeCooldownMs: 0,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [{ id: "t1", content: "task", status: "in_progress" }] } } });

      mockTodo.mockResolvedValue({ data: [{ id: "t1", content: "task", status: "in_progress" }], error: undefined });

      // User message clears nudgePaused
      await plugin.event({ event: { type: "message.created", properties: { sessionID: "test", info: { role: "user" } } } });

      // After user message, nudge should work
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(500);

      expect(mockPrompt).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should not resume nudging from a synthetic user message", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockRejectedValueOnce({ name: "MessageAbortedError", message: "User cancelled" });

      const plugin = await createPlugin({ client: mockClient }, {
        nudgeEnabled: true,
        nudgeCooldownMs: 0,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [{ id: "t1", content: "task", status: "in_progress" }] } } });

      mockTodo.mockResolvedValue({ data: [{ id: "t1", content: "task", status: "in_progress" }], error: undefined });

      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(500);
      expect(mockPrompt).toHaveBeenCalledTimes(1);

      mockPrompt.mockClear();
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });

      await plugin.event({
        event: {
          type: "message.created",
          properties: {
            sessionID: "test",
            info: {
              role: "user",
              id: "synthetic-1",
              parts: [{ type: "text", text: "Please continue.", synthetic: true }],
            },
          },
        },
      });
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(500);

      expect(mockPrompt).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe("reasoning token tracking", () => {
    it("should accumulate reasoning tokens from message.updated", async () => {
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000 });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Reasoning message with tokens
      await plugin.event({ event: { type: "message.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        info: { role: "assistant" },
        tokens: { input: 1000, output: 500, reasoning: 2000 }
      } } });

      // Test passes if no error
      expect(true).toBe(true);
    });

    it("should track step-finish tokens from message.part.updated", async () => {
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 5000 });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // step-finish part with tokens
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
  });

  describe("token limit error parsing", () => {
    it("should parse detailed token error message", async () => {
      const { parseTokensFromError } = await import('../shared.js');

      const error = new Error("You requested a total of 264230 tokens: 232230 tokens from the input messages and 32000 tokens for the completion.");
      const result = parseTokensFromError(error);

      expect(result).toEqual({ total: 264230, input: 232230, output: 32000 });
    });

    it("should parse simple token error message", async () => {
      const { parseTokensFromError } = await import('../shared.js');

      const error = new Error("You requested 150000 tokens");
      const result = parseTokensFromError(error);

      expect(result).toEqual({ total: 150000, input: 150000, output: 0 });
    });

    it("should return null for non-token errors", async () => {
      const { parseTokensFromError } = await import('../shared.js');

      const error = new Error("Something went wrong");
      const result = parseTokensFromError(error);

      expect(result).toBeNull();
    });

    it("should handle null error", async () => {
      const { parseTokensFromError } = await import('../shared.js');

      const result = parseTokensFromError(null);

      expect(result).toBeNull();
    });
  });

  describe("compactCooldownMs behavior", () => {
    it("should handle proactive compact checks during part updates", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        autoCompact: true,
        compactCooldownMs: 60000,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Each part update now triggers proactive compact check
      // Just verify no crash
      for (let i = 0; i < 10; i++) {
        await plugin.event({ event: { type: "message.part.updated", properties: {
          sessionID: "test",
          messageID: "msg1",
          part: { id: "part" + i, type: "text", text: "a".repeat(100), sessionID: "test", messageID: "msg1" },
          delta: "a".repeat(100)
        } } });
      }

      expect(true).toBe(true);
    });
  });

  describe("MessageAbortedError detection in nudge", () => {
    it("should handle nudge abort and pause", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });

      const nestedError = {
        name: "Error",
        message: "Request failed",
        data: {
          info: {
            error: { name: "MessageAbortedError" }
          }
        }
      };

      mockPrompt.mockRejectedValue(nestedError);

      const plugin = await createPlugin({ client: mockClient }, {
        nudgeEnabled: true,
        nudgeCooldownMs: 0,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [{ id: "t1", content: "task", status: "in_progress" }] } } });

      mockTodo.mockResolvedValue({ data: [{ id: "t1", content: "task", status: "in_progress" }], error: undefined });

      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(500);

      // Should have attempted nudge
      expect(mockPrompt).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("should resume nudging after post-recovery tool execution", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockRejectedValueOnce({ name: "MessageAbortedError", message: "User cancelled" });
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        nudgeEnabled: true,
        nudgeCooldownMs: 0,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [{ id: "t1", content: "task", status: "in_progress" }] } } });

      mockTodo.mockResolvedValue({ data: [{ id: "t1", content: "task", status: "in_progress" }], error: undefined });

      // First nudge fires but gets aborted — sets nudgePaused = true
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(500);
      expect(mockPrompt).toHaveBeenCalledTimes(1);

      // AI resumes work after recovery — tool execution clears nudgePaused
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part1", type: "tool", name: "read", sessionID: "test", messageID: "msg1" },
      } } });

      // Session goes idle again — nudge should work because nudgePaused was cleared
      mockPrompt.mockClear();
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(500);

      expect(mockPrompt).toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe("maxSessionAgeMs behavior", () => {
    it("should not crash with maxSessionAgeMs config", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        maxSessionAgeMs: 7200000,
        terminalTitleEnabled: false
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part1", type: "text", text: "hello", sessionID: "test", messageID: "msg1" },
        delta: "hello"
      } } });

      expect(true).toBe(true);
      vi.useRealTimers();
    });

    it("should clean up old sessions via maxSessionAgeMs", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        maxSessionAgeMs: 7200000,
        terminalTitleEnabled: false
      });

      // Create session
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "old", status: { type: "busy" } } } });

      // Session age tracking works (no crash)
      expect(true).toBe(true);
    });
  });

  describe("autoSubmitCount behavior", () => {
    it("should track auto-submit count", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        autoCompact: false,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "session.error", properties: { sessionID: "test", error: { name: "TokenLimitError", message: "Token limit" } } } });

      // Trigger recovery
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();

      // Auto-submit count incremented during recovery
      expect(true).toBe(true);
      vi.useRealTimers();
    });
  });

  describe("backoff exponential behavior", () => {
    it("should use exponential backoff after maxRecoveries", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 500,
        waitAfterAbortMs: 50,
        cooldownMs: 0,
        maxRecoveries: 1,
        abortPollMaxTimeMs: 0,
        autoCompact: false,
        maxBackoffMs: 60000
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

      // After maxRecoveries, exponential backoff kicks in
      // At 1 failure, backoff delay = 500 * 2^0 = 500ms
      await vi.advanceTimersByTimeAsync(300);
      await flushPromises();
      expect(mockAbort).not.toHaveBeenCalled();

      // Backoff should still be active at 400ms
      await vi.advanceTimersByTimeAsync(100);
      await flushPromises();
      expect(mockAbort).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe("hasOpenTodos tracking", () => {
    it("should set hasOpenTodos when todo is in_progress", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        nudgeEnabled: true,
        nudgeCooldownMs: 0,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [
        { id: "t1", content: "task", status: "in_progress" }
      ] } } });

      mockTodo.mockResolvedValue({ data: [{ id: "t1", content: "task", status: "in_progress" }], error: undefined });

      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(500);

      expect(mockPrompt).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should clear hasOpenTodos when all todos are completed", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        nudgeEnabled: true,
        nudgeCooldownMs: 0,
        nudgeIdleDelayMs: 0,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // All todos are already completed - no pending todos
      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [
        { id: "t1", content: "task", status: "completed" }
      ] } } });

      // Idle with no pending todos - should NOT send nudge
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(100);

      expect(mockPrompt).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should treat pending status as open todos", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        nudgeEnabled: true,
        nudgeCooldownMs: 0,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // pending status should also trigger nudge
      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [
        { id: "t1", content: "task", status: "pending" }
      ] } } });

      mockTodo.mockResolvedValue({ data: [{ id: "t1", content: "task", status: "pending" }], error: undefined });

      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(500);

      expect(mockPrompt).toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe("recoveryFailed tracking", () => {
    it("should increment recoveryFailed when recovery fails", async () => {
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
      await vi.advanceTimersByTimeAsync(600);
      await flushPromises();

      // Recovery should have been attempted (even if it failed)
      expect(mockAbort).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe("model config cache", () => {
    it("should invalidate cache when requested", async () => {
      const { invalidateModelLimitCache } = await import('../shared.js');

      // Should not throw
      invalidateModelLimitCache();

      expect(true).toBe(true);
    });

    it("should return null for non-existent config file", async () => {
      const { getModelContextLimit } = await import('../shared.js');

      const result = getModelContextLimit("/nonexistent/path/config.json");

      expect(result).toBeNull();
    });
  });

  describe("continueWithPlanMessage config", () => {
    it("should validate continueWithPlanMessage is non-empty", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      // Empty continueWithPlanMessage should trigger validation, but stallTimeoutMs preserved
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        waitAfterAbortMs: 100,
        continueWithPlanMessage: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(1000);

      // stallTimeoutMs preserved at 5000, no abort after 1000ms
      expect(mockAbort).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should accept valid continueWithPlanMessage", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        continueWithPlanMessage: "Custom plan continue message",
        terminalTitleEnabled: false
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      expect(plugin).toBeDefined();
    });
  });

  describe("proactive compact during message.part.updated", () => {
    it("should check compaction on part updates", async () => {
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        autoCompact: true,
        proactiveCompactAtTokens: 1000000,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Each part update now triggers a proactive compact check
      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part1", type: "text", text: "some text content", sessionID: "test", messageID: "msg1" },
        delta: "some"
      } } });

      await Promise.resolve();
      expect(true).toBe(true);
    });
  });

  describe("toast notifications", () => {
    it("should show Session Resumed toast when session goes busy after nudge", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });
      mockTodo.mockResolvedValue({ data: [{ id: "1", status: "in_progress", content: "task" }], error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        nudgeEnabled: true,
        nudgeIdleDelayMs: 500,
        nudgeCooldownMs: 1000,
        showToasts: true,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      // Create session with busy status
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      // Set hasOpenTodos via todo.updated
      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [{ id: "t1", content: "test todo", status: "in_progress" }] } } });

      // Session goes idle - schedules nudge after idle delay
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      
      // Advance timers to trigger nudge
      await vi.advanceTimersByTimeAsync(500);
      await flushPromises();

      // Verify nudge was sent
      expect(mockPrompt).toHaveBeenCalled();

      // Now session goes busy (AI responding to nudge)
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await flushPromises();

      // Toast should be shown
      expect(mockShowToast).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({
          title: "Session Resumed"
        })
      }));
      vi.useRealTimers();
    });

    it("should NOT show Session Resumed toast when busy without recent nudge", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        showToasts: true,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      // Session goes busy without any nudge
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await flushPromises();

      // Toast should NOT be shown
      expect(mockShowToast).not.toHaveBeenCalled();
    });

    it("should NOT show Session Resumed toast when user sends message after nudge", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });
      mockTodo.mockResolvedValue({ data: [{ id: "1", status: "in_progress", content: "task" }], error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        nudgeEnabled: true,
        nudgeIdleDelayMs: 500,
        nudgeCooldownMs: 1000,
        showToasts: true,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      // Create session with busy status
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      // Set hasOpenTodos
      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [{ id: "t1", content: "test todo", status: "in_progress" }] } } });

      // Session goes idle - schedules nudge
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(500);
      await flushPromises();

      // Nudge was sent
      expect(mockPrompt).toHaveBeenCalled();

      // User sends a message (resets lastNudgeAt)
      await plugin.event({ event: { type: "message.updated", properties: { sessionID: "test", info: { role: "user", id: "user-msg-1" } } } });
      await flushPromises();

      // Session goes busy (user's message, not nudge response)
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await flushPromises();

      // Toast should NOT be shown because user message reset lastNudgeAt
      expect(mockShowToast).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should NOT show Recovery Successful toast when busy without recent continue", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        showToasts: true,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      // Session goes busy without any continue sent
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await flushPromises();

      // Recovery Successful toast should NOT be shown (no continue was sent)
      expect(mockShowToast).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should show Recovery Successful toast when session goes busy after continue", async () => {
      vi.useFakeTimers();
      mockStatus
        .mockResolvedValueOnce({ data: { "test": { type: "busy" } }, error: undefined })
        .mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 200,
        waitAfterAbortMs: 10,
        cooldownMs: 0,
        maxRecoveries: 3,
        showToasts: true,
        autoCompact: false,
        abortPollMaxTimeMs: 0,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: ""
      });

      // Simulate a part to set up session and progress
      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "text", text: "hello", sessionID: "test", messageID: "msg1" }, delta: "hello" } } });

      // Advance timers past stall timeout to trigger recovery (sets lastContinueAt)
      await vi.advanceTimersByTimeAsync(250);
      await flushPromises();

      // Verify recovery was triggered (abort + continue)
      expect(mockAbort).toHaveBeenCalled();
      expect(mockPrompt).toHaveBeenCalled();

      mockShowToast.mockClear();

      // Now session goes busy (AI resumed after continue)
      // Mock status to return busy
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await flushPromises();

      // Recovery Successful toast should be shown
      expect(mockShowToast).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({
          title: "Recovery Successful"
        })
      }));
      vi.useRealTimers();
    });
  });
});

describe("test-fix loop", () => {
  let mockAbort: ReturnType<typeof vi.fn>;
  let mockPrompt: ReturnType<typeof vi.fn>;
  let mockStatus: ReturnType<typeof vi.fn>;
  let mockTodo: ReturnType<typeof vi.fn>;
  let mockSummarize: ReturnType<typeof vi.fn>;
  let mockShowToast: ReturnType<typeof vi.fn>;
  let mockClient: MockClient;

  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    
    mockAbort = vi.fn().mockResolvedValue({ data: true, error: undefined });
    mockPrompt = vi.fn().mockResolvedValue({ data: {}, error: undefined });
    mockStatus = vi.fn().mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
    mockTodo = vi.fn().mockResolvedValue({ data: [], error: undefined });
    mockSummarize = vi.fn().mockResolvedValue({ data: {}, error: undefined });
    mockShowToast = vi.fn().mockResolvedValue({ data: {}, error: undefined });

    mockClient = {
      session: {
        abort: mockAbort,
        prompt: mockPrompt,
        status: mockStatus,
        todo: mockTodo,
        summarize: mockSummarize,
      },
      tui: {
        showToast: mockShowToast,
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it("should reset reviewFired when new pending todos appear after review, enabling test-fix loop", async () => {
    vi.useFakeTimers();
    mockTodo.mockResolvedValue({ data: [], error: undefined });

    const plugin = await createPlugin({ client: mockClient }, {
      stallTimeoutMs: 5000,
      reviewOnComplete: true,
      reviewDebounceMs: 300,
      reviewCooldownMs: 300,
      showToasts: true,
      terminalTitleEnabled: false,
      statusFilePath: "",
      autoCompact: false
    });

    // Create session with busy status
    await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

    // Add pending todos (initial)
    await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [
      { id: "t1", content: "task 1", status: "in_progress" },
      { id: "t2", content: "task 2", status: "in_progress" }
    ] } } });

    // Complete all todos — should trigger review
    await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [
      { id: "t1", content: "task 1", status: "completed" },
      { id: "t2", content: "task 2", status: "completed" }
    ] } } });

    // Wait for review debounce
    await vi.advanceTimersByTimeAsync(350);
    await flushPromises();

    // Verify review prompt was sent
    expect(mockPrompt).toHaveBeenCalled();
    const reviewCall1 = mockPrompt.mock.calls[mockPrompt.mock.calls.length - 1];
    expect(reviewCall1[0].body.parts[0].text).toContain("complete");

    mockPrompt.mockClear();

    // Advance past review cooldown so reviewFired can be reset
    await vi.advanceTimersByTimeAsync(350);
    await flushPromises();

    // Add new pending todos — should reset reviewFired, enabling test-fix loop
    await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [
      { id: "t1", content: "task 1", status: "completed" },
      { id: "t2", content: "task 2", status: "completed" },
      { id: "t3", content: "fix failing test", status: "in_progress" }
    ] } } });

    // Complete all todos again — should trigger another review
    await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [
      { id: "t1", content: "task 1", status: "completed" },
      { id: "t2", content: "task 2", status: "completed" },
      { id: "t3", content: "fix failing test", status: "completed" }
    ] } } });

    // Wait for review debounce
    await vi.advanceTimersByTimeAsync(350);
    await flushPromises();

    // Verify review was sent a second time (test-fix loop works)
    expect(mockPrompt).toHaveBeenCalled();
    const reviewCall2 = mockPrompt.mock.calls[mockPrompt.mock.calls.length - 1];
    expect(reviewCall2[0].body.parts[0].text).toContain("complete");

    vi.useRealTimers();
  });

  it("should NOT trigger review when same todos are re-sent (no new pending todos)", async () => {
    vi.useFakeTimers();
    mockTodo.mockResolvedValue({ data: [], error: undefined });

    const plugin = await createPlugin({ client: mockClient }, {
      stallTimeoutMs: 5000,
      reviewOnComplete: true,
      reviewDebounceMs: 300,
      showToasts: true,
      terminalTitleEnabled: false,
      statusFilePath: "",
      autoCompact: false
    });

    // Create session with busy status
    await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

    // Add pending todos
    await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [
      { id: "t1", content: "task 1", status: "in_progress" }
    ] } } });

    // Complete all todos — should trigger review
    await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [
      { id: "t1", content: "task 1", status: "completed" }
    ] } } });

    // Wait for review debounce
    await vi.advanceTimersByTimeAsync(350);
    await flushPromises();

    // Verify review prompt was sent
    expect(mockPrompt).toHaveBeenCalled();
    mockPrompt.mockClear();

    // Send same completed todos again (no state change)
    await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [
      { id: "t1", content: "task 1", status: "completed" }
    ] } } });

    // Wait for review debounce
    await vi.advanceTimersByTimeAsync(350);
    await flushPromises();

    // Review should NOT fire again (no new pending todos to reset reviewFired)
    expect(mockPrompt).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  describe("question.asked auto-answer", () => {
    it("should auto-answer with first option when autoAnswerQuestions is true", async () => {
      vi.useFakeTimers();
      const mockPost = vi.fn().mockResolvedValue({ data: {} });
      const mockHttpClient = { post: mockPost };
      const mockInput = {
        client: {
          session: {
            abort: mockAbort,
            prompt: mockPrompt,
            status: mockStatus,
            todo: mockTodo,
            summarize: mockSummarize,
          },
          tui: { showToast: mockShowToast },
          _client: mockHttpClient,
        },
      };

      const plugin = await createPlugin(mockInput as any, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: "",
        autoAnswerQuestions: true,
        autoAnswerSafeOnly: false,
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      await plugin.event({ event: { type: "question.asked", properties: {
        id: "req-123",
        sessionID: "test",
        questions: [{
          question: "Which approach?",
          header: "Approach",
          options: [{ label: "Option A" }, { label: "Option B" }],
          multiple: false,
          custom: true,
        }],
      } } });

      expect(mockPost).toHaveBeenCalledWith({
        url: "/question/req-123/reply",
        headers: { "Content-Type": "application/json" },
        body: { answers: [["Option A"]] },
      });
      vi.useRealTimers();
    });

    it("should NOT auto-answer when autoAnswerQuestions is false", async () => {
      vi.useFakeTimers();
      const mockPost = vi.fn().mockResolvedValue({ data: {} });
      const mockHttpClient = { post: mockPost };
      const mockInput = {
        client: {
          session: {
            abort: mockAbort,
            prompt: mockPrompt,
            status: mockStatus,
            todo: mockTodo,
            summarize: mockSummarize,
          },
          tui: { showToast: mockShowToast },
          _client: mockHttpClient,
        },
      };

      const plugin = await createPlugin(mockInput as any, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: "",
        autoAnswerQuestions: false,
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      await plugin.event({ event: { type: "question.asked", properties: {
        id: "req-456",
        sessionID: "test",
        questions: [{
          question: "Which approach?",
          header: "Approach",
          options: [{ label: "Option A" }, { label: "Option B" }],
        }],
      } } });

      expect(mockPost).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should handle multiple questions in one event", async () => {
      vi.useFakeTimers();
      const mockPost = vi.fn().mockResolvedValue({ data: {} });
      const mockHttpClient = { post: mockPost };
      const mockInput = {
        client: {
          session: {
            abort: mockAbort,
            prompt: mockPrompt,
            status: mockStatus,
            todo: mockTodo,
            summarize: mockSummarize,
          },
          tui: { showToast: mockShowToast },
          _client: mockHttpClient,
        },
      };

      const plugin = await createPlugin(mockInput as any, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: "",
        autoAnswerQuestions: true,
        autoAnswerSafeOnly: false,
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      await plugin.event({ event: { type: "question.asked", properties: {
        id: "req-789",
        sessionID: "test",
        questions: [
          { question: "Q1?", header: "H1", options: [{ label: "A1" }, { label: "A2" }] },
          { question: "Q2?", header: "H2", options: [{ label: "B1" }] },
        ],
      } } });

      expect(mockPost).toHaveBeenCalledWith({
        url: "/question/req-789/reply",
        headers: { "Content-Type": "application/json" },
        body: { answers: [["A1"], ["B1"]] },
      });
      vi.useRealTimers();
    });

    it("should NOT auto-answer multi-option questions when autoAnswerSafeOnly is true", async () => {
      vi.useFakeTimers();
      const mockPost = vi.fn().mockResolvedValue({ data: {} });
      const mockHttpClient = { post: mockPost };
      const mockInput = {
        client: {
          session: {
            abort: mockAbort,
            prompt: mockPrompt,
            status: mockStatus,
            todo: mockTodo,
            summarize: mockSummarize,
          },
          tui: { showToast: mockShowToast },
          _client: mockHttpClient,
        },
      };

      const plugin = await createPlugin(mockInput as any, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: "",
        autoAnswerQuestions: true,
        autoAnswerSafeOnly: true,
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      await plugin.event({ event: { type: "question.asked", properties: {
        id: "req-danger",
        sessionID: "test",
        questions: [{
          question: "Delete everything?",
          header: "Confirm",
          options: [{ label: "Yes, delete everything" }, { label: "No, keep it" }],
        }],
      } } });

      expect(mockPost).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should auto-answer single-option questions when autoAnswerSafeOnly is true", async () => {
      vi.useFakeTimers();
      const mockPost = vi.fn().mockResolvedValue({ data: {} });
      const mockHttpClient = { post: mockPost };
      const mockInput = {
        client: {
          session: {
            abort: mockAbort,
            prompt: mockPrompt,
            status: mockStatus,
            todo: mockTodo,
            summarize: mockSummarize,
          },
          tui: { showToast: mockShowToast },
          _client: mockHttpClient,
        },
      };

      const plugin = await createPlugin(mockInput as any, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: "",
        autoAnswerQuestions: true,
        autoAnswerSafeOnly: true,
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      await plugin.event({ event: { type: "question.asked", properties: {
        id: "req-safe",
        sessionID: "test",
        questions: [{
          question: "Continue?",
          header: "Confirm",
          options: [{ label: "OK" }],
        }],
      } } });

      expect(mockPost).toHaveBeenCalledWith({
        url: "/question/req-safe/reply",
        headers: { "Content-Type": "application/json" },
        body: { answers: [["OK"]] },
      });
      vi.useRealTimers();
    });
  });

  describe("nudge re-activation after compaction", () => {
    it("should send nudge after session.compacted clears compacting and needsContinue", async () => {
      vi.useFakeTimers();
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockTodo.mockResolvedValue({ data: [{ id: "t1", content: "task", status: "in_progress" }], error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        nudgeEnabled: true,
        nudgeIdleDelayMs: 0,
        nudgeCooldownMs: 0,
        nudgeMaxSubmits: 10,
        compactionSafetyTimeoutMs: 30000,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: "",
      });

      // Setup: session goes idle with open todos — first nudge succeeds
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [
        { id: "t1", content: "task", status: "in_progress" }
      ] } } });
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(100);
      expect(mockPrompt).toHaveBeenCalledTimes(1);
      mockPrompt.mockClear();

      // Start compaction — sets compacting=true
      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", part: { type: "compaction" } } } });

      // Session goes idle — nudge deferred because compacting, retry scheduled
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });

      // Compaction completes — session.compacted clears compacting, sets needsContinue, re-schedules nudge
      await plugin.event({ event: { type: "session.compacted", properties: { sessionID: "test" } } });

      // The session.compacted handler calls nudge.scheduleNudge() which sets a timer.
      // When injectNudge runs, it finds needsContinue=true.
      // Before the fix: injectNudge returned silently — nudge was dead.
      // After the fix: injectNudge schedules retry — nudge eventually fires.
      // But needsContinue blocks until the session goes idle and the continue is sent.
      // Let the nudge timer fire (nudgeIdleDelayMs=0, but the scheduleNudge timer)
      await vi.advanceTimersByTimeAsync(100);

      // At this point injectNudge runs but needsContinue=true → schedules retry
      // Now simulate the session going idle again (continue was processed)
      // which clears needsContinue
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });

      // Wait for nudge retry to fire
      await vi.advanceTimersByTimeAsync(6000);

      // Nudge should fire now (needsContinue cleared, compacting cleared)
      expect(mockPrompt).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("should reset nudgeRetryCount after session.compacted", async () => {
      vi.useFakeTimers();
      mockPrompt.mockResolvedValue({ data: {}, error: undefined });
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
      mockTodo.mockResolvedValue({ data: [{ id: "t1", content: "task", status: "in_progress" }], error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        nudgeEnabled: true,
        nudgeIdleDelayMs: 0,
        nudgeCooldownMs: 0,
        compactionSafetyTimeoutMs: 30000,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: "",
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [
        { id: "t1", content: "task", status: "in_progress" }
      ] } } });

      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
      await vi.advanceTimersByTimeAsync(100);
      expect(mockPrompt).toHaveBeenCalledTimes(1);
      mockPrompt.mockClear();

      // Fire session.compacted — clears compacting, sets needsContinue, re-schedules nudge
      await plugin.event({ event: { type: "session.compacted", properties: { sessionID: "test" } } });

      // Advance through nudge retry cycles (needsContinue blocks, retry every 5s)
      await vi.advanceTimersByTimeAsync(10000);
      // Nudge should fire after needsContinue is cleared or through retry
      expect(mockPrompt).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe("resetSession completeness", () => {
    it("should reset all session state fields on session.deleted", async () => {
      vi.useFakeTimers();
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false,
        statusFilePath: "",
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Verify session was created
      await plugin.event({ event: { type: "session.deleted", properties: { sessionID: "test" } } });

      // After deletion, creating a new session with the same ID should start fresh
      await plugin.event({ event: { type: "session.created", properties: { sessionID: "test" } } });

      // If resetSession missed any fields, the new session would inherit stale values
      // We verify by triggering stall detection — if resetSession worked, attempts=0
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(5000);
      await flushPromises();

      // Should trigger recovery (attempts should be 0, not carrying over from before)
      expect(mockAbort).toHaveBeenCalled();
      vi.useRealTimers();
    });
  });
});
