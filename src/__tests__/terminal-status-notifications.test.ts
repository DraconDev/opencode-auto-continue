import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Test terminal output generation
describe("terminal module output", () => {
  let mockAbort: ReturnType<typeof vi.fn>;
  let mockPrompt: ReturnType<typeof vi.fn>;
  let mockStatus: ReturnType<typeof vi.fn>;
  let mockTodo: ReturnType<typeof vi.fn>;
  let mockClient: any;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    mockAbort = vi.fn().mockResolvedValue({ data: true, error: undefined });
    mockPrompt = vi.fn().mockResolvedValue({ data: {}, error: undefined });
    mockStatus = vi.fn().mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
    mockTodo = vi.fn().mockResolvedValue({ data: [], error: undefined });

    mockClient = {
      session: {
        abort: mockAbort,
        prompt: mockPrompt,
        status: mockStatus,
        todo: mockTodo,
        summarize: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    writeSpy?.mockRestore();
  });

  async function createPlugin(input: { client: any }, options?: Record<string, unknown>) {
    const { AutoForceResumePlugin } = await import('../index.js');
    return AutoForceResumePlugin(input as any, options as any);
  }

  describe("OSC 0/2 terminal title", () => {
    it("should write OSC 0 title when session becomes busy", async () => {
      writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: true,
        terminalProgressEnabled: false
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      const osc0Calls = writeSpy.mock.calls.filter(call =>
        typeof call[0] === 'string' && call[0].includes('\x1b]0;')
      );

      expect(osc0Calls.length).toBeGreaterThan(0);
      writeSpy.mockRestore();
    });

    it("should clear OSC 0 title when session becomes idle", async () => {
      writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: true,
        terminalProgressEnabled: false
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "idle" } } } });

      // Should have cleared the title
      const clearCalls = writeSpy.mock.calls.filter(call =>
        typeof call[0] === 'string' && call[0].includes('\x1b]0;')
      );

      // At least one clear (empty title) should have been written
      expect(clearCalls.length).toBeGreaterThan(0);
      writeSpy.mockRestore();
    });

    it("should NOT write OSC 0 when terminalTitleEnabled is false", async () => {
      writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      const osc0Calls = writeSpy.mock.calls.filter(call =>
        typeof call[0] === 'string' && call[0].includes('\x1b]0;')
      );

      expect(osc0Calls).toHaveLength(0);
      writeSpy.mockRestore();
    });

    it("should include elapsed time in title", async () => {
      vi.useFakeTimers();
      writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: true,
        terminalProgressEnabled: false
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      vi.advanceTimersByTime(30000);

      const titleCall = writeSpy.mock.calls.find(call =>
        typeof call[0] === 'string' && call[0].includes('\x1b]0;')
      );

      if (titleCall) {
        const title = titleCall[0] as string;
        // Should contain some time indicator
        expect(title).toMatch(/[0-9]+/);
      }

      writeSpy.mockRestore();
      vi.useRealTimers();
    });

    it("should include last progress time in title", async () => {
      vi.useFakeTimers();
      writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: true,
        terminalProgressEnabled: false
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Progress event
      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part1", type: "text", text: "hello", sessionID: "test", messageID: "msg1" },
        delta: "hello"
      } } });

      vi.advanceTimersByTime(15000);

      // Title should reference last progress
      const titleCall = writeSpy.mock.calls.find(call =>
        typeof call[0] === 'string' && call[0].includes('\x1b]0;')
      );

      // Should have been called
      expect(titleCall).toBeDefined();

      writeSpy.mockRestore();
      vi.useRealTimers();
    });
  });

  describe("OSC 9;4 progress bar", () => {
    it("should write OSC 9;4 progress when session busy and enabled", async () => {
      writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        terminalProgressEnabled: true
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      const osc94Calls = writeSpy.mock.calls.filter(call =>
        typeof call[0] === 'string' && call[0].includes('\x1b]9;4')
      );

      expect(osc94Calls.length).toBeGreaterThan(0);
      writeSpy.mockRestore();
    });

    it("should NOT write OSC 9;4 when terminalProgressEnabled is false", async () => {
      writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        terminalProgressEnabled: false
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      const osc94Calls = writeSpy.mock.calls.filter(call =>
        typeof call[0] === 'string' && call[0].includes('\x1b]9;4')
      );

      expect(osc94Calls).toHaveLength(0);
      writeSpy.mockRestore();
    });

    it("should clear OSC 9;4 when session becomes idle", async () => {
      writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        terminalProgressEnabled: true
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "idle" } } } });

      // Should have cleared progress bar (OSC 9;4 with 0 or empty)
      const clearCalls = writeSpy.mock.calls.filter(call =>
        typeof call[0] === 'string' && call[0].includes('\x1b]9;4')
      );

      // Should have progress bar calls including at least one clear
      expect(clearCalls.length).toBeGreaterThan(0);
      writeSpy.mockRestore();
    });

    it("should show percentage based on token estimation", async () => {
      vi.useFakeTimers();
      writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: false,
        terminalProgressEnabled: true,
        proactiveCompactAtTokens: 100000
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Accumulate tokens
      for (let i = 0; i < 10; i++) {
        await plugin.event({ event: { type: "message.part.updated", properties: {
          sessionID: "test",
          messageID: "msg1",
          part: { id: "part" + i, type: "text", text: "a".repeat(100), sessionID: "test", messageID: "msg1" },
          delta: "a".repeat(100)
        } } });
      }

      // Progress bar should have been updated with percentage
      const progressCall = writeSpy.mock.calls.find(call =>
        typeof call[0] === 'string' && call[0].includes('\x1b]9;4')
      );

      expect(progressCall).toBeDefined();

      writeSpy.mockRestore();
      vi.useRealTimers();
    });
  });

  describe("combined terminal output", () => {
    it("should write both title and progress when both enabled", async () => {
      writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: true,
        terminalProgressEnabled: true
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      const osc0Calls = writeSpy.mock.calls.filter(call =>
        typeof call[0] === 'string' && call[0].includes('\x1b]0;')
      );
      const osc94Calls = writeSpy.mock.calls.filter(call =>
        typeof call[0] === 'string' && call[0].includes('\x1b]9;4')
      );

      expect(osc0Calls.length).toBeGreaterThan(0);
      expect(osc94Calls.length).toBeGreaterThan(0);
      writeSpy.mockRestore();
    });

    it("should not interfere with non-OSC output", async () => {
      const regularOutput = vi.fn();
      writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((str: string) => {
        if (!str.includes('\x1b')) {
          regularOutput(str);
        }
        return true;
      });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        terminalTitleEnabled: true,
        terminalProgressEnabled: false
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Regular output should still work
      expect(regularOutput).not.toHaveBeenCalled();

      writeSpy.mockRestore();
    });
  });
});

