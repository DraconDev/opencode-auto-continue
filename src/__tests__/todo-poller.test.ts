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
    ...overrides,
  } as any;
}

function makeDeps(overrides: Record<string, unknown> = {}) {
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

  return {
    config: makeConfig(),
    sessions,
    log,
    isDisposed: () => false,
    input,
    writeStatusFile,
    triggerReview,
    maybeOpportunisticCompact,
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
  });
});
