# Auto-Continue Vision: AI That Drives AI Autonomously

**Status**: Design / RFC  
**Version**: 7.0 Vision  
**Date**: 2026-05-07  
**Author**: Auto-Continue Team  

---

## 1. Executive Summary

Current auto-continue is **reactive**: it watches sessions, detects stalls, and recovers. The 7.0 vision transforms it into **proactive autonomous AI orchestration**: an AI system that understands goals, predicts problems, optimizes strategies, and drives sessions to completion with minimal human intervention.

**The shift**: From "detect and recover" → "understand, predict, optimize, and complete."

---

## 2. Philosophy: The Three Layers of Autonomy

```
┌─────────────────────────────────────────────────────────────┐
│                    LAYER 3: STRATEGIC AI                     │
│         Goal Understanding • Task Decomposition              │
│         Cross-Session Planning • Resource Allocation         │
├─────────────────────────────────────────────────────────────┤
│                    LAYER 2: TACTICAL AI                      │
│         Predictive Intervention • Adaptive Recovery          │
│         Pattern Learning • Context-Aware Decision Making     │
├─────────────────────────────────────────────────────────────┤
│                    LAYER 1: OPERATIONAL                      │
│         Stall Detection • Recovery Execution                 │
│         Status Monitoring • Basic Nudging                    │
│              [ CURRENT IMPLEMENTATION ]                      │
└─────────────────────────────────────────────────────────────┘
```

**Current State (v6.x)**: Solid Layer 1 with nascent Layer 2 (AI Advisory).  
**Vision (v7.0+)**: Full Layer 2 maturity + Layer 3 introduction.

---

## 3. Core Concepts

### 3.1 Session Intent Understanding

Instead of treating sessions as black boxes that occasionally stall, the system **understands what the session is trying to accomplish**:

```typescript
interface SessionIntent {
  primaryGoal: string;           // "Refactor auth module"
  decomposition: TaskGraph;      // Hierarchical task breakdown
  currentFocus: string;          // "Currently working on: JWT token validation"
  estimatedComplexity: number;   // 1-10 scale
  domain: "refactoring" | "feature" | "bugfix" | "testing" | "documentation";
  blockers: string[];            // Known obstacles
}
```

**How**: Extract intent from:
- Initial user prompt
- Todo structure and content
- Code changes being made
- Tool usage patterns (read/write/bash)
- Assistant reasoning content

### 3.2 Predictive Stall Prevention

**Current**: Timer fires → detect stall → recover.  
**Vision**: Predict stall 30-60 seconds before it happens → intervene proactively.

```
[Progress Event Stream]
        │
        ▼
[Pattern Matcher] ──► "This looks like the beginning of 
        │                reasoning-loop pattern from history"
        ▼
[Predictive Model] ──► 78% probability of stall in 45s
        │
        ▼
[Proactive Intervention] ──► Send guidance before stall:
    "You're doing deep reasoning. Remember to test your 
     hypothesis with the codebase before continuing analysis."
```

**Signals for prediction**:
- Token velocity slowing (tokens/sec decreasing)
- Repeated similar reasoning patterns
- Tool call sequences that historically lead to stalls
- Context window approaching thresholds
- Time since last file modification

### 3.3 Adaptive Recovery Strategies

**Current**: One-size-fits-all recovery (abort + continue with generic message).  
**Vision**: Context-specific recovery tailored to the stall pattern.

| Stall Pattern | Adaptive Recovery Strategy |
|--------------|---------------------------|
| `reasoning-loop` | "You've been analyzing for 3 minutes. Try implementing a small test to validate your approach." |
| `tool-call-failure` | "The last tool call failed. Check the error message and retry with corrected parameters: [specific error]." |
| `context-bloat` | Trigger compaction + "Context is getting large. Let me compact it. Continue with the current task." |
| `api-delay` | Wait longer (no abort) + "External API seems slow. I'll wait for the response." |
| `confusion` | "You seem unsure about the approach. Here's a suggestion: [AI-generated hint based on codebase]." |
| `todo-overwhelm` | "You have 8 pending tasks. Let's focus on just the next one: [top priority task]." |

### 3.4 Self-Improving Recovery System

The system learns from every recovery:

```typescript
interface RecoveryLearning {
  sessionId: string;
  stallPattern: string;
  recoveryStrategy: string;
  outcome: "success" | "failure" | "partial";
  timeToRecovery: number;
  messagesUntilNextStall: number;
  effectiveness: number; // Calculated score
}

// Continuously update strategy effectiveness
function updateStrategyEffectiveness(learning: RecoveryLearning) {
  const strategy = strategyPool[learning.stallPattern];
  strategy.effectiveness = movingAverage(
    strategy.effectiveness,
    learning.outcome === "success" ? 1 : 0,
    0.3 // learning rate
  );
  
  // Promote successful strategies, demote failing ones
  if (strategy.effectiveness > 0.8) {
    strategy.priority = "primary";
  } else if (strategy.effectiveness < 0.3) {
    strategy.priority = "fallback";
  }
}
```

**Learning sources**:
- Recovery success/failure rates per strategy
- Time-to-recovery per strategy
- Messages generated before next stall
- User engagement after recovery (did they take over?)
- Task completion rates post-recovery

### 3.5 Meta-Cognitive Loop

The system periodically reflects on its own performance:

```
Every 5 minutes (or per session milestone):
  
  1. ANALYZE: "How am I doing managing this session?"
     - Recovery frequency increasing? → Adjust stallTimeoutMs
     - Always same stall pattern? → Pre-emptive intervention
     - User keeps taking over? → Recovery too aggressive
     
  2. ADAPT: "What should I change?"
     - Increase timeouts for deep-thinking sessions
     - Decrease timeouts for simple tasks
     - Switch recovery strategies
     
  3. PREDICT: "What's coming next?"
     - Likely to hit token limit? → Proactive compaction
     - Many todos remaining? → Prepare nudge sequence
     - Complex task ahead? → Increase patience
```

---

## 4. Target Architecture (v7.0)

### 4.1 Module Overview

```
index.ts                    Event router, lifecycle coordinator
├── autonomous-core.ts      NEW: Intent understanding, goal tracking
├── predictive-engine.ts    NEW: Stall prediction, proactive intervention
├── adaptive-recovery.ts    NEW: Strategy selection, learning system
├── strategy-pool.ts        NEW: Recovery strategy definitions + effectiveness
├── meta-cognition.ts       NEW: Self-monitoring, parameter adaptation
├── session-orchestrator.ts NEW: Multi-session coordination
├── ai-advisor.ts           EXISTING: Heuristic + AI analysis (enhanced)
├── recovery.ts             EXISTING: Core recovery (enhanced with strategies)
├── nudge.ts                EXISTING: Idle nudging (context-aware)
├── compaction.ts           EXISTING: Emergency compaction
├── review.ts               EXISTING: Completion review
├── terminal.ts             EXISTING: Terminal UI
├── status-file.ts          EXISTING: Status persistence
└── shared.ts               EXISTING: Types, utilities
```

### 4.2 New Module: Autonomous Core

**Purpose**: Understand session intent and track progress toward goals.

```typescript
// src/autonomous-core.ts

interface TaskGraph {
  root: TaskNode;
  nodes: Map<string, TaskNode>;
}

interface TaskNode {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "blocked" | "completed";
  dependencies: string[];
  estimatedEffort: number; // minutes
  actualEffort: number;
  complexity: number; // 1-10
  domain: string;
  parentId?: string;
  subtasks: string[];
}

interface SessionIntent {
  primaryGoal: string;
  taskGraph: TaskGraph;
  currentTaskId: string;
  sessionStartTime: number;
  estimatedTotalTime: number;
  confidence: number; // How well do we understand the intent?
}

export function createAutonomousCore(deps: AutonomousCoreDeps) {
  return {
    // Extract intent from session context
    async extractIntent(sessionId: string): Promise<SessionIntent>;
    
    // Update task progress based on activity
    async updateTaskProgress(sessionId: string, activity: ActivityEvent): Promise<void>;
    
    // Get current focus recommendation
    getCurrentFocus(sessionId: string): FocusRecommendation;
    
    // Check if session is on track
    isOnTrack(sessionId: string): HealthStatus;
    
    // Suggest task decomposition if needed
    suggestDecomposition(sessionId: string): TaskNode[];
  };
}
```

