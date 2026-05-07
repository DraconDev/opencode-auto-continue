/**
 * Auto-Continue v7.0 - Strategy Pool Module
 * 
 * Defines recovery strategies and manages their selection based on
 * context, effectiveness, and stall patterns.
 */

import type {
  RecoveryStrategy,
  RecoveryContext,
  RecoveryResult,
  StallPatternType,
  StrategyPriority,
} from "./autonomy-types.js";

/**
 * Create the strategy pool with all built-in strategies.
 */
export function createStrategyPool() {
  const strategies: Map<string, RecoveryStrategy> = new Map();
  
  // Register all built-in strategies
  for (const strategy of BUILT_IN_STRATEGIES) {
    strategies.set(strategy.id, strategy);
  }
  
  return {
    /**
     * Get all active strategies.
     */
    getAll: (): RecoveryStrategy[] => {
      return Array.from(strategies.values())
        .filter(s => s.priority !== "disabled");
    },
    
    /**
     * Get strategies applicable to a specific pattern.
     */
    getForPattern: (pattern: StallPatternType): RecoveryStrategy[] => {
      return Array.from(strategies.values())
        .filter(s => s.priority !== "disabled")
        .filter(s => s.applicablePatterns.includes(pattern));
    },
    
    /**
     * Get a specific strategy by ID.
     */
    get: (id: string): RecoveryStrategy | undefined => {
      return strategies.get(id);
    },
    
    /**
     * Register a custom strategy.
     */
    register: (strategy: RecoveryStrategy): void => {
      strategies.set(strategy.id, strategy);
    },
    
    /**
     * Update strategy effectiveness.
     */
    updateEffectiveness: (id: string, effectiveness: number): void => {
      const strategy = strategies.get(id);
      if (strategy) {
        strategy.effectiveness = Math.max(0, Math.min(1, effectiveness));
        
        // Update priority based on effectiveness
        if (strategy.effectiveness > 0.8) {
          strategy.priority = "primary";
        } else if (strategy.effectiveness < 0.3) {
          strategy.priority = "fallback";
        }
      }
    },
    
    /**
     * Disable a strategy.
     */
    disable: (id: string): void => {
      const strategy = strategies.get(id);
      if (strategy) {
        strategy.priority = "disabled";
      }
    },
    
    /**
     * Enable a previously disabled strategy.
     */
    enable: (id: string): void => {
      const strategy = strategies.get(id);
      if (strategy) {
        strategy.priority = strategy.effectiveness > 0.5 ? "secondary" : "fallback";
      }
    },
    
    /**
     * Get effectiveness report for all strategies.
     */
    getReport: (): StrategyReport[] => {
      return Array.from(strategies.values()).map(s => ({
        id: s.id,
        name: s.name,
        priority: s.priority,
        effectiveness: s.effectiveness,
        applicablePatterns: s.applicablePatterns,
      }));
    },
  };
}

export interface StrategyReport {
  id: string;
  name: string;
  priority: StrategyPriority;
  effectiveness: number;
  applicablePatterns: StallPatternType[];
}

// ============================================================================
// Built-in Strategies
// ============================================================================

/**
 * Strategy 1: Gentle Guidance
 * 
 * For reasoning loops and confusion. Doesn't abort, sends a gentle
 * suggestion to help the model break out of its thought pattern.
 */
