/**
 * Auto-Continue v7.0 - Autonomous Core Module
 * 
 * This module extracts session intent, builds task graphs, and tracks progress
 * toward goals. It's the foundation for autonomous session management.
 */

import type {
  SessionIntent,
  TaskGraph,
  TaskNode,
  TaskDomain,
  TaskStatus,
  IntentExtractionResult,
  IntentAnalysis,
  HealthStatus,
  FocusRecommendation,
  AutonomousCoreDeps,
} from "./autonomy-types.js";

/**
 * Create the AutonomousCore module.
 */
export function createAutonomousCore(deps: AutonomousCoreDeps) {
  const { log, config } = deps;
  const intents = new Map<string, SessionIntent>();
  
  return {
    /**
     * Extract intent from a user prompt.
     * 
     * Analyzes the prompt to understand:
     * - Primary goal
     * - Domain (refactoring, feature, bugfix, etc.)
     * - Complexity estimate
     * - Ambiguities that need clarification
     */
    extractIntent: async (sessionId: string, prompt: string): Promise<IntentExtractionResult> => {
      if (!config.intentExtraction) {
        return createFallbackResult(sessionId, prompt);
      }
      
      try {
        log(`[AutonomousCore] Extracting intent for session ${sessionId}`);
        
        const analysis = analyzePrompt(prompt);
        const confidence = calculateConfidence(analysis);
        
        const intent: SessionIntent = {
          primaryGoal: extractPrimaryGoal(prompt, analysis),
          domain: (Object.entries(analysis.domainScores)[0]?.[0] as TaskDomain) || "unknown",
          taskGraph: createInitialTaskGraph(analysis),
          currentTaskId: "root",
          sessionStartTime: Date.now(),
          estimatedTotalTime: estimateTotalTime(analysis),
          confidence,
          blockers: analysis.ambiguities,
        };
        
        intents.set(sessionId, intent);
        
        log(`[AutonomousCore] Intent extracted: "${intent.primaryGoal}" (${intent.domain}, confidence: ${confidence.toFixed(2)})`);
        
        return {
          intent,
          success: confidence >= 0.5,
          analysis,
        };
      } catch (error) {
        log(`[AutonomousCore] Intent extraction failed:`, error);
        return createFallbackResult(sessionId, prompt);
      }
    },
    
    /**
     * Get the current intent for a session.
     */
    getIntent: (sessionId: string): SessionIntent | undefined => {
      return intents.get(sessionId);
    },
    
    /**
     * Build or update task graph from todo list.
     */
    buildTaskGraph: async (sessionId: string, todos: TodoItem[]): Promise<TaskGraph> => {
      const intent = intents.get(sessionId);
      
      const nodes = new Map<string, TaskNode>();
      
      // Create root node
      const rootNode: TaskNode = {
        id: "root",
        description: intent?.primaryGoal || "Session tasks",
        status: "in_progress",
        dependencies: [],
        estimatedEffort: 0,
        actualEffortMs: 0,
        complexity: intent?.taskGraph.root.complexity || 5,
        domain: intent?.domain || "unknown",
        subtasks: [],
        createdAt: Date.now(),
      };
      nodes.set("root", rootNode);
      
      // Create nodes from todos
      let maxDepth = 1;
      for (const todo of todos) {
        const node: TaskNode = {
          id: todo.id,
          description: todo.content || todo.title || "Unknown task",
          status: mapTodoStatus(todo.status),
          dependencies: [],
          estimatedEffort: 10, // Default 10 minutes
          actualEffortMs: 0,
          complexity: 5,
          domain: intent?.domain || "unknown",
          parentId: "root",
          subtasks: [],
          createdAt: Date.now(),
        };
        nodes.set(todo.id, node);
        rootNode.subtasks.push(todo.id);
        maxDepth = Math.max(maxDepth, 2);
      }
      
      const graph: TaskGraph = {
        root: rootNode,
        nodes,
        maxDepth,
      };
      
      // Update intent with new graph
      if (intent) {
        intent.taskGraph = graph;
        // Update current task to first in_progress task
        const firstInProgress = Array.from(nodes.values())
          .find(n => n.status === "in_progress" && n.id !== "root");
        if (firstInProgress) {
          intent.currentTaskId = firstInProgress.id;
        }
      }
      
      return graph;
    },
    
    /**
     * Update task progress based on activity.
     */
    updateTaskProgress: async (sessionId: string, activity: ActivityEvent): Promise<void> => {
      const intent = intents.get(sessionId);
      if (!intent) return;
      
      const { taskGraph } = intent;
      
      switch (activity.type) {
        case "tool_call":
          // Tool calls suggest work on current task
          updateTaskEffort(taskGraph, intent.currentTaskId, activity.durationMs || 0);
          break;
          
        case "file_modify":
          // File modifications may indicate task completion
          if (activity.filePath) {
            const matchingTask = findTaskByFile(taskGraph, activity.filePath);
            if (matchingTask && activity.isCompletion) {
              matchingTask.status = "completed";
              matchingTask.completedAt = Date.now();
            }
          }
          break;
          
        case "todo_update":
          // Todo updates directly reflect task status
          if (activity.todoId) {
            const task = taskGraph.nodes.get(activity.todoId);
            if (task) {
              task.status = mapTodoStatus(activity.newStatus || "pending");
              if (task.status === "completed") {
                task.completedAt = Date.now();
              }
            }
          }
          break;
          
        case "message":
          // Messages may indicate task switching
          if (activity.suggestsTaskSwitch && activity.content) {
            const newTask = findTaskByDescription(taskGraph, activity.content);
            if (newTask) {
              intent.currentTaskId = newTask.id;
            }
          }
          break;
      }
      
      // Update root progress
      updateRootProgress(taskGraph);
    },
    
    /**
     * Get current focus recommendation.
     */
    getCurrentFocus: (sessionId: string): FocusRecommendation => {
      const intent = intents.get(sessionId);
      if (!intent) {
        return {
          taskDescription: "No intent available",
          nextFocus: "Start working",
          estimatedTimeRemaining: 0,
        };
      }
      
      const currentTask = intent.taskGraph.nodes.get(intent.currentTaskId);
      const pendingTasks = Array.from(intent.taskGraph.nodes.values())
        .filter(n => n.status === "pending" || n.status === "in_progress");
      
      return {
        taskDescription: currentTask?.description || intent.primaryGoal,
        nextFocus: pendingTasks[0]?.description || "Complete session",
        hint: generateHint(intent, currentTask),
        estimatedTimeRemaining: calculateRemainingTime(intent),
      };
    },
    
    /**
     * Check if session is on track.
     */
    isOnTrack: (sessionId: string): HealthStatus => {
      const intent = intents.get(sessionId);
      if (!intent) {
        return { score: 0.5, onTrack: true, risks: [], suggestions: [] };
      }
      
      const elapsed = Date.now() - intent.sessionStartTime;
      const estimated = intent.estimatedTotalTime * 60 * 1000; // Convert to ms
      
      const completedTasks = Array.from(intent.taskGraph.nodes.values())
        .filter(n => n.status === "completed").length;
      const totalTasks = intent.taskGraph.nodes.size - 1; // Exclude root
      
      const progressRatio = totalTasks > 0 ? completedTasks / totalTasks : 0;
      const timeRatio = estimated > 0 ? elapsed / estimated : 0;
      
      const score = Math.max(0, Math.min(1, progressRatio / Math.max(timeRatio, 0.1)));
      // For newly started sessions (little time elapsed), default to neutral-positive score
      const adjustedScore = timeRatio < 0.1 ? 0.8 : score;
      // Consider on track if: score is good, OR just started (little time elapsed), OR all done
      const onTrack = adjustedScore >= 0.7 || timeRatio < 0.1 || progressRatio >= 1;
      
      const risks: string[] = [];
      const suggestions: string[] = [];
      
      if (timeRatio > 1.5 && progressRatio < 0.5) {
        risks.push("Significantly behind schedule");
        suggestions.push("Consider breaking remaining tasks into smaller pieces");
      }
      
      if (intent.blockers.length > 0) {
        risks.push(`Blockers identified: ${intent.blockers.join(", ")}`);
      }
      
      return { score: adjustedScore, onTrack, risks, suggestions };
    },
    
    /**
     * Suggest task decomposition if needed.
     */
    suggestDecomposition: (sessionId: string): TaskNode[] => {
      const intent = intents.get(sessionId);
      if (!intent) return [];
      
      const suggestions: TaskNode[] = [];
      
      for (const [id, node] of intent.taskGraph.nodes) {
        if (id === "root") continue;
        
        // Suggest decomposition for complex, in-progress tasks
        if (node.complexity > 7 && node.status === "in_progress" && node.subtasks.length === 0) {
          suggestions.push(node);
        }
      }
      
      return suggestions;
    },
    
    /**
     * Clear intent for a session (cleanup).
     */
    clearIntent: (sessionId: string): void => {
      intents.delete(sessionId);
    },
  };
}

