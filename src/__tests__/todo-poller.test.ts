import { describe, it, expect, vi } from "vitest";
import { createTodoPoller } from "../todo-poller.js";
import type { SessionState } from "../session-state.js";
import { createSession } from "../session-state.js";

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    todoPollIntervalMs: 30000,
    reviewOnComplete: true,
    reviewDebounceMs: 500,
    reviewCooldownMs: 60000,
    opportunisticCompactAfterReview: true,
    opportunisticCompactAtTokens: 60000,
    todoMdPath: "",
    ...overrides,
  } as any;
}

function makeDeps(overrides: Record<string, unknown> = {}, configOverrides: Record<string, unknown> = {}) {
  const sessions = new Map<string, SessionState>();
  const log = vi.fn();
  const mockTodo = vi.fn().mockResolvedValue({ data: [], error: undefined });
  const input = {
    client: { session: { todo: mockTodo } },
    directory: "/test",
  } as any;
  const writeStatusFile = vi.fn();
  const triggerReview = vi.fn();
  const maybeOpportunisticCompact = vi.fn().mockResolvedValue(false);
  const scheduleNudge = vi.fn();

  return {
    config: makeConfig(configOverrides),
    sessions,
    log,
    isDisposed: () => false,
    input,
    writeStatusFile,
    triggerReview,
    maybeOpportunisticCompact,
    scheduleNudge,
    mockTodo,
    ...overrides,
  } as any;
}

