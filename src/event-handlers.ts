import type { PluginConfig } from "./config.js";
import type { SessionState } from "./session-state.js";
import { getTokenCount } from "./session-state.js";
import {
  isPlanContent,
  containsToolCallAsText,
  estimateTokens,
  parseTokensFromError,
  updateProgress,
  safeHook,
  getMessageText,
} from "./shared.js";
import type { createTerminalModule } from "./terminal.js";
import type { createCompactionModule } from "./compaction.js";
import type { createNudgeModule } from "./nudge.js";
import type { createReviewModule } from "./review.js";
import type { createSessionMonitor } from "./session-monitor.js";
import type { createStopConditionsModule } from "./stop-conditions.js";
import type { createTestRunner } from "./test-runner.js";
import type { createTodoPoller } from "./todo-poller.js";
import { containsDangerousCommand, formatDangerousBlocklist } from "./dangerous-commands.js";
import type {
  TypedPluginInput,
  MessageInfo,
  PluginEvent,
  PartInfo,
  PartType,
  SessionStatusType,
  TodoItem,
} from "./types.js";
import { extractSessionId, isSyntheticEvent } from "./types.js";
/** Bundles all dependencies needed by event handlers */
export interface HandlerContext {
  input: TypedPluginInput;
  config: PluginConfig;
  sessions: Map<string, SessionState>;
  log: (...args: unknown[]) => void;
  isDisposed: () => boolean;

  // Session helpers
  getSession: (id: string) => SessionState;
  refreshRealTokens: (id: string) => Promise<number>;
  clearTimer: (id: string) => void;
  resetSession: (id: string) => void;

  // Sub-modules
  terminal: ReturnType<typeof createTerminalModule>;
  writeStatusFile: (sessionId: string) => void;
  clearPendingWrites: () => void;
  compaction: ReturnType<typeof createCompactionModule>;
  nudge: ReturnType<typeof createNudgeModule>;
  review: ReturnType<typeof createReviewModule>;
  sessionMonitor: ReturnType<typeof createSessionMonitor>;
  stopConditions: ReturnType<typeof createStopConditionsModule>;
  testRunner: ReturnType<typeof createTestRunner>;
  todoPoller: ReturnType<typeof createTodoPoller>;

  // Recovery scheduling
  scheduleRecovery: (sessionId: string, delayMs: number) => void;
  recover: (sessionId: string) => Promise<void>;
}

function isSyntheticMessageEvent(e: PluginEvent): boolean {
  return isSyntheticEvent(e);
}

/**
 * Main event dispatcher. Routes events to the appropriate handler function.
 */
export async function handleEvent(ctx: HandlerContext, event: PluginEvent): Promise<void> {
  await safeHook("event", async () => {
    const sid = extractSessionId(event);
    if (!sid) {
      ctx.log('event received without sessionID, skipping:', event.type);
      return;
    }

    const type = event.type;

    if (type === "session.error") {
      await handleSessionError(ctx, sid, event);
    } else if (type === "session.created") {
      await handleSessionCreated(ctx, sid, event);
    } else if (type === "session.updated") {
      handleSessionUpdated(ctx, sid);
    } else if (type === "session.diff") {
      ctx.log('session.diff:', sid);
    } else if (type === "message.updated") {
      await handleMessageUpdated(ctx, sid, event);
    } else if (type === "session.status") {
      await handleSessionStatus(ctx, sid, event);
    } else if (type === "message.part.updated") {
      await handleMessagePartUpdated(ctx, sid, event);
    } else if (type === "message.created" || type === "message.part.added") {
      await handleMessageActivity(ctx, sid, event, type);
    } else if (type === "todo.updated") {
      handleTodoUpdated(ctx, sid, event);
    } else if (type === "question.asked") {
      await handleQuestionAsked(ctx, sid, event);
    } else if (type === "session.idle") {
      await handleSessionIdle(ctx, sid);
    } else if (type === "session.compacted") {
      handleSessionCompacted(ctx, sid);
    } else if (type === "session.ended" || type === "session.deleted") {
      handleSessionEnded(ctx, sid, type);
    }
  }, ctx.log);
}