// ============================================================================
// Intent Extraction Helpers
// ============================================================================

interface TodoItem {
  id: string;
  content?: string;
  title?: string;
  status: string;
}

interface ActivityEvent {
  type: "tool_call" | "file_modify" | "todo_update" | "message";
  durationMs?: number;
  filePath?: string;
  isCompletion?: boolean;
  todoId?: string;
  newStatus?: string;
  suggestsTaskSwitch?: boolean;
  content?: string;
}

/** Domain keywords for classification */
const DOMAIN_KEYWORDS: Record<TaskDomain, string[]> = {
  refactoring: ["refactor", "restructure", "cleanup", "simplify", "rename", "move", "extract", "consolidate"],
  feature: ["implement", "add", "create", "build", "support", "enable", "introduce", "new feature"],
  bugfix: ["fix", "bug", "issue", "error", "crash", "resolve", "repair", "correct", "broken"],
  testing: ["test", "spec", "coverage", "assert", "mock", "jest", "vitest", "cypress", "playwright"],
  documentation: ["doc", "readme", "comment", "guide", "explain", "document", "wiki", "manual"],
  optimization: ["optimize", "performance", "speed", "cache", "memory", "cpu", "benchmark", "faster"],
  setup: ["setup", "install", "configure", "init", "bootstrap", "deploy", "build", "ci", "docker"],
  unknown: [],
};

