/**
 * Event Handlers Module
 * 
 * Extracted from index.ts to improve readability and maintainability.
 * All event handlers are now isolated in dedicated methods.
 */

import type { TypedPluginInput } from "./types.js";
import type { PluginConfig } from "./config.js";
import type { SessionState } from "./session-state.js";
import type { TerminalModule } from "./terminal.js";
import type { NudgeModule } from "./nudge.js";
import type { ReviewModule } from "./review.js";
import type { CompactionModule } from "./compaction.js";
import type { AIAdvisorModule } from "./ai-advisor.js";
import type { SessionMonitorModule } from "./session-monitor.js";
import type { RecoveryModule } from "./recovery.js";
import {
  isPlanContent,
  estimateTokens,
  parseTokensFromError,
  scheduleRecoveryWithGeneration,
  isSyntheticMessageEvent,
  getMessageText,
} from "./shared.js";

export class EventHandlers {
  constructor(
    private input: TypedPluginInput,
    private config: PluginConfig,
    private sessions: Map<string, SessionState>,
    private getSession: (sid: string) => SessionState,
    private clearTimer: (sid: string) => void,
    private scheduleRecovery: (sid: string, timeoutMs: number) => void,
    private writeStatusFile: (sid: string) => void,
    private updateProgress: (s: SessionState) => void,
    private terminal: TerminalModule,
    private nudge: NudgeModule,
    private review: ReviewModule,
    private compaction: CompactionModule,
    private aiAdvisor: AIAdvisorModule,
    private sessionMonitor: SessionMonitorModule,
    private recover: RecoveryModule["recover"],
    private resetSession: (sid: string) => void,
    private log: (...args: unknown[]) => void,
  ) {}

  get sid(): string {
    return (this.input as any)?.sessionID || "default";
  }

  handleSessionError(err: Error & { code?: string }, sid: string): void {
    const isMessageAbortedError = err?.code === "MessageAbortedError" || err?.message?.includes("MessageAbortedError");
    const isUserCancelled = isMessageAbortedError;

    if (isUserCancelled) {
      this.clearTimer(sid);
      this.writeStatusFile(sid);
      const s = this.sessions.get(sid);
      if (s) {
        s.userCancelled = true;
        s.lastKnownStatus = "error";
        this.nudge.pauseNudge(sid);
      }
      this.log("user cancelled session:", sid);
      return;
    }

    const isTokenLimit = this.compaction.isTokenLimitError(err);
    if (isTokenLimit) {
      const s = this.sessions.get(sid);
      if (s) {
        s.tokenLimitHits++;
        const parsedTokens = parseTokensFromError(err);
        if (parsedTokens) {
          s.estimatedTokens = Math.max(s.estimatedTokens, parsedTokens.total);
          this.log("parsed tokens from error:", parsedTokens.total, "input:", parsedTokens.input, "output:", parsedTokens.output, "session:", sid);
        }
        this.log("token limit error detected (hit #" + s.tokenLimitHits + ") for session:", sid);
        if (this.config.showToasts) {
          this.input.client.tui.showToast({
            query: { directory: this.input.directory || "" },
            body: {
              title: "Token Limit Reached",
              message: `Compacting context to free up tokens (hit #${s.tokenLimitHits})...`,
              variant: "warning",
            },
          }).catch(() => {});
        }
        this.compaction.forceCompact(sid).then(async (compacted) => {
          if (!this.sessions.has(sid)) {
            this.log("session deleted during emergency compaction, skipping continue:", sid);
            return;
          }
          const currentSession = this.sessions.get(sid)!;
          if (compacted) {
            this.log("emergency compaction succeeded for session:", sid);
            currentSession.needsContinue = true;
            currentSession.continueMessageText = currentSession.planning ? this.config.continueWithPlanMessage : this.config.shortContinueMessage;
            await this.review.sendContinue(sid);
          } else {
            this.log("emergency compaction failed for session:", sid);
            if (this.config.showToasts) {
              this.input.client.tui.showToast({
                query: { directory: this.input.directory || "" },
                body: {
                  title: "Compaction Failed",
                  message: "Could not free up tokens. Session may be stuck.",
                  variant: "error",
                },
              }).catch(() => {});
            }
          }
        }).catch((e) => {
          this.log("emergency compaction error:", e);
        });
      }
      this.clearTimer(sid);
      this.writeStatusFile(sid);
      return;
    }

    this.clearTimer(sid);
    this.writeStatusFile(sid);
  }

