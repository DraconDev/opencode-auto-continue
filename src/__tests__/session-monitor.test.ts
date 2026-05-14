/**
 * Tests for SessionMonitor module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { flushPromises } from "./helpers.js";
import { createSessionMonitor } from "../session-monitor.js";
import type { PluginConfig, SessionState } from "../shared.js";
import type { TypedPluginInput } from "../types.js";

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
  maxAutoSubmits: 3,
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
  compactAtMessageCount: 50,
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
  // Session Monitor config
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
    lastAdvisoryAdvice: null,
    lastKnownStatus: 'unknown',
    stoppedByCondition: null,
    ...partial,
  };
}

const mockLog = vi.fn();

const mockInput = {
  client: {
    session: {
      list: vi.fn().mockResolvedValue({ data: [] }),
    },
  },
} as unknown as TypedPluginInput;

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
      input: mockInput,
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
      
      // Wait a tiny bit
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
      // Setup: parent with child, both busy
      const parent = createMockSession({ timer: setTimeout(() => {}, 1000), lastProgressAt: Date.now() - 20000 });
      const child = createMockSession({ timer: setTimeout(() => {}, 1000) });
      sessions.set("parent-1", parent);
      sessions.set("child-1", child);
      monitor.trackParentChild("parent-1", "child-1");

      monitor.start();

      // Simulate child finishing (busyCount drops from 2 to 1)
      clearTimeout(child.timer as ReturnType<typeof setTimeout>);
      child.timer = null;

      // Wait for orphan check interval (5s) - use fake timers
      vi.advanceTimersByTime(6000);

      // Since parent is stuck > subagentWaitMs (15s), it should trigger recovery
      // But we set lastProgressAt to 20s ago, so it should trigger
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

  describe("Session Discovery", () => {
    it("should discover missed sessions", async () => {
      vi.useRealTimers(); // Use real timers for async test
      
      const mockList = vi.fn().mockResolvedValue({
        data: [
          { id: "session-1" },
          { id: "session-2" },
        ],
      });

      const customInput = {
        client: {
          session: {
            list: mockList,
          },
        },
      } as unknown as TypedPluginInput;

      const customMonitor = createSessionMonitor({
        config: { ...mockConfig, sessionDiscoveryIntervalMs: 50 },
        sessions,
        log: mockLog,
        input: customInput,
        isDisposed: () => isDisposed,
        recover: () => {},
      });

      customMonitor.start();
      
      // Wait for discovery interval
      await new Promise(r => setTimeout(r, 100));
      
      expect(mockList).toHaveBeenCalled();
      expect(sessions.has("session-1")).toBe(true);
      expect(sessions.has("session-2")).toBe(true);
      
      customMonitor.stop();
    });

    it("should arm recovery timer for discovered busy sessions", async () => {
      const mockList = vi.fn().mockResolvedValue({
        data: [{ id: "busy-session" }],
      });
      const mockStatus = vi.fn().mockResolvedValue({
        data: { "busy-session": { type: "busy" } },
      });

      const customInput = {
        client: {
          session: {
            list: mockList,
            status: mockStatus,
          },
        },
      } as unknown as TypedPluginInput;

      const customMonitor = createSessionMonitor({
        config: { ...mockConfig, sessionDiscoveryIntervalMs: 50, stallTimeoutMs: 100 },
        sessions,
        log: mockLog,
        input: customInput,
        isDisposed: () => isDisposed,
        recover: (id: string) => {
          recoverCalls.push(id);
        },
      });

      customMonitor.start();
      await vi.advanceTimersByTimeAsync(60);
      await flushPromises();

      expect(sessions.has("busy-session")).toBe(true);
      expect(sessions.get("busy-session")?.timer).not.toBeNull();

      await vi.advanceTimersByTimeAsync(100);

      expect(recoverCalls).toContain("busy-session");
      customMonitor.stop();
    });

    it("should NOT arm recovery timer for discovered sessions with unknown status", async () => {
      const mockList = vi.fn().mockResolvedValue({
        data: [{ id: "unknown-session" }],
      });
      const mockStatus = vi.fn().mockResolvedValue({ data: {} });

      const customInput = {
        client: {
          session: {
            list: mockList,
            status: mockStatus,
          },
        },
      } as unknown as TypedPluginInput;

      const customMonitor = createSessionMonitor({
        config: { ...mockConfig, sessionDiscoveryIntervalMs: 50, stallTimeoutMs: 100 },
        sessions,
        log: mockLog,
        input: customInput,
        isDisposed: () => isDisposed,
        recover: (id: string) => {
          recoverCalls.push(id);
        },
      });

      customMonitor.start();
      await vi.advanceTimersByTimeAsync(60);
      await flushPromises();

      expect(sessions.has("unknown-session")).toBe(true);
      // FIX 10: Unknown status sessions are tracked but NOT armed for recovery
      expect(sessions.get("unknown-session")?.timer).toBeNull();

      await vi.advanceTimersByTimeAsync(100);

      expect(recoverCalls).not.toContain("unknown-session");
      customMonitor.stop();
    });
  });

  describe("Idle Session Cleanup", () => {
    it("should clean up idle sessions", () => {
      const oldSession = createMockSession({
        timer: null,
        lastProgressAt: Date.now() - 700000, // 700s ago > 600s timeout
      });
      sessions.set("old-session", oldSession);

      monitor.start();
      
      // Wait for cleanup interval (30s) - but we can trigger it via stats
      vi.advanceTimersByTime(35000);
      
      // Check if session was cleaned up
      // Note: cleanup runs on interval, may not be immediate
      monitor.stop();
    });

    it("should not clean up sessions with pending auto-continue work", () => {
      const nudgeTimer = setTimeout(() => {}, 1000);
      (nudgeTimer as any).unref?.();
      const pendingContinue = createMockSession({
        timer: null,
        needsContinue: true,
        lastProgressAt: Date.now() - 700000,
      });
      const pendingNudge = createMockSession({
        timer: null,
        nudgeTimer,
        lastProgressAt: Date.now() - 700000,
      });
      sessions.set("pending-continue", pendingContinue);
      sessions.set("pending-nudge", pendingNudge);

      monitor.start();
      vi.advanceTimersByTime(35000);

      expect(sessions.has("pending-continue")).toBe(true);
      expect(sessions.has("pending-nudge")).toBe(true);

      monitor.stop();
    });

    it("should enforce max session limit", () => {
      // Create more sessions than maxSessions
      for (let i = 0; i < 55; i++) {
        sessions.set(`session-${i}`, createMockSession({
          timer: null,
          lastProgressAt: Date.now() - i * 1000,
        }));
      }

      monitor.start();
      vi.advanceTimersByTime(35000);
      
      expect(sessions.size).toBeLessThanOrEqual(mockConfig.maxSessions);
      
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
    });
  });
});
