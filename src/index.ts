import type { Plugin } from "@opencode-ai/plugin";
import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import {
  type SessionState,
  type Todo,
  createSession,
  updateProgress,
} from "./session-state.js";
import {
  type PluginConfig,
  DEFAULT_CONFIG,
  validateConfig,
} from "./config.js";
import {
  isPlanContent,
  estimateTokens,
  parseTokensFromError,
  safeHook,
  detectDCP,
  getDCPVersion,
} from "./shared.js";
import { createTerminalModule } from "./terminal.js";
import { createNudgeModule } from "./nudge.js";
import { createStatusFileModule } from "./status-file.js";
import { createRecoveryModule } from "./recovery.js";
import { createCompactionModule } from "./compaction.js";
import { createReviewModule } from "./review.js";
import { createAIAdvisor } from "./ai-advisor.js";
import { createSessionMonitor } from "./session-monitor.js";
import { getPlanPath, markPlanItemComplete } from "./plan.js";
import { createSessionManager } from "./session-manager.js";
import { createEventRouter } from "./event-router.js";

export const AutoForceResumePlugin: Plugin = async (input, options) => {
  let config: PluginConfig = {
    ...DEFAULT_CONFIG,
    ...(typeof options === "object" && options !== null ? options as Partial<PluginConfig> : {}),
  };
  
  // Detect DCP and auto-adjust compaction settings
  const hasDCP = detectDCP();
  if (hasDCP) {
    config.dcpDetected = true;
    config.dcpVersion = getDCPVersion();
    if (config.autoCompact) {
      config.autoCompact = false;
      // We'll log this after log function is defined
    }
  }
  
  config = validateConfig(config);

  const sessions = new Map<string, SessionState>();
  let isDisposed = false;

  const { getSession, clearTimer, resetSession } = createSessionManager(sessions);

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
  
  // Log DCP detection after log function is available
  if (config.dcpDetected) {
    log('DCP (Dynamic Context Pruning) detected — proactive compaction disabled, DCP handles context optimization');
  }

  const terminal = createTerminalModule({ config, sessions, log, input });
  const aiAdvisor = createAIAdvisor({ config, log, input });
  const nudge = createNudgeModule({ config, sessions, log, isDisposed: () => isDisposed, input, aiAdvisor });

  const { writeStatusFile } = createStatusFileModule({ config, sessions, log });

  const { recover } = createRecoveryModule({ config, sessions, log, input, isDisposed: () => isDisposed, writeStatusFile, cancelNudge: nudge.cancelNudge, aiAdvisor });

  const compaction = createCompactionModule({ config, sessions, log, input });

  const review = createReviewModule({ config, sessions, log, input, isDisposed: () => isDisposed, writeStatusFile, isTokenLimitError: compaction.isTokenLimitError, forceCompact: compaction.forceCompact });

  const sessionMonitor = createSessionMonitor({ config, sessions, log, input, isDisposed: () => isDisposed, recover });
  sessionMonitor.start();

  terminal.registerStatusLineHook();

  const eventRouter = createEventRouter({
    config, sessions, log, getSession, clearTimer, resetSession,
    terminal, nudge, review, recover, compaction, sessionMonitor,
    writeStatusFile, updateProgress, createSession
  });

  return {
    event: async ({ event }: { event: any }) => {
      await eventRouter.handleEvent(event);
    },
    "experimental.compaction.autocontinue": async (_ctx: any, output: { enabled: boolean }) => {
      // Disable OpenCode's generic synthetic "continue" message that fires after compaction.
      // The plugin sends its own todo-aware continue message via review.sendContinue().
      output.enabled = false;
    },
    dispose() {
      isDisposed = true;
      log('disposing plugin');
      for (const [sid] of sessions) {
        clearTimer(sid);
        nudge.cancelNudge(sid);
      }
      terminal.clearTerminalTitle();
      terminal.clearTerminalProgress();
      sessionMonitor.stop();
    },
  };
};