async function handleSessionError(ctx: HandlerContext, sid: string, e: PluginEvent): Promise<void> {
  const { config, sessions, log, clearTimer, writeStatusFile, compaction, review, scheduleRecovery, input } = ctx;
  const props = e.properties as Record<string, unknown>;
  const err = props.error as { name: string; message?: string; data?: Record<string, unknown>; statusCode?: number; isRetryable?: boolean } | undefined;
  log('session.error:', err?.name, err?.message);

  if (err?.name === "MessageAbortedError") {
    const s = sessions.get(sid);
    if (s?.aborting) {
      log('session abort was plugin-initiated, keeping recovery enabled:', sid);
      clearTimer(sid);
      writeStatusFile(sid);
      return;
    }
    if (s) {
      s.userCancelled = true;
      s.lastKnownStatus = 'error';
      ctx.nudge.pauseNudge(sid);
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

      if (config.showToasts) {
        try {
          input.client.tui.showToast({
            query: { directory: input.directory || "" },
            body: {
              title: "Token Limit Reached",
              message: `Compacting context to free up tokens (hit #${s.tokenLimitHits})...`,
              variant: "warning",
            },
          }).catch(() => {});
        } catch (e) {
          // ignore toast errors
        }
      }

      compaction.forceCompact(sid).then(async (compacted) => {
        if (!sessions.has(sid)) {
          log('session deleted during emergency compaction, skipping continue:', sid);
          return;
        }
        const currentSession = sessions.get(sid)!;
        if (compacted) {
          log('emergency compaction succeeded for session:', sid);
          currentSession.needsContinue = true;
          currentSession.continueMessageText = currentSession.planning ? config.continueWithPlanMessage : config.shortContinueMessage;
          await review.sendContinue(sid);
        } else {
          log('emergency compaction failed for session:', sid);
          currentSession.backoffAttempts++;
          const backoffDelay = Math.min(
            config.stallTimeoutMs * Math.pow(2, currentSession.backoffAttempts),
            config.maxBackoffMs
          );
          log('scheduling recovery after emergency compaction failure, backoff:', backoffDelay, 'ms');
          scheduleRecovery(sid, backoffDelay);
          if (config.showToasts) {
            try {
              input.client.tui.showToast({
                query: { directory: input.directory || "" },
                body: {
                  title: "Compaction Failed",
                  message: `Could not free up tokens. Will retry recovery in ${Math.round(backoffDelay / 1000)}s.`,
                  variant: "error",
                },
              }).catch(() => {});
            } catch (e) {
              // ignore toast errors
            }
          }
        }
      }).catch((e) => {
        log('emergency compaction error:', e);
      });
    }
  }
  clearTimer(sid);
  writeStatusFile(sid);
}

async function handleSessionCreated(ctx: HandlerContext, sid: string, e: PluginEvent): Promise<void> {
  const { config, sessions, log, getSession, sessionMonitor, writeStatusFile, input, isDisposed } = ctx;
  log('session.created:', sid);
  const s = getSession(sid);
  await ctx.refreshRealTokens(sid);
  sessionMonitor.touchSession(sid);

  // Schedule delayed fallback for dangerous command policy injection.
  if (config.dangerousCommandBlocking && config.dangerousCommandInjection) {
    const DANGEROUS_CMD_FALLBACK_MS = 30000;
    s.dangerousCommandPromptTimer = setTimeout(() => {
      s.dangerousCommandPromptTimer = null;
      if (s.systemTransformHookCalled) {
        log('dangerous command policy already injected via system transform hook, skipping session.prompt fallback, session:', sid);
        return;
      }
      if (isDisposed() || !sessions.has(sid)) return;
      log('system transform hook not called after', DANGEROUS_CMD_FALLBACK_MS, 'ms, falling back to session.prompt injection, session:', sid);
      input.client.session.prompt({
        path: { id: sid },
        query: { directory: input.directory || "" },
        body: {
          parts: [{
            type: "text",
            text: `## ⚠️ Dangerous Commands Policy\n\nThe following commands are blocked by policy and must never be used:\n\n${formatDangerousBlocklist()}\n\nIf you need one of these for a legitimate reason, explain why and it can be approved manually.`,
            synthetic: true,
          }],
        },
      }).catch((e: any) => log('dangerous command fallback injection failed:', e));
    }, DANGEROUS_CMD_FALLBACK_MS);
    if (s.dangerousCommandPromptTimer && (s.dangerousCommandPromptTimer as any).unref) {
      (s.dangerousCommandPromptTimer as any).unref();
    }
  }

  writeStatusFile(sid);
}

function handleSessionUpdated(ctx: HandlerContext, sid: string): void {
  ctx.log('session.updated:', sid);
  ctx.writeStatusFile(sid);
}

async function handleMessageUpdated(ctx: HandlerContext, sid: string, e: PluginEvent): Promise<void> {
  const { config, sessions, log, getSession, nudge, writeStatusFile } = ctx;
  const props = e.properties as Record<string, unknown>;
  const info = props.info as MessageInfo | undefined;
  const isSynthetic = isSyntheticMessageEvent(e);

  if (info?.role === "user" && isSynthetic) {
    log('ignoring synthetic user message update:', sid);
    writeStatusFile(sid);
    return;
  }

  if (info?.role === "user" && info?.id) {
    const s = getSession(sid);
    if (s.lastUserMessageId !== info.id) {
      s.lastUserMessageId = info.id;
      s.autoSubmitCount = 0;
      s.attempts = 0;
      s.backoffAttempts = 0;
      s.lastNudgeAt = 0;
      s.lastContinueAt = 0;
      s.lastOutputAt = Date.now();
      s.lastToolExecutionAt = Date.now();
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
      s.estimatedTokens += totalMsgTokens;
      log('assistant message tokens:', totalMsgTokens, 'input:', msgTokens.input, 'output:', msgTokens.output, 'reasoning:', msgTokens.reasoning, 'session:', sid);
    }
  }

  writeStatusFile(sid);
}

