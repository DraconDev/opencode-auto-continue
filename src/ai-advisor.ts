import type { SessionState } from "./session-state.js";
import type { TypedPluginInput } from "./types.js";
import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";

interface ProviderCache {
  path: string | null;
  mtime: number;
  config: { baseURL: string; apiKey?: string; headers?: Record<string, string> } | null;
}

let providerCache: ProviderCache = { path: null, mtime: 0, config: null };

export interface AIAdvisorConfig {
  enableAdvisory: boolean;
  advisoryModel: string;
  advisoryTimeoutMs: number;
  advisoryMaxTokens: number;
  advisoryTemperature: number;
}

export interface SessionContext {
  sessionId: string;
  elapsedMs: number;
  lastProgressMs: number;
  attempts: number;
  stallDetections: number;
  lastStallPartType: string;
  stallPatterns: Record<string, number>;
  estimatedTokens: number;
  messageCount: number;
  planning: boolean;
  compacting: boolean;
  userCancelled: boolean;
  hasOpenTodos: boolean;
  recentMessages: Array<{
    role: string;
    type?: string;
    text?: string;
    timestamp?: string;
  }>;
  recentErrors: string[];
}

export interface AIAdvice {
  action: "abort" | "wait" | "continue" | "compact" | "unknown";
  confidence: number; // 0-1
  reasoning: string;
  suggestedDelayMs?: number;
  stallPattern?: string; // Classification of why the stall occurred
  customPrompt?: string; // AI-generated continuation prompt (optional)
  contextSummary?: string; // Brief summary of what the model was doing
}

export interface AIAdvisorDeps {
  config: AIAdvisorConfig;
  log: (...args: unknown[]) => void;
  input: TypedPluginInput;
}

// Default prompt template for session analysis
const DEFAULT_ADVISORY_PROMPT = `You are a session monitoring assistant. Analyze this session context and advise whether to abort, wait, or continue.

Session Context:
{context}

Recent Activity:
{messages}

Based on this, what action should be taken?
Respond with a JSON object:
{
  "action": "abort" | "wait" | "continue" | "compact",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation",
  "suggestedDelayMs": number (if waiting),
  "stallPattern": "stuck-on-reasoning" | "stuck-on-tool" | "stuck-on-output" | "stuck-on-planning" | "context-bloat" | "api-delay" | "todo-stalled" | "mixed-progress" | "cold-start" | "unknown",
  "customPrompt": "optional: write a brief, specific message to send to the AI to help it continue (max 200 chars). If null, use default prompt.",
  "contextSummary": "one sentence summary of what the model was doing before stalling"
}

Rules:
- "abort" if the model is stuck, looping, or making no meaningful progress
- "wait" if the model is actively working (API calls, file operations, reasoning)
- "continue" if the model completed work and needs encouragement
- "compact" if context is bloated but model is working
- "stallPattern" should classify WHY the stall occurred:
  - "stuck-on-reasoning": Stuck in thought loops without action
  - "stuck-on-tool": Repeated tool calls without progress
  - "stuck-on-output": Generating same text repeatedly
  - "stuck-on-planning": Planning endlessly without executing
  - "context-bloat": High token usage slowing model down
  - "api-delay": Waiting on external API responses
  - "todo-stalled": Has pending tasks but stopped working
  - "mixed-progress": Trying different approaches slowly
  - "cold-start": Just began, hasn't had time to make progress
  - "unknown": Can't determine the pattern
- "customPrompt" should be tailored to the situation:
  - If tool call failed: "Retry the last tool call with corrected parameters..."
  - If reasoning loop: "Stop reasoning and take action on the next step..."
  - If todo stalled: "Continue working on [specific task name]..."
  - Keep it under 200 characters
  - If unsure or generic, set customPrompt to null
- "contextSummary" should be one sentence describing what the model was doing
- Confidence should reflect certainty (0.5 = uncertain, 0.9 = very certain)`;