  handleSessionCreated(sid: string): void {
    this.log("session.created:", sid);
    this.getSession(sid);
    this.sessionMonitor.touchSession(sid);
    this.writeStatusFile(sid);
  }

  handleSessionUpdated(sid: string): void {
    this.log("session.updated:", sid);
    this.writeStatusFile(sid);
  }

  handleSessionDiff(sid: string): void {
    this.log("session.diff:", sid);
  }

  handleMessageUpdated(e: any): void {
    const sid = this.sid;
    const info = e?.properties?.info;
    const isSynthetic = isSyntheticMessageEvent(e);
    if (info?.role === "user" && isSynthetic) {
      this.log("ignoring synthetic user message update:", sid);
      this.writeStatusFile(sid);
      return;
    }
    if (info?.role === "user" && info?.id) {
      const s = this.getSession(sid);
      if (s.lastUserMessageId !== info.id) {
        s.lastUserMessageId = info.id;
        s.autoSubmitCount = 0;
        s.attempts = 0;
        s.backoffAttempts = 0;
        s.lastNudgeAt = 0;
        s.lastContinueAt = 0;
        this.nudge.resetNudge(sid);
        this.log("user message detected, resetting counters:", sid);
      }
    }
    if (info?.role === "assistant" && info?.tokens) {
      const s = this.getSession(sid);
      const msgTokens = info.tokens;
      const totalMsgTokens = (msgTokens.input || 0) + (msgTokens.output || 0) + (msgTokens.reasoning || 0);
      if (totalMsgTokens > 0) {
        s.estimatedTokens = Math.max(s.estimatedTokens, totalMsgTokens);
        this.log("assistant message tokens:", totalMsgTokens, "input:", msgTokens.input, "output:", msgTokens.output, "reasoning:", msgTokens.reasoning, "session:", sid);
      }
    }
    this.writeStatusFile(sid);
  }

  handleSessionStatus(e: any): void {
    const sid = this.sid;
    const status = e?.properties?.status;
    this.log("session.status:", sid, status?.type);
    const s = this.getSession(sid);

    if (status?.type === "busy" || status?.type === "retry") {
      this.sessionMonitor.touchSession(sid);
      s.userCancelled = false;
      if (s.actionStartedAt === 0) {
        s.actionStartedAt = Date.now();
      }
      if (!s.planning && !s.compacting) {
        this.scheduleRecovery(sid, this.config.stallTimeoutMs);
      }
      const timeSinceOutput = Date.now() - s.lastOutputAt;
      if (timeSinceOutput > this.config.busyStallTimeoutMs && !s.aborting) {
        this.log("busy-but-dead detected: no output for", timeSinceOutput, "ms, forcing recovery");
        if (this.config.showToasts) {
          this.input.client.tui.showToast({
            query: { directory: this.input.directory || "" },
            body: {
              title: "Session Stuck",
              message: `Session busy but no output for ${Math.round(timeSinceOutput / 1000)}s. Forcing recovery...`,
              variant: "warning",
            },
          }).catch(() => {});
        }
        this.recover(sid).catch((e: unknown) => this.log("busy-but-dead recovery failed:", e));
      }
      if (s.lastNudgeAt > 0 && Date.now() - s.lastNudgeAt < 30000) {
        if (this.config.showToasts) {
          this.input.client.tui.showToast({
            query: { directory: this.input.directory || "" },
            body: {
              title: "Session Resumed",
              message: "The AI has resumed working after the nudge.",
              variant: "info",
            },
          }).catch(() => {});
        }
        s.lastNudgeAt = 0;
      }
      if (s.lastContinueAt > 0 && Date.now() - s.lastContinueAt < 30000) {
        if (this.config.showToasts) {
          this.input.client.tui.showToast({
            query: { directory: this.input.directory || "" },
            body: {
              title: "Recovery Successful",
              message: "The AI has resumed working after recovery.",
              variant: "success",
            },
          }).catch(() => {});
        }
        s.lastContinueAt = 0;
      }
      this.terminal.updateTerminalTitle(sid);
      this.terminal.updateTerminalProgress(sid);
    }

    if (status?.type === "idle") {
      s.actionStartedAt = 0;
      this.clearTimer(sid);
      if (s.needsContinue) {
        if (s.aborting) {
          this.log("session idle while recovery is finalizing, recovery will send queued continue for:", sid);
        } else {
          this.log("session idle, sending queued continue for:", sid);
          this.review.sendContinue(sid);
        }
      } else if (this.config.nudgeEnabled) {
        this.nudge.scheduleNudge(sid);
      }
      this.terminal.clearTerminalTitle();
      this.terminal.clearTerminalProgress();
    }

    this.writeStatusFile(sid);
  }

