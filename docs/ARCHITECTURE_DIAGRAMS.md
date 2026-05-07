# Auto-Continue Architecture Diagrams

**Status**: Visual Documentation  
**Version**: 1.0  
**Related**: VISION-v7.0.md, ARCHITECTURE.md  

---

## 1. System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         AUTO-CONTINUE v7.0                                   │
│                    AI That Drives AI Autonomously                            │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                              LAYER 3: STRATEGIC                              │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐           │
│  │ Session          │  │ Goal             │  │ Task             │           │
│  │ Orchestrator     │  │ Decomposer       │  │ Prioritizer      │           │
│  │ (v7.5)           │  │ (v7.5)           │  │ (v7.5)           │           │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘           │
│           │                     │                     │                      │
│           └─────────────────────┼─────────────────────┘                      │
│                                 ▼                                            │
│                    ┌──────────────────────┐                                  │
│                    │  Multi-Session       │                                  │
│                    │  Coordination        │                                  │
│                    └──────────────────────┘                                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              LAYER 2: TACTICAL                               │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      AUTONOMOUS CORE (v7.0)                          │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │   │
│  │  │ Intent       │  │ Task Graph   │  │ Progress     │              │   │
│  │  │ Extractor    │  │ Builder      │  │ Tracker      │              │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘              │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                   PREDICTIVE ENGINE (v7.1)                           │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │   │
│  │  │ Signal       │  │ Stall        │  │ Proactive    │              │   │
│  │  │ Collector    │  │ Predictor    │  │ Intervention │              │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘              │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                  ADAPTIVE RECOVERY (v7.0)                            │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │   │
│  │  │ Strategy     │  │ Pattern      │  │ Custom       │              │   │
│  │  │ Selector     │  │ Classifier   │  │ Prompt Gen   │              │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘              │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │              SELF-IMPROVING SYSTEM (v7.2)                            │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │   │
│  │  │ Learning     │  │ Pattern      │  │ Parameter    │              │   │
│  │  │ Database     │  │ Discovery    │  │ Adaptation   │              │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘              │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                META-COGNITION (v7.2)                                 │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │   │
│  │  │ Self-        │  │ Performance  │  │ Auto-        │              │   │
│  │  │ Reflection   │  │ Reports      │  │ Adaptation   │              │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘              │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            LAYER 1: OPERATIONAL                              │
│                                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ Recovery     │  │ Nudge        │  │ Compaction   │  │ Review       │   │
│  │ Module       │  │ Module       │  │ Module       │  │ Module       │   │
│  │ (enhanced)   │  │ (enhanced)   │  │ (existing)   │  │ (existing)   │   │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘   │
│                                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ Terminal     │  │ Status       │  │ AI           │  │ Shared       │   │
│  │ Module       │  │ File Module  │  │ Advisor      │  │ Utilities    │   │
│  │ (existing)   │  │ (existing)   │  │ (enhanced)   │  │ (existing)   │   │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         OPENCODE SDK INTERFACE                               │
│                                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ session.     │  │ message.     │  │ todo.        │  │ client.      │   │
│  │ status()     │  │ updated()    │  │ updated()    │  │ API          │   │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              DATA FLOW                                       │
│                    How Information Moves Through the System                  │
└─────────────────────────────────────────────────────────────────────────────┘

[User Prompt]
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│                    INTENT EXTRACTION                         │
│  Parse → Tokenize → Classify Domain → Extract Goals         │
│  Output: SessionIntent { goal, domain, complexity }         │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    TASK GRAPH BUILDER                        │
│  Todos → Dependencies → Hierarchy → Effort Estimates        │
│  Output: TaskGraph { nodes, edges, root }                   │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   SESSION STATE STORE                        │
│  SessionState { intent, taskGraph, progress, predictions }  │
└─────────────────────────┬───────────────────────────────────┘
                          │
         ┌────────────────┼────────────────┐
         │                │                │
         ▼                ▼                ▼
┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐
│  PREDICTIVE │  │   PROGRESS  │  │    RECOVERY CONTEXT │
│   ENGINE    │  │   TRACKER   │  │      BUILDER        │
│             │  │             │  │                     │
│ Input:      │  │ Input:      │  │ Input:              │
│ - Session   │  │ - Tool calls│  │ - Session state     │
│ - History   │  │ - File ops  │  │ - Stall pattern     │
│ - Signals   │  │ - Messages  │  │ - Recent messages   │
│             │  │             │  │ - Intent            │
│ Output:     │  │ Output:     │  │ Output:             │
│ - Prediction│  │ - Task %    │  │ - RecoveryContext   │
│ - Probability│ │ - Focus     │  │                     │
└──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘
       │                │                     │
       └────────────────┼─────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│              ADAPTIVE RECOVERY DECISION                      │