export function createAIAdvisor(deps: AIAdvisorDeps) {
  const { config, log, input } = deps;

  // Extract session context for AI analysis
  async function extractContext(
    sessionId: string,
    state: SessionState
  ): Promise<SessionContext> {
    const now = Date.now();
    const recentMessages: SessionContext["recentMessages"] = [];
    const recentErrors: string[] = [];

    try {
      // Fetch recent messages
      const resp = await input.client.session.messages({
        path: { id: sessionId },
        query: { limit: 10 },
      });
      const messages = Array.isArray(resp.data) ? resp.data : [];
      
      for (const msg of messages.slice(-5)) {
        const anyMsg = msg as any;
        recentMessages.push({
          role: anyMsg.role || "unknown",
          type: anyMsg.type,
          text: anyMsg.content || anyMsg.text,
          timestamp: anyMsg.createdAt,
        });
      }
    } catch (e) {
      log("failed to fetch messages for AI context:", e);
    }

    return {
      sessionId,
      elapsedMs: now - state.actionStartedAt,
      lastProgressMs: now - state.lastProgressAt,
      attempts: state.attempts,
      stallDetections: state.stallDetections,
      lastStallPartType: state.lastStallPartType,
      stallPatterns: { ...state.stallPatterns },
      estimatedTokens: state.estimatedTokens,
      messageCount: state.messageCount,
      planning: state.planning,
      compacting: state.compacting,
      userCancelled: state.userCancelled,
      hasOpenTodos: state.hasOpenTodos,
      recentMessages,
      recentErrors,
    };
  }

  // Call AI for advice (tries AI first, falls back to heuristics)
  async function getAdvice(context: SessionContext): Promise<AIAdvice | null> {
    if (!config.enableAdvisory) {
      // Even without AI advisory mode, use heuristic analysis
      return getHeuristicAdvice(context);
    }

    // Try AI call first (if real provider is configured)
    if (config.advisoryModel) {
      const contextStr = JSON.stringify(context, null, 2);
      const messagesStr = context.recentMessages
        .map((m) => `[${m.role}] ${m.type || ""}: ${m.text?.slice(0, 200) || ""}`)
        .join("\n");

      const prompt = DEFAULT_ADVISORY_PROMPT
        .replace("{context}", contextStr)
        .replace("{messages}", messagesStr);

      try {
        log("requesting AI advice for session:", context.sessionId);
        const model = config.advisoryModel || "default";
        const response = await callAIForAdvice(prompt, model, config);
        if (response) {
          log("AI advice received:", response.action, "confidence:", response.confidence);
          return response;
        }
      } catch (e) {
        log("AI advisory call failed, falling back to heuristics:", e);
      }
    }

    // Fall back to heuristic analysis
    return getHeuristicAdvice(context);
  }

  // Heuristic-based advice (works without external AI)
  function getHeuristicAdvice(context: SessionContext): AIAdvice | null {
    // Pattern: Tool-text detection already handled in recovery.ts
    // These heuristics address edge cases the hardcoded rules miss

    // 1. Model just started working but made no progress yet
    if (context.elapsedMs < 30000 && context.messageCount < 3) {
      return {
        action: "wait",
        confidence: 0.7,
        reasoning: "Session just started, give it time to begin working",
        suggestedDelayMs: 30000,
        stallPattern: "cold-start",
        customPrompt: "Session is initializing — please begin working on the first task.",
        contextSummary: "Session just started, waiting for model to begin working",
      };
    }

    // 2. Repeated same part type stalling (e.g., always "text")
    const dominantPattern = Object.entries(context.stallPatterns)
      .sort(([, a], [, b]) => b - a)[0];
    if (dominantPattern && dominantPattern[1] >= 3 && Object.keys(context.stallPatterns).length === 1) {
      return {
        action: "abort",
        confidence: 0.8,
        reasoning: `Repeatedly stalled on '${dominantPattern[0]}' (${dominantPattern[1]} times) — model may be stuck in output loop`,
        stallPattern: dominantPattern[0] === "tool" ? "stuck-on-tool" : "stuck-on-output",
        customPrompt: `The model appears stuck generating ${dominantPattern[0]} output. Please abort the current operation and start fresh with a clearer approach.`,
        contextSummary: `Model stuck in repeated ${dominantPattern[0]} generation loop`,
      };
    }

    // 3. Mixed stall patterns suggest model is trying different approaches
    if (Object.keys(context.stallPatterns).length >= 3) {
      return {
        action: "wait",
        confidence: 0.6,
        reasoning: "Model cycling through different part types — may be making slow progress",
        suggestedDelayMs: 30000,
        stallPattern: "mixed-progress",
        customPrompt: "The model is trying different approaches. Please continue working — don't give up yet.",
        contextSummary: "Model cycling through different activity types, likely exploring solutions",
      };
    }

    // 4. Planning for too long (>2 min)
    if (context.planning && context.elapsedMs > 120000) {
      return {
        action: "abort",
        confidence: 0.7,
        reasoning: "Planning for over 2 minutes without executing — model may be stuck in analysis loop",
        stallPattern: "stuck-on-planning",
        customPrompt: "The model has been planning for too long. Please abort the current plan and start executing the next concrete step.",
        contextSummary: "Model stuck in planning phase for over 2 minutes without execution",
      };
    }

    // 5. High token count + recent text suggests bloat, not stall
    if (context.estimatedTokens > 80000 && context.lastStallPartType === "text") {
      if (context.hasOpenTodos) {
        return {
          action: "continue",
          confidence: 0.65,
          reasoning: "High token usage suggests bloat rather than stall — nudge with todo context",
          stallPattern: "context-bloat",
          customPrompt: "Context is getting large but work is in progress. Please continue with the next pending task.",
          contextSummary: "High token usage with pending todos, likely context bloat rather than true stall",
        };
      }
      return {
        action: "compact",
        confidence: 0.7,
        reasoning: "High token usage with no pending todos — likely context bloat",
        stallPattern: "context-bloat",
        customPrompt: "Context has grown too large. Please compact and summarize completed work before continuing.",
        contextSummary: "High token usage with no pending todos, likely context bloat",
      };
    }

    // 6. Many failed attempts but session still young — try different approach
    if (context.attempts >= 2 && context.elapsedMs < 60000) {
      return {
        action: "wait",
        confidence: 0.5,
        reasoning: "Multiple attempts failed early — session may need more time to stabilize",
        suggestedDelayMs: 60000,
        stallPattern: "unstable-start",
        customPrompt: "Multiple recovery attempts failed. Please wait a moment and then try a fresh approach.",
        contextSummary: "Multiple early recovery failures, session may be unstable",
      };
    }

    // 7. Model has pending todos but no recent text output
    if (context.hasOpenTodos && context.lastProgressMs > 60000) {
      return {
        action: "continue",
        confidence: 0.75,
        reasoning: `Has pending todos but stalled — needs nudge to continue`,
        stallPattern: "todo-stalled",
        customPrompt: "You have pending todos that need attention. Please continue working on the next incomplete task.",
        contextSummary: "Model has pending todos but stalled, needs encouragement to continue",
      };
    }

    // No heuristic matched — let hardcoded rules handle it
    return null;
  }

  // Call actual AI provider (OpenAI-compatible) for advice
  async function callAIForAdvice(
    prompt: string,
    model: string,
    aiConfig: AIAdvisorConfig
  ): Promise<AIAdvice | null> {
    try {
      // Read provider config from opencode.json
      const providerConfig = readProviderConfig(config.advisoryModel);
      if (!providerConfig) {
        log("no provider config found for AI advisory");
        return null;
      }

      const { baseURL, apiKey, headers } = providerConfig;
      const chatUrl = `${baseURL.replace(/\/+$/, "")}/chat/completions`;

      log("calling AI provider:", chatUrl, "model:", model);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), aiConfig.advisoryTimeoutMs);

      try {
        const response = await fetch(chatUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            ...headersWithoutAuth(headers),
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            max_tokens: aiConfig.advisoryMaxTokens,
            temperature: aiConfig.advisoryTemperature,
            response_format: { type: "json_object" },
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          log("AI provider returned:", response.status, response.statusText);
          return null;
        }

        const data = await response.json() as any;
        const content = data?.choices?.[0]?.message?.content;
        if (!content) {
          log("empty AI response");
          return null;
        }

        // Parse JSON from the response
        const parsed = JSON.parse(content) as AIAdvice;
        
        // Validate the response
        if (!parsed.action || !["abort", "wait", "continue", "compact"].includes(parsed.action)) {
          log("invalid AI advice action:", parsed.action);
          return null;
        }
        
        log("AI advice:", parsed.action, "confidence:", parsed.confidence, "reasoning:", parsed.reasoning?.substring(0, 100));
        
        return {
          action: parsed.action,
          confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
          reasoning: parsed.reasoning || "AI advisory",
          suggestedDelayMs: parsed.suggestedDelayMs,
          stallPattern: parsed.stallPattern || "unknown",
          customPrompt: parsed.customPrompt || undefined,
          contextSummary: parsed.contextSummary || undefined,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (e) {
      log("AI call failed:", e);
      return null;
    }
  }

  // Read provider config from opencode.json
  // Prefer matching provider by model name over first available
  // Cache parsed opencode.json to avoid repeated disk reads
  function readProviderConfig(targetModel?: string): { baseURL: string; apiKey?: string; headers?: Record<string, string> } | null {
    try {
      const configPath = join(
        process.env.HOME || "/tmp",
        ".config",
        "opencode",
        "opencode.json"
      );
      
      if (!existsSync(configPath)) {
        log("opencode.json not found at:", configPath);
        return null;
      }

      // Check cache validity using mtime
      const stats = statSync(configPath, { throwIfNoEntry: false });
      const mtime = stats?.mtimeMs || 0;
      
      if (providerCache.path === configPath && providerCache.mtime === mtime && providerCache.config !== null) {
        log("using cached provider config for model:", targetModel);
        return providerCache.config;
      }

      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(raw);
      const providers = config?.provider;
      if (!providers) return null;

      let result: { baseURL: string; apiKey?: string; headers?: Record<string, string> } | null = null;

      // If a target model is specified, try to find the provider that has it
      if (targetModel) {
        const targetModelName = targetModel.includes("/") ? targetModel.split("/").pop() : targetModel;
        for (const [name, provider] of Object.entries(providers) as [string, any][]) {
          const opts = provider.options || {};
          const models = opts.models || {};
          // Check if this provider has the target model
          for (const [modelName, modelConfig] of Object.entries(models) as [string, any][]) {
            if (modelName === targetModelName || modelName === targetModel) {
              const baseURL = opts.baseURL || opts.baseUrl;
              const apiKey = opts.apiKey || opts.api_key;
              const headers = opts.headers;
              if (baseURL) {
                log("using matched provider:", name, "for model:", targetModel, "baseURL:", baseURL);
                result = { baseURL, apiKey, headers };
                break;
              }
            }
          }
          if (result) break;
        }
        if (!result) {
          log("no provider found for model:", targetModel, ", falling back to first available");
        }
      }

      // Find the first enabled provider with OpenAI-compatible models
      if (!result) {
        for (const [name, provider] of Object.entries(providers) as [string, any][]) {
          const opts = provider.options || {};
          const baseURL = opts.baseURL || opts.baseUrl;
          const apiKey = opts.apiKey || opts.api_key;
          const headers = opts.headers;

          if (baseURL) {
            log("using provider:", name, "baseURL:", baseURL);
            result = { baseURL, apiKey, headers };
            break;
          }
        }
      }

      // Update cache
      providerCache = { path: configPath, mtime, config: result };
      return result;
    } catch (e) {
      log("failed to read provider config:", e);
      return null;
    }
  }

  // Strip Authorization from headers if apiKey was used
  function headersWithoutAuth(headers?: Record<string, string>): Record<string, string> {
    if (!headers) return {};
    const AUTH_HEADERS = ["authorization", "x-api-key", "x-auth-token", "api-key", "token", "proxy-authorization", "x-proxy-authorization"];
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (!AUTH_HEADERS.includes(key.toLowerCase())) {
        result[key] = value;
      }
    }
    return result;
  }

  // Check whether to invoke the advisory system (heuristic or AI)
  function shouldUseAI(state: SessionState): boolean {
    // Heuristic advice is always available and cheap — use it for edge cases
    
    // Don't use for obvious cases
    if (state.userCancelled) return false;
    if (state.compacting) return false;
    
    // Use advisory for:
    // - Multiple failed recoveries (need pattern analysis)
    if (state.attempts >= 2) return true;
    
    // - High stall detection count (unclear why)
    if (state.stallDetections >= 3) return true;
    
    // - Mixed stall patterns (different part types stalling)
    const patternKeys = Object.keys(state.stallPatterns);
    if (patternKeys.length >= 2) return true;
    
    // - Planning mode with long elapsed time
    if (state.planning && (Date.now() - state.actionStartedAt) > 120000) return true;
    
    return false;
  }

  return {
    extractContext,
    getAdvice,
    shouldUseAI,
  };
}

export type AIAdvisor = ReturnType<typeof createAIAdvisor>;