async function handleSessionStatus(ctx: HandlerContext, sid: string, e: PluginEvent): Promise<void> {
  const { config, sessions, log, getSession, clearTimer, writeStatusFile, scheduleRecovery, recover, sessionMonitor, stopConditions, review, compaction, terminal, input, isDisposed, todoPoller, nudge } = ctx;
  const props = e.properties as Record<string, unknown>;
  const status = props.status as SessionStatusType | undefined;
  log('session.status:', sid, status?.type);
  const s = getSession(sid);

  if (status?.type === "busy" || status?.type === "retry") {
    sessionMonitor.touchSession(sid);
    s.userCancelled = false;
    if (s.actionStartedAt === 0) {
      s.actionStartedAt = Date.now();
    }

    // Schedule recovery timer for normal stall detection
    if (!s.planning && !s.compacting) {
      scheduleRecovery(sid, config.stallTimeoutMs);
    }

    // Check for busy-but-dead
    const timeSinceOutput = Date.now() - s.lastOutputAt;
    if (timeSinceOutput > config.busyStallTimeoutMs) {
      const stop = stopConditions.checkStopConditions(sid);
      if (stop.shouldStop) {
        log('[StopConditions] session stopped, skipping busy-but-dead recovery:', stop.reason);
        clearTimer(sid);
      } else {
        const timeSinceToolExecution = Date.now() - s.lastToolExecutionAt;
        if (timeSinceToolExecution < config.busyStallTimeoutMs) {
          log('busy-but-dead rescheduling: no output for', timeSinceOutput, 'ms but tool execution recent (' + timeSinceToolExecution + 'ms), session may be running long tools');
          scheduleRecovery(sid, config.stallTimeoutMs);
        } else {
          log('busy-but-dead detected: no output for', timeSinceOutput, 'ms, forcing recovery');
          if (config.showToasts) {
            try {
              input.client.tui.showToast({
                query: { directory: input.directory || "" },
                body: {
                  title: "Session Stuck",
                  message: `Session busy but no output for ${Math.round(timeSinceOutput / 1000)}s. Forcing recovery...`,
                  variant: "warning",
                },
              }).catch(() => {});
            } catch (e) {
              // ignore toast errors
            }
          }
          recover(sid).catch((e: unknown) => log('busy-but-dead recovery failed:', e));
        }
      }
    }

    // Check for text-only stall
    const timeSinceToolExecution = Date.now() - s.lastToolExecutionAt;
    if (config.textOnlyStallTimeoutMs > 0 && timeSinceToolExecution > config.textOnlyStallTimeoutMs && timeSinceOutput <= config.busyStallTimeoutMs) {
      const stop = stopConditions.checkStopConditions(sid);
      if (stop.shouldStop) {
        log('[StopConditions] session stopped, skipping text-only stall recovery:', stop.reason);
      } else {
        log('text-only stall detected: no tool execution for', timeSinceToolExecution, 'ms (output is recent), forcing recovery');
        if (config.showToasts) {
          try {
            input.client.tui.showToast({
              query: { directory: input.directory || "" },
              body: {
                title: "Text-Only Stall",
                message: `No tool execution for ${Math.round(timeSinceToolExecution / 1000)}s — recovering session.`,
                variant: "warning",
              },
            }).catch(() => {});
          } catch (e) {}
        }
        recover(sid).catch((e: unknown) => log('text-only stall recovery failed:', e));
      }
    }

    // Check for tool loop
    if (s.toolRepeatCount >= config.toolLoopMaxRepeats) {
      const stop = stopConditions.checkStopConditions(sid);
      if (stop.shouldStop) {
        log('[StopConditions] session stopped, skipping tool loop recovery:', stop.reason);
      } else {
        log('tool loop recovery: tool', s.lastToolName, 'repeated', s.toolRepeatCount, 'times, forcing recovery');
        s.toolRepeatCount = 0;
        recover(sid).catch((e: unknown) => log('tool loop recovery failed:', e));
      }
    }

    // Show "Session Resumed" toast
    if (s.lastNudgeAt > 0 && Date.now() - s.lastNudgeAt < 30000) {
      if (config.showToasts) {
        try {
          input.client.tui.showToast({
            query: { directory: input.directory || "" },
            body: {
              title: "Session Resumed",
              message: "The AI has resumed working after the nudge.",
              variant: "info",
            },
          }).catch(() => {});
        } catch (e) {
          // ignore toast errors
        }
      }
      s.lastNudgeAt = 0;
    }

    // Show recovery success toast
    if (s.lastContinueAt > 0 && Date.now() - s.lastContinueAt < 30000) {
      if (config.showToasts) {
        try {
          input.client.tui.showToast({
            query: { directory: input.directory || "" },
            body: {
              title: "Recovery Successful",
              message: "The AI has resumed working after recovery.",
              variant: "success",
            },
          }).catch(() => {});
        } catch (e) {
          // ignore toast errors
        }
      }
      s.lastContinueAt = 0;
      // Opportunistic compaction after recovery
      if (config.opportunisticCompactAfterRecovery && getTokenCount(s) >= config.opportunisticCompactAtTokens) {
        compaction.maybeOpportunisticCompact(sid, 'post-recovery').catch((e: unknown) => log('opportunistic compact post-recovery failed:', e));
      }
    }

    terminal.updateTerminalTitle(sid);
    terminal.updateTerminalProgress(sid);
  }

  if (status?.type === "idle") {
    s.actionStartedAt = 0;
    clearTimer(sid);

    // Send queued continue when session becomes idle/stable
    if (s.needsContinue) {
      if (s.aborting) {
        log('session idle while recovery is finalizing, scheduling delayed continue fallback for:', sid);
        setTimeout(() => {
          if (isDisposed()) return;
          const session = sessions.get(sid);
          if (session && session.needsContinue && !session.continueInProgress) {
            log('delayed continue fallback firing for:', sid);
            review.sendContinue(sid).catch((e: unknown) => log('delayed continue fallback failed:', e));
          }
        }, 3000);
      } else {
        log('session idle, sending queued continue for:', sid);
        await review.sendContinue(sid);
      }
    }

    if (!s.needsContinue) {
      // Opportunistic compaction on idle
      if (config.opportunisticCompactOnIdle && getTokenCount(s) >= config.opportunisticCompactAtTokens) {
        compaction.maybeOpportunisticCompact(sid, 'idle').catch((e: unknown) => log('opportunistic compact on idle failed:', e));
      }

      // Poll todos and schedule nudge/review — same as handleSessionIdle
      // This ensures we pick up work immediately even if session.idle event is delayed
      await todoPoller.pollAndProcess(sid);

      const stopCheck = stopConditions.checkStopConditions(sid);
      if (!stopCheck.shouldStop && config.nudgeEnabled) {
        nudge.scheduleNudge(sid);
      }
    }

    terminal.clearTerminalTitle();
    terminal.clearTerminalProgress();
  }

  writeStatusFile(sid);
}