│  Context → Pattern Match → Strategy Select → Execute        │
│  Output: RecoveryResult { success, time, messages }         │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│              LEARNING DATABASE UPDATE                        │
│  Record → Calculate Effectiveness → Update Strategy         │
│  Output: Updated effectiveness scores                       │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│              META-COGNITION REFLECTION                       │
│  Analyze → Detect Issues → Suggest Adaptations → Apply      │
│  Output: Parameter changes, reports                         │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Recovery Flow Comparison

### Current (v6.x) - Reactive

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│   BUSY   │────►│  STALL   │────►│  DETECT  │────►│  RECOVER │
│          │     │  (180s)  │     │  (timer) │     │ (abort + │
│          │     │          │     │          │     │ generic) │
└──────────┘     └──────────┘     └──────────┘     └────┬─────┘
                                                        │
                                                        ▼
                                                  ┌──────────┐
                                                  │  IDLE    │
                                                  │          │
                                                  └──────────┘

Time: ──────────────────────────────────────────────────────────►
      0s        60s       120s      180s      185s      190s
                │                   │         │         │
                │                   │         │         └── Resume
                │                   │         └── Abort
                │                   └── Stall!
                └── Normal progress
```

### Vision (v7.0) - Adaptive

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│   BUSY   │────►│  INTENT  │────►│ ADAPTIVE │────►│ CUSTOM   │
│          │────►│  KNOWN   │────►│ STRATEGY │────►│ RECOVERY │
│          │     │          │     │ SELECT   │     │          │
└──────────┘     └──────────┘     └────┬─────┘     └────┬─────┘
                                       │                │
                                       │ Pattern:       │ Message:
                                       │ "tool-fail"    │ "Check 
                                       │                │ error..."
                                       │                │
                                       ▼                ▼
                                 ┌──────────┐     ┌──────────┐
                                 │ STRATEGY │────►│  IDLE    │
                                 │ "direct" │     │          │
                                 └──────────┘     └──────────┘

Time: ──────────────────────────────────────────────────────────►
      0s        60s       120s      180s      182s      185s
                │                   │         │         │
                │                   │         │         └── Resume
                │                   │         └── Specific message
                │                   └── Stall!
                └── Normal progress + intent tracking
```

### Vision (v7.1) - Proactive

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│   BUSY   │────►│ PREDICT  │────►│ PROACTIVE│────►│ CONTINUE │
│          │────►│  (85%)   │────►│ GUIDANCE │────►│ NORMAL   │
│          │     │          │     │          │     │          │
└──────────┘     └──────────┘     └────┬─────┘     └──────────┘
                                       │
                                       │ "Consider
                                       │  testing
                                       │  your idea"
                                       │
                                       ▼
                                 ┌──────────┐
                                 │   NO     │
                                 │  STALL!  │
                                 └──────────┘

Time: ──────────────────────────────────────────────────────────►
      0s        60s       120s      150s      180s      210s
                │                   │         │         │
                │                   │         │         └── Still working!
                │                   │         └── Guidance given
                │                   └── Prediction: 85% stall in 30s
                └── Normal progress + monitoring