/** Complexity indicators */
const COMPLEXITY_INDICATORS = {
  high: ["architecture", "redesign", "migration", "rewrite", "integration", "protocol", "algorithm"],
  medium: ["refactor", "implement", "feature", "module", "component", "service"],
  low: ["fix", "update", "tweak", "adjust", "typo", "comment", "format", "lint"],
};

function analyzePrompt(prompt: string): IntentAnalysis {
  const lowerPrompt = prompt.toLowerCase();
  
  // Extract keywords
  const keywords = extractKeywords(prompt);
  
  // Classify domain
  const domainScores = classifyDomain(lowerPrompt);
  
  // Estimate complexity
  const complexityEstimate = estimateComplexity(lowerPrompt);
  
  // Suggest steps
  const suggestedSteps = suggestSteps(domainScores[0]?.[0] as TaskDomain || "unknown", keywords);
  
  // Find ambiguities
  const ambiguities = findAmbiguities(prompt);
  
  return {
    keywords,
    domainScores: Object.fromEntries(domainScores) as Record<TaskDomain, number>,
    complexityEstimate,
    suggestedSteps,
    ambiguities,
  };
}

function extractKeywords(prompt: string): string[] {
  // Simple keyword extraction - split by spaces and filter
  const words = prompt.toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 3)
    .filter(w => !isStopWord(w));
  
  // Return unique keywords
  return [...new Set(words)].slice(0, 10);
}

function isStopWord(word: string): boolean {
  const stopWords = new Set([
    "the", "and", "for", "are", "but", "not", "you", "all", "can", "had", "her", "was", "one", "our", "out", "day", "get", "has", "him", "his", "how", "man", "new", "now", "old", "see", "two", "way", "who", "boy", "did", "its", "let", "put", "say", "she", "too", "use",
  ]);
  return stopWords.has(word);
}

function classifyDomain(prompt: string): Array<[TaskDomain, number]> {
  const scores: Array<[TaskDomain, number]> = [];
  
  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    let score = 0;
    for (const keyword of keywords) {
      if (prompt.includes(keyword)) {
        score += keyword.length; // Longer matches = more specific
      }
    }
    scores.push([domain as TaskDomain, score]);
  }
  
  // Sort by score descending
  scores.sort((a, b) => b[1] - a[1]);
  
  // Normalize scores
  const maxScore = scores[0][1];
  if (maxScore > 0) {
    for (let i = 0; i < scores.length; i++) {
      scores[i] = [scores[i][0], scores[i][1] / maxScore];
    }
  }
  
  return scores;
}

function estimateComplexity(prompt: string): number {
  let score = 5; // Default medium
  
  for (const indicator of COMPLEXITY_INDICATORS.high) {
    if (prompt.includes(indicator)) score += 2;
  }
  for (const indicator of COMPLEXITY_INDICATORS.medium) {
    if (prompt.includes(indicator)) score += 1;
  }
  for (const indicator of COMPLEXITY_INDICATORS.low) {
    if (prompt.includes(indicator)) score -= 1;
  }
  
  // Adjust by length (longer prompts tend to be more complex)
  if (prompt.length > 200) score += 1;
  if (prompt.length > 500) score += 1;
  
  return Math.max(1, Math.min(10, score));
}

