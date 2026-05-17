/**
 * Session event handlers.
 * Handles: session.created, session.updated, session.diff, session.error,
 * session.status, session.idle, session.compacted, session.ended, session.deleted
 */

import type { PluginConfig } from "./config.js";
import type { SessionState } from "./session-state.js";
import { getTokenCount } from "./session-state.js";
import {
  isPlanContent,
  parseTokensFromError,
  estimateTokens,
} from "./shared.js";
import { safeUnref } from "./typed-helpers.js";
import type {
  PluginEvent,
  SessionStatusType,
} from "./types.js";
import { formatDangerousBlocklist } from "./dangerous-commands.js";
import type { HandlerContext } from "./handler-context.js";

const DANGEROUS_CMD_FALLBACK_MS = 30000;

// ─── session.created ───────────────────────────────────────────────────────────

export async function handleSessionCreated(ctx: HandlerContext, sid: string): Promise<void> {
  const { config, sessions, log, getSession, sessionMonitor, writeStatusFile, input, isDisposed } = ctx;
  log('session.created:', sid);
  const s = getSession(sid);
  await ctx.refreshRealTokens(sid);
  sessionMonitor.touchSession(sid);

  // Schedule delayed fallback for dangerous command policy injection.
  if (config.dangerousCommandBlocking && config.dangerousCommandInjection) {
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
    safeUnref(s.dangerousCommandPromptTimer);
  }

  writeStatusFile(sid);
}

// ─── session.updated ───────────────────────────────────────────────────────────

export function handleSessionUpdated(ctx: HandlerContext, sid: string): void {
  ctx.log('session.updated:', sid);
  ctx.writeStatusFile(sid);
}

// ─── session.error ─────────────────────────────────────────────────────────────

export async function handleSessionError(ctx: HandlerContext, sid: string, e: PluginEvent): Promise<void> {
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

// ─── session.status ───────────────────────────────────────────────────────────

export async function handleSessionStatus(ctx: HandlerContext, sid: string, e: PluginEvent): Promise<void> {
  const {
    config, sessions, log, getSession, clearTimer, writeStatusFile,
    scheduleRecovery, recover, sessionMonitor, stopConditions, review,
    compaction, terminal, input, isDisposed, todoPoller, nudge,
  } = ctx;

  const props = e.properties as Record<string, unknown>;
  const status = props.status as SessionStatusType | undefined;
  log('session.status:', sid, status?.type);
  const s = getSession(sid);

  if (status?.type === "busy" || status?.type === "retry") {
    sessionMonitor.touchSession(sid);
    s.userCancelled = false;
    s.idleProcessingDone = false;
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

      // Poll todos and schedule nudge/review — fallback if session.idle hasn't handled it
      if (!s.idleProcessingDone) {
        s.idleProcessingDone = true;
        await todoPoller.pollAndProcess(sid);


        const stopCheck = stopConditions.checkStopConditions(sid);
        if (!stopCheck.shouldStop && config.nudgeEnabled) {
          nudge.scheduleNudge(sid);
        }
      } else {
        log('session.status(idle) skipping duplicate idle processing — handled by session.idle:', sid);
      }
    }

    terminal.clearTerminalTitle();
    terminal.clearTerminalProgress();
  }

  writeStatusFile(sid);
}

// ─── session.idle (event) ──────────────────────────────────────────────────────

export async function handleSessionIdle(ctx: HandlerContext, sid: string): Promise<void> {
  const {
    config, sessions, log, getSession, clearTimer, writeStatusFile,
    scheduleRecovery, review, compaction, nudge, stopConditions,
    todoPoller, isDisposed,
  } = ctx;
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

    s.idleProcessingDone = true;

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

  s.idleProcessingDone = true;
  writeStatusFile(sid);
}

// ─── session.compacted ─────────────────────────────────────────────────────────

export function handleSessionCompacted(ctx: HandlerContext, sid: string): void {
  const { config, log, getSession, clearTimer, scheduleRecovery, writeStatusFile, review, nudge, isDisposed } = ctx;
  const s = getSession(sid);
  log('session compacted, clearing compacting flag:', sid);
  s.compacting = false;
  s.compactionTimedOut = false;
  s.lastCompactionFailedAt = 0;
  s.lastCompactionTimeoutAt = 0;
  s.lastCompactionCheckAt = 0;
  s.hardCompactionInProgress = false;
  s.idleProcessingDone = false;
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

// ─── session.ended / session.deleted ───────────────────────────────────────────

export function handleSessionEnded(ctx: HandlerContext, sid: string, type: string): void {
  const { log, nudge, resetSession, writeStatusFile } = ctx;
  log('stale event:', type, sid);
  nudge.cancelNudge(sid);
  resetSession(sid);
  writeStatusFile(sid);
}