async function handleMessagePartUpdated(ctx: HandlerContext, sid: string, e: PluginEvent): Promise<void> {
  const { config, log, getSession, sessionMonitor, clearTimer, scheduleRecovery, writeStatusFile, compaction, nudge, input } = ctx;
  log('progress event: message.part.updated', sid);
  const s = getSession(sid);
  const props = e.properties as Record<string, unknown>;
  const part = props.part as PartInfo | undefined;
  const partType = part?.type as PartType | undefined;

  // CRITICAL: Ignore synthetic messages to prevent infinite loops
  if (part?.synthetic === true) {
    log('ignoring synthetic message part');
    return;
  }

  const isRealProgress = partType === "text" || partType === "step-finish" || partType === "reasoning" || partType === "tool" || partType === "step-start" || partType === "subtask" || partType === "file";
  log('message.part.updated:', partType, isRealProgress ? '(progress)' : '(ignored)');

  if (isRealProgress) {
    // Detect tool-call-as-text
    let isToolCallAsText = false;
    if (partType === "text" || partType === "reasoning") {
      const partText = part?.text || "";
      if (containsToolCallAsText(partText)) {
        isToolCallAsText = true;
        log('tool-call-as-text detected in', partType, 'part — NOT resetting progress, session:', sid);
      }
    }

    if (!isToolCallAsText) {
      updateProgress(s);
      sessionMonitor.touchSession(sid);
      s.attempts = 0;
      s.userCancelled = false;
    }

    s.lastStallPartType = partType || "unknown";

    // Track actual output for busy-but-dead detection
    if (!isToolCallAsText) {
      s.lastOutputAt = Date.now();
    }

    // Track text content length
    if (partType === "text" || partType === "reasoning") {
      const text = part?.text || "";
      if (text.length > s.lastOutputLength) {
        s.lastOutputLength = text.length;
        log('output tracked: text length', text.length, 'session:', sid);
      }
    } else if (partType === "tool" || partType === "file" || partType === "subtask" || partType === "step-start" || partType === "step-finish") {
      s.lastOutputLength++;
      s.lastToolExecutionAt = Date.now();

      // Track tool loop
      if (partType === "tool") {
        const toolName = part?.name || part?.toolName || "";
        if (toolName === s.lastToolName && toolName) {
          s.toolRepeatCount++;
          if (s.toolRepeatCount >= config.toolLoopMaxRepeats) {
            log('tool loop detected:', toolName, 'repeated', s.toolRepeatCount, 'times, session:', sid);
          }
        } else {
          s.toolRepeatCount = 0;
          s.lastToolName = toolName;
        }

        // Dangerous command detection — fire-and-forget abort
        if (config.dangerousCommandBlocking && (toolName === "bash" || toolName === "shell" || toolName === "execute")) {
          const partInput = part?.input as Record<string, unknown> | undefined;
          const cmdText = (typeof partInput?.command === 'string' && partInput.command)
            || (Array.isArray(partInput) && typeof partInput[0] === 'string' && partInput[0])
            || (typeof partInput === 'string' && partInput)
            || "";
          if (cmdText && containsDangerousCommand(cmdText)) {
            log('DANGEROUS COMMAND BLOCKED — aborting session:', sid, 'tool:', toolName);
            input.client.session.abort({
              path: { id: sid },
              query: { directory: input.directory || "" },
            }).catch((ae: any) => log('dangerous command abort failed:', ae));
            input.client.session.prompt({
              path: { id: sid },
              query: { directory: input.directory || "" },
              body: {
                parts: [{
                  type: "text",
                  text: `The previous command was blocked by the dangerous command policy. Do not attempt to run it again.`,
                  synthetic: true,
                }],
              },
            }).catch((pe: any) => log('dangerous command prompt failed:', pe));
          }
        }
      } else {
        s.toolRepeatCount = 0;
        s.lastToolName = '';
      }

      // Reset nudge count on real progress
      if (s.nudgeCount > 0) {
        log('resetting nudge count after real progress:', partType, 'was:', s.nudgeCount);
        s.nudgeCount = 0;
      }
      // Resume nudging after recovery
      if (s.nudgePaused) {
        log('resuming nudge after post-recovery progress:', partType, 'session:', sid);
        s.nudgePaused = false;
      }
      log('output tracked:', partType, 'session:', sid);
    }

    // Estimate tokens for parts without actual token counts
    let partText = "";
    if (partType === "tool") {
      partText = JSON.stringify(part) || "";
    } else if (partType === "file") {
      partText = (part?.url || "") + " " + (part?.mime || "");
    } else if (partType === "subtask") {
      partText = (part?.prompt || "") + " " + (part?.description || "");
    } else if (partType === "step-start") {
      partText = (part as unknown as Record<string, unknown>)?.name as string || "";
    }

    if (partText) {
      const estTokens = estimateTokens(partText, config.tokenEstimateMultiplier);
      s.estimatedTokens += estTokens;
    }

    // Track recovery intent
    if (partType === "tool") {
      const toolName = part?.name || part?.toolName || "";
      if (toolName) {
        s.lastToolCall = toolName;
        s.lastToolSummary = `ran ${toolName}`;
      }
    } else if (partType === "file") {
      const fileUrl = part?.url || "";
      if (fileUrl) {
        s.lastFileEdited = fileUrl;
        s.lastToolSummary = `edited ${fileUrl.split("/").pop()}`;
      }
    } else if (partType === "subtask") {
      const subtaskName = part?.name || part?.description || part?.prompt || "";
      if (subtaskName) {
        s.lastToolSummary = `working on subtask: ${subtaskName.slice(0, 80)}`;
      }
    } else if (partType === "step-start") {
      const stepName = part?.name || "";
      if (stepName) {
        s.lastToolSummary = `step: ${stepName.slice(0, 80)}`;
      }
    }

    // Extract actual tokens from step-finish parts
    if (partType === "step-finish" && part?.tokens) {
      const stepTokens = part.tokens;
      const totalStepTokens = (stepTokens.input || 0) + (stepTokens.output || 0) + (stepTokens.reasoning || 0);
      if (totalStepTokens > 0) {
        if (s.realTokensBaseline > 0 && totalStepTokens > s.estimatedTokens) {
          log('step-finish tokens ignored (post-compaction, tokens likely pre-compaction):', totalStepTokens, 'estimated:', s.estimatedTokens, 'session:', sid);
        } else {
          s.estimatedTokens = Math.max(s.estimatedTokens, totalStepTokens);
          log('step-finish tokens:', totalStepTokens, 'input:', stepTokens.input, 'output:', stepTokens.output, 'reasoning:', stepTokens.reasoning, 'session:', sid);
        }
      }
    }
  }

  await ctx.refreshRealTokens(sid);
  log('[Compaction] token check:', sid, 'effective=', getTokenCount(s), 'real=', s.realTokens, 'baseline=', s.realTokensBaseline, 'estimated=', s.estimatedTokens, 'proactiveThreshold=', config.proactiveCompactAtTokens, 'hardThreshold=', config.hardCompactAtTokens);
  compaction.maybeProactiveCompact(sid).then((proactiveOk) => {
    if (!proactiveOk) compaction.maybeHardCompact(sid).catch((e: unknown) => log('hard compact escalation failed:', e));
  }).catch((e: unknown) => log('proactive compact check failed:', e));

  // Handle compaction parts
  if (partType === "compaction") {
    log('compaction started, pausing stall monitoring');
    clearTimer(sid);
    s.compacting = true;
    if (config.compactionSafetyTimeoutMs > 0 && !s.compactionSafetyTimer) {
      s.compactionSafetyTimer = setTimeout(() => {
        if (s.compacting) {
          log('[Compaction] SAFETY TIMEOUT — compacting flag stuck for', sid, ', force-clearing after', config.compactionSafetyTimeoutMs, 'ms');
          s.compactionTimedOut = true;
          s.compacting = false;
          s.hardCompactionInProgress = false;
          if (s.hasOpenTodos && config.nudgeEnabled && !s.planning) {
            s.nudgeRetryCount = 0;
            log('[Compaction] re-scheduling nudge after safety timeout, session:', sid);
            nudge.scheduleNudge(sid);
          }
        }
      }, config.compactionSafetyTimeoutMs);
      if (s.compactionSafetyTimer.unref) s.compactionSafetyTimer.unref();
    }
  }

  // Handle text parts for plan detection
  if (partType === "text") {
    const partText = part?.text as string | undefined;
    if (partText) {
      if (isPlanContent(partText)) {
        log('plan detected in updated text part, pausing stall monitoring');
        s.planning = true;
        s.planningStartedAt = Date.now();
        clearTimer(sid);
        scheduleRecovery(sid, config.planningTimeoutMs);
      }
    }
  }

  // Clear plan flag on non-plan progress
  if (s.planning && (partType === "tool" || partType === "file" || partType === "subtask" || partType === "step-start" || partType === "step-finish")) {
    log('non-plan progress detected, clearing plan flag');
    s.planning = false;
    s.planBuffer = '';
    scheduleRecovery(sid, config.stallTimeoutMs);
  }

  // Check for plan content in delta
  const deltaText = props.delta as string | undefined;
  if (deltaText) {
    s.planBuffer = (s.planBuffer + deltaText).slice(-200);
    if (isPlanContent(s.planBuffer)) {
      log('plan detected in delta, pausing stall monitoring — user must address');
      s.planning = true;
      s.planningStartedAt = Date.now();
      s.planBuffer = '';
      clearTimer(sid);
      scheduleRecovery(sid, config.planningTimeoutMs);
    }
  }

  // Schedule normal recovery if not planning/compacting
  if (!s.planning && !s.compacting) {
    clearTimer(sid);
    scheduleRecovery(sid, config.stallTimeoutMs);
  } else if (s.planning && !s.timer) {
    scheduleRecovery(sid, config.planningTimeoutMs);
  }

  writeStatusFile(sid);
}

