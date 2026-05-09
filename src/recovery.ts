import type { PluginConfig, SessionState } from "./shared.js";
import { formatMessage, shouldBlockPrompt } from "./shared.js";
import type { TypedPluginInput } from "./types.js";
import type { AIAdvisor } from "./ai-advisor.js";

export interface RecoveryDeps {
  config: PluginConfig;
  sessions: Map<string, SessionState>;
  log: (...args: unknown[]) => void;
  input: TypedPluginInput;
  isDisposed: () => boolean;
  writeStatusFile: (sessionId: string) => void;
  cancelNudge: (sessionId: string) => void;
  aiAdvisor?: AIAdvisor;
  sendContinue?: (sessionId: string) => Promise<void>;
}

// Tool-text detection patterns (XML tool calls embedded in text/reasoning)
const TOOL_TEXT_PATTERNS = [
  /<function\s*=/i,
  /<function>/i,
  /<\/function>/i,
  /<parameter\s*=/i,
  /<parameter>/i,
  /<\/parameter>/i,
  /<tool_call[\s>]/i,
  /<\/tool_call>/i,
  /<tool[\s_]name\s*=/i,
  /<invoke\s+/i,
  /<invoke>/i,
  /<\/invoke>/i,
  /<(?:edit|write|read|bash|grep|glob|search|replace|execute|run|cat|ls|npm|pip|docker)\s*(?:\s[^>]*)?\s*(?:\/>|>)/i,
];

const TRUNCATED_XML_PATTERNS = [
  { open: /<function[^>]*>/i, close: /<\/function>/i },
  { open: /<parameter[^>]*>/i, close: /<\/parameter>/i },
  { open: /<tool_call[^>]*>/i, close: /<\/tool_call>/i },
  { open: /<invoke[^>]*>/i, close: /<\/invoke>/i },
];

const TOOL_TEXT_RECOVERY_PROMPT =
  "I noticed you have a tool call generated in your thinking/reasoning. Please execute it using the proper tool calling mechanism instead of keeping it in reasoning.";

function containsToolCallAsText(text: string): boolean {
  if (text.length <= 10) return false;
  if (TOOL_TEXT_PATTERNS.some((pat) => pat.test(text))) return true;
  for (const { open, close } of TRUNCATED_XML_PATTERNS) {
    if (open.test(text) && !close.test(text)) return true;
  }
  return false;
}

async function checkToolTextInSession(sessionId: string, input: TypedPluginInput): Promise<boolean> {
  try {
    const resp = await input.client.session.messages({
      path: { id: sessionId },
      query: { limit: 3 },
    });
    const messages = Array.isArray(resp.data) ? resp.data : [];
    for (const msg of messages) {
      const role = (msg as any).role || (msg as any).info?.role;
      if (role !== "assistant") continue;
      const parts = (msg as any).parts || [];
      for (const part of parts) {
        if (part.type === "text" || part.type === "reasoning") {
          const text = part.text || "";
          if (containsToolCallAsText(text)) return true;
        }
      }
    }
  } catch (e) {
    // Silently ignore fetch errors
  }
  return false;
}

// Hallucination loop detection
const LOOP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const LOOP_MAX_CONTINUES = 3;

function recordContinue(s: SessionState): void {
  s.continueTimestamps.push(Date.now());
  const cutoff = Date.now() - LOOP_WINDOW_MS;
  while (s.continueTimestamps.length > 0 && s.continueTimestamps[0] < cutoff) {
    s.continueTimestamps.shift();
  }
}

function isHallucinationLoop(s: SessionState): boolean {
  recordContinue(s);
  return s.continueTimestamps.length >= LOOP_MAX_CONTINUES;
}

