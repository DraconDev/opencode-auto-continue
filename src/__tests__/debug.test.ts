import { vi, describe, it, expect } from 'vitest';

describe("debug recover flow", () => {
  it("should trace recover execution", async () => {
    vi.useFakeTimers();
    
    const mockAbort = vi.fn().mockResolvedValue({ data: true, error: undefined });
    const mockStatus = vi.fn().mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
    
    const mockClient = {
      session: {
        abort: mockAbort,
        prompt: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
        status: mockStatus,
        todo: vi.fn().mockResolvedValue({ data: [], error: undefined }),
        summarize: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
      },
    };
    
    const { AutoForceResumePlugin } = await import('../src/index.js');
    const plugin = await AutoForceResumePlugin({ client: mockClient } as any, { 
      stallTimeoutMs: 5000, 
      waitAfterAbortMs: 100,
      cooldownMs: 0,
      abortPollMaxTimeMs: 0,
      terminalTitleEnabled: false, 
      terminalProgressEnabled: false, 
      statusFilePath: "",
      debug: true
    });
    
    await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.resolve();
    
    console.log('mockAbort calls:', mockAbort.mock.calls.length);
    console.log('mockStatus calls:', mockStatus.mock.calls.length);
    
    expect(mockAbort).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
