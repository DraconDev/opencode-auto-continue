import type { PluginConfig, SessionState } from "./shared.js";
import { updateProgress, estimateTokens, isPlanContent } from "./shared.js";
import type { NudgeModule } from "./nudge.js";
import type { TerminalModule } from "./terminal.js";
import type { NotificationModule } from "./notifications.js";
import type { CompactionModule } from "./compaction.js";
import type { ReviewModule } from "./review.js";

export interface EventHandlerDeps {
  config: PluginConfig;
  sessions: Map<string, SessionState>;
  log: (...args: unknown[]) => void;
  getSession: (id: string) => SessionState;
  clearTimer: (id: string) => void;
  resetSession: (id: string) => void;
  isDisposed: () => boolean;
  nudge: NudgeModule;
  terminal: TerminalModule;
  notifications: NotificationModule;
  compaction: CompactionModule;
  review: ReviewModule;
  recover: (sessionId: string) => Promise<void>;
  writeStatusFile: (sessionId: string) => void;
}

export function createEventHandler(deps: EventHandlerDeps) {
  const {
    config,
    sessions,
    log,
    getSession,
    clearTimer,
    resetSession,
    isDisposed,
    nudge,
    terminal,
    notifications,
    compaction,
    review,
    recover,
    writeStatusFile,
  } = deps;

  const progressTypes = ["message.part.updated"];
  const staleTypes = ["session.error", "session.ended", "session.deleted"];

  async function handleEvent(event: any): Promise<void> {
    if (isDisposed()) return;

    const e = event as any;
    const sid =
      e?.properties?.sessionID ||
      e?.properties?.info?.sessionID ||
      e?.properties?.part?.sessionID ||
      "default";

    try {
      if (event?.type === "session.error") {
        const err = e?.properties?.error;
        log("session.error:", err?.name);
        if (err?.name === "MessageAbortedError") {
          const s = sessions.get(sid);
          if (s) {
            s.userCancelled = true;
            nudge.pauseNudge(sid);
          }
          log("user cancelled session:", sid);
        }
        clearTimer(sid);
        writeStatusFile(sid);
        return;
      }

      if (event?.type === "session.created") {
        log("session.created:", sid);
        getSession(sid);
        writeStatusFile(sid);
        return;
      }

      if (event?.type === "session.updated") {
        log("session.updated:", sid);
        writeStatusFile(sid);
        return;
      }

      if (event?.type === "session.diff") {
        log("session.diff:", sid);
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
            log("user message detected, resetting counters:", sid);
          }
        }
        writeStatusFile(sid);
        return;
      }

      if (event?.type === "session.status") {
        const status = e?.properties?.status;
        log("session.status:", sid, status?.type);
        const s = getSession(sid);

        if (status && typeof status === "object") {
          const rawStatus = status as any;
          if (typeof rawStatus.tokensInput === "number") {
            s.estimatedTokens = Math.max(s.estimatedTokens, rawStatus.tokensInput);
          }
          if (typeof rawStatus.tokensOutput === "number") {
            s.estimatedTokens = Math.max(
              s.estimatedTokens,
              rawStatus.tokensInput + rawStatus.tokensOutput
            );
          }
          if (typeof rawStatus.totalTokens === "number") {
            s.estimatedTokens = Math.max(s.estimatedTokens, rawStatus.totalTokens);
          }
        }

        if (status?.type === "busy" || status?.type === "retry") {
          updateProgress(s);
          s.userCancelled = false;
          if (s.planning) {
            log("session busy, clearing plan flag");
            s.planning = false;
          }
          if (s.compacting) {
            log("session busy, clearing compacting flag (compaction likely finished)");
            s.compacting = false;
          }
          if (s.actionStartedAt === 0) {
            notifications.startTimerToast(sid);
          }
          terminal.updateTerminalTitle(sid);
          terminal.updateTerminalProgress(sid);
          await compaction.maybeProactiveCompact(sid);
        }

        if (status?.type === "idle" && s.needsContinue) {
          log("session idle, sending queued continue for:", sid);
          await review.sendContinue(sid);
        }

        if (status?.type === "idle" && !s.needsContinue) {
          await compaction.maybeProactiveCompact(sid);
        }

        if (status?.type === "idle" && !s.needsContinue && s.hasOpenTodos && config.nudgeEnabled) {
          nudge.scheduleNudge(sid);
        }

        if (status?.type === "idle") {
          notifications.stopTimerToast(sid);
          terminal.clearTerminalTitle();
          terminal.clearTerminalProgress();
        }

        clearTimer(sid);
        if (!s.planning && !s.compacting) {
          s.timer = setTimeout(() => recover(sid), config.stallTimeoutMs);
        }

        if (!s.planning && !s.compacting && s.estimatedTokens > 0) {
          await compaction.maybeProactiveCompact(sid);
        }

        writeStatusFile(sid);
        return;
      }

      if (progressTypes.includes(event?.type)) {
        log("progress event:", event?.type, sid);
        const s = getSession(sid);

        if (event?.type === "message.part.updated") {
          const part = e?.properties?.part;
          const partType = part?.type;

          if (part?.synthetic === true) {
            log("ignoring synthetic message part");
            return;
          }

          const isRealProgress =
            partType === "text" ||
            partType === "step-finish" ||
            partType === "reasoning" ||
            partType === "tool" ||
            partType === "step-start" ||
            partType === "subtask" ||
            partType === "file";

          log("message.part.updated:", partType, isRealProgress ? "(progress)" : "(ignored)");

          if (isRealProgress) {
            updateProgress(s);
            s.attempts = 0;
            s.userCancelled = false;
            s.lastStallPartType = partType || "unknown";

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
              s.estimatedTokens += estimateTokens(partText);
            }
          }

          if (partType === "compaction") {
            log("compaction started, pausing stall monitoring");
            s.compacting = true;
          }

          if (partType === "text") {
            const partText = e?.properties?.part?.text as string | undefined;
            if (partText && isPlanContent(partText)) {
              log("plan detected in updated text part, pausing stall monitoring");
              s.planning = true;
            }
          }
        }

        const deltaText = e?.properties?.delta as string | undefined;
        if (deltaText) {
          s.planBuffer = (s.planBuffer + deltaText).slice(-200);
          if (isPlanContent(s.planBuffer)) {
            log("plan detected in delta, pausing stall monitoring — user must address");
            s.planning = true;
            s.planBuffer = "";
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
            log("user message during recovery, cancelling queued continue");
            s.needsContinue = false;
            s.continueMessageText = "";
          }
        } else {
          const s = sessions.get(sid);
          if (s && s.needsContinue) {
            log("ignoring synthetic message event during recovery:", event?.type);
            return;
          }
        }

        log("activity event:", event?.type, sid, "role:", msgRole);
        const s = getSession(sid);

        if (isUserMessage) {
          s.messageCount++;
          const msgText = e?.properties?.info?.content || e?.properties?.info?.text || "";
          const estimated = estimateTokens(msgText);
          s.estimatedTokens += estimated;
          log("message count incremented:", s.messageCount, "estimated tokens added:", estimated, "total:", s.estimatedTokens);
        } else {
          const msgText = e?.properties?.info?.content || e?.properties?.info?.text || "";
          if (msgText) {
            s.estimatedTokens += estimateTokens(msgText);
          }
        }

        updateProgress(s);
        s.attempts = 0;
        s.userCancelled = false;
        if (s.planning) {
          log("user sent message, clearing plan flag");
          s.planning = false;
        }
        if (s.compacting) {
          log("user sent message, clearing compacting flag");
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
        const allCompleted = todos.length > 0 && todos.every((t: any) => t.status === "completed" || t.status === "cancelled");
        const hasPending = todos.some((t: any) => t.status === "in_progress" || t.status === "pending");

        s.hasOpenTodos = hasPending;

        if (allCompleted && !s.reviewFired && config.reviewOnComplete) {
          if (s.reviewDebounceTimer) clearTimeout(s.reviewDebounceTimer);
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
        nudge.scheduleNudge(sid);
        writeStatusFile(sid);
        return;
      }

      if (event?.type === "session.compacted") {
        const s = getSession(sid);
        log("session compacted, clearing compacting flag:", sid);
        s.compacting = false;
        s.lastCompactionAt = Date.now();
        s.estimatedTokens = Math.floor(s.estimatedTokens * 0.3);
        s.attempts = 0;
        s.backoffAttempts = 0;
        clearTimer(sid);
        if (!s.planning && !s.compacting) {
          s.timer = setTimeout(() => recover(sid), 0);
        }
        writeStatusFile(sid);
        return;
      }

      if (staleTypes.includes(event?.type)) {
        log("stale event:", event?.type, sid);
        nudge.cancelNudge(sid);
        resetSession(sid);
        writeStatusFile(sid);
        return;
      }
    } catch (err) {
      log("event handler error:", err);
    }
  }

  function dispose(): void {
    log("disposing plugin");
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

  return { handleEvent, dispose };
}
