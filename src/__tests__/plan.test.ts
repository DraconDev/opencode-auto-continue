/**
 * Tests for Plan module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parsePlan,
  getPlanPath,
  hasPendingPlanItems,
  buildPlanContinueMessage,
  markPlanItemComplete,
} from "../plan.js";

describe("Plan Module", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "plan-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("parsePlan", () => {
    it("should return empty result when plan file does not exist", () => {
      const result = parsePlan(join(tempDir, "nonexistent.md"));
      expect(result.items).toEqual([]);
      expect(result.nextItem).toBeNull();
      expect(result.progress.total).toBe(0);
    });

    it("should parse plan with phases and items", () => {
      const planContent = `# Plan: Build a Dota Game

## Phase 1: Project Setup
- [ ] Initialize project structure
- [x] Setup build system
- [ ] Configure testing

## Phase 2: Core Engine
- [ ] Implement game loop
- [ ] Create entity system
`;
      const planDir = join(tempDir, ".opencode");
      mkdirSync(planDir, { recursive: true });
      const planPath = join(planDir, "plan.md");
      writeFileSync(planPath, planContent, "utf-8");

      const result = parsePlan(planPath);

      expect(result.items).toHaveLength(5);
      expect(result.items[0].phase).toBe("Phase 1: Project Setup");
      expect(result.items[0].description).toBe("Initialize project structure");
      expect(result.items[0].completed).toBe(false);
      expect(result.items[1].completed).toBe(true);
      expect(result.items[2].completed).toBe(false);
      expect(result.items[3].phase).toBe("Phase 2: Core Engine");
    });

    it("should identify next incomplete item", () => {
      const planContent = `## Phase 1
- [x] Done task
- [ ] Next task
- [ ] Later task
`;
      const planPath = join(tempDir, "plan.md");
      writeFileSync(planPath, planContent, "utf-8");

      const result = parsePlan(planPath);

      expect(result.nextItem).not.toBeNull();
      expect(result.nextItem?.description).toBe("Next task");
      expect(result.currentPhase).toBe("Phase 1");
    });

    it("should calculate progress correctly", () => {
      const planContent = `## Phase 1
- [x] Task 1
- [x] Task 2
- [ ] Task 3
`;
      const planPath = join(tempDir, "plan.md");
      writeFileSync(planPath, planContent, "utf-8");

      const result = parsePlan(planPath);

      expect(result.progress.completed).toBe(2);
      expect(result.progress.total).toBe(3);
    });

    it("should handle all completed items", () => {
      const planContent = `## Phase 1
- [x] Task 1
- [x] Task 2
`;
      const planPath = join(tempDir, "plan.md");
      writeFileSync(planPath, planContent, "utf-8");

      const result = parsePlan(planPath);

      expect(result.nextItem).toBeNull();
      expect(result.progress.completed).toBe(2);
      expect(result.progress.total).toBe(2);
    });
  });

  describe("getPlanPath", () => {
    it("should return default path when no plan files exist", () => {
      const path = getPlanPath("/project");
      expect(path).toBe("/project/.opencode/plan.md");
    });

    it("should prioritize PLAN.md as the standard", () => {
      writeFileSync(join(tempDir, "PLAN.md"), "## Phase 1\n- [ ] Task\n", "utf-8");

      const path = getPlanPath(tempDir);
      expect(path).toBe(join(tempDir, "PLAN.md"));
    });

    it("should prioritize PLAN.md over .opencode/plan.md", () => {
      const opencodeDir = join(tempDir, ".opencode");
      mkdirSync(opencodeDir, { recursive: true });
      writeFileSync(join(opencodeDir, "plan.md"), "## Phase 1\n- [ ] Task\n", "utf-8");
      writeFileSync(join(tempDir, "PLAN.md"), "## Phase 2\n- [ ] Task\n", "utf-8");

      const path = getPlanPath(tempDir);
      expect(path).toBe(join(tempDir, "PLAN.md"));
    });

    it("should fall back to ROADMAP.md if no PLAN.md exists", () => {
      writeFileSync(join(tempDir, "ROADMAP.md"), "## Phase 1\n- [ ] Task\n", "utf-8");

      const path = getPlanPath(tempDir);
      expect(path).toBe(join(tempDir, "ROADMAP.md"));
    });

    it("should fall back to .opencode/plan.md if no root plans exist", () => {
      const opencodeDir = join(tempDir, ".opencode");
      mkdirSync(opencodeDir, { recursive: true });
      writeFileSync(join(opencodeDir, "plan.md"), "## Phase 1\n- [ ] Task\n", "utf-8");

      const path = getPlanPath(tempDir);
      expect(path).toBe(join(tempDir, ".opencode", "plan.md"));
    });

    it("should fall back to README.md if no other plan files exist", () => {
      writeFileSync(join(tempDir, "README.md"), "## Roadmap\n- [ ] Task\n", "utf-8");

      const path = getPlanPath(tempDir);
      expect(path).toBe(join(tempDir, "README.md"));
    });

    it("should fall back to TODO.md if no other plan files exist", () => {
      writeFileSync(join(tempDir, "TODO.md"), "- [ ] Task\n", "utf-8");

      const path = getPlanPath(tempDir);
      expect(path).toBe(join(tempDir, "TODO.md"));
    });
  });

  describe("hasPendingPlanItems", () => {
    it("should return false when plan does not exist", () => {
      expect(hasPendingPlanItems(tempDir)).toBe(false);
    });

    it("should return true when plan has pending items", () => {
      const planDir = join(tempDir, ".opencode");
      mkdirSync(planDir, { recursive: true });
      const planPath = join(planDir, "plan.md");
      writeFileSync(
        planPath,
        `## Phase 1\n- [ ] Pending task\n`,
        "utf-8"
      );

      expect(hasPendingPlanItems(tempDir)).toBe(true);
    });

    it("should return false when all items are completed", () => {
      const planDir = join(tempDir, ".opencode");
      mkdirSync(planDir, { recursive: true });
      const planPath = join(planDir, "plan.md");
      writeFileSync(
        planPath,
        `## Phase 1\n- [x] Completed task\n`,
        "utf-8"
      );

      expect(hasPendingPlanItems(tempDir)).toBe(false);
    });
  });

  describe("buildPlanContinueMessage", () => {
    it("should return null when no next item", () => {
      const result = parsePlan(join(tempDir, "nonexistent.md"));
      const message = buildPlanContinueMessage(result);
      expect(message).toBeNull();
    });

    it("should build message with phase and progress", () => {
      const planPath = join(tempDir, "plan.md");
      writeFileSync(
        planPath,
        `## Phase 1: Setup\n- [x] Task 1\n- [ ] Task 2\n`,
        "utf-8"
      );

      const result = parsePlan(planPath);
      const message = buildPlanContinueMessage(result);

      expect(message).not.toBeNull();
      expect(message).toContain("50% complete");
      expect(message).toContain("Phase 1: Setup");
      expect(message).toContain("Task 2");
      expect(message).toContain("create todos");
    });

    it("should handle zero progress", () => {
      const planPath = join(tempDir, "plan.md");
      writeFileSync(
        planPath,
        `## Phase 1\n- [ ] Task 1\n`,
        "utf-8"
      );

      const result = parsePlan(planPath);
      const message = buildPlanContinueMessage(result);

      expect(message).not.toBeNull();
      expect(message).toContain("0% complete");
    });
  });

  describe("markPlanItemComplete", () => {
    it("should mark matching item as complete", () => {
      const planPath = join(tempDir, "plan.md");
      writeFileSync(
        planPath,
        `## Phase 1\n- [ ] Initialize project\n- [ ] Setup tests\n`,
        "utf-8"
      );

      const result = markPlanItemComplete(planPath, "Initialize project");
      expect(result).toBe(true);

      const updated = parsePlan(planPath);
      expect(updated.items[0].completed).toBe(true);
      expect(updated.items[1].completed).toBe(false);
    });

    it("should return false when plan does not exist", () => {
      const result = markPlanItemComplete(join(tempDir, "nonexistent.md"), "task");
      expect(result).toBe(false);
    });

    it("should return false when no matching item found", () => {
      const planPath = join(tempDir, "plan.md");
      writeFileSync(
        planPath,
        `## Phase 1\n- [ ] Task 1\n`,
        "utf-8"
      );

      const result = markPlanItemComplete(planPath, "Nonexistent task");
      expect(result).toBe(false);
    });

    it("should handle partial match", () => {
      const planPath = join(tempDir, "plan.md");
      writeFileSync(
        planPath,
        `## Phase 1\n- [ ] Initialize the project structure\n`,
        "utf-8"
      );

      const result = markPlanItemComplete(planPath, "Initialize");
      expect(result).toBe(true);

      const updated = parsePlan(planPath);
      expect(updated.items[0].completed).toBe(true);
    });
  });

  describe("Config Features", () => {
    it("should use custom plan file path when provided", () => {
      const customPath = join(tempDir, "custom-plan.md");
      writeFileSync(customPath, "## Phase 1\n- [ ] Custom task\n", "utf-8");

      const path = getPlanPath(tempDir, "custom-plan.md");
      expect(path).toBe(customPath);
    });

    it("should fall back to standard search when custom path does not exist", () => {
      writeFileSync(join(tempDir, "PLAN.md"), "## Phase 1\n- [ ] Task\n", "utf-8");

      const path = getPlanPath(tempDir, "nonexistent.md");
      expect(path).toBe(join(tempDir, "PLAN.md"));
    });

    it("should handle absolute custom path", () => {
      const customPath = join(tempDir, "absolute-plan.md");
      writeFileSync(customPath, "## Phase 1\n- [ ] Absolute task\n", "utf-8");

      const path = getPlanPath(tempDir, customPath);
      expect(path).toBe(customPath);
    });

    it("should limit upcoming items in continue message", () => {
      const planPath = join(tempDir, "plan.md");
      writeFileSync(
        planPath,
        `## Phase 1\n- [x] Task 1\n- [ ] Task 2\n- [ ] Task 3\n- [ ] Task 4\n- [ ] Task 5\n`,
        "utf-8"
      );

      const result = parsePlan(planPath);
      const message = buildPlanContinueMessage(result, 2);

      expect(message).toContain("Task 2");
      expect(message).toContain("Upcoming items");
      expect(message).toContain("Task 3");
      expect(message).not.toContain("Task 4");
    });

    it("should show all upcoming items when maxItems is high", () => {
      const planPath = join(tempDir, "plan.md");
      writeFileSync(
        planPath,
        `## Phase 1\n- [x] Task 1\n- [ ] Task 2\n- [ ] Task 3\n- [ ] Task 4\n`,
        "utf-8"
      );

      const result = parsePlan(planPath);
      const message = buildPlanContinueMessage(result, 10);

      expect(message).toContain("Task 2");
      expect(message).toContain("Task 3");
      expect(message).toContain("Task 4");
    });

    it("should not show upcoming section when no more items", () => {
      const planPath = join(tempDir, "plan.md");
      writeFileSync(
        planPath,
        `## Phase 1\n- [x] Task 1\n- [ ] Task 2\n`,
        "utf-8"
      );

      const result = parsePlan(planPath);
      const message = buildPlanContinueMessage(result, 3);

      expect(message).toContain("Task 2");
      expect(message).not.toContain("Upcoming items");
    });
  });
});
