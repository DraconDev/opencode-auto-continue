# Self-Improving Recovery System Design

**Status**: Design Document  
**Version**: 1.0  
**Related**: VISION-v7.0.md, ARCHITECTURE.md  

---

## 1. System Overview

The Self-Improving Recovery System (SIRS) transforms recovery from a static set of rules into a **living, learning system** that continuously optimizes itself based on outcomes.

```
┌──────────────────────────────────────────────────────────────┐
│                    SIRS CORE LOOP                             │
│                                                               │
│   ┌─────────┐    ┌──────────┐    ┌─────────┐    ┌─────────┐ │
│   │ DETECT  │───►│ RECOVER  │───►│  LEARN  │───►│ IMPROVE │ │
│   │  STALL  │    │          │    │         │    │         │ │
│   └─────────┘    └──────────┘    └─────────┘    └─────────┘ │
│        ▲                                          │          │
│        └──────────────────────────────────────────┘          │
│                    (feedback loop)                            │
└──────────────────────────────────────────────────────────────┘
```

**Key Principle**: Every recovery attempt is a learning opportunity. The system gets smarter with every session.

---

## 2. Learning Database Schema

```typescript
// ~/.opencode/auto-continue/learning.db (SQLite)

// Recovery outcomes
interface RecoveryRecord {
  id: string;                    // UUID
  timestamp: number;             // Unix ms
  sessionId: string;
  
  // Input context
  stallPattern: string;          // e.g., "reasoning-loop"
  recoveryStrategy: string;      // e.g., "gentle-guidance"
  sessionDomain: string;         // e.g., "refactoring"
  taskComplexity: number;        // 1-10
  tokenCount: number;
  contextUtilization: number;    // 0-1
  sessionAge: number;            // ms
  todoCount: number;
  recentToolFailureRate: number; // 0-1
  
  // Intervention details
  customPrompt: string;
  proactiveIntervention: boolean; // Was this pre-emptive?
  
  // Outcome
  success: boolean;              // Did model resume productive work?
  timeToRecovery: number;        // ms from intervention to progress
  messagesUntilNextStall: number; // How long did recovery last?
  userTookOver: boolean;         // Did user intervene?
  taskCompleted: boolean;        // Was the overall task finished?
  
  // Derived metrics (calculated)
  effectivenessScore: number;    // 0-1 composite score
  userSatisfaction: number;      // Inferred from user behavior
}

// Strategy performance over time
interface StrategyPerformance {
  strategyId: string;
  stallPattern: string;
  sessionDomain: string;
  
  // Statistics
  totalAttempts: number;
  successes: number;
  failures: number;
  partials: number;
  
  // Time metrics
  avgTimeToRecovery: number;
  minTimeToRecovery: number;
  maxTimeToRecovery: number;
  
  // Effectiveness (decaying average)
  currentEffectiveness: number;  // 0-1
  effectivenessHistory: Array<{
    timestamp: number;
    value: number;
  }>;
  
  // Trend
  trend: "improving" | "stable" | "declining";
  lastUpdated: number;
}

// User preferences (learned implicitly)
interface UserPreference {
  userId: string;                // Anonymous hash
  preferredAutonomyLevel: string; // Inferred from override rate
  patienceFactor: number;        // Multiplier for timeouts
  domainPreferences: Map<string, {
    preferredStrategy: string;
    customTimeoutMs: number;
  }>;
}
```

---

## 3. Effectiveness Scoring Algorithm

```typescript
function calculateEffectiveness(record: RecoveryRecord): number {
  const weights = {
    success: 0.4,           // Did it work?
    speed: 0.2,             // How fast?
    durability: 0.2,        // How long until next stall?
    autonomy: 0.2,          // Did user need to intervene?
  };
  
  // Success score (binary, but partial credit possible)
  const successScore = record.success ? 1.0 : 
                       (record.messagesUntilNextStall > 3 ? 0.5 : 0.0);
  
  // Speed score (faster is better, max at 10s)
  const speedScore = Math.max(0, 1 - (record.timeToRecovery / 10000));
  
  // Durability score (more messages = better)
  const durabilityScore = Math.min(1, record.messagesUntilNextStall / 10);
  
  // Autonomy score (user didn't take over = better)
  const autonomyScore = record.userTookOver ? 0.0 : 1.0;
  
  return (
    weights.success * successScore +
    weights.speed * speedScore +
    weights.durability * durabilityScore +
    weights.autonomy * autonomyScore
  );
}
```

