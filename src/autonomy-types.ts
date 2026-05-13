/**
 * Auto-Continue v7.0 - Autonomous AI Types
 * 
 * Core type definitions for the autonomous session management architecture.
 * These types support intent extraction, predictive intervention, adaptive recovery,
 * self-improving learning, and meta-cognitive monitoring.
 */

// ============================================================================
// AUTONOMY CONFIGURATION
// ============================================================================

/**
 * Autonomy level controls which modules are active.
 * Higher levels enable more proactive autonomous behavior.
 */
export type AutonomyLevel = "basic" | "adaptive" | "proactive" | "full";

/**
 * Extended plugin configuration for v7.0 autonomous features.
 */
export interface AutonomyConfig {
  /** Current autonomy level - controls feature activation */
  level: AutonomyLevel;
  
  /** Enable intent extraction from session prompts */
  intentExtraction: boolean;
  
  /** Enable predictive stall detection and proactive intervention */
  predictiveIntervention: boolean;
  
  /** Enable strategy effectiveness learning */
  learningEnabled: boolean;
  
  /** Enable self-monitoring and parameter adaptation */
  metaCognition: boolean;
  
  /** Enable multi-session orchestration (v7.5+) */
  taskOrchestration: boolean;
  
  /** Enable automatic task decomposition */
  autoDecomposition: boolean;
  
  /** Active recovery strategies */
  strategyPool: string[];
  
  /** Probability threshold for proactive intervention (0-1) */
  predictionThreshold: number;
  
  /** How quickly to update strategy effectiveness (0-1) */
  learningRate: number;
  
  /** Interval between self-reflections in ms */
  reflectionIntervalMs: number;
  
  /** Maximum concurrent sessions for orchestration */
  maxConcurrentSessions: number;
  
  /** Enable automatic checkpoint creation */
  autoCheckpoint: boolean;
  
  /** Checkpoint creation interval in ms */
  checkpointIntervalMs: number;
}

/** Default autonomy configuration */
export const DEFAULT_AUTONOMY_CONFIG: AutonomyConfig = {
  level: "adaptive",
  intentExtraction: true,
  predictiveIntervention: false,
  learningEnabled: true,
  metaCognition: false,
  taskOrchestration: false,
  autoDecomposition: false,
  strategyPool: [
    "gentle-guidance",
    "direct-intervention",
    "context-compaction",
    "task-refocus",
  ],
  predictionThreshold: 0.7,
  learningRate: 0.3,
  reflectionIntervalMs: 300000, // 5 minutes
  maxConcurrentSessions: 3,
  autoCheckpoint: false,
  checkpointIntervalMs: 600000, // 10 minutes
};

/** Autonomy configuration presets by level */
export const AUTONOMY_PRESETS: Record<AutonomyLevel, Partial<AutonomyConfig>> = {
  basic: {
    intentExtraction: false,
    predictiveIntervention: false,
    learningEnabled: false,
    metaCognition: false,
    taskOrchestration: false,
    autoDecomposition: false,
  },
  adaptive: {
    intentExtraction: true,
    predictiveIntervention: false,
    learningEnabled: true,
    metaCognition: false,
    taskOrchestration: false,
    autoDecomposition: false,
  },
  proactive: {
    intentExtraction: true,
    predictiveIntervention: true,
    learningEnabled: true,
    metaCognition: true,
    taskOrchestration: false,
    autoDecomposition: false,
  },
  full: {
    intentExtraction: true,
    predictiveIntervention: true,
    learningEnabled: true,
    metaCognition: true,
    taskOrchestration: true,
    autoDecomposition: true,
  },
};

// ============================================================================
// SESSION INTENT & TASK GRAPH
// ============================================================================

/**
 * Represents the AI's understanding of what the session is trying to accomplish.
 */
export interface SessionIntent {
  /** Primary goal extracted from the initial prompt */
  primaryGoal: string;
  
  /** Domain classification */
  domain: TaskDomain;
  
  /** Task decomposition hierarchy */
  taskGraph: TaskGraph;
  
  /** ID of the task currently being worked on */
  currentTaskId: string;
  
  /** When the session started */
  sessionStartTime: number;
  
  /** Estimated total time in minutes */
  estimatedTotalTime: number;
  
  /** How confident we are in this intent (0-1) */
  confidence: number;
  
  /** Known blockers or obstacles */
  blockers: string[];
}

/** Task domain classification */
export type TaskDomain = 
  | "refactoring" 
  | "feature" 
  | "bugfix" 
  | "testing" 
  | "documentation" 
  | "optimization"
  | "setup"
  | "unknown";

