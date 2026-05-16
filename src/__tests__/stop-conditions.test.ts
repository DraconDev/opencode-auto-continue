import { vi, describe, it, expect, beforeEach } from 'vitest';
import { createStopConditionsModule } from '../stop-conditions.js';
import type { PluginConfig } from '../config.js';
import type { SessionState } from '../session-state.js';
import { createSession } from '../session-state.js';

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
  shortContinueMessage: "Continue.",
  continueWithPlanMessage: "Finish plan.",
  continueMessage: "Continue.",
  continueWithTodosMessage: "Continue with todos.",
  maxAttemptsMessage: "Max.",
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
};

describe("stop conditions module", () => {
  let sessions: Map<string, SessionState>;
  let log: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessions = new Map();
    log = vi.fn();
  });

  function createModule(config?: Partial<PluginConfig>) {
    return createStopConditionsModule({
      config: { ...DEFAULT_CONFIG, ...config },
      sessions,
      log,
    });
  }

  describe("checkStopConditions", () => {
    it("returns shouldStop=false when no conditions configured", () => {
      const s = createSession();
      sessions.set("test", s);
      const module = createModule();
      const result = module.checkStopConditions("test");
      expect(result.shouldStop).toBe(false);
    });

    it("returns shouldStop=false when session does not exist", () => {
      const module = createModule({ maxRuntimeMs: 5000 });
      const result = module.checkStopConditions("nonexistent");
      expect(result.shouldStop).toBe(false);
    });

    it("returns shouldStop=true when session already stopped", () => {
      const s = createSession();
      s.stoppedByCondition = "previous stop";
      sessions.set("test", s);
      const module = createModule();
      const result = module.checkStopConditions("test");
      expect(result.shouldStop).toBe(true);
      expect(result.reason).toBe("previous stop");
    });

    it("stops on maxRuntimeMs exceeded", () => {
      const s = createSession();
      s.sessionCreatedAt = Date.now() - 10000;
      sessions.set("test", s);
      const module = createModule({ maxRuntimeMs: 5000 });
      const result = module.checkStopConditions("test");
      expect(result.shouldStop).toBe(true);
      expect(result.reason).toContain("maxRuntimeMs");
      expect(s.stoppedByCondition).toBe(result.reason);
    });

    it("does not stop when maxRuntimeMs not exceeded", () => {
      const s = createSession();
      s.sessionCreatedAt = Date.now() - 1000;
      sessions.set("test", s);
      const module = createModule({ maxRuntimeMs: 5000 });
      const result = module.checkStopConditions("test");
      expect(result.shouldStop).toBe(false);
    });

    it("does not stop when maxRuntimeMs is 0 (disabled)", () => {
      const s = createSession();
      s.sessionCreatedAt = Date.now() - 100000;
      sessions.set("test", s);
      const module = createModule({ maxRuntimeMs: 0 });
      const result = module.checkStopConditions("test");
      expect(result.shouldStop).toBe(false);
    });

    it("stops when stopFilePath file exists", () => {
      const s = createSession();
      sessions.set("test", s);
      const module = createModule({ stopFilePath: "/tmp/test-stop-file-marker" });
      // Create the stop file
      require('fs').writeFileSync('/tmp/test-stop-file-marker', 'stop');
      try {
        const result = module.checkStopConditions("test");
        expect(result.shouldStop).toBe(true);
        expect(result.reason).toContain("stopFile");
      } finally {
        require('fs').unlinkSync('/tmp/test-stop-file-marker');
      }
    });

    it("does not stop when stopFilePath is empty", () => {
      const s = createSession();
      sessions.set("test", s);
      const module = createModule({ stopFilePath: "" });
      const result = module.checkStopConditions("test");
      expect(result.shouldStop).toBe(false);
    });

    it("does not stop when stopFilePath file does not exist", () => {
      const s = createSession();
      sessions.set("test", s);
      const module = createModule({ stopFilePath: "/tmp/nonexistent-stop-file-xyz" });
      const result = module.checkStopConditions("test");
      expect(result.shouldStop).toBe(false);
    });

    it("stops when untilMarker found in todo content", () => {
      const s = createSession();
      s.lastKnownTodos = [
        { id: "todo1", status: "completed", content: "Do something" },
        { id: "todo2", status: "completed", content: "ALL_DONE marker" },
      ];
      sessions.set("test", s);
      const module = createModule({ untilMarker: "ALL_DONE" });
      const result = module.checkStopConditions("test");
      expect(result.shouldStop).toBe(true);
      expect(result.reason).toContain("untilMarker");
    });

    it("does not stop when untilMarker not in todo content", () => {
      const s = createSession();
      s.lastKnownTodos = [
        { id: "todo1", status: "completed", content: "Do something" },
        { id: "todo2", status: "pending", content: "Keep working" },
      ];
      sessions.set("test", s);
      const module = createModule({ untilMarker: "ALL_DONE" });
      const result = module.checkStopConditions("test");
      expect(result.shouldStop).toBe(false);
    });

    it("does not stop when untilMarker is empty", () => {
      const s = createSession();
      s.lastTodoSnapshot = "todo1:completed";
      sessions.set("test", s);
      const module = createModule({ untilMarker: "" });
      const result = module.checkStopConditions("test");
      expect(result.shouldStop).toBe(false);
    });

    it("sets stoppedByCondition on session when stop triggered", () => {
      const s = createSession();
      s.sessionCreatedAt = Date.now() - 10000;
      sessions.set("test", s);
      const module = createModule({ maxRuntimeMs: 5000 });
      expect(s.stoppedByCondition).toBeNull();
      module.checkStopConditions("test");
      expect(s.stoppedByCondition).toBeTruthy();
    });
  });
});
