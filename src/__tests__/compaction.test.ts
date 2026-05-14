import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { flushPromises } from './helpers.js';
import { createCompactionModule } from '../compaction.js';
import type { PluginConfig } from '../config.js';
import type { SessionState } from '../session-state.js';

const DEFAULT_CONFIG: PluginConfig = {
  stallTimeoutMs: 45000,
  waitAfterAbortMs: 5000,
  maxRecoveries: 3,
  cooldownMs: 60000,
  abortPollIntervalMs: 200,
  abortPollMaxTimeMs: 5000,
  abortPollMaxFailures: 3,
  debug: false,
  maxBackoffMs: 1800000,
  maxAutoSubmits: 3,
  shortContinueMessage: "Continue.",
  continueWithPlanMessage: "Finish your plan.",
  continueMessage: "Continue.",
  continueWithTodosMessage: "Continue with todos.",
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
  autoCompact: true,
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
  opportunisticCompactAtTokens: 50000,
  opportunisticCompactAfterRecovery: true,
  opportunisticCompactOnIdle: true,
  opportunisticCompactBeforeNudge: true,
  opportunisticCompactAfterReview: true,
  nudgeCompactThreshold: 80000,
  hardCompactAtTokens: 100000,
  hardCompactMaxWaitMs: 30000,
  hardCompactBypassCooldown: true,
  compactionSafetyTimeoutMs: 15000,
  stopFilePath: "",
  maxRuntimeMs: 0,
  untilMarker: "",
  planningTimeoutMs: 300000,
  busyStallTimeoutMs: 180000,
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
    actionStartedAt: 0,
    lastStallPartType: "",
    lastOutputAt: Date.now(),
    lastOutputLength: 0,
    lastProgressAt: Date.now(),
    needsContinue: false,
    continueMessageText: "",
    attempts: 0,
    backoffAttempts: 0,
    reviewFired: false,
    reviewDebounceTimer: null,
    planBuffer: "",
    autoSubmitCount: 0,
    messageCount: 0,
    lastKnownStatus: "idle",
    lastKnownTodos: [],
    stoppedByCondition: null,
    hardCompactionInProgress: false,
    lastHardCompactionAt: 0,
    compactionSafetyTimer: null,
    ...overrides,
  };
}