/**
 * Hierarchical task decomposition.
 */
export interface TaskGraph {
  /** Root task node */
  root: TaskNode;
  
  /** All nodes by ID for quick lookup */
  nodes: Map<string, TaskNode>;
  
  /** Current depth of the graph */
  maxDepth: number;
}

/**
 * Individual task in the hierarchy.
 */
export interface TaskNode {
  /** Unique identifier */
  id: string;
  
  /** Human-readable description */
  description: string;
  
  /** Current execution status */
  status: TaskStatus;
  
  /** IDs of tasks that must complete before this one */
  dependencies: string[];
  
  /** Estimated effort in minutes */
  estimatedEffort: number;
  
  /** Actual time spent so far in ms */
  actualEffortMs: number;
  
  /** Complexity rating 1-10 */
  complexity: number;
  
  /** Domain classification */
  domain: TaskDomain;
  
  /** Parent task ID (undefined for root) */
  parentId?: string;
  
  /** Child task IDs */
  subtasks: string[];
  
  /** When this task was created */
  createdAt: number;
  
  /** When this task was completed (undefined if not done) */
  completedAt?: number;
}

/** Task execution status */
export type TaskStatus = "pending" | "in_progress" | "blocked" | "completed" | "cancelled";

/**
 * Result of intent extraction.
 */
export interface IntentExtractionResult {
  /** The extracted intent */
  intent: SessionIntent;
  
  /** Whether extraction was successful enough to proceed */
  success: boolean;
  
  /** Raw analysis for debugging */
  analysis: IntentAnalysis;
}

/** Detailed analysis from intent extraction */
export interface IntentAnalysis {
  /** Keywords identified in prompt */
  keywords: string[];
  
  /** Detected domain with confidence scores */
  domainScores: Record<TaskDomain, number>;
  
  /** Complexity estimate 1-10 */
  complexityEstimate: number;
  
  /** Suggested decomposition steps */
  suggestedSteps: string[];
  
  /** Ambiguities that need clarification */
  ambiguities: string[];
}

// ============================================================================
// PREDICTIVE ENGINE
// ============================================================================

/**
 * Prediction of an impending stall.
 */
export interface StallPrediction {
  /** Probability of stall occurring (0-1) */
  probability: number;
  
  /** Estimated time until stall in ms */
  estimatedTimeToStall: number;
  
  /** Predicted stall pattern type */
  predictedPattern: StallPatternType;
  
  /** Confidence in this prediction (0-1) */
  confidence: number;
  
  /** Factors contributing to this prediction */
  contributingFactors: PredictionFactor[];
  
  /** When this prediction was made */
  timestamp: number;
}

/** Types of stall patterns that can be predicted */
export type StallPatternType =
  | "reasoning-loop"
  | "tool-failure"
  | "context-bloat"
  | "api-delay"
  | "todo-overwhelm"
  | "confusion"
  | "infinite-loop"
  | "cold-start"
  | "mixed-progress"
  | "unknown";

/** Individual factor contributing to a stall prediction */
export interface PredictionFactor {
  /** Factor name */
  name: string;
  
  /** Weight/contribution (0-1) */
  weight: number;
  
  /** Current value */
  value: number;
  
  /** Threshold that triggered concern */
  threshold: number;
  
  /** Human-readable description */
  description: string;
}

/**
 * A proactive intervention to prevent a predicted stall.
 */
export interface ProactiveIntervention {
  /** Type of intervention */
  type: InterventionType;
  
  /** Message to send (if applicable) */
  message?: string;
  
  /** New timeout value (if adjusting) */
  newTimeoutMs?: number;
  
  /** When to trigger this intervention */
  triggerTime: number;
  
  /** Prediction that triggered this intervention */
  prediction: StallPrediction;
}

/** Types of proactive interventions */
export type InterventionType = 
  | "guidance" 
  | "nudge" 
  | "compaction" 
  | "timeout-adjustment"
  | "task-refocus";

/**
 * Signals collected from session for prediction.
 */
export interface PredictionSignals {
  /** Token velocity (tokens per second) */
  tokenVelocity: number;
  
  /** Change in token velocity (negative = slowing) */
  tokenVelocityDelta: number;
  
  /** How much reasoning text repeats */
  reasoningRepetitionScore: number;
  
  /** Tool call failure rate (0-1) */
  toolFailureRate: number;
  
  /** Time since last meaningful progress in ms */
  timeSinceProgress: number;
  
  /** Context utilization (0-1) */
  contextUtilization: number;
  