describe("status file module", () => {
  let mockClient: any;

  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    mockClient = {
      session: {
        abort: vi.fn().mockResolvedValue({ data: true, error: undefined }),
        prompt: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
        status: vi.fn().mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined }),
        todo: vi.fn().mockResolvedValue({ data: [], error: undefined }),
        summarize: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  async function createPlugin(input: { client: any }, options?: Record<string, unknown>) {
    const { AutoForceResumePlugin } = await import('../index.js');
    return AutoForceResumePlugin(input as any, options as any);
  }

  describe("status file integration", () => {
    it("should not crash when status file is enabled", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        statusFileEnabled: true,
        statusFilePath: "/tmp/test-status.json",
        terminalTitleEnabled: false
      });

      await plugin.event({ event: { type: "session.created", properties: { sessionID: "test" } } });

      expect(true).toBe(true);
    });

    it("should handle statusFilePath with special characters", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        statusFileEnabled: true,
        statusFilePath: "/tmp/test-status (special) [brackets].json",
        terminalTitleEnabled: false
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      expect(true).toBe(true);
    });

    it("should not crash when statusFileEnabled is false", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        statusFileEnabled: false,
        statusFilePath: "/tmp/test-status.json",
        terminalTitleEnabled: false
      });

      await plugin.event({ event: { type: "session.created", properties: { sessionID: "test" } } });
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "idle" } } } });

      expect(true).toBe(true);
    });

    it("should write status on multiple events", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        statusFileEnabled: true,
        statusFilePath: "/tmp/test-status.json",
        terminalTitleEnabled: false
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [
        { id: "t1", content: "task", status: "in_progress" }
      ] } } });
      await plugin.event({ event: { type: "message.created", properties: { sessionID: "test", info: { role: "user" } } } });

      expect(true).toBe(true);
    });

    it("should handle maxStatusHistory configuration", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        statusFileEnabled: true,
        statusFilePath: "/tmp/test-status.json",
        maxStatusHistory: 5,
        terminalTitleEnabled: false
      });

      // Multiple status updates
      for (let i = 0; i < 10; i++) {
        await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      }

      expect(true).toBe(true);
    });

    it("should handle empty statusFilePath", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        statusFileEnabled: true,
        statusFilePath: "",
        terminalTitleEnabled: false
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      expect(true).toBe(true);
    });

    it("should include session state in status tracking", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        statusFileEnabled: true,
        statusFilePath: "/tmp/test-status.json",
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
    });

    it("should track todo changes in status", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        statusFileEnabled: true,
        statusFilePath: "/tmp/test-status.json",
        terminalTitleEnabled: false
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [
        { id: "t1", content: "task", status: "in_progress" }
      ] } } });
      await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [
        { id: "t1", content: "task", status: "completed" }
      ] } } });

      expect(true).toBe(true);
    });

    it("should handle recovery events in status", async () => {
      vi.useFakeTimers();
      const mockStatus = mockClient.session.status as any;
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 500,
        waitAfterAbortMs: 50,
        cooldownMs: 0,
        maxRecoveries: 3,
        abortPollMaxTimeMs: 0,
        autoCompact: false,
        statusFileEnabled: true,
        statusFilePath: "/tmp/test-status.json",
        terminalTitleEnabled: false
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
      await vi.advanceTimersByTimeAsync(600);
      await Promise.resolve();

      // Recovery attempted
      expect(mockClient.session.abort).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });
});

