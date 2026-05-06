import { vi } from 'vitest';

async function test() {
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
  
  const { AutoForceResumePlugin } = await import('./src/index.js');
  const plugin = await AutoForceResumePlugin({ client: mockClient } as any, { stallTimeoutMs: 5000, terminalTitleEnabled: false, terminalProgressEnabled: false, statusFilePath: "" });
  
  console.log('Before event - Date.now():', Date.now());
  await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
  console.log('After event - Date.now():', Date.now());
  
  console.log('Advancing 5000ms...');
  await vi.advanceTimersByTimeAsync(5000);
  console.log('After advance - Date.now():', Date.now());
  
  console.log('mockAbort called:', mockAbort.mock.calls.length, 'times');
  console.log('mockStatus called:', mockStatus.mock.calls.length, 'times');
  
  vi.useRealTimers();
}

test().catch(console.error);
