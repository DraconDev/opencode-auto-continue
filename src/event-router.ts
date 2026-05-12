/**
 * Event Router Module
 * 
 * Routes OpenCode events to appropriate handlers.
 * Extracted from index.ts to reduce file size and improve maintainability.
 */

import type { SessionState, Todo } from "./session-state.js";
import type { PluginConfig } from "./config.js";
import { safeHook, parseTokensFromError, estimateTokens, isPlanContent, scheduleRecoveryWithGeneration } from "./shared.js";
import { existsSync } from "fs";
import { getPlanPath, markPlanItemComplete } from "./plan.js";

export interface EventRouterDeps {
  config: PluginConfig;
  sessions: Map<string, SessionState>;
  log: (...args: unknown[]) => void;
  getSession: (id: string) => SessionState;
  clearTimer: (id: string) => void;
  resetSession: (id: string) => void;
  terminal: {
    updateTerminalTitle: (sid: string) => void;
    updateTerminalProgress: (sid: string) => void;
    clearTerminalTitle: () => void;
    clearTerminalProgress: () => void;
  };
  nudge: {
    scheduleNudge: (sid: string) => void;
    cancelNudge: (sid: string) => void;
    pauseNudge: (sid: string) => void;
    resetNudge: (sid: string) => void;
  };
  review: {
    sendContinue: (sid: string) => Promise<void>;
    triggerReview: (sid: string) => Promise<void>;
  };
  recover: (sid: string) => Promise<void>;
  compaction: {
    isTokenLimitError: (err: unknown) => boolean;
    forceCompact: (sid: string) => Promise<boolean>;
    maybeProactiveCompact: (sid: string) => Promise<boolean>;
  };
  sessionMonitor: {
    touchSession: (sid: string) => void;
  };
  writeStatusFile: (sid: string) => void;
  updateProgress: (s: SessionState) => void;
  createSession: () => SessionState;
}