async function handleMessageActivity(ctx: HandlerContext, sid: string, e: PluginEvent, eventType: string): Promise<void> {
  const { config, sessions, log, getSession, clearTimer, scheduleRecovery, writeStatusFile, compaction } = ctx;
  const props = e.properties as Record<string, unknown>;
  const info = props.info as MessageInfo | undefined;
  const msgRole = info?.role;
  const isSynthetic = isSyntheticMessageEvent(e);
  const isUserMessage = msgRole === "user" && !isSynthetic;

  if (isSynthetic) {
    log('ignoring synthetic message activity event:', eventType, sid);
    writeStatusFile(sid);
    return;
  }

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
      log('ignoring synthetic message event during recovery:', eventType);
      return;
    }
  }

  log('activity event:', eventType, sid, 'role:', msgRole);
  const s = getSession(sid);

  // Track message count and estimate tokens
  if (isUserMessage) {
    s.messageCount++;
    const msgText = (info?.content || info?.text || '') as string;
    const estTokens = estimateTokens(msgText, config.tokenEstimateMultiplier);
    s.estimatedTokens += estTokens;
    log('message count incremented:', s.messageCount, 'estimated tokens added:', estTokens, 'total:', s.estimatedTokens);
  } else {
    const msgText = (info?.content || info?.text || '') as string;
    if (msgText && msgRole !== 'assistant') {
      const estTokens = estimateTokens(msgText, config.tokenEstimateMultiplier);
      s.estimatedTokens += estTokens;
    }
    s.lastOutputAt = Date.now();
    if (msgText && msgText.length > s.lastOutputLength) {
      s.lastOutputLength = msgText.length;
    }
  }

  updateProgress(s);
  s.attempts = 0;
  s.userCancelled = false;

  if (s.planning && isUserMessage) {
    log('user sent message, clearing plan flag');
    s.planning = false;
    s.planBuffer = '';
  }

  if (s.compacting) {
    log('activity after compaction (not clearing flag — session.compacted event will clear it)');
  }

  clearTimer(sid);
  if (!s.planning && !s.compacting) {
    scheduleRecovery(sid, config.stallTimeoutMs);
  }

  writeStatusFile(sid);
  await ctx.refreshRealTokens(sid);
  compaction.maybeProactiveCompact(sid).then((proactiveOk) => {
    if (!proactiveOk) compaction.maybeHardCompact(sid).catch((e: unknown) => log('hard compact escalation failed:', e));
  }).catch((e: unknown) => log('proactive compact check failed:', e));
}