```

---

## 4. Module Interaction Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        MODULE INTERACTIONS                                   │
└─────────────────────────────────────────────────────────────────────────────┘

                    ┌─────────────────────┐
                    │     index.ts        │
                    │   (Event Router)    │
                    └──────────┬──────────┘
                               │
           ┌───────────────────┼───────────────────┐
           │                   │                   │
           ▼                   ▼                   ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  AutonomousCore │  │ PredictiveEngine│  │Recovery Module  │
│                 │  │                 │  │                 │
│ • extractIntent │  │ • predictStall  │  │ • recover()     │
│ • buildTaskGraph│  │ • getSignals    │  │ • abort()       │
│ • trackProgress │  │ • intervene()   │  │ • continue()    │
└────────┬────────┘  └────────┬────────┘  └────────┬────────┘
         │                    │                    │
         │                    │                    │
         └────────────────────┼────────────────────┘
                              │
                              ▼
                    ┌─────────────────────┐
                    │   AdaptiveRecovery  │
                    │   (Strategy Pool)   │
                    │                     │
                    │ • selectStrategy()  │
                    │ • executeStrategy() │
                    │ • getEffectiveness()│
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
    ┌─────────────────┐ ┌──────────────┐ ┌─────────────────┐
    │  AIAdvisor      │ │  NudgeModule │ │  CompactionMod  │
    │                 │ │              │ │                 │
    │ • getAdvice()   │ │ • sendNudge()│ │ • forceCompact()│
    │ • classify()    │ │ • schedule() │ │ • verify()      │
    └─────────────────┘ └──────────────┘ └─────────────────┘
              │                │                │
              └────────────────┼────────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │  SelfImprovingSystem │
                    │   (Learning DB)      │
                    │                      │
                    │ • recordOutcome()   │
                    │ • updateStrategy()  │
                    │ • discoverPattern() │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │   MetaCognition     │
                    │                     │
                    │ • reflect()         │
                    │ • generateReport()  │
                    │ • adaptParams()     │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │  Terminal/StatusFile│
                    │                     │
                    │ • updateTitle()     │
                    │ • writeStatus()     │
                    │ • progressBar()     │
                    └─────────────────────┘
```

---

## 5. Learning Loop Visualization

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        LEARNING FEEDBACK LOOP                                │
└─────────────────────────────────────────────────────────────────────────────┘

    ┌──────────────┐
    │   SESSION    │
    │   STARTS     │
    └──────┬───────┘
           │
           ▼
    ┌──────────────┐
    │    BUSY      │
    │   WORKING    │
    └──────┬───────┘
           │
           ▼
    ┌──────────────┐     ┌──────────────────────┐
    │    STALL     │────►│  Recovery Strategy   │
    │  DETECTED    │     │  Selected:           │
    └──────┬───────┘     │  "gentle-guidance"   │
           │             └──────────┬───────────┘
           │                        │
           │                        ▼
           │             ┌──────────────────────┐
           │             │  Execute Strategy    │
           │             │  Abort? No           │
           │             │  Message: "Try..."   │
           │             └──────────┬───────────┘
           │                        │
           ▼                        ▼
    ┌──────────────┐     ┌──────────────────────┐
    │   OUTCOME    │     │  Record in Learning  │
    │   Recorded   │◄────│  Database:           │
    └──────┬───────┘     │  - Strategy used     │
           │             │  - Outcome: success  │
           │             │  - Time: 15s         │
           │             │  - Messages: 8       │
           │             └──────────────────────┘
           │
           ▼
    ┌──────────────┐
    │   UPDATE     │
    │  STRATEGY    │
    │ EFFECTIVENESS│
    └──────┬───────┘
           │
           │ New Effectiveness:
           │ "gentle-guidance" +
           │ "reasoning-loop" = 0.87
           │
           ▼
    ┌──────────────┐
    │   NEXT TIME  │
    │  SAME PATTERN│
    └──────┬───────┘
           │
           │ Strategy selection:
           │ "gentle-guidance" now
           │ ranked #1 (0.87)
           │
           ▼
    ┌──────────────┐
    │   FASTER     │
    │   BETTER     │
    │   RECOVERY   │
    └──────────────┘


Visual: Effectiveness Over Time
────────────────────────────────────────►
0.5 │                    ╱╲
    │                   ╱  ╲     ╱╲
0.6 │                  ╱    ╲   ╱  ╲
    │                 ╱      ╲ ╱    ╲
0.7 │    ╱╲          ╱        ╳      ╲
    │   ╱  ╲        ╱        ╱ ╲      ╲
0.8 │  ╱    ╲  ╱╲  ╱        ╱   ╲      ╲──
    │ ╱      ╲╱  ╲╱        ╱     ╲
0.9 │╱                  ╱╲╱       ╲
    │
1.0 ├───────────────────────────────────────
    Strategy learns and improves over sessions