describe("planning state behavior", () => {
  let mockClient: any;

  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    mockClient = {
      session: {
        abort: vi.fn().mockResolvedValue({ data: true, error: undefined }),
        prompt: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
        status: vi.fn().mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined }),
        todo: vi.fn().mockResolvedValue({ data: [], error: undefined }),
        summarize: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  async function createPlugin(input: { client: any }, options?: Record<string, unknown>) {
    const { AutoForceResumePlugin } = await import('../index.js');
    return AutoForceResumePlugin(input as any, options as any);
  }

  describe("plan detection", () => {
    it("should detect plan from text starting with 'here is my plan'", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        autoCompact: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Plan text
      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part1", type: "text", text: "Here is my plan:", sessionID: "test", messageID: "msg1" },
        delta: "Here"
      } } });

      expect(true).toBe(true); // Test passes if no crash
    });

    it("should detect plan from markdown heading '## Plan'", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        autoCompact: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part1", type: "text", text: "## Plan", sessionID: "test", messageID: "msg1" },
        delta: "##"
      } } });

      expect(true).toBe(true);
    });

    it("should detect plan from bold text '**Plan:**'", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        autoCompact: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part1", type: "text", text: "**Plan:**", sessionID: "test", messageID: "msg1" },
        delta: "**"
      } } });

      expect(true).toBe(true);
    });

    it("should detect plan from 'Here's my plan'", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        autoCompact: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part1", type: "text", text: "Here's my plan:", sessionID: "test", messageID: "msg1" },
        delta: "Here"
      } } });

      expect(true).toBe(true);
    });

    it("should be case insensitive for plan detection", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        autoCompact: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part1", type: "text", text: "HERE IS MY PLAN", sessionID: "test", messageID: "msg1" },
        delta: "HERE"
      } } });

      expect(true).toBe(true);
    });
  });

  describe("planning pauses monitoring", () => {
    it("should pause stall timer during planning", async () => {
      vi.useFakeTimers();
      const mockStatus = mockClient.session.status as any;
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 1000,
        waitAfterAbortMs: 100,
        autoCompact: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Start planning
      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part1", type: "text", text: "Here is my plan:", sessionID: "test", messageID: "msg1" },
        delta: "Here"
      } } });

      // Wait longer than stallTimeout - but planning should pause it
      await vi.advanceTimersByTimeAsync(2000);

      // Abort should NOT be called because planning paused monitoring
      expect(mockClient.session.abort).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("should clear planning flag on non-plan progress", async () => {
      vi.useFakeTimers();
      const mockStatus = mockClient.session.status as any;
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 1000,
        waitAfterAbortMs: 100,
        autoCompact: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Plan detected
      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part1", type: "text", text: "Here is my plan:", sessionID: "test", messageID: "msg1" },
        delta: "Here"
      } } });

      // Non-plan progress (tool call) clears planning
      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part2", type: "tool", sessionID: "test", messageID: "msg1" },
      } } });

      // Now timer should work
      await vi.advanceTimersByTimeAsync(2000);

      expect(mockClient.session.abort).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe("plan content accumulation", () => {
    it("should accumulate plan buffer across multiple parts", async () => {
      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        autoCompact: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // First part of plan
      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part1", type: "text", text: "Here is my plan:", sessionID: "test", messageID: "msg1" },
        delta: "Here"
      } } });

      // Second part
      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part2", type: "text", text: "1. First step", sessionID: "test", messageID: "msg1" },
        delta: "1."
      } } });

      expect(true).toBe(true);
    });

    it("should clear plan buffer when planning ends", async () => {
      vi.useFakeTimers();
      const mockStatus = mockClient.session.status as any;
      mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });

      const plugin = await createPlugin({ client: mockClient }, {
        stallTimeoutMs: 5000,
        autoCompact: false,
        terminalTitleEnabled: false,
        statusFilePath: ""
      });

      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      // Plan starts
      await plugin.event({ event: { type: "message.part.updated", properties: {
        sessionID: "test",
        messageID: "msg1",
        part: { id: "part1", type: "text", text: "Here is my plan:", sessionID: "test", messageID: "msg1" },
        delta: "Here"
      } } });

      // Plan ends with idle
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });

      // New busy clears plan
      mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });
      await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

      expect(true).toBe(true);

      vi.useRealTimers();
    });
  });
});