  /** How well current signals match historical patterns */
  historicalPatternMatch: number;
  
  /** Number of messages in current burst */
  messageBurstSize: number;
  
  /** Average message processing time */
  avgMessageProcessingTime: number;
}

// ============================================================================
// ADAPTIVE RECOVERY
// ============================================================================

/**
 * A recovery strategy for handling stalls.
 */
export interface RecoveryStrategy {
  /** Unique identifier */
  id: string;
  
  /** Human-readable name */
  name: string;
  
  /** Description of when to use this strategy */
  description: string;
  
  /** Which stall patterns this strategy can handle */
  applicablePatterns: StallPatternType[];
  
  /** Priority level */
  priority: StrategyPriority;
  
  /** Current effectiveness score (0-1) */
  effectiveness: number;
  
  /** Whether this strategy requires abort */
  requiresAbort: boolean;
  
  /** Maximum character length for generated messages */
  maxMessageLength: number;
  
  /** Execute the strategy */
  execute: (sessionId: string, context: RecoveryContext) => Promise<RecoveryResult>;
  
  /** Generate a contextual message for this strategy */
  generateMessage: (context: RecoveryContext) => string;
}

/** Strategy priority levels */
export type StrategyPriority = "primary" | "secondary" | "fallback" | "disabled";

/**
 * Context available during recovery decision-making.
 */
export interface RecoveryContext {
  /** Session state at time of stall */
  sessionState: unknown; // SessionState from shared.ts
  
  /** Extracted session intent (if available) */
  intent?: SessionIntent;
  
  /** Classified stall pattern */
  stallPattern: StallPatternType;
  
  /** How confident we are in the pattern classification */
  patternConfidence: number;
  
  /** Recent messages for context */
  recentMessages: unknown[]; // Message types
  
  /** Current todos */
  todoContext: TodoContext[];
  
  /** History of failures in this session */
  failureHistory: FailureEvent[];
  
  /** Whether a proactive intervention was already attempted */
  proactiveInterventionSent: boolean;
  
  /** Number of recovery attempts so far */
  recoveryAttempts: number;
  
  /** Current token count */
  tokenCount: number;
  
  /** Context limit */
  contextLimit: number;
  
  /** Session age in ms */
  sessionAge: number;
}

/** Simplified todo context for recovery */
export interface TodoContext {
  id: string;
  content: string;
  status: string;
  priority?: number;
}

/** Record of a failure event */
export interface FailureEvent {
  timestamp: number;
  pattern: StallPatternType;
  strategy: string;
  message: string;
  outcome: "success" | "failure" | "partial";
}

/**
 * Result of executing a recovery strategy.
 */
export interface RecoveryResult {
  /** Whether recovery was successful */
  success: boolean;
  
  /** Time from intervention to resumed progress in ms */
  timeToRecovery: number;
  
  /** Number of messages generated before next stall */
  messagesUntilNextStall: number;
  
  /** Whether user took over */
  userTookOver: boolean;
  
  /** Whether the overall task was completed */
  taskCompleted: boolean;
  
  /** Strategy that was used */
  strategyId: string;
  
  /** Custom message that was sent */
  message: string;
  
  /** Whether abort was performed */
  aborted: boolean;
}

// ============================================================================
// SELF-IMPROVING SYSTEM
// ============================================================================

/**
 * Record of a recovery outcome in the learning database.
 */
export interface RecoveryRecord {
  /** Unique identifier */
  id: string;
  
  /** When this record was created */
  timestamp: number;
  
  /** Session ID (hashed for privacy) */
  sessionId: string;
  
  // Input context
  stallPattern: StallPatternType;
  recoveryStrategy: string;
  sessionDomain: TaskDomain;
  taskComplexity: number;
  tokenCount: number;
  contextUtilization: number;
  sessionAge: number;
  todoCount: number;
  recentToolFailureRate: number;
  
  // Intervention details
  customPrompt: string;
  proactiveIntervention: boolean;
  
  // Outcome
  success: boolean;
  timeToRecovery: number;
  messagesUntilNextStall: number;
  userTookOver: boolean;
  taskCompleted: boolean;
  
  // Derived metrics
  effectivenessScore: number;
}

/**
 * Strategy performance statistics in the learning database.
 */
export interface StrategyPerformanceRecord {
  /** Strategy ID */
  strategyId: string;
  
  /** Stall pattern */
  stallPattern: StallPatternType;
  
  /** Session domain */
  sessionDomain: TaskDomain;
  
  // Statistics
  totalAttempts: number;
  successes: number;
  failures: number;
  partials: number;
  
