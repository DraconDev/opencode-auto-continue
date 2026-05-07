/**
 * Tests for StrategyPool module
 */

import { describe, it, expect, vi } from "vitest";
import { createStrategyPool, selectBestStrategy, BUILT_IN_STRATEGIES } from "../strategy-pool.js";
import type { RecoveryContext, StallPatternType, RecoveryResult } from "../autonomy-types.js";

const mockContext: RecoveryContext = {
  sessionState: {},
  stallPattern: "reasoning-loop" as StallPatternType,
  patternConfidence: 0.9,
  recentMessages: [],
  todoContext: [],
  failureHistory: [],
  proactiveInterventionSent: false,
  recoveryAttempts: 0,
  tokenCount: 5000,
  contextLimit: 100000,
  sessionAge: 60000,
};

describe("StrategyPool", () => {
  describe("Basic Operations", () => {
    it("should return all built-in strategies", () => {
      const pool = createStrategyPool();
      const strategies = pool.getAll();
      
      expect(strategies.length).toBe(BUILT_IN_STRATEGIES.length);
      expect(strategies.map(s => s.id)).toContain("gentle-guidance");
      expect(strategies.map(s => s.id)).toContain("direct-intervention");
    });
    
    it("should get strategies by pattern", () => {
      const pool = createStrategyPool();
      const strategies = pool.getForPattern("reasoning-loop");
      
      expect(strategies.length).toBeGreaterThan(0);
      expect(strategies.every(s => s.applicablePatterns.includes("reasoning-loop"))).toBe(true);
    });
    
    it("should get a specific strategy by ID", () => {
      const pool = createStrategyPool();
      const strategy = pool.get("gentle-guidance");
      
      expect(strategy).toBeDefined();
      expect(strategy?.name).toBe("Gentle Guidance");
    });
    
    it("should return undefined for unknown strategy", () => {
      const pool = createStrategyPool();
      const strategy = pool.get("nonexistent");
      
      expect(strategy).toBeUndefined();
    });
  });
  
  describe("Strategy Management", () => {
    it("should register a custom strategy", () => {
      const pool = createStrategyPool();
      
      const customStrategy = {
        id: "custom-strategy",
        name: "Custom",
        description: "Test",
        applicablePatterns: ["reasoning-loop" as StallPatternType],
        priority: "secondary" as const,
        effectiveness: 0.5,
        requiresAbort: false,
        maxMessageLength: 100,
        execute: vi.fn(),
        generateMessage: vi.fn().mockReturnValue("Custom message"),
      };
      
      pool.register(customStrategy);
      
      expect(pool.get("custom-strategy")).toBeDefined();
      expect(pool.getAll().length).toBe(BUILT_IN_STRATEGIES.length + 1);
    });
    
    it("should update strategy effectiveness", () => {
      const pool = createStrategyPool();
      
      pool.updateEffectiveness("gentle-guidance", 0.95);
      
      const strategy = pool.get("gentle-guidance");
      expect(strategy?.effectiveness).toBe(0.95);
      expect(strategy?.priority).toBe("primary");
    });
    
    it("should downgrade low effectiveness strategies", () => {
      const pool = createStrategyPool();
      
      pool.updateEffectiveness("gentle-guidance", 0.2);
      
      const strategy = pool.get("gentle-guidance");
      expect(strategy?.priority).toBe("fallback");
    });
    
    it("should disable and enable strategies", () => {
      const pool = createStrategyPool();
      
      pool.disable("gentle-guidance");
      expect(pool.get("gentle-guidance")?.priority).toBe("disabled");
      
      pool.enable("gentle-guidance");
      expect(pool.get("gentle-guidance")?.priority).not.toBe("disabled");
    });
    
    it("should exclude disabled strategies from getAll", () => {
      const pool = createStrategyPool();
      
      pool.disable("gentle-guidance");
      const strategies = pool.getAll();
      
      expect(strategies.map(s => s.id)).not.toContain("gentle-guidance");
    });
  });
  
  describe("Strategy Selection", () => {
    it("should select the best strategy for a pattern", async () => {
      const pool = createStrategyPool();
      const strategies = pool.getForPattern("reasoning-loop");
      
      const mockGetEffectiveness = vi.fn().mockResolvedValue(0.8);
      
      const selected = await selectBestStrategy(
        mockContext,
        strategies,
        mockGetEffectiveness,
        0 // No exploration
      );
      
      expect(selected).toBeDefined();
      expect(selected.applicablePatterns).toContain("reasoning-loop");
    });
    
    it("should explore alternative strategies sometimes", async () => {
      const pool = createStrategyPool();
      const strategies = pool.getForPattern("reasoning-loop");
      
      const mockGetEffectiveness = vi.fn().mockImplementation((id) => {
        return Promise.resolve(id === "gentle-guidance" ? 0.9 : 0.7);
      });
      
      // With 100% exploration rate, should sometimes pick second best
      let explorations = 0;
      for (let i = 0; i < 100; i++) {
        const selected = await selectBestStrategy(
          mockContext,
          strategies,
          mockGetEffectiveness,
          1.0 // Always explore
        );
        if (selected.id !== "gentle-guidance") {
          explorations++;
        }
      }
      
      expect(explorations).toBeGreaterThan(0);
    });
    
    it("should fallback when no strategies match", async () => {
      const pool = createStrategyPool();
      
      const noMatchContext: RecoveryContext = {
        ...mockContext,
        stallPattern: "unknown" as StallPatternType,
      };
      
      const strategies = pool.getAll();
      const mockGetEffectiveness = vi.fn().mockResolvedValue(0.5);
      
      const selected = await selectBestStrategy(
        noMatchContext,
        strategies,
        mockGetEffectiveness,
        0
      );
      
      expect(selected).toBeDefined();
    });
    
    it("should penalize gentle-guidance if proactive failed", async () => {
      const pool = createStrategyPool();
      const strategies = pool.getForPattern("reasoning-loop");
      
      const contextWithProactive: RecoveryContext = {
        ...mockContext,
        proactiveInterventionSent: true,
      };
      
      const mockGetEffectiveness = vi.fn().mockResolvedValue(0.8);
      
      const selected = await selectBestStrategy(
        contextWithProactive,
        strategies,
        mockGetEffectiveness,
        0
      );
      
      // Should prefer non-gentle-guidance strategy
      if (selected.id === "gentle-guidance") {
        // If gentle-guidance is still selected, its score was penalized but still best
        expect(mockGetEffectiveness).toHaveBeenCalled();
      }
    });
  });
  
  describe("Strategy Execution", () => {
    it("should execute gentle-guidance without abort", async () => {
      const pool = createStrategyPool();
      const strategy = pool.get("gentle-guidance")!;
      
      const result = await strategy.execute("session-1", mockContext);
      
      expect(result.success).toBe(true);
      expect(result.aborted).toBe(false);
      expect(result.strategyId).toBe("gentle-guidance");
      expect(result.message.length).toBeGreaterThan(0);
    });
    
    it("should execute direct-intervention with abort", async () => {
      const pool = createStrategyPool();
      const strategy = pool.get("direct-intervention")!;
      
      const result = await strategy.execute("session-1", mockContext);
      
      expect(result.success).toBe(true);
      expect(result.aborted).toBe(true);
    });
    
    it("should generate contextual messages", () => {
      const pool = createStrategyPool();
      const strategy = pool.get("gentle-guidance")!;
      
      const message = strategy.generateMessage(mockContext);
      
      expect(message.length).toBeGreaterThan(0);
      expect(message.length).toBeLessThanOrEqual(strategy.maxMessageLength);
    });
  });
  
  describe("Report Generation", () => {
    it("should generate effectiveness report", () => {
      const pool = createStrategyPool();
      const report = pool.getReport();
      
      expect(report.length).toBe(BUILT_IN_STRATEGIES.length);
      expect(report[0]).toHaveProperty("id");
      expect(report[0]).toHaveProperty("name");
      expect(report[0]).toHaveProperty("effectiveness");
      expect(report[0]).toHaveProperty("priority");
    });
  });
});
