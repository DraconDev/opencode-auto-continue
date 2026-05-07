# Autonomous Session Lifecycle Architecture

**Status**: Design Document  
**Version**: 1.0  
**Related**: VISION-v7.0.md  

---

## 1. Session State Machine (Enhanced)

```
                    ┌─────────────┐
                    │   CREATED   │
                    └──────┬──────┘
                           │ session.created
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                      INTENT EXTRACTION                        │
│  Parse prompt → Build task graph → Identify current focus    │
│  Confidence check: Low confidence → Ask user for clarification│
└──────────────────────────────────────────────────────────────┘
                           │
                           ▼
                    ┌─────────────┐
         ┌─────────│   PLANNING  │◄─────────┐
         │         └──────┬──────┘          │
         │                │ plan detected   │
         │                ▼                 │
         │    ┌───────────────────────┐     │
         │    │    PREDICTIVE GUARD   │     │
         │    │ Monitor for planning- │     │
         │    │ induced stalls (>60s) │     │
         │    └───────────┬───────────┘     │
         │                │ stall predicted │
         │                ▼                 │
         │    ┌───────────────────────┐     │
         └────┤   PROACTIVE NUDGE     ├─────┘
              │ "You have a plan. Time│
              │  to start executing." │
              └───────────┬───────────┘
                          │ execution begins
                          ▼
                    ┌─────────────┐
        ┌───────────│    BUSY     │───────────┐
        │           └──────┬──────┘           │
        │                  │ progress events   │
        │                  ▼                   │
        │    ┌───────────────────────┐        │
        │    │  PREDICTIVE ENGINE    │        │
        │    │ Continuously monitors:│        │
        │    │ • Token velocity      │        │
        │    │ • Reasoning patterns  │        │
        │    │ • Tool failure rates  │        │
        │    │ • Context utilization │        │
        │    └───────────┬───────────┘        │
        │                │                     │
        │    ┌───────────┴───────────┐        │
        │    │   Prediction Result   │        │
        │    ├───────────────────────┤        │
        │    │ probability: 0.78     │        │
        │    │ pattern: "reasoning"  │        │
        │    │ timeToStall: 45s      │        │
        │    └───────────┬───────────┘        │
        │                │                     │
        │    ┌───────────┴───────────┐        │
        │    │   Intervention?       │        │
        │    │ threshold: 0.7        │        │
        │    │ 0.78 >= 0.7 → YES     │        │
        │    └───────────┬───────────┘        │
        │                │ send guidance      │
        │                ▼                    │
        │    ┌───────────────────────┐       │
        └────┤   PROACTIVE GUIDE    │       │
             │ "Consider testing     │       │
             │  your hypothesis..."  │       │
             └───────────┬───────────┘       │
                         │                   │
        ┌────────────────┼────────────────┐  │
        │                │                │  │
        │    ┌───────────┴───────────┐   │  │
        │    │   Still no progress   │   │  │
        │    │ after stallTimeoutMs  │   │  │
        │    └───────────┬───────────┘   │  │
        │                │               │  │
        │                ▼               │  │
        │    ┌───────────────────────┐   │  │
        │    │    STALL DETECTED     │   │  │
        │    │ Pattern: "reasoning"  │   │  │
        │    │ Confidence: 0.92      │   │  │
        │    └───────────┬───────────┘   │  │
        │                │               │  │
        │                ▼               │  │
        │    ┌───────────────────────┐   │  │
        │    │  ADAPTIVE RECOVERY    │   │  │
        │    │ Select strategy based:│   │  │
        │    │ • Stall pattern       │   │  │
        │    │ • Session intent      │   │  │
        │    │ • Historical success  │   │  │
        │    └───────────┬───────────┘   │  │
        │                │               │  │
        │    ┌───────────┴───────────┐   │  │
        │    │ Execute strategy:     │   │  │
        │    │ "gentle-guidance"     │   │  │
        │    │ (effectiveness: 0.87) │   │  │
        │    └───────────┬───────────┘   │  │
        │                │               │  │
        │                ▼               │  │
        │    ┌───────────────────────┐   │  │
        └────┤    RECOVERING        │   │  │
             │ abort + custom prompt │   │  │
             └───────────┬───────────┘   │  │
                         │               │  │
                         ▼               │  │
                  ┌─────────────┐        │  │
                  │   IDLE      │◄───────┘  │
                  └──────┬──────┘           │
                         │                   │
        ┌────────────────┼────────────────┐  │
        │                │                │  │
        │    ┌───────────┴───────────┐   │  │
        │    │  Recovery successful? │   │  │
        │    └───────────┬───────────┘   │  │
        │                │               │  │
        │      ┌─────────┴─────────┐     │  │
        │      │ YES               │ NO  │  │
        │      │                   │     │  │
        │      ▼                   ▼     │  │
        │ ┌─────────┐        ┌──────────┐│  │
        │ │ LEARN   │        │ BACKOFF  ││  │
        │ │ Record  │        │ Increase ││  │
        │ │ outcome │        │ timeout  ││  │
        │ └────┬────┘        └────┬─────┘│  │
        │      │                  │      │  │
        └──────┼──────────────────┼──────┘  │
               │                  │         │
               └──────────────────┘         │
                          │                │
                          ▼                │
                   ┌─────────────┐         │
                   │    BUSY     │◄────────┘
                   └─────────────┘
                          │
                          │ [Loop continues]
                          │
                          ▼
                   ┌─────────────┐
              ┌────┤   todos     │────┐
              │    │  updated    │    │
              │    └──────┬──────┘    │
              │           │           │
              │  ┌────────┴────────┐  │
              │  │ All completed?  │  │
              │  └────────┬────────┘  │
              │           │           │
              │     ┌─────┴─────┐     │
              │     │ YES       │ NO  │
              │     │           │     │
              │     ▼           ▼     │
              │ ┌────────┐  ┌────────┐│
              │ │ REVIEW │  │ NUDGE  ││
              │ │ FLOW   │  │ FLOW   ││
              │ └───┬────┘  └───┬────┘│
              │     │           │     │
              └─────┴───────────┴─────┘
                          │
                          ▼
                   ┌─────────────┐
              ┌────┤   session   │────┐
              │    │   ended     │    │
              │    └──────┬──────┘    │
              │           │           │
              │     ┌─────┴─────┐     │
              │     │ COMPACT   │     │
              │     │ & ARCHIVE │     │
              │     └─────┬─────┘     │
              │           │           │
              └───────────┼───────────┘
                          ▼
                   ┌─────────────┐
                   │   CLEANUP   │
                   │  (terminal, │
                   │   status)   │
                   └─────────────┘
```

