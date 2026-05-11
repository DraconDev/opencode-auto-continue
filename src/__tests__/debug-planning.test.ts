import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

describe("planning debug", () => {
  let mockAbort: any;
  let mockPrompt: any;
  let mockStatus: any;
  let mockTodo: any;
  let mockSummarize: any;
  let mockShowToast: any;
  let mockClient: any;

  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    
    mockAbort = vi.fn().mockResolvedValue({ data: true, error: undefined });
    mockPrompt = vi.fn().mockResolvedValue({ data: {}, error: undefined });
    mockStatus = vi.fn().mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
    mockTodo = vi.fn().mockResolvedValue({ data: [], error: undefined });
    mockSummarize = vi.fn().mockResolvedValue({ data: {}, error: undefined });
    mockShowToast = vi.fn().mockResolvedValue({ data: {}, error: undefined });

    // CORRECT: match the createPlugin wrapper in plugin.test.ts
    // The plugin expects input.client to have session/tui methods
    mockClient = {
      client: {
        session: { abort: mockAbort, prompt: mockPrompt, status: mockStatus, todo: mockTodo, summarize: mockSummarize },
        tui: { showToast: mockShowToast },
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it("should fire planning timeout and call abort", async () => {
    vi.useFakeTimers();
    
    const { AutoForceResumePlugin } = await import('../index.js');
    const plugin = await AutoForceResumePlugin(
      mockClient as any,
      { stallTimeoutMs: 100, planningTimeoutMs: 200, cooldownMs: 0, waitAfterAbortMs: 50, autoCompact: false, terminalTitleEnabled: false, statusFilePath: "" } as any
    );
    
    await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
    
    console.log('DEBUG: After status(busy), mockAbort calls:', mockAbort.mock.calls.length);
    
    await plugin.event({ event: { type: "message.part.updated", properties: {
      sessionID: "test",
      messageID: "msg1",
      part: { id: "part1", type: "text", text: "Let me plan this out:\n1. First step", sessionID: "test", messageID: "msg1" },
      delta: "Let me plan this out"
    } } });
    
    console.log('DEBUG: After plan event, mockAbort calls:', mockAbort.mock.calls.length);
    
    await vi.advanceTimersByTimeAsync(250);
    
    console.log('DEBUG: After 250ms advance, mockAbort calls:', mockAbort.mock.calls.length);
    console.log('DEBUG: mockAbort mock:', JSON.stringify(mockAbort.mock));
    
    expect(mockAbort).toHaveBeenCalled();
  });
});