export function createRecoveryModule(deps: RecoveryDeps) {
  const { config, sessions, log, input, isDisposed, writeStatusFile, cancelNudge } = deps;

  async function isSessionIdle(sessionId: string): Promise<boolean> {
    try {
      const statusResult = await input.client.session.status({});
      const statusData = statusResult.data as Record<string, { type: string }>;
      return statusData[sessionId]?.type === "idle";
    } catch (e) {
      log('status check before immediate continue failed:', e);
      return false;
    }
  }

  async function recover(sessionId: string) {
    if (isDisposed()) return;
    const s = sessions.get(sessionId);
    if (!s) return;

    if (s.aborting) return;
    if (s.userCancelled) return;
    if (s.planning) return;
    if (s.compacting) return;
    if (s.attempts >= config.maxRecoveries) {
      // Before giving up, check if AI has advice
        if (deps.aiAdvisor && deps.aiAdvisor.shouldUseAI(s)) {
        try {
          const context = await deps.aiAdvisor.extractContext(sessionId, s);
          const advice = await deps.aiAdvisor.getAdvice(context);
          
          // Save to session state for status file
          if (advice) {
            s.lastAdvisoryAdvice = { action: advice.action, confidence: advice.confidence, reasoning: advice.reasoning, customPrompt: advice.customPrompt, contextSummary: advice.contextSummary };
          }
          
          if (advice && advice.confidence > 0.6) {
            log('AI advice for stalled session:', advice.action, 'confidence:', advice.confidence, 'reasoning:', advice.reasoning);
            
            if (advice.action === 'wait' && advice.suggestedDelayMs) {
              log('AI suggests waiting', advice.suggestedDelayMs, 'ms instead of aborting');
              s.backoffAttempts = Math.max(0, s.backoffAttempts - 1); // Forgive one backoff
              s.timer = setTimeout(() => recover(sessionId), advice.suggestedDelayMs);
              return;
            }
            
            if (advice.action === 'continue') {
              log('AI suggests continuing without abort');
              s.attempts = 0; // Reset attempts
              s.timer = setTimeout(() => recover(sessionId), config.stallTimeoutMs);
              return;
            }
            
            // For 'abort' or 'compact', fall through to normal backoff
          }
        } catch (e) {
          log('AI advisory failed, falling back to hardcoded backoff:', e);
        }
      }
      
      const backoffDelay = Math.min(
        config.stallTimeoutMs * Math.pow(2, s.backoffAttempts),
        config.maxBackoffMs
      );
      s.backoffAttempts++;
      log('max recoveries reached, using exponential backoff:', backoffDelay, 'ms (attempt', s.backoffAttempts, ')');
      s.timer = setTimeout(() => recover(sessionId), backoffDelay);
      return;
    }

    const now = Date.now();

    if (now - s.lastRecoveryTime < config.cooldownMs) return;

    if (config.maxSessionAgeMs > 0 && now - s.sessionCreatedAt > config.maxSessionAgeMs) {
      log('session too old, giving up:', sessionId, 'age:', now - s.sessionCreatedAt, 'ms');
      s.aborting = false;
      return;
    }

    s.aborting = true;
    s.stallDetections++;
    s.recoveryStartTime = Date.now();

    if (config.stallPatternDetection && s.lastStallPartType) {
      s.stallPatterns[s.lastStallPartType] = (s.stallPatterns[s.lastStallPartType] || 0) + 1;
    }

    writeStatusFile(sessionId);

    try {
      const statusResult = await input.client.session.status({});
      const statusData = statusResult.data as Record<string, { type: string }>;
      const sessionStatus = statusData[sessionId];

      if (!sessionStatus || sessionStatus.type !== "busy") {
        s.aborting = false;
        return;
      }

      const currentTime = Date.now();

      if (currentTime - s.lastProgressAt < config.stallTimeoutMs) {
        s.aborting = false;
        const remaining = config.stallTimeoutMs - (currentTime - s.lastProgressAt);
        s.timer = setTimeout(() => recover(sessionId), Math.max(remaining, 100));
        return;
      }

      // Check if the model output tool calls as raw text (XML in reasoning)
      const hasToolText = await checkToolTextInSession(sessionId, input);
      if (hasToolText) {
        log('tool-text detected in session, using recovery prompt');
      }

      // Abort the session first (required before compaction)
      try {
        await input.client.session.abort({
          path: { id: sessionId },
          query: { directory: input.directory || "" }
        });
        log('session aborted for recovery:', sessionId);
      } catch (e) {
        log('abort failed:', e);
        s.aborting = false;
        s.timer = setTimeout(() => recover(sessionId), config.stallTimeoutMs * 2);
        return;
      }

      // Wait for session to become idle
      const startTime = Date.now();
      let isIdle = false;
      let statusFailures = 0;

      if (config.abortPollMaxTimeMs > 0) {
        while (!isIdle && Date.now() - startTime < config.abortPollMaxTimeMs && statusFailures < config.abortPollMaxFailures) {
          await new Promise(r => setTimeout(r, config.abortPollIntervalMs));
          try {
            const pollResult = await input.client.session.status({});
            const pollData = pollResult.data as Record<string, { type: string }>;
            const pollStatus = pollData[sessionId];
            if (pollStatus?.type === "idle") {
              isIdle = true;
            }
            statusFailures = 0;
          } catch (e) {
            statusFailures++;
            log('status poll failed:', e);
          }
        }
      }

      // Now that session is idle, try compaction
      if (config.autoCompact && !hasToolText && isIdle) {
        try {
          log('attempting auto-compaction for session:', sessionId);
          await input.client.session.summarize({
            path: { id: sessionId },
            query: { directory: input.directory || "" }
          });
          log('auto-compaction successful, waiting for session to resume');
          await new Promise(r => setTimeout(r, 3000));
        } catch (e: any) {
          log('auto-compaction failed:', e?.message || e?.name || String(e), 'status:', e?.status, 'response:', JSON.stringify(e?.response || {}), 'data:', JSON.stringify(e?.data || {}));
        }
      }

      const remainingWait = config.waitAfterAbortMs - (Date.now() - startTime);
      if (remainingWait > 0) {
        await new Promise(r => setTimeout(r, remainingWait));
      }

      if (s.autoSubmitCount >= config.maxAutoSubmits) {
        log('loop protection: max auto-submits reached:', s.autoSubmitCount);
        s.aborting = false;
        return;
      }

      // Hallucination loop detection: if 3+ continues in 10min, force abort+resume
      if (isHallucinationLoop(s)) {
        log('hallucination loop detected! forcing abort+resume to break cycle');
        try {
          await input.client.session.abort({
            path: { id: sessionId },
            query: { directory: input.directory || "" }
          });
          await new Promise(r => setTimeout(r, 3000));
        } catch (e) {
          log('abort in hallucination loop handler failed:', e);
        }
      }

      let messageText = config.continueMessage;
      const templateVars: Record<string, string> = {
        attempts: String(s.attempts + 1),
        maxAttempts: String(config.maxRecoveries),
      };

      // If tool-text was detected, use the tool-text recovery prompt
      if (hasToolText) {
        messageText = TOOL_TEXT_RECOVERY_PROMPT;
        log('using tool-text recovery prompt');
      } else if (s.lastAdvisoryAdvice?.customPrompt) {
        // Use AI-generated custom prompt if available
        messageText = s.lastAdvisoryAdvice.customPrompt;
        log('using AI-generated custom prompt:', messageText);
      } else if (s.planning) {
        messageText = config.continueWithPlanMessage;
        log('using plan-aware continue message');
      } else if (config.includeTodoContext) {
        try {
          const todoResult = await input.client.session.todo({ path: { id: sessionId } });
          const todos = Array.isArray(todoResult.data) ? todoResult.data : [];
          const pending = todos.filter((t: any) => t.status === 'in_progress' || t.status === 'pending');
          const completed = todos.filter((t: any) => t.status === 'completed' || t.status === 'cancelled');

          templateVars.total = String(todos.length);
          templateVars.completed = String(completed.length);
          templateVars.pending = String(pending.length);

          if (pending.length > 0) {
            const todoList = pending.slice(0, 5).map((t: any) => t.content || t.title || t.id).join(', ');
            templateVars.todoList = todoList + (pending.length > 5 ? '...' : '');
            messageText = formatMessage(config.continueWithTodosMessage, templateVars);
            log('todo context added:', pending.length, 'pending tasks');
          } else {
            log('no pending todos');
          }
        } catch (e) {
          log('todo fetch failed:', e);
        }
      }

      if (messageText === config.continueMessage) {
        messageText = formatMessage(config.continueMessage, templateVars);
      }

      if (s.tokenLimitHits > 0) {
        log('using short continue message due to previous token limit hits:', s.tokenLimitHits);
        messageText = config.shortContinueMessage;
      }

      // Prompt guard: prevent duplicate continue messages
      const isDuplicate = await shouldBlockPrompt(sessionId, messageText, input, log);
      if (isDuplicate) {
        log('prompt guard blocked duplicate continue, skipping recovery');
        s.aborting = false;
        return;
      }

      s.needsContinue = true;
      s.continueMessageText = messageText;
      log('queued continue message, waiting for stable state');

      s.attempts++;
      s.autoSubmitCount++;
      s.lastRecoveryTime = Date.now();
      s.backoffAttempts = 0;
      s.messageCount++;

      s.nudgeCount = 0;
      cancelNudge(sessionId);

      // If abort polling already confirmed idle, send the queued prompt now.
      // Otherwise do one final status check; relying only on a future idle event
      // can strand the custom continue message after a successful abort.
      if (deps.sendContinue && (isIdle || await isSessionIdle(sessionId))) {
        log('session is idle after recovery, sending queued continue immediately');
        await deps.sendContinue(sessionId);
      }
    } catch (e) {
      log('recovery failed:', e);
      s.timer = setTimeout(() => recover(sessionId), config.stallTimeoutMs * 2);
    } finally {
      s.aborting = false;
    }
  }

  return { recover };
}