const gentleGuidanceStrategy: RecoveryStrategy = {
  id: "gentle-guidance",
  name: "Gentle Guidance",
  description: "Sends a helpful suggestion without aborting. Best for reasoning loops.",
  applicablePatterns: ["reasoning-loop", "confusion", "mixed-progress"],
  priority: "primary",
  effectiveness: 0.85,
  requiresAbort: false,
  maxMessageLength: 200,
  
  execute: async (sessionId: string, context: RecoveryContext): Promise<RecoveryResult> => {
    const message = gentleGuidanceStrategy.generateMessage(context);
    
    // In a real implementation, this would send the message via the SDK
    // For now, we simulate success
    return {
      success: true,
      timeToRecovery: 15000, // 15 seconds
      messagesUntilNextStall: 5,
      userTookOver: false,
      taskCompleted: false,
      strategyId: gentleGuidanceStrategy.id,
      message,
      aborted: false,
    };
  },
  
  generateMessage: (context: RecoveryContext): string => {
    const { intent, stallPattern, recoveryAttempts } = context;
    const task = intent?.taskGraph.nodes.get(intent?.currentTaskId || "");
    
    if (stallPattern === "reasoning-loop") {
      return `You've been analyzing for a while. Consider testing your hypothesis${task ? ` on "${task.description}"` : ""}. Sometimes writing a quick test reveals the answer faster than continued analysis.`;
    }
    
    if (stallPattern === "confusion") {
      return `You seem to be exploring different approaches. Let's focus on one path: ${task?.description || "the current task"}. What's the simplest next step you can take?`;
    }
    
    return `You've been working on this for a while. Try a different approach or break the problem into smaller pieces.`;
  },
};

/**
 * Strategy 2: Direct Intervention
 * 
 * For tool failures and clear errors. Aborts and sends specific
 * instructions to fix the problem.
 */
const directInterventionStrategy: RecoveryStrategy = {
  id: "direct-intervention",
  name: "Direct Intervention",
  description: "Aborts and sends specific error-focused guidance. Best for tool failures.",
  applicablePatterns: ["tool-failure", "api-delay"],
  priority: "primary",
  effectiveness: 0.78,
  requiresAbort: true,
  maxMessageLength: 200,
  
  execute: async (sessionId: string, context: RecoveryContext): Promise<RecoveryResult> => {
    const message = directInterventionStrategy.generateMessage(context);
    
    return {
      success: true,
      timeToRecovery: 10000, // 10 seconds
      messagesUntilNextStall: 8,
      userTookOver: false,
      taskCompleted: false,
      strategyId: directInterventionStrategy.id,
      message,
      aborted: true,
    };
  },
  
  generateMessage: (context: RecoveryContext): string => {
    const { stallPattern, recentMessages } = context;
    
    if (stallPattern === "tool-failure") {
      // Try to extract error from recent messages
      const errorMessage = extractErrorFromMessages(recentMessages);
      if (errorMessage) {
        return `The last tool call failed with: "${errorMessage.substring(0, 80)}...". Check the error details and retry with corrected parameters.`;
      }
      return "The last tool call failed. Review the error message and retry with corrected parameters.";
    }
    
    if (stallPattern === "api-delay") {
      return "The external API seems slow or unresponsive. Wait a moment and retry, or check if there's a service status issue.";
    }
    
    return "There was an error. Review the details and try again with corrections.";
  },
};

/**
 * Strategy 3: Context Compaction
 * 
 * For context bloat. Triggers compaction and sends a refocus message.
 */
const contextCompactionStrategy: RecoveryStrategy = {
  id: "context-compaction",
  name: "Context Compaction",
  description: "Compacts context and sends refocus message. Best for token limit issues.",
  applicablePatterns: ["context-bloat"],
  priority: "primary",
  effectiveness: 0.72,
  requiresAbort: true,
  maxMessageLength: 150,
  
  execute: async (sessionId: string, context: RecoveryContext): Promise<RecoveryResult> => {
    const message = contextCompactionStrategy.generateMessage(context);
    
    return {
      success: true,
      timeToRecovery: 20000, // 20 seconds (compaction takes time)
      messagesUntilNextStall: 10,
      userTookOver: false,
      taskCompleted: false,
      strategyId: contextCompactionStrategy.id,
      message,
      aborted: true,
    };
  },
  
  generateMessage: (context: RecoveryContext): string => {
    const { tokenCount, contextLimit } = context;
    const utilization = contextLimit > 0 ? Math.round((tokenCount / contextLimit) * 100) : 0;
    
    return `Context is getting large (${utilization}% full). Let me compact it to free up space. Continue with the current task after compaction completes.`;
  },
};

/**
 * Strategy 4: Task Refocus
 * 
 * For todo overwhelm. Aborts and focuses on a single task.
 */
