> **STATUS: Design RFC** — This document describes aspirational features not yet implemented. See FLOW-CHART.md for current behavior.

# Spec-Driven Auto-Continue: Feature Design Document

**Date**: 2026-05-08
**Status**: Design Phase
**Version**: v8.0 Vision

---

## Problem Statement

Current behavior when AI finishes normally:
1. AI completes its turn (idle status)
2. User must manually type "continue" or similar
3. AI starts fresh, may lose context on what to do next
4. No verification that previous work was correct

**The Gap**: No plugin intelligently continues after **normal completion** based on:
- Plan/spec state (what's done vs what's left)
- Test results (did the code work?)
- Review status (does it need review?)
- Code state (uncommitted changes, build status)

---

## What Competitors Are Doing

### 1. Mte90/opencode-auto-resume (38 stars)
**Scope**: Recovery from failures only (stalls, tool-text, hallucination loops)
**Gap**: No normal-completion handling whatsoever
**Architecture**: Single-file, 1028 lines, event-driven timer

### 2. Reddit "tiny auto-continue" plugin
**Scope**: Parses `TASK_STATUS: INCOMPLETE` from AI output → sends "keep going"
**Gap**: Dumb string matching, no plan awareness, no verification
**Architecture**: ~50 lines, regex-based

### 3. davidroman0O's Multi-Agent Workflow (Gist, 1 star)
**Scope**: Full autonomous pipeline: plan → review → TDD test → implement → review → PR
**Approach**: Slash commands (`/workflow`) with dedicated agents (@check, @test, @make)
**Gap**: Requires explicit user command, not automatic; heavy setup (5 agents, Linear CLI)
**Innovation**: Test-first by default, structured failure classification, fresh context per task

### 4. OpenAI Auto-Review
**Scope**: Separate agent reviews and approves/denies boundary-crossing actions
**Gap**: Security-focused, not workflow automation
**Innovation**: Multi-agent trust model

### 5. TDD-obsessed community
**Scope**: Making agents write tests before code automatically
**Gap**: No integration with recovery/continue systems
**Innovation**: RED→GREEN evidence tracking, failure classification

---

## Our Unique Opportunity

**No competitor combines**:
- ✅ Automatic continuation after normal idle (not just failures)
- ✅ Plan/spec awareness (what was supposed to happen)
- ✅ Verification gate (tests, build, lint)
- ✅ Review gate (did we do what was asked?)
- ✅ Integration with existing recovery system

---

## Feature Design: "Auto-Checkpoint"

### Concept

When the AI goes idle after normal completion, instead of waiting for the user, the plugin:

1. **Reads the plan** (from session context or AGENTS.md)
2. **Checks the current state** (git status, test results, build status)
3. **Determines what's next** (from plan vs reality gap)
4. **Auto-continues with specific instructions** (not just "continue")

### Example Workflow

**User says**: "Implement user authentication with JWT tokens"

**AI Plan Generated**:
```
Step 1: Create auth module structure
Step 2: Implement JWT token generation
Step 3: Add middleware for token validation
Step 4: Write tests for auth flow
Step 5: Run cargo test to verify
Step 6: Run cargo clippy for linting
```

**After Step 3 (AI goes idle)**:
- Plugin detects idle with pending plan steps
- Plugin runs `cargo test` automatically
- Tests fail (auth module not fully wired)
- Plugin sends: "Tests are failing: [error output]. Please fix the auth middleware integration before proceeding to Step 4."

**After Step 4 (AI goes idle)**:
- Plugin detects idle with pending plan steps
- Plugin runs `cargo test` automatically
- Tests pass
- Plugin sends: "Tests passing! Now run `cargo clippy` to check code quality (Step 6)."

**After Step 6 (AI goes idle)**:
- Plugin detects idle, all plan steps complete
- Plugin runs final verification: `cargo test` + `cargo clippy`
- Everything passes
- Plugin sends: "All checks pass! Ready for review. Should I create a summary of changes?"

---

## Architecture

```
session.status(idle)
    │
    ▼
[Auto-Checkpoint Trigger]
    │
    ├── Check: Is there a plan/spec?
    │   ├── NO → Normal nudge (existing behavior)
    │   └── YES → Continue
    │
    ├── Step 1: Parse Plan
    │   ├── Extract steps from session context
    │   ├── Track completed vs pending
    │   └── Identify current step
    │
    ├── Step 2: Verify Current Step
    │   ├── Run tests (cargo test, npm test, etc.)
    │   ├── Run linter (clippy, eslint, etc.)
    │   ├── Check build (cargo build, tsc, etc.)
    │   └── Check git status (uncommitted changes)
    │
    ├── Step 3: Determine Next Action
    │   ├── Tests failed? → Fix first
    │   ├── Linter failed? → Fix first
    │   ├── Build failed? → Fix first
    │   ├── All pass? → Continue to next step
    │   └── All steps done? → Completion prompt
    │
    └── Step 4: Auto-Continue
        ├── Generate specific prompt (not generic "continue")
        ├── Include verification results
        ├── Reference plan step
        └── Send via promptAsync
```

