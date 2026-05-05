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

      await (input.client.session as any).abort({ 
        path: { id: sessionId },
        query: { directory: (input as any).directory || "" }
      });

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
          } catch {
            statusFailures++;
          }
        }
      }

      // Also wait the minimum time even if idle
      const remainingWait = config.waitAfterAbortMs - (Date.now() - startTime);
      if (remainingWait > 0) {
        await new Promise(r => setTimeout(r, remainingWait));
      }

      const promptOptions = {
        body: { parts: [{ type: "text", text: "Please continue from where you left off." }] as any[] },
        path: { id: sessionId },
        query: { directory: (input as any).directory }
      };

      try {
        if (typeof (input.client.session as any).promptAsync === "function") {
          await (input.client.session as any).promptAsync(promptOptions);
        } else {
          await input.client.session.prompt(promptOptions as any);
        }
      } catch (e) {
        log('prompt failed:', e);
      }

      s.attempts++;
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
          const partType = e?.properties?.part?.type;
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
        log('activity event:', event?.type, sid);
        const s = getSession(sid);
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
      });
      sessions.clear();
    }
  };
};

