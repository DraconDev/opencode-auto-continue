import { existsSync, writeFileSync, renameSync, appendFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import type { PluginConfig } from "./config.js";
import type { SessionState } from "./session-state.js";
import { formatDuration, getModelContextLimit, getCompactionThreshold } from "./shared.js";

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
  } catch {
    // ignore
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

  function writeStatusFile(sessionId: string) {
    if (!config.statusFileEnabled) return;
    
    // FIX 13: Debounce writes to prevent event loop blocking
    const existing = pendingWrites.get(sessionId);
    if (existing) {
      clearTimeout(existing);
    }
    
    const timeout = setTimeout(() => {
      pendingWrites.delete(sessionId);
      doWriteStatusFile(sessionId);
    }, DEBOUNCE_MS);
    pendingWrites.set(sessionId, timeout);
  }

  function doWriteStatusFile(sessionId: string) {
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
        dcp: {
          detected: config.dcpDetected,
          version: config.dcpVersion || null,
        },
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
              proactiveTriggers: 0,
              tokenLimitTriggers: s.tokenLimitHits,
              successful: s.lastCompactionAt > 0 ? 1 : 0,
              lastCompactAt: s.lastCompactionAt > 0 ? new Date(s.lastCompactionAt).toISOString() : null,
              estimatedTokens: s.estimatedTokens,
              threshold: getCompactionThreshold(
                getModelContextLimit(join(process.env.HOME || "/tmp", ".config", "opencode", "opencode.json")),
                config
              ),
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
              advisory: s.lastAdvisoryAdvice ? {
                action: s.lastAdvisoryAdvice.action,
                confidence: s.lastAdvisoryAdvice.confidence,
                reasoning: s.lastAdvisoryAdvice.reasoning,
                stallPattern: s.lastAdvisoryAdvice.stallPattern || null,
                customPrompt: s.lastAdvisoryAdvice.customPrompt || null,
                contextSummary: s.lastAdvisoryAdvice.contextSummary || null,
                checkedAt: new Date().toISOString(),
              } : null,
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
          const rotateExt = `.${config.statusFileRotate}`;
          const rotateFile = statusFile + rotateExt;
          if (existsSync(rotateFile)) {
            for (let i = config.statusFileRotate - 1; i >= 1; i--) {
              const oldFile = statusFile + `.${i}`;
              const newFile = statusFile + `.${i + 1}`;
              if (existsSync(oldFile)) {
                renameSync(oldFile, newFile);
              }
            }
          }
          renameSync(statusFile, statusFile + ".1");
        } catch {
          // ignore rotation errors
        }
      }

      const tmpFile = statusFile + ".tmp";
      writeFileSync(tmpFile, JSON.stringify(data, null, 2) + "\n");
      renameSync(tmpFile, statusFile);
    } catch {
      // Silently ignore file system errors
    }
  }

  return { writeStatusFile };
}