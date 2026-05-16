/**
 * Auto-Continue v7.0 - Session Monitor Module
 *
 * Handles:
 * 1. Orphan parent detection - when subagent finishes but parent stays busy
 *
 * Session discovery and idle cleanup were removed — they created a
 * cleanup→rediscover loop that spawned fresh SessionState entries,
 * bypassing review cooldown and causing review spam / credit burn.
 * OpenCode already tracks sessions in its DB; our runtime Map only
 * needs entries for sessions we learned about via events.
 */

import type { SessionState } from "./session-state.js";
import type { PluginConfig } from "./config.js";
import type { StopConditionResult } from "./stop-conditions.js";

export interface SessionMonitorDeps {
  config: PluginConfig;
  sessions: Map<string, SessionState>;
  log: (...args: unknown[]) => void;
  isDisposed: () => boolean;
  recover: (sessionId: string) => Promise<void>;
  checkStopConditions?: (sessionId: string) => StopConditionResult;
}

export interface SessionMonitor {
  start(): void;
  stop(): void;
  touchSession(sessionId: string): void;
  trackParentChild(parentId: string, childId: string): void;
  cleanupSession(sessionId: string): void;
  getStats(): SessionMonitorStats;
}

export interface SessionMonitorStats {
  totalSessions: number;
  busySessions: number;
  idleSessions: number;
  orphanRecoveries: number;
}

/**
 * Create the session monitor module. Periodically checks for orphaned
 * sessions (sub-agents whose parent session has ended), idle sessions
 * that have timed out, and session count limits. Handles automatic
 * cleanup and recovery for detected orphans.
 */
