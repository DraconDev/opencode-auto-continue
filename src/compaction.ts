import type { PluginConfig } from "./config.js";
import type { SessionState } from "./session-state.js";
import type { TypedPluginInput } from "./types.js";

export interface CompactionDeps {
  config: PluginConfig;
  sessions: Map<string, SessionState>;
  log: (...args: unknown[]) => void;
  input: TypedPluginInput;
}

export function createCompactionModule(deps: CompactionDeps) {
  const { config, sessions, log, input } = deps;

  function isTokenLimitError(error: any): boolean {
    if (!error) return false;
    const message = error.message || String(error);
    return config.tokenLimitPatterns.some(pattern =>
      message.toLowerCase().includes(pattern.toLowerCase())
    );
  }

  async function attemptCompact(sessionId: string): Promise<boolean> {
    try {
      log('attempting compaction for session:', sessionId);

      const s = sessions.get(sessionId);
      const preTokens = s?.estimatedTokens || 0;
      if (s) {
        s.compacting = true;
        if (config.compactionSafetyTimeoutMs > 0) {
          s.compactionSafetyTimer = setTimeout(() => {
            if (s.compacting) {
              log('[Compaction] SAFETY TIMEOUT — compacting flag stuck for', sessionId, ', force-clearing after', config.compactionSafetyTimeoutMs, 'ms');
              s.compacting = false;
              s.hardCompactionInProgress = false;
            }
          }, config.compactionSafetyTimeoutMs);
          if (s.compactionSafetyTimer.unref) s.compactionSafetyTimer.unref();
        }
      }

      await input.client.session.summarize({
        path: { id: sessionId },
        query: { directory: input.directory || "" }
      });

      const maxWait = config.compactionVerifyWaitMs;
      const waitTimes = [2000, 3000, 5000].filter(t => t <= maxWait);
      if (waitTimes.length === 0) waitTimes.push(maxWait);

      for (const waitMs of waitTimes) {
        await new Promise(r => setTimeout(r, waitMs));

        const status = await input.client.session.status({});
        const data = status.data as Record<string, { type: string }>;
        const isBusy = data[sessionId]?.type === "busy";

        if (!isBusy) {
          log('compaction successful for session:', sessionId, 'after', waitMs, 'ms wait');
          if (s) {
            s.lastCompactionAt = Date.now();
            s.compacting = false;
            if (s.compactionSafetyTimer) { clearTimeout(s.compactionSafetyTimer); s.compactionSafetyTimer = null; }
            const reduction = Math.floor(preTokens * config.compactReductionFactor);
            s.estimatedTokens = Math.max(s.estimatedTokens - reduction, Math.floor(preTokens * (1 - config.compactReductionFactor)));
            log('compaction reduced tokens from ~', preTokens, 'to ~', s.estimatedTokens);
          }
          return true;
        }

        log('compaction still in progress after', waitMs, 'ms, session still busy');
      }

      log('compaction did not complete within expected time for session:', sessionId);
      if (s) {
        s.compacting = false;
        if (s.compactionSafetyTimer) { clearTimeout(s.compactionSafetyTimer); s.compactionSafetyTimer = null; }
      }
      return false;
    } catch (e: any) {
      log('compaction attempt failed:', e?.message || e?.name || String(e), 'status:', e?.status);
      const s = sessions.get(sessionId);
      if (s) {
        s.compacting = false;
        if (s.compactionSafetyTimer) { clearTimeout(s.compactionSafetyTimer); s.compactionSafetyTimer = null; }
      }
      return false;
    }
  }

  async function forceCompact(sessionId: string): Promise<boolean> {
    const s = sessions.get(sessionId);
    if (!s) return false;

    s.compacting = true;

    // Try compaction with retries
    for (let attempt = 0; attempt < config.compactMaxRetries; attempt++) {
      if (attempt > 0) {
        log(`compaction retry ${attempt + 1}/${config.compactMaxRetries} for session:`, sessionId);
        await new Promise(r => setTimeout(r, config.compactRetryDelayMs * attempt));
      }

      const success = await attemptCompact(sessionId);
      if (success) {
        s.tokenLimitHits = 0;
        return true;
      }
    }

    log('compaction failed after all retries for session:', sessionId);
    s.compacting = false;
    return false;
  }

  async function maybeOpportunisticCompact(sessionId: string, reason: string): Promise<boolean> {
    const s = sessions.get(sessionId);
    if (!s) return false;
    if (s.compacting) return false;
    if (s.planning) return false;
    if (s.stoppedByCondition) return false;

    const now = Date.now();
    if (s.lastCompactionAt > 0 && now - s.lastCompactionAt < config.compactCooldownMs) {
      return false;
    }

    const threshold = config.opportunisticCompactAtTokens;
    if (s.estimatedTokens >= threshold) {
      log(`[Compaction] OPPORTUNISTIC TRIGGER (${reason}) — session ${sessionId} has ${s.estimatedTokens} tokens (threshold: ${threshold})`);
      const success = await forceCompact(sessionId);
      if (success) {
        log(`[Compaction] OPPORTUNISTIC SUCCESS (${reason}) — session ${sessionId}`);
      }
      return success;
    }

    return false;
  }

  async function maybeProactiveCompact(sessionId: string): Promise<boolean> {
    if (!config.autoCompact) return false;
    
    const s = sessions.get(sessionId);
    if (!s) return false;
    if (s.compacting) return false;
    if (s.planning) return false;
    
    const now = Date.now();
    if (s.lastCompactionAt > 0 && now - s.lastCompactionAt < config.compactCooldownMs) {
      return false;
    }
    
    const threshold = config.proactiveCompactAtTokens;
    if (s.estimatedTokens >= threshold) {
      log(`[Compaction] PROACTIVE TRIGGER — session ${sessionId} has ${s.estimatedTokens} tokens (threshold: ${threshold}), attempting compaction`);
      s.proactiveCompactCount++;
      const success = await forceCompact(sessionId);
      if (success) {
        log(`[Compaction] PROACTIVE SUCCESS — session ${sessionId} compacted successfully`);
      } else {
        log(`[Compaction] PROACTIVE FAILED — session ${sessionId} compaction failed`);
      }
      return success;
    }
    
    return false;
  }

  async function maybeHardCompact(sessionId: string): Promise<boolean> {
    const s = sessions.get(sessionId);
    if (!s) return false;
    if (s.hardCompactionInProgress) return false;
    if (s.compacting) return false;
    if (s.planning) return false;
    if (s.stoppedByCondition) return false;

    const threshold = config.hardCompactAtTokens;
    if (threshold <= 0) return false;
    if (s.estimatedTokens < threshold) return false;

    s.hardCompactionInProgress = true;
    s.hardCompactCount++;
    log(`[Compaction] HARD TRIGGER — session ${sessionId} has ${s.estimatedTokens} tokens (hard threshold: ${threshold}), blocking until compaction completes`);

    const bypassCooldown = config.hardCompactBypassCooldown;
    const cooldownOk = bypassCooldown || s.lastCompactionAt === 0 || Date.now() - s.lastCompactionAt >= config.compactCooldownMs;

    if (cooldownOk) {
      const maxWait = config.hardCompactMaxWaitMs;
      const deadline = Date.now() + maxWait;

      let success = false;
      for (let attempt = 0; attempt < config.compactMaxRetries; attempt++) {
        if (Date.now() > deadline) {
          log(`[Compaction] HARD TIMEOUT — exceeded max wait ${maxWait}ms for session ${sessionId}`);
          break;
        }
        if (attempt > 0) {
          const delay = Math.min(config.compactRetryDelayMs * attempt, deadline - Date.now());
          if (delay > 0) await new Promise(r => setTimeout(r, delay));
        }
        success = await attemptCompact(sessionId);
        if (success) break;
      }

      if (success) {
        log(`[Compaction] HARD SUCCESS — session ${sessionId} compacted via hard compactor`);
        s.lastHardCompactionAt = Date.now();
      } else {
        log(`[Compaction] HARD FAILED — session ${sessionId} hard compaction did not succeed within ${maxWait}ms`);
      }
    } else {
      log(`[Compaction] HARD SKIP — cooldown active and bypass disabled for session ${sessionId}`);
    }

    s.hardCompactionInProgress = false;
    return s.estimatedTokens < threshold;
  }

  return { isTokenLimitError, attemptCompact, forceCompact, maybeProactiveCompact, maybeOpportunisticCompact, maybeHardCompact };
}