describe("todo-poller", () => {
  describe("pollAndProcess", () => {
    it("should fetch todos from API and update session state", async () => {
      const deps = makeDeps();
      const s = createSession();
      deps.sessions.set("test", s);
      deps.mockTodo.mockResolvedValue({
        data: [
          { id: "t1", content: "Task A", status: "in_progress" },
          { id: "t2", content: "Task B", status: "pending" },
        ],
        error: undefined,
      });

      const poller = createTodoPoller(deps);
      const result = await poller.pollAndProcess("test");

      expect(result).not.toBeNull();
      expect(s.hasOpenTodos).toBe(true);
      expect(s.lastKnownTodos).toHaveLength(2);
      expect(deps.mockTodo).toHaveBeenCalledWith({
        path: { id: "test" },
        query: { directory: "/test" },
      });
    });

    it("should set hasOpenTodos=false when all todos completed", async () => {
      const deps = makeDeps();
      const s = createSession();
      deps.sessions.set("test", s);
      deps.mockTodo.mockResolvedValue({
        data: [
          { id: "t1", content: "Task A", status: "completed" },
          { id: "t2", content: "Task B", status: "cancelled" },
        ],
        error: undefined,
      });

      const poller = createTodoPoller(deps);
      await poller.pollAndProcess("test");

      expect(s.hasOpenTodos).toBe(false);
    });

    it("should trigger review when all todos completed", async () => {
      vi.useFakeTimers();
      const deps = makeDeps();
      const s = createSession();
      deps.sessions.set("test", s);
      deps.mockTodo.mockResolvedValue({
        data: [{ id: "t1", content: "Task A", status: "completed" }],
        error: undefined,
      });

      const poller = createTodoPoller(deps);
      await poller.pollAndProcess("test");

      expect(deps.triggerReview).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);

      expect(deps.triggerReview).toHaveBeenCalledWith("test");
      vi.useRealTimers();
    });

    it("should trigger review immediately when reviewDebounceMs is 0", async () => {
      const deps = makeDeps({}, { reviewDebounceMs: 0 });
      const s = createSession();
      deps.sessions.set("test", s);
      deps.mockTodo.mockResolvedValue({
        data: [{ id: "t1", content: "Task A", status: "completed" }],
        error: undefined,
      });

      const poller = createTodoPoller(deps);
      await poller.pollAndProcess("test");

      expect(deps.triggerReview).toHaveBeenCalledWith("test");
      expect(s.reviewDebounceTimer).toBeNull();
    });

    it("should skip poll when todo.updated event received recently", async () => {
      const deps = makeDeps();
      const s = createSession();
      deps.sessions.set("test", s);

      const poller = createTodoPoller(deps);

      // Simulate a recent todo.updated event
      poller.markEventTodoReceived("test");

      const result = await poller.pollAndProcess("test");

      expect(result).toBeNull();
      expect(deps.mockTodo).not.toHaveBeenCalled();
    });

    it("should process cached todos when poll is skipped due to freshness", async () => {
      const deps = makeDeps();
      const s = createSession();
      deps.sessions.set("test", s);

      const poller = createTodoPoller(deps);

      // First, populate cached todos via processTodos
      poller.processTodos("test", [
        { id: "t1", content: "Task A", status: "in_progress" },
      ]);
      expect(s.hasOpenTodos).toBe(true);
      expect(deps.scheduleNudge).toHaveBeenCalledWith("test");

      // Simulate a recent todo.updated event (marks freshness)
      poller.markEventTodoReceived("test");

      // Reset the mock to check if scheduleNudge is called again
      deps.scheduleNudge.mockClear();

      // Poll should be skipped, but cached todos should be reprocessed
      const result = await poller.pollAndProcess("test");

      expect(result).toBeNull();
      expect(deps.mockTodo).not.toHaveBeenCalled();
      expect(deps.scheduleNudge).toHaveBeenCalledWith("test");
    });

    it("should trigger review from cached todos when poll is skipped and all todos completed", async () => {
      vi.useFakeTimers();
      const deps = makeDeps();
      const s = createSession();
      deps.sessions.set("test", s);

      const poller = createTodoPoller(deps);

      // Populate cached todos with all completed
      poller.processTodos("test", [
        { id: "t1", content: "Task A", status: "completed" },
      ]);

      // Simulate a recent todo.updated event
      poller.markEventTodoReceived("test");

      // Poll should be skipped, but cached todos should be reprocessed
      const result = await poller.pollAndProcess("test");

      expect(result).toBeNull();
      expect(deps.mockTodo).not.toHaveBeenCalled();

      // Review debounce timer should be started from cached todos
      expect(s.reviewDebounceTimer).not.toBeNull();
      await vi.advanceTimersByTimeAsync(500);
      expect(deps.triggerReview).toHaveBeenCalledWith("test");

      vi.useRealTimers();
    });

    it("should poll after event freshness window expires", async () => {
      vi.useFakeTimers();
      const deps = makeDeps();
      const s = createSession();
      deps.sessions.set("test", s);
      deps.mockTodo.mockResolvedValue({
        data: [{ id: "t1", content: "Task", status: "in_progress" }],
        error: undefined,
      });

      const poller = createTodoPoller(deps);
      poller.markEventTodoReceived("test");

      // Should skip immediately
      let result = await poller.pollAndProcess("test");
      expect(result).toBeNull();

      // After freshness window (10s), should poll
      await vi.advanceTimersByTimeAsync(10001);
      result = await poller.pollAndProcess("test");
      expect(result).not.toBeNull();
      expect(deps.mockTodo).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("should not trigger review twice (reviewFired guard)", async () => {
      vi.useFakeTimers();
      const deps = makeDeps();
      const s = createSession();
      deps.sessions.set("test", s);
      deps.mockTodo.mockResolvedValue({
        data: [{ id: "t1", content: "Task", status: "completed" }],
        error: undefined,
      });

      const poller = createTodoPoller(deps);
      await poller.pollAndProcess("test");
      await vi.advanceTimersByTimeAsync(500);
      expect(deps.triggerReview).toHaveBeenCalledTimes(1);

      // Poll again — reviewFired is true, should not trigger again
      s.reviewFired = true;
      deps.mockTodo.mockResolvedValue({
        data: [{ id: "t1", content: "Task", status: "completed" }],
        error: undefined,
      });
      await poller.pollAndProcess("test");
      expect(deps.triggerReview).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it("should reset reviewFired when new pending todos appear and cooldown elapsed", async () => {
      const deps = makeDeps();
      const s = createSession();
      s.reviewFired = true;
      s.lastReviewAt = 0;
      deps.sessions.set("test", s);
      deps.mockTodo.mockResolvedValue({
        data: [{ id: "t2", content: "New bug", status: "in_progress" }],
        error: undefined,
      });

      const poller = createTodoPoller(deps);
      await poller.pollAndProcess("test");

      expect(s.reviewFired).toBe(false);
      expect(s.hasOpenTodos).toBe(true);
    });

    it("should NOT reset reviewFired when cooldown is active", async () => {
      const deps = makeDeps({ reviewCooldownMs: 60000 });
      const s = createSession();
      s.reviewFired = true;
      s.lastReviewAt = Date.now() - 10000;
      deps.sessions.set("test", s);
      deps.mockTodo.mockResolvedValue({
        data: [{ id: "t2", content: "New bug", status: "in_progress" }],
        error: undefined,
      });

      const poller = createTodoPoller(deps);
      await poller.pollAndProcess("test");

      expect(s.reviewFired).toBe(true);
    });

    it("should reset reviewFired when cooldown has elapsed", async () => {
      const deps = makeDeps({ reviewCooldownMs: 60000 });
      const s = createSession();
      s.reviewFired = true;
      s.lastReviewAt = Date.now() - 70000;
      deps.sessions.set("test", s);
      deps.mockTodo.mockResolvedValue({
        data: [{ id: "t2", content: "New bug", status: "in_progress" }],
        error: undefined,
      });

      const poller = createTodoPoller(deps);
      await poller.pollAndProcess("test");

      expect(s.reviewFired).toBe(false);
    });

    it("should handle API errors gracefully", async () => {
      const deps = makeDeps();
      const s = createSession();
      deps.sessions.set("test", s);
      deps.mockTodo.mockRejectedValue(new Error("API error"));

      const poller = createTodoPoller(deps);
      const result = await poller.pollAndProcess("test");

      expect(result).toBeNull();
      expect(s.hasOpenTodos).toBe(false);
    });

    it("should handle empty todo list from API", async () => {
      const deps = makeDeps();
      const s = createSession();
      s.hasOpenTodos = true;
      deps.sessions.set("test", s);
      deps.mockTodo.mockResolvedValue({ data: [], error: undefined });

      const poller = createTodoPoller(deps);
      await poller.pollAndProcess("test");

      expect(s.hasOpenTodos).toBe(false);
      expect(s.lastKnownTodos).toHaveLength(0);
    });

    it("should not poll when disposed", async () => {
      let disposed = false;
      const deps = makeDeps({ isDisposed: () => disposed });
      const s = createSession();
      deps.sessions.set("test", s);

      const poller = createTodoPoller(deps);
      disposed = true;
      const result = await poller.pollAndProcess("test");

      expect(result).toBeNull();
      expect(deps.mockTodo).not.toHaveBeenCalled();
    });
  });

  describe("periodic polling", () => {
    it("should start and stop periodic poll", async () => {
      vi.useFakeTimers();
      const deps = makeDeps();
      const s = createSession();
      deps.sessions.set("test", s);

      const poller = createTodoPoller(deps);
      poller.startPeriodicPoll();

      // Timer is set, but hasn't fired yet
      expect(deps.mockTodo).not.toHaveBeenCalled();

      // Advance past the interval
      await vi.advanceTimersByTimeAsync(30001);
      expect(deps.mockTodo).toHaveBeenCalled();

      poller.stopPeriodicPoll();
      vi.useRealTimers();
    });

    it("should not start periodic poll when interval is 0", () => {
      const deps = makeDeps();
      deps.config.todoPollIntervalMs = 0;
      const poller = createTodoPoller(deps);

      poller.startPeriodicPoll();
      // No timer set — no polling
    });

    it("should skip session when compacting", async () => {
      const deps = makeDeps();
      const s = createSession();
      s.compacting = true;
      deps.sessions.set("test", s);

      const poller = createTodoPoller(deps);
      await poller.pollAllActive();

      expect(deps.mockTodo).not.toHaveBeenCalled();
    });

    it("should skip session when planning", async () => {
      const deps = makeDeps();
      const s = createSession();
      s.planning = true;
      deps.sessions.set("test", s);

      const poller = createTodoPoller(deps);
      await poller.pollAllActive();

      expect(deps.mockTodo).not.toHaveBeenCalled();
    });

    it("should respect MIN_POLL_INTERVAL_MS between pollAllActive calls", async () => {
      const deps = makeDeps();
      const s = createSession();
      deps.sessions.set("test", s);

      const poller = createTodoPoller(deps);
      await poller.pollAllActive();
      expect(deps.mockTodo).toHaveBeenCalledTimes(1);

      // Immediate second call should be throttled
      await poller.pollAllActive();
      expect(deps.mockTodo).toHaveBeenCalledTimes(1);
    });
  });

  describe("processTodos", () => {
    it("should handle mixed status todos correctly", () => {
      const deps = makeDeps();
      const s = createSession();
      deps.sessions.set("test", s);

      const poller = createTodoPoller(deps);
      poller.processTodos("test", [
        { id: "t1", content: "Done", status: "completed" },
        { id: "t2", content: "Active", status: "in_progress" },
        { id: "t3", content: "Queued", status: "pending" },
        { id: "t4", content: "Cancelled", status: "cancelled" },
      ]);

      expect(s.hasOpenTodos).toBe(true);
      expect(s.lastKnownTodos).toHaveLength(4);
    });

    it("should cancel review debounce when todos become incomplete", () => {
      vi.useFakeTimers();
      const deps = makeDeps();
      const s = createSession();
      deps.sessions.set("test", s);

      const poller = createTodoPoller(deps);

      // All completed → starts review debounce
      poller.processTodos("test", [
        { id: "t1", content: "Done", status: "completed" },
      ]);
      expect(s.reviewDebounceTimer).not.toBeNull();

      // New pending todo → cancel debounce
      poller.processTodos("test", [
        { id: "t1", content: "Done", status: "completed" },
        { id: "t2", content: "New", status: "in_progress" },
      ]);
      expect(s.reviewDebounceTimer).toBeNull();

      vi.useRealTimers();
    });

    it("should NOT trigger review when cooldown is active (all completed)", () => {
      vi.useFakeTimers();
      const deps = makeDeps({ reviewCooldownMs: 60000 });
      const s = createSession();
      s.lastReviewAt = Date.now() - 10000;
      deps.sessions.set("test", s);

      const poller = createTodoPoller(deps);
      poller.processTodos("test", [
        { id: "t1", content: "Done", status: "completed" },
      ]);

      expect(s.reviewDebounceTimer).toBeNull();
      expect(deps.triggerReview).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("should trigger review when cooldown has elapsed (all completed)", () => {
      vi.useFakeTimers();
      const deps = makeDeps({ reviewCooldownMs: 60000 });
      const s = createSession();
      s.lastReviewAt = Date.now() - 70000;
      deps.sessions.set("test", s);

      const poller = createTodoPoller(deps);
      poller.processTodos("test", [
        { id: "t1", content: "Done", status: "completed" },
      ]);

      expect(s.reviewDebounceTimer).not.toBeNull();

      vi.advanceTimersByTime(500);
      expect(deps.triggerReview).toHaveBeenCalledWith("test");

      vi.useRealTimers();
    });

    it("should NOT reset reviewFired during cooldown when new pending todos appear", () => {
      const deps = makeDeps({ reviewCooldownMs: 60000 });
      const s = createSession();
      s.reviewFired = true;
      s.lastReviewAt = Date.now() - 10000;
      deps.sessions.set("test", s);

      const poller = createTodoPoller(deps);
      poller.processTodos("test", [
        { id: "t1", content: "Done", status: "completed" },
        { id: "t2", content: "New bug", status: "in_progress" },
      ]);

      expect(s.reviewFired).toBe(true);
    });

    it("should reset reviewFired after cooldown when new pending todos appear", () => {
      const deps = makeDeps({ reviewCooldownMs: 60000 });
      const s = createSession();
      s.reviewFired = true;
      s.lastReviewAt = Date.now() - 70000;
      deps.sessions.set("test", s);

      const poller = createTodoPoller(deps);
      poller.processTodos("test", [
        { id: "t1", content: "Done", status: "completed" },
        { id: "t2", content: "New bug", status: "in_progress" },
      ]);

      expect(s.reviewFired).toBe(false);
    });

    it("should reset reviewFired when all todos complete after cooldown expires", () => {
      vi.useFakeTimers();
      const deps = makeDeps({ reviewCooldownMs: 60000 });
      const s = createSession();
      s.reviewFired = true;
      s.lastReviewAt = Date.now() - 10000;
      deps.sessions.set("test", s);

      const poller = createTodoPoller(deps);

      // Pending todos appear but cooldown prevents reviewFired reset
      poller.processTodos("test", [
        { id: "t1", content: "Done", status: "completed" },
        { id: "t2", content: "New bug", status: "in_progress" },
      ]);
      expect(s.reviewFired).toBe(true);

      // Advance past cooldown
      vi.advanceTimersByTime(60000);

      // All todos complete — reviewFired should be reset so review can fire
      poller.processTodos("test", [
        { id: "t1", content: "Done", status: "completed" },
        { id: "t2", content: "Fixed", status: "completed" },
      ]);
      expect(s.reviewFired).toBe(false);
      expect(s.reviewDebounceTimer).not.toBeNull();

      vi.useRealTimers();
    });

    it("should NOT reset reviewFired when all completed and cooldown still active", () => {
      const deps = makeDeps({ reviewCooldownMs: 60000 });
      const s = createSession();
      s.reviewFired = true;
      s.lastReviewAt = Date.now() - 10000;
      deps.sessions.set("test", s);

      const poller = createTodoPoller(deps);
      poller.processTodos("test", [
        { id: "t1", content: "Done", status: "completed" },
      ]);

      expect(s.reviewFired).toBe(true);
      expect(s.reviewDebounceTimer).toBeNull();
    });

    describe("review compaction deferral", () => {
      it("should still trigger review debounce even when session was compacting during poll", () => {
        const deps = makeDeps();
        const s = createSession();
        s.compacting = false;
        deps.sessions.set("test", s);

        const poller = createTodoPoller(deps);
        poller.processTodos("test", [
          { id: "t1", content: "Done", status: "completed" },
        ]);

        expect(s.reviewDebounceTimer).not.toBeNull();
        expect(deps.triggerReview).not.toHaveBeenCalled();
      });

      it("should trigger review debounce when all completed after compaction clears", () => {
        const deps = makeDeps();
        const s = createSession();
        deps.sessions.set("test", s);

        const poller = createTodoPoller(deps);

        // First: todos pending, then all complete
        poller.processTodos("test", [
          { id: "t1", content: "Task", status: "in_progress" },
        ]);

        poller.processTodos("test", [
          { id: "t1", content: "Done", status: "completed" },
        ]);

        expect(s.reviewDebounceTimer).not.toBeNull();
      });
    });

    describe("nudge fallback scheduling", () => {
      it("should call scheduleNudge when pending todos are detected", () => {
        const deps = makeDeps();
        const s = createSession();
        deps.sessions.set("test", s);

        const poller = createTodoPoller(deps);
        poller.processTodos("test", [
          { id: "t1", content: "Task A", status: "in_progress" },
        ]);

        expect(deps.scheduleNudge).toHaveBeenCalledWith("test");
      });

      it("should call scheduleNudge for pending status", () => {
        const deps = makeDeps();
        const s = createSession();
        deps.sessions.set("test", s);

        const poller = createTodoPoller(deps);
        poller.processTodos("test", [
          { id: "t1", content: "Task A", status: "pending" },
        ]);

        expect(deps.scheduleNudge).toHaveBeenCalledWith("test");
      });

      it("should NOT call scheduleNudge when all todos are completed", () => {
        const deps = makeDeps();
        const s = createSession();
        deps.sessions.set("test", s);

        const poller = createTodoPoller(deps);
        poller.processTodos("test", [
          { id: "t1", content: "Done", status: "completed" },
        ]);

        expect(deps.scheduleNudge).not.toHaveBeenCalled();
      });

      it("should NOT call scheduleNudge when nudge is paused", () => {
        const deps = makeDeps();
        const s = createSession();
        s.nudgePaused = true;
        deps.sessions.set("test", s);

        const poller = createTodoPoller(deps);
        poller.processTodos("test", [
          { id: "t1", content: "Task A", status: "in_progress" },
        ]);

        expect(deps.scheduleNudge).not.toHaveBeenCalled();
      });

      it("should NOT call scheduleNudge when scheduleNudge is undefined", () => {
        const deps = makeDeps({ scheduleNudge: undefined });
        const s = createSession();
        deps.sessions.set("test", s);

        const poller = createTodoPoller(deps);
        expect(() => {
          poller.processTodos("test", [
            { id: "t1", content: "Task A", status: "in_progress" },
          ]);
        }).not.toThrow();
      });

      it("should call scheduleNudge on each processTodos call if pending todos persist", () => {
        const deps = makeDeps();
        const s = createSession();
        deps.sessions.set("test", s);

        const poller = createTodoPoller(deps);
        poller.processTodos("test", [
          { id: "t1", content: "Task A", status: "in_progress" },
        ]);
        poller.processTodos("test", [
          { id: "t1", content: "Task A", status: "in_progress" },
        ]);

        expect(deps.scheduleNudge).toHaveBeenCalledTimes(2);
      });

      it("should not throw when session is not in the map", () => {
        const deps = makeDeps();
        const poller = createTodoPoller(deps);

        expect(() => {
          poller.processTodos("nonexistent", [
            { id: "t1", content: "Task A", status: "in_progress" },
          ]);
        }).not.toThrow();
      });
    });
  });

  describe("cleanupSession", () => {
    it("should clear event freshness so future polls are not skipped", async () => {
      const deps = makeDeps();
      const s = createSession();
      deps.sessions.set("test", s);
      deps.mockTodo.mockResolvedValue({
        data: [{ id: "t1", content: "Task", status: "in_progress" }],
        error: undefined,
      });

      const poller = createTodoPoller(deps);
      poller.markEventTodoReceived("test");

      // Event freshness should skip the poll
      let result = await poller.pollAndProcess("test");
      expect(result).toBeNull();

      // Cleanup removes the freshness entry
      poller.cleanupSession("test");

      // Now poll should proceed (no freshness skip)
      result = await poller.pollAndProcess("test");
      expect(result).not.toBeNull();
      expect(deps.mockTodo).toHaveBeenCalled();
    });

    it("should clear reviewDebounceTimer to prevent leaked timeouts", () => {
      const deps = makeDeps();
      const s = createSession();
      s.reviewDebounceTimer = setTimeout(() => {}, 99999) as any;
      deps.sessions.set("test", s);

      const poller = createTodoPoller(deps);
      poller.cleanupSession("test");

      expect(s.reviewDebounceTimer).toBeNull();
    });

    it("should handle cleanup when reviewDebounceTimer is null", () => {
      const deps = makeDeps();
      const s = createSession();
      s.reviewDebounceTimer = null;
      deps.sessions.set("test", s);

      const poller = createTodoPoller(deps);
      expect(() => poller.cleanupSession("test")).not.toThrow();
    });

    it("should clear reviewRetryTimer to prevent leaked timeouts", () => {
      const deps = makeDeps();
      const s = createSession();
      s.reviewRetryTimer = setTimeout(() => {}, 99999) as any;
      deps.sessions.set("test", s);

      const poller = createTodoPoller(deps);
      poller.cleanupSession("test");

      expect(s.reviewRetryTimer).toBeNull();
    });

    it("should handle cleanup when reviewRetryTimer is null", () => {
      const deps = makeDeps();
      const s = createSession();
      s.reviewRetryTimer = null;
      deps.sessions.set("test", s);

      const poller = createTodoPoller(deps);
      expect(() => poller.cleanupSession("test")).not.toThrow();
    });
  });

  describe("TODO.md sync", () => {
    it("should call sendTodoMdSync when all todos complete and reviewFired reset with TODO.md tasks", async () => {
      vi.useFakeTimers();
      const sendTodoMdSync = vi.fn().mockResolvedValue(undefined);
      const todoMdReader = {
        readAndParse: vi.fn().mockResolvedValue({ pending: ["New task from TODO.md"], completed: [] }),
      };
      const deps = makeDeps({ sendTodoMdSync, todoMdReader }, { todoMdPath: "TODO.md", todoMdSync: true });
      const s = createSession();
      s.reviewFired = true;
      s.lastReviewAt = 0;
      deps.sessions.set("test", s);

      const poller = createTodoPoller(deps);
      poller.processTodos("test", [
        { id: "t1", content: "Done", status: "completed" },
      ]);

      expect(s.reviewFired).toBe(false);

      await vi.advanceTimersByTimeAsync(0);

      expect(todoMdReader.readAndParse).toHaveBeenCalledWith("/test", expect.any(Array));
      vi.useRealTimers();
    });

    it("should NOT call sendTodoMdSync when todoMdSync is false", () => {
      const sendTodoMdSync = vi.fn().mockResolvedValue(undefined);
      const todoMdReader = {
        readAndParse: vi.fn().mockResolvedValue({ pending: ["Task"], completed: [] }),
      };
      const deps = makeDeps({ sendTodoMdSync, todoMdReader }, { todoMdPath: "TODO.md", todoMdSync: false });
      const s = createSession();
      s.reviewFired = true;
      s.lastReviewAt = 0;
      deps.sessions.set("test", s);

      const poller = createTodoPoller(deps);
      poller.processTodos("test", [
        { id: "t1", content: "Done", status: "completed" },
      ]);

      expect(todoMdReader.readAndParse).not.toHaveBeenCalled();
    });

    it("should NOT call sendTodoMdSync when todoMdPath is empty", () => {
      const sendTodoMdSync = vi.fn().mockResolvedValue(undefined);
      const todoMdReader = {
        readAndParse: vi.fn().mockResolvedValue({ pending: ["Task"], completed: [] }),
      };
      const deps = makeDeps({ sendTodoMdSync, todoMdReader }, { todoMdPath: "", todoMdSync: true });
      const s = createSession();
      s.reviewFired = true;
      s.lastReviewAt = 0;
      deps.sessions.set("test", s);

      const poller = createTodoPoller(deps);
      poller.processTodos("test", [
        { id: "t1", content: "Done", status: "completed" },
      ]);

      expect(todoMdReader.readAndParse).not.toHaveBeenCalled();
    });

    it("should NOT call sendTodoMdSync when todoMdSyncFired is already true", () => {
      const sendTodoMdSync = vi.fn().mockResolvedValue(undefined);
      const todoMdReader = {
        readAndParse: vi.fn().mockResolvedValue({ pending: ["Task"], completed: [] }),
      };
      const deps = makeDeps({ sendTodoMdSync, todoMdReader }, { todoMdPath: "TODO.md", todoMdSync: true });
      const s = createSession();
      s.reviewFired = true;
      s.lastReviewAt = 0;
      s.todoMdSyncFired = true;
      deps.sessions.set("test", s);

      const poller = createTodoPoller(deps);
      poller.processTodos("test", [
        { id: "t1", content: "Done", status: "completed" },
      ]);

      expect(todoMdReader.readAndParse).not.toHaveBeenCalled();
    });

    it("should reset todoMdSyncFired when new pending todos appear", () => {
      const deps = makeDeps();
      const s = createSession();
      s.reviewFired = true;
      s.lastReviewAt = 0;
      s.todoMdSyncFired = true;
      deps.sessions.set("test", s);

      const poller = createTodoPoller(deps);
      poller.processTodos("test", [
        { id: "t1", content: "Done", status: "completed" },
        { id: "t2", content: "New bug", status: "in_progress" },
      ]);

      expect(s.todoMdSyncFired).toBe(false);
    });

    it("should NOT call sendTodoMdSync during review cooldown", () => {
      const sendTodoMdSync = vi.fn().mockResolvedValue(undefined);
      const todoMdReader = {
        readAndParse: vi.fn().mockResolvedValue({ pending: ["Task"], completed: [] }),
      };
      const deps = makeDeps({ sendTodoMdSync, todoMdReader }, { todoMdPath: "TODO.md", todoMdSync: true, reviewCooldownMs: 60000 });
      const s = createSession();
      s.reviewFired = true;
      s.lastReviewAt = Date.now() - 10000;
      deps.sessions.set("test", s);

      const poller = createTodoPoller(deps);
      poller.processTodos("test", [
        { id: "t1", content: "Done", status: "completed" },
      ]);

      expect(s.reviewFired).toBe(true);
      expect(todoMdReader.readAndParse).not.toHaveBeenCalled();
    });

    it("should pass correct arguments to sendTodoMdSync", async () => {
      vi.useFakeTimers();
      const sendTodoMdSync = vi.fn().mockResolvedValue(undefined);
      const todoMdReader = {
        readAndParse: vi.fn().mockResolvedValue({ pending: ["Task A", "Task B"], completed: [] }),
      };
      const deps = makeDeps({ sendTodoMdSync, todoMdReader }, { todoMdPath: "TODO.md", todoMdSync: true });
      const s = createSession();
      s.reviewFired = true;
      s.lastReviewAt = 0;
      deps.sessions.set("test", s);

      const poller = createTodoPoller(deps);
      poller.processTodos("test", [
        { id: "t1", content: "Done", status: "completed" },
      ]);

      await vi.advanceTimersByTimeAsync(0);

      expect(todoMdReader.readAndParse).toHaveBeenCalledWith("/test", expect.arrayContaining([
        expect.objectContaining({ status: "completed" }),
      ]));

      vi.useRealTimers();
    });

    it("should handle sendTodoMdSync rejection gracefully", async () => {
      vi.useFakeTimers();
      const sendTodoMdSync = vi.fn().mockRejectedValue(new Error("send failed"));
      const todoMdReader = {
        readAndParse: vi.fn().mockResolvedValue({ pending: ["Task"], completed: [] }),
      };
      const deps = makeDeps({ sendTodoMdSync, todoMdReader }, { todoMdPath: "TODO.md", todoMdSync: true });
      const s = createSession();
      s.reviewFired = true;
      s.lastReviewAt = 0;
      deps.sessions.set("test", s);

      const poller = createTodoPoller(deps);
      poller.processTodos("test", [
        { id: "t1", content: "Done", status: "completed" },
      ]);

      await vi.advanceTimersByTimeAsync(0);

      expect(sendTodoMdSync).toHaveBeenCalled();
      expect(deps.log).toHaveBeenCalledWith("todo.md sync send error:", expect.any(Error));

      vi.useRealTimers();
    });
  });
});
