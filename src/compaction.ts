import type { PluginConfig, SessionState } from "./shared.js";
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

      // Record pre-compaction state
      const s = sessions.get(sessionId);
      const preTokens = s?.estimatedTokens || 0;
      if (s) {
        s.compacting = true;
      }

      // Check if session is busy - summarize requires idle session
      const preStatus = await input.client.session.status({});
      const preData = preStatus.data as Record<string, { type: string }>;
      if (preData[sessionId]?.type === "busy") {
        log('compaction skipped: session is busy, cannot summarize while generating');
        if (s) s.compacting = false;
        return false;
      }

      await input.client.session.summarize({
        path: { id: sessionId },
        query: { directory: input.directory || "" }
      });

      // Wait for compaction with progressive checks
      // Compaction can take several seconds for large contexts
      const maxWait = config.compactionVerifyWaitMs;
      const waitTimes = [2000, 3000, 5000].filter(t => t <= maxWait);
      if (waitTimes.length === 0) waitTimes.push(maxWait);

      for (const waitMs of waitTimes) {
        await new Promise(r => setTimeout(r, waitMs));

        // Check if session is still busy
        const status = await input.client.session.status({});
        const data = status.data as Record<string, { type: string }>;
        const isBusy = data[sessionId]?.type === "busy";

        if (!isBusy) {
          log('compaction successful for session:', sessionId, 'after', waitMs, 'ms wait');
          if (s) {
            s.lastCompactionAt = Date.now();
            s.compacting = false;
            // Reset estimated tokens since context was compacted
            const reduction = Math.floor(preTokens * config.compactReductionFactor); // Configurable reduction factor
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
      }
      return false;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      log('compaction attempt failed:', err.message, 'status:', (e as Record<string, unknown>)?.status);
      const s = sessions.get(sessionId);
      if (s) {
        s.compacting = false;
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

  return { isTokenLimitError, attemptCompact, forceCompact };
}