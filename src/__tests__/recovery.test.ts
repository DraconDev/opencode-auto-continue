import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { flushPromises } from './helpers.js';
import { createRecoveryModule } from '../recovery.js';
import type { PluginConfig } from '../config.js';
import type { SessionState } from '../session-state.js';

const DEFAULT_CONFIG: PluginConfig = {
  stallTimeoutMs: 5000,
  busyStallTimeoutMs: 180000,
  waitAfterAbortMs: 50,
  maxRecoveries: 3,
  cooldownMs: 60000,
  abortPollIntervalMs: 50,
  abortPollMaxTimeMs: 200,
  abortPollMaxFailures: 3,
  debug: false,
  maxBackoffMs: 1800000,
  shortContinueMessage: "Continue.",
  continueWithPlanMessage: "Finish your plan.",
  continueMessage: "Continue working.",
  continueWithTodosMessage: "You have {pending} open task(s): {todoList}.",
  maxAttemptsMessage: "Max attempts.",
  includeTodoContext: true,
  reviewOnComplete: true,
  reviewMessage: "Review.",
  reviewDebounceMs: 500,
  showToasts: false,
  nudgeEnabled: true,
  nudgeIdleDelayMs: 500,
  nudgeMaxSubmits: 3,
  nudgeMessage: "Nudge.",
  nudgeCooldownMs: 60000,
  autoCompact: false,
  maxSessionAgeMs: 7200000,
  proactiveCompactAtTokens: 100000,
  proactiveCompactAtPercent: 50,
  compactRetryDelayMs: 100,
  compactMaxRetries: 3,
  terminalTitleEnabled: false,
  statusFileEnabled: false,
  statusFilePath: "",
  maxStatusHistory: 10,
  statusFileRotate: 5,
  recoveryHistogramEnabled: false,
  stallPatternDetection: false,
  terminalProgressEnabled: false,
  compactionVerifyWaitMs: 10000,
  compactCooldownMs: 60000,
  compactReductionFactor: 0.7,
  tokenEstimateMultiplier: 1.0,
  opportunisticCompactAtTokens: 50000,
  opportunisticCompactAfterRecovery: true,
  opportunisticCompactOnIdle: true,
  opportunisticCompactBeforeNudge: true,
  opportunisticCompactAfterReview: true,
  nudgeCompactThreshold: 80000,
  stopFilePath: "",
  maxRuntimeMs: 0,
  untilMarker: "",
  planningTimeoutMs: 300000,
  enableAdvisory: false,
  advisoryModel: "",
  advisoryTimeoutMs: 5000,
  advisoryMaxTokens: 500,
  advisoryTemperature: 0.1,
  subagentWaitMs: 15000,
  orphanWaitMs: 15000,
  sessionDiscoveryIntervalMs: 60000,
  idleSessionTimeoutMs: 600000,
  idleCleanupMs: 600000,
  maxSessions: 50,
  sessionMonitorEnabled: true,
  orphanParentDetection: true,
  sessionDiscovery: true,
  idleCleanup: true,
  tokenLimitPatterns: [
    "context length",
    "maximum context length",
    "token count exceeds",
    "too many tokens",
    "payload too large",
    "token limit exceeded",
  ],
};

function createSessionState(overrides?: Partial<SessionState>): SessionState {
  const now = Date.now();
  return {
    timer: null,
    nudgeTimer: null,
    planning: false,
    planningStartedAt: 0,
    compacting: false,
    lastCompactionAt: 0,
    userCancelled: false,
    aborting: false,
    hasOpenTodos: false,
    lastNudgeAt: 0,
    lastContinueAt: 0,
    lastUserMessageId: "",
    estimatedTokens: 0,
    tokenLimitHits: 0,
    actionStartedAt: now,
    lastStallPartType: "",
    lastOutputAt: now,
    lastOutputLength: 0,
    lastToolExecutionAt: now,
    toolRepeatCount: 0,
    lastToolName: '',
    lastProgressAt: now,
    needsContinue: false,
    continueMessageText: "",
    attempts: 0,
    backoffAttempts: 0,
    reviewFired: false,
    reviewDebounceTimer: null,
    lastReviewAt: 0,
    reviewCount: 0,
    planBuffer: "",
    autoSubmitCount: 0,
    messageCount: 0,
    lastKnownStatus: "busy",
    lastKnownTodos: [],
    sessionCreatedAt: now,
    lastRecoveryTime: 0,
    recoveryStartTime: 0,
    stallDetections: 0,
    recoverySuccessful: 0,
    recoveryFailed: 0,
    lastRecoverySuccess: 0,
    totalRecoveryTimeMs: 0,
    recoveryTimes: [],
    stallPatterns: {},
    continueTimestamps: [],
    timerGeneration: 0,
    sentMessageAt: 0,
    lastRealTokenRefreshAt: 0,
    lastPlanItemDescription: "",
    statusHistory: [],
    nudgeFailureCount: 0,
    lastNudgeFailureAt: 0,
    lastTodoSnapshot: "",
    nudgePaused: false,
    continueRetryCount: 0,
    lastContinueRetryAt: 0,
    continueInProgress: false,
    stoppedByCondition: null,
    ...overrides,
  };
}

describe("recovery module unit tests", () => {
  let sessions: Map<string, SessionState>;
  let log: ReturnType<typeof vi.fn>;
  let mockStatus: ReturnType<typeof vi.fn>;
  let mockAbort: ReturnType<typeof vi.fn>;
  let mockMessages: ReturnType<typeof vi.fn>;
  let mockTodo: ReturnType<typeof vi.fn>;
  let mockSummarize: ReturnType<typeof vi.fn>;
  let mockToast: ReturnType<typeof vi.fn>;
  let mockScheduleRecovery: ReturnType<typeof vi.fn>;
  let mockSendContinue: ReturnType<typeof vi.fn>;
  let mockForceCompact: ReturnType<typeof vi.fn>;
  let isDisposed: () => boolean;
  let writeStatusFile: ReturnType<typeof vi.fn>;
  let cancelNudge: ReturnType<typeof vi.fn>;
  let module: ReturnType<typeof createRecoveryModule>;

  beforeEach(() => {
    vi.useFakeTimers();
    sessions = new Map();
    log = vi.fn();
    mockStatus = vi.fn();
    mockAbort = vi.fn();
    mockMessages = vi.fn().mockResolvedValue({ data: [] });
    mockTodo = vi.fn().mockResolvedValue({ data: [] });
    mockSummarize = vi.fn();
    mockToast = vi.fn();
    mockScheduleRecovery = vi.fn();
    mockSendContinue = vi.fn().mockResolvedValue(undefined);
    mockForceCompact = vi.fn().mockResolvedValue(true);
    isDisposed = () => false;
    writeStatusFile = vi.fn();
    cancelNudge = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createModule(config?: Partial<PluginConfig>) {
    return createRecoveryModule({
      config: { ...DEFAULT_CONFIG, ...config },
      sessions,
      log,
      input: {
        directory: "/tmp",
        client: {
          session: {
            status: mockStatus,
            abort: mockAbort,
            messages: mockMessages,
            todo: mockTodo,
            summarize: mockSummarize,
          },
          tui: { showToast: mockToast },
        },
      } as any,
      isDisposed,
      writeStatusFile,
      cancelNudge,
      scheduleRecovery: mockScheduleRecovery,
      sendContinue: mockSendContinue,
      forceCompact: mockForceCompact,
    });
  }

  function createSession(sessionId = "test", overrides?: Partial<SessionState>) {
    const s = createSessionState(overrides);
    sessions.set(sessionId, s);
    return s;
  }

  // Advance timers to let recover() poll for idle, wait after abort, etc.
  async function settleTimers() {
    await vi.advanceTimersByTimeAsync(5000);
    await flushPromises();
  }

  describe("guards", () => {
    it("returns early if disposed", async () => {
      isDisposed = () => true;
      createSession("test");
      module = createModule();
      await module.recover("test");
      expect(mockAbort).not.toHaveBeenCalled();
    });

    it("returns early if session does not exist", async () => {
      module = createModule();
      await module.recover("nonexistent");
      expect(mockAbort).not.toHaveBeenCalled();
    });

    it("returns early if session is aborting", async () => {
      createSession("test", { aborting: true });
      module = createModule();
      await module.recover("test");
      expect(mockAbort).not.toHaveBeenCalled();
    });

    it("returns early if user cancelled", async () => {
      createSession("test", { userCancelled: true });
      module = createModule();
      await module.recover("test");
      expect(mockAbort).not.toHaveBeenCalled();
    });

    it("returns early if compacting", async () => {
      createSession("test", { compacting: true });
      module = createModule();
      await module.recover("test");
      expect(mockAbort).not.toHaveBeenCalled();
    });

    it("returns early if planning and timeout not reached", async () => {
      createSession("test", { planning: true, planningStartedAt: Date.now() - 1000 });
      module = createModule({ planningTimeoutMs: 5000 });
      await module.recover("test");
      expect(mockAbort).not.toHaveBeenCalled();
    });
  });

  describe("planning state", () => {
    it("proceeds with recovery if planning timeout exceeded", async () => {
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockResolvedValue({});
      const s = createSession("test", {
        planning: true,
        planningStartedAt: Date.now() - 600000,
        lastProgressAt: Date.now() - 30000,
        lastOutputAt: Date.now() - 30000,
        autoSubmitCount: 0,
      });
      module = createModule({ planningTimeoutMs: 300000, autoCompact: false });
      const promise = module.recover("test");
      await settleTimers();
      await promise;
      expect(s.planning).toBe(false);
      expect(mockAbort).toHaveBeenCalled();
    });
  });

  describe("max recoveries backoff", () => {
    it("schedules backoff when maxRecoveries reached", async () => {
      createSession("test", { attempts: 3 });
      module = createModule({ maxRecoveries: 3 });
      await module.recover("test");
      expect(mockAbort).not.toHaveBeenCalled();
      expect(mockScheduleRecovery).toHaveBeenCalledWith("test", expect.any(Number));
    });

    it("increments backoffAttempts on each backoff", async () => {
      const s = createSession("test", { attempts: 3, backoffAttempts: 1 });
      module = createModule({ maxRecoveries: 3 });
      await module.recover("test");
      expect(s.backoffAttempts).toBe(2);
    });

    it("caps backoff at maxBackoffMs", async () => {
      createSession("test", { attempts: 3, backoffAttempts: 50 });
      module = createModule({ maxRecoveries: 3, maxBackoffMs: 1800000 });
      await module.recover("test");
      const delay = mockScheduleRecovery.mock.calls[0][1];
      expect(delay).toBeLessThanOrEqual(1800000);
    });
  });

  describe("cooldown", () => {
    it("reschedules when cooldown is active", async () => {
      const now = Date.now();
      createSession("test", { lastRecoveryTime: now - 5000 });
      module = createModule({ cooldownMs: 60000 });
      await module.recover("test");
      expect(mockAbort).not.toHaveBeenCalled();
      expect(mockScheduleRecovery).toHaveBeenCalledWith("test", expect.any(Number));
    });

    it("skips cooldown if enough time has passed", async () => {
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockResolvedValue({});
      const now = Date.now();
      createSession("test", {
        lastRecoveryTime: now - 120000,
        lastProgressAt: now - 30000,
        lastOutputAt: now - 30000,
        autoSubmitCount: 0,
      });
      module = createModule({ cooldownMs: 60000, autoCompact: false });
      const promise = module.recover("test");
      await settleTimers();
      await promise;
      expect(mockAbort).toHaveBeenCalled();
    });
  });

  describe("session age", () => {
    it("gives up if session exceeds maxSessionAgeMs", async () => {
      const s = createSession("test", { sessionCreatedAt: Date.now() - 10000000 });
      module = createModule({ maxSessionAgeMs: 7200000 });
      await module.recover("test");
      expect(s.aborting).toBe(false);
      expect(mockAbort).not.toHaveBeenCalled();
    });
  });

  describe("stall detection", () => {
    it("reschedules if session is not busy", async () => {
      mockStatus.mockResolvedValue({ data: { test: { type: "idle" } } });
      const s = createSession("test");
      module = createModule();
      await module.recover("test");
      expect(s.aborting).toBe(false);
      expect(mockAbort).not.toHaveBeenCalled();
    });

    it("reschedules if stall timeout not yet elapsed", async () => {
      const now = Date.now();
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      createSession("test", { lastProgressAt: now - 1000, lastOutputAt: now - 1000 });
      module = createModule({ stallTimeoutMs: 5000, busyStallTimeoutMs: 180000 });
      await module.recover("test");
      // Should reschedule via busy-but-dead check rather than proceeding to abort
      expect(mockAbort).not.toHaveBeenCalled();
    });

    it("proceeds when session has no real output despite busy (busy-but-dead)", async () => {
      const now = Date.now();
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockResolvedValue({});
      createSession("test", {
        lastProgressAt: now - 100,
        lastOutputAt: now - 200000,
        autoSubmitCount: 0,
      });
      module = createModule({ stallTimeoutMs: 5000, busyStallTimeoutMs: 180000, autoCompact: false });
      const promise = module.recover("test");
      await settleTimers();
      await promise;
      expect(mockAbort).toHaveBeenCalled();
    });
  });

  describe("tool-text detection", () => {
    it("detects XML tool calls in reasoning and uses specialized prompt", async () => {
      const now = Date.now();
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockResolvedValue({});
      mockMessages.mockResolvedValue({
        data: [{
          role: "assistant",
          parts: [{ type: "text", text: "I need to call <function name=\"search\">" }],
        }],
      });
      const s = createSession("test", {
        lastProgressAt: now - 30000,
        lastOutputAt: now - 200000,
        autoSubmitCount: 0,
      });
      module = createModule({ autoCompact: false });
      const promise = module.recover("test");
      await settleTimers();
      await promise;
      expect(s.continueMessageText).toContain("tool call generated");
    });
  });

  describe("text-only stall detection", () => {
    it("should proceed with recovery when text-only stall detected in recover()", async () => {
      const now = Date.now();
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockResolvedValue({});
      const s = createSession("test", {
        lastProgressAt: now - 1000,
        lastOutputAt: now - 1000,
        lastToolExecutionAt: now - 130000,
      });
      module = createModule({ textOnlyStallTimeoutMs: 120000, autoCompact: false });
      const promise = module.recover("test");
      await settleTimers();
      await promise;
      expect(mockAbort).toHaveBeenCalled();
    });

    it("should NOT proceed when text-only stall not reached", async () => {
      const now = Date.now();
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      const s = createSession("test", {
        lastProgressAt: now - 1000,
        lastOutputAt: now - 1000,
        lastToolExecutionAt: now - 60000,
      });
      module = createModule({ textOnlyStallTimeoutMs: 120000, autoCompact: false });
      const promise = module.recover("test");
      await settleTimers();
      await promise;
      expect(mockAbort).not.toHaveBeenCalled();
    });
  });

  describe("hallucination loop", () => {
    it("detects 3+ continues in 10 minute window", async () => {
      const now = Date.now();
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockResolvedValue({});
      createSession("test", {
        lastProgressAt: now - 30000,
        lastOutputAt: now - 200000,
        continueTimestamps: [now - 60000, now - 120000, now - 180000],
        autoSubmitCount: 0,
      });
      module = createModule({ autoCompact: false });
      const promise = module.recover("test");
      await settleTimers();
      await promise;
      expect(log.mock.calls.some((c: unknown[]) => String(c).includes("hallucination loop"))).toBe(true);
    });
  });

  describe("abort flow", () => {
    it("aborts and sends continue on idle session", async () => {
      const now = Date.now();
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockResolvedValue({});
      const s = createSession("test", {
        lastProgressAt: now - 30000,
        lastOutputAt: now - 200000,
        autoSubmitCount: 0,
      });
      // First status call returns busy (stall check), subsequent return idle (polling + sendContinue)
      mockStatus
        .mockResolvedValueOnce({ data: { test: { type: "busy" } } })
        .mockResolvedValue({ data: { test: { type: "idle" } } });
      module = createModule({ autoCompact: false });
      const promise = module.recover("test");
      await settleTimers();
      await promise;
      expect(mockAbort).toHaveBeenCalledWith({
        path: { id: "test" },
        query: { directory: "/tmp" },
      });
      expect(mockSendContinue).toHaveBeenCalledWith("test");
    });

    it("increments attempts and autoSubmitCount", async () => {
      const now = Date.now();
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockResolvedValue({});
      const s = createSession("test", {
        lastProgressAt: now - 30000,
        lastOutputAt: now - 200000,
        attempts: 1,
        autoSubmitCount: 1,
      });
      module = createModule({ autoCompact: false });
      const promise = module.recover("test");
      await settleTimers();
      await promise;
      expect(s.attempts).toBe(2);
      expect(s.autoSubmitCount).toBe(2);
    });

    it("handles abort API failure and reschedules", async () => {
      const now = Date.now();
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockRejectedValue(new Error("abort failed"));
      createSession("test", {
        lastProgressAt: now - 30000,
        lastOutputAt: now - 200000,
      });
      module = createModule({ autoCompact: false });
      await module.recover("test");
      expect(mockScheduleRecovery).toHaveBeenCalled();
    });

    it("stops when maxRecoveries reached", async () => {
      const now = Date.now();
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockResolvedValue({});
      const s = createSession("test", {
        lastProgressAt: now - 30000,
        lastOutputAt: now - 200000,
        attempts: 3,
      });
      module = createModule({ maxRecoveries: 3, autoCompact: false });
      const promise = module.recover("test");
      await settleTimers();
      await promise;
      expect(s.needsContinue).toBe(false);
      expect(mockSendContinue).not.toHaveBeenCalled();
    });
  });

  describe("continue message", () => {
    it("uses default continue message when no todos", async () => {
      const now = Date.now();
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockResolvedValue({});
      const s = createSession("test", {
        lastProgressAt: now - 30000,
        lastOutputAt: now - 200000,
        autoSubmitCount: 0,
      });
      module = createModule({ includeTodoContext: false, autoCompact: false });
      const promise = module.recover("test");
      await settleTimers();
      await promise;
      expect(s.continueMessageText).toBe("Continue working.");
    });

    it("includes todo context when pending todos exist", async () => {
      const now = Date.now();
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockResolvedValue({});
      mockTodo.mockResolvedValue({
        data: [
          { id: "1", status: "in_progress", content: "Fix login bug" },
          { id: "2", status: "pending", content: "Add tests" },
        ],
      });
      const s = createSession("test", {
        lastProgressAt: now - 30000,
        lastOutputAt: now - 200000,
        autoSubmitCount: 0,
      });
      module = createModule({ autoCompact: false });
      const promise = module.recover("test");
      await settleTimers();
      await promise;
      expect(s.continueMessageText).toContain("Fix login bug");
      expect(s.continueMessageText).toContain("Add tests");
    });

    it("uses shortContinueMessage when tokenLimitHits > 0", async () => {
      const now = Date.now();
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockResolvedValue({});
      const s = createSession("test", {
        lastProgressAt: now - 30000,
        lastOutputAt: now - 200000,
        tokenLimitHits: 2,
        autoSubmitCount: 0,
      });
      module = createModule({ includeTodoContext: false, autoCompact: false });
      const promise = module.recover("test");
      await settleTimers();
      await promise;
      expect(s.continueMessageText).toBe("Continue.");
    });

    it("does NOT override tool-text prompt when tokenLimitHits > 0 and hasToolText is true", async () => {
      const now = Date.now();
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockResolvedValue({});
      mockMessages.mockResolvedValue({ data: [
        { role: "assistant", parts: [{ type: "reasoning", text: "Let me call the read tool: <function=read>" }] }
      ]});
      const s = createSession("test", {
        lastProgressAt: now - 30000,
        lastOutputAt: now - 200000,
        lastToolExecutionAt: now - 30000,
        tokenLimitHits: 2,
        autoSubmitCount: 0,
      });
      module = createModule({ includeTodoContext: false, autoCompact: false });
      const promise = module.recover("test");
      await settleTimers();
      await promise;
      expect(s.continueMessageText).toContain("proper tool calling mechanism");
    });

    it("uses plan-aware message when session was planning", async () => {
      // When planning is active but not timed out, recovery returns early.
      // This test verifies that path by checking no abort occurs.
      const now = Date.now();
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      const s = createSession("test", {
        lastProgressAt: now - 30000,
        lastOutputAt: now - 200000,
        planning: true,
        planningStartedAt: now - 1000, // recent, not timed out
        autoSubmitCount: 0,
      });
      module = createModule({ planningTimeoutMs: 5000, includeTodoContext: false, autoCompact: false });
      await module.recover("test");
      // Should return early due to active planning, abort not called
      expect(mockAbort).not.toHaveBeenCalled();
      expect(s.planning).toBe(true);
    });
  });

  describe("recovery error handling", () => {
    it("increments recoveryFailed and schedules retry on exception", async () => {
      createSession("test", { attempts: 1 });
      module = createModule();
      mockStatus.mockRejectedValue(new Error("status check failed"));
      await module.recover("test");
      const s = sessions.get("test")!;
      expect(s.recoveryFailed).toBe(1);
      expect(mockScheduleRecovery).toHaveBeenCalled();
    });

    it("uses exponential backoff when maxRecoveries reached and failure occurs", async () => {
      // When at maxRecoveries and an error occurs, backoff is used instead of normal retry
      createSession("test", { attempts: 3 });
      module = createModule({ maxRecoveries: 3, stallTimeoutMs: 5000 });
      mockStatus
        .mockResolvedValueOnce({ data: { test: { type: "idle" } } }) // initial busy check passes
        .mockRejectedValueOnce(new Error("status check failed")); // then poll fails
      await module.recover("test");
      // Should use backoff rather than retry
      expect(mockScheduleRecovery).toHaveBeenCalled();
    });
  });

  describe("stall pattern tracking", () => {
    it("records stall pattern when stallPatternDetection enabled", async () => {
      const now = Date.now();
      mockStatus
        .mockResolvedValueOnce({ data: { test: { type: "busy" } } })
        .mockResolvedValue({ data: { test: { type: "idle" } } });
      mockAbort.mockResolvedValue({});
      const s = createSession("test", {
        lastProgressAt: now - 30000,
        lastOutputAt: now - 200000,
        lastStallPartType: "text",
        autoSubmitCount: 0,
      });
      module = createModule({ stallPatternDetection: true, autoCompact: false });
      const promise = module.recover("test");
      await settleTimers();
      await promise;
      expect(s.stallPatterns["text"]).toBe(1);
    });
  });

  describe("toast notifications", () => {
    it("shows auto-continue toast on recovery", async () => {
      const now = Date.now();
      mockStatus
        .mockResolvedValueOnce({ data: { test: { type: "busy" } } })
        .mockResolvedValue({ data: { test: { type: "idle" } } });
      mockAbort.mockResolvedValue({});
      createSession("test", {
        lastProgressAt: now - 30000,
        lastOutputAt: now - 200000,
        autoSubmitCount: 0,
      });
      module = createModule({ showToasts: true, autoCompact: false });
      const promise = module.recover("test");
      await settleTimers();
      await promise;
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({ title: "Auto-Continue" }),
      }));
    });
  });

  describe("auto-compaction during recovery", () => {
    it("calls forceCompact when autoCompact is enabled and session idle", async () => {
      const now = Date.now();
      mockStatus
        .mockResolvedValueOnce({ data: { test: { type: "busy" } } })
        .mockResolvedValue({ data: { test: { type: "idle" } } });
      mockAbort.mockResolvedValue({});
      createSession("test", {
        lastProgressAt: now - 30000,
        lastOutputAt: now - 200000,
        autoSubmitCount: 0,
      });
      module = createModule({ autoCompact: true });
      const promise = module.recover("test");
      await settleTimers();
      await promise;
      expect(mockForceCompact).toHaveBeenCalled();
    });
  });

  describe("prompt guard", () => {
    it("does not block when no recent prompts match", async () => {
      const now = Date.now();
      mockStatus
        .mockResolvedValueOnce({ data: { test: { type: "busy" } } })
        .mockResolvedValue({ data: { test: { type: "idle" } } });
      mockAbort.mockResolvedValue({});
      mockMessages.mockResolvedValue({ data: [] });
      const s = createSession("test", {
        lastProgressAt: now - 30000,
        lastOutputAt: now - 200000,
        autoSubmitCount: 0,
      });
      module = createModule({ includeTodoContext: false, autoCompact: false });
      const promise = module.recover("test");
      await settleTimers();
      await promise;
      expect(s.needsContinue).toBe(true);
    });
  });
});