function suggestSteps(domain: TaskDomain, keywords: string[]): string[] {
  const steps: string[] = [];
  
  switch (domain) {
    case "refactoring":
      steps.push("Analyze current code structure");
      steps.push("Identify refactoring targets");
      steps.push("Apply refactoring changes");
      steps.push("Run tests to verify");
      break;
    case "feature":
      steps.push("Design the feature interface");
      steps.push("Implement core functionality");
      steps.push("Add error handling");
      steps.push("Write tests");
      break;
    case "bugfix":
      steps.push("Reproduce the bug");
      steps.push("Identify root cause");
      steps.push("Implement fix");
      steps.push("Verify fix with tests");
      break;
    case "testing":
      steps.push("Identify test scenarios");
      steps.push("Write test cases");
      steps.push("Implement test helpers");
      steps.push("Run and verify coverage");
      break;
    case "documentation":
      steps.push("Identify documentation gaps");
      steps.push("Write documentation");
      steps.push("Add code examples");
      steps.push("Review for clarity");
      break;
    default:
      steps.push("Understand requirements");
      steps.push("Plan implementation");
      steps.push("Execute plan");
      steps.push("Verify results");
  }
  
  return steps;
}

function findAmbiguities(prompt: string): string[] {
  const ambiguities: string[] = [];
  const lowerPrompt = prompt.toLowerCase();
  
  // Check for vague terms
  if (lowerPrompt.includes("improve") || lowerPrompt.includes("better")) {
    ambiguities.push("Vague improvement goal - specific criteria needed");
  }
  if (lowerPrompt.includes("etc") || lowerPrompt.includes("and so on")) {
    ambiguities.push("Incomplete requirements list");
  }
  if (lowerPrompt.includes("maybe") || lowerPrompt.includes("possibly")) {
    ambiguities.push("Uncertain requirements");
  }
  if (lowerPrompt.includes("fast") || lowerPrompt.includes("quick")) {
    ambiguities.push("No specific performance targets");
  }
  
  return ambiguities;
}

function extractPrimaryGoal(prompt: string, analysis: IntentAnalysis): string {
  // Try to extract the main action/objective from the prompt
  const sentences = prompt.split(/[.!?]/).filter(s => s.trim().length > 0);
  
  if (sentences.length > 0) {
    const firstSentence = sentences[0].trim();
    // Limit to reasonable length
    if (firstSentence.length <= 100) {
      return firstSentence;
    }
    return firstSentence.substring(0, 100) + "...";
  }
  
  return analysis.keywords.slice(0, 5).join(" ") || "Session goal";
}

function calculateConfidence(analysis: IntentAnalysis): number {
  let score = 0.5; // Base confidence
  
  // Boost for clear domain classification
  const topDomainScore = Object.values(analysis.domainScores)[0] || 0;
  score += topDomainScore * 0.2;
  
  // Boost for keyword richness
  score += Math.min(0.2, analysis.keywords.length * 0.02);
  
  // Penalize ambiguities
  score -= analysis.ambiguities.length * 0.1;
  
  // Boost for clear structure (multiple sentences)
  score += analysis.suggestedSteps.length > 2 ? 0.1 : 0;
  
  return Math.max(0, Math.min(1, score));
}

function estimateTotalTime(analysis: IntentAnalysis): number {
  // Rough estimate in minutes based on complexity
  return analysis.complexityEstimate * 10;
}

function createInitialTaskGraph(analysis: IntentAnalysis): TaskGraph {
  const rootNode: TaskNode = {
    id: "root",
    description: "Session goal",
    status: "in_progress",
    dependencies: [],
    estimatedEffort: estimateTotalTime(analysis),
    actualEffortMs: 0,
    complexity: analysis.complexityEstimate,
    domain: Object.entries(analysis.domainScores)[0]?.[0] as TaskDomain || "unknown",
    subtasks: [],
    createdAt: Date.now(),
  };
  
  const nodes = new Map<string, TaskNode>();
  nodes.set("root", rootNode);
  
  // Add suggested steps as subtasks
  for (let i = 0; i < analysis.suggestedSteps.length; i++) {
    const stepNode: TaskNode = {
      id: `step-${i}`,
      description: analysis.suggestedSteps[i],
      status: i === 0 ? "in_progress" : "pending",
      dependencies: i > 0 ? [`step-${i - 1}`] : [],
      estimatedEffort: 10,
      actualEffortMs: 0,
      complexity: Math.max(1, analysis.complexityEstimate - 2),
      domain: rootNode.domain,
      parentId: "root",
      subtasks: [],
      createdAt: Date.now(),
    };
    nodes.set(stepNode.id, stepNode);
    rootNode.subtasks.push(stepNode.id);
  }
  
  return {
    root: rootNode,
    nodes,
    maxDepth: 2,
  };
}