describe("compaction module unit tests", () => {
  let sessions: Map<string, SessionState>;
  let log: ReturnType<typeof vi.fn>;
  let mockSummarize: ReturnType<typeof vi.fn>;
  let mockStatus: ReturnType<typeof vi.fn>;
  let module: ReturnType<typeof createCompactionModule>;

  beforeEach(() => {
    vi.useFakeTimers();
    sessions = new Map();
    log = vi.fn();
    mockSummarize = vi.fn();
    mockStatus = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createModule(config?: Partial<PluginConfig>) {
    return createCompactionModule({
      config: { ...DEFAULT_CONFIG, ...config },
      sessions,
      log,
      input: {
        directory: "/tmp",
        client: {
          session: {
            summarize: mockSummarize,
            status: mockStatus,
          },
          tui: { showToast: vi.fn() },
        },
      } as any,
    });
  }

  describe("isTokenLimitError", () => {
    it("returns false for null/undefined", () => {
      module = createModule();
      expect(module.isTokenLimitError(null)).toBe(false);
      expect(module.isTokenLimitError(undefined)).toBe(false);
    });

    it("returns false for non-token errors", () => {
      module = createModule();
      expect(module.isTokenLimitError({ name: "MessageAbortedError", message: "aborted" })).toBe(false);
      expect(module.isTokenLimitError({ name: "Error", message: "network timeout" })).toBe(false);
    });

    it("returns true when error message contains token limit patterns", () => {
      module = createModule();
      expect(module.isTokenLimitError({ name: "Error", message: "maximum context length exceeded" })).toBe(true);
      expect(module.isTokenLimitError({ name: "Error", message: "token count exceeds 200000" })).toBe(true);
      expect(module.isTokenLimitError({ name: "Error", message: "payload too large" })).toBe(true);
      expect(module.isTokenLimitError({ name: "Error", message: "token limit exceeded" })).toBe(true);
    });

    it("is case-insensitive", () => {
      module = createModule();
      expect(module.isTokenLimitError({ message: "MAXIMUM CONTEXT LENGTH" })).toBe(true);
      expect(module.isTokenLimitError({ message: "Token Limit Exceeded" })).toBe(true);
    });

    it("matches via String(error) when error has no message", () => {
      module = createModule();
      const err = new Error("too many tokens");
      expect(module.isTokenLimitError(err)).toBe(true);
    });

    it("uses custom tokenLimitPatterns from config", () => {
      module = createModule({ tokenLimitPatterns: ["custom error"] });
      expect(module.isTokenLimitError({ message: "this is a custom error" })).toBe(true);
      expect(module.isTokenLimitError({ message: "context length exceeded" })).toBe(false);
    });
  });

  describe("forceCompact", () => {
    it("returns false if session does not exist", async () => {
      module = createModule();
      const result = await module.forceCompact("nonexistent");
      expect(result).toBe(false);
    });

    it("calls summarize and returns true on success", async () => {
      mockSummarize.mockResolvedValue({ data: {} });
      mockStatus.mockResolvedValue({ data: { test: { type: "idle" } } });

      const s = createSessionState({ estimatedTokens: 50000 });
      sessions.set("test", s);
      module = createModule();

      const promise = module.forceCompact("test");
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();

      expect(mockSummarize).toHaveBeenCalledWith({
        path: { id: "test" },
        query: { directory: "/tmp" },
      });
      const result = await promise;
      expect(result).toBe(true);
    });

    it("retries on failure up to compactMaxRetries", async () => {
      mockSummarize.mockRejectedValue(new Error("summarize failed"));
      mockStatus.mockResolvedValue({ data: { test: { type: "idle" } } });

      const s = createSessionState({ estimatedTokens: 50000 });
      sessions.set("test", s);
      module = createModule({ compactMaxRetries: 3, compactRetryDelayMs: 100 });

      const promise = module.forceCompact("test");
      // Need to advance past each retry delay
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(100);
        await flushPromises();
      }

      expect(mockSummarize).toHaveBeenCalledTimes(3);
      const result = await promise;
      expect(result).toBe(false);
    });

    it("clears tokenLimitHits on success", async () => {
      mockSummarize.mockResolvedValue({ data: {} });
      mockStatus.mockResolvedValue({ data: { test: { type: "idle" } } });

      const s = createSessionState({ estimatedTokens: 50000, tokenLimitHits: 3 });
      sessions.set("test", s);
      module = createModule();

      const promise = module.forceCompact("test");
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();

      await promise;
      expect(s.tokenLimitHits).toBe(0);
    });
  });

  describe("attemptCompact", () => {
    it("returns false if summarize throws", async () => {
      mockSummarize.mockRejectedValue(new Error("fail"));
      const s = createSessionState();
      sessions.set("test", s);
      module = createModule();

      const promise = module.attemptCompact("test");
      // Retry delay timers
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();

      const result = await promise;
      expect(result).toBe(false);
    });

    it("waits for session to become idle after summarize", async () => {
      // Session stays busy for first poll, then idle
      mockSummarize.mockResolvedValue({ data: {} });
      mockStatus
        .mockResolvedValueOnce({ data: { test: { type: "busy" } } })
        .mockResolvedValueOnce({ data: { test: { type: "idle" } } });

      sessions.set("test", createSessionState({ estimatedTokens: 100000 }));
      module = createModule({ compactionVerifyWaitMs: 10000 });

      const promise = module.attemptCompact("test");
      // First poll at 2000ms → busy
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();
      // Second poll at 3000ms → idle
      await vi.advanceTimersByTimeAsync(3000);
      await flushPromises();

      const result = await promise;
      expect(result).toBe(true);
      expect(mockStatus).toHaveBeenCalledTimes(2);
    });

    it("returns false if session stays busy past all wait intervals", async () => {
      mockSummarize.mockResolvedValue({ data: {} });
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });

      sessions.set("test", createSessionState({ estimatedTokens: 100000 }));
      module = createModule({ compactionVerifyWaitMs: 10000 });

      const promise = module.attemptCompact("test");
      // Advance through all wait intervals: 2000 + 3000 + 5000 = 10000ms
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();
      await vi.advanceTimersByTimeAsync(3000);
      await flushPromises();
      await vi.advanceTimersByTimeAsync(5000);
      await flushPromises();

      const result = await promise;
      expect(result).toBe(false);
    });
  });

  describe("maybeProactiveCompact", () => {
    it("returns false if autoCompact is disabled", async () => {
      sessions.set("test", createSessionState({ estimatedTokens: 200000 }));
      module = createModule({ autoCompact: false });
      const result = await module.maybeProactiveCompact("test");
      expect(result).toBe(false);
    });

    it("returns false if session does not exist", async () => {
      module = createModule();
      const result = await module.maybeProactiveCompact("nonexistent");
      expect(result).toBe(false);
    });

    it("returns false if session is already compacting", async () => {
      sessions.set("test", createSessionState({ estimatedTokens: 200000, compacting: true }));
      module = createModule();
      const result = await module.maybeProactiveCompact("test");
      expect(result).toBe(false);
    });

    it("returns false if session is planning", async () => {
      sessions.set("test", createSessionState({ estimatedTokens: 200000, planning: true }));
      module = createModule();
      const result = await module.maybeProactiveCompact("test");
      expect(result).toBe(false);
    });

    it("returns false if cooldown has not elapsed", async () => {
      const s = createSessionState({ estimatedTokens: 200000, lastCompactionAt: Date.now() - 10000 });
      sessions.set("test", s);
      module = createModule({ compactCooldownMs: 60000 });
      const result = await module.maybeProactiveCompact("test");
      expect(result).toBe(false);
    });

    it("returns false if tokens are below threshold", async () => {
      sessions.set("test", createSessionState({ estimatedTokens: 1000 }));
      module = createModule({ proactiveCompactAtTokens: 100000 });
      const result = await module.maybeProactiveCompact("test");
      expect(result).toBe(false);
    });

    it("calls forceCompact when tokens exceed threshold", async () => {
      mockSummarize.mockResolvedValue({ data: {} });
      mockStatus.mockResolvedValue({ data: { test: { type: "idle" } } });

      sessions.set("test", createSessionState({ estimatedTokens: 200000 }));
      module = createModule({ proactiveCompactAtTokens: 100000 });

      const promise = module.maybeProactiveCompact("test");
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();

      const result = await promise;
      expect(result).toBe(true);
      expect(mockSummarize).toHaveBeenCalled();
    });
  });

  describe("maybeOpportunisticCompact", () => {
    it("returns false if session does not exist", async () => {
      module = createModule();
      const result = await module.maybeOpportunisticCompact("nonexistent", "test");
      expect(result).toBe(false);
    });

    it("returns false if session is already compacting", async () => {
      sessions.set("test", createSessionState({ estimatedTokens: 60000, compacting: true }));
      module = createModule();
      const result = await module.maybeOpportunisticCompact("test", "post-recovery");
      expect(result).toBe(false);
    });

    it("returns false if session is planning", async () => {
      sessions.set("test", createSessionState({ estimatedTokens: 60000, planning: true }));
      module = createModule();
      const result = await module.maybeOpportunisticCompact("test", "post-recovery");
      expect(result).toBe(false);
    });

    it("returns false if session is stopped by condition", async () => {
      sessions.set("test", createSessionState({ estimatedTokens: 60000, stoppedByCondition: "maxRuntime" }));
      module = createModule();
      const result = await module.maybeOpportunisticCompact("test", "post-recovery");
      expect(result).toBe(false);
    });

    it("returns false if cooldown has not elapsed", async () => {
      sessions.set("test", createSessionState({ estimatedTokens: 60000, lastCompactionAt: Date.now() - 10000 }));
      module = createModule({ compactCooldownMs: 60000 });
      const result = await module.maybeOpportunisticCompact("test", "post-recovery");
      expect(result).toBe(false);
    });

    it("returns false if tokens are below threshold", async () => {
      sessions.set("test", createSessionState({ estimatedTokens: 10000 }));
      module = createModule({ opportunisticCompactAtTokens: 50000 });
      const result = await module.maybeOpportunisticCompact("test", "post-recovery");
      expect(result).toBe(false);
    });

    it("calls forceCompact when tokens exceed threshold", async () => {
      mockSummarize.mockResolvedValue({ data: {} });
      mockStatus.mockResolvedValue({ data: { test: { type: "idle" } } });

      sessions.set("test", createSessionState({ estimatedTokens: 60000 }));
      module = createModule({ opportunisticCompactAtTokens: 50000 });

      const promise = module.maybeOpportunisticCompact("test", "post-recovery");
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();

      const result = await promise;
      expect(result).toBe(true);
      expect(mockSummarize).toHaveBeenCalled();
    });

    it("logs reason string when triggered", async () => {
      mockSummarize.mockResolvedValue({ data: {} });
      mockStatus.mockResolvedValue({ data: { test: { type: "idle" } } });

      sessions.set("test", createSessionState({ estimatedTokens: 60000 }));
      module = createModule({ opportunisticCompactAtTokens: 50000 });

      const promise = module.maybeOpportunisticCompact("test", "on-idle");
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();
      await promise;

      const allLogs = log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(allLogs).toContain("OPPORTUNISTIC TRIGGER");
      expect(allLogs).toContain("on-idle");
    });
  });

  describe("maybeHardCompact", () => {
    it("returns false if session does not exist", async () => {
      module = createModule();
      const result = await module.maybeHardCompact("nonexistent");
      expect(result).toBe(false);
    });

    it("returns false if hardCompactionAtTokens is 0 (disabled)", async () => {
      sessions.set("test", createSessionState({ estimatedTokens: 200000 }));
      module = createModule({ hardCompactAtTokens: 0 });
      const result = await module.maybeHardCompact("test");
      expect(result).toBe(false);
    });

    it("returns false if tokens are below hard threshold", async () => {
      sessions.set("test", createSessionState({ estimatedTokens: 50000 }));
      module = createModule({ hardCompactAtTokens: 100000 });
      const result = await module.maybeHardCompact("test");
      expect(result).toBe(false);
    });

    it("returns false if session is already compacting", async () => {
      sessions.set("test", createSessionState({ estimatedTokens: 200000, compacting: true }));
      module = createModule();
      const result = await module.maybeHardCompact("test");
      expect(result).toBe(false);
    });

    it("returns false if session is planning", async () => {
      sessions.set("test", createSessionState({ estimatedTokens: 200000, planning: true }));
      module = createModule();
      const result = await module.maybeHardCompact("test");
      expect(result).toBe(false);
    });

    it("returns false if session is stopped by condition", async () => {
      sessions.set("test", createSessionState({ estimatedTokens: 200000, stoppedByCondition: "maxRuntime" }));
      module = createModule();
      const result = await module.maybeHardCompact("test");
      expect(result).toBe(false);
    });

    it("returns false if hard compaction already in progress", async () => {
      sessions.set("test", createSessionState({ estimatedTokens: 200000, hardCompactionInProgress: true }));
      module = createModule();
      const result = await module.maybeHardCompact("test");
      expect(result).toBe(false);
    });

    it("fires regardless of autoCompact flag", async () => {
      mockSummarize.mockResolvedValue({ data: {} });
      mockStatus.mockResolvedValue({ data: { test: { type: "idle" } } });

      sessions.set("test", createSessionState({ estimatedTokens: 200000 }));
      module = createModule({ autoCompact: false, hardCompactAtTokens: 100000 });

      const promise = module.maybeHardCompact("test");
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();

      const result = await promise;
      expect(result).toBe(true);
      expect(mockSummarize).toHaveBeenCalled();
    });

    it("bypasses cooldown when hardCompactBypassCooldown is true", async () => {
      mockSummarize.mockResolvedValue({ data: {} });
      mockStatus.mockResolvedValue({ data: { test: { type: "idle" } } });

      sessions.set("test", createSessionState({ estimatedTokens: 200000, lastCompactionAt: Date.now() - 10000 }));
      module = createModule({ hardCompactAtTokens: 100000, compactCooldownMs: 60000, hardCompactBypassCooldown: true });

      const promise = module.maybeHardCompact("test");
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();

      const result = await promise;
      expect(result).toBe(true);
      expect(mockSummarize).toHaveBeenCalled();
    });

    it("respects cooldown when hardCompactBypassCooldown is false", async () => {
      sessions.set("test", createSessionState({ estimatedTokens: 200000, lastCompactionAt: Date.now() - 10000 }));
      module = createModule({ hardCompactAtTokens: 100000, compactCooldownMs: 60000, hardCompactBypassCooldown: false });

      const result = await module.maybeHardCompact("test");
      expect(result).toBe(false);
      expect(mockSummarize).not.toHaveBeenCalled();
    });

    it("returns true when compaction succeeds and tokens drop below threshold", async () => {
      mockSummarize.mockResolvedValue({ data: {} });
      mockStatus.mockResolvedValue({ data: { test: { type: "idle" } } });

      sessions.set("test", createSessionState({ estimatedTokens: 200000 }));
      module = createModule({ hardCompactAtTokens: 100000 });

      const promise = module.maybeHardCompact("test");
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();

      const result = await promise;
      expect(result).toBe(true);
      expect(sessions.get("test")!.hardCompactionInProgress).toBe(false);
      expect(sessions.get("test")!.lastHardCompactionAt).toBeGreaterThan(0);
    });

    it("returns false but clears flag on compaction failure", async () => {
      mockSummarize.mockRejectedValue(new Error("fail"));
      sessions.set("test", createSessionState({ estimatedTokens: 200000 }));
      module = createModule({ hardCompactAtTokens: 100000, compactMaxRetries: 1, compactRetryDelayMs: 100 });

      const promise = module.maybeHardCompact("test");
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();

      const result = await promise;
      expect(result).toBe(false);
      expect(sessions.get("test")!.hardCompactionInProgress).toBe(false);
    });

    it("times out if compaction exceeds hardCompactMaxWaitMs", async () => {
      mockSummarize.mockResolvedValue({ data: {} });
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });

      sessions.set("test", createSessionState({ estimatedTokens: 200000 }));
      module = createModule({ hardCompactAtTokens: 100000, hardCompactMaxWaitMs: 5000, compactionVerifyWaitMs: 1000, compactRetryDelayMs: 100 });

      const promise = module.maybeHardCompact("test");
      // Advance enough to get through one attempt (1000ms verify wait) + one retry (100ms)
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();
      // Let the timeout check happen
      await vi.advanceTimersByTimeAsync(5000);
      await flushPromises();

      const result = await promise;
      expect(result).toBe(false);
      expect(sessions.get("test")!.hardCompactionInProgress).toBe(false);
    });

    it("logs reason string when triggered", async () => {
      mockSummarize.mockResolvedValue({ data: {} });
      mockStatus.mockResolvedValue({ data: { test: { type: "idle" } } });

      sessions.set("test", createSessionState({ estimatedTokens: 200000 }));
      module = createModule({ hardCompactAtTokens: 100000 });

      const promise = module.maybeHardCompact("test");
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();
      await promise;

      const allLogs = log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(allLogs).toContain("HARD TRIGGER");
    });
  });

    it("logs reason string when triggered", async () => {
      mockSummarize.mockResolvedValue({ data: {} });
      mockStatus.mockResolvedValue({ data: { test: { type: "idle" } } });

      sessions.set("test", createSessionState({ estimatedTokens: 200000 }));
      module = createModule({ hardCompactAtTokens: 100000 });

      const promise = module.maybeHardCompact("test");
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();
      await promise;

      const allLogs = log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(allLogs).toContain("HARD TRIGGER");
    });
  });

  describe("edge cases", () => {
    it("handles error object with no message property", () => {
      module = createModule();
      expect(module.isTokenLimitError({ name: "Error" })).toBe(false);
      expect(module.isTokenLimitError({ name: "Error", message: "" })).toBe(false);
    });

    it("safety timeout clears stuck compacting flag", async () => {
      mockSummarize.mockResolvedValue({ data: {} });
      mockStatus.mockResolvedValue({ data: { test: { type: "busy" } } });

      sessions.set("test", createSessionState({ estimatedTokens: 100000 }));
      module = createModule({ compactionSafetyTimeoutMs: 2000, compactionVerifyWaitMs: 1000 });

      const promise = module.forceCompact("test");
      // After 1000ms verify wait + 2000ms safety timeout = 3000ms
      await vi.advanceTimersByTimeAsync(3000);
      await flushPromises();

      const s = sessions.get("test")!;
      expect(s.compacting).toBe(false);

      // Finish the promise
      await vi.advanceTimersByTimeAsync(1000);
      await flushPromises();
      await promise;
    });

    it("does not compact if forceCompact called with no session", async () => {
      module = createModule();
      const result = await module.forceCompact("missing");
      expect(result).toBe(false);
      expect(mockSummarize).not.toHaveBeenCalled();
    });

    it("sets compacting=true during compaction attempt, resets on failure", async () => {
      mockSummarize.mockRejectedValue(new Error("fail"));

      const s = createSessionState();
      sessions.set("test", s);
      module = createModule({ compactMaxRetries: 1 });

      const promise = module.forceCompact("test");
      // Session has compacting set to true before attempt
      expect(s.compacting).toBe(true);

      await vi.advanceTimersByTimeAsync(100);
      await flushPromises();

      await promise;
      expect(s.compacting).toBe(false);
    });

    it("estimates reduced tokens after successful compaction", async () => {
      mockSummarize.mockResolvedValue({ data: {} });
      mockStatus.mockResolvedValue({ data: { test: { type: "idle" } } });

      const s = createSessionState({ estimatedTokens: 100000 });
      sessions.set("test", s);
      module = createModule({ compactReductionFactor: 0.5 });

      const promise = module.forceCompact("test");
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();

      await promise;
      // With reductionFactor 0.5: 100000 - floor(100000 * 0.5) = 50000
      // or max(50000, floor(100000 * 0.5)) = max(50000, 50000) = 50000
      expect(s.estimatedTokens).toBe(50000);
    });
  });
});
