/**
 * Plan-Driven Auto-Continue Module
 * 
 * Reads `.opencode/plan.md` and provides next steps when
 * the AI runs out of todos. This extends the existing
 * nudge/review flow with plan-aware continuation.
 */

import { readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";

export interface PlanItem {
  phase: string;
  description: string;
  completed: boolean;
  lineNumber: number;
}

export interface PlanParseResult {
  items: PlanItem[];
  currentPhase: string | null;
  nextItem: PlanItem | null;
  progress: { completed: number; total: number };
  raw: string;
}

/**
 * Parse a plan markdown file.
 * 
 * Expected format:
 * ```markdown
 * # Plan: Build a Dota Game
 * 
 * ## Phase 1: Project Setup
 * - [ ] Initialize project structure
 * - [x] Setup build system
 * - [ ] Configure testing
 * 
 * ## Phase 2: Core Engine
 * - [ ] Implement game loop
 * - [ ] Create entity system
 * ```
 */
export function parsePlan(planPath: string): PlanParseResult {
  if (!existsSync(planPath)) {
    return {
      items: [],
      currentPhase: null,
      nextItem: null,
      progress: { completed: 0, total: 0 },
      raw: "",
    };
  }

  const raw = readFileSync(planPath, "utf-8");
  const lines = raw.split("\n");
  
  const items: PlanItem[] = [];
  let currentPhase: string | null = null;
  let completedCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Detect phase headers (## or ###)
    const phaseMatch = line.match(/^#{2,3}\s+(.+)$/);
    if (phaseMatch) {
      currentPhase = phaseMatch[1].trim();
      continue;
    }
    
    // Detect plan items (- [ ] or - [x])
    const itemMatch = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (itemMatch && currentPhase) {
      const isCompleted = itemMatch[1].toLowerCase() === "x";
      const description = itemMatch[2].trim();
      
      items.push({
        phase: currentPhase,
        description,
        completed: isCompleted,
        lineNumber: i + 1,
      });
      
      if (isCompleted) {
        completedCount++;
      }
    }
  }

  // Find next incomplete item
  const nextItem = items.find(item => !item.completed) || null;
  
  // Find current phase (first phase with incomplete items)
  const currentPhaseName = nextItem ? nextItem.phase : null;

  return {
    items,
    currentPhase: currentPhaseName,
    nextItem,
    progress: {
      completed: completedCount,
      total: items.length,
    },
    raw,
  };
}

/**
 * Get the path to the plan file.
 * If a custom path is provided, uses that. Otherwise searches for common plan filenames.
 * Priority order:
 * 1. Custom path (if provided and exists)
 * 2. PLAN.md (standard project plan)
 * 3. ROADMAP.md (long-term planning)
 * 4. .opencode/plan.md (OpenCode specific)
 * 5. README.md (may contain plan sections)
 * 6. TODO.md (simple task lists)
 * Returns the first one found, or the default path if none exist.
 */
export function getPlanPath(directory: string, customPath?: string | null): string {
  // Use custom path if provided and exists
  if (customPath) {
    const fullPath = customPath.startsWith("/") ? customPath : join(directory, customPath);
    if (existsSync(fullPath)) {
      return fullPath;
    }
  }

  const candidates = [
    join(directory, "PLAN.md"),
    join(directory, "ROADMAP.md"),
    join(directory, ".opencode", "plan.md"),
    join(directory, "README.md"),
    join(directory, "TODO.md"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Default to .opencode/plan.md if none found
  return join(directory, ".opencode", "plan.md");
}

/**
 * Check if a plan exists and has pending items.
 */
export function hasPendingPlanItems(directory: string): boolean {
  const planPath = getPlanPath(directory);
  if (!existsSync(planPath)) {
    return false;
  }
  
  const result = parsePlan(planPath);
  return result.nextItem !== null;
}

/**
 * Build a continue message based on the plan state.
 * 
 * This tells the AI what the next plan item is so it can
 * create todos and start working.
 * 
 * @param result - The parsed plan result
 * @param maxItems - Maximum number of upcoming items to include (default: 3)
 */
export function buildPlanContinueMessage(result: PlanParseResult, maxItems: number = 3): string | null {
  if (!result.nextItem) {
    return null;
  }

  const { nextItem, progress, currentPhase } = result;
  const percent = progress.total > 0 
    ? Math.round((progress.completed / progress.total) * 100) 
    : 0;

  let message = `You've completed the current tasks. `;
  message += `According to the plan (${percent}% complete), `;
  
  if (currentPhase) {
    message += `the next item in "${currentPhase}" is: **${nextItem.description}**.`;
  } else {
    message += `the next item is: **${nextItem.description}**.`;
  }
  
  // Include upcoming items if there are more
  const upcomingItems = result.items
    .filter(item => !item.completed && item.lineNumber > nextItem.lineNumber)
    .slice(0, maxItems - 1);
  
  if (upcomingItems.length > 0) {
    message += `\n\nUpcoming items after this:\n`;
    for (const item of upcomingItems) {
      message += `- ${item.description}\n`;
    }
  }
  
  message += `\nPlease create todos for this work and start implementing.`;
  
  return message;
}

/**
 * Mark a plan item as completed by description.
 * Returns true if an item was found and marked.
 */
export function markPlanItemComplete(
  planPath: string, 
  description: string
): boolean {
  if (!existsSync(planPath)) {
    return false;
  }

  const raw = readFileSync(planPath, "utf-8");
  const lines = raw.split("\n");
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match item with description
    const itemMatch = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (itemMatch) {
      const itemDesc = itemMatch[2].trim();
      // Fuzzy match - check if description contains or is contained
      if (itemDesc.toLowerCase().includes(description.toLowerCase()) ||
          description.toLowerCase().includes(itemDesc.toLowerCase())) {
        // Mark as complete
        lines[i] = line.replace(/\[ \]/, "[x]");
        found = true;
        break; // Only mark first match
      }
    }
  }

  if (found) {
    writeFileSync(planPath, lines.join("\n"), "utf-8");
  }

  return found;
}
