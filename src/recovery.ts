import type { PluginConfig } from "./config.js";
import type { SessionState } from "./session-state.js";
import { formatMessage, shouldBlockPrompt, containsToolCallAsText } from "./shared.js";
import type { TypedPluginInput } from "./types.js";

export interface RecoveryDeps {
  config: PluginConfig;
  sessions: Map<string, SessionState>;
  log: (...args: unknown[]) => void;
  input: TypedPluginInput;
  isDisposed: () => boolean;
  writeStatusFile: (sessionId: string) => void;
  cancelNudge: (sessionId: string) => void;
  scheduleRecovery: (sessionId: string, delayMs: number) => void;
  sendContinue?: (sessionId: string) => Promise<void>;
  maybeHardCompact?: (sessionId: string) => Promise<boolean>;
  forceCompact?: (sessionId: string) => Promise<boolean>;
}

const TOOL_TEXT_RECOVERY_PROMPT =
  "I noticed you have a tool call generated in your thinking/reasoning. Please execute it using the proper tool calling mechanism instead of keeping it in reasoning.";

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
  return s.continueTimestamps.length >= LOOP_MAX_CONTINUES;
}

export function createRecoveryModule(deps: RecoveryDeps) {
  const { config, sessions, log, input, isDisposed, writeStatusFile, cancelNudge, scheduleRecovery } = deps;

  // FIX 1: scheduleRecovery is now passed in from index.ts (unified implementation with generation counter)

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
    // FIX 3/11: Allow recovery if planning has been going on too long
    if (s.planning && Date.now() - s.planningStartedAt < config.planningTimeoutMs) {
      log('session is planning, skipping recovery (planning timeout not reached):', sessionId);
      return;
    } else if (s.planning) {
      log('planning timeout reached (', config.planningTimeoutMs, 'ms), forcing recovery:', sessionId);
      s.planning = false; // Clear planning flag to allow recovery
    }
    if (s.compacting) return;
    if (s.hardCompactionInProgress) return;

    if (deps.maybeHardCompact) {
      try {
        const compacted = await deps.maybeHardCompact(sessionId);
        if (compacted) {
          log('hard compaction succeeded before recovery, tokens now below threshold:', sessionId);
        }
      } catch (e) {
        log('hard compaction before recovery failed (proceeding anyway):', e);
      }
    }

    if (s.attempts >= config.maxRecoveries) {
      const backoffDelay = Math.min(
        config.stallTimeoutMs * Math.pow(2, s.backoffAttempts),
        config.maxBackoffMs
      );
      s.backoffAttempts++;
      log('max recoveries reached, using exponential backoff:', backoffDelay, 'ms (attempt', s.backoffAttempts, ')');
      scheduleRecovery(sessionId, backoffDelay);
      return;
    }

    const now = Date.now();

    if (now - s.lastRecoveryTime < config.cooldownMs) {
      const remainingCooldown = config.cooldownMs - (now - s.lastRecoveryTime);
      const delay = Math.max(remainingCooldown, 100);
      log('recovery cooldown active, rescheduling:', delay, 'ms');
      scheduleRecovery(sessionId, delay);
      return;
    }

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

      // Check normal stall timeout (no progress at all)
      if (currentTime - s.lastProgressAt < config.stallTimeoutMs) {
        // Check busy-but-dead: session has "progress" pings but no actual output
        const timeSinceOutput = currentTime - s.lastOutputAt;
        if (timeSinceOutput < config.busyStallTimeoutMs) {
          // Check text-only stall: session outputting text but no tool execution
          const timeSinceToolExecution = currentTime - s.lastToolExecutionAt;
          if (config.textOnlyStallTimeoutMs > 0 && timeSinceToolExecution > config.textOnlyStallTimeoutMs) {
            log('text-only stall in recover(): no tool execution for', timeSinceToolExecution, 'ms');
            // Fall through to recovery — tool-text detection will confirm
          } else {
            s.aborting = false;
            const remaining = config.stallTimeoutMs - (currentTime - s.lastProgressAt);
            scheduleRecovery(sessionId, Math.max(remaining, 100));
            return;
          }
        } else {
          log('busy-but-dead detected: last progress recent but no actual output for', timeSinceOutput, 'ms');
        }
        // Fall through to recovery despite recent progress ping
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
        scheduleRecovery(sessionId, config.stallTimeoutMs * 2);
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

      // Now that session is idle, try compaction via the compaction module
      // (uses proper flag management, safety timers, and retry logic)
      if (config.autoCompact && !hasToolText && isIdle && deps.forceCompact) {
        try {
          log('attempting auto-compaction via compaction module for session:', sessionId);
          const compacted = await deps.forceCompact(sessionId);
          if (compacted) {
            log('auto-compaction successful after recovery abort');
            // forceCompact handles flag cleanup and session.compacted event will fire
          } else {
            log('auto-compaction did not succeed after recovery abort');
          }
        } catch (e: any) {
          log('auto-compaction failed:', e?.message || e?.name || String(e));
        }
      }

      const remainingWait = config.waitAfterAbortMs - (Date.now() - startTime);
      if (remainingWait > 0) {
        await new Promise(r => setTimeout(r, remainingWait));
      }

      if (s.attempts >= config.maxRecoveries) {
        log('loop protection: max recoveries reached:', s.attempts);
        // Show toast when loop protection activates
        try {
          await input.client.tui.showToast({
            query: { directory: input.directory || "" },
            body: {
              title: "Auto-Continue Paused",
              message: `Max recoveries (${config.maxRecoveries}) reached. Send a message to resume.`,
              variant: "warning",
            },
          });
        } catch (e) {
          log('max recoveries toast error (ignored):', e);
        }
        s.needsContinue = false;
        s.continueMessageText = '';
        s.aborting = false;
        return;
      }

      // Hallucination loop detection: if 3+ continues in 10min, just wait and resume
      // No need to abort again — session was already aborted above
      if (isHallucinationLoop(s)) {
        log('hallucination loop detected! waiting before resume to break cycle');
        await new Promise(r => setTimeout(r, 3000));
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

      // Build recovery intent context from tracked state
      let intentHint = '';
      if (s.lastToolSummary) {
        intentHint = `You were last: ${s.lastToolSummary}. `;
      }
      if (s.lastFileEdited) {
        const fileName = s.lastFileEdited.split('/').pop() || s.lastFileEdited;
        intentHint += `File: ${fileName}. `;
      }
      if (intentHint) {
        messageText = messageText.trim() + '\n\n## Recovery Context\n' + intentHint;
        log('recovery intent added:', intentHint);
      }

      if (s.tokenLimitHits > 0 && !hasToolText && !s.planning) {
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
      recordContinue(s);
      s.autoSubmitCount++;
      s.lastRecoveryTime = Date.now();
      s.backoffAttempts = 0;
      s.messageCount++;

      s.nudgeCount = 0;
      cancelNudge(sessionId);

      // Show toast so user knows auto-continue is happening
      try {
        await input.client.tui.showToast({
          query: { directory: input.directory || "" },
          body: {
            title: "Auto-Continue",
            message: `Session stalled. Sending continue message (attempt ${s.attempts}/${config.maxRecoveries})...`,
            variant: "warning",
          },
        });
      } catch (e) {
        log('recovery toast error (ignored):', e);
      }

      // If abort polling already confirmed idle, send the queued prompt now.
      // Otherwise do one final status check; relying only on a future idle event
      // can strand the custom continue message after a successful abort.
      if (deps.sendContinue) {
        const readyForContinue = await isSessionIdle(sessionId);
        if (readyForContinue) {
          log('session is idle after recovery, sending queued continue immediately');
          await deps.sendContinue(sessionId);
        } else {
          log('queued continue remains pending until session becomes idle:', sessionId);
        }
      }
    } catch (e) {
      log('recovery failed:', e);
      // FIX 3: Only increment recoveryFailed here - attempts was already incremented in try block (line 379)
      s.recoveryFailed++;
      
      if (s.attempts >= config.maxRecoveries) {
        // Use exponential backoff after max recoveries
        const backoffDelay = Math.min(
          config.stallTimeoutMs * Math.pow(2, s.backoffAttempts),
          config.maxBackoffMs
        );
        s.backoffAttempts++;
        log('recovery failed and max reached, using backoff:', backoffDelay, 'ms (attempt', s.attempts, ')');
        scheduleRecovery(sessionId, backoffDelay);
      } else {
        // Normal retry with increased delay
        const retryDelay = config.stallTimeoutMs * 2;
        log('recovery failed, scheduling retry in:', retryDelay, 'ms (attempt', s.attempts, ')');
        scheduleRecovery(sessionId, retryDelay);
      }
    } finally {
      s.aborting = false;
    }
  }

  return { recover };
}
