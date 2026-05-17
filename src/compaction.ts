import type { PluginConfig } from "./config.js";
import type { SessionState } from "./session-state.js";
import { getTokenCount } from "./session-state.js";
import type { TypedPluginInput } from "./types.js";

export interface CompactionDeps {
  config: PluginConfig;
  sessions: Map<string, SessionState>;
  log: (...args: unknown[]) => void;
  input: TypedPluginInput;
}

type BackoffCheckResult = { blocked: boolean; reason: string; remainingMs: number };

function checkBackoff(s: SessionState, config: PluginConfig): BackoffCheckResult {
  const now = Date.now();

  if (s.lastCompactionFailedAt > 0) {
    const timeSinceFail = now - s.lastCompactionFailedAt;
    if (timeSinceFail < config.compactionFailBackoffMs) {
      return {
        blocked: true,
        reason: 'failure backoff',
        remainingMs: config.compactionFailBackoffMs - timeSinceFail,
      };
    }
  }

  if (s.lastCompactionTimeoutAt > 0) {
    const timeSinceTimeout = now - s.lastCompactionTimeoutAt;
    if (timeSinceTimeout < config.compactionTimeoutBackoffMs) {
      return {
        blocked: true,
        reason: 'timeout backoff',
        remainingMs: config.compactionTimeoutBackoffMs - timeSinceTimeout,
      };
    }
  }

  return { blocked: false, reason: '', remainingMs: 0 };
}

/**
 * Create the compaction module. Implements a 4-layer compaction strategy:
 * 1. Opportunistic — when token usage is elevated but not critical
 * 2. Proactive — when token usage is approaching the limit
 * 3. Hard — when token usage is at the limit
 * 4. Emergency — last resort when hard compaction fails
 * Each layer has its own thresholds, grace periods, and failure backoff.
 */