**Intent Extraction Pipeline**:
1. **Parse initial prompt** → Extract primary goal
2. **Analyze todo structure** → Build task hierarchy
3. **Monitor tool usage** → Infer current subtask
4. **Track file changes** → Map to task progress
5. **Reasoning analysis** → Understand approach/mindset

### 4.3 New Module: Predictive Engine

**Purpose**: Predict stalls before they happen and intervene proactively.

```typescript
// src/predictive-engine.ts

interface StallPrediction {
  probability: number;        // 0-1
  estimatedTimeToStall: number; // milliseconds
  predictedPattern: string;   // e.g., "reasoning-loop"
  confidence: number;         // 0-1
  contributingFactors: string[];
}

interface ProactiveIntervention {
  type: "guidance" | "nudge" | "compaction" | "timeout_adjustment";
  message?: string;
  newTimeoutMs?: number;
  triggerTime: number;        // When to trigger (absolute)
}

export function createPredictiveEngine(deps: PredictiveEngineDeps) {
  return {
    // Analyze session state and predict stall
    predictStall(sessionId: string): StallPrediction;
    
    // Generate proactive intervention based on prediction
    generateIntervention(prediction: StallPrediction): ProactiveIntervention;
    
    // Execute intervention at appropriate time
    scheduleIntervention(sessionId: string, intervention: ProactiveIntervention): void;
    
    // Update prediction models with actual outcomes
    learn(sessionId: string, prediction: StallPrediction, actualOutcome: StallOutcome): void;
  };
}
```

**Prediction Signals**:

| Signal | Weight | Description |
|--------|--------|-------------|
| Token velocity delta | High | Decreasing tokens/sec indicates slowing progress |
| Reasoning repetition | High | Similar reasoning text patterns detected |
| Tool failure rate | High | Increasing tool call failures |
| Time since progress | Medium | Absolute time without meaningful progress |
| Context utilization | Medium | % of context window used |
| Task complexity | Low | Complex tasks naturally take longer |
| Historical pattern match | High | Similar sessions stalled at this point |

**Prediction Model**:
```typescript
function calculateStallProbability(session: SessionState): number {
  const features = {
    tokenVelocityDelta: calculateTokenVelocityDelta(session),
    reasoningRepetition: detectReasoningRepetition(session),
    toolFailureRate: calculateToolFailureRate(session),
    timeSinceProgress: Date.now() - session.lastProgressAt,
    contextUtilization: session.estimatedTokens / session.contextLimit,
    historicalPatternMatch: matchHistoricalPattern(session),
  };
  
  // Weighted ensemble
  return sigmoid(
    weights.tokenVelocityDelta * features.tokenVelocityDelta +
    weights.reasoningRepetition * features.reasoningRepetition +
    weights.toolFailureRate * features.toolFailureRate +
    weights.timeSinceProgress * normalizeTime(features.timeSinceProgress) +
    weights.contextUtilization * features.contextUtilization +
    weights.historicalPatternMatch * features.historicalPatternMatch
  );
}
```

### 4.4 New Module: Adaptive Recovery

**Purpose**: Select and execute the best recovery strategy based on context.

```typescript
// src/adaptive-recovery.ts

interface RecoveryStrategy {
  id: string;
  name: string;
  description: string;
  applicablePatterns: string[];        // Which stall patterns this handles
  priority: "primary" | "secondary" | "fallback";
  effectiveness: number;               // 0-1, learned over time
  execution: (sessionId: string, context: RecoveryContext) => Promise<RecoveryResult>;
}

interface RecoveryContext {
  sessionState: SessionState;
  intent: SessionIntent;
  stallPattern: string;
  prediction: StallPrediction;
  recentMessages: Message[];
  todoContext: Todo[];
  failureHistory: FailureEvent[];
}

export function createAdaptiveRecovery(deps: AdaptiveRecoveryDeps) {
  const strategies: RecoveryStrategy[] = [
    gentleGuidanceStrategy,
    directInterventionStrategy,
    contextCompactionStrategy,
    taskRefocusStrategy,
    creativeBreakStrategy,
    externalResourceStrategy,
  ];
  
  return {
    // Select best strategy for current situation
    selectStrategy(context: RecoveryContext): RecoveryStrategy;
    
    // Execute selected strategy
    executeStrategy(sessionId: string, strategy: RecoveryStrategy): Promise<RecoveryResult>;
    
    // Learn from outcome
    learn(strategyId: string, outcome: RecoveryOutcome): void;
    
    // Get strategy effectiveness report
    getEffectivenessReport(): StrategyReport;
  };
}
```

