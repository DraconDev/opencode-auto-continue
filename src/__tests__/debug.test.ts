import { vi, describe, it, expect } from 'vitest';
import type { Plugin } from "@opencode-ai/plugin";

async function createPlugin(input: any, options?: Record<string, unknown>) {
  const { AutoForceResumePlugin } = await import('./index.js');
  return AutoForceResumePlugin(input, options as Parameters<Plugin>[1]);
}

describe("debug planning", () => {
  it("should call abort after planning timeout", async () => {
    vi.useFakeTimers();
    
    const mockAbort = vi.fn().mockResolvedValue({ data: true });
    const mockStatus = vi.fn().mockResolvedValue({ data: { "test": { type: "busy" } } });
    
    const plugin = await createPlugin({
      client: {
        session: {
          abort: mockAbort,
          prompt: vi.fn().mockResolvedValue({}),
          status: mockStatus,
          todo: vi.fn().mockResolvedValue({ data: [] }),
          summarize: vi.fn().mockResolvedValue({}),
          messages: vi.fn().mockResolvedValue({ data: [] }), // Add this!
        },
        tui: {
          showToast: vi.fn().mockResolvedValue({}),
        },
      }
    }, {
      stallTimeoutMs: 100,
      planningTimeoutMs: 200,
      cooldownMs: 0,
      autoCompact: false,
      terminalTitleEnabled: false,
      statusFilePath: "",
      debug: true,
    });

    await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
    
    await plugin.event({ event: { type: "message.part.updated", properties: {
      sessionID: "test",
      messageID: "msg1",
      part: { id: "part1", type: "text", text: "Let me plan this out:\n1. First step", sessionID: "test", messageID: "msg1" },
      delta: "Let me plan this out"
    }}});

    console.log("Before advance: Date.now() =", Date.now());
    await vi.advanceTimersByTimeAsync(250);
    console.log("After advance: Date.now() =", Date.now());
    
    console.log("mockAbort calls:", mockAbort.mock.calls.length);
    expect(mockAbort).toHaveBeenCalled();
    
    vi.useRealTimers();
  });
});
