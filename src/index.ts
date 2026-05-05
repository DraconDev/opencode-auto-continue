import type { Plugin } from "@opencode-ai/plugin";
import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";

interface SessionState {
  timer: ReturnType<typeof setTimeout> | null;
  attempts: number;
  lastRecoveryTime: number;
  lastProgressAt: number;
  aborting: boolean;
  userCancelled: boolean;
  planning: boolean;
  planBuffer: string;
  compacting: boolean;
  backoffAttempts: number;
  autoSubmitCount: number;
  lastUserMessageId: string;
  sentMessageAt: number;
  reviewFired: boolean;
  reviewDebounceTimer: ReturnType<typeof setTimeout> | null;
  nudgeTimer: ReturnType<typeof setTimeout> | null;
  lastNudgeAt: number;
  hasOpenTodos: boolean;
  needsContinue: boolean;
  continueMessageText: string;
}

interface PluginConfig {
  stallTimeoutMs: number;
  waitAfterAbortMs: number;
  maxRecoveries: number;
  cooldownMs: number;
  abortPollIntervalMs: number;
  abortPollMaxTimeMs: number;
  abortPollMaxFailures: number;
  debug: boolean;
  maxBackoffMs: number;
  maxAutoSubmits: number;
  continueMessage: string;
  continueWithTodosMessage: string;
  maxAttemptsMessage: string;
  includeTodoContext: boolean;
  reviewOnComplete: boolean;
  reviewMessage: string;
  reviewDebounceMs: number;
  showToasts: boolean;
  nudgeEnabled: boolean;
  nudgeTimeoutMs: number;
  nudgeMessage: string;
  nudgeCooldownMs: number;
  autoCompact: boolean;
}

const DEFAULT_CONFIG: PluginConfig = {
  stallTimeoutMs: 180000,
  waitAfterAbortMs: 1500,
  maxRecoveries: 3,
  cooldownMs: 60000,
  abortPollIntervalMs: 200,
  abortPollMaxTimeMs: 5000,
  abortPollMaxFailures: 3,
  debug: false,
  maxBackoffMs: 1800000,
  maxAutoSubmits: 3,
  continueMessage: "Please continue from where you left off.",
  continueWithTodosMessage: "Please continue from where you left off. You have {pending} open task(s): {todoList}.",
  maxAttemptsMessage: "I've tried to continue several times but haven't seen progress. Please send a new message when you're ready to continue.",
  includeTodoContext: true,
  reviewOnComplete: true,
  reviewMessage: "All tasks in this session have been completed. Please perform a final review: summarize what was accomplished, note any technical decisions or trade-offs made, flag anything that should be documented, and list any follow-up tasks or improvements for next time.",
  reviewDebounceMs: 500,
  showToasts: false,
  nudgeEnabled: true,
  nudgeTimeoutMs: 300000,
  nudgeMessage: "You have {pending} open task(s). Send a message when you're ready to continue.",
  nudgeCooldownMs: 60000,
  autoCompact: true,
};

