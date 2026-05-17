/**
 * Message event handlers.
 * Handles: message.updated, message.part.updated, message.created, message.part.added
 */

import type { SessionState } from "./session-state.js";
import { getTokenCount } from "./session-state.js";
import {
  isPlanContent,
  containsToolCallAsText,
  estimateTokens,
  updateProgress,
} from "./shared.js";
import { containsDangerousCommand } from "./dangerous-commands.js";
import type {
  MessageInfo,
  PluginEvent,
  PartInfo,
  PartType,
} from "./types.js";
import { isSyntheticEvent } from "./types.js";
import type { HandlerContext } from "./handler-context.js";

function isSyntheticMessageEvent(e: PluginEvent): boolean {
  return isSyntheticEvent(e);
}

// ─── message.updated ──────────────────────────────────────────────────────────

export async function handleMessageUpdated(
  ctx: HandlerContext,
  sid: string,
  e: PluginEvent,
): Promise<void> {
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
      s.sentMessageAt = Date.now();
      s.autoSubmitCount = 0;
      s.attempts = 0;
      s.backoffAttempts = 0;
      s.lastNudgeAt = 0;
      s.lastContinueAt = 0;
      s.lastOutputAt = Date.now();
      s.lastToolExecutionAt = Date.now();
      nudge.resetNudge(sid);
      log('user message detected, resetting counters:', sid);

      // User message clears any queued continue
      if (s.needsContinue) {
        log('user message received, cancelling queued continue');
        s.needsContinue = false;
        s.continueMessageText = '';
      }

      // Reset planning on user message
      if (s.planning) {
        log('user sent message, clearing plan flag');
        s.planning = false;
        s.planBuffer = '';
      }
    }
  }

  // Track assistant message token counts
  if (info?.role === "assistant" && !isSynthetic && info?.tokens) {
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

// ─── message.part.updated ───────────────────────────────────────────────────────

export async function handleMessagePartUpdated(
  ctx: HandlerContext,
  sid: string,
  e: PluginEvent,
): Promise<void> {
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

// ─── message.created / message.part.added ──────────────────────────────────────

export async function handleMessageActivity(
  ctx: HandlerContext,
  sid: string,
  e: PluginEvent,
  eventType: string,
): Promise<void> {
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
    log('user message estimated tokens:', estTokens, 'session:', sid);
  }

  // Update progress on any message activity
  updateProgress(s);

  // Reset counters on user message
  if (isUserMessage) {
    s.attempts = 0;
    s.userCancelled = false;

    if (s.planning && isUserMessage) {
      log('user sent message, clearing plan flag');
      s.planning = false;
      s.planBuffer = '';
    }
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