**Built-in Strategies**:

1. **Gentle Guidance** (primary for reasoning loops)
   - Don't abort, send suggestion message
   - "You've been analyzing for 2 minutes. Consider testing your hypothesis."

2. **Direct Intervention** (primary for tool failures)
   - Abort + specific error-focused continue
   - "The last grep failed. Try: grep -r 'pattern' --include='*.ts'"

3. **Context Compaction** (primary for context bloat)
   - Compact + refocus message
   - "Context is getting large. Compact and continue with [current task]."

4. **Task Refocus** (primary for todo overwhelm)
   - Abort + single-task focus
   - "You have 5 pending tasks. Let's focus only on: [top task]"

5. **Creative Break** (secondary for repeated failures)
   - Abort + suggest different approach
   - "This approach isn't working. Try: [alternative based on codebase]"

6. **External Resource** (fallback for knowledge gaps)
   - Abort + suggest documentation/external help
   - "This requires knowledge of [topic]. Check: [relevant docs]"

### 4.5 New Module: Meta-Cognition

**Purpose**: The system monitors and improves itself.

```typescript
// src/meta-cognition.ts

interface MetaCognitiveState {
  // Session-level
  interventionFrequency: number;       // How often we're intervening
  interventionEffectiveness: number;   // Success rate
  userOverrideRate: number;           // How often user takes over
  
  // System-level
  globalRecoveryRate: number;
  averageTimeToCompletion: number;
  strategyPerformance: Map<string, number>;
  parameterEffectiveness: Map<string, number>;
}

interface ParameterAdaptation {
  parameter: string;                   // e.g., "stallTimeoutMs"
  currentValue: number | string | boolean;
  suggestedValue: number | string | boolean;
  reason: string;
  confidence: number;
}

export function createMetaCognition(deps: MetaCognitionDeps) {
  return {
    // Periodic self-reflection
    reflect(sessionId: string): Reflection;
    
    // Suggest parameter adaptations
    suggestAdaptations(sessionId: string): ParameterAdaptation[];
    
    // Apply adaptation (with approval or auto-apply)
    applyAdaptation(sessionId: string, adaptation: ParameterAdaptation): void;
    
    // Generate performance report
    generateReport(timeRange: TimeRange): MetaCognitiveReport;
    
    // Detect systemic issues
    detectSystemicIssues(): SystemicIssue[];
  };
}
```

**Self-Adaptation Examples**:

```typescript
// If recovery frequency > 3 per 10 minutes, increase patience
if (interventionFrequency > 0.3) {
  adaptations.push({
    parameter: "stallTimeoutMs",
    currentValue: config.stallTimeoutMs,
    suggestedValue: config.stallTimeoutMs * 1.5,
    reason: "Too many recoveries. Session may need more time.",
    confidence: 0.8
  });
}

// If always same stall pattern, enable pre-emptive intervention
if (dominantPattern.frequency > 0.7) {
  adaptations.push({
    parameter: "predictiveIntervention",
    currentValue: false,
    suggestedValue: true,
    reason: `Frequent ${dominantPattern.name} detected. Enable proactive prevention.`,
    confidence: 0.85
  });
}
```

---

## 5. Enhanced Existing Modules

### 5.1 AI Advisor Enhancement

**Current**: Advises on abort/wait/continue.  
**Enhanced**: Full strategic planning + custom prompt generation.

```typescript
// Enhanced AIAdvice
interface AIAdvice {
  action: "abort" | "wait" | "continue" | "compact" | "guide" | "refocus";
  confidence: number;
  reasoning: string;
  
  // NEW: Generated content
  customPrompt: string;           // AI-written recovery message
  suggestedStrategy: string;      // Which recovery strategy to use
  suggestedTimeout: number;       // Adjust stall timeout
  
  // NEW: Predictive
  predictedOutcome: string;       // "Will likely succeed with this approach"
  riskAssessment: string;         // "Low risk - gentle guidance"
  
  // NEW: Contextual
  contextSummary: string;
  nextSteps: string[];           // "1. Fix auth bug, 2. Update tests"
}
```