export function createCompactionModule(deps: CompactionDeps) {
  const { config, sessions, log, input } = deps;

  function inGracePeriod(s: SessionState): boolean {
    if (config.compactionGracePeriodMs <= 0 || s.lastCompactionAt <= 0) return false;
    const elapsed = Date.now() - s.lastCompactionAt;
    if (elapsed < config.compactionGracePeriodMs) {
      log(`[Compaction] GRACE PERIOD — ${Math.round((config.compactionGracePeriodMs - elapsed) / 1000)}s remaining since last compaction`);
      return true;
    }
    return false;
  }

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
      if (!s) return false;
      if (s.compacting && !s.compactionTimedOut) {
        log('already compacting and not timed out — skipping for session:', sessionId);
        return false;
      }
      s.compacting = true;
      s.compactionTimedOut = false;

      const baseWait = config.compactionVerifyWaitMs;
      const tokenCount = getTokenCount(s);
      const scaledWait = tokenCount > 500000 ? baseWait * 3 : tokenCount > 200000 ? baseWait * 2 : baseWait;
      const effectiveSafetyMs = config.compactionSafetyTimeoutMs > 0
        ? Math.max(config.compactionSafetyTimeoutMs, scaledWait + 5000)
        : 0;

      if (effectiveSafetyMs > 0 && !s.compactionSafetyTimer) {
        s.compactionSafetyTimer = setTimeout(() => {
          if (s.compacting) {
            log('[Compaction] SAFETY TIMEOUT — compacting flag stuck for', sessionId, ', force-clearing after', effectiveSafetyMs, 'ms');
            s.compactionTimedOut = true;
            s.compacting = false;
            s.hardCompactionInProgress = false;
          }
        }, effectiveSafetyMs);
        if (s.compactionSafetyTimer.unref) s.compactionSafetyTimer.unref();
      }

      await input.client.session.summarize({
        path: { id: sessionId },
        query: { directory: input.directory || "" }
      });

      const maxWait = scaledWait;
      const pollInterval = 1000;
      const deadline = Date.now() + maxWait;

      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, pollInterval));
        const current = sessions.get(sessionId);
        if (!current) {
          log('session deleted during compaction wait');
          return false;
        }
        if (current.compactionTimedOut) {
          log('compaction aborted — safety timeout fired for session:', sessionId);
          current.compacting = false;
          if (current.compactionSafetyTimer) { clearTimeout(current.compactionSafetyTimer); current.compactionSafetyTimer = null; }
          return false;
        }
        if (!current.compacting && current.lastCompactionAt > 0) {
          log('compaction completed (detected via compacting flag cleared) for session:', sessionId);
          if (s && s.compactionSafetyTimer) { clearTimeout(s.compactionSafetyTimer); s.compactionSafetyTimer = null; }
          return true;
        }
        if (!current.compacting) {
          log('compacting flag cleared without lastCompactionAt — session.compacted may have fired before we started polling for session:', sessionId);
          if (s && s.compactionSafetyTimer) { clearTimeout(s.compactionSafetyTimer); s.compactionSafetyTimer = null; }
          return current.lastCompactionAt > 0;
        }
      }

      log('compaction timed out after', maxWait, 'ms (scaled from', baseWait, 'for', tokenCount, 'tokens), session still compacting:', sessionId);
      if (s) {
        s.compacting = false;
        s.compactionTimedOut = true;
        s.lastCompactionTimeoutAt = Date.now();
        if (s.compactionSafetyTimer) { clearTimeout(s.compactionSafetyTimer); s.compactionSafetyTimer = null; }
      }
      return false;
    } catch (e: any) {
      log('compaction attempt failed:', e?.message || e?.name || String(e), 'status:', e?.status);
      const s = sessions.get(sessionId);
      if (s) {
        s.compacting = false;
        s.lastCompactionFailedAt = Date.now();
        if (s.compactionSafetyTimer) { clearTimeout(s.compactionSafetyTimer); s.compactionSafetyTimer = null; }
      }
      return false;
    }
  }

  async function forceCompact(sessionId: string): Promise<boolean> {
    const s = sessions.get(sessionId);
    if (!s) return false;

    for (let attempt = 0; attempt < config.compactMaxRetries; attempt++) {
      if (attempt > 0) {
        log(`compaction retry ${attempt + 1}/${config.compactMaxRetries} for session:`, sessionId);
        await new Promise(r => setTimeout(r, config.compactRetryDelayMs * attempt));
        s.compactionTimedOut = false;
      }

      const success = await attemptCompact(sessionId);
      if (success) {
        s.tokenLimitHits = 0;
        s.lastCompactionFailedAt = 0;
        s.lastCompactionTimeoutAt = 0;
        return true;
      }
      if (s.compactionTimedOut) {
        log('compaction aborted due to safety timeout, not retrying for session:', sessionId);
        break;
      }
    }

    log('compaction failed after all retries for session:', sessionId);
    s.compacting = false;
    if (s.compactionTimedOut) {
      s.lastCompactionTimeoutAt = Date.now();
    } else {
      s.lastCompactionFailedAt = Date.now();
    }
    return false;
  }

  async function maybeOpportunisticCompact(sessionId: string, reason: string): Promise<boolean> {
    const s = sessions.get(sessionId);
    if (!s) return false;
    if (s.compacting) { log(`[Compaction] OPPORTUNISTIC SKIP (${reason}) — already compacting`); return false; }
    if (s.planning) { log(`[Compaction] OPPORTUNISTIC SKIP (${reason}) — planning`); return false; }
    if (s.stoppedByCondition) { log(`[Compaction] OPPORTUNISTIC SKIP (${reason}) — stopped by condition`); return false; }
    if (inGracePeriod(s)) { log(`[Compaction] OPPORTUNISTIC SKIP (${reason}) — grace period`); return false; }
    const backoff = checkBackoff(s, config);
    if (backoff.blocked) {
      log(`[Compaction] OPPORTUNISTIC SKIP (${reason}) — recent ${backoff.reason} (${Math.round(backoff.remainingMs / 1000)}s remaining)`);
      return false;
    }

    const now = Date.now();
    if (s.lastCompactionAt > 0 && now - s.lastCompactionAt < config.compactCooldownMs) {
      log(`[Compaction] OPPORTUNISTIC SKIP (${reason}) — cooldown (${Math.round((config.compactCooldownMs - (now - s.lastCompactionAt)) / 1000)}s remaining)`);
      return false;
    }

    const threshold = config.opportunisticCompactAtTokens;
    const tokenCount = getTokenCount(s);
    if (tokenCount >= threshold) {
      log(`[Compaction] OPPORTUNISTIC TRIGGER (${reason}) — session ${sessionId} has ${tokenCount} tokens (threshold: ${threshold})`);
      const success = await forceCompact(sessionId);
      if (success) {
        log(`[Compaction] OPPORTUNISTIC SUCCESS (${reason}) — session ${sessionId}`);
      }
      return success;
    }

    log(`[Compaction] OPPORTUNISTIC SKIP (${reason}) — tokens ${tokenCount} < threshold ${threshold}, session ${sessionId}`);
    return false;
  }

  async function maybeProactiveCompact(sessionId: string): Promise<boolean> {
    if (!config.autoCompact) return false;
    
    const s = sessions.get(sessionId);
    if (!s) return false;
    if (s.compacting) { log('[Compaction] PROACTIVE SKIP — already compacting'); return false; }
    if (s.planning) { log('[Compaction] PROACTIVE SKIP — planning'); return false; }
    if (inGracePeriod(s)) { log('[Compaction] PROACTIVE SKIP — grace period'); return false; }
    const backoff = checkBackoff(s, config);
    if (backoff.blocked) {
      log(`[Compaction] PROACTIVE SKIP — recent ${backoff.reason} (${Math.round(backoff.remainingMs / 1000)}s remaining)`);
      return false;
    }
    
    const now = Date.now();
    if (s.lastCompactionAt > 0 && now - s.lastCompactionAt < config.compactCooldownMs) {
      log('[Compaction] PROACTIVE SKIP — cooldown');
      return false;
    }
    
    const threshold = config.proactiveCompactAtTokens;
    const tokenCount = getTokenCount(s);
    if (tokenCount >= threshold) {
      log(`[Compaction] PROACTIVE TRIGGER — session ${sessionId} has ${tokenCount} tokens (threshold: ${threshold}), attempting compaction`);
      s.proactiveCompactCount++;
      const success = await forceCompact(sessionId);
      if (success) {
        log(`[Compaction] PROACTIVE SUCCESS — session ${sessionId} compacted successfully`);
      } else {
        log(`[Compaction] PROACTIVE FAILED — session ${sessionId} compaction failed`);
      }
      return success;
    }
    
    log(`[Compaction] PROACTIVE SKIP — tokens ${tokenCount} < threshold ${threshold}, session ${sessionId}`);
    return false;
  }

  async function maybeHardCompact(sessionId: string): Promise<boolean> {
    const s = sessions.get(sessionId);
    if (!s) return false;
    if (s.hardCompactionInProgress) { log('[Compaction] HARD SKIP — already in progress'); return false; }
    if (s.compacting) { log('[Compaction] HARD SKIP — already compacting'); return false; }
    if (s.stoppedByCondition) { log('[Compaction] HARD SKIP — stopped by condition'); return false; }
    if (inGracePeriod(s)) { log('[Compaction] HARD SKIP — grace period'); return false; }
    const backoff = checkBackoff(s, config);
    if (backoff.blocked) {
      log(`[Compaction] HARD SKIP — recent ${backoff.reason} (${Math.round(backoff.remainingMs / 1000)}s remaining)`);
      return false;
    }

    const threshold = config.hardCompactAtTokens;
    if (threshold <= 0) return false;
    const tokenCount = getTokenCount(s);
    if (tokenCount < threshold) {
      log(`[Compaction] HARD SKIP — tokens ${tokenCount} < threshold ${threshold}, session ${sessionId}`);
      return false;
    }

    s.hardCompactionInProgress = true;
    s.hardCompactCount++;
    log(`[Compaction] HARD TRIGGER — session ${sessionId} has ${getTokenCount(s)} tokens (hard threshold: ${threshold}), blocking until compaction completes`);

    const bypassCooldown = config.hardCompactBypassCooldown;
    const cooldownOk = bypassCooldown || s.lastCompactionAt === 0 || Date.now() - s.lastCompactionAt >= config.compactCooldownMs;

    let success = false;
    let attempted = false;
    if (cooldownOk) {
      const maxWait = config.hardCompactMaxWaitMs;
      const deadline = Date.now() + maxWait;

      for (let attempt = 0; attempt < config.compactMaxRetries; attempt++) {
        if (Date.now() > deadline) {
          log(`[Compaction] HARD TIMEOUT — exceeded max wait ${maxWait}ms for session ${sessionId}`);
          break;
        }
        if (attempt > 0) {
          const delay = Math.min(config.compactRetryDelayMs * attempt, deadline - Date.now());
          if (delay > 0) await new Promise(r => setTimeout(r, delay));
          s.compactionTimedOut = false;
        }
        attempted = true;
        success = await attemptCompact(sessionId);
        if (success) break;
        if (s.compactionTimedOut) {
          log(`[Compaction] HARD ABORT — safety timeout, not retrying for session ${sessionId}`);
          break;
        }
      }

      if (success) {
        log(`[Compaction] HARD SUCCESS — session ${sessionId} compacted via hard compactor`);
        s.lastHardCompactionAt = Date.now();
        s.lastCompactionFailedAt = 0;
        s.lastCompactionTimeoutAt = 0;
      } else if (attempted) {
        log(`[Compaction] HARD FAILED — session ${sessionId} hard compaction did not succeed within ${maxWait}ms`);
        if (s.compactionTimedOut) {
          s.lastCompactionTimeoutAt = Date.now();
        } else {
          s.lastCompactionFailedAt = Date.now();
        }
      }
    } else {
      log(`[Compaction] HARD SKIP — cooldown active and bypass disabled for session ${sessionId}`);
    }

    s.hardCompactionInProgress = false;
    return success;
  }

  return { isTokenLimitError, attemptCompact, forceCompact, maybeProactiveCompact, maybeOpportunisticCompact, maybeHardCompact, inGracePeriod };
}