---

## Components

### 1. Plan Parser (`src/plan-parser.ts`)

```typescript
interface PlanStep {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  verification?: VerificationCommand[];
  dependsOn?: string[];
}

interface Plan {
  steps: PlanStep[];
  currentStepId: string | null;
  metadata: {
    createdAt: number;
    source: 'session' | 'agents_md' | 'user';
  };
}

function parsePlanFromSession(sessionId: string): Promise<Plan | null>
function parsePlanFromMessages(messages: any[]): Plan | null
function extractPlanFromText(text: string): Plan | null
```

**Detection patterns**:
- Markdown lists with checkboxes: `- [ ] Step 1: ...`
- Numbered lists: `1. Step 1: ...`
- Explicit plan blocks: `## Plan` or `### Implementation Plan`
- AGENTS.md `## Plan` section
- Todo items as implicit plan steps

### 2. Verification Runner (`src/verification-runner.ts`)

```typescript
interface VerificationResult {
  command: string;
  success: boolean;
  output: string;
  exitCode: number;
  durationMs: number;
}

interface VerificationSuite {
  tests: VerificationCommand[];
  lint: VerificationCommand[];
  build: VerificationCommand[];
}

interface VerificationCommand {
  name: string;
  command: string;
  cwd?: string;
  required: boolean; // Must pass to continue
  timeoutMs: number;
}

const DEFAULT_VERIFICATIONS: Record<string, VerificationSuite> = {
  rust: {
    tests: [{ name: 'cargo test', command: 'cargo test', required: true, timeoutMs: 120000 }],
    lint: [{ name: 'cargo clippy', command: 'cargo clippy -- -D warnings', required: false, timeoutMs: 60000 }],
    build: [{ name: 'cargo build', command: 'cargo build', required: true, timeoutMs: 120000 }],
  },
  typescript: {
    tests: [{ name: 'npm test', command: 'npm test', required: true, timeoutMs: 120000 }],
    lint: [{ name: 'eslint', command: 'npx eslint src/', required: false, timeoutMs: 60000 }],
    build: [{ name: 'tsc', command: 'npx tsc --noEmit', required: true, timeoutMs: 60000 }],
  },
  // ... more languages
};

function detectProjectType(directory: string): string
async function runVerification(command: VerificationCommand): Promise<VerificationResult>
async function runVerificationSuite(suite: VerificationSuite): Promise<VerificationResult[]>
```

### 3. State Analyzer (`src/state-analyzer.ts`)

```typescript
interface SessionState {
  gitStatus: {
    hasUncommittedChanges: boolean;
    modifiedFiles: string[];
    newFiles: string[];
    deletedFiles: string[];
  };
  lastBuildResult: VerificationResult | null;
  lastTestResult: VerificationResult | null;
  lastLintResult: VerificationResult | null;
  planProgress: Plan;
}

async function analyzeSessionState(sessionId: string): Promise<SessionState>
function determineNextAction(state: SessionState): NextAction

interface NextAction {
  type: 'fix_tests' | 'fix_lint' | 'fix_build' | 'continue_step' | 'complete' | 'review';
  message: string;
  context: string;
}
```

### 4. Auto-Continue Engine (`src/auto-checkpoint.ts`)

```typescript
interface AutoCheckpointDeps {
  config: PluginConfig;
  sessions: Map<string, SessionState>;
  log: (...args: unknown[]) => void;
  input: TypedPluginInput;
}

interface AutoCheckpointConfig {
  enabled: boolean;
  verifyBeforeContinue: boolean;
  autoRunTests: boolean;
  autoRunLint: boolean;
  autoRunBuild: boolean;
  testTimeoutMs: number;
  lintTimeoutMs: number;
  buildTimeoutMs: number;
  maxAutoContinues: number; // Loop protection
  continueCooldownMs: number;
}

function createAutoCheckpoint(deps: AutoCheckpointDeps): {
  onSessionIdle: (sessionId: string) => Promise<void>;
  getState: (sessionId: string) => SessionState | undefined;
}
```

---

## Integration Points

### With Existing Recovery System

```typescript
// In index.ts, session.status(idle) handler:
if (s.hasOpenTodos && config.nudgeEnabled) {
  // Existing nudge logic
  await injectNudge(sessionId);
} else if (config.autoCheckpointEnabled && hasPlan(sessionId)) {
  // NEW: Auto-checkpoint logic
  await autoCheckpoint.onSessionIdle(sessionId);
}
```