### 5.2 Recovery Module Enhancement

**Current**: Abort + continue with generic message.  
**Enhanced**: Strategy selection + adaptive execution.

```typescript
// Enhanced recovery flow
async function recover(sessionId: string) {
  const context = await buildRecoveryContext(sessionId);
  
  // NEW: Get AI advice with strategy recommendation
  const advice = await aiAdvisor.getAdvice(context);
  
  // NEW: Select best strategy based on advice
  const strategy = adaptiveRecovery.selectStrategy({
    ...context,
    advice
  });
  
  // NEW: Execute strategy
  const result = await adaptiveRecovery.executeStrategy(sessionId, strategy);
  
  // NEW: Learn from outcome
  adaptiveRecovery.learn(strategy.id, {
    success: result.success,
    timeToRecovery: result.duration,
    messagesUntilNextStall: result.messagesUntilNextStall
  });
}
```

### 5.3 Nudge Module Enhancement

**Current**: Generic "continue working" message.  
**Enhanced**: Context-aware, task-specific nudges.

```typescript
// Enhanced nudge with intent awareness
function buildNudge(sessionId: string): string {
  const intent = autonomousCore.getIntent(sessionId);
  const focus = autonomousCore.getCurrentFocus(sessionId);
  
  return `You're working on "${intent.primaryGoal}". 
    Current focus: ${focus.taskDescription}.
    ${focus.hint || "Keep going!"}`;
}
```

---

## 6. Multi-Session Orchestration (v7.5)

For complex tasks requiring multiple sessions:

```typescript
// Session orchestration
interface OrchestrationPlan {
  sessions: SessionConfig[];
  dependencies: DependencyGraph;
  checkpoints: Checkpoint[];
  rollbackStrategy: RollbackConfig;
}

interface SessionConfig {
  id: string;
  purpose: string;
  model: string;
  contextBudget: number;
  parentSession?: string;
}

// Example: Large refactoring
const plan: OrchestrationPlan = {
  sessions: [
    { id: "analysis", purpose: "Analyze codebase and plan refactoring" },
    { id: "auth", purpose: "Refactor auth module", parentSession: "analysis" },
    { id: "tests", purpose: "Update tests for auth", parentSession: "auth" },
    { id: "integration", purpose: "Integration testing", parentSession: "tests" }
  ],
  dependencies: {
    "auth": ["analysis"],
    "tests": ["auth"],
    "integration": ["tests"]
  }
};
```

**Orchestrator responsibilities**:
- Start sessions in dependency order
- Transfer context between sessions
- Monitor all sessions simultaneously
- Coordinate handoffs at checkpoints
- Handle failures with rollback

---

## 7. Data & Learning Pipeline

### 7.1 Recovery Effectiveness Database

```typescript
// Stored in ~/.opencode/auto-continue/learning.db

interface RecoveryRecord {
  id: string;
  timestamp: number;
  sessionId: string;
  
  // What happened
  stallPattern: string;
  recoveryStrategy: string;
  customPrompt: string;
  
  // Context
  tokenCount: number;
  sessionAge: number;
  todoCount: number;
  taskComplexity: number;
  
  // Outcome
  success: boolean;
  timeToRecovery: number;
  messagesUntilNextStall: number;
  userTookOver: boolean;
  taskCompleted: boolean;
  
  // Derived
  effectiveness: number; // Calculated score 0-1
}
```

### 7.2 Learning Loop

```
[Recovery Executed]
        │
        ▼
[Record Outcome] ──► Store in local DB
        │
        ▼
[Update Strategy Effectiveness]
        │
        ▼
[Periodic Model Retraining]
        │
        ▼
[Update Default Parameters]
        │
        ▼
[Better Recovery Next Time]
```

### 7.3 Anonymous Telemetry (Opt-in)

With user consent, aggregate statistics help improve the system:
- Stall pattern frequencies
- Recovery strategy effectiveness
- Average session completion times
- Common failure modes