function handleTodoUpdated(ctx: HandlerContext, sid: string, e: PluginEvent): void {
  const props = e.properties as Record<string, unknown>;
  const todos = props.todos as TodoItem[] | undefined;
  if (!Array.isArray(todos)) return;
  ctx.todoPoller.markEventTodoReceived(sid);
  ctx.todoPoller.processTodos(sid, todos);
}

async function handleQuestionAsked(ctx: HandlerContext, sid: string, e: PluginEvent): Promise<void> {
  const { config, log, getSession, writeStatusFile, input, nudge } = ctx;
  if (!config.autoAnswerQuestions) return;

  const props = e.properties as Record<string, unknown>;
  const requestID = props.id as string | undefined;
  const questions = (props.questions || []) as Array<{ header?: string; question?: string; options?: Array<{ label?: string }> }>;
  log('question.asked:', requestID, 'session:', sid, 'questions:', questions.length);

  if (requestID && questions.length > 0) {
    const SAFE_PATTERNS = /^(yes|ok|okay|confirm|continue|proceed|accept|agree|got it|sure|y)$/i;
    const answers: string[][] = [];
    let allSafe = true;

    for (const q of questions) {
      const opts = q.options || [];
      if (opts.length === 0) { allSafe = false; break; }
      if (opts.length === 1) {
        answers.push([opts[0].label || ""]);
      } else if (config.autoAnswerSafeOnly) {
        const safeOpt = opts.find((o) => SAFE_PATTERNS.test(o.label?.trim() || ""));
        if (safeOpt) {
          answers.push([safeOpt.label || ""]);
        } else {
          allSafe = false;
          break;
        }
      } else {
        answers.push([opts[0]?.label || ""]);
      }
    }

    if (!allSafe) {
      log('skipping auto-answer: multi-option question without safe default');
      writeStatusFile(sid);
      return;
    }

    for (let i = 0; i < questions.length; i++) {
      log('auto-answering question:', questions[i].header || questions[i].question, '→', answers[i][0]);
    }

    try {
      const httpClient = (input.client as any)._client;
      if (httpClient) {
        await httpClient.post({
          url: `/question/${requestID}/reply`,
          headers: { "Content-Type": "application/json" },
          body: { answers },
        });
        log('auto-replied to question:', requestID);
      } else {
        log('no HTTP client available for question reply');
      }

      const s = getSession(sid);
      s.lastOutputAt = Date.now();
      s.lastProgressAt = Date.now();
      nudge.cancelNudge(sid);
    } catch (err) {
      log('question auto-reply FAILED:', err);
    }
  }

  writeStatusFile(sid);
}