---

## 2. State Definitions

### Core States

| State | Description | Entry Condition | Exit Condition |
|-------|-------------|-----------------|----------------|
| **CREATED** | Session initialized | `session.created` event | Intent extraction complete |
| **PLANNING** | Model is generating a plan | Plan text detected in messages | Execution begins (tool/file activity) |
| **BUSY** | Model actively working | `session.status(busy)` or progress events | `session.status(idle)` or stall detected |
| **RECOVERING** | Recovery in progress | Stall timer fires | Recovery completes (success/failure) |
| **IDLE** | Model stopped generating | `session.status(idle)` | `session.status(busy)` or nudge sent |
| **COMPACTING** | Context compaction running | Token limit error or proactive compaction | Compaction completes |

### Sub-States (Predictive Layer)

| Sub-State | Description | Trigger |
|-----------|-------------|---------|
| **MONITORING** | Predictive engine watching for stall signals | Always active during BUSY |
| **PREDICTED_STALL** | High probability stall detected | Prediction threshold exceeded |
| **PROACTIVE_GUIDANCE** | Guidance sent before stall | Predicted stall + intervention triggered |
| **STRATEGY_SELECTION** | Choosing recovery strategy | Stall detected |
| **LEARNING** | Recording outcome for future improvement | Recovery completes |

---

## 3. Intent Extraction Flow