function createFallbackResult(sessionId: string, prompt: string): IntentExtractionResult {
  const intent: SessionIntent = {
    primaryGoal: prompt.substring(0, 100) || "Session goal",
    domain: "unknown",
    taskGraph: {
      root: {
        id: "root",
        description: "Session goal",
        status: "in_progress",
        dependencies: [],
        estimatedEffort: 60,
        actualEffortMs: 0,
        complexity: 5,
        domain: "unknown",
        subtasks: [],
        createdAt: Date.now(),
      },
      nodes: new Map(),
      maxDepth: 1,
    },
    currentTaskId: "root",
    sessionStartTime: Date.now(),
    estimatedTotalTime: 60,
    confidence: 0.3,
    blockers: [],
  };
  
  return {
    intent,
    success: false,
    analysis: {
      keywords: [],
      domainScores: { unknown: 1.0 } as Record<TaskDomain, number>,
      complexityEstimate: 5,
      suggestedSteps: [],
      ambiguities: ["Intent extraction disabled or failed"],
    },
  };
}

// ============================================================================
// Task Graph Helpers
// ============================================================================

function mapTodoStatus(status: string): TaskStatus {
  switch (status.toLowerCase()) {
    case "completed":
    case "done":
      return "completed";
    case "in_progress":
    case "active":
      return "in_progress";
    case "blocked":
    case "waiting":
      return "blocked";
    case "cancelled":
    case "abandoned":
      return "cancelled";
    default:
      return "pending";
  }
}

function updateTaskEffort(graph: TaskGraph, taskId: string, durationMs: number): void {
  const task = graph.nodes.get(taskId);
  if (task) {
    task.actualEffortMs += durationMs;
  }
  // Also accumulate on root for overall session tracking
  const root = graph.nodes.get("root");
  if (root) {
    root.actualEffortMs += durationMs;
  }
}

function findTaskByFile(graph: TaskGraph, filePath: string): TaskNode | undefined {
  // Simple heuristic: check if task description mentions the file
  for (const [id, node] of graph.nodes) {
    if (id === "root") continue;
    const fileName = filePath.split("/").pop()?.toLowerCase() || "";
    if (node.description.toLowerCase().includes(fileName)) {
      return node;
    }
  }
  return undefined;
}

function findTaskByDescription(graph: TaskGraph, content: string): TaskNode | undefined {
  const lowerContent = content.toLowerCase();
  let bestMatch: TaskNode | undefined;
  let bestScore = 0;
  
  for (const [id, node] of graph.nodes) {
    if (id === "root") continue;
    const lowerDesc = node.description.toLowerCase();
    
    // Simple word overlap scoring
    const words = lowerDesc.split(/\s+/);
    let score = 0;
    for (const word of words) {
      if (word.length > 3 && lowerContent.includes(word)) {
        score += 1;
      }
    }
    
    if (score > bestScore) {
      bestScore = score;
      bestMatch = node;
    }
  }
  
  return bestMatch;
}

function updateRootProgress(graph: TaskGraph): void {
  const completedTasks = Array.from(graph.nodes.values())
    .filter(n => n.id !== "root" && n.status === "completed").length;
  const totalTasks = graph.nodes.size - 1; // Exclude root
  
  if (totalTasks > 0 && completedTasks === totalTasks) {
    graph.root.status = "completed";
    graph.root.completedAt = Date.now();
  }
}

function generateHint(intent: SessionIntent, currentTask?: TaskNode): string | undefined {
  if (!currentTask) return undefined;
  
  const pendingDeps = currentTask.dependencies
    .map(id => intent.taskGraph.nodes.get(id))
    .filter(n => n && n.status !== "completed");
  
  if (pendingDeps.length > 0) {
    return `Complete dependencies first: ${pendingDeps.map(n => n!.description).join(", ")}`;
  }
  
  if (currentTask.complexity > 7) {
    return "This is a complex task. Consider breaking it down.";
  }
  
  return undefined;
}

function calculateRemainingTime(intent: SessionIntent): number {
  let remaining = 0;
  for (const [id, node] of intent.taskGraph.nodes) {
    if (id === "root") continue;
    if (node.status !== "completed") {
      const elapsed = node.actualEffortMs;
      const estimated = node.estimatedEffort * 60 * 1000;
      remaining += Math.max(0, estimated - elapsed);
    }
  }
  return Math.round(remaining / (60 * 1000)); // Convert to minutes
}
