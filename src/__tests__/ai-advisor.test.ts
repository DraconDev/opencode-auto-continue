import { describe, it, expect, vi } from "vitest";
import { createAIAdvisor, type AIAdvisorConfig, type SessionContext } from "../ai-advisor.js";
import type { SessionState } from "../shared.js";

function createMockState(overrides: Partial<SessionState> = {}): SessionState {
  const now = Date.now();
  return {
    timer: null,
    lastProgressAt: now,
    actionStartedAt: now,
    attempts: 0,
    lastRecoveryTime: 0,
    backoffAttempts: 0,
    autoSubmitCount: 0,
    aborting: false,
    recoveryStartTime: 0,
    stallDetections: 0,
    recoverySuccessful: 0,
    recoveryFailed: 0,
    lastRecoverySuccess: 0,
    totalRecoveryTimeMs: 0,
    recoveryTimes: [],
    lastStallPartType: "",
    stallPatterns: {},
    continueTimestamps: [],
    userCancelled: false,
    planning: false,
    planBuffer: "",
    compacting: false,
    sessionCreatedAt: now,
    messageCount: 0,
    estimatedTokens: 0,
    lastCompactionAt: 0,
    tokenLimitHits: 0,
    nudgeTimer: null,
    lastNudgeAt: 0,
    nudgeCount: 0,
    lastTodoSnapshot: "",
    nudgePaused: false,
    hasOpenTodos: false,
    lastKnownTodos: [],
    lastAdvisoryAdvice: null,
    needsContinue: false,
    continueMessageText: "",
    reviewFired: false,
    reviewDebounceTimer: null,
    lastUserMessageId: "",
    sentMessageAt: 0,
    statusHistory: [],
    ...overrides,
  };
}

const defaultConfig: AIAdvisorConfig = {
  enableAdvisory: false,
  advisoryModel: "",
  advisoryTimeoutMs: 5000,
  advisoryMaxTokens: 500,
  advisoryTemperature: 0.1,
};

const mockLog = vi.fn();
const mockInput = {
  client: {
    session: {
      messages: vi.fn(),
    },
  },
} as any;

describe("AI Advisor Module", () => {
  describe("createAIAdvisor", () => {
    it("should create the advisor module", () => {
      const advisor = createAIAdvisor({ config: defaultConfig, log: mockLog, input: mockInput });
      expect(advisor).toBeDefined();
      expect(advisor.extractContext).toBeInstanceOf(Function);
      expect(advisor.getAdvice).toBeInstanceOf(Function);
      expect(advisor.shouldUseAI).toBeInstanceOf(Function);
    });
  });

  describe("shouldUseAI", () => {
    it("should return false for obvious cases (user cancelled)", () => {
      const advisor = createAIAdvisor({ config: defaultConfig, log: mockLog, input: mockInput });
      const state = createMockState({ userCancelled: true, attempts: 3 });
      expect(advisor.shouldUseAI(state)).toBe(false);
    });

    it("should return false for compacting sessions", () => {
      const advisor = createAIAdvisor({ config: defaultConfig, log: mockLog, input: mockInput });
      const state = createMockState({ compacting: true, attempts: 3 });
      expect(advisor.shouldUseAI(state)).toBe(false);
    });

    it("should return true when attempts >= 2", () => {
      const advisor = createAIAdvisor({ config: defaultConfig, log: mockLog, input: mockInput });
      const state = createMockState({ attempts: 2 });
      expect(advisor.shouldUseAI(state)).toBe(true);
    });

    it("should return true when stallDetections >= 3", () => {
      const advisor = createAIAdvisor({ config: defaultConfig, log: mockLog, input: mockInput });
      const state = createMockState({ stallDetections: 3 });
      expect(advisor.shouldUseAI(state)).toBe(true);
    });

    it("should return true when mixed stall patterns exist", () => {
      const advisor = createAIAdvisor({ config: defaultConfig, log: mockLog, input: mockInput });
      const state = createMockState({
        stallPatterns: { text: 2, tool: 1 },
      });
      expect(advisor.shouldUseAI(state)).toBe(true);
    });

    it("should return true when planning for over 2 minutes", () => {
      const advisor = createAIAdvisor({ config: defaultConfig, log: mockLog, input: mockInput });
      const state = createMockState({
        planning: true,
        actionStartedAt: Date.now() - 130000, // > 2 min ago
      });
      expect(advisor.shouldUseAI(state)).toBe(true);
    });

    it("should return false for fresh sessions with no issues", () => {
      const advisor = createAIAdvisor({ config: defaultConfig, log: mockLog, input: mockInput });
      const state = createMockState();
      expect(advisor.shouldUseAI(state)).toBe(false);
    });
  });

  describe("extractContext", () => {
    it("should extract basic session state", async () => {
      const advisor = createAIAdvisor({ config: defaultConfig, log: mockLog, input: mockInput });
      const state = createMockState({
        attempts: 3,
        stallDetections: 5,
        lastStallPartType: "tool",
        stallPatterns: { tool: 3, text: 2 },
        estimatedTokens: 45000,
        messageCount: 12,
        hasOpenTodos: true,
      });

      const context = await advisor.extractContext("test-session", state);
      
      expect(context.sessionId).toBe("test-session");
      expect(context.attempts).toBe(3);
      expect(context.stallDetections).toBe(5);
      expect(context.lastStallPartType).toBe("tool");
      expect(context.stallPatterns).toEqual({ tool: 3, text: 2 });
      expect(context.estimatedTokens).toBe(45000);
      expect(context.messageCount).toBe(12);
      expect(context.hasOpenTodos).toBe(true);
      expect(context.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(context.lastProgressMs).toBeGreaterThanOrEqual(0);
    });

    it("should fetch recent messages when available", async () => {
      mockInput.client.session.messages.mockResolvedValueOnce({
        data: [
          { role: "user", content: "hello", createdAt: new Date().toISOString() },
          { role: "assistant", content: "I'll help", createdAt: new Date().toISOString() },
        ],
      });

      const advisor = createAIAdvisor({ config: defaultConfig, log: mockLog, input: mockInput });
      const state = createMockState();
      const context = await advisor.extractContext("test-session", state);

      expect(context.recentMessages.length).toBe(2);
      expect(context.recentMessages[0].role).toBe("user");
      expect(context.recentMessages[1].role).toBe("assistant");
    });

    it("should handle message fetch errors gracefully", async () => {
      mockInput.client.session.messages.mockRejectedValueOnce(new Error("API error"));

      const advisor = createAIAdvisor({ config: defaultConfig, log: mockLog, input: mockInput });
      const state = createMockState();
      const context = await advisor.extractContext("test-session", state);

      expect(context.recentMessages).toEqual([]);
      expect(mockLog).toHaveBeenCalledWith(
        "failed to fetch messages for AI context:",
        expect.any(Error)
      );
    });
  });

  describe("getHeuristicAdvice (via getAdvice)", () => {
    it("should advise wait for newly started sessions", async () => {
      const advisor = createAIAdvisor({ config: defaultConfig, log: mockLog, input: mockInput });
      const context: SessionContext = {
        sessionId: "test",
        elapsedMs: 5000,
        lastProgressMs: 1000,
        attempts: 0,
        stallDetections: 1,
        lastStallPartType: "text",
        stallPatterns: {},
        estimatedTokens: 1000,
        messageCount: 1,
        planning: false,
        compacting: false,
        userCancelled: false,
        hasOpenTodos: false,
        recentMessages: [],
        recentErrors: [],
      };

      const advice = await advisor.getAdvice(context);
      expect(advice).not.toBeNull();
      expect(advice!.action).toBe("wait");
      expect(advice!.suggestedDelayMs).toBe(30000);
      expect(advice!.customPrompt).toContain("initializing");
      expect(advice!.contextSummary).toContain("Session just started");
    });

    it("should advise abort for repeated same-type stall", async () => {
      const advisor = createAIAdvisor({ config: defaultConfig, log: mockLog, input: mockInput });
      const context: SessionContext = {
        sessionId: "test",
        elapsedMs: 120000,
        lastProgressMs: 60000,
        attempts: 2,
        stallDetections: 3,
        lastStallPartType: "text",
        stallPatterns: { text: 4 },
        estimatedTokens: 20000,
        messageCount: 10,
        planning: false,
        compacting: false,
        userCancelled: false,
        hasOpenTodos: true,
        recentMessages: [],
        recentErrors: [],
      };

      const advice = await advisor.getAdvice(context);
      expect(advice).not.toBeNull();
      expect(advice!.action).toBe("abort");
      expect(advice!.confidence).toBeGreaterThanOrEqual(0.8);
      expect(advice!.customPrompt).toContain("stuck");
      expect(advice!.contextSummary).toContain("stuck");
    });

    it("should advise wait for mixed stall patterns", async () => {
      const advisor = createAIAdvisor({ config: defaultConfig, log: mockLog, input: mockInput });
      const context: SessionContext = {
        sessionId: "test",
        elapsedMs: 120000,
        lastProgressMs: 30000,
        attempts: 1,
        stallDetections: 3,
        lastStallPartType: "tool",
        stallPatterns: { text: 1, tool: 1, reasoning: 1, file: 1 },
        estimatedTokens: 30000,
        messageCount: 15,
        planning: false,
        compacting: false,
        userCancelled: false,
        hasOpenTodos: true,
        recentMessages: [],
        recentErrors: [],
      };

      const advice = await advisor.getAdvice(context);
      expect(advice).not.toBeNull();
      expect(advice!.action).toBe("wait");
      expect(advice!.suggestedDelayMs).toBe(30000);
    });

    it("should advise abort for long planning", async () => {
      const advisor = createAIAdvisor({ config: defaultConfig, log: mockLog, input: mockInput });
      const context: SessionContext = {
        sessionId: "test",
        elapsedMs: 180000,
        lastProgressMs: 60000,
        attempts: 0,
        stallDetections: 2,
        lastStallPartType: "text",
        stallPatterns: { text: 2 },
        estimatedTokens: 50000,
        messageCount: 5,
        planning: true,
        compacting: false,
        userCancelled: false,
        hasOpenTodos: false,
        recentMessages: [],
        recentErrors: [],
      };

      const advice = await advisor.getAdvice(context);
      expect(advice).not.toBeNull();
      expect(advice!.action).toBe("abort");
      expect(advice!.reasoning).toContain("Planning");
    });

    it("should advise continue for high tokens with pending todos", async () => {
      const advisor = createAIAdvisor({ config: defaultConfig, log: mockLog, input: mockInput });
      const context: SessionContext = {
        sessionId: "test",
        elapsedMs: 300000,
        lastProgressMs: 1000,
        attempts: 0,
        stallDetections: 1,
        lastStallPartType: "text",
        stallPatterns: {},
        estimatedTokens: 90000,
        messageCount: 30,
        planning: false,
        compacting: false,
        userCancelled: false,
        hasOpenTodos: true,
        recentMessages: [],
        recentErrors: [],
      };

      const advice = await advisor.getAdvice(context);
      expect(advice).not.toBeNull();
      expect(advice!.action).toBe("continue");
      expect(advice!.confidence).toBeGreaterThanOrEqual(0.6);
    });

    it("should advise compact for high tokens without pending todos", async () => {
      const advisor = createAIAdvisor({ config: defaultConfig, log: mockLog, input: mockInput });
      const context: SessionContext = {
        sessionId: "test",
        elapsedMs: 300000,
        lastProgressMs: 1000,
        attempts: 0,
        stallDetections: 1,
        lastStallPartType: "text",
        stallPatterns: {},
        estimatedTokens: 90000,
        messageCount: 30,
        planning: false,
        compacting: false,
        userCancelled: false,
        hasOpenTodos: false,
        recentMessages: [],
        recentErrors: [],
      };

      const advice = await advisor.getAdvice(context);
      expect(advice).not.toBeNull();
      expect(advice!.action).toBe("compact");
    });

    it("should return null when no heuristic matches", async () => {
      const advisor = createAIAdvisor({ config: defaultConfig, log: mockLog, input: mockInput });
      const context: SessionContext = {
        sessionId: "test",
        elapsedMs: 120000,
        lastProgressMs: 1000,
        attempts: 0,
        stallDetections: 1,
        lastStallPartType: "tool",
        stallPatterns: {},
        estimatedTokens: 10000,
        messageCount: 8,
        planning: false,
        compacting: false,
        userCancelled: false,
        hasOpenTodos: false,
        recentMessages: [],
        recentErrors: [],
      };

      const advice = await advisor.getAdvice(context);
      expect(advice).toBeNull();
    });
  });
});