**Effectiveness thresholds**:
- **0.8-1.0**: Excellent — primary strategy
- **0.5-0.8**: Good — secondary strategy
- **0.3-0.5**: Poor — fallback only
- **0.0-0.3**: Broken — disable and alert

---

## 4. Strategy Effectiveness Update

```typescript
class StrategyEffectivenessTracker {
  private alpha: number = 0.3;  // Learning rate
  
  updateEffectiveness(
    strategyId: string,
    pattern: string,
    domain: string,
    outcome: RecoveryOutcome
  ): void {
    const key = `${strategyId}:${pattern}:${domain}`;
    const current = this.getEffectiveness(key);
    
    // Calculate outcome score
    const score = outcome.success ? 1.0 : 
                  outcome.partial ? 0.5 : 0.0;
    
    // Exponential moving average
    const newEffectiveness = 
      (current * (1 - this.alpha)) + 
      (score * this.alpha);
    
    this.setEffectiveness(key, newEffectiveness);
    this.updateTrend(key, newEffectiveness);
    
    // Log significant changes
    if (Math.abs(newEffectiveness - current) > 0.15) {
      log(`Strategy ${strategyId} effectiveness for ${pattern} ` +
          `changed: ${current.toFixed(2)} → ${newEffectiveness.toFixed(2)}`);
    }
  }
  
  private updateTrend(key: string, newValue: number): void {
    const history = this.getHistory(key);
    const recent = history.slice(-5);  // Last 5 attempts
    
    if (recent.length < 3) return;
    
    const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
    const avgOlder = history.slice(0, -5).reduce((a, b) => a + b, 0) / 
                     Math.max(1, history.length - 5);
    
    if (avgRecent > avgOlder * 1.1) {
      this.setTrend(key, "improving");
    } else if (avgRecent < avgOlder * 0.9) {
      this.setTrend(key, "declining");
    } else {
      this.setTrend(key, "stable");
    }
  }
}
```

---

## 5. Strategy Selection Algorithm

```typescript
function selectBestStrategy(
  context: RecoveryContext,
  strategies: RecoveryStrategy[],
  learningDB: LearningDatabase
): RecoveryStrategy {
  
  // Filter: only strategies applicable to this pattern
  const applicable = strategies.filter(s => 
    s.applicablePatterns.includes(context.stallPattern)
  );
  
  // Score each strategy
  const scored = applicable.map(strategy => {
    const baseEffectiveness = learningDB.getEffectiveness(
      strategy.id,
      context.stallPattern,
      context.sessionDomain
    );
    
    // Adjust based on context
    let score = baseEffectiveness;
    
    // Boost if strategy handles this token count well historically
    const tokenPerformance = learningDB.getTokenPerformance(
      strategy.id,
      context.tokenCount
    );
    score = score * 0.7 + tokenPerformance * 0.3;
    
    // Penalize if recently failed
    const recentFailures = learningDB.getRecentFailures(
      strategy.id,
      context.sessionId,
      3  // Last 3 attempts
    );
    score *= (1 - (recentFailures * 0.2));  // Up to 40% penalty
    
    // Boost if proactive intervention was already tried
    if (context.proactiveInterventionSent && 
        strategy.id === "gentle-guidance") {
      score *= 0.7;  // Penalize gentle guidance if proactive failed
    }
    
    return { strategy, score };
  });
  
  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  
  // Top 3 strategies with weighted random selection
  // (exploration vs exploitation)
  const top3 = scored.slice(0, 3);
  const explorationRate = 0.1;  // 10% chance to try something new
  
  if (Math.random() < explorationRate && top3.length > 1) {
    // Randomly select from top 3 for exploration
    const randomIndex = Math.floor(Math.random() * top3.length);
    return top3[randomIndex].strategy;
  }
  
  return top3[0].strategy;
}
```

---

## 6. Pattern Discovery

The system discovers new stall patterns automatically:

```typescript
class PatternDiscovery {
  private minSamples = 5;
  private similarityThreshold = 0.85;
  
  discoverNewPattern(records: RecoveryRecord[]): StallPattern | null {
    // Cluster failed recoveries with similar characteristics
    const failures = records.filter(r => !r.success);
    
    for (const failure of failures) {
      const similar = this.findSimilar(failure, failures);
      
      if (similar.length >= this.minSamples) {
        // Check if this cluster matches known patterns
        const knownMatch = this.matchKnownPattern(similar);
        
        if (!knownMatch) {
          // New pattern discovered!
          return this.createNewPattern(similar);
        }
      }
    }
    
    return null;
  }
  
  private findSimilar(
    target: RecoveryRecord, 
    candidates: RecoveryRecord[]
  ): RecoveryRecord[] {
    return candidates.filter(c => 
      c.sessionDomain === target.sessionDomain &&
      this.similarityScore(c, target) > this.similarityThreshold
    );
  }
  
  private similarityScore(a: RecoveryRecord, b: RecoveryRecord): number {
    // Compare characteristics
    const features = [
      this.compareTokens(a.tokenCount, b.tokenCount),
      this.compareRates(a.recentToolFailureRate, b.recentToolFailureRate),
      this.compareTimes(a.sessionAge, b.sessionAge),
      this.compareToolSequences(a.recentTools, b.recentTools),
    ];
    
    return features.reduce((sum, f) => sum + f, 0) / features.length;
  }
  
  private createNewPattern(records: RecoveryRecord[]): StallPattern {
    const pattern: StallPattern = {
      id: `pattern-${Date.now()}`,
      name: this.generateName(records),
      characteristics: this.extractCharacteristics(records),
      frequency: records.length,
      firstSeen: records[0].timestamp,
      recommendedStrategy: this.findBestStrategy(records),
    };
    
    log(`New stall pattern discovered: ${pattern.name}`);
    return pattern;
  }
}
```

---

## 7. Parameter Adaptation

The system adapts its own parameters based on performance:

```typescript
interface ParameterAdaptation {
  parameter: string;
  currentValue: number;
  suggestedValue: number;
  reason: string;
  confidence: number;
  autoApply: boolean;
}

function generateAdaptations(
  sessionHistory: SessionRecord[],
  currentConfig: PluginConfig
): ParameterAdaptation[] {
  const adaptations: ParameterAdaptation[] = [];
  
  // 1. Stall timeout adaptation
  const avgRecoveryFrequency = calculateRecoveryFrequency(sessionHistory);
  if (avgRecoveryFrequency > 3) {  // More than 3 per 10 minutes
    adaptations.push({
      parameter: "stallTimeoutMs",
      currentValue: currentConfig.stallTimeoutMs,
      suggestedValue: currentConfig.stallTimeoutMs * 1.5,
      reason: `High recovery frequency (${avgRecoveryFrequency}/10min). ` +
              "Sessions may need more time.",
      confidence: 0.75,
      autoApply: true,
    });
  }
  
  // 2. Nudge cooldown adaptation
  const nudgeEffectiveness = calculateNudgeEffectiveness(sessionHistory);
  if (nudgeEffectiveness < 0.3) {
    adaptations.push({
      parameter: "nudgeCooldownMs",
      currentValue: currentConfig.nudgeCooldownMs,
      suggestedValue: currentConfig.nudgeCooldownMs * 2,
      reason: "Nudges are not effective. Reducing frequency.",
      confidence: 0.6,
      autoApply: false,  // Require user approval
    });
  }
  
  // 3. Prediction threshold adaptation
  const predictionAccuracy = calculatePredictionAccuracy(sessionHistory);
  if (predictionAccuracy > 0.8) {
    adaptations.push({
      parameter: "predictionThreshold",
      currentValue: currentConfig.predictionThreshold,
      suggestedValue: currentConfig.predictionThreshold * 0.9,
      reason: "Predictions are accurate. Can be more aggressive.",
      confidence: 0.8,
      autoApply: true,
    });
  }
  
  // 4. Strategy pool adaptation
  const worstStrategy = findWorstPerformingStrategy(sessionHistory);
  if (worstStrategy && worstStrategy.effectiveness < 0.3) {
    adaptations.push({
      parameter: "disabledStrategies",
      currentValue: currentConfig.disabledStrategies,
      suggestedValue: [...currentConfig.disabledStrategies, worstStrategy.id],
      reason: `Strategy "${worstStrategy.name}" has ${worstStrategy.effectiveness} effectiveness. ` +
              "Disabling to improve overall performance.",
      confidence: 0.85,
      autoApply: false,
    });
  }
  
  return adaptations;
}
```

---

## 8. Meta-Cognitive Reports

Periodic self-assessment reports:

