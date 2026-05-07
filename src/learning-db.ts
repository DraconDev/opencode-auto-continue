/**
 * Auto-Continue v7.0 - Learning Database
 * 
 * File-based learning database for tracking recovery outcomes,
 * strategy effectiveness, and discovered stall patterns.
 * 
 * Uses JSON file storage for simplicity and zero dependencies.
 * Future versions may migrate to SQLite for better performance.
 */

import { join } from "path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import type {
  RecoveryRecord,
  StrategyPerformanceRecord,
  DiscoveredPattern,
  UserPreferenceRecord,
  TimeRange,
  StallPatternType,
  TaskDomain,
  RecoveryResult,
  LearningDatabase,
} from "./autonomy-types.js";

/**
 * Configuration for the learning database.
 */
export interface LearningDBConfig {
  /** Database file path. Defaults to ~/.opencode/auto-continue/learning.json */
  dbPath: string;
  
  /** Maximum records to keep before pruning */
  maxRecords: number;
  
  /** Enable automatic pruning of old records */
  autoPrune: boolean;
}

/** Default configuration */
export const DEFAULT_LEARNING_DB_CONFIG: LearningDBConfig = {
  dbPath: join(
    process.env.HOME || process.env.USERPROFILE || ".",
    ".opencode",
    "auto-continue",
    "learning.json"
  ),
  maxRecords: 10000,
  autoPrune: true,
};

/**
 * In-memory database structure
 */
interface LearningData {
  version: number;
  recoveryRecords: RecoveryRecord[];
  strategyPerformance: StrategyPerformanceRecord[];
  discoveredPatterns: DiscoveredPattern[];
  userPreferences: UserPreferenceRecord[];
}

/**
 * Create the file-based learning database.
 */
