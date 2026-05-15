import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSessionMonitor } from "../session-monitor.js";
import type { PluginConfig, SessionState } from "../shared.js";

const mockConfig: PluginConfig = {
  stallTimeoutMs: 180000,
  waitAfterAbortMs: 5000,
  maxRecoveries: 3,
  cooldownMs: 60000,
  abortPollIntervalMs: 200,
  abortPollMaxTimeMs: 5000,
  abortPollMaxFailures: 3,
  debug: false,
  maxBackoffMs: 1800000,
  shortContinueMessage: "Continue.",
  continueWithPlanMessage: "Continue with plan.",
  continueMessage: "Please continue.",
  continueWithTodosMessage: "Continue with {pending} tasks.",
  maxAttemptsMessage: "Max attempts.",
  includeTodoContext: true,
  reviewOnComplete: true,
  reviewMessage: "Review.",
  reviewDebounceMs: 500,
  showToasts: true,
  nudgeEnabled: true,
  nudgeIdleDelayMs: 500,
  nudgeMaxSubmits: 3,
  nudgeMessage: "Nudge.",
  nudgeCooldownMs: 60000,
  tokenLimitPatterns: ["context length"],
  terminalTitleEnabled: true,
  statusFileEnabled: true,
  autoCompact: true,
  maxSessionAgeMs: 7200000,
  proactiveCompactAtTokens: 100000,
  proactiveCompactAtPercent: 50,
  compactRetryDelayMs: 3000,
  compactMaxRetries: 3,
  statusFilePath: "",
  maxStatusHistory: 10,
  statusFileRotate: 5,
  recoveryHistogramEnabled: true,
  stallPatternDetection: true,
  terminalProgressEnabled: true,
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
  enableAdvisory: false,
  advisoryModel: "",
  advisoryTimeoutMs: 5000,
  advisoryMaxTokens: 500,
  advisoryTemperature: 0.1,
  subagentWaitMs: 15000,
  sessionDiscoveryIntervalMs: 60000,
  idleSessionTimeoutMs: 600000,
  maxSessions: 50,
  orphanParentDetection: true,
  sessionDiscovery: true,
  idleCleanup: true,
};

function createMockSession(partial: Partial<SessionState> = {}): SessionState {
  return {
    attempts: 0,
    backoffAttempts: 0,
    autoSubmitCount: 0,
    lastProgressAt: Date.now(),
    lastUserMessageId: "",
    sentMessageAt: 0,
    timer: null,
    needsContinue: false,
    continueMessageText: "",
    nudgeCount: 0,
    lastNudgeAt: 0,
    hasOpenTodos: false,
    lastKnownTodos: [],
    estimatedTokens: 0,
    messageCount: 0,
    lastCompactionAt: 0,
    tokenLimitHits: 0,
    planning: false,
    planBuffer: "",
    compacting: false,
    userCancelled: false,
    aborting: false,
    sessionCreatedAt: Date.now(),
    actionStartedAt: 0,
    lastRecoveryTime: 0,
    recoveryStartTime: 0,
    stallDetections: 0,
    recoverySuccessful: 0,
    recoveryFailed: 0,
    lastRecoverySuccess: 0,
    totalRecoveryTimeMs: 0,
    recoveryTimes: [],
    statusHistory: [],
    nudgePaused: false,
    lastTodoSnapshot: "",
    todoChangeCount: 0,
    lastStallPartType: "",
    stallPatterns: {},
    continueHistory: [],
    reviewFired: false,
    reviewDebounceTimer: null,
    lastReviewAt: 0,
    reviewCount: 0,
    lastKnownStatus: 'unknown',
    lastRealTokenRefreshAt: 0,
    stoppedByCondition: null,
    ...partial,
  };
}

const mockLog = vi.fn();

describe("SessionMonitor", () => {
  let monitor: ReturnType<typeof createSessionMonitor>;
  let sessions: Map<string, SessionState>;
  let recoverCalls: string[];
  let isDisposed: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    sessions = new Map();
    recoverCalls = [];
    isDisposed = false;
    mockLog.mockClear();

    monitor = createSessionMonitor({
      config: mockConfig,
      sessions,
      log: mockLog,
      isDisposed: () => isDisposed,
      recover: (id: string) => {
        recoverCalls.push(id);
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Basic Operations", () => {
    it("should start and stop without errors", () => {
      monitor.start();
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("started"));
      monitor.stop();
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("stopped"));
    });

    it("should track session touch", () => {
      const session = createMockSession();
      sessions.set("session-1", session);
      const oldTime = session.lastProgressAt;

      monitor.touchSession("session-1");

      expect(session.lastProgressAt).toBeGreaterThanOrEqual(oldTime);
    });

    it("should track parent-child relationships", () => {
      monitor.trackParentChild("parent-1", "child-1");
      expect(mockLog).toHaveBeenCalledWith(
        expect.stringContaining("tracked parent-child"),
        "parent-1",
        "→",
        "child-1"
      );
    });
  });

  describe("Orphan Parent Detection", () => {
    it("should detect orphan parent when busyCount drops", () => {
      const parent = createMockSession({ timer: setTimeout(() => {}, 1000), lastProgressAt: Date.now() - 20000 });
      const child = createMockSession({ timer: setTimeout(() => {}, 1000) });
      sessions.set("parent-1", parent);
      sessions.set("child-1", child);
      monitor.trackParentChild("parent-1", "child-1");

      monitor.start();

      clearTimeout(child.timer as ReturnType<typeof setTimeout>);
      child.timer = null;

      vi.advanceTimersByTime(6000);

      monitor.stop();
    });

    it("should not detect orphan if parent is not stuck long enough", () => {
      const parent = createMockSession({ timer: setTimeout(() => {}, 1000), lastProgressAt: Date.now() });
      const child = createMockSession({ timer: setTimeout(() => {}, 1000) });
      sessions.set("parent-1", parent);
      sessions.set("child-1", child);
      monitor.trackParentChild("parent-1", "child-1");

      monitor.start();
      clearTimeout(child.timer as ReturnType<typeof setTimeout>);
      child.timer = null;

      vi.advanceTimersByTime(6000);

      expect(recoverCalls).not.toContain("parent-1");
      monitor.stop();
    });
  });

  describe("Stats", () => {
    it("should report correct stats", () => {
      sessions.set("busy-1", createMockSession({ timer: setTimeout(() => {}, 1000), lastKnownStatus: 'busy' as const }));
      sessions.set("busy-2", createMockSession({ timer: setTimeout(() => {}, 1000), lastKnownStatus: 'busy' as const }));
      sessions.set("idle-1", createMockSession({ timer: null, lastKnownStatus: 'idle' as const }));

      const stats = monitor.getStats();

      expect(stats.totalSessions).toBe(3);
      expect(stats.busySessions).toBe(2);
      expect(stats.idleSessions).toBe(1);
      expect(stats.orphanRecoveries).toBe(0);
      expect(stats).not.toHaveProperty("discoveredSessions");
      expect(stats).not.toHaveProperty("cleanedUpSessions");
    });
  });
});