  handleMessagePartUpdated(e: any): void {
    const sid = this.sid;
    this.log("progress event:", e?.type, sid);
    const s = this.getSession(sid);
    const part = e?.properties?.part;
    const partType = part?.type;

    if (part?.synthetic === true) {
      this.log("ignoring synthetic message part");
      return;
    }

    const isRealProgress = partType === "text" || partType === "step-finish" || partType === "reasoning" || partType === "tool" || partType === "step-start" || partType === "subtask" || partType === "file";
    this.log("message.part.updated:", partType, isRealProgress ? "(progress)" : "(ignored)");
    if (isRealProgress) {
      this.updateProgress(s);
      this.sessionMonitor.touchSession(sid);
      s.attempts = 0;
      s.userCancelled = false;
      s.lastStallPartType = partType || "unknown";
      s.lastOutputAt = Date.now();
      if (partType === "text" || partType === "reasoning") {
        const text = e?.properties?.part?.text || "";
        if (text.length > s.lastOutputLength) {
          s.lastOutputLength = text.length;
          this.log("output tracked: text length", text.length, "session:", sid);
        }
      } else if (partType === "tool" || partType === "file" || partType === "subtask" || partType === "step-start" || partType === "step-finish") {
        s.lastOutputLength++;
        this.log("output tracked:", partType, "session:", sid);
      }

      let partText = "";
      if (partType === "tool") {
        partText = JSON.stringify(e?.properties?.part) || "";
      } else if (partType === "file") {
        partText = (e?.properties?.part?.url || "") + " " + (e?.properties?.part?.mime || "");
      } else if (partType === "subtask") {
        partText = (e?.properties?.part?.prompt || "") + " " + (e?.properties?.part?.description || "");
      } else if (partType === "step-start") {
        partText = e?.properties?.part?.name || "";
      }
      if (partText) {
        const estimatedTokens = estimateTokens(partText, this.config.tokenEstimateMultiplier);
        s.estimatedTokens += estimatedTokens;
      }
      if (partType === "step-finish" && part?.tokens) {
        const stepTokens = part.tokens;
        const totalStepTokens = (stepTokens.input || 0) + (stepTokens.output || 0) + (stepTokens.reasoning || 0);
        if (totalStepTokens > 0) {
          s.estimatedTokens = Math.max(s.estimatedTokens, totalStepTokens);
          this.log("step-finish tokens:", totalStepTokens, "input:", stepTokens.input, "output:", stepTokens.output, "reasoning:", stepTokens.reasoning, "session:", sid);
        }
      }
    }

    if (partType === "compaction") {
      this.log("compaction started, pausing stall monitoring");
      s.compacting = true;
    }

    if (partType === "text") {
      const partText = e?.properties?.part?.text as string | undefined;
      if (partText && isPlanContent(partText)) {
        this.log("plan detected in updated text part, pausing stall monitoring");
        s.planning = true;
        s.planningStartedAt = Date.now();
        this.clearTimer(sid);
        this.scheduleRecovery(sid, this.config.planningTimeoutMs);
      }
    }

    if (s.planning && (partType === "tool" || partType === "file" || partType === "subtask" || partType === "step-start" || partType === "step-finish")) {
      this.log("non-plan progress detected, clearing plan flag");
      s.planning = false;
      this.scheduleRecovery(sid, this.config.stallTimeoutMs);
    }

    const deltaText = e?.properties?.delta as string | undefined;
    if (deltaText) {
      s.planBuffer = (s.planBuffer + deltaText).slice(-200);
      if (isPlanContent(s.planBuffer)) {
        this.log("plan detected in delta, pausing stall monitoring — user must address");
        s.planning = true;
        s.planningStartedAt = Date.now();
        s.planBuffer = "";
        this.clearTimer(sid);
        this.scheduleRecovery(sid, this.config.planningTimeoutMs);
      }
    }

    if (!s.planning && !s.compacting) {
      this.clearTimer(sid);
      this.scheduleRecovery(sid, this.config.stallTimeoutMs);
    } else if (s.planning && !s.timer) {
      this.scheduleRecovery(sid, this.config.planningTimeoutMs);
    }
    this.writeStatusFile(sid);
  }