```typescript
interface MetaCognitiveReport {
  period: { start: number; end: number };
  
  // Recovery performance
  totalRecoveries: number;
  successRate: number;
  avgTimeToRecovery: number;
  mostCommonPattern: string;
  mostEffectiveStrategy: string;
  
  // Learning progress
  strategiesImproved: number;
  strategiesDeclined: number;
  newPatternsDiscovered: number;
  parametersAdapted: number;
  
  // Predictive performance
  predictionsMade: number;
  predictionAccuracy: number;
  interventionsPrevented: number;  // Stalls prevented proactively
  
  // User impact
  userOverrides: number;
  userOverrideRate: number;
  avgSessionAutonomy: number;  // % of time without user intervention
  
  // Recommendations
  recommendations: string[];
}

// Example report
const exampleReport: MetaCognitiveReport = {
  period: { start: 1715000000000, end: 1717600000000 },
  totalRecoveries: 45,
  successRate: 0.82,  // Up from 0.65 last month!
  avgTimeToRecovery: 18000,  // 18s, down from 45s
  mostCommonPattern: "reasoning-loop",
  mostEffectiveStrategy: "gentle-guidance",
  strategiesImproved: 2,
  strategiesDeclined: 1,
  newPatternsDiscovered: 1,  // "api-rate-limit"
  parametersAdapted: 3,
  predictionsMade: 28,
  predictionAccuracy: 0.79,
  interventionsPrevented: 12,  // 12 stalls prevented!
  userOverrides: 8,
  userOverrideRate: 0.18,  // Down from 0.40!
  avgSessionAutonomy: 0.84,  // 84% autonomous!
  recommendations: [
    "Consider enabling 'proactive' autonomy level — predictions are accurate",
    "Strategy 'creative-break' is underperforming for 'refactoring' domain",
    "Token limits hit frequently — suggest enabling DCP plugin",
  ],
};
```

---

## 9. Learning Data Flow

```
[Recovery Outcome]
    │
    ▼
[Calculate Effectiveness]
    │
    ├──► effectivenessScore
    └──► userSatisfaction (inferred)
    │
    ▼
[Update Strategy Performance]
    │
    ├──► Update effectiveness (EMA)
    ├──► Update trend (improving/stable/declining)
    └──► Update time metrics
    │
    ▼
[Check for Pattern Discovery]
    │
    ├──► Cluster similar failures
    ├──► Compare to known patterns
    └──► Create new pattern if novel
    │
    ▼
[Check for Parameter Adaptation]
    │
    ├──► Calculate recovery frequency
    ├──► Calculate nudge effectiveness
    ├──► Calculate prediction accuracy
    └──► Generate adaptation suggestions
    │
    ▼
[Persist to Database]
    │
    ├──► RecoveryRecord (append)
    ├──► StrategyPerformance (update)
    ├──► StallPattern (create/update)
    └──► UserPreference (update)
    │
    ▼
[Apply Auto-Adaptations]
    │
    ├──► If autoApply && confidence > 0.7
    │    → Apply parameter change
    │    → Log: "Auto-adapted stallTimeoutMs: 180000 → 270000"
    │
    └──► If !autoApply || confidence <= 0.7
         → Queue for user review
         → Show in status file
         → Suggest in meta-cognitive report
```

---

## 10. Exploration vs Exploitation

The system balances using known good strategies with trying new ones:

```typescript
function shouldExplore(sessionId: string): boolean {
  const session = getSession(sessionId);
  
  // Base exploration rate
  let explorationRate = 0.1;  // 10%
  
  // Increase exploration if:
  // 1. Current strategies are failing
  const recentSuccessRate = calculateRecentSuccessRate(session, 5);
  if (recentSuccessRate < 0.5) {
    explorationRate += 0.15;  // Try something new!
  }
  
  // 2. New pattern detected
  if (session.stallPattern === "unknown") {
    explorationRate += 0.1;
  }
  
  // 3. Been a while since we explored
  const lastExploration = getLastExplorationTime(session);
  if (Date.now() - lastExploration > 3600000) {  // 1 hour
    explorationRate += 0.05;
  }
  
  // Decrease exploration if:
  // 1. Current strategies are working well
  if (recentSuccessRate > 0.9) {
    explorationRate -= 0.05;  // Don't fix what isn't broken
  }
  
  // Cap between 5% and 30%
  explorationRate = Math.max(0.05, Math.min(0.30, explorationRate));
  
  return Math.random() < explorationRate;
}
```