  // Time metrics
  avgTimeToRecovery: number;
  minTimeToRecovery: number;
  maxTimeToRecovery: number;
  
  // Effectiveness (current EMA value)
  currentEffectiveness: number;
  
  // Trend
  trend: EffectivenessTrend;
  
  /** Last update timestamp */
  lastUpdated: number;
}

/** Effectiveness trend direction */
export type EffectivenessTrend = "improving" | "stable" | "declining";

/**
 * Discovered stall pattern.
 */
export interface DiscoveredPattern {
  /** Unique identifier */
  id: string;
  
  /** Human-readable name */
  name: string;
  
  /** Characteristics that define this pattern */
  characteristics: PatternCharacteristics;
  
  /** How many times observed */
  frequency: number;
  
  /** When first observed */
  firstSeen: number;
  
  /** Recommended strategy for this pattern */
  recommendedStrategy: string;
}

/** Characteristics that define a stall pattern */
export interface PatternCharacteristics {
  /** Typical token count range */
  tokenRange: { min: number; max: number };
  
  /** Typical session age range in ms */
  ageRange: { min: number; max: number };
  
  /** Common tool failures */
  toolFailures: string[];
  
  /** Reasoning keywords */
  reasoningKeywords: string[];
  
  /** Typical domains */
  domains: TaskDomain[];
}

/**
 * User preference record (learned implicitly).
 */
export interface UserPreferenceRecord {
  /** Anonymous user hash */
  userId: string;
  
  /** Inferred autonomy level preference */
  preferredAutonomyLevel: AutonomyLevel;
  
  /** Patience multiplier for timeouts */
  patienceFactor: number;
  
  /** Domain-specific preferences */
  domainPreferences: Record<TaskDomain, DomainPreference>;
  
  /** Last updated */
  lastUpdated: number;
}

/** Domain-specific preferences */
export interface DomainPreference {
  preferredStrategy: string;
  customTimeoutMs: number;
  effectivenessMultiplier: number;
}

// ============================================================================
// META-COGNITION
// ============================================================================

/**
 * Current meta-cognitive state of the system.
 */
export interface MetaCognitiveState {
  // Session-level metrics
  interventionFrequency: number;
  interventionEffectiveness: number;
  userOverrideRate: number;
  
  // System-level metrics
  globalRecoveryRate: number;
  averageTimeToCompletion: number;
  strategyPerformance: Map<string, number>;
  parameterEffectiveness: Map<string, number>;
  
  // Trends
  recoveryTrend: EffectivenessTrend;
  autonomyTrend: EffectivenessTrend;
}

/**
 * Suggested parameter adaptation.
 */
export interface ParameterAdaptation {
  /** Parameter name */
  parameter: string;
  
  /** Current value */
  currentValue: number | string | boolean;
  
  /** Suggested new value */
  suggestedValue: number | string | boolean;
  
  /** Human-readable explanation */
  reason: string;
  
  /** Confidence in this suggestion (0-1) */
  confidence: number;
  
  /** Whether to apply automatically */
  autoApply: boolean;
}

/**
 * Meta-cognitive performance report.
 */
export interface MetaCognitiveReport {
  /** Report period */
  period: { start: number; end: number };
  
  // Recovery performance
  totalRecoveries: number;
  successRate: number;
  avgTimeToRecovery: number;
  mostCommonPattern: StallPatternType;
  mostEffectiveStrategy: string;
  
  // Learning progress
  strategiesImproved: number;
  strategiesDeclined: number;
  newPatternsDiscovered: number;
  parametersAdapted: number;
  
  // Predictive performance
  predictionsMade: number;
  predictionAccuracy: number;
  interventionsPrevented: number;
  
  // User impact
  userOverrides: number;
  userOverrideRate: number;
  avgSessionAutonomy: number;
  
  // Recommendations
  recommendations: string[];
}

// ============================================================================
// SESSION ORCHESTRATION (v7.5)
// ============================================================================

/**
 * Plan for coordinating multiple sessions.
 */
export interface OrchestrationPlan {
  /** Individual session configurations */
  sessions: SessionConfig[];
  
  /** Dependency graph between sessions */
  dependencies: DependencyGraph;
  
  /** Checkpoint definitions */
  checkpoints: Checkpoint[];
  
  /** Rollback configuration */
  rollbackStrategy: RollbackConfig;
}

/** Configuration for a single session in an orchestration */
export interface SessionConfig {
  /** Unique session identifier */
  id: string;
  
  /** Purpose/goal of this session */
  purpose: string;
  
  /** AI model to use */
  model: string;
  
