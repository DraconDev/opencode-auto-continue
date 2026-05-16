import { existsSync, writeFileSync, renameSync, mkdirSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import type { PluginConfig } from "./config.js";
import type { SessionState } from "./session-state.js";
import { getTokenCount } from "./session-state.js";
import { formatDuration, getCompactionThreshold } from "./shared.js";

export interface StatusFileDeps {
  config: PluginConfig;
  sessions: Map<string, SessionState>;
  log: (...args: unknown[]) => void;
}

function ensureLogDir(logDir: string) {
  try {
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
  } catch (e) {
    log('ensureLogDir failed:', e);
  }
}

let _pluginVersion: string | null = null;
function getPluginVersion(): string {
  if (_pluginVersion !== null) return _pluginVersion;
  try {
    const pkgPath = join(process.env.HOME || "/tmp", ".config", "opencode", "plugins", "node_modules", "opencode-auto-continue", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    _pluginVersion = pkg.version as string;
  } catch {
    _pluginVersion = "unknown";
  }
  return _pluginVersion!;
}

export function createStatusFileModule(deps: StatusFileDeps) {
  const { config, sessions, log } = deps;
  const logDir = join(process.env.HOME || "/tmp", ".opencode", "logs");
  const defaultStatusFile = join(logDir, "auto-force-resume.status");
  
  // FIX 13: Debounce status file writes - max once per 500ms per session
  const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();
  const DEBOUNCE_MS = 500;
  let writeInProgress = false;
  let writeQueue: string[] = [];

  function writeStatusFile(sessionId: string) {
    if (!config.statusFileEnabled) return;
    
    // FIX 13: Debounce writes to prevent event loop blocking
    const existing = pendingWrites.get(sessionId);
    if (existing) {
      clearTimeout(existing);
    }
    
    const timeout = setTimeout(() => {
      pendingWrites.delete(sessionId);
      if (writeInProgress) {
        writeQueue.push(sessionId);
      } else {
        doWriteStatusFile(sessionId);
      }
    }, DEBOUNCE_MS);
    pendingWrites.set(sessionId, timeout);
  }

  function doWriteStatusFile(sessionId: string) {
    writeInProgress = true;
    try {
      ensureLogDir(logDir);
      const s = sessions.get(sessionId);
      if (!s) return;

      const now = Date.now();
      const elapsed = now - s.sessionCreatedAt;
      const actionDuration = s.actionStartedAt > 0 ? now - s.actionStartedAt : 0;
      const lastProgressAgo = now - s.lastProgressAt;
      const nextRetryIn = s.attempts >= config.maxRecoveries && s.backoffAttempts > 0
        ? Math.min(config.stallTimeoutMs * Math.pow(2, s.backoffAttempts), config.maxBackoffMs)
        : 0;

      const avgRecoveryTime = s.recoverySuccessful > 0
        ? Math.round(s.totalRecoveryTimeMs / s.recoverySuccessful)
        : 0;
      const recoveryRate = s.attempts > 0
        ? Math.round((s.recoverySuccessful / s.attempts) * 100)
        : 0;

      const currentStatus = {
        timestamp: new Date().toISOString(),
        status: s.aborting ? "recovering" : (s.compacting ? "compacting" : (s.planning ? "planning" : "active")),
        actionDuration: actionDuration > 0 ? formatDuration(actionDuration) : "idle",
        progressAgo: formatDuration(lastProgressAgo),
      };
      s.statusHistory.push(currentStatus);
      if (s.statusHistory.length > config.maxStatusHistory) {
        s.statusHistory.shift();
      }

      let histogram = null;
      if (config.recoveryHistogramEnabled && s.recoveryTimes.length > 0) {
        const sorted = [...s.recoveryTimes].sort((a, b) => a - b);
        const min = sorted[0];
        const max = sorted[sorted.length - 1];
        const median = sorted.length % 2 === 0
          ? (sorted[Math.floor(sorted.length / 2) - 1] + sorted[Math.floor(sorted.length / 2)]) / 2
          : sorted[Math.floor(sorted.length / 2)];
        histogram = {
          min: formatDuration(min),
          max: formatDuration(max),
          median: formatDuration(median),
          samples: s.recoveryTimes.length,
        };
      }

      let topStallPatterns = null;
      if (config.stallPatternDetection && Object.keys(s.stallPatterns).length > 0) {
        topStallPatterns = Object.entries(s.stallPatterns)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([type, count]) => ({ type, count }));
      }

      const data = {
        version: getPluginVersion(),
        timestamp: new Date().toISOString(),

        sessions: {
          [sessionId]: {
            elapsed: formatDuration(elapsed),
            status: currentStatus.status,
            recovery: {
              attempts: s.attempts,
              successful: s.recoverySuccessful,
              failed: s.recoveryFailed,
              lastAttempt: s.lastRecoveryTime > 0 ? new Date(s.lastRecoveryTime).toISOString() : null,
              lastSuccess: s.lastRecoverySuccess > 0 ? new Date(s.lastRecoverySuccess).toISOString() : null,
              inBackoff: s.attempts >= config.maxRecoveries,
              backoffAttempts: s.backoffAttempts,
              nextRetryIn: nextRetryIn > 0 ? formatDuration(nextRetryIn) : null,
              avgRecoveryTime: avgRecoveryTime > 0 ? formatDuration(avgRecoveryTime) : null,
              recoveryRate: `${recoveryRate}%`,
              histogram,
            },
            stall: {
              detections: s.stallDetections,
              lastDetectionAt: s.lastRecoveryTime > 0 ? new Date(s.lastRecoveryTime).toISOString() : null,
              lastPartType: s.lastStallPartType || null,
              patterns: topStallPatterns,
            },
            compaction: {
              proactiveTriggers: s.proactiveCompactCount,
              hardTriggers: s.hardCompactCount,
              tokenLimitTriggers: s.tokenLimitHits,
              successful: s.lastCompactionAt > 0 ? 1 : 0,
              lastCompactAt: s.lastCompactionAt > 0 ? new Date(s.lastCompactionAt).toISOString() : null,
              lastHardCompactAt: s.lastHardCompactionAt > 0 ? new Date(s.lastHardCompactionAt).toISOString() : null,
              estimatedTokens: s.estimatedTokens,
              realTokens: s.realTokens,
              effectiveTokens: getTokenCount(s),
              threshold: getCompactionThreshold(config),
              tokenPressure: config.hardCompactAtTokens > 0
                ? (getTokenCount(s) >= config.hardCompactAtTokens ? "high" : getTokenCount(s) >= config.hardCompactAtTokens * 0.5 ? "med" : "low")
                : "unknown",
            },
            timer: {
              actionDuration: actionDuration > 0 ? formatDuration(actionDuration) : "idle",
              lastProgressAgo: formatDuration(lastProgressAgo),
            },
            nudge: {
              sent: s.lastNudgeAt > 0 ? 1 : 0,
              lastNudgeAt: s.lastNudgeAt > 0 ? new Date(s.lastNudgeAt).toISOString() : null,
            },
            todos: {
              hasOpenTodos: s.hasOpenTodos,
            },
            autoSubmits: s.autoSubmitCount,
            userCancelled: s.userCancelled,
            planning: s.planning,
            compacting: s.compacting,
            sessionCreatedAt: new Date(s.sessionCreatedAt).toISOString(),
            history: s.statusHistory,
          },
        },
      };

      const statusFile = config.statusFilePath || defaultStatusFile;

      if (config.statusFileRotate > 0 && existsSync(statusFile)) {
        try {
          const maxRotated = statusFile + `.${config.statusFileRotate}`;
          if (existsSync(maxRotated)) {
            unlinkSync(maxRotated);
          }
          for (let i = config.statusFileRotate - 1; i >= 1; i--) {
            const oldFile = statusFile + `.${i}`;
            const newFile = statusFile + `.${i + 1}`;
            if (existsSync(oldFile)) {
              renameSync(oldFile, newFile);
            }
          }
          renameSync(statusFile, statusFile + ".1");
        } catch (e) {
          log('status file rotation error:', e);
        }
      }

      const tmpFile = statusFile + ".tmp";
      writeFileSync(tmpFile, JSON.stringify(data, null, 2) + "\n");
      renameSync(tmpFile, statusFile);
    } catch (e) {
      log('status file write failed:', e);
    } finally {
      writeInProgress = false;
      // Drain queued writes — only process the latest session
      if (writeQueue.length > 0) {
        const next = writeQueue.pop()!;
        writeQueue.length = 0; // drop older queued writes
        doWriteStatusFile(next);
      }
    }
  }

  function clearPendingWrites(): void {
    for (const [id, timeout] of pendingWrites) {
      clearTimeout(timeout);
    }
    pendingWrites.clear();
  }

  return { writeStatusFile, clearPendingWrites };
}