const taskRefocusStrategy: RecoveryStrategy = {
  id: "task-refocus",
  name: "Task Refocus",
  description: "Focuses on a single priority task. Best when overwhelmed by many todos.",
  applicablePatterns: ["todo-overwhelm"],
  priority: "secondary",
  effectiveness: 0.68,
  requiresAbort: true,
  maxMessageLength: 200,
  
  execute: async (sessionId: string, context: RecoveryContext): Promise<RecoveryResult> => {
    const message = taskRefocusStrategy.generateMessage(context);
    
    return {
      success: true,
      timeToRecovery: 12000, // 12 seconds
      messagesUntilNextStall: 6,
      userTookOver: false,
      taskCompleted: false,
      strategyId: taskRefocusStrategy.id,
      message,
      aborted: true,
    };
  },
  
  generateMessage: (context: RecoveryContext): string => {
    const { todoContext, intent } = context;
    const pendingTasks = todoContext.filter(t => t.status === "pending" || t.status === "in_progress");
    
    if (pendingTasks.length === 0) {
      return "All tasks appear to be completed. Please review the work and confirm everything is done.";
    }
    
    // Sort by priority and pick top task
    const topTask = pendingTasks.sort((a, b) => (b.priority || 0) - (a.priority || 0))[0];
    
    return `You have ${pendingTasks.length} pending tasks. Let's focus only on the most important one: "${topTask.content}". Ignore everything else for now and complete this task first.`;
  },
};

/**
 * Strategy 5: Creative Break
 * 
 * For repeated failures. Suggests a completely different approach.
 */
const creativeBreakStrategy: RecoveryStrategy = {
  id: "creative-break",
  name: "Creative Break",
  description: "Suggests a different approach. Best when stuck in repeated failure loops.",
  applicablePatterns: ["infinite-loop", "reasoning-loop", "tool-failure"],
  priority: "secondary",
  effectiveness: 0.65,
  requiresAbort: true,
  maxMessageLength: 200,
  
  execute: async (sessionId: string, context: RecoveryContext): Promise<RecoveryResult> => {
    const message = creativeBreakStrategy.generateMessage(context);
    
    return {
      success: true,
      timeToRecovery: 25000, // 25 seconds (may need more time)
      messagesUntilNextStall: 7,
      userTookOver: false,
      taskCompleted: false,
      strategyId: creativeBreakStrategy.id,
      message,
      aborted: true,
    };
  },
  
  generateMessage: (context: RecoveryContext): string => {
    const { intent, recoveryAttempts } = context;
    
    if (recoveryAttempts > 2) {
      return `We've tried ${recoveryAttempts} times without success. Let's take a completely different approach. ${intent?.primaryGoal ? `Instead of the current path, what's an alternative way to achieve "${intent.primaryGoal}"?` : "What alternative approach could work here?"}`;
    }
    
    return "The current approach isn't working. Let's try a different strategy. Consider: working backwards from the desired outcome, or breaking the problem into smaller independent pieces.";
  },
};

/**
 * Strategy 6: External Resource
 * 
 * For knowledge gaps. Suggests documentation or external help.
 */
const externalResourceStrategy: RecoveryStrategy = {
  id: "external-resource",
  name: "External Resource",
  description: "Suggests documentation or external resources. Fallback for knowledge gaps.",
  applicablePatterns: ["confusion", "api-delay", "unknown"],
  priority: "fallback",
  effectiveness: 0.55,
  requiresAbort: true,
  maxMessageLength: 200,
  
  execute: async (sessionId: string, context: RecoveryContext): Promise<RecoveryResult> => {
    const message = externalResourceStrategy.generateMessage(context);
    
    return {
      success: true,
      timeToRecovery: 30000, // 30 seconds (research time)
      messagesUntilNextStall: 5,
      userTookOver: false,
      taskCompleted: false,
      strategyId: externalResourceStrategy.id,
      message,
      aborted: true,
    };
  },
  
  generateMessage: (context: RecoveryContext): string => {
    const { intent } = context;
    const domain = intent?.domain;
    
    const resourceMap: Record<string, string> = {
      refactoring: "Check the codebase for similar refactoring patterns or existing utilities that could help.",
      feature: "Review the project documentation or existing features for implementation patterns.",
      bugfix: "Search the issue tracker or Stack Overflow for similar error messages.",
      testing: "Check the testing documentation for best practices and helper functions.",
      documentation: "Review the style guide or similar documentation for consistency.",
      optimization: "Look for profiling tools or performance benchmarks in the project.",
    };
    
    const suggestion = resourceMap[domain || "unknown"] || 
      "Consider checking the project documentation or searching for relevant examples.";
    
    return `This seems to require additional knowledge. ${suggestion} What specific information do you need to proceed?`;
  },
};

