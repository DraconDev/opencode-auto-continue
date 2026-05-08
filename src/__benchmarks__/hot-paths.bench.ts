import { bench, describe } from "vitest";
import { estimateTokens, formatMessage } from "../shared.js";
import { parsePlan } from "../plan.js";
import { createStrategyPool, selectBestStrategy } from "../strategy-pool.js";
import type { RecoveryContext, StallPatternType } from "../autonomy-types.js";

// Sample data for benchmarks
const sampleText = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(50);
const sampleCode = "function test() {\n  const x = 1;\n  return x + 2;\n}\n".repeat(20);
const samplePlan = `# Project Plan

## Phase 1: Setup
- [x] Initialize repository
- [ ] Configure CI/CD
- [ ] Add linting rules

## Phase 2: Core Features
- [ ] Implement authentication
- [ ] Add user dashboard
- [ ] Setup database schema

## Phase 3: Polish
- [ ] Write documentation
- [ ] Add tests
- [ ] Performance optimization
`;

describe("Token Estimation", () => {
  bench("estimate text tokens (2500 chars)", () => {
    estimateTokens(sampleText);
  });

  bench("estimate code tokens (500 chars)", () => {
    estimateTokens(sampleCode);
  });

  bench("estimate reasoning tokens (2500 chars)", () => {
    estimateTokens(sampleText);
  });
});

describe("Plan Parsing", () => {
  bench("parse full plan (8 items)", () => {
    parsePlan(samplePlan);
  });

  bench("parse empty plan", () => {
    parsePlan("");
  });
});

describe("Message Formatting", () => {
  const templateVars = {
    pending: "3",
    total: "5",
    completed: "2",
    todoList: "task1, task2, task3",
    attempts: "1",
    maxAttempts: "3",
  };

  bench("format continue message", () => {
    formatMessage(
      "Continue working. You have {pending} of {total} tasks remaining: {todoList}.",
      templateVars
    );
  });

  bench("format complex message", () => {
    formatMessage(
      "Attempt {attempts}/{maxAttempts}: {pending} tasks pending ({completed} done). Focus on: {todoList}",
      templateVars
    );
  });
});

describe("Strategy Selection", () => {
  const pool = createStrategyPool();
  const strategies = pool.getAll();
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

  const mockGetEffectiveness = async () => 0.8;

  bench("select best strategy (6 strategies)", async () => {
    await selectBestStrategy(mockContext, strategies, mockGetEffectiveness, 0);
  });

  bench("select with exploration (6 strategies)", async () => {
    await selectBestStrategy(mockContext, strategies, mockGetEffectiveness, 0.3);
  });
});