```
[User Prompt]
    │
    ▼
[Parse Prompt]
    │
    ├──► Extract: Primary goal
    │    "Refactor authentication module"
    │
    ├──► Identify: Domain
    │    → "refactoring"
    │
    ├──► Detect: Task indicators
    │    → "auth", "refactor", "module"
    │    → Look for existing auth code
    │    → Identify related files
    │
    └──► Build: Initial task graph
         │
         ▼
    ┌───────────────────────┐
    │     TASK GRAPH        │
    │                       │
    │  [Refactor Auth]      │
    │       │               │
    │  ┌────┴────┐          │
    │  ▼         ▼          │
    │ [Analyze] [Plan]      │
    │  │         │          │
    │  ▼         ▼          │
    │ [Test]   [Impl]       │
    │            │          │
    │         ┌──┴──┐       │
    │         ▼     ▼       │
    │      [JWT]  [OAuth]   │
    │                       │
    └───────────────────────┘
         │
         ▼
[Confidence Check]
    │
    ├──► Confidence >= 0.7
    │    → Proceed to PLANNING/BUSY
    │
    └──► Confidence < 0.7
         → Ask user: "I understand you want to refactor auth. 
                      Should I focus on JWT, OAuth, or both?"
         → Wait for clarification
         → Refine task graph
```

---

## 4. Predictive Intervention Decision Tree

```
[During BUSY state - every 5 seconds]
    │
    ▼
[Collect Signals]
    │
    ├──► Token velocity (tokens/sec over last 30s)
    ├──► Reasoning repetition score
    ├──► Tool success/failure rate
    ├──► Time since last progress
    ├──► Context utilization %
    └──► Historical pattern match
    │
    ▼
[Calculate Stall Probability]
    │
    ├──► probability < 0.5
    │    → Continue monitoring
    │
    ├──► 0.5 <= probability < 0.7
    │    → Increase monitoring frequency
    │    → Pre-load recovery strategy
    │
    └──► probability >= 0.7
         │
         ▼
    [Generate Intervention]
         │
         ├──► pattern = "reasoning-loop"
         │    → Send: "You've been analyzing for {time}. 
         │            Consider testing your hypothesis."
         │
         ├──► pattern = "tool-failure"
         │    → Send: "The {tool} call keeps failing. 
         │            Check: {suggested_fix}"
         │
         ├──► pattern = "context-bloat"
         │    → Trigger proactive compaction
         │    → Send: "Let me compact context. Continue after."
         │
         └──► pattern = "api-delay"
              → Adjust timeout: +30s
              → Do NOT abort
              → Send: "Waiting for API. I'll be patient."
    │
    ▼
[Record Intervention]
    │
    ├──► Track: time, pattern, message
    └──► Set flag: proactiveInterventionSent
    │
    ▼
[Continue Monitoring]
    │
    └──► If stall still happens despite intervention
         → Log: "Proactive intervention failed"
         → Use adaptive recovery with strategy boost
```

---

## 5. Recovery Strategy Selection

```
[Stall Detected]
    │
    ▼
[Build Recovery Context]
    │
    ├──► Session intent & current task
    ├──► Stall pattern classification
    ├──► Recent messages (last 10)
    ├──► Tool failure history
    ├──► Token count & context utilization
    └──► Historical recovery outcomes
    │
    ▼
[Query Strategy Pool]
    │
    ├──► Filter: applicable strategies for this pattern
    │    Example: pattern="reasoning-loop"
    │    → [gentle-guidance, creative-break, task-refocus]
    │
    ├──► Score: effectiveness × recency × context fit
    │    gentle-guidance:  0.87 × 1.0 × 0.95 = 0.827
    │    creative-break:   0.72 × 0.9 × 0.80 = 0.518
    │    task-refocus:     0.65 × 1.0 × 0.70 = 0.455
    │
    └──► Select: highest score
         → gentle-guidance (0.827)
    │
    ▼
[Execute Strategy]
    │
    ├──► gentle-guidance:
    │    Abort? → NO (don't abort for reasoning loops)
    │    Message: "You've been thinking for {time}.
    │             Try writing a quick test to validate."
    │    Wait: 30s for response
    │
    └──► direct-intervention:
         Abort? → YES
         Message: "{specific_error}. Try: {fix}"
         Continue normally
    │
    ▼
[Monitor Outcome]
    │
    ├──► Success: Model resumes productive work
    │    → Record: strategy, timeToRecovery, pattern
    │    → Update effectiveness: +0.05
    │
    ├──► Partial: Model works briefly then stalls again
    │    → Record: strategy, timeToNextStall
    │    → Update effectiveness: +0.02
    │    → Flag: may need escalation
    │
    └──► Failure: Model doesn't recover
         → Record: strategy, failure reason
         → Update effectiveness: -0.10
         → Try next best strategy
         → After 3 failures: fallback to generic recovery
```