function validateConfig(config: PluginConfig): PluginConfig {
  const errors: string[] = [];
  
  if (config.stallTimeoutMs <= 0) {
    errors.push(`stallTimeoutMs must be > 0, got ${config.stallTimeoutMs}`);
  }
  if (config.waitAfterAbortMs <= 0) {
    errors.push(`waitAfterAbortMs must be > 0, got ${config.waitAfterAbortMs}`);
  }
  if (config.stallTimeoutMs <= config.waitAfterAbortMs) {
    errors.push(`stallTimeoutMs (${config.stallTimeoutMs}) must be > waitAfterAbortMs (${config.waitAfterAbortMs})`);
  }
  if (config.maxRecoveries < 0) {
    errors.push(`maxRecoveries must be >= 0, got ${config.maxRecoveries}`);
  }
  if (config.cooldownMs < 0) {
    errors.push(`cooldownMs must be >= 0, got ${config.cooldownMs}`);
  }
  if (config.abortPollIntervalMs <= 0) {
    errors.push(`abortPollIntervalMs must be > 0, got ${config.abortPollIntervalMs}`);
  }
  if (config.abortPollMaxTimeMs < 0) {
    errors.push(`abortPollMaxTimeMs must be >= 0, got ${config.abortPollMaxTimeMs}`);
  }
  if (config.abortPollMaxFailures <= 0) {
    errors.push(`abortPollMaxFailures must be > 0, got ${config.abortPollMaxFailures}`);
  }

  if (config.maxBackoffMs < config.stallTimeoutMs) {
    errors.push(`maxBackoffMs (${config.maxBackoffMs}) must be >= stallTimeoutMs (${config.stallTimeoutMs})`);
  }
  if (config.maxAutoSubmits < 0) {
    errors.push(`maxAutoSubmits must be >= 0, got ${config.maxAutoSubmits}`);
  }
  if (!config.continueMessage || typeof config.continueMessage !== 'string') {
    errors.push(`continueMessage must be a non-empty string`);
  }
  if (!config.reviewMessage || typeof config.reviewMessage !== 'string') {
    errors.push(`reviewMessage must be a non-empty string`);
  }
  if (config.reviewDebounceMs < 0) {
    errors.push(`reviewDebounceMs must be >= 0, got ${config.reviewDebounceMs}`);
  }

  if (errors.length > 0) {
    try {
      const vLogDir = join(process.env.HOME || "/tmp", ".opencode", "logs");
      const vLogFile = join(vLogDir, "auto-force-resume.log");
      if (!existsSync(vLogDir)) mkdirSync(vLogDir, { recursive: true });
      appendFileSync(vLogFile, `[${new Date().toISOString()}] [auto-force-resume] Config validation failed, using defaults: ${errors.join(', ')}\n`);
    } catch {
      // ignore
    }
    return { ...DEFAULT_CONFIG };
  }
  
  return config;
}

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
      sessions.set(id, {
        timer: null,
        attempts: 0,
        lastRecoveryTime: 0,
        lastProgressAt: Date.now(),
        aborting: false,
        userCancelled: false,
        planning: false,
        planBuffer: '',
        compacting: false,
        backoffAttempts: 0,
        autoSubmitCount: 0,
        lastUserMessageId: '',
        sentMessageAt: 0,
        reviewFired: false,
        reviewDebounceTimer: null,
        nudgeTimer: null,
        lastNudgeAt: 0,
        hasOpenTodos: false,
        needsContinue: false,
        continueMessageText: '',
      });
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
    }
    sessions.delete(id);
  }

  function updateProgress(s: SessionState) {
    s.lastProgressAt = Date.now();
  }

  const PLAN_PATTERNS = [
    /^here\s+is\s+(my|the)\s+plan/i,
    /^here'[rs]\s+(my|the)\s+plan/i,
    /^##\s*plan\b/i,
    /^\*\*plan:\*\*$/i,
    /^##\s*proposed\s+plan/i,
    /^##\s*implementation\s+plan/i,
    /^plan:\s*/i,
    /^\d+[\.\)]\s*step\s+\d+/i,
    /^-\s*\[x\]\s/i,
    /^-\s*\[\s\]\s/i,
    /^let\s+me\s+outline/i,
    /^here'?s?\s+(my|the)\s+approach/i,
    /^i('ll|'m going to| will)\s+start\s+by/i,
    /^(first|to start|initially),?\s+(i('ll|'m)|we('ll|'re))/i,
    /^here'?s?\s+(what i|what we|how i|how we)/i,
    /^my\s+plan\s+is/i,
    /^step\s+\d+[\:\.]/i,
    /^\d+\.\s+[A-Z]/i,
    /^-\s+[A-Z][^\.]*$/im,
    /^\*\s+[A-Z][^\.]*$/im,
  ];

  function isPlanContent(text: string): boolean {
    const trimmed = text.trim();
    return PLAN_PATTERNS.some(p => p.test(trimmed));
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

  function formatMessage(template: string, vars: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] || '');
  }

  async function triggerReview(sessionId: string) {
    if (isDisposed) return;
    const s = sessions.get(sessionId);
    if (!s || s.reviewFired) return;
    
    s.reviewFired = true;
    log('triggering review for session:', sessionId);
    
    try {
      // Show toast if enabled
      if (config.showToasts) {
        try {
          await (input.client as any).tui.showToast({
            query: { directory: (input as any).directory || "" },
            body: {
              title: "Session Complete",
              message: "All tasks completed. Initiating review...",
              variant: "info",
            },
          });
        } catch (e) {
          log('toast error (ignored):', e);
        }
      }
      
      // Send review prompt
      await (input.client.session as any).prompt({
        path: { id: sessionId },
        query: { directory: (input as any).directory || "" },
        body: {
          parts: [{
            type: "text",
            text: config.reviewMessage,
            synthetic: true,
          }],
        },
      });
      
      log('review sent successfully');
    } catch (e) {
      log('review failed:', e);
    }
  }

  async function sendNudge(sessionId: string) {
    if (isDisposed) return;
    const s = sessions.get(sessionId);
    if (!s) return;
    
    // Don't nudge if user recently engaged
    if (s.lastUserMessageId) return;
    
    // Don't nudge if recently nudged
    if (Date.now() - s.lastNudgeAt < config.nudgeCooldownMs) return;
    
    // Don't nudge if no open todos
    if (!s.hasOpenTodos) return;
    
    log('sending nudge for session:', sessionId);
    s.lastNudgeAt = Date.now();
    
    try {
      const messageText = formatMessage(config.nudgeMessage, {
        pending: s.hasOpenTodos ? 'some' : '0',
      });
      
      await (input.client.session as any).prompt({
        path: { id: sessionId },
        query: { directory: (input as any).directory || "" },
        body: {
          parts: [{
            type: "text",
            text: messageText,
            synthetic: true,
          }],
        },
      });
      
      log('nudge sent successfully');
    } catch (e) {
      log('nudge failed:', e);
    }
  }

  async function sendContinue(sessionId: string) {
    if (isDisposed) return;
    const s = sessions.get(sessionId);
    if (!s || !s.needsContinue) return;
    
    const messageText = s.continueMessageText;
    s.needsContinue = false;
    s.continueMessageText = '';
    
    log('sending continue prompt from event handler');
    
    try {
      await (input.client.session as any).prompt({
        path: { id: sessionId },
        query: { directory: (input as any).directory || "" },
        body: {
          parts: [{
            type: "text",
            text: messageText,
            synthetic: true,
          }],
        },
      });
      
      log('continue sent successfully');
    } catch (e: any) {
      log('continue failed:', e);
      
      // Handle token limit error
      if (isTokenLimitError(e)) {
        log('token limit error detected, forcing compaction');
        const compacted = await forceCompact(sessionId);
        if (compacted) {
          log('compaction succeeded, retrying continue');
          // Retry after compaction
          await new Promise(r => setTimeout(r, 2000));
          try {
            await (input.client.session as any).prompt({
              path: { id: sessionId },
              query: { directory: (input as any).directory || "" },
              body: {
                parts: [{
                  type: "text",
                  text: "Please continue from where you left off.",
                  synthetic: true,
                }],
              },
            });
            log('retry after compaction succeeded');
          } catch (e2) {
            log('retry after compaction failed:', e2);
          }
        } else {
          log('compaction failed, giving up on this recovery');
        }
      }
    }
  }

  function isTokenLimitError(error: any): boolean {
    if (!error) return false;
    const message = error.message || String(error);
    return message.includes('context length') || 
           message.includes('maximum context length') ||
           message.includes('token count exceeds') ||
           message.includes('too many tokens');
  }

  async function forceCompact(sessionId: string): Promise<boolean> {
    try {
      log('forcing compaction for token limit');
      await (input.client.session as any).summarize({
        path: { id: sessionId },
        query: { directory: (input as any).directory || "" }
      });
      // Wait for compaction
      await new Promise(r => setTimeout(r, 5000));
      
      // Verify it worked
      const status = await input.client.session.status({});
      const data = status.data as Record<string, { type: string }>;
      return data[sessionId]?.type !== "busy";
    } catch (e) {
      log('force compaction failed:', e);
      return false;
    }
  }

  async function recover(sessionId: string) {
    if (isDisposed) return;
    const s = sessions.get(sessionId);
    if (!s) return;

    if (s.aborting) return;
    if (s.userCancelled) return;
    if (s.planning) return;
    if (s.compacting) return;
    if (s.attempts >= config.maxRecoveries) {
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

    s.aborting = true;

    try {
      const statusResult = await input.client.session.status({});
      const statusData = statusResult.data as Record<string, { type: string }>;
      const sessionStatus = statusData[sessionId];

      if (!sessionStatus || sessionStatus.type !== "busy") {
        s.aborting = false;
        return;
      }

      if (now - s.lastProgressAt < config.stallTimeoutMs) {
        s.aborting = false;
        const remaining = config.stallTimeoutMs - (now - s.lastProgressAt);
        s.timer = setTimeout(() => recover(sessionId), Math.max(remaining, 100));
        return;
      }

      // Try auto-compaction before aborting
      if (config.autoCompact) {
        try {
          log('attempting auto-compaction for session:', sessionId);
          await (input.client.session as any).summarize({
            path: { id: sessionId },
            query: { directory: (input as any).directory || "" }
          });
          log('auto-compaction successful, waiting for session to resume');
          // Wait a bit for compaction to complete
          await new Promise(r => setTimeout(r, 3000));
          
          // Check if session recovered
          const postCompactStatus = await input.client.session.status({});
          const postData = postCompactStatus.data as Record<string, { type: string }>;
          if (postData[sessionId]?.type === "busy") {
            log('session still busy after compaction, proceeding with abort');
          } else {
            log('session recovered after compaction');
            s.aborting = false;
            return;
          }
        } catch (e) {
          log('auto-compaction failed:', e);
        }
      }

      try {
        await (input.client.session as any).abort({
          path: { id: sessionId },
          query: { directory: (input as any).directory || "" }
        });
      } catch (e) {
        log('abort failed:', e);
        s.aborting = false;
        s.timer = setTimeout(() => recover(sessionId), config.stallTimeoutMs * 2);
        return;
      }

      // Poll for session to become idle
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

      // Also wait the minimum time even if idle
      const remainingWait = config.waitAfterAbortMs - (Date.now() - startTime);
      if (remainingWait > 0) {
        await new Promise(r => setTimeout(r, remainingWait));
      }

      // Loop protection: check auto-submit count
      if (s.autoSubmitCount >= config.maxAutoSubmits) {
        log('loop protection: max auto-submits reached:', s.autoSubmitCount);
        s.aborting = false;
        return;
      }

      // Fetch todos if enabled
      let messageText = config.continueMessage;
      const templateVars: Record<string, string> = {
        attempts: String(s.attempts + 1),
        maxAttempts: String(config.maxRecoveries),
      };
      
      if (config.includeTodoContext) {
        try {
          const todoResult = await (input.client.session as any).todo({ path: { id: sessionId } });
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

      // If still using default message, apply template vars
      if (messageText === config.continueMessage) {
        messageText = formatMessage(config.continueMessage, templateVars);
      }

      // Store message for later delivery (from event handler, not timer)
      s.needsContinue = true;
      s.continueMessageText = messageText;
      log('queued continue message, waiting for stable state');

      s.attempts++;
      s.autoSubmitCount++;
      s.lastRecoveryTime = Date.now();
      s.backoffAttempts = 0;

      // Don't set timer here - event handlers will set it when new activity starts
    } catch (e) {
      // Recovery failed, retry with longer delay
      log('recovery failed:', e);
      s.timer = setTimeout(() => recover(sessionId), config.stallTimeoutMs * 2);
    } finally {
      s.aborting = false;
    }
  }

  return {
    event: async ({ event }: { event: any }) => {
      const e = event as any;
      const sid = e?.properties?.sessionID || e?.properties?.info?.sessionID || e?.properties?.part?.sessionID || "default";

      const progressTypes = [
        "message.part.updated",
      ];

      const staleTypes = [
        "session.idle",
        "session.error",
        "session.compacted",
        "session.ended",
        "session.deleted"
      ];

      if (event?.type === "session.error") {
        const err = e?.properties?.error;
        log('session.error:', err?.name);
        if (err?.name === "MessageAbortedError") {
          const s = sessions.get(sid);
          if (s) s.userCancelled = true;
          log('user cancelled session:', sid);
        }
        clearTimer(sid);
        return;
      }

      if (event?.type === "session.created") {
        log('session.created:', sid);
        getSession(sid);
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
            // Reset nudge timer on user activity
            if (s.nudgeTimer) {
              clearTimeout(s.nudgeTimer);
              s.nudgeTimer = null;
            }
            log('user message detected, resetting counters:', sid);
          }
        }
        return;
      }

      if (event?.type === "session.status") {
        const status = e?.properties?.status;
        log('session.status:', sid, status?.type);
        const s = getSession(sid);
        if (status?.type === "busy") {
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
        }
        // Send queued continue when session becomes idle/stable
        if (status?.type === "idle" && s.needsContinue) {
          log('session idle, sending queued continue for:', sid);
          await sendContinue(sid);
        } else if (status?.type === "idle") {
          log('session idle but no queued continue for:', sid, 'needsContinue:', s.needsContinue);
        }
        clearTimer(sid);
        if (status?.type === "busy" || status?.type === "retry") {
          s.timer = setTimeout(() => {
            recover(sid);
          }, config.stallTimeoutMs);
        }
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
          }
          if (partType === "compaction") {
            log('compaction started, pausing stall monitoring');
            s.compacting = true;
          }
          if (partType === "text") {
            const partText = e?.properties?.part?.text as string | undefined;
            if (partText && isPlanContent(partText)) {
              log('plan detected in updated text part, pausing stall monitoring');
              s.planning = true;
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
        return;
      }

      if (event?.type === "message.created" || event?.type === "message.part.added") {
        // CRITICAL: Ignore events from our own synthetic prompts
        // We track needsContinue to know if we sent a prompt recently
        const s = sessions.get(sid);
        if (s && s.needsContinue) {
          log('ignoring message event during recovery:', event?.type);
          return;
        }
        
        log('activity event:', event?.type, sid);
        const s2 = getSession(sid);
        updateProgress(s2);
        s2.attempts = 0;
        s2.userCancelled = false;
        if (s2.planning) {
          log('user sent message, clearing plan flag');
          s2.planning = false;
        }
        if (s2.compacting) {
          log('user sent message, clearing compacting flag');
          s2.compacting = false;
        }
        clearTimer(sid);
        if (!s2.planning && !s2.compacting) {
          s2.timer = setTimeout(() => {
            recover(sid);
          }, config.stallTimeoutMs);
        }
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
            triggerReview(sid);
          }, config.reviewDebounceMs);
        } else if (!allCompleted && s.reviewDebounceTimer) {
          clearTimeout(s.reviewDebounceTimer);
          s.reviewDebounceTimer = null;
        }
        
        // Handle nudge timer
        if (hasPending && config.nudgeEnabled) {
          // Start or reset nudge timer
          if (s.nudgeTimer) {
            clearTimeout(s.nudgeTimer);
          }
          s.nudgeTimer = setTimeout(() => {
            s.nudgeTimer = null;
            sendNudge(sid);
          }, config.nudgeTimeoutMs);
        } else if (!hasPending && s.nudgeTimer) {
          // Cancel nudge if no pending todos
          clearTimeout(s.nudgeTimer);
          s.nudgeTimer = null;
        }
        return;
      }

      if (staleTypes.includes(event?.type)) {
        log('stale event:', event?.type, sid);
        resetSession(sid);
        return;
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
      });
      sessions.clear();
    }
  };
};