```

---

## 6. Configuration-Driven Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    CONFIGURATION DRIVES BEHAVIOR                             │
└─────────────────────────────────────────────────────────────────────────────┘

User Configuration (opencode.json)
    │
    ├──► autonomy.level: "adaptive"
    │     │
    │     ├──► Intent Extraction: ON
    │     ├──► Adaptive Recovery: ON
    │     ├──► Learning System: ON
    │     ├──► Predictive Engine: OFF
    │     ├──► Meta-Cognition: OFF
    │     └──► Orchestration: OFF
    │
    ├──► strategyPool: ["gentle-guidance", "direct-intervention"]
    │     │
    │     └──► Only these strategies active
    │
    ├──► learning.enabled: true
    │     │
    │     └──► Record outcomes, update effectiveness
    │
    └──► predictive.enabled: false
          │
          └──► No proactive intervention

Resulting Architecture:
┌─────────────────────────────────────────┐
│  ON  │ AutonomousCore                   │
│  ON  │ AdaptiveRecovery                 │
│  ON  │ SelfImprovingSystem              │
│  OFF │ PredictiveEngine (not loaded)    │
│  OFF │ MetaCognition (not loaded)       │
│  OFF │ Orchestrator (not loaded)        │
└─────────────────────────────────────────┘

vs.

User Configuration (opencode.json)
    │
    └──► autonomy.level: "full"
          │
          └──► ALL modules loaded and active

Resulting Architecture:
┌─────────────────────────────────────────┐
│  ON  │ AutonomousCore                   │
│  ON  │ AdaptiveRecovery                 │
│  ON  │ SelfImprovingSystem              │
│  ON  │ PredictiveEngine                 │
│  ON  │ MetaCognition                    │
│  ON  │ Orchestrator                     │
└─────────────────────────────────────────┘
```

---

## 7. Event-Driven Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        EVENT-DRIVEN ARCHITECTURE                             │
└─────────────────────────────────────────────────────────────────────────────┘

OpenCode SDK Events:

session.created
    │
    ├──► AutonomousCore.extractIntent()
    ├──► SessionState initialized
    └──► StatusFile.write()

session.status(busy)
    │
    ├──► RecoveryModule.startTimer()
    ├──► PredictiveEngine.startMonitoring() [if enabled]
    └──► Terminal.updateTitle()

message.part.updated(text|tool|file)
    │
    ├──► RecoveryModule.resetTimer()
    ├──► AutonomousCore.trackProgress()
    ├──► PredictiveEngine.updateSignals() [if enabled]
    └──► StatusFile.write()

predictive.intervention [custom event]
    │
    ├──► PredictiveEngine.generateGuidance()
    ├──► sendCustomPrompt(guidance)
    └──► LearningDB.recordIntervention()

stall.timer.fired
    │
    ├──► RecoveryModule.classifyStall()
    ├──► AdaptiveRecovery.selectStrategy()
    ├──► AIAdvisor.getAdvice() [if enabled]
    ├──► RecoveryModule.executeStrategy()
    └──► StatusFile.write()

recovery.completed
    │
    ├──► SelfImprovingSystem.recordOutcome()
    ├──► StrategyPool.updateEffectiveness()
    ├──► MetaCognition.reflect() [if enabled]
    └──► StatusFile.write()

session.status(idle)
    │
    ├──► RecoveryModule.clearTimer()
    ├──► NudgeModule.checkTodos()
    ├──► ReviewModule.checkCompletion()
    └──► Terminal.clearTitle()

todo.updated
    │
    ├──► AutonomousCore.updateTaskGraph()
    ├──► NudgeModule.updateTodoState()
    ├──► ReviewModule.checkAllCompleted()
    └──► StatusFile.write()

session.error(token_limit)
    │
    ├──► CompactionModule.forceCompact()
    ├──► PredictiveEngine.recordContextBloat() [if enabled]
    └──► StatusFile.write()

session.ended
    │
    ├──► MetaCognition.generateReport() [if enabled]
    ├──► SelfImprovingSystem.persistLearning()
    ├──► StatusFile.archive()
    └──► Terminal.clearTitle()
```

---

## 8. Multi-Session Orchestration (v7.5)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    MULTI-SESSION ORCHESTRATION                               │
└─────────────────────────────────────────────────────────────────────────────┘

                    ┌─────────────────────┐
                    │   Orchestrator      │
                    │   Central Hub       │
                    └──────────┬──────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
        ▼                      ▼                      ▼
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│  Session A   │      │  Session B   │      │  Session C   │
│  (Analysis)  │─────►│  (Auth Ref)  │─────►│  (Tests)     │
│              │      │              │      │              │
│ Status:      │      │ Status:      │      │ Status:      │
│ complete     │      │ busy         │      │ pending      │
│              │      │              │      │              │
│ Output:      │      │ Input:       │      │ Input:       │
│ - findings   │      │ - findings   │      │ - auth code  │
│ - plan       │      │              │      │              │
└──────────────┘      └──────────────┘      └──────────────┘
        │                      │                      │
        │                      │                      │
        └──────────────────────┼──────────────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │   Context Transfer  │
                    │                     │
                    │ Session A ──► B:    │
                    │ - analysis results  │
                    │ - refactor plan     │
                    │                     │
                    │ Session B ──► C:    │
                    │ - auth code         │
                    │ - test requirements │
                    └─────────────────────┘

Dependency Graph:

    [Analysis]
        │
        ▼
    [Auth Ref] ──┐
        │        │
        ▼        ▼
    [Tests]  [Docs]
        │
        ▼
    [Integration]

Execution Order:
1. Start: Analysis
2. After Analysis complete: Auth Ref
3. After Auth Ref complete: Tests + Docs (parallel)
4. After Tests complete: Integration
```