export function createLearningDB(
  config: Partial<LearningDBConfig> = {}
): LearningDatabase {
  const fullConfig = { ...DEFAULT_LEARNING_DB_CONFIG, ...config };
  
  // Ensure directory exists
  const dir = fullConfig.dbPath.substring(0, fullConfig.dbPath.lastIndexOf("/"));
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Directory may already exist
  }
  
  // Load existing data or create new
  let data: LearningData = loadData(fullConfig.dbPath);
  
  // Ensure data structure is valid
  if (!data.version) {
    data = {
      version: 1,
      recoveryRecords: [],
      strategyPerformance: [],
      discoveredPatterns: [],
      userPreferences: [],
    };
  }
  
  return {
    recordOutcome: async (record: RecoveryRecord) => {
      try {
        data.recoveryRecords.push(record);
        
        // Update strategy performance
        updateStrategyPerformance(data, record);
        
        // Prune if needed
        if (fullConfig.autoPrune && data.recoveryRecords.length > fullConfig.maxRecords) {
          data.recoveryRecords = data.recoveryRecords.slice(-fullConfig.maxRecords);
        }
        
        // Persist
        saveData(fullConfig.dbPath, data);
      } catch (error) {
        console.error("[LearningDB] Failed to record outcome:", error);
      }
    },
    
    getEffectiveness: async (
      strategyId: string,
      pattern: StallPatternType,
      domain: TaskDomain
    ): Promise<number> => {
      try {
        const perf = data.strategyPerformance.find(
          p => p.strategyId === strategyId && p.stallPattern === pattern && p.sessionDomain === domain
        );
        return perf?.currentEffectiveness ?? 0.5;
      } catch (error) {
        console.error("[LearningDB] Failed to get effectiveness:", error);
        return 0.5;
      }
    },
    
    updatePerformance: async (
      strategyId: string,
      pattern: StallPatternType,
      domain: TaskDomain,
      outcome: RecoveryResult
    ): Promise<void> => {
      try {
        const index = data.strategyPerformance.findIndex(
          p => p.strategyId === strategyId && p.stallPattern === pattern && p.sessionDomain === domain
        );
        
        if (index >= 0) {
          const existing = data.strategyPerformance[index];
          const newAttempts = existing.totalAttempts + 1;
          const newSuccesses = existing.successes + (outcome.success ? 1 : 0);
          const newFailures = existing.failures + (!outcome.success ? 1 : 0);
          const newAvgTime = (existing.avgTimeToRecovery * existing.totalAttempts + outcome.timeToRecovery) / newAttempts;
          
          // EMA update
          const alpha = 0.3;
          const outcomeScore = outcome.success ? 1.0 : outcome.messagesUntilNextStall > 3 ? 0.5 : 0.0;
          const newEffectiveness = (existing.currentEffectiveness * (1 - alpha)) + (outcomeScore * alpha);
          
          data.strategyPerformance[index] = {
            ...existing,
            totalAttempts: newAttempts,
            successes: newSuccesses,
            failures: newFailures,
            avgTimeToRecovery: newAvgTime,
            currentEffectiveness: newEffectiveness,
            trend: calculateTrend(existing.currentEffectiveness, newEffectiveness),
            lastUpdated: Date.now(),
          };
        } else {
          data.strategyPerformance.push({
            strategyId,
            stallPattern: pattern,
            sessionDomain: domain,
            totalAttempts: 1,
            successes: outcome.success ? 1 : 0,
            failures: outcome.success ? 0 : 1,
            partials: 0,
            avgTimeToRecovery: outcome.timeToRecovery,
            minTimeToRecovery: outcome.timeToRecovery,
            maxTimeToRecovery: outcome.timeToRecovery,
            currentEffectiveness: outcome.success ? 1.0 : 0.0,
            trend: "stable",
            lastUpdated: Date.now(),
          });
        }
        
        saveData(fullConfig.dbPath, data);
      } catch (error) {
        console.error("[LearningDB] Failed to update performance:", error);
      }
    },
    
    getRecentRecords: async (timeRange: TimeRange): Promise<RecoveryRecord[]> => {
      try {
        return data.recoveryRecords.filter(
          r => r.timestamp >= timeRange.start && r.timestamp <= timeRange.end
        );
      } catch (error) {
        console.error("[LearningDB] Failed to get recent records:", error);
        return [];
      }
    },
    
    getStrategyPerformance: async (strategyId: string): Promise<StrategyPerformanceRecord[]> => {
      try {
        return data.strategyPerformance.filter(p => p.strategyId === strategyId);
      } catch (error) {
        console.error("[LearningDB] Failed to get strategy performance:", error);
        return [];
      }
    },
    
    discoverPatterns: async (): Promise<DiscoveredPattern[]> => {
      try {
        // Simple pattern discovery: group failed recoveries by pattern/domain
        const failures = data.recoveryRecords.filter(r => !r.success);
        const groups = new Map<string, RecoveryRecord[]>();
        
        for (const failure of failures) {
          const key = `${failure.stallPattern}:${failure.sessionDomain}`;
          const group = groups.get(key) || [];
          group.push(failure);
          groups.set(key, group);
        }
        
        const patterns: DiscoveredPattern[] = [];
        for (const [key, records] of groups) {
          if (records.length >= 5) {
            const [pattern, domain] = key.split(":") as [StallPatternType, TaskDomain];
            const avgTokens = records.reduce((sum, r) => sum + r.tokenCount, 0) / records.length;
            const avgAge = records.reduce((sum, r) => sum + r.sessionAge, 0) / records.length;
            
            patterns.push({
              id: `pattern-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              name: `${pattern} in ${domain}`,
              characteristics: {
                tokenRange: { min: avgTokens * 0.8, max: avgTokens * 1.2 },
                ageRange: { min: avgAge * 0.8, max: avgAge * 1.2 },
                toolFailures: [],
                reasoningKeywords: [],
                domains: [domain],
              },
              frequency: records.length,
              firstSeen: records[0].timestamp,
              recommendedStrategy: "gentle-guidance",
            });
          }
        }
        
        return patterns;
      } catch (error) {
        console.error("[LearningDB] Failed to discover patterns:", error);
        return [];
      }
    },
    
    getUserPreferences: async (userId: string): Promise<UserPreferenceRecord | undefined> => {
      try {
        return data.userPreferences.find(p => p.userId === userId);
      } catch (error) {
        console.error("[LearningDB] Failed to get user preferences:", error);
        return undefined;
      }
    },
    
    close: async () => {
      saveData(fullConfig.dbPath, data);
    },
  };
}

// ============================================================================
// File I/O Helpers
// ============================================================================

function loadData(path: string): LearningData {
  try {
    if (existsSync(path)) {
      const content = readFileSync(path, "utf-8");
      return JSON.parse(content) as LearningData;
    }
  } catch (error) {
    console.error("[LearningDB] Failed to load data, starting fresh:", error);
  }
  
  return {
    version: 1,
    recoveryRecords: [],
    strategyPerformance: [],
    discoveredPatterns: [],
    userPreferences: [],
  };
}

function saveData(path: string, data: LearningData): void {
  try {
    writeFileSync(path, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("[LearningDB] Failed to save data:", error);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function updateStrategyPerformance(data: LearningData, record: RecoveryRecord): void {
  const index = data.strategyPerformance.findIndex(
    p => p.strategyId === record.recoveryStrategy && 
         p.stallPattern === record.stallPattern && 
         p.sessionDomain === record.sessionDomain
  );
  
  if (index < 0) {
    data.strategyPerformance.push({
      strategyId: record.recoveryStrategy,
      stallPattern: record.stallPattern,
      sessionDomain: record.sessionDomain,
      totalAttempts: 0,
      successes: 0,
      failures: 0,
      partials: 0,
      avgTimeToRecovery: 0,
      minTimeToRecovery: 0,
      maxTimeToRecovery: 0,
      currentEffectiveness: 0.5,
      trend: "stable",
      lastUpdated: Date.now(),
    });
  }
}

function calculateTrend(oldValue: number, newValue: number): "improving" | "stable" | "declining" {
  const delta = newValue - oldValue;
  if (delta > 0.05) return "improving";
  if (delta < -0.05) return "declining";
  return "stable";
}