### With Todo System

- Plan steps map to todos automatically
- Completing a plan step → marks corresponding todo as done
- Todo updates → update plan step status

### With Session Monitor

- Auto-checkpoint sessions tracked in session monitor
- Idle cleanup aware of auto-checkpoint in-progress
- Orphan detection doesn't interfere with verification running

---

## Configuration

```json
{
  "plugin": [
    ["opencode-auto-continue", {
      "autoCheckpointEnabled": true,
      "verifyBeforeContinue": true,
      "autoRunTests": true,
      "autoRunLint": true,
      "autoRunBuild": true,
      "testTimeoutMs": 120000,
      "lintTimeoutMs": 60000,
      "buildTimeoutMs": 120000,
      "maxAutoContinues": 10,
      "continueCooldownMs": 30000,
      "verificationRules": {
        "rust": {
          "test": "cargo test",
          "lint": "cargo clippy -- -D warnings",
          "build": "cargo build"
        },
        "typescript": {
          "test": "npm test",
          "lint": "npx eslint src/",
          "build": "npx tsc --noEmit"
        }
      }
    }]
  ]
}
```

---

## Example Prompts Generated

### Scenario 1: Tests Failing

```
Step 3 of 6 (JWT middleware) appears complete, but verification shows issues:

**cargo test** (FAILED):
```
test auth::tests::test_jwt_validation ... FAILED
Error: assert_eq!(result, true) at src/auth/tests.rs:45
```

**Next**: Fix the JWT validation test before proceeding to Step 4 (write integration tests).

Please fix the failing test and run `cargo test` again.
```

### Scenario 2: All Pass, Continue

```
Step 3 of 6 (JWT middleware) verified successfully:

✅ cargo test: PASSED (12 tests)
✅ cargo clippy: PASSED (0 warnings)
✅ cargo build: PASSED

**Next**: Proceed to Step 4: Write integration tests for the auth flow.

Please implement integration tests covering login, token refresh, and logout endpoints.
```

### Scenario 3: Completion

```
All 6 steps of the plan are complete:

✅ cargo test: PASSED (24 tests)
✅ cargo clippy: PASSED (0 warnings)
✅ cargo build: PASSED
✅ git status: 3 files modified, 2 new files

**Summary of changes**:
- src/auth/mod.rs (new) - JWT token generation
- src/auth/middleware.rs (new) - Token validation middleware
- src/main.rs - Integrated auth into app

Would you like me to:
1. Commit these changes with a conventional commit message
2. Show a diff for review
3. Continue with another task
```

---

## Safety & Guardrails

1. **Loop Protection**: Max 10 auto-continues per session, then require user input
2. **Verification Timeouts**: Commands timeout to prevent hanging
3. **Failure Graceful**: If verification fails to run, still allow continue with warning
4. **User Override**: ESC / abort stops auto-checkpoint permanently for session
5. **Opt-in**: Disabled by default, user must enable in config
6. **Question Detection**: If AI asks user something, pause auto-checkpoint
7. **Cost Awareness**: Verification commands run locally (no API cost), only continue prompt costs tokens

---

## Competitive Advantage

| Feature | auto-resume (Mte90) | tiny plugin | davidroman0O | **auto-continue (us)** |
|---------|---------------------|-------------|--------------|------------------------|
| Auto-continue on idle | ❌ | ✅ Dumb | ❌ Manual | ✅ **Intelligent** |
| Plan awareness | ❌ | ❌ | ✅ Complex | ✅ **Automatic** |
| Verification (tests/lint) | ❌ | ❌ | ✅ Full TDD | ✅ **Automatic** |
| Failure recovery | ✅ | ❌ | ✅ | ✅ **+ Verification** |
| Easy setup | ✅ | ✅ | ❌ 5 agents | ✅ **Plugin only** |
| Review gate | ❌ | ❌ | ✅ Multi-agent | ✅ **Built-in** |

---

## Implementation Phases

### Phase 1: Plan Parser (Week 1)
- Parse plans from session messages
- Extract steps and track progress
- Map to todo items

### Phase 2: Verification Runner (Week 2)
- Detect project type
- Run tests/lint/build
- Parse results

### Phase 3: State Analyzer (Week 3)
- Compare plan vs reality
- Determine next action
- Generate specific prompts

### Phase 4: Integration (Week 4)
- Wire into existing idle handler
- Add config options
- Add tests
- Update docs

---

## Success Metrics

- **User intervention reduction**: 50% fewer manual "continue" prompts
- **Quality improvement**: 80% of auto-continues pass verification
- **User satisfaction**: Users report feeling "the AI just knows what to do next"

---

*Design by: opencode-auto-continue team*
*Inspired by: davidroman0O's multi-agent workflow, TDD community, user feedback*