  /** Context budget in tokens */
  contextBudget: number;
  
  /** Parent session ID (for context transfer) */
  parentSession?: string;
  
  /** Child session IDs */
  childSessions: string[];
  
  /** Autonomy level for this session */
  autonomyLevel: AutonomyLevel;
}

/** Dependency graph between sessions */
export interface DependencyGraph {
  /** Map of session ID -> sessions it depends on */
  dependencies: Record<string, string[]>;
  
  /** Execution order (topological sort) */
  executionOrder: string[];
  
  /** Sessions that can run in parallel */
  parallelGroups: string[][];
}

/** Checkpoint for save/restore */
export interface Checkpoint {
  /** Checkpoint ID */
  id: string;
  
  /** Session ID */
  sessionId: string;
  
  /** When created */
  timestamp: number;
  
  /** Checkpoint label */
  label: string;
  
  /** Serialized session state */
  state: CheckpointState;
}

/** Serializable checkpoint state */
export interface CheckpointState {
  intent: SessionIntent;
  taskGraph: TaskGraph;
  progress: number;
  estimatedTokens: number;
  todoState: unknown[];
  contextSummary: string;
}

/** Rollback configuration */
export interface RollbackConfig {
  /** Number of checkpoints to keep */
  maxCheckpoints: number;
  
  /** Auto-rollback on failure */
  autoRollback: boolean;
  
  /** Which failures trigger rollback */
  rollbackTriggers: string[];
}

// ============================================================================
// UTILITY TYPES
// ============================================================================

/**
 * Result wrapper for operations that can fail.
 */
export interface Result<T, E = Error> {
  success: boolean;
  data?: T;
  error?: E;
}

/**
 * Time range for querying historical data.
 */
export interface TimeRange {
  start: number;
  end: number;
}

/**
 * Health status of a session.
 */
export interface HealthStatus {
  /** Overall health score (0-1) */
  score: number;
  
  /** Is the session on track? */
  onTrack: boolean;
  
  /** Risk factors */
  risks: string[];
  
  /** Suggested actions */
  suggestions: string[];
}

/**
 * Focus recommendation for the current task.
 */
export interface FocusRecommendation {
  /** Current task description */
  taskDescription: string;
  
  /** What to focus on next */
  nextFocus: string;
  
  /** Optional hint */
  hint?: string;
  
  /** Estimated time remaining */
  estimatedTimeRemaining: number;
}

// ============================================================================
// MODULE DEPENDENCY TYPES
// ============================================================================

/**
 * Dependencies for the AutonomousCore module.
 */
export interface AutonomousCoreDeps {
  log: (...args: unknown[]) => void;
  config: AutonomyConfig;
}

/**
 * Dependencies for the PredictiveEngine module.
 */
export interface PredictiveEngineDeps {
  log: (...args: unknown[]) => void;
  config: AutonomyConfig;
  sessions: Map<string, unknown>; // SessionState
}

/**
 * Dependencies for the AdaptiveRecovery module.
 */
export interface AdaptiveRecoveryDeps {
  log: (...args: unknown[]) => void;
  config: AutonomyConfig;
  sessions: Map<string, unknown>;
  learningDB: LearningDatabase;
}

/**
 * Dependencies for the MetaCognition module.
 */
export interface MetaCognitionDeps {
  log: (...args: unknown[]) => void;
  config: AutonomyConfig;
  learningDB: LearningDatabase;
}

/**
 * Interface for the learning database.
 */
export interface LearningDatabase {
  /** Record a recovery outcome */
  recordOutcome(record: RecoveryRecord): Promise<void>;
  
  /** Get strategy effectiveness */
  getEffectiveness(strategyId: string, pattern: StallPatternType, domain: TaskDomain): Promise<number>;
  
  /** Update strategy performance */
  updatePerformance(strategyId: string, pattern: StallPatternType, domain: TaskDomain, outcome: RecoveryResult): Promise<void>;
  
  /** Get recent records */
  getRecentRecords(timeRange: TimeRange): Promise<RecoveryRecord[]>;
  
  /** Get strategy performance report */
  getStrategyPerformance(strategyId: string): Promise<StrategyPerformanceRecord[]>;
  
  /** Discover new patterns */
  discoverPatterns(): Promise<DiscoveredPattern[]>;
  
  /** Get user preferences */
  getUserPreferences(userId: string): Promise<UserPreferenceRecord | undefined>;
  
  /** Close database connection */
  close(): Promise<void>;
}

// ============================================================================
// EXPORTS
// ============================================================================

// Re-export removed to break circular dependency chain
