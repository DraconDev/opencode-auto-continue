import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Plugin } from "@opencode-ai/plugin";

interface MockClient {
  session: {
    abort: ReturnType<typeof vi.fn>;
    prompt: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    todo: ReturnType<typeof vi.fn>;
    summarize: ReturnType<typeof vi.fn>;
  };
  tui: {
    showToast: ReturnType<typeof vi.fn>;
  };
}

async function createPlugin(input: { client: MockClient }, options?: Record<string, unknown>) {
  const { AutoForceResumePlugin } = await import('../index.js');
  return AutoForceResumePlugin(input as Parameters<Plugin>[0], options as Parameters<Plugin>[1]);
}

describe("debug planning timer", () => {
  let mockAbort: ReturnType<typeof vi.fn>;
  let mockPrompt: ReturnType<typeof vi.fn>;
  let mockStatus: ReturnType<typeof vi.fn>;
  let mockShowToast: ReturnType<typeof vi.fn>;
  let mockClient: MockClient;

  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    mockAbort = vi.fn().mockResolvedValue({ data: true, error: undefined });
    mockPrompt = vi.fn().mockResolvedValue({ data: {}, error: undefined });
    mockStatus = vi.fn().mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });
    mockShowToast = vi.fn().mockResolvedValue({ data: {}, error: undefined });
    mockClient = {
      session: { abort: mockAbort, prompt: mockPrompt, status: mockStatus, todo: vi.fn(), summarize: vi.fn() },
      tui: { showToast: mockShowToast },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it("trace timer scheduling", async () => {
    vi.useFakeTimers();
    mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
    
    const plugin = await createPlugin({ client: mockClient }, {
      stallTimeoutMs: 1000,
      planningTimeoutMs: 300000,
      autoCompact: false,
      terminalTitleEnabled: false,
      statusFilePath: "",
      debug: true,
    });

    console.log("=== BEFORE session.status ===");
    await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
    console.log("=== AFTER session.status ===");
    
    // Access internal state to check timer
    const pluginAny = plugin as any;
    const sessions = pluginAny._sessions || new Map();
    
    console.log("=== BEFORE message.part.updated ===");
    await plugin.event({ event: { type: "message.part.updated", properties: {
      sessionID: "test",
      messageID: "msg1",
      part: { id: "part1", type: "text", text: "Let me plan this out:\n1. First step\n2. Second step", sessionID: "test", messageID: "msg1" },
      delta: "Let me plan this out"
    } } });
    console.log("=== AFTER message.part.updated ===");
    
    console.log("=== Advancing 10 seconds ===");
    await vi.advanceTimersByTimeAsync(10000);
    console.log("=== Done ===");
    
    console.log("Abort calls:", mockAbort.mock.calls.length);
    console.log("Session state:", sessions.get("test"));
    
    vi.useRealTimers();
  });
});