---

## 6. Learning Loop Integration

```
[Recovery Outcome Recorded]
    │
    ▼
[Update Strategy Effectiveness]
    │
    ├──► newEffectiveness = (old × (1 - α)) + (outcome × α)
    │    Where α = learningRate (default 0.3)
    │
    └──► Example:
         Old: 0.80, Outcome: 1.0 (success)
         New: (0.80 × 0.7) + (1.0 × 0.3) = 0.86
    │
    ▼
[Update Pattern Association]
    │
    ├──► Record: "reasoning-loop" + "gentle-guidance" = 0.86
    └──► If this is the best pairing, promote to primary
    │
    ▼
[Check for Parameter Adaptation]
    │
    ├──► If success rate < 0.5 for pattern:
    │    → Suggest: increase stallTimeoutMs for this domain
    │
    ├──► If proactive interventions working:
    │    → Suggest: lower prediction threshold (more aggressive)
    │
    └──► If user keeps overriding:
         → Suggest: decrease autonomy level
    │
    ▼
[Persist Learning]
    │
    └──► Save to: ~/.opencode/auto-continue/learning.db
```

---

## 7. Event Flow Summary

```
Event                        │ Action                          │ State Change
─────────────────────────────┼─────────────────────────────────┼─────────────────────
session.created              │ Initialize session              │ CREATED → PLANNING
                             │ Extract intent                  │
                             │ Build task graph                │
─────────────────────────────┼─────────────────────────────────┼─────────────────────
message.part (plan text)     │ Pause monitoring                │ → PLANNING
                             │ Start plan timer                │
─────────────────────────────┼─────────────────────────────────┼─────────────────────
message.part (tool/file)     │ Resume monitoring               │ PLANNING → BUSY
                             │ Clear planning flag             │
                             │ Update task progress            │
─────────────────────────────┼─────────────────────────────────┼─────────────────────
session.status (busy)        │ Start stall timer               │ → BUSY
                             │ Start predictive monitoring     │
                             │ Update terminal title           │
─────────────────────────────┼─────────────────────────────────┼─────────────────────
predictive.signal (high)     │ Generate intervention           │ BUSY → PREDICTED
                             │ Schedule proactive message      │
─────────────────────────────┼─────────────────────────────────┼─────────────────────
proactive.intervention       │ Send guidance                   │ PREDICTED → PROACTIVE
                             │ Record intervention             │
─────────────────────────────┼─────────────────────────────────┼─────────────────────
stall.timer fired            │ Classify stall pattern          │ BUSY → RECOVERING
                             │ Select recovery strategy        │
                             │ Execute strategy                │
─────────────────────────────┼─────────────────────────────────┼─────────────────────
recovery.success             │ Record outcome                  │ RECOVERING → IDLE
                             │ Update strategy effectiveness   │
                             │ Schedule nudge if needed        │
─────────────────────────────┼─────────────────────────────────┼─────────────────────
recovery.failure             │ Record failure                  │ RECOVERING → IDLE
                             │ Try next strategy               │
                             │ Apply backoff                   │
─────────────────────────────┼─────────────────────────────────┼─────────────────────
session.status (idle)        │ Clear timers                    │ → IDLE
                             │ Check todos                     │
                             │ Send nudge if pending           │
─────────────────────────────┼─────────────────────────────────┼─────────────────────
todo.updated (all done)      │ Trigger review                  │ → REVIEW
                             │ Debounce 500ms                  │
─────────────────────────────┼─────────────────────────────────┼─────────────────────
session.error (token limit)  │ Trigger compaction              │ BUSY → COMPACTING
                             │ Parse tokens                    │
─────────────────────────────┼─────────────────────────────────┼─────────────────────
session.compacted            │ Clear compacting flag           │ COMPACTING → IDLE
                             │ Reset token estimates           │
                             │ Send continue                   │
─────────────────────────────┼─────────────────────────────────┼─────────────────────
session.ended / deleted      │ Clean up all state              │ → CLEANUP
                             │ Persist learning                │
                             │ Clear terminal                  │
```