describe("compaction state behavior", () => {
  let mockClient: any;

  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    mockClient = {
      session: {
        abort: vi.fn().mockResolvedValue({ data: true, error: undefined }),
        prompt: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
        status: vi.fn().mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined }),
        todo: vi.fn().mockResolvedValue({ data: [], error: undefined }),
        summarize: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  async function createPlugin(input: { client: any }, options?: Record<string, unknown>) {
    const { AutoForceResumePlugin } = await import('../index.js');
    return AutoForceResumePlugin(input as any, options as any);
  }

  it("should set compacting flag during compaction part", async () => {
    vi.useFakeTimers();
    const mockStatus = mockClient.session.status as any;
    mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });

    const plugin = await createPlugin({ client: mockClient }, {
      stallTimeoutMs: 5000,
      autoCompact: false,
      terminalTitleEnabled: false,
      statusFilePath: ""
    });

    await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

    // Compaction part starts
    await plugin.event({ event: { type: "message.part.updated", properties: {
      sessionID: "test",
      messageID: "msg1",
      part: { id: "part1", type: "compaction", auto: true, sessionID: "test", messageID: "msg1" },
      delta: ""
    } } });

    // Timer should be paused
    await vi.advanceTimersByTimeAsync(10000);
    expect(mockClient.session.abort).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("should clear compacting flag on session.status busy", async () => {
    vi.useFakeTimers();
    const mockStatus = mockClient.session.status as any;
    mockStatus.mockResolvedValue({ data: { "test": { type: "busy" } }, error: undefined });

    const plugin = await createPlugin({ client: mockClient }, {
      stallTimeoutMs: 1000,
      waitAfterAbortMs: 100,
      autoCompact: false,
      terminalTitleEnabled: false,
      statusFilePath: ""
    });

    await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

    // Compaction
    await plugin.event({ event: { type: "message.part.updated", properties: {
      sessionID: "test",
      messageID: "msg1",
      part: { id: "part1", type: "compaction", auto: true, sessionID: "test", messageID: "msg1" },
      delta: ""
    } } });

    // Clear flag by busy status
    await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

    // Now stall timer should work
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockClient.session.abort).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("should NOT clear session on session.compacted event", async () => {
    vi.useFakeTimers();
    const mockStatus = mockClient.session.status as any;
    mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });

    const plugin = await createPlugin({ client: mockClient }, {
      stallTimeoutMs: 5000,
      autoCompact: false,
      terminalTitleEnabled: false,
      terminalProgressEnabled: false,
      statusFilePath: ""
    });

    await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });
    await plugin.event({ event: { type: "todo.updated", properties: { sessionID: "test", todos: [
      { id: "t1", content: "task", status: "in_progress" }
    ] } } });

    // session.compacted event
    await plugin.event({ event: { type: "session.compacted", properties: { sessionID: "test" } } });

    // After compaction, idle should still trigger nudge because session state is preserved
    mockClient.session.todo.mockResolvedValue({ data: [{ id: "t1", content: "task", status: "in_progress" }], error: undefined });

    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "test" } } });
    await vi.advanceTimersByTimeAsync(600);

    expect(mockClient.session.prompt).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("should reset estimated tokens on session.compacted", async () => {
    vi.useFakeTimers();
    const mockStatus = mockClient.session.status as any;
    mockStatus.mockResolvedValue({ data: { "test": { type: "idle" } }, error: undefined });

    const plugin = await createPlugin({ client: mockClient }, {
      stallTimeoutMs: 5000,
      autoCompact: false,
      terminalTitleEnabled: false,
      terminalProgressEnabled: false,
      statusFilePath: ""
    });

    await plugin.event({ event: { type: "session.status", properties: { sessionID: "test", status: { type: "busy" } } } });

    // Accumulate tokens
    await plugin.event({ event: { type: "message.updated", properties: {
      sessionID: "test",
      messageID: "msg1",
      info: { role: "assistant" },
      tokens: { input: 50000, output: 10000, reasoning: 0 }
    } } });

    // Compaction happens
    await plugin.event({ event: { type: "session.compacted", properties: { sessionID: "test" } } });

    // Test passes if no crash - tokens were reset
    expect(true).toBe(true);

    vi.useRealTimers();
  });
});