async function handleSessionIdle(ctx: HandlerContext, sid: string): Promise<void> {
  const { config, sessions, log, getSession, clearTimer, writeStatusFile, scheduleRecovery, review, compaction, nudge, stopConditions, todoPoller, isDisposed } = ctx;
  if (isDisposed()) return;
  const s = getSession(sid);
  clearTimer(sid);

  if (s.needsContinue) {
    if (s.aborting) {
      log('session.idle while recovery is finalizing, scheduling delayed continue fallback for:', sid);
      setTimeout(() => {
        if (isDisposed()) return;
        const session = sessions.get(sid);
        if (session && session.needsContinue && !session.continueInProgress) {
          log('delayed continue fallback firing for:', sid);
          review.sendContinue(sid).catch((e: unknown) => log('delayed continue fallback failed:', e));
        }
      }, 3000);
    } else {
      log('session.idle, sending queued continue for:', sid);
      await review.sendContinue(sid);
    }
    writeStatusFile(sid);
    await ctx.refreshRealTokens(sid);
    compaction.maybeProactiveCompact(sid).then((proactiveOk) => {
      if (!proactiveOk) compaction.maybeHardCompact(sid).catch((e: unknown) => log('hard compact escalation failed:', e));
    }).catch((e: unknown) => log('proactive compact check failed:', e));

    // Also poll todos and schedule nudge so we're ready immediately
    // when the AI finishes the continue prompt
    await todoPoller.pollAndProcess(sid);
    if (s.hasOpenTodos && config.nudgeEnabled) {
      nudge.scheduleNudge(sid);
    }
    return;
  }

  // Poll todos before deciding nudge
  await todoPoller.pollAndProcess(sid);

  const stopCheck = stopConditions.checkStopConditions(sid);
  if (!stopCheck.shouldStop) {
    await ctx.refreshRealTokens(sid);
    compaction.maybeProactiveCompact(sid).catch((e: unknown) => log('proactive compact failed during idle:', e));
    if (config.opportunisticCompactBeforeNudge && getTokenCount(s) >= config.nudgeCompactThreshold) {
      compaction.maybeOpportunisticCompact(sid, 'pre-nudge').catch((e: unknown) => log('opportunistic compact pre-nudge failed:', e));
    }
    nudge.scheduleNudge(sid);
  }

  writeStatusFile(sid);
}

function handleSessionCompacted(ctx: HandlerContext, sid: string): void {
  const { config, log, getSession, clearTimer, scheduleRecovery, writeStatusFile, review, nudge, isDisposed } = ctx;
  const s = getSession(sid);
  log('session compacted, clearing compacting flag:', sid);
  s.compacting = false;
  s.compactionTimedOut = false;
  s.lastCompactionFailedAt = 0;
  s.lastCompactionTimeoutAt = 0;
  s.hardCompactionInProgress = false;
  if (s.compactionSafetyTimer) { clearTimeout(s.compactionSafetyTimer); s.compactionSafetyTimer = null; }
  const hadPendingReview = s.reviewRetryTimer !== null;
  if (s.reviewRetryTimer) { clearTimeout(s.reviewRetryTimer); s.reviewRetryTimer = null; }
  s.lastCompactionAt = Date.now();
  s.estimatedTokens = Math.floor(s.estimatedTokens * config.compactReductionFactor);
  s.realTokensBaseline = s.realTokens;
  s.attempts = 0;
  s.backoffAttempts = 0;
  clearTimer(sid);

  if (!s.planning && !s.compacting) {
    scheduleRecovery(sid, config.stallTimeoutMs);
  }

  if (!s.userCancelled && !isDisposed()) {
    s.needsContinue = true;
    s.continueMessageText = s.planning ? config.continueWithPlanMessage : config.shortContinueMessage;
    review.sendContinue(sid).catch((e) => log('continue after compaction failed:', e));
  }

  // Re-trigger deferred review if one was pending before compaction completed
  if (hadPendingReview && !s.reviewFired && !s.userCancelled && !isDisposed()) {
    log('re-triggering deferred review after compaction, session:', sid);
    review.triggerReview(sid).catch((e) => log('deferred review after compaction failed:', e));
  }

  // Re-schedule nudge after compaction
  if (s.hasOpenTodos && config.nudgeEnabled && !s.planning) {
    s.nudgeRetryCount = 0;
    log('re-scheduling nudge after compaction, session:', sid);
    nudge.scheduleNudge(sid);
  }

  writeStatusFile(sid);
}

