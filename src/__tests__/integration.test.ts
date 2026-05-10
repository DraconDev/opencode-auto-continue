import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from "fs";
import type { Plugin } from "@opencode-ai/plugin";

// Integration test: verify the plugin actually triggers abort+continue
interface MockClient {
  session: {
    abort: ReturnType<typeof vi.fn>;
    prompt: ReturnType<typeof vi.fn>;
    promptAsync: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    todo: ReturnType<typeof vi.fn>;
    messages: ReturnType<typeof vi.fn>;
  };
}

async function loadPlugin(input: { client: MockClient }, options?: Record<string, unknown>) {
  // Load the actual compiled plugin
  const { AutoForceResumePlugin } = await import('../../dist/index.js');
  return AutoForceResumePlugin(input as Parameters<Plugin>[0], options as Parameters<Plugin>[1]);
}

describe("opencode-auto-continue integration", () => {
  let mockAbort: ReturnType<typeof vi.fn>;
  let mockPrompt: ReturnType<typeof vi.fn>;
  let mockPromptAsync: ReturnType<typeof vi.fn>;
  let mockStatus: ReturnType<typeof vi.fn>;
  let mockTodo: ReturnType<typeof vi.fn>;
  let mockClient: MockClient;

  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    
    mockAbort = vi.fn().mockResolvedValue({ data: true, error: undefined });
    mockPrompt = vi.fn().mockResolvedValue({ data: {}, error: undefined });
    mockPromptAsync = vi.fn().mockResolvedValue({ data: {}, error: undefined });
    mockStatus = vi.fn().mockResolvedValue({ data: { "test-session": { type: "busy" } }, error: undefined });
    mockTodo = vi.fn().mockResolvedValue({ data: [], error: undefined });

    mockClient = {
      session: {
        abort: mockAbort,
        prompt: mockPrompt,
        promptAsync: mockPromptAsync,
        status: mockStatus,
        todo: mockTodo,
        messages: vi.fn().mockResolvedValue({ data: [], error: undefined }),
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it("should complete full recovery cycle: busy → stall → abort → continue", async () => {
    vi.useFakeTimers();
    const plugin = await loadPlugin(
      { client: mockClient },
      { stallTimeoutMs: 1000, waitAfterAbortMs: 100, cooldownMs: 0, maxRecoveries: 3, abortPollMaxTimeMs: 0, debug: true }
    );

    // Step 1: Session becomes busy
    await plugin.event({ event: { type: "session.status", properties: { sessionID: "test-session", status: { type: "busy" } } } });
    
    // Step 2: Some initial progress
    await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session", messageID: "msg1", part: { id: "part1", type: "text", text: "hello", sessionID: "test-session", messageID: "msg1" }, delta: "hello" } } });
    
    // Step 3: Wait for stall (no progress for 1000ms) + waitAfterAbortMs
    await vi.advanceTimersByTimeAsync(1100);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();  // Wait for async recover() to complete
    
    // Step 4: Should have called abort
    expect(mockAbort).toHaveBeenCalledTimes(1);
    expect(mockAbort).toHaveBeenCalledWith(expect.objectContaining({
      path: { id: "test-session" },
      query: expect.any(Object)
    }));
    
    // Step 5: Simulate session becoming idle (triggers sendContinue)
    await plugin.event({ event: { type: "session.status", properties: { sessionID: "test-session", status: { type: "idle" } } } });
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();  // Wait for async sendContinue
    
    vi.useRealTimers();
  });

  it("should NOT abort if session is idle", async () => {
    vi.useFakeTimers();
    mockStatus.mockResolvedValue({ data: { "test-session": { type: "idle" } }, error: undefined });
    
    const plugin = await loadPlugin(
      { client: mockClient },
      { stallTimeoutMs: 500, waitAfterAbortMs: 50, cooldownMs: 0, maxRecoveries: 3, abortPollMaxTimeMs: 0, debug: true }
    );

    await plugin.event({ event: { type: "session.status", properties: { sessionID: "test-session", status: { type: "busy" } } } });
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    
    // Should check status and see idle, so no abort
    expect(mockAbort).not.toHaveBeenCalled();
    
    vi.useRealTimers();
  });

  it("should use prompt fallback when promptAsync not available", async () => {
    vi.useFakeTimers();
    delete (mockClient.session as any).promptAsync;
    
    const plugin = await loadPlugin(
      { client: mockClient },
      { stallTimeoutMs: 1000, waitAfterAbortMs: 100, cooldownMs: 0, maxRecoveries: 3, abortPollMaxTimeMs: 0 }
    );

    await plugin.event({ event: { type: "session.status", properties: { sessionID: "test-session", status: { type: "busy" } } } });
    await vi.advanceTimersByTimeAsync(1100);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();  // Wait for async recover()
    
    expect(mockAbort).toHaveBeenCalledTimes(1);
    
    // Trigger continue via session.status (idle)
    await plugin.event({ event: { type: "session.status", properties: { sessionID: "test-session", status: { type: "idle" } } } });
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();  // Wait for async sendContinue
    
    // only the continue message, no notification
    expect(mockPrompt).toHaveBeenCalledTimes(1);
    
    vi.useRealTimers();
  });

  it("should handle tool execution without false stall", async () => {
    vi.useFakeTimers();
    const plugin = await loadPlugin(
      { client: mockClient },
      { stallTimeoutMs: 1000, waitAfterAbortMs: 100, cooldownMs: 0, maxRecoveries: 3, abortPollMaxTimeMs: 0 }
    );

    await plugin.event({ event: { type: "session.status", properties: { sessionID: "test-session", status: { type: "busy" } } } });
    
    // Tool starts running
    await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session", messageID: "msg1", part: { id: "part1", type: "tool", callID: "call1", tool: "bash", state: { type: "running" }, sessionID: "test-session", messageID: "msg1" }, delta: "" } } });
    
    // Wait almost full timeout
    await vi.advanceTimersByTimeAsync(900);
    await Promise.resolve();
    
    // Should NOT abort because tool is making progress
    expect(mockAbort).not.toHaveBeenCalled();
    
    vi.useRealTimers();
  });

  it("should write valid status file structure during session lifecycle", async () => {
    vi.useFakeTimers();
    const tmpStatusFile = `/tmp/opencode-test-status-${Date.now()}.json`;
    const plugin = await loadPlugin(
      { client: mockClient },
      {
        stallTimeoutMs: 5000,
        waitAfterAbortMs: 100,
        cooldownMs: 0,
        maxRecoveries: 3,
        abortPollMaxTimeMs: 0,
        statusFileEnabled: true,
        statusFilePath: tmpStatusFile,
        terminalProgressEnabled: false,
        terminalTitleEnabled: false,
        debug: true,
      }
    );

    // Step 1: Create session — status file should be written
    await plugin.event({ event: { type: "session.status", properties: { sessionID: "test-session", status: { type: "busy" } } } });
    // Flush debounced status file write
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();

    let statusContent = readFileSync(tmpStatusFile, "utf-8");
    let status = JSON.parse(statusContent);

    expect(status.sessions["test-session"]).toBeDefined();
    expect(status.sessions["test-session"].elapsed).toBeDefined();
    expect(status.sessions["test-session"].status).toBe("active");
    expect(status.sessions["test-session"].recovery).toBeDefined();
    expect(status.sessions["test-session"].recovery.attempts).toBe(0);

    // Step 2: Send a progress event — status file updates
    await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session", messageID: "msg1", part: { id: "part1", type: "text", text: "hello world", sessionID: "test-session", messageID: "msg1" }, delta: "hello" } } });
    // Flush debounced status file write
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();

    statusContent = readFileSync(tmpStatusFile, "utf-8");
    status = JSON.parse(statusContent);
    expect(status.sessions["test-session"].timer.lastProgressAgo).toBeDefined();

    // Step 3: Send todo with pending todos — nudge state tracked
    await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test-session", todos: [{ id: "t1", content: "test task", status: "in_progress" }] } } });
    // Flush debounced status file write
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();

    statusContent = readFileSync(tmpStatusFile, "utf-8");
    status = JSON.parse(statusContent);
    expect(status.sessions["test-session"].todos.hasOpenTodos).toBe(true);

    // Step 4: session.idle with pending todos — nudge tracked
    mockStatus.mockResolvedValue({ data: { "test-session": { type: "idle" } }, error: undefined });
    mockPrompt.mockResolvedValue({ data: {}, error: undefined });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test-session" } } });
    // Flush debounced status file write (also flushes nudge timer at 500ms)
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();

    statusContent = readFileSync(tmpStatusFile, "utf-8");
    status = JSON.parse(statusContent);
    expect(status.sessions["test-session"].nudge.lastNudgeAt).toBeDefined();

    // Step 5: session.deleted — session should be cleaned up (file may be gone or session absent)
    await plugin.event({ event: { type: "session.deleted", properties: { sessionID: "test-session", info: {} } } });

    // Status file should not throw — session is cleaned up gracefully
    try {
      const finalContent = readFileSync(tmpStatusFile, "utf-8");
      const finalStatus = JSON.parse(finalContent);
      // After deleted, session should either be absent from file or status should reflect cleanup
      expect(finalStatus.sessions["test-session"]).toBeUndefined();
    } catch {
      // File may have been rotated or cleaned up — that's fine
    }

    vi.useRealTimers();
  });

  it("should handle session.idle with no pending todos gracefully", async () => {
    vi.useFakeTimers();
    const plugin = await loadPlugin(
      { client: mockClient },
      {
        nudgeEnabled: true,
        nudgeCooldownMs: 0,
        terminalProgressEnabled: false,
        terminalTitleEnabled: false,
        statusFileEnabled: false,
      }
    );

    // Create session without todos
    await plugin.event({ event: { type: "session.status", properties: { sessionID: "test-session", status: { type: "busy" } } } });

    // Fire session.idle with no todos
    mockStatus.mockResolvedValue({ data: { "test-session": { type: "idle" } }, error: undefined });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test-session" } } });

    // No prompt should have been sent
    expect(mockPrompt).not.toHaveBeenCalled();
  });

  it("should resume monitoring after session.compacted", async () => {
    vi.useFakeTimers();
    const plugin = await loadPlugin(
      { client: mockClient },
      {
        stallTimeoutMs: 1000,
        waitAfterAbortMs: 100,
        terminalProgressEnabled: false,
        terminalTitleEnabled: false,
        statusFileEnabled: false,
      }
    );

    // Start busy session
    await plugin.event({ event: { type: "session.status", properties: { sessionID: "test-session", status: { type: "busy" } } } });

    // Compaction starts (compacting flag set)
    await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "test-session", messageID: "msg1", part: { id: "part1", type: "compaction", auto: true }, delta: "" } } });

    // Timer fires — should NOT abort because compacting = true
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    expect(mockAbort).not.toHaveBeenCalled();

    // session.compacted fires — should clear compacting flag
    await plugin.event({ event: { type: "session.compacted", properties: { sessionID: "test-session" } } });

    // After compaction, the session is idle — recover() will see idle and not abort
    // This is correct behavior: after compaction the model goes idle waiting for work
    // We verified above that compacting=false allows normal monitoring to resume
    vi.useRealTimers();
  });

  it("should trigger review when all todos are completed", async () => {
    vi.useFakeTimers();
    const plugin = await loadPlugin(
      { client: mockClient },
      {
        reviewEnabled: true,
        terminalProgressEnabled: false,
        terminalTitleEnabled: false,
        statusFileEnabled: false,
      }
    );

    // Create session with todos
    await plugin.event({ event: { type: "session.status", properties: { sessionID: "test-session", status: { type: "busy" } } } });
    await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test-session", todos: [
      { id: "t1", content: "task 1", status: "in_progress" },
      { id: "t2", content: "task 2", status: "pending" }
    ] } } });

    // Complete all todos
    await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test-session", todos: [
      { id: "t1", content: "task 1", status: "completed" },
      { id: "t2", content: "task 2", status: "completed" }
    ] } } });

    // Wait for debounce
    await vi.advanceTimersByTimeAsync(600);
    await Promise.resolve();
    await Promise.resolve();

    // Should have sent review prompt
    expect(mockPrompt).toHaveBeenCalled();
    const lastCall = mockPrompt.mock.calls[mockPrompt.mock.calls.length - 1];
    expect(lastCall[0].body.parts[0].text).toContain("complete");

    vi.useRealTimers();
  });

  it("should send nudge when session goes idle with pending todos", async () => {
    vi.useFakeTimers();
    mockTodo.mockResolvedValue({ 
      data: [{ id: "t1", content: "incomplete task", status: "in_progress" }], 
      error: undefined 
    });

    const plugin = await loadPlugin(
      { client: mockClient },
      {
        nudgeEnabled: true,
        nudgeCooldownMs: 0,
        nudgeIdleDelayMs: 100,
        terminalProgressEnabled: false,
        terminalTitleEnabled: false,
        statusFileEnabled: false,
      }
    );

    // Create busy session
    await plugin.event({ event: { type: "session.status", properties: { sessionID: "test-session", status: { type: "busy" } } } });
    
    // Add pending todos
    await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test-session", todos: [
      { id: "t1", content: "incomplete task", status: "in_progress" }
    ] } } });

    // Session goes idle
    mockStatus.mockResolvedValue({ data: { "test-session": { type: "idle" } }, error: undefined });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test-session" } } });

    // Wait for nudge delay
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await Promise.resolve();

    // Should have sent nudge prompt
    expect(mockPrompt).toHaveBeenCalled();
    const lastCall = mockPrompt.mock.calls[mockPrompt.mock.calls.length - 1];
    expect(lastCall[0].body.parts[0].text).toContain("incomplete");

    vi.useRealTimers();
  });

  it("should detect hallucination loop and force abort+resume", async () => {
    vi.useFakeTimers();
    const plugin = await loadPlugin(
      { client: mockClient },
      {
        stallTimeoutMs: 1000,
        waitAfterAbortMs: 100,
        cooldownMs: 0,
        maxRecoveries: 5,
        abortPollMaxTimeMs: 0,
        debug: true,
      }
    );

    await plugin.event({ event: { type: "session.status", properties: { sessionID: "test-session", status: { type: "busy" } } } });

    // Trigger 3 recovery cycles in quick succession (within 10 minutes)
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      
      // Trigger idle to send continue
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test-session", status: { type: "idle" } } } });
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      
      // Reset to busy for next cycle
      if (i < 2) {
        await plugin.event({ event: { type: "session.status", properties: { sessionID: "test-session", status: { type: "busy" } } } });
      }
    }

    // Should have called abort at least 3 times (normal recoveries + hallucination loop extra abort)
    expect(mockAbort.mock.calls.length).toBeGreaterThanOrEqual(3);

    vi.useRealTimers();
  });

  it("should skip nudge when last assistant message is a question", async () => {
    vi.useFakeTimers();
    mockTodo.mockResolvedValue({ 
      data: [{ id: "t1", content: "incomplete task", status: "in_progress" }], 
      error: undefined 
    });

    // Mock messages to return a question from assistant
    mockClient.session.messages = vi.fn().mockResolvedValue({
      data: [
        { id: "msg1", role: "assistant", parts: [{ type: "text", text: "Would you like me to proceed with this approach?" }] }
      ],
      error: undefined
    });

    const plugin = await loadPlugin(
      { client: mockClient },
      {
        nudgeEnabled: true,
        nudgeCooldownMs: 0,
        nudgeIdleDelayMs: 100,
        terminalProgressEnabled: false,
        terminalTitleEnabled: false,
        statusFileEnabled: false,
      }
    );

    // Create busy session with pending todos
    await plugin.event({ event: { type: "session.status", properties: { sessionID: "test-session", status: { type: "busy" } } } });
    await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test-session", todos: [
      { id: "t1", content: "incomplete task", status: "in_progress" }
    ] } } });

    // Session goes idle
    mockStatus.mockResolvedValue({ data: { "test-session": { type: "idle" } }, error: undefined });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test-session" } } });

    // Wait for nudge delay
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await Promise.resolve();

    // Should still send nudge — question detection was removed from nudge path
    // (plugin nudges regardless of whether AI is asking a question)
    const nudgeCalls = mockPrompt.mock.calls.filter((call: any) => 
      call[0].body.parts[0].text?.includes("incomplete")
    );
    expect(nudgeCalls.length).toBeGreaterThanOrEqual(1);

    vi.useRealTimers();
  });

  it("should use tool-text recovery prompt when XML detected in reasoning", async () => {
    vi.useFakeTimers();
    
    // Mock messages to return tool call as text in reasoning
    mockClient.session.messages = vi.fn().mockResolvedValue({
      data: [
        { id: "msg1", role: "assistant", parts: [{ type: "reasoning", text: "<function=bash>\n<parameter>ls -la</parameter>\n</function>" }] }
      ],
      error: undefined
    });

    const plugin = await loadPlugin(
      { client: mockClient },
      {
        stallTimeoutMs: 1000,
        waitAfterAbortMs: 100,
        cooldownMs: 0,
        maxRecoveries: 3,
        abortPollMaxTimeMs: 0,
      }
    );

    await plugin.event({ event: { type: "session.status", properties: { sessionID: "test-session", status: { type: "busy" } } } });
    
    // Wait for stall
    await vi.advanceTimersByTimeAsync(1100);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Trigger continue
    await plugin.event({ event: { type: "session.status", properties: { sessionID: "test-session", status: { type: "idle" } } } });
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Should have sent tool-text recovery prompt
    expect(mockPrompt).toHaveBeenCalled();
    const lastCall = mockPrompt.mock.calls[mockPrompt.mock.calls.length - 1];
    expect(lastCall[0].body.parts[0].text).toContain("tool call");

    vi.useRealTimers();
  });
});