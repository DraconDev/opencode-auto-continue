/**
 * Tests for AutonomousCore module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAutonomousCore } from "../autonomous-core.js";
import type { AutonomyConfig } from "../autonomy-types.js";

const mockConfig: AutonomyConfig = {
  level: "adaptive",
  intentExtraction: true,
  predictiveIntervention: false,
  learningEnabled: true,
  metaCognition: false,
  taskOrchestration: false,
  autoDecomposition: false,
  strategyPool: ["gentle-guidance", "direct-intervention"],
  predictionThreshold: 0.7,
  learningRate: 0.3,
  reflectionIntervalMs: 300000,
  maxConcurrentSessions: 3,
  autoCheckpoint: false,
  checkpointIntervalMs: 600000,
};

describe("AutonomousCore", () => {
  const mockLog = vi.fn();
  let core: ReturnType<typeof createAutonomousCore>;
  
  beforeEach(() => {
    mockLog.mockClear();
    core = createAutonomousCore({ log: mockLog, config: mockConfig });
  });
  
  describe("Intent Extraction", () => {
    it("should extract intent from a refactoring prompt", async () => {
      const result = await core.extractIntent("session-1", "Refactor the authentication module to use JWT tokens instead of session cookies");
      
      expect(result.success).toBe(true);
      expect(result.intent.primaryGoal).toContain("Refactor");
      expect(result.intent.domain).toBe("refactoring");
      expect(result.intent.confidence).toBeGreaterThan(0.5);
      expect(result.intent.taskGraph.nodes.size).toBeGreaterThan(1);
    });
    
    it("should extract intent from a feature prompt", async () => {
      const result = await core.extractIntent("session-2", "Implement a new user dashboard with real-time notifications and analytics widgets");
      
      expect(result.success).toBe(true);
      expect(result.intent.domain).toBe("feature");
      expect(result.intent.taskGraph.root.subtasks.length).toBeGreaterThan(0);
    });
    
    it("should extract intent from a bugfix prompt", async () => {
      const result = await core.extractIntent("session-3", "Fix the memory leak in the data processing pipeline that causes crashes after 10 minutes");
      
      expect(result.success).toBe(true);
      expect(result.intent.domain).toBe("bugfix");
    });
    
    it("should identify ambiguities in vague prompts", async () => {
      const result = await core.extractIntent("session-4", "Improve the app to make it better and faster");
      
      expect(result.analysis.ambiguities.length).toBeGreaterThan(0);
      expect(result.analysis.ambiguities[0]).toContain("Vague");
    });
    
    it("should return fallback when intent extraction is disabled", async () => {
      const disabledConfig = { ...mockConfig, intentExtraction: false };
      const disabledCore = createAutonomousCore({ log: mockLog, config: disabledConfig });
      
      const result = await disabledCore.extractIntent("session-5", "Refactor auth module");
      
      expect(result.success).toBe(false);
      expect(result.intent.domain).toBe("unknown");
    });
    
    it("should estimate complexity based on keywords", async () => {
      const simpleResult = await core.extractIntent("session-6", "Fix typo in README");
      const complexResult = await core.extractIntent("session-7", "Redesign the entire microservices architecture with event-driven patterns");
      
      expect(simpleResult.analysis.complexityEstimate).toBeLessThan(complexResult.analysis.complexityEstimate);
    });
  });
  
  describe("Task Graph", () => {
    it("should build task graph from todos", async () => {
      await core.extractIntent("session-8", "Implement feature X");
      
      const todos = [
        { id: "todo-1", content: "Design API", status: "completed" },
        { id: "todo-2", content: "Implement backend", status: "in_progress" },
        { id: "todo-3", content: "Write tests", status: "pending" },
      ];
      
      const graph = await core.buildTaskGraph("session-8", todos);
      
      expect(graph.nodes.size).toBe(4); // root + 3 todos
      expect(graph.root.subtasks.length).toBe(3);
      expect(graph.maxDepth).toBe(2);
    });
    
    it("should map todo statuses correctly", async () => {
      await core.extractIntent("session-9", "Test");
      
      const todos = [
        { id: "todo-1", content: "Done task", status: "completed" },
        { id: "todo-2", content: "Active task", status: "in_progress" },
        { id: "todo-3", content: "Blocked task", status: "blocked" },
        { id: "todo-4", content: "Pending task", status: "pending" },
      ];
      
      const graph = await core.buildTaskGraph("session-9", todos);
      
      expect(graph.nodes.get("todo-1")?.status).toBe("completed");
      expect(graph.nodes.get("todo-2")?.status).toBe("in_progress");
      expect(graph.nodes.get("todo-3")?.status).toBe("blocked");
      expect(graph.nodes.get("todo-4")?.status).toBe("pending");
    });
  });
  
  describe("Progress Tracking", () => {
    it("should update task effort on tool calls", async () => {
      await core.extractIntent("session-10", "Implement feature");
      
      const todos = [{ id: "todo-1", content: "Task 1", status: "in_progress" }];
      await core.buildTaskGraph("session-10", todos);
      
      await core.updateTaskProgress("session-10", {
        type: "tool_call",
        durationMs: 5000,
      });
      
      const intent = core.getIntent("session-10");
      expect(intent?.taskGraph.nodes.get("root")?.actualEffortMs).toBe(5000);
    });
    
    it("should mark task complete on file modification", async () => {
      await core.extractIntent("session-11", "Implement feature");
      
      const todos = [
        { id: "todo-1", content: "Implement auth.ts", status: "in_progress" },
      ];
      await core.buildTaskGraph("session-11", todos);
      
      await core.updateTaskProgress("session-11", {
        type: "file_modify",
        filePath: "/src/auth.ts",
        isCompletion: true,
      });
      
      const intent = core.getIntent("session-11");
      expect(intent?.taskGraph.nodes.get("todo-1")?.status).toBe("completed");
    });
  });
  
  describe("Health Status", () => {
    it("should report healthy when on track", async () => {
      await core.extractIntent("session-12", "Simple task");
      
      const health = core.isOnTrack("session-12");
      expect(health.onTrack).toBe(true);
      expect(health.score).toBeGreaterThan(0);
    });
    
    it("should identify risks when behind schedule", async () => {
      await core.extractIntent("session-13", "Complex refactoring task");
      
      // Simulate a lot of time passing with no progress
      const intent = core.getIntent("session-13");
      if (intent) {
        intent.sessionStartTime = Date.now() - 1000 * 60 * 60 * 2; // 2 hours ago
        intent.estimatedTotalTime = 30; // 30 minutes estimated
      }
      
      const health = core.isOnTrack("session-13");
      expect(health.risks.length).toBeGreaterThan(0);
      expect(health.risks[0]).toContain("behind schedule");
    });
  });
  
  describe("Focus Recommendation", () => {
    it("should recommend current task focus", async () => {
      await core.extractIntent("session-14", "Implement feature");
      
      const todos = [
        { id: "todo-1", content: "Design API", status: "completed" },
        { id: "todo-2", content: "Implement backend", status: "in_progress" },
      ];
      await core.buildTaskGraph("session-14", todos);
      
      const focus = core.getCurrentFocus("session-14");
      expect(focus.taskDescription).toContain("Implement backend");
      expect(focus.nextFocus).toBeDefined();
    });
  });
  
  describe("Cleanup", () => {
    it("should clear intent on cleanup", async () => {
      await core.extractIntent("session-15", "Test task");
      expect(core.getIntent("session-15")).toBeDefined();
      
      core.clearIntent("session-15");
      expect(core.getIntent("session-15")).toBeUndefined();
    });
  });
});