---

## 11. Cold Start Problem

New users have no learning history. Solution: **Transfer Learning**.

```typescript
// Default strategies with community effectiveness
const defaultStrategyEffectiveness: Record<string, number> = {
  "gentle-guidance:reasoning-loop:refactoring": 0.85,
  "direct-intervention:tool-failure:feature": 0.78,
  "context-compaction:context-bloat:testing": 0.72,
  "task-refocus:todo-overwhelm:documentation": 0.68,
};

// Community averages (anonymous, aggregated)
const communityAverages: Record<string, number> = {
  "gentle-guidance:reasoning-loop:*": 0.82,
  "direct-intervention:tool-failure:*": 0.75,
};

function getInitialEffectiveness(
  strategyId: string,
  pattern: string,
  domain: string
): number {
  // Try specific match first
  const specific = `${strategyId}:${pattern}:${domain}`;
  if (defaultStrategyEffectiveness[specific]) {
    return defaultStrategyEffectiveness[specific];
  }
  
  // Try community average
  const community = `${strategyId}:${pattern}:*`;
  if (communityAverages[community]) {
    return communityAverages[community] * 0.9;  // Slightly discount
  }
  
  // Fallback: neutral
  return 0.5;
}
```

**As user accumulates data, personal history overrides defaults.**

---

## 12. Privacy & Data Retention

```typescript
// Data retention policies
const retentionPolicies = {
  // Keep detailed records for 30 days
  recoveryRecords: 30 * 24 * 60 * 60 * 1000,
  
  // Keep strategy performance indefinitely (anonymized)
  strategyPerformance: Infinity,
  
  // Keep user preferences indefinitely
  userPreferences: Infinity,
  
  // Keep raw messages for 7 days (for debugging)
  messageHistory: 7 * 24 * 60 * 60 * 1000,
};

// Data minimization
function sanitizeRecord(record: RecoveryRecord): SafeRecord {
  return {
    // Include
    stallPattern: record.stallPattern,
    recoveryStrategy: record.recoveryStrategy,
    success: record.success,
    timeToRecovery: record.timeToRecovery,
    messagesUntilNextStall: record.messagesUntilNextStall,
    
    // Exclude (privacy sensitive)
    // - sessionId (linkable)
    // - customPrompt (may contain code)
    // - timestamp (precise)
    
    // Transform
    sessionDomain: record.sessionDomain,
    taskComplexity: roundToNearest(record.taskComplexity, 2),  // Less precise
    tokenCount: roundToNearest(record.tokenCount, 1000),  // Bucketed
  };
}
```

---

## 13. Integration Points

```typescript
// Integration with existing modules

// 1. Recovery Module
class AdaptiveRecovery {
  constructor(
    private learningDB: LearningDatabase,
    private strategyPool: StrategyPool,
    private config: AutonomyConfig
  ) {}
  
  async recover(sessionId: string): Promise<RecoveryResult> {
    const context = await this.buildContext(sessionId);
    
    // Select best strategy using learning data
    const strategy = selectBestStrategy(
      context,
      this.strategyPool.getAll(),
      this.learningDB
    );
    
    // Execute
    const result = await strategy.execute(sessionId, context);
    
    // Learn
    this.learningDB.recordOutcome(sessionId, strategy.id, result);
    this.strategyPool.updateEffectiveness(strategy.id, result);
    
    return result;
  }
}

// 2. Predictive Engine
class PredictiveEngine {
  constructor(private learningDB: LearningDatabase) {}
  
  predictStall(sessionId: string): StallPrediction {
    // Use historical patterns to improve prediction
    const historicalPattern = this.learningDB.getHistoricalPattern(sessionId);
    
    // ... prediction logic ...
    
    return prediction;
  }
}

// 3. Meta-Cognition
class MetaCognition {
  constructor(private learningDB: LearningDatabase) {}
  
  generateReport(): MetaCognitiveReport {
    const records = this.learningDB.getRecentRecords(30 * 24 * 60 * 60 * 1000);
    
    return {
      totalRecoveries: records.length,
      successRate: calculateSuccessRate(records),
      // ... etc
    };
  }
}
```

---

*This design enables the auto-continue plugin to continuously improve its recovery strategies based on real-world outcomes, making it more effective over time without requiring manual tuning.*