**Privacy**: No session content, file names, or code sent. Only patterns and metrics.

---

## 8. Implementation Roadmap

### Phase 1: Foundation (v7.0) — 4 weeks
- [ ] **Autonomous Core Module**
  - Intent extraction from prompts
  - Task graph construction from todos
  - Progress tracking
- [ ] **Enhanced AI Advisor**
  - Strategy recommendation
  - Custom prompt generation
  - Context-aware advice
- [ ] **Strategy Pool**
  - Define 6 recovery strategies
  - Basic effectiveness tracking
- [ ] **Integration**
  - Wire into existing recovery flow
  - Backward compatibility

### Phase 2: Prediction (v7.1) — 3 weeks
- [ ] **Predictive Engine**
  - Token velocity monitoring
  - Pattern detection
  - Stall probability calculation
- [ ] **Proactive Intervention**
  - Guidance messages before stall
  - Timeout adjustments
  - Pre-emptive compaction suggestions
- [ ] **Learning System**
  - Outcome recording
  - Strategy effectiveness updates
  - Parameter adaptation

### Phase 3: Self-Improvement (v7.2) — 3 weeks
- [ ] **Meta-Cognition**
  - Self-reflection loops
  - Parameter auto-adaptation
  - Performance reports
- [ ] **Advanced Strategies**
  - Creative break strategy
  - External resource strategy
  - Multi-step recovery sequences
- [ ] **Optimization**
  - Strategy pool optimization
  - Prediction model tuning
  - Historical pattern matching

### Phase 4: Orchestration (v7.5) — 4 weeks
- [ ] **Session Orchestrator**
  - Multi-session plans
  - Dependency management
  - Context transfer
- [ ] **Checkpoint System**
  - Save/restore session state
  - Rollback capabilities
  - Resume from checkpoint
- [ ] **Advanced Workflows**
  - Parallel session execution
  - Result aggregation
  - Cross-session learning

### Phase 5: Ecosystem (v8.0) — 6 weeks
- [ ] **Plugin Ecosystem**
  - Custom strategy plugins
  - Third-party integrations
  - Community strategy sharing
- [ ] **Cloud Learning**
  - Federated learning across users
  - Global strategy optimization
  - Anonymized pattern database
- [ ] **Advanced AI**
  - Fine-tuned models for session management
  - Domain-specific advisors
  - Natural language goal specification

---

## 9. Configuration

### New Configuration Options

```json
{
  "autonomy": {
    "level": "adaptive",           // "basic" | "adaptive" | "proactive" | "full"
    "intentExtraction": true,      // Enable goal understanding
    "predictiveIntervention": true, // Enable pre-stall prevention
    "learningEnabled": true,       // Enable strategy learning
    "metaCognition": true,         // Enable self-monitoring
    "strategyPool": [              // Active strategies
      "gentle-guidance",
      "direct-intervention", 
      "context-compaction",
      "task-refocus"
    ],
    "predictionThreshold": 0.7,    // Probability threshold for proactive intervention
    "learningRate": 0.3,           // How quickly to update strategy effectiveness
    "reflectionIntervalMs": 300000 // 5 minutes between self-reflections
  },
  "orchestration": {
    "enabled": false,              // Multi-session orchestration
    "maxConcurrentSessions": 3,
    "autoCheckpoint": true,
    "checkpointIntervalMs": 600000 // 10 minutes
  }
}
```

### Autonomy Levels

| Level | Description | Features |
|-------|-------------|----------|
| **basic** | Current behavior | Reactive recovery only |
| **adaptive** | Smart recovery | Strategy selection + learning |
| **proactive** | Predictive | Adaptive + stall prediction + guidance |
| **full** | Autonomous | Proactive + meta-cognition + self-improvement |

---

## 10. Success Metrics

### Key Performance Indicators

| Metric | Current (v6.x) | Target (v7.0) | Target (v7.5) |
|--------|---------------|---------------|---------------|
| Recovery success rate | ~65% | 80% | 90% |
| Average recovery time | 45s | 20s | 10s |
| Stall prevention rate | 0% | 30% | 60% |
| User override rate | ~40% | 20% | 10% |
| Task completion rate | ~70% | 85% | 95% |
| Session autonomy time | 60% | 80% | 95% |

