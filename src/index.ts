import type { Plugin } from "@opencode-ai/plugin";
import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import {
  type SessionState,
  type PluginConfig,
  DEFAULT_CONFIG,
  validateConfig,
  PLAN_PATTERNS,
  isPlanContent,
  estimateTokens,
  formatDuration,
  createSession,
  updateProgress,
  formatMessage,
} from "./shared.js";
import { createTerminalModule } from "./terminal.js";
import { createNotificationModule } from "./notifications.js";
import { createNudgeModule } from "./nudge.js";
import { createStatusFileModule } from "./status-file.js";
import { createRecoveryModule } from "./recovery.js";
import { createCompactionModule } from "./compaction.js";
import { createReviewModule } from "./review.js";

export const AutoForceResumePlugin: Plugin = async (input, options) => {
  let config: PluginConfig = {
    ...DEFAULT_CONFIG,
    ...(typeof options === "object" && options !== null ? options as Partial<PluginConfig> : {}),
  };
  config = validateConfig(config);

  const sessions = new Map<string, SessionState>();
  let isDisposed = false;

  function getSession(id: string): SessionState {
    if (!sessions.has(id)) {
      sessions.set(id, createSession());
    }
    return sessions.get(id)!;
  }

  function clearTimer(id: string) {
    const s = sessions.get(id);
    if (s?.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
  }

  function resetSession(id: string) {
    clearTimer(id);
    const s = sessions.get(id);
    if (s) {
      s.planBuffer = '';
      s.planning = false;
      s.compacting = false;
      s.backoffAttempts = 0;
      s.autoSubmitCount = 0;
      s.lastUserMessageId = '';
      s.sentMessageAt = 0;
      s.reviewFired = false;
      if (s.reviewDebounceTimer) {
        clearTimeout(s.reviewDebounceTimer);
        s.reviewDebounceTimer = null;
      }
      if (s.nudgeTimer) {
        clearTimeout(s.nudgeTimer);
        s.nudgeTimer = null;
      }
      s.lastNudgeAt = 0;
      s.hasOpenTodos = false;
      s.needsContinue = false;
      s.continueMessageText = '';
      s.messageCount = 0;
      s.estimatedTokens = 0;
      s.lastCompactionAt = 0;
      s.tokenLimitHits = 0;
      s.actionStartedAt = 0;
      s.stallDetections = 0;
      s.recoverySuccessful = 0;
      s.recoveryFailed = 0;
      s.lastRecoverySuccess = 0;
      s.totalRecoveryTimeMs = 0;
      s.recoveryStartTime = 0;
      s.statusHistory = [];
      s.recoveryTimes = [];
      s.lastStallPartType = "";
      s.stallPatterns = {};
      if (s.toastTimer) {
        clearInterval(s.toastTimer);
        s.toastTimer = null;
      }
    }
    sessions.delete(id);
  }

  const logDir = join(process.env.HOME || "/tmp", ".opencode", "logs");
  const logFile = join(logDir, "auto-force-resume.log");

  function ensureLogDir() {
    try {
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }
    } catch {
      // ignore
    }
  }

  function log(...args: unknown[]) {
    if (!config.debug) return;
    try {
      ensureLogDir();
      const timestamp = new Date().toISOString();
      const message = `[${timestamp}] [auto-force-resume] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`;
      appendFileSync(logFile, message);
    } catch {
      // ignore file errors silently
    }
  }

  const terminal = createTerminalModule({ config, sessions, log, input });
  const notifications = createNotificationModule({ config, sessions, log, isDisposed, input });
  const nudge = createNudgeModule({ config, sessions, log, isDisposed: () => isDisposed, input });

  const { writeStatusFile } = createStatusFileModule({ config, sessions, log });

  const { recover } = createRecoveryModule({ config, sessions, log, input, isDisposed: () => isDisposed, writeStatusFile, cancelNudge: nudge.cancelNudge });

  const compaction = createCompactionModule({ config, sessions, log, input });

  const review = createReviewModule({ config, sessions, log, input, isDisposed: () => isDisposed, writeStatusFile, isTokenLimitError: compaction.isTokenLimitError, forceCompact: compaction.forceCompact });

  terminal.registerStatusLineHook();

  return {
    event: async ({ event }: { event: any }) => {
      try {
        const e = event as any;
        const sid = e?.properties?.sessionID || e?.properties?.info?.sessionID || e?.properties?.part?.sessionID || "default";

      const progressTypes = [
        "message.part.updated",
      ];

      const staleTypes = [
        "session.error",
        "session.ended",
        "session.deleted"
      ];

      if (event?.type === "session.error") {
        const err = e?.properties?.error;
        log('session.error:', err?.name, err?.message);
        if (err?.name === "MessageAbortedError") {
          const s = sessions.get(sid);
          if (s) {
            s.userCancelled = true;
            nudge.pauseNudge(sid);
          }
          log('user cancelled session:', sid);
        } else if (compaction.isTokenLimitError(err)) {
          const s = sessions.get(sid);
          if (s) {
            s.tokenLimitHits++;
            log('token limit error detected (hit #' + s.tokenLimitHits + ') for session:', sid);
            // Attempt emergency compaction asynchronously
            compaction.forceCompact(sid).then(async (compacted) => {
              if (compacted) {
                log('emergency compaction succeeded for session:', sid);
                // Queue a short continue after emergency compaction
                s.needsContinue = true;
                s.continueMessageText = config.shortContinueMessage;
                await review.sendContinue(sid);
              } else {
                log('emergency compaction failed for session:', sid);
              }
            }).catch((e) => {
              log('emergency compaction error:', e);
            });
          }
        }
        clearTimer(sid);
        writeStatusFile(sid);
        return;
      }

      if (event?.type === "session.created") {
        log('session.created:', sid);
        getSession(sid);
        writeStatusFile(sid);
        return;
      }

      if (event?.type === "session.updated") {
        log('session.updated:', sid);
        // Session was modified (e.g., model/provider change) — preserve state
        writeStatusFile(sid);
        return;
      }

      if (event?.type === "session.diff") {
        // Session diff events are informational — no action needed
        log('session.diff:', sid);
        return;
      }

      if (event?.type === "message.updated") {
        const info = e?.properties?.info;
        if (info?.role === "user" && info?.id) {
          const s = getSession(sid);
          if (s.lastUserMessageId !== info.id) {
            s.lastUserMessageId = info.id;
            s.autoSubmitCount = 0;
            s.attempts = 0;
            s.backoffAttempts = 0;
            nudge.resetNudge(sid);
            log('user message detected, resetting counters:', sid);
          }
        }
        // Track actual tokens from assistant messages
        if (info?.role === "assistant" && info?.tokens) {
          const s = getSession(sid);
          const msgTokens = info.tokens;
          const totalMsgTokens = (msgTokens.input || 0) + (msgTokens.output || 0) + (msgTokens.reasoning || 0);
          if (totalMsgTokens > 0) {
            // AssistantMessage.tokens represents tokens for this specific message
            // We accumulate to get a rough total (this will be an overestimate since
            // it counts all messages, not just the ones in context window)
            s.estimatedTokens += totalMsgTokens;
            log('assistant message tokens:', totalMsgTokens, 'input:', msgTokens.input, 'output:', msgTokens.output, 'reasoning:', msgTokens.reasoning, 'session:', sid);
          }
        }
        writeStatusFile(sid);
        return;
      }

      if (event?.type === "session.status") {
        const status = e?.properties?.status;
        log('session.status:', sid, status?.type);
        const s = getSession(sid);
        
        // Try reading actual token count from status response if available
        // Some OpenCode versions include token info in status responses
        if (status && typeof status === 'object') {
          const rawStatus = status as any;
          if (typeof rawStatus.tokensInput === 'number') {
            s.estimatedTokens = Math.max(s.estimatedTokens, rawStatus.tokensInput);
          }
          if (typeof rawStatus.tokensOutput === 'number') {
            s.estimatedTokens = Math.max(s.estimatedTokens, (rawStatus.tokensInput || 0) + rawStatus.tokensOutput);
          }
          if (typeof rawStatus.totalTokens === 'number') {
            s.estimatedTokens = Math.max(s.estimatedTokens, rawStatus.totalTokens);
          }
        }
        
        if (status?.type === "busy" || status?.type === "retry") {
          updateProgress(s);
          s.userCancelled = false;
          if (s.planning) {
            log('session busy, clearing plan flag');
            s.planning = false;
          }
          if (s.compacting) {
            log('session busy, clearing compacting flag (compaction likely finished)');
            s.compacting = false;
          }
          // Start timer toast if not already running
          if (s.actionStartedAt === 0) {
            notifications.startTimerToast(sid);
          }
          // Update terminal title and progress
          terminal.updateTerminalTitle(sid);
          terminal.updateTerminalProgress(sid);
          // Check for proactive compaction when resuming busy
          // Catches pre-existing context bloat from prior interactions
          await compaction.maybeProactiveCompact(sid);
        }
        // Send queued continue when session becomes idle/stable
        if (status?.type === "idle" && s.needsContinue) {
          log('session idle, sending queued continue for:', sid);
          await review.sendContinue(sid);
        }
        // Proactive compaction when idle and message count is high
        if (status?.type === "idle" && !s.needsContinue) {
          await compaction.maybeProactiveCompact(sid);
        }
        // Auto-continue when transitioning busy→idle with pending todos
        if (status?.type === "idle" && !s.needsContinue && s.hasOpenTodos && config.nudgeEnabled) {
          nudge.scheduleNudge(sid);
        }
        // Stop timer toast and clear terminal title/progress when session becomes idle
        if (status?.type === "idle") {
          notifications.stopTimerToast(sid);
          terminal.clearTerminalTitle();
          terminal.clearTerminalProgress();
        }
        clearTimer(sid);
        if (!s.planning && !s.compacting) {
          s.timer = setTimeout(() => {
            recover(sid);
          }, config.stallTimeoutMs);
        }
        // Check for proactive compaction on every progress event
        // This ensures we catch context bloat during active sessions
        if (!s.planning && !s.compacting && s.estimatedTokens > 0) {
          await compaction.maybeProactiveCompact(sid);
        }
        writeStatusFile(sid);
        return;
      }

      if (progressTypes.includes(event?.type)) {
        log('progress event:', event?.type, sid);
        const s = getSession(sid);

        if (event?.type === "message.part.updated") {
          const part = e?.properties?.part;
          const partType = part?.type;
          
          // CRITICAL: Ignore synthetic messages to prevent infinite loops
          if (part?.synthetic === true) {
            log('ignoring synthetic message part');
            return;
          }
          
          const isRealProgress = partType === "text" || partType === "step-finish" || partType === "reasoning" || partType === "tool" || partType === "step-start" || partType === "subtask" || partType === "file";
          log('message.part.updated:', partType, isRealProgress ? '(progress)' : '(ignored)');
          if (isRealProgress) {
            updateProgress(s);
            s.attempts = 0;
            s.userCancelled = false;
            // Track part type for stall pattern detection
            s.lastStallPartType = partType || "unknown";
            
            // Estimate tokens from ALL part types, not just text
            // This gives a more accurate picture of total context usage
            let partText = "";
            if (partType === "text") {
              partText = e?.properties?.part?.text as string || "";
            } else if (partType === "reasoning") {
              partText = e?.properties?.part?.reasoning as string || "";
            } else if (partType === "tool") {
              partText = JSON.stringify(e?.properties?.part) || "";
            } else if (partType === "file") {
              partText = (e?.properties?.part?.url || "") + " " + (e?.properties?.part?.mime || "");
            } else if (partType === "subtask") {
              partText = (e?.properties?.part?.prompt || "") + " " + (e?.properties?.part?.description || "");
            } else if (partType === "step-start") {
              partText = e?.properties?.part?.name || "";
            }
            
            if (partText) {
              const estimatedTokens = estimateTokens(partText);
              s.estimatedTokens += estimatedTokens;
            }
            // Extract actual tokens from step-finish parts (most accurate source)
            if (partType === "step-finish" && part?.tokens) {
              const stepTokens = part.tokens;
              const totalStepTokens = (stepTokens.input || 0) + (stepTokens.output || 0) + (stepTokens.reasoning || 0);
              if (totalStepTokens > 0) {
                // step-finish tokens represent the actual tokens used in this completion step
                // This is the most accurate token count available
                s.estimatedTokens = Math.max(s.estimatedTokens, totalStepTokens);
                log('step-finish tokens:', totalStepTokens, 'input:', stepTokens.input, 'output:', stepTokens.output, 'reasoning:', stepTokens.reasoning, 'session:', sid);
              }
            }
          }
          if (partType === "compaction") {
            log('compaction started, pausing stall monitoring');
            s.compacting = true;
          }
          if (partType === "text") {
            const partText = e?.properties?.part?.text as string | undefined;
            if (partText) {
              if (isPlanContent(partText)) {
                log('plan detected in updated text part, pausing stall monitoring');
                s.planning = true;
              }
            }
          }
        }

        // Check if this is a delta update containing plan content
        const deltaText = e?.properties?.delta as string | undefined;
        if (deltaText) {
          s.planBuffer = (s.planBuffer + deltaText).slice(-200);
          if (isPlanContent(s.planBuffer)) {
            log('plan detected in delta, pausing stall monitoring — user must address');
            s.planning = true;
            s.planBuffer = '';
          }
        }

        clearTimer(sid);
        if (!s.planning && !s.compacting) {
          s.timer = setTimeout(() => {
            recover(sid);
          }, config.stallTimeoutMs);
        }
        writeStatusFile(sid);
        return;
      }

      if (event?.type === "message.created" || event?.type === "message.part.added") {
        // Check if this is a real user message (not our synthetic prompt)
        const msgRole = e?.properties?.info?.role;
        const isUserMessage = msgRole === "user";
        
        if (isUserMessage) {
          // User sent a message - cancel any queued continue and process normally
          const s = sessions.get(sid);
          if (s && s.needsContinue) {
            log('user message during recovery, cancelling queued continue');
            s.needsContinue = false;
            s.continueMessageText = '';
          }
        } else {
          // Non-user message (likely our synthetic prompt) - check if we're recovering
          const s = sessions.get(sid);
          if (s && s.needsContinue) {
            log('ignoring synthetic message event during recovery:', event?.type);
            return;
          }
        }
        
        log('activity event:', event?.type, sid, 'role:', msgRole);
        const s = getSession(sid);
        
        // Track message count and estimate tokens for proactive compaction
        if (isUserMessage) {
          s.messageCount++;
          // Estimate tokens from message text
          const msgText = e?.properties?.info?.content || e?.properties?.info?.text || '';
          const estimatedTokens = estimateTokens(msgText);
          s.estimatedTokens += estimatedTokens;
          log('message count incremented:', s.messageCount, 'estimated tokens added:', estimatedTokens, 'total:', s.estimatedTokens);
        } else {
          // Also estimate tokens from assistant/tool responses
          const msgText = e?.properties?.info?.content || e?.properties?.info?.text || '';
          if (msgText) {
            const estimatedTokens = estimateTokens(msgText);
            s.estimatedTokens += estimatedTokens;
          }
        }
        
        updateProgress(s);
        s.attempts = 0;
        s.userCancelled = false;
        if (s.planning) {
          log('user sent message, clearing plan flag');
          s.planning = false;
        }
        if (s.compacting) {
          log('user sent message, clearing compacting flag');
          s.compacting = false;
        }
        clearTimer(sid);
        if (!s.planning && !s.compacting) {
          s.timer = setTimeout(() => {
            recover(sid);
          }, config.stallTimeoutMs);
        }
        writeStatusFile(sid);
        return;
      }

      if (event?.type === "todo.updated") {
        const todos = e?.properties?.todos;
        if (!Array.isArray(todos)) return;
        
        const s = getSession(sid);
        const allCompleted = todos.length > 0 && todos.every((t: any) => t.status === 'completed' || t.status === 'cancelled');
        const hasPending = todos.some((t: any) => t.status === 'in_progress' || t.status === 'pending');
        
        // Track open todos for nudging
        s.hasOpenTodos = hasPending;
        
        // Handle review on completion
        if (allCompleted && !s.reviewFired && config.reviewOnComplete) {
          if (s.reviewDebounceTimer) {
            clearTimeout(s.reviewDebounceTimer);
          }
          s.reviewDebounceTimer = setTimeout(() => {
            s.reviewDebounceTimer = null;
            review.triggerReview(sid);
          }, config.reviewDebounceMs);
        } else if (!allCompleted && s.reviewDebounceTimer) {
          clearTimeout(s.reviewDebounceTimer);
          s.reviewDebounceTimer = null;
        }

        // Nudge is triggered by session.idle — todo.updated just sets hasOpenTodos flag
        writeStatusFile(sid);
        return;
      }

      // session.idle fires when the model stops generating and goes idle
      // Schedule a nudge after delay (nudge module handles cooldown, loop protection, etc.)
      if (event?.type === "session.idle") {
        nudge.scheduleNudge(sid);
        writeStatusFile(sid);
        return;
      }

      // session.compacted fires when context compaction completes
      // The session is still active after compaction, so preserve state
      if (event?.type === "session.compacted") {
        const s = getSession(sid);
        log('session compacted, clearing compacting flag:', sid);
        s.compacting = false;
        s.lastCompactionAt = Date.now();
        // Reset estimated tokens since context was just compacted
        s.estimatedTokens = Math.floor(s.estimatedTokens * 0.3);
        // Reset recovery counters since we just freed context space
        s.attempts = 0;
        s.backoffAttempts = 0;
        // Restart stall timer since we just freed context
        clearTimer(sid);
        if (!s.planning && !s.compacting) {
          s.timer = setTimeout(() => recover(sid), 0);
        }
        writeStatusFile(sid);
        return;
      }

      if (staleTypes.includes(event?.type)) {
        log('stale event:', event?.type, sid);
        nudge.cancelNudge(sid);
        resetSession(sid);
        writeStatusFile(sid);
        return;
      }
    } catch (err) {
      log('event handler error:', err);
      // Don't crash the plugin — errors in one event shouldn't break the pipeline
    }
  },
    dispose: () => {
      log('disposing plugin');
      isDisposed = true;
      sessions.forEach((s) => {
        if (s.timer) {
          clearTimeout(s.timer);
          s.timer = null;
        }
        if (s.reviewDebounceTimer) {
          clearTimeout(s.reviewDebounceTimer);
          s.reviewDebounceTimer = null;
        }
        if (s.nudgeTimer) {
          clearTimeout(s.nudgeTimer);
          s.nudgeTimer = null;
        }
        if (s.toastTimer) {
          clearInterval(s.toastTimer);
          s.toastTimer = null;
        }
      });
      sessions.clear();
    }
  };
};