export function createEventRouter(deps: EventRouterDeps) {
  const {
    config, sessions, log, getSession, clearTimer, resetSession,
    terminal, nudge, review, recover, compaction, sessionMonitor,
    writeStatusFile, updateProgress
  } = deps;

  const progressTypes = ["message.part.updated"];
  const staleTypes = ["session.error", "session.ended", "session.deleted"];

  async function handleEvent(event: any) {
    await safeHook("event", async () => {
      const e = event;
      const sid = e?.properties?.sessionID || e?.properties?.info?.sessionID || e?.properties?.part?.sessionID || "default";

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
            const parsedTokens = parseTokensFromError(err);
            if (parsedTokens) {
              s.estimatedTokens = Math.max(s.estimatedTokens, parsedTokens.total);
              log('parsed tokens from error:', parsedTokens.total, 'input:', parsedTokens.input, 'output:', parsedTokens.output, 'session:', sid);
            }
            log('token limit error detected (hit #' + s.tokenLimitHits + ') for session:', sid);
            compaction.forceCompact(sid).then(async (compacted) => {
              if (compacted) {
                log('emergency compaction succeeded for session:', sid);
                s.needsContinue = true;
                s.continueMessageText = s.planning ? config.continueWithPlanMessage : config.shortContinueMessage;
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
        sessionMonitor.touchSession(sid);
        writeStatusFile(sid);
        return;
      }

      if (event?.type === "session.updated") {
        log('session.updated:', sid);
        writeStatusFile(sid);
        return;
      }

      if (event?.type === "session.diff") {
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
        if (info?.role === "assistant" && info?.tokens) {
          const s = getSession(sid);
          const msgTokens = info.tokens;
          const totalMsgTokens = (msgTokens.input || 0) + (msgTokens.output || 0) + (msgTokens.reasoning || 0);
          if (totalMsgTokens > 0) {
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
        
        if (status?.type === "busy" || status?.type === "retry") {
          updateProgress(s);
          sessionMonitor.touchSession(sid);
          s.userCancelled = false;
          if (s.actionStartedAt === 0) {
            s.actionStartedAt = Date.now();
          }
          if (s.compacting) {
            log('session busy, clearing compacting flag (compaction likely finished)');
            s.compacting = false;
          }
          terminal.updateTerminalTitle(sid);
          terminal.updateTerminalProgress(sid);
        }
        if (status?.type === "idle" && s.needsContinue) {
          log('session idle, sending queued continue for:', sid);
          await review.sendContinue(sid);
        }
        if (status?.type === "idle" && !s.needsContinue && config.nudgeEnabled) {
          nudge.scheduleNudge(sid);
        }
        if (status?.type === "idle") {
          terminal.clearTerminalTitle();
          terminal.clearTerminalProgress();
        }
        if (status?.type === "busy" || status?.type === "retry") {
        clearTimer(sid);
        if (!s.planning && !s.compacting) {
          scheduleRecoveryWithGeneration(sessions, sid, config.stallTimeoutMs, recover, log);
        }
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
          
          if (part?.synthetic === true) {
            log('ignoring synthetic message part');
            return;
          }
          
          const isRealProgress = partType === "text" || partType === "step-finish" || partType === "reasoning" || partType === "tool" || partType === "step-start" || partType === "subtask" || partType === "file";
          log('message.part.updated:', partType, isRealProgress ? '(progress)' : '(ignored)');
          if (isRealProgress) {
            updateProgress(s);
            sessionMonitor.touchSession(sid);
            s.attempts = 0;
            s.userCancelled = false;
            s.lastStallPartType = partType || "unknown";
            
            let partText = "";
            if (partType === "text") {
              partText = e?.properties?.part?.text || "";
            } else if (partType === "reasoning") {
              partText = e?.properties?.part?.reasoning || "";
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
            if (partType === "step-finish" && part?.tokens) {
              const stepTokens = part.tokens;
              const totalStepTokens = (stepTokens.input || 0) + (stepTokens.output || 0) + (stepTokens.reasoning || 0);
              if (totalStepTokens > 0) {
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
            const partText = e?.properties?.part?.text;
            if (partText && isPlanContent(partText)) {
              log('plan detected in updated text part, pausing stall monitoring');
              s.planning = true;
            }
          }

          if (s.planning && (partType === "tool" || partType === "file" || partType === "subtask" || partType === "step-start" || partType === "step-finish")) {
            log('non-plan progress detected, clearing plan flag');
            s.planning = false;
          }
        }

        const deltaText = e?.properties?.delta;
        if (deltaText) {
          s.planBuffer = (s.planBuffer + deltaText).slice(-200);
          if (isPlanContent(s.planBuffer)) {
            log('plan detected in delta, pausing stall monitoring');
            s.planning = true;
            s.planBuffer = '';
          }
        }

        clearTimer(sid);
        if (!s.planning && !s.compacting) {
          s.timer = setTimeout(() => recover(sid), config.stallTimeoutMs);
        }
        writeStatusFile(sid);
        return;
      }

      if (event?.type === "message.created" || event?.type === "message.part.added") {
        const msgRole = e?.properties?.info?.role;
        const isUserMessage = msgRole === "user";
        
        if (isUserMessage) {
          const s = sessions.get(sid);
          if (s && s.needsContinue) {
            log('user message during recovery, cancelling queued continue');
            s.needsContinue = false;
            s.continueMessageText = '';
          }
        } else {
          const s = sessions.get(sid);
          if (s && s.needsContinue) {
            log('ignoring synthetic message event during recovery:', event?.type);
            return;
          }
        }
        
        log('activity event:', event?.type, sid, 'role:', msgRole);
        const s = getSession(sid);
        
        if (isUserMessage) {
          s.messageCount++;
          const msgText = e?.properties?.info?.content || e?.properties?.info?.text || '';
          const estimatedTokens = estimateTokens(msgText);
          s.estimatedTokens += estimatedTokens;
          log('message count incremented:', s.messageCount, 'estimated tokens added:', estimatedTokens, 'total:', s.estimatedTokens);
        } else {
          const msgText = e?.properties?.info?.content || e?.properties?.info?.text || '';
          if (msgText) {
            const estimatedTokens = estimateTokens(msgText);
            s.estimatedTokens += estimatedTokens;
          }
        }
        
        // Check if proactive compaction is needed after token update
        if (s.estimatedTokens > config.proactiveCompactAtTokens && !s.compacting) {
          log('token threshold exceeded:', s.estimatedTokens, '/', config.proactiveCompactAtTokens, 'checking proactive compaction');
          compaction.maybeProactiveCompact(sid).catch((e: unknown) => log('proactive compaction error:', e));
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
          s.timer = setTimeout(() => recover(sid), config.stallTimeoutMs);
        }
        writeStatusFile(sid);
        return;
      }

      if (event?.type === "todo.updated") {
        const todos = e?.properties?.todos;
        if (!Array.isArray(todos)) return;
        
        const s = getSession(sid);
        const allCompleted = todos.length > 0 && todos.every((t: Todo) => t.status === 'completed' || t.status === 'cancelled');
        const hasPending = todos.some((t: Todo) => t.status === 'in_progress' || t.status === 'pending');
        
        s.hasOpenTodos = hasPending;
        s.lastKnownTodos = todos;
        
        if (config.planDrivenContinue && config.planAutoMarkComplete) {
          const completedTodos = todos.filter((t: Todo) => t.status === 'completed' || t.status === 'cancelled');
          if (completedTodos.length > 0) {
            const planPath = getPlanPath((e?.properties?.directory as string) || "", config.planFilePath);
            if (existsSync(planPath)) {
              Promise.resolve().then(() => {
                for (const todo of completedTodos) {
                  const todoDesc = todo.content || todo.title || '';
                  if (todoDesc && markPlanItemComplete(planPath, todoDesc)) {
                    log('auto-marked plan item as complete:', todoDesc);
                  }
                }
              }).catch((e) => {
                log('auto-mark plan items failed:', e);
              });
            }
          }
        }
        
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

        writeStatusFile(sid);
        return;
      }

      if (event?.type === "session.idle") {
        const s = getSession(sid);
        nudge.scheduleNudge(sid);
        writeStatusFile(sid);
        return;
      }

      if (event?.type === "session.compacted") {
        const s = getSession(sid);
        log('session compacted, clearing compacting flag:', sid);
        s.compacting = false;
        s.lastCompactionAt = Date.now();
        s.estimatedTokens = Math.floor(s.estimatedTokens * (1 - config.compactReductionFactor));
        s.attempts = 0;
        s.backoffAttempts = 0;
        clearTimer(sid);
        if (!s.planning && !s.compacting) {
          scheduleRecoveryWithGeneration(sessions, sid, 0, recover, log);
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
    }, log);
  }

  return { handleEvent };
}