**Session Autonomy Time**: Percentage of session time where AI works without human intervention.

---

## 11. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Over-intervention (annoying user) | High | Configurable autonomy levels, easy disable, user feedback loop |
| Wrong predictions | Medium | Conservative thresholds, fallbacks to reactive mode, learning |
| Performance overhead | Medium | Efficient signal processing, async analysis, optional features |
| Privacy concerns | High | All learning is local-only, telemetry is opt-in and anonymous |
| Complexity explosion | High | Modular design, feature flags, gradual rollout |
| Strategy conflicts | Low | Clear priority hierarchy, AI advisor arbitration |

---

## 12. Backward Compatibility

**Guarantee**: All v6.x configurations and behaviors remain valid.

- New features are **opt-in** via `autonomy.level` setting
- Default level is `adaptive` (not `proactive` or `full`)
- All new modules are additive — none replace existing modules
- Existing hooks and APIs unchanged
- Migration path: v6.x → v7.0 adaptive → v7.1 proactive → v7.2 full

---

## 13. Conclusion

The Auto-Continue Vision transforms the plugin from a **reactive safety net** into a **proactive AI co-pilot**. By understanding session intent, predicting problems, learning from outcomes, and continuously improving, the system maximizes autonomous execution time while minimizing user intervention.

**The ultimate goal**: Open a session, state your goal, and let the AI manage itself to completion — with the auto-continue plugin serving as the intelligent orchestrator that keeps everything on track.

---

## Appendix A: Example Scenarios

### Scenario 1: Reasoning Loop Prevention

**Before (v6.x)**:
```
[AI thinking deeply for 3 minutes]
[STALL DETECTED after 180s]
[RECOVER: abort + "Please continue"]
[AI starts thinking again...]
```

**After (v7.0 proactive)**:
```
[AI thinking for 90s]
[PREDICTION: 85% chance of reasoning loop in 30s]
[PROACTIVE: "You've been analyzing for 90s. Consider writing 
            a quick test to validate your hypothesis."]
[AI: "Good idea, let me try that..."]
[AI runs test, gets feedback, continues productively]
[No stall!]
```

### Scenario 2: Context-Aware Recovery

**Before**:
```
[AI stuck on API integration]
[RECOVER: abort + generic "Please continue"]
[AI continues struggling]
```

**After**:
```
[AI stuck on API integration - 3rd tool call failure]
[RECOVER: strategy="direct-intervention"]
[MESSAGE: "The API calls keep failing with 401. Check if 
           you need to refresh the auth token first. 
           Try: curl -H 'Authorization: Bearer ...'"]
[AI: "Ah, the token expired! Let me refresh it..."]
[Success!]
```

### Scenario 3: Self-Improving System

**Week 1**: System learns that "reasoning-loop" stalls in "refactoring" tasks respond best to "gentle-guidance" strategy.

**Week 2**: System automatically prefers "gentle-guidance" for refactoring tasks, reducing recovery time from 45s to 15s.

**Week 3**: System starts predicting reasoning loops 60 seconds before they happen, preventing 70% of them entirely.

---

## Appendix B: API Reference

### New Exports

```typescript
// Main module exports
export { sendCustomPrompt } from "./shared.js";
export { createAutonomousCore } from "./autonomous-core.js";
export { createPredictiveEngine } from "./predictive-engine.js";
export { createAdaptiveRecovery } from "./adaptive-recovery.js";
export { createMetaCognition } from "./meta-cognition.js";

// Types
export type { 
  SessionIntent, 
  TaskGraph, 
  StallPrediction,
  RecoveryStrategy,
  MetaCognitiveState 
} from "./types.js";
```

### Usage Example

```typescript
import { AutoForceResumePlugin } from "opencode-auto-continue";

// In opencode.json
{
  "plugin": [
    ["opencode-auto-continue", {
      "autonomy": {
        "level": "proactive",
        "intentExtraction": true,
        "predictiveIntervention": true,
        "learningEnabled": true,
        "metaCognition": true
      }
    }]
  ]
}
```

---

*This document is a living design. As we implement each phase, we'll update with learnings and refine the approach.*