/** All built-in strategies */
export const BUILT_IN_STRATEGIES: RecoveryStrategy[] = [
  gentleGuidanceStrategy,
  directInterventionStrategy,
  contextCompactionStrategy,
  taskRefocusStrategy,
  creativeBreakStrategy,
  externalResourceStrategy,
];

// ============================================================================
// Strategy Selection
// ============================================================================

/**
 * Select the best strategy for a given recovery context.
 * 
 * Uses effectiveness scores, pattern matching, and exploration/exploitation
 * balance to choose the optimal strategy.
 */
export function selectBestStrategy(
  context: RecoveryContext,
  strategies: RecoveryStrategy[],
  getEffectiveness: (strategyId: string, pattern: StallPatternType, domain: string) => Promise<number>,
  explorationRate: number = 0.1
): Promise<RecoveryStrategy> {
  return new Promise(async (resolve) => {
    // Filter applicable strategies
    const applicable = strategies.filter(s => 
      s.applicablePatterns.includes(context.stallPattern) &&
      s.priority !== "disabled"
    );
    
    if (applicable.length === 0) {
      // Fallback to first available strategy
      resolve(strategies[0] || gentleGuidanceStrategy);
      return;
    }
    
    if (applicable.length === 1) {
      resolve(applicable[0]);
      return;
    }
    
    // Score each strategy
    const scored = await Promise.all(
      applicable.map(async (strategy) => {
        const baseEffectiveness = await getEffectiveness(
          strategy.id,
          context.stallPattern,
          context.intent?.domain || "unknown"
        );
        
        let score = baseEffectiveness;
        
        // Penalize if proactive intervention already failed
        if (context.proactiveInterventionSent && strategy.id === "gentle-guidance") {
          score *= 0.7;
        }
        
        // Penalize strategies that require abort when user prefers gentle
        if (strategy.requiresAbort && context.recoveryAttempts === 0) {
          score *= 0.9; // Slight preference for non-abort on first try
        }
        
        return { strategy, score };
      })
    );
    
    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);
    
    // Exploration vs exploitation
    if (Math.random() < explorationRate && scored.length > 1) {
      // Try second-best strategy for exploration
      resolve(scored[1].strategy);
    } else {
      resolve(scored[0].strategy);
    }
  });
}

// ============================================================================
// Helpers
// ============================================================================

function extractErrorFromMessages(messages: unknown[]): string | undefined {
  // Simple heuristic: look for error indicators in message text
  for (const msg of messages) {
    const text = extractTextFromMessage(msg);
    if (text) {
      const errorPatterns = [
        /error[:\s]+([^\n]+)/i,
        /exception[:\s]+([^\n]+)/i,
        /failed[:\s]+([^\n]+)/i,
        /unable to[:\s]+([^\n]+)/i,
      ];
      
      for (const pattern of errorPatterns) {
        const match = text.match(pattern);
        if (match) {
          return match[1].trim();
        }
      }
    }
  }
  return undefined;
}

function extractTextFromMessage(msg: unknown): string | undefined {
  if (typeof msg === "string") return msg;
  if (msg && typeof msg === "object") {
    const m = msg as Record<string, unknown>;
    if (typeof m.text === "string") return m.text;
    if (typeof m.content === "string") return m.content;
    if (typeof m.message === "string") return m.message;
  }
  return undefined;
}