---

## 8. Multi-Session Coordination (v7.5)

```
[Orchestrator View]
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│                    SESSION POOL                              │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Analysis │  │  Auth    │  │  Tests   │  │   Docs   │   │
│  │ Session  │──►│ Session  │──►│ Session  │  │ Session  │   │
│  │          │  │          │  │          │  │          │   │
│  │ Status:  │  │ Status:  │  │ Status:  │  │ Status:  │   │
│  │ complete │  │  busy    │  │ pending  │  │ pending  │   │
│  │          │  │          │  │          │  │          │   │
│  │ Intent:  │  │ Intent:  │  │ Intent:  │  │ Intent:  │   │
│  │"Analyze  │  │"Refactor │  │"Write    │  │"Update  │   │
│  │ codebase"│  │ auth"    │  │ tests"   │  │ docs"    │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│                                                              │
│  Dependencies: Auth → Tests, Auth → Docs                    │
│  Parallel: Tests & Docs can run simultaneously              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
[Orchestrator Decisions]
    │
    ├──► Auth session stalls?
    │    → Analyze: Is it blocked on Analysis output?
    │    → If yes: Transfer analysis results
    │    → If no: Apply normal recovery
    │
    ├──► Auth session completes?
    │    → Trigger: Tests session (dependency met)
    │    → Trigger: Docs session (dependency met)
    │    → Transfer: Auth context to child sessions
    │
    └──► Multiple sessions stall simultaneously?
         → Prioritize by dependency order
         → Allocate recovery budget per session
         → Coordinate to avoid resource conflicts
```

---

## 9. Configuration-Driven Behavior

```typescript
// Autonomy level determines state machine complexity

const autonomyConfigs = {
  basic: {
    predictiveEngine: false,
    proactiveIntervention: false,
    adaptiveRecovery: false,
    learningEnabled: false,
    metaCognition: false,
    // Only reactive recovery
  },
  
  adaptive: {
    predictiveEngine: false,
    proactiveIntervention: false,
    adaptiveRecovery: true,        // Strategy selection
    learningEnabled: true,         // Record outcomes
    metaCognition: false,
  },
  
  proactive: {
    predictiveEngine: true,        // Stall prediction
    proactiveIntervention: true,   // Pre-stall guidance
    adaptiveRecovery: true,
    learningEnabled: true,
    metaCognition: true,           // Self-monitoring
  },
  
  full: {
    predictiveEngine: true,
    proactiveIntervention: true,
    adaptiveRecovery: true,
    learningEnabled: true,
    metaCognition: true,
    intentExtraction: true,        // Understand goals
    taskOrchestration: true,       // Multi-session
    autoDecomposition: true,       // Break down tasks
  }
};
```

---

## 10. Key Invariants

1. **Intent is always optional** — If intent extraction fails, system falls back to reactive mode
2. **Predictions never block** — If prediction engine is slow, continue with reactive recovery
3. **Learning is local-only** — No cloud dependencies for learning
4. **User can always override** — Any autonomous action can be interrupted by user
5. **Strategies degrade gracefully** — If best strategy fails, try next best, never crash
6. **State is recoverable** — If plugin crashes/restarts, session state can be reconstructed
7. **Privacy by default** — No session content leaves local machine

---

*This document defines the architectural foundation for autonomous session management. See VISION-v7.0.md for the high-level vision and ROADMAP.md for implementation phases.*