function handleSessionEnded(ctx: HandlerContext, sid: string, type: string): void {
  const { log, nudge, resetSession, writeStatusFile } = ctx;
  log('stale event:', type, sid);
  nudge.cancelNudge(sid);
  resetSession(sid);
  writeStatusFile(sid);
}

/**
 * Handle the experimental.chat.system.transform hook.
 * Injects dangerous command policy into the system prompt.
 */
export function handleSystemTransform(ctx: HandlerContext, _input: Record<string, unknown>, output: { system: string[] }): void {
  const { config, sessions, log } = ctx;
  const sid = _input?.sessionID as string | undefined;
  if (config.dangerousCommandBlocking && config.dangerousCommandInjection) {
    output.system = output.system || [];
    const policy = `## ⚠️ Dangerous Commands Policy\n\nThe following commands are blocked by policy and must never be used:\n\n${formatDangerousBlocklist()}\n\nIf you need one of these for a legitimate reason, explain why and it can be approved manually.`;
    output.system.push(policy);
    if (sid) {
      const s = sessions.get(sid);
      if (s) s.systemTransformHookCalled = true;
    }
    log('dangerous commands policy injected via system transform hook, session:', sid);
  }
}

/**
 * Handle the experimental.session.compacting hook.
 * Injects session state context into compaction to preserve important context.
 */
export function handleSessionCompacting(ctx: HandlerContext, _input: Record<string, unknown>, output: { context: string[]; prompt?: string }): void {
  const { sessions, log } = ctx;
  const sid = _input?.sessionID as string | undefined;
  if (!sid) {
    log('experimental.session.compacting hook called without sessionID, skipping');
    return;
  }
  const s = sessions.get(sid);

  if (s) {
    const contextLines: string[] = [];

    // Preserve active todos
    if (s.lastKnownTodos && s.lastKnownTodos.length > 0) {
      const pending = s.lastKnownTodos.filter(t => t.status === 'in_progress' || t.status === 'pending');
      if (pending.length > 0) {
        contextLines.push(`## Active Tasks`);
        for (const t of pending.slice(0, 5)) {
          contextLines.push(`- ${t.content || t.title || 'Task'} (${t.status})`);
        }
      }
    }

    // Preserve planning state
    if (s.planning) {
      contextLines.push(`## Currently Creating Plan`);
      contextLines.push(`The agent was in the middle of creating a plan when compaction occurred.`);
    }

    // Add recovery context
    if (s.attempts > 0) {
      contextLines.push(`## Recovery Context`);
      contextLines.push(`Recovery attempts: ${s.attempts}`);
      if (s.recoveryTimes.length > 0) {
        contextLines.push(`Recent recovery durations: ${s.recoveryTimes.slice(-3).map(t => Math.round(t/1000)+'s').join(', ')}`);
      }
    }

    // Add token context
    if (getTokenCount(s) > 0) {
      contextLines.push(`## Token Context`);
      contextLines.push(s.realTokens > 0 ? `Tokens: ${s.realTokens.toLocaleString()} (actual)` : `Estimated tokens: ~${s.estimatedTokens}`);
      if (s.tokenLimitHits > 0) {
        contextLines.push(`Token limit hits: ${s.tokenLimitHits}`);
      }
    }

    // Add stall pattern context
    if (s.stallDetections > 0) {
      contextLines.push(`## Stall Context`);
      contextLines.push(`Stall detections: ${s.stallDetections}`);
      const patterns = Object.entries(s.stallPatterns);
      if (patterns.length > 0) {
        contextLines.push(`Stall patterns: ${patterns.slice(0, 5).map(([k,v]) => `${k}: ${v}`).join(', ')}`);
      }
    }

    // Add nudge context
    if (s.nudgeCount > 0) {
      contextLines.push(`## Nudge Context`);
      contextLines.push(`Nudges sent: ${s.nudgeCount}`);
    }

    if (contextLines.length > 0) {
      output.context = output.context || [];
      output.context.push(contextLines.join("\n"));
      log('injected session context into compaction:', sid, 'lines:', contextLines.length);
    }
  }
}

/**
 * Handle the experimental.compaction.autocontinue hook.
 * Disables OpenCode's generic synthetic continue — we handle our own.
 */
export function handleCompactionAutocontinue(ctx: HandlerContext, _input: Record<string, unknown>, output: { enabled: boolean }): void {
  const { sessions, log } = ctx;
  output.enabled = false;

  const sid = _input?.sessionID as string | undefined;
  if (!sid) {
    log('experimental.compaction.autocontinue hook called without sessionID, skipping');
    return;
  }
  const s = sessions.get(sid);
  if (s && s.needsContinue) {
    log('autocontinue disabled for session:', sid, '- using custom continue');
  }
}