  handleMessageCreatedOrPartAdded(e: any): void {
    const sid = this.sid;
    const msgRole = e?.properties?.info?.role;
    const isSynthetic = isSyntheticMessageEvent(e);
    const isUserMessage = msgRole === "user" && !isSynthetic;

    if (isSynthetic) {
      this.log("ignoring synthetic message activity event:", e?.type, sid);
      this.writeStatusFile(sid);
      return;
    }

    if (isUserMessage) {
      const s = this.sessions.get(sid);
      if (s && s.needsContinue) {
        this.log("user message during recovery, cancelling queued continue");
        s.needsContinue = false;
        s.continueMessageText = "";
      }
    } else {
      const s = this.sessions.get(sid);
      if (s && s.needsContinue) {
        this.log("ignoring synthetic message event during recovery:", e?.type);
        return;
      }
    }

    this.log("activity event:", e?.type, sid, "role:", msgRole);
    const s = this.getSession(sid);

    if (isUserMessage) {
      s.messageCount++;
      const msgText = e?.properties?.info?.content || e?.properties?.info?.text || "";
      const estimatedTokens = estimateTokens(msgText, this.config.tokenEstimateMultiplier);
      s.estimatedTokens += estimatedTokens;
      this.log("message count incremented:", s.messageCount, "estimated tokens added:", estimatedTokens, "total:", s.estimatedTokens);
    } else {
      const msgText = e?.properties?.info?.content || e?.properties?.info?.text || "";
      if (msgText && msgRole !== "assistant") {
        const estimatedTokens = estimateTokens(msgText, this.config.tokenEstimateMultiplier);
        s.estimatedTokens += estimatedTokens;
      }
      s.lastOutputAt = Date.now();
      if (msgText && msgText.length > s.lastOutputLength) {
        s.lastOutputLength = msgText.length;
      }
    }

    this.updateProgress(s);
    s.attempts = 0;
    s.userCancelled = false;
    if (s.planning && isUserMessage) {
      this.log("user sent message, clearing plan flag");
      s.planning = false;
    }
    if (s.compacting) {
      this.log("activity after compaction, clearing compacting flag");
      s.compacting = false;
    }
    this.clearTimer(sid);
    if (!s.planning && !s.compacting) {
      this.scheduleRecovery(sid, this.config.stallTimeoutMs);
    }
    this.writeStatusFile(sid);
  }

