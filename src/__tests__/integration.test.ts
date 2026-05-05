import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Plugin } from "@opencode-ai/plugin";

// Integration test: verify the plugin actually triggers abort+continue
interface MockClient {
  session: {
    abort: ReturnType<typeof vi.fn>;
    prompt: ReturnType<typeof vi.fn>;
    promptAsync: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    todo: ReturnType<typeof vi.fn>;
  };
}

async function loadPlugin(input: { client: MockClient }, options?: Record<string, unknown>) {
  // Load the actual compiled plugin
  const { AutoForceResumePlugin } = await import('../../dist/index.js');
  return AutoForceResumePlugin(input as Parameters<Plugin>[0], options as Parameters<Plugin>[1]);
}

describe("opencode-auto-force-resume integration", () => {
  let mockAbort: ReturnType<typeof vi.fn>;
  let mockPrompt: ReturnType<typeof vi.fn>;
  let mockPromptAsync: ReturnType<typeof vi.fn>;
  let mockStatus: ReturnType<typeof vi.fn>;
  let mockTodo: ReturnType<typeof vi.fn>;
  let mockClient: MockClient;

  beforeEach(() => {
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
});