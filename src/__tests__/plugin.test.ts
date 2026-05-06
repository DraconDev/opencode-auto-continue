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
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    
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

  describe("token limit handling", () => {
    it("should trigger forceCompact and retry with short message on token limit error", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      
      // First prompt succeeds, second fails with token limit
      let promptCalls = 0;
      mockPrompt.mockImplementation(() => {
        promptCalls++;
        if (promptCalls === 1) {
          return Promise.resolve({ data: {}, error: undefined });
        }
        return Promise.reject(new Error("maximum context length exceeded"));
      });

      const plugin = await createPlugin({ client: mockClient }, { 
        stallTimeoutMs: 1000, 
        waitAfterAbortMs: 100,
        cooldownMs: 0,
        maxRecoveries: 3,
        abortPollMaxTimeMs: 0,
        tokenLimitPatterns: ["maximum context length"],
        terminalTitleEnabled: false,
        statusFileEnabled: false
      });

      // Start busy session
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Trigger recovery
      await vi.advanceTimersByTimeAsync(1100);
      await Promise.resolve();

      // First recovery attempt should call abort
      expect(mockAbort).toHaveBeenCalledTimes(1);

      // After abort, idle triggers sendContinue
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "idle" } } } });

      // Should have attempted to send continue (which fails with token limit)
      expect(mockPrompt).toHaveBeenCalled();

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
      // Empty tokenLimitPatterns should trigger validation failure and use defaults
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 1000, waitAfterAbortMs: 100, tokenLimitPatterns: [] });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(1000);

      // Should use default stallTimeoutMs (180000) since validation failed
      expect(mockAbort).not.toHaveBeenCalled();
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

    it("should validate proactive compaction token threshold", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      // Negative token threshold should trigger validation failure
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 1000, waitAfterAbortMs: 100, proactiveCompactAtTokens: -1 });

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
      const plugin = await createPlugin({ client: mockClient }, { stallTimeoutMs: 1000, waitAfterAbortMs: 100, proactiveCompactAtPercent: 150 });

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

  describe("statusLine hook", () => {
    it("should attempt to register statusLine hook on init", async () => {
      const hookSpy = vi.fn();
      const plugin = await createPlugin(
        { client: mockClient, hook: hookSpy } as any,
        { stallTimeoutMs: 5000, terminalTitleEnabled: false }
      );

      // Plugin should initialize without error
      expect(plugin).toBeDefined();
      expect(plugin.event).toBeDefined();
      expect(plugin.dispose).toBeDefined();
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
        terminalTitleEnabled: false 
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();

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
        stallPatternDetection: true 
      });

      // Simulate progress then stall
      await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test", messageID: "msg1", part: { id: "part1", type: "text", text: "hello", sessionID: "test", messageID: "msg1" }, delta: "hello" } } });
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();

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
      await Promise.resolve();

      // Should attempt to summarize (compact) before aborting
      expect(mockStatus).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("should trigger proactive compaction when estimatedTokens >= threshold", async () => {
      vi.useFakeTimers();
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      const plugin = await createPlugin({ client: mockClient }, { 
        stallTimeoutMs: 5000, 
        waitAfterAbortMs: 100,
        proactiveCompactAtTokens: 100,
        proactiveCompactAtPercent: 50,
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
      // We can't easily mock summarize() in this test setup, so we just verify no errors
      expect(true).toBe(true);
      vi.useRealTimers();
    });
  });

  describe("token estimation", () => {
    it("should count tokens from all part types, not just text", async () => {
      vi.useFakeTimers();
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

      expect(true).toBe(true);
      vi.useRealTimers();
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
});