  handleTodoUpdated(e: any): void {
    const sid = this.sid;
    const todos = e?.properties?.todos;
    if (!Array.isArray(todos)) return;

    const s = this.getSession(sid);
    const allCompleted = todos.length > 0 && todos.every((t: any) => t.status === "completed" || t.status === "cancelled");
    const hasPending = todos.some((t: any) => t.status === "in_progress" || t.status === "pending");

    s.hasOpenTodos = hasPending;
    s.lastKnownTodos = todos;

    if (allCompleted && !s.reviewFired && this.config.reviewOnComplete) {
      if (s.reviewDebounceTimer) {
        clearTimeout(s.reviewDebounceTimer);
      }
      s.reviewDebounceTimer = setTimeout(() => {
        s.reviewDebounceTimer = null;
        this.review.triggerReview(sid);
      }, this.config.reviewDebounceMs);
    } else if (!allCompleted && s.reviewDebounceTimer) {
      clearTimeout(s.reviewDebounceTimer);
      s.reviewDebounceTimer = null;
    }

    if (hasPending && s.reviewFired) {
      this.log("new pending todos detected after review, resetting review flag:", sid);
      s.reviewFired = false;
    }

    this.writeStatusFile(sid);
  }

  handleSessionIdle(): void {
    const sid = this.sid;
    const s = this.getSession(sid);
    this.clearTimer(sid);
    if (s.needsContinue) {
      if (s.aborting) {
        this.log("session.idle while recovery is finalizing, recovery will send queued continue for:", sid);
      } else {
        this.log("session.idle, sending queued continue for:", sid);
        this.review.sendContinue(sid);
      }
      this.writeStatusFile(sid);
      return;
    }
    this.nudge.scheduleNudge(sid);
    this.writeStatusFile(sid);
  }

  handleSessionCompacted(): void {
    const sid = this.sid;
    const s = this.getSession(sid);
    this.log("session compacted, clearing compacting flag:", sid);
    s.compacting = false;
    s.lastCompactionAt = Date.now();
    s.estimatedTokens = Math.floor(s.estimatedTokens * (1 - this.config.compactReductionFactor));
    s.attempts = 0;
    s.backoffAttempts = 0;
    this.clearTimer(sid);
    if (!s.planning && !s.compacting) {
      this.scheduleRecovery(sid, this.config.stallTimeoutMs);
    }
    s.needsContinue = true;
    s.continueMessageText = s.planning ? this.config.continueWithPlanMessage : this.config.shortContinueMessage;
    this.review.sendContinue(sid).catch((e) => this.log("continue after compaction failed:", e));
    this.writeStatusFile(sid);
  }

  handleStaleEvent(eventType: string): void {
    const sid = this.sid;
    this.log("stale event:", eventType, sid);
    this.nudge.cancelNudge(sid);
    this.resetSession(sid);
    this.writeStatusFile(sid);
  }

  injectCompactionContext(output: any): void {
    const sid = this.sid;
    const s = this.sessions.get(sid);
    if (!s) return;

    const contextLines: string[] = [];

    if (s.lastKnownTodos && s.lastKnownTodos.length > 0) {
      const pending = s.lastKnownTodos.filter((t) => t.status === "in_progress" || t.status === "pending");
      if (pending.length > 0) {
        contextLines.push("## Active Tasks");
        for (const t of pending.slice(0, 5)) {
          contextLines.push(`- ${t.content || t.title || "Task"} (${t.status})`);
        }
      }
    }

    if (s.planning) {
      contextLines.push("## Currently Creating Plan");
      contextLines.push("The agent was in the middle of creating a plan when compaction occurred.");
    }

    if (s.attempts > 0) {
      contextLines.push("## Recovery Context");
      contextLines.push(`Recovery attempts: ${s.attempts}`);
    }

    if (contextLines.length > 0) {
      output.context = output.context || [];
      output.context.push(contextLines.join("\n"));
      this.log("injected session context into compaction:", sid, "lines:", contextLines.length);
    }
  }

  disableAutoContinue(output: any): void {
    output.enabled = false;
    const sid = this.sid;
    const s = this.sessions.get(sid);
    if (s && s.needsContinue) {
      this.log("autocontinue disabled for session:", sid, "- using custom continue");
    }
  }
}