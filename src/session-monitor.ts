/**
 * Auto-Continue v7.0 - Session Monitor Module
 *
 * Handles:
 * 1. Orphan parent detection - when subagent finishes but parent stays busy
 * 2. Session discovery - periodic polling to find missed sessions
 * 3. Idle session cleanup - prevent memory leaks
 */

import { createSession, type SessionState } from "./session-state.js";
import type { PluginConfig } from "./config.js";
import type { TypedPluginInput } from "./types.js";

export interface SessionMonitorDeps {
  config: PluginConfig;
  sessions: Map<string, SessionState>;
  log: (...args: unknown[]) => void;
  input: TypedPluginInput;
  isDisposed: () => boolean;
  recover: (sessionId: string) => void;
}

export interface SessionMonitor {
  start(): void;
  stop(): void;
  touchSession(sessionId: string): void;
  trackParentChild(parentId: string, childId: string): void;
  getStats(): SessionMonitorStats;
}

export interface SessionMonitorStats {
  totalSessions: number;
  busySessions: number;
  idleSessions: number;
  orphanRecoveries: number;
  discoveredSessions: number;
  cleanedUpSessions: number;
}

/**
 * Create the session monitor module.
 */
export function createSessionMonitor(deps: SessionMonitorDeps): SessionMonitor {
  const { config, sessions, log, input, isDisposed, recover } = deps;

  let discoveryTimer: ReturnType<typeof setInterval> | null = null;
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;
  let orphanCheckTimer: ReturnType<typeof setInterval> | null = null;
  let previousBusyCount = 0;
  let orphanRecoveryCount = 0;
  let discoveredCount = 0;
  let cleanedUpCount = 0;

  // Track parent-child relationships
  const parentChildMap = new Map<string, Set<string>>();
  const childParentMap = new Map<string, string>();

  function scheduleDiscoveredRecovery(sessionId: string, state: SessionState): void {
    // FIX 4: Increment generation to invalidate stale timers
    state.timerGeneration++;
    const currentGeneration = state.timerGeneration;
    // FIX 9: Use shorter initial timeout for discovered sessions that may already be stuck
    const timeoutMs = Math.min(config.stallTimeoutMs, 30000);
    const timer = setTimeout(() => {
      const current = sessions.get(sessionId);
      if (current && current.timer === timer && current.timerGeneration === currentGeneration) {
        current.timer = null;
        recover(sessionId);
      } else {
        log('[SessionMonitor] stale discovered recovery timer ignored:', sessionId);
      }
    }, timeoutMs);
    (timer as any).unref?.();
    state.timer = timer;
  }

  function getBusyCount(): number {
    let count = 0;
    for (const [_, s] of sessions) {
      if (s.lastKnownStatus === 'busy' || s.lastKnownStatus === 'retry' || s.aborting || s.compacting) {
        count++;
      }
    }
    return count;
  }

  function getIdleSessions(): string[] {
    const idle: string[] = [];
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (s.lastKnownStatus !== 'busy' && s.lastKnownStatus !== 'retry' && !s.aborting && !s.compacting) {
        idle.push(id);
      }
    }
    return idle;
  }

  function hasPendingWork(s: SessionState): boolean {
    return (
      s.timer != null ||
      s.nudgeTimer != null ||
      s.reviewDebounceTimer != null ||
      s.needsContinue ||
      s.aborting ||
      s.compacting
    );
  }

  /**
   * Check for orphan parent sessions.
   * When busyCount drops from >1 to 1, a subagent may have finished
   * but the parent is still stuck as busy.
   * 
   * FIX 2: Also detect single busy sessions that have been stuck for too long.
   */
  function checkOrphanParents(): void {
    if (isDisposed()) return;

    const currentBusyCount = getBusyCount();

    // Detect transition: multiple busy → single busy (potential orphan)
    if (previousBusyCount > 1 && currentBusyCount === 1) {
      log('[SessionMonitor] busyCount dropped from', previousBusyCount, 'to 1, checking for orphan parent');

      // Find the remaining busy session
      for (const [id, s] of sessions) {
        if (s.lastKnownStatus === 'busy' || s.lastKnownStatus === 'retry' || s.aborting || s.compacting) {
          // Check if this session has children that recently finished
          const children = parentChildMap.get(id);
          if (children && children.size > 0) {
            // This is a parent session - check if it's been stuck too long
            const timeSinceProgress = Date.now() - s.lastProgressAt;
            if (timeSinceProgress > config.subagentWaitMs) {
              log('[SessionMonitor] orphan parent detected:', id, 'stuck for', timeSinceProgress, 'ms after subagent completion');
              orphanRecoveryCount++;
              recover(id);
            } else {
              // Schedule another check after the wait period
              setTimeout(() => {
                if (!isDisposed()) {
                  const session = sessions.get(id);
                  if (session && (session.lastKnownStatus === 'busy' || session.lastKnownStatus === 'retry' || session.aborting || session.compacting)) {
                    const elapsed = Date.now() - session.lastProgressAt;
                    if (elapsed > config.subagentWaitMs) {
                      log('[SessionMonitor] orphan parent confirmed:', id, 'after delayed check');
                      orphanRecoveryCount++;
                      recover(id);
                    }
                  }
                }
              }, config.subagentWaitMs - timeSinceProgress + 1000);
            }
          }
          break;
        }
      }
    }

    // FIX 2: Also check for single busy sessions stuck for too long
    // (catches orphans even without parent-child tracking, and single-session stalls)
    // FIX 5: Use stallTimeoutMs instead of subagentWaitMs * 2 (30s is too aggressive vs 180s stallTimeoutMs)
    if (currentBusyCount >= 1) {
      for (const [id, s] of sessions) {
        if (s.lastKnownStatus === 'busy' || s.lastKnownStatus === 'retry' || s.aborting || s.compacting) {
          const timeSinceProgress = Date.now() - s.lastProgressAt;
          const stuckThreshold = config.stallTimeoutMs;
          if (timeSinceProgress > stuckThreshold && !s.userCancelled && !s.aborting && !s.planning) {
            log('[SessionMonitor] single busy session stuck for too long:', id, 'stuck for', timeSinceProgress, 'ms');
            orphanRecoveryCount++;
            recover(id);
          }
          // Don't break — check ALL busy sessions, not just the first
        }
      }
    }

    previousBusyCount = currentBusyCount;
  }

  /**
   * Discover sessions via session.list() API.
   * Catches sessions missed by event tracking.
   */
  async function discoverSessions(): Promise<void> {
    if (isDisposed()) return;

    try {
      const result = await input.client.session.list();
      const sessionList = Array.isArray(result.data) ? result.data : [];
      let statusData: Record<string, { type: string }> = {};

      try {
        const statusResult = await (input.client.session as any).status?.({});
        statusData = (statusResult?.data || {}) as Record<string, { type: string }>;
      } catch (e) {
        log('[SessionMonitor] status check during discovery failed:', e);
      }

      for (const session of sessionList) {
        const id = session.id;
        if (!id) continue;

        if (!sessions.has(id)) {
          const statusType =
            statusData[id]?.type ||
            (session as any).status?.type ||
            (session as any).type ||
            null;

          if (statusType && statusType !== "busy" && statusType !== "retry") {
            continue;
          }

          // New session discovered - create minimal session entry
          log('[SessionMonitor] discovered missed session:', id);
          discoveredCount++;

          // Create minimal session so recovery knows about it
          const state = createSession();
          state.actionStartedAt = Date.now();

          // FIX 10: Only arm recovery on busy/retry status, skip on null/unknown
          if (statusType === "busy" || statusType === "retry") {
            scheduleDiscoveredRecovery(id, state);
          } else if (statusType === null) {
            log('[SessionMonitor] discovered session with unknown status, not arming recovery:', id);
          }

          sessions.set(id, state);
        }
      }

      log('[SessionMonitor] discovery complete, tracked:', sessions.size, 'sessions, discovered:', discoveredCount);
    } catch (e) {
      log('[SessionMonitor] session discovery failed:', e);
    }
  }

  /**
   * Clean up idle sessions to prevent memory leaks.
   */
  function cleanupIdleSessions(): void {
    if (isDisposed()) return;

    const now = Date.now();
    const toDelete: string[] = [];

    for (const [id, s] of sessions) {
      // Clean up if idle for too long
      if (!hasPendingWork(s)) {
        const idleTime = now - s.lastProgressAt;
        if (idleTime > config.idleSessionTimeoutMs) {
          toDelete.push(id);
        }
      }
    }

    // Enforce max session limit
    if (sessions.size > config.maxSessions) {
      // Sort by last activity, oldest first
      const sorted = Array.from(sessions.entries())
        .filter(([id]) => !toDelete.includes(id))
        .filter(([, s]) => !hasPendingWork(s))
        .sort((a, b) => a[1].lastProgressAt - b[1].lastProgressAt);

      const toRemove = sessions.size - config.maxSessions;
      for (let i = 0; i < toRemove && i < sorted.length; i++) {
        const id = sorted[i][0];
        if (!toDelete.includes(id)) {
          toDelete.push(id);
        }
      }
    }

    for (const id of toDelete) {
      const s = sessions.get(id);
      if (s) {
        // FIX 2: Clear dangling timers before deleting session
        if (s.timer) {
          clearTimeout(s.timer);
          s.timer = null;
        }
        if (s.nudgeTimer) {
          clearTimeout(s.nudgeTimer);
          s.nudgeTimer = null;
        }
        if (s.reviewDebounceTimer) {
          clearTimeout(s.reviewDebounceTimer);
          s.reviewDebounceTimer = null;
        }
      }
      sessions.delete(id);
      parentChildMap.delete(id);
      childParentMap.delete(id);
      cleanedUpCount++;
      log('[SessionMonitor] cleaned up idle session:', id);
    }
  }

  function touchSession(sessionId: string): void {
    const s = sessions.get(sessionId);
    if (s) {
      s.lastProgressAt = Date.now();
    }
  }

  function trackParentChild(parentId: string, childId: string): void {
    if (!parentChildMap.has(parentId)) {
      parentChildMap.set(parentId, new Set());
    }
    parentChildMap.get(parentId)!.add(childId);
    childParentMap.set(childId, parentId);
    log('[SessionMonitor] tracked parent-child:', parentId, '→', childId);
  }

  function start(): void {
    if (isDisposed()) return;
    if (orphanCheckTimer || discoveryTimer || cleanupTimer) return; // Already started

    if (config.sessionMonitorEnabled === false) {
      log('[SessionMonitor] disabled by config');
      return;
    }

    // Orphan parent check every 5 seconds
    if (config.orphanParentDetection !== false) {
      orphanCheckTimer = setInterval(checkOrphanParents, 5000);
    }

    // Session discovery every configured interval
    if (config.sessionDiscovery !== false && config.sessionDiscoveryIntervalMs > 0) {
      discoveryTimer = setInterval(() => {
        discoverSessions().catch(e => log('[SessionMonitor] discovery error:', e));
      }, config.sessionDiscoveryIntervalMs);
    }

    // Idle cleanup every 30 seconds
    if (config.idleCleanup !== false) {
      cleanupTimer = setInterval(cleanupIdleSessions, 30000);
    }

    if (!orphanCheckTimer && !discoveryTimer && !cleanupTimer) {
      log('[SessionMonitor] all monitor features disabled by config');
      return;
    }

    log(`[SessionMonitor] started, orphanCheck: ${orphanCheckTimer ? '5s' : 'off'}, discovery: ${discoveryTimer ? `${config.sessionDiscoveryIntervalMs}ms` : 'off'}, cleanup: ${cleanupTimer ? '30s' : 'off'}`);
  }

  function stop(): void {
    if (orphanCheckTimer) {
      clearInterval(orphanCheckTimer);
      orphanCheckTimer = null;
    }
    if (discoveryTimer) {
      clearInterval(discoveryTimer);
      discoveryTimer = null;
    }
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
    log('[SessionMonitor] stopped');
  }

  function getStats(): SessionMonitorStats {
    return {
      totalSessions: sessions.size,
      busySessions: getBusyCount(),
      idleSessions: getIdleSessions().length,
      orphanRecoveries: orphanRecoveryCount,
      discoveredSessions: discoveredCount,
      cleanedUpSessions: cleanedUpCount,
    };
  }

  return {
    start,
    stop,
    touchSession,
    trackParentChild,
    getStats,
  };
}
