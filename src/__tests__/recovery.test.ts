import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { flushPromises } from './helpers.js';
import { createRecoveryModule } from '../recovery.js';
import type { PluginConfig } from '../config.js';
import type { SessionState } from '../session-state.js';
import type { AIAdvisor } from '../ai-advisor.js';

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
  maxAutoSubmits: 3,
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
  compactAtMessageCount: 50,
  tokenEstimateMultiplier: 1.0,
  dcpDetected: false,
  dcpVersion: null,
  planningTimeoutMs: 300000,
  busyStallTimeoutMs_conflict: 180000,
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
    lastProgressAt: now,
    needsContinue: false,
    continueMessageText: "",
    attempts: 0,
    backoffAttempts: 0,
    reviewFired: false,
    reviewDebounceTimer: null,
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
    lastAdvisoryAdvice: null,
    lastPlanItemDescription: "",
    statusHistory: [],
    nudgeFailureCount: 0,
    lastNudgeFailureAt: 0,
    lastTodoSnapshot: "",
    nudgePaused: false,
    continueRetryCount: 0,
    lastContinueRetryAt: 0,
    continueInProgress: false,
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
  let isDisposed: () => boolean;
  let writeStatusFile: ReturnType<typeof vi.fn>;
  let cancelNudge: ReturnType<typeof vi.fn>;
  let module: ReturnType<typeof createRecoveryModule>;
  let statusCallIndex: number;

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
    isDisposed = () => false;
    writeStatusFile = vi.fn();
    cancelNudge = vi.fn();
    statusCallIndex = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createModule(config?: Partial<PluginConfig>, aiAdvisor?: AIAdvisor) {
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
      aiAdvisor,
      sendContinue: mockSendContinue,
    });
  }

  function setupBusySession(sessionId: string = "test", overrides?: Partial<SessionState>) {
    const s = createSessionState(overrides);
    sessions.set(sessionId, s);
    // Default: first status call returns busy, subsequent return idle
    mockStatus.mockResolvedValue({ data: { [sessionId]: { type: "idle" } } });
    return s;
  }

  describe("guards", () => {
    it("returns early if disposed", async () => {
      isDisposed = () => true;
      setupBusySession("test");
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
      setupBusySession("test", { aborting: true });
      module = createModule();
      await module.recover("test");
      expect(mockAbort).not.toHaveBeenCalled();
    });

    it("returns early if user cancelled", async () => {
      setupBusySession("test", { userCancelled: true });
      module = createModule();
      await module.recover("test");
      expect(mockAbort).not.toHaveBeenCalled();
    });

    it("returns early if compacting", async () => {
      setupBusySession("test", { compacting: true });
      module = createModule();
      await module.recover("test");
      expect(mockAbort).not.toHaveBeenCalled();
    });
  });

  describe("planning state", () => {
    it("skips recovery if planning and timeout not reached", async () => {
      setupBusySession("test", { planning: true, planningStartedAt: Date.now() - 1000 });
      module = createModule({ planningTimeoutMs: 5000 });
      await module.recover("test");
      expect(mockAbort).not.toHaveBeenCalled();
    });

    it("proceeds with recovery if planning timeout exceeded", async () => {
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      const s = setupBusySession("test", { planning: true, planningStartedAt: Date.now() - 600000 });
      s.autoSubmitCount = 0;
      mockAbort.mockResolvedValue({});
      module = createModule({ planningTimeoutMs: 300000, autoCompact: false, stallPatternDetection: false });
      const promise = module.recover("test");
      await vi.advanceTimersByTimeAsync(500);
      await flushPromises();
      await promise;
      expect(s.planning).toBe(false);
      expect(mockAbort).toHaveBeenCalled();
    });
  });

  describe("max recoveries backoff", () => {
    it("schedules backoff when maxRecoveries reached", async () => {
      setupBusySession("test", { attempts: 3, maxRecoveries: 3 });
      module = createModule({ maxRecoveries: 3 });
      await module.recover("test");
      expect(mockAbort).not.toHaveBeenCalled();
      expect(mockScheduleRecovery).toHaveBeenCalledWith("test", expect.any(Number));
    });

    it("increments backoffAttempts when maxRecoveries reached", async () => {
      const s = setupBusySession("test", { attempts: 3, backoffAttempts: 1 });
      module = createModule({ maxRecoveries: 3 });
      await module.recover("test");
      expect(s.backoffAttempts).toBe(2);
    });

    it("caps backoff at maxBackoffMs", async () => {
      const s = setupBusySession("test", { attempts: 3, backoffAttempts: 50 });
      module = createModule({ maxRecoveries: 3, maxBackoffMs: 1800000, stallTimeoutMs: 5000 });
      await module.recover("test");
      const delay = mockScheduleRecovery.mock.calls[0][1];
      expect(delay).toBeLessThanOrEqual(1800000);
    });
  });

  describe("cooldown", () => {
    it("reschedules when cooldown is active", async () => {
      setupBusySession("test", { lastRecoveryTime: Date.now() - 5000 });
      module = createModule({ cooldownMs: 60000 });
      await module.recover("test");
      expect(mockAbort).not.toHaveBeenCalled();
      expect(mockScheduleRecovery).toHaveBeenCalledWith("test", expect.any(Number));
    });

    it("skips cooldown if enough time has passed", async () => {
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockResolvedValue({});
      setupBusySession("test", { lastRecoveryTime: Date.now() - 120000 });
      module = createModule({ cooldownMs: 60000, autoCompact: false, stallPatternDetection: false });
      const promise = module.recover("test");
      await vi.advanceTimersByTimeAsync(500);
      await flushPromises();
      await promise;
      expect(mockAbort).toHaveBeenCalled();
    });
  });

  describe("session age", () => {
    it("gives up if session exceeds maxSessionAgeMs", async () => {
      const s = setupBusySession("test", { sessionCreatedAt: Date.now() - 10000000 });
      module = createModule({ maxSessionAgeMs: 7200000 });
      await module.recover("test");
      expect(s.aborting).toBe(false);
      expect(mockAbort).not.toHaveBeenCalled();
    });
  });

  describe("stall detection", () => {
    it("reschedules if session is not busy", async () => {
      mockStatus.mockResolvedValue({ data: { test: { type: "idle" } } });
      const s = setupBusySession("test");
      module = createModule();
      await module.recover("test");
      expect(s.aborting).toBe(false);
      expect(mockAbort).not.toHaveBeenCalled();
    });

    it("reschedules if stall timeout has not elapsed for progress", async () => {
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      const s = setupBusySession("test", { lastProgressAt: Date.now() - 1000, lastOutputAt: Date.now() - 1000 });
      module = createModule({ stallTimeoutMs: 5000, busyStallTimeoutMs: 180000 });
      await module.recover("test");
      expect(s.aborting).toBe(false);
      expect(mockScheduleRecovery).toHaveBeenCalled();
    });

    it("proceeds when progress pinged but no real output (busy-but-dead)", async () => {
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockResolvedValue({});
      const s = setupBusySession("test", { lastProgressAt: Date.now() - 100, lastOutputAt: Date.now() - 200000 });
      s.autoSubmitCount = 0;
      module = createModule({ stallTimeoutMs: 5000, busyStallTimeoutMs: 180000, autoCompact: false, stallPatternDetection: false });
      const promise = module.recover("test");
      await vi.advanceTimersByTimeAsync(500);
      await flushPromises();
      await promise;
      expect(mockAbort).toHaveBeenCalled();
    });
  });

  describe("tool-text detection", () => {
    it("detects tool call in session messages and uses recovery prompt", async () => {
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockResolvedValue({});
      mockMessages.mockResolvedValue({
        data: [
          {
            role: "assistant",
            parts: [{ type: "text", text: "I need to call <function name=\"search\">" }],
          },
        ],
      });
      const s = setupBusySession("test", { lastProgressAt: Date.now() - 10000, lastOutputAt: Date.now() - 10000 });
      s.autoSubmitCount = 0;
      module = createModule({ stallTimeoutMs: 5000, busyStallTimeoutMs: 5000, autoCompact: false, stallPatternDetection: false });
      const promise = module.recover("test");
      await vi.advanceTimersByTimeAsync(500);
      await flushPromises();
      await promise;
      expect(s.continueMessageText).toContain("tool call generated");
    });
  });

  describe("hallucination loop", () => {
    it("detects hallucination loop with 3+ continues in 10min", async () => {
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockResolvedValue({});
      const s = setupBusySession("test", {
        lastProgressAt: Date.now() - 10000,
        lastOutputAt: Date.now() - 10000,
        continueTimestamps: [
          Date.now() - 60000,
          Date.now() - 120000,
          Date.now() - 180000,
        ],
      });
      s.autoSubmitCount = 0;
      module = createModule({ stallTimeoutMs: 5000, busyStallTimeoutMs: 5000, autoCompact: false, stallPatternDetection: false });
      const promise = module.recover("test");
      await vi.advanceTimersByTimeAsync(5000);
      await flushPromises();
      await promise;
      expect(log.mock.calls.some((c: unknown[]) => String(c).includes("hallucination loop"))).toBe(true);
    });
  });

  describe("abort flow", () => {
    it("aborts and sends continue when session is idle after abort", async () => {
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockResolvedValue({});
      const s = setupBusySession("test", { lastProgressAt: Date.now() - 10000, lastOutputAt: Date.now() - 10000 });
      s.autoSubmitCount = 0;
      module = createModule({ stallTimeoutMs: 5000, busyStallTimeoutMs: 5000, autoCompact: false, stallPatternDetection: false });
      const promise = module.recover("test");
      await vi.advanceTimersByTimeAsync(1000);
      await flushPromises();
      await promise;
      expect(mockAbort).toHaveBeenCalledWith({
        path: { id: "test" },
        query: { directory: "/tmp" },
      });
      expect(mockSendContinue).toHaveBeenCalledWith("test");
    });

    it("increments attempts and autoSubmitCount on successful recovery", async () => {
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockResolvedValue({});
      const s = setupBusySession("test", { lastProgressAt: Date.now() - 10000, lastOutputAt: Date.now() - 10000, attempts: 1, autoSubmitCount: 1 });
      module = createModule({ stallTimeoutMs: 5000, busyStallTimeoutMs: 5000, autoCompact: false, stallPatternDetection: false });
      const promise = module.recover("test");
      await vi.advanceTimersByTimeAsync(1000);
      await flushPromises();
      await promise;
      expect(s.attempts).toBe(2);
      expect(s.autoSubmitCount).toBe(2);
    });

    it("handles abort API failure and reschedules", async () => {
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockRejectedValue(new Error("abort failed"));
      setupBusySession("test", { lastProgressAt: Date.now() - 10000, lastOutputAt: Date.now() - 10000 });
      module = createModule({ stallTimeoutMs: 5000, busyStallTimeoutMs: 5000 });
      await module.recover("test");
      expect(mockScheduleRecovery).toHaveBeenCalled();
    });

    it("stops recovery when maxAutoSubmits reached", async () => {
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockResolvedValue({});
      const s = setupBusySession("test", { lastProgressAt: Date.now() - 10000, lastOutputAt: Date.now() - 10000, autoSubmitCount: 3 });
      module = createModule({ stallTimeoutMs: 5000, busyStallTimeoutMs: 5000, maxAutoSubmits: 3, autoCompact: false, stallPatternDetection: false });
      const promise = module.recover("test");
      await vi.advanceTimersByTimeAsync(1000);
      await flushPromises();
      await promise;
      expect(s.needsContinue).toBe(false);
      expect(mockSendContinue).not.toHaveBeenCalled();
    });
  });

  describe("continue message", () => {
    it("uses default continue message when no todos", async () => {
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockResolvedValue({});
      const s = setupBusySession("test", { lastProgressAt: Date.now() - 10000, lastOutputAt: Date.now() - 10000 });
      s.autoSubmitCount = 0;
      module = createModule({ stallTimeoutMs: 5000, busyStallTimeoutMs: 5000, includeTodoContext: true, autoCompact: false, stallPatternDetection: false });
      const promise = module.recover("test");
      await vi.advanceTimersByTimeAsync(1000);
      await flushPromises();
      await promise;
      expect(s.continueMessageText).toBe("Continue working.");
    });

    it("includes todo context when pending todos exist", async () => {
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockResolvedValue({});
      mockTodo.mockResolvedValue({
        data: [
          { id: "1", status: "in_progress", content: "Fix login bug" },
          { id: "2", status: "pending", content: "Add tests" },
        ],
      });
      const s = setupBusySession("test", { lastProgressAt: Date.now() - 10000, lastOutputAt: Date.now() - 10000 });
      s.autoSubmitCount = 0;
      module = createModule({ stallTimeoutMs: 5000, busyStallTimeoutMs: 5000, includeTodoContext: true, autoCompact: false, stallPatternDetection: false });
      const promise = module.recover("test");
      await vi.advanceTimersByTimeAsync(1000);
      await flushPromises();
      await promise;
      expect(s.continueMessageText).toContain("Fix login bug");
      expect(s.continueMessageText).toContain("Add tests");
    });

    it("uses shortContinueMessage when tokenLimitHits > 0", async () => {
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockResolvedValue({});
      const s = setupBusySession("test", { lastProgressAt: Date.now() - 10000, lastOutputAt: Date.now() - 10000, tokenLimitHits: 2 });
      s.autoSubmitCount = 0;
      module = createModule({ stallTimeoutMs: 5000, busyStallTimeoutMs: 5000, includeTodoContext: false, autoCompact: false, stallPatternDetection: false });
      const promise = module.recover("test");
      await vi.advanceTimersByTimeAsync(1000);
      await flushPromises();
      await promise;
      expect(s.continueMessageText).toBe("Continue.");
    });

    it("uses plan-aware message when session is planning", async () => {
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockResolvedValue({});
      const s = setupBusySession("test", {
        lastProgressAt: Date.now() - 10000,
        lastOutputAt: Date.now() - 10000,
        planning: true,
        planningStartedAt: Date.now() - 600000,
      });
      s.autoSubmitCount = 0;
      module = createModule({ stallTimeoutMs: 5000, busyStallTimeoutMs: 5000, planningTimeoutMs: 300000, includeTodoContext: false, autoCompact: false, stallPatternDetection: false });
      const promise = module.recover("test");
      await vi.advanceTimersByTimeAsync(1000);
      await flushPromises();
      await promise;
      expect(s.continueMessageText).toBe("Finish your plan.");
    });
  });

  describe("recovery error handling", () => {
    it("increments recoveryFailed and schedules retry on exception", async () => {
      mockStatus.mockRejectedValue(new Error("status check failed"));
      const s = setupBusySession("test", { attempts: 1 });
      module = createModule({ stallTimeoutMs: 5000 });
      await module.recover("test");
      expect(s.recoveryFailed).toBe(1);
      expect(mockScheduleRecovery).toHaveBeenCalled();
    });

    it("uses exponential backoff when maxRecoveries reached after failure", async () => {
      mockStatus.mockRejectedValue(new Error("status check failed"));
      const s = setupBusySession("test", { attempts: 3 });
      module = createModule({ stallTimeoutMs: 5000, maxRecoveries: 3 });
      await module.recover("test");
      expect(s.recoveryFailed).toBe(1);
      expect(s.backoffAttempts).toBe(1);
    });
  });

  describe("stall pattern tracking", () => {
    it("records stall pattern when stallPatternDetection is enabled", async () => {
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockResolvedValue({});
      const s = setupBusySession("test", { lastProgressAt: Date.now() - 10000, lastOutputAt: Date.now() - 10000, lastStallPartType: "text" });
      s.autoSubmitCount = 0;
      module = createModule({ stallTimeoutMs: 5000, busyStallTimeoutMs: 5000, stallPatternDetection: true, autoCompact: false });
      const promise = module.recover("test");
      await vi.advanceTimersByTimeAsync(1000);
      await flushPromises();
      await promise;
      expect(s.stallPatterns["text"]).toBe(1);
    });
  });

  describe("toast notifications", () => {
    it("shows auto-continue toast on recovery attempt", async () => {
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockResolvedValue({});
      const s = setupBusySession("test", { lastProgressAt: Date.now() - 10000, lastOutputAt: Date.now() - 10000 });
      s.autoSubmitCount = 0;
      module = createModule({ stallTimeoutMs: 5000, busyStallTimeoutMs: 5000, showToasts: true, autoCompact: false, stallPatternDetection: false });
      const promise = module.recover("test");
      await vi.advanceTimersByTimeAsync(1000);
      await flushPromises();
      await promise;
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({ title: "Auto-Continue" }),
      }));
    });
  });

  describe("auto-compaction during recovery", () => {
    it("calls summarize when autoCompact is enabled and session is idle", async () => {
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockResolvedValue({});
      mockSummarize.mockResolvedValue({});
      const s = setupBusySession("test", { lastProgressAt: Date.now() - 10000, lastOutputAt: Date.now() - 10000 });
      s.autoSubmitCount = 0;
      module = createModule({ stallTimeoutMs: 5000, busyStallTimeoutMs: 5000, autoCompact: true, stallPatternDetection: false });
      const promise = module.recover("test");
      await vi.advanceTimersByTimeAsync(4000);
      await flushPromises();
      await promise;
      expect(mockSummarize).toHaveBeenCalled();
    });
  });

  describe("prompt guard", () => {
    it("does not block when no recent prompts match", async () => {
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });
      mockAbort.mockResolvedValue({});
      mockMessages.mockResolvedValue({ data: [] });
      const s = setupBusySession("test", { lastProgressAt: Date.now() - 10000, lastOutputAt: Date.now() - 10000 });
      s.autoSubmitCount = 0;
      module = createModule({ stallTimeoutMs: 5000, busyStallTimeoutMs: 5000, includeTodoContext: false, autoCompact: false, stallPatternDetection: false });
      const promise = module.recover("test");
      await vi.advanceTimersByTimeAsync(1000);
      await flushPromises();
      await promise;
      expect(s.needsContinue).toBe(true);
    });
  });
});