---

## 9. Performance Characteristics

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        PERFORMANCE TARGETS                                   │
└─────────────────────────────────────────────────────────────────────────────┘

Latency Budget (per event):
┌──────────────────────────┬─────────────┬─────────────┐
│ Operation                │ Target      │ Max         │
├──────────────────────────┼─────────────┼─────────────┤
│ Event handling           │ < 1ms       │ < 5ms       │
│ Intent extraction        │ < 50ms      │ < 100ms     │
│ Stall prediction         │ < 10ms      │ < 50ms      │
│ Strategy selection       │ < 5ms       │ < 20ms      │
│ Learning DB query        │ < 10ms      │ < 50ms      │
│ Effectiveness update     │ < 5ms       │ < 20ms      │
│ Status file write        │ < 20ms      │ < 100ms     │
│ Terminal update          │ < 5ms       │ < 20ms      │
└──────────────────────────┴─────────────┴─────────────┘

Memory Budget (per session):
┌──────────────────────────┬─────────────┐
│ Component                │ Target      │
├──────────────────────────┼─────────────┤
│ SessionState             │ ~200 bytes  │
│ Intent/TaskGraph         │ ~2 KB       │
│ Prediction cache         │ ~1 KB       │
│ Learning data (shared)   │ ~10 MB total│
│ Status file buffer       │ ~5 KB       │
└──────────────────────────┴─────────────┘

Recovery Time Targets:
┌──────────────────────────┬─────────────┬─────────────┐
│ Metric                   │ v6.x        │ v7.0 Target │
├──────────────────────────┼─────────────┼─────────────┤
│ Detection → Strategy     │ N/A         │ < 100ms     │
│ Strategy → Execution     │ N/A         │ < 50ms      │
│ Abort → Continue         │ ~5s         │ ~5s         │
│ Total recovery time      │ ~45s        │ ~20s        │
│ Time to productive work  │ ~60s        │ ~30s        │
└──────────────────────────┴─────────────┴─────────────┘
```

---

## 10. Error Handling & Resilience

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     ERROR HANDLING STRATEGY                                  │
└─────────────────────────────────────────────────────────────────────────────┘

Failure Modes:

1. Intent Extraction Fails
   │
   ├──► Confidence < 0.3
   │    └──► Fallback: No intent tracking, reactive mode only
   │
   └──► Exception thrown
        └──► Catch, log, continue with empty intent

2. Prediction Engine Fails
   │
   ├──► Timeout (> 50ms)
   │    └──► Skip prediction, continue with reactive recovery
   │
   └──► Exception thrown
        └──► Catch, log, disable predictions for this session

3. Strategy Execution Fails
   │
   ├──► Strategy throws error
   │    └──► Catch, log, try next best strategy
   │
   ├──► All strategies fail
   │    └──► Fallback to generic recovery (v6.x behavior)
   │
   └──► Session abort fails
        └──► Log error, mark session as unrecoverable

4. Learning DB Fails
   │
   ├──► Write fails
   │    └──► Queue for retry, don't block recovery
   │
   ├──► Read fails
   │    └──► Use default effectiveness (0.5)
   │
   └──► Corruption detected
        └──► Backup restore, reset learning

5. Meta-Cognition Loop Fails
   │
   └──► Reflection fails
        └──► Log error, skip this cycle, try next time

Resilience Principles:
- Fail open: If advanced feature fails, fall back to basic behavior
- Never crash: All errors caught and logged
- Graceful degradation: Reduce functionality, don't stop working
- Self-healing: Detect and recover from own failures
```

---

*These diagrams provide visual reference for the architecture described in VISION-v7.0.md and ARCHITECTURE.md. See ROADMAP.md for implementation phases.*