export function createSessionMonitor(deps: SessionMonitorDeps): SessionMonitor {
  const { config, sessions, log, isDisposed, recover } = deps;

  let orphanCheckTimer: ReturnType<typeof setInterval> | null = null;
  let previousBusyCount = 0;
  let orphanRecoveryCount = 0;
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  const parentChildMap = new Map<string, Set<string>>();
  const childParentMap = new Map<string, string>();

  function getBusyCount(): number {
    let count = 0;
    for (const [, s] of sessions) {
      if (s.lastKnownStatus === 'busy' || s.lastKnownStatus === 'retry' || s.aborting || s.compacting) {
        count++;
      }
    }
    return count;
  }

  function getIdleSessions(): string[] {
    const idle: string[] = [];
    for (const [id, s] of sessions) {
      if (s.lastKnownStatus !== 'busy' && s.lastKnownStatus !== 'retry' && !s.aborting && !s.compacting) {
        idle.push(id);
      }
    }
    return idle;
  }

  function checkOrphanParents(): void {
    if (isDisposed()) return;

    const currentBusyCount = getBusyCount();

    if (previousBusyCount > 1 && currentBusyCount === 1) {
      log('[SessionMonitor] busyCount dropped from', previousBusyCount, 'to 1, checking for orphan parent');

      for (const [id, s] of sessions) {
        if (s.lastKnownStatus === 'busy' || s.lastKnownStatus === 'retry' || s.aborting || s.compacting) {
          const children = parentChildMap.get(id);
          if (children && children.size > 0) {
            const timeSinceProgress = Date.now() - s.lastProgressAt;
            if (timeSinceProgress > config.subagentWaitMs) {
              log('[SessionMonitor] orphan parent detected:', id, 'stuck for', timeSinceProgress, 'ms after subagent completion');
              if (deps.checkStopConditions) {
                const stop = deps.checkStopConditions(id);
                if (stop.shouldStop) {
                  log('[SessionMonitor] session stopped, skipping orphan recovery:', stop.reason);
                  break;
                }
              }
              orphanRecoveryCount++;
              recover(id).catch((e: unknown) => log('[SessionMonitor] orphan recovery failed:', e));
            } else {
              const delay = config.subagentWaitMs - timeSinceProgress + 1000;
              const timer = setTimeout(() => {
                pendingTimers.delete(timer);
                if (!isDisposed()) {
                  const session = sessions.get(id);
                  if (session && (session.lastKnownStatus === 'busy' || session.lastKnownStatus === 'retry' || session.aborting || session.compacting)) {
                    const elapsed = Date.now() - session.lastProgressAt;
                    if (elapsed > config.subagentWaitMs) {
                      log('[SessionMonitor] orphan parent confirmed:', id, 'after delayed check');
                      if (deps.checkStopConditions) {
                        const stop = deps.checkStopConditions(id);
                        if (stop.shouldStop) {
                          log('[SessionMonitor] session stopped, skipping delayed orphan recovery:', stop.reason);
                          return;
                        }
                      }
                      orphanRecoveryCount++;
                      recover(id).catch((e: unknown) => log('[SessionMonitor] delayed orphan recovery failed:', e));
                    }
                  }
                }
              }, delay);
              if (timer.unref) timer.unref();
              pendingTimers.add(timer);
            }
          }
          break;
        }
      }
    }

    if (currentBusyCount >= 1) {
      for (const [id, s] of sessions) {
        if (s.lastKnownStatus === 'busy' || s.lastKnownStatus === 'retry' || s.aborting || s.compacting) {
          if (s.aborting) continue;
          const timeSinceProgress = Date.now() - s.lastProgressAt;
          const stuckThreshold = config.stallTimeoutMs;
          if (timeSinceProgress > stuckThreshold) {
            log('[SessionMonitor] single busy session stuck for too long:', id, 'stuck for', timeSinceProgress, 'ms');
            if (deps.checkStopConditions) {
              const stop = deps.checkStopConditions(id);
              if (stop.shouldStop) {
                log('[SessionMonitor] session stopped, skipping stuck session recovery:', stop.reason);
                continue;
              }
            }
            orphanRecoveryCount++;
            recover(id).catch((e: unknown) => log('[SessionMonitor] stuck session recovery failed:', e));
          }
        }
      }
    }

    previousBusyCount = currentBusyCount;
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
    if (orphanCheckTimer) return;

    if (config.sessionMonitorEnabled === false) {
      log('[SessionMonitor] disabled by config');
      return;
    }

    if (config.orphanParentDetection !== false) {
      orphanCheckTimer = setInterval(checkOrphanParents, 5000);
      if (orphanCheckTimer.unref) orphanCheckTimer.unref();
    }

    if (!orphanCheckTimer) {
      log('[SessionMonitor] all monitor features disabled by config');
      return;
    }

    log('[SessionMonitor] started, orphanCheck: 5s');
  }

  function stop(): void {
    if (orphanCheckTimer) {
      clearInterval(orphanCheckTimer);
      orphanCheckTimer = null;
    }
    for (const timer of pendingTimers) {
      clearTimeout(timer);
    }
    pendingTimers.clear();
    log('[SessionMonitor] stopped');
  }

  function cleanupSession(sessionId: string): void {
    const children = parentChildMap.get(sessionId);
    if (children) {
      for (const childId of children) {
        childParentMap.delete(childId);
      }
      parentChildMap.delete(sessionId);
    }
    if (childParentMap.has(sessionId)) {
      const parentId = childParentMap.get(sessionId)!;
      const siblings = parentChildMap.get(parentId);
      if (siblings) {
        siblings.delete(sessionId);
        if (siblings.size === 0) parentChildMap.delete(parentId);
      }
      childParentMap.delete(sessionId);
    }
  }

  function getStats(): SessionMonitorStats {
    return {
      totalSessions: sessions.size,
      busySessions: getBusyCount(),
      idleSessions: getIdleSessions().length,
      orphanRecoveries: orphanRecoveryCount,
    };
  }

  return {
    start,
    stop,
    touchSession,
    trackParentChild,
    cleanupSession,
    getStats,
  };
}
