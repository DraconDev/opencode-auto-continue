import { type PluginConfig } from "./config.js";
import { type SessionState } from "./session-state.js";
import { formatDuration } from "./shared.js";
import type { TypedPluginInput } from "./types.js";

export interface TerminalDeps {
  config: Pick<PluginConfig, "terminalTitleEnabled" | "terminalProgressEnabled" | "stallTimeoutMs">;
  sessions: Map<string, SessionState>;
  log: (message: string, ...args: unknown[]) => void;
  input: TypedPluginInput;
}

export function createTerminalModule(deps: TerminalDeps) {
  const { config, sessions, log, input } = deps;

  // ── Terminal Title (OSC sequences) ────────────────────────────────────

  function updateTerminalTitle(sessionId: string) {
    if (!config.terminalTitleEnabled) return;
    const s = sessions.get(sessionId);
    if (!s || s.actionStartedAt === 0) return;

    const now = Date.now();
    const actionDuration = now - s.actionStartedAt;
    const progressAgo = now - s.lastProgressAt;
    const title = `⏱️ ${formatDuration(actionDuration)} | Last: ${formatDuration(progressAgo)} ago`;

    try {
      if (process.stdout.isTTY) {
        process.stdout.write(`\x1b]0;${title}\x07`);
        process.stdout.write(`\x1b]2;${title}\x07`);
      }
    } catch {
      // ignore
    }
  }

  function clearTerminalTitle() {
    if (!config.terminalTitleEnabled) return;
    try {
      if (process.stdout.isTTY) {
        process.stdout.write('\x1b]0;opencode\x07');
        process.stdout.write('\x1b]2;opencode\x07');
      }
    } catch {
      // ignore
    }
  }

  // ── Terminal Progress Bar (OSC 9;4) ───────────────────────────────────

  function updateTerminalProgress(sessionId: string) {
    if (!config.terminalProgressEnabled) return;
    const s = sessions.get(sessionId);
    if (!s || s.actionStartedAt === 0) return;

    const now = Date.now();
    const actionDuration = now - s.actionStartedAt;
    const progressAgo = now - s.lastProgressAt;
    
    // Calculate progress percentage based on stallTimeoutMs
    // 0% = just started, 100% = about to trigger recovery
    const progress = Math.min(Math.floor((progressAgo / config.stallTimeoutMs) * 100), 99);
    
    try {
      if (process.stdout.isTTY) {
        process.stdout.write(`\x1b]9;4;1;${progress}\x07`);
      }
    } catch {
      // ignore
    }
  }

  function clearTerminalProgress() {
    if (!config.terminalProgressEnabled) return;
    try {
      if (process.stdout.isTTY) {
        process.stdout.write('\x1b]9;4;0\x07');
      }
    } catch {
      // ignore
    }
  }

  // ── StatusLine Hook (future-proof) ────────────────────────────────────

  function registerStatusLineHook() {
    try {
      // Check if the plugin system supports statusLine hooks
      const pluginSystem = input as any;
      if (typeof pluginSystem.hook === 'function') {
        pluginSystem.hook("tui.statusLine.variables", async (_input: any, result: any) => {
          // Provide timer variables for each active session
          sessions.forEach((s, sid) => {
            if (s.actionStartedAt > 0) {
              const now = Date.now();
              const actionDuration = now - s.actionStartedAt;
              const progressAgo = now - s.lastProgressAt;
              result.variables[`afr_timer_${sid.slice(0, 8)}`] = formatDuration(actionDuration);
              result.variables[`afr_progress_${sid.slice(0, 8)}`] = formatDuration(progressAgo);
            }
          });
          return result;
        });
        log('statusLine hook registered');
      }
    } catch {
      // Hook not available in this OpenCode version
    }
  }


  return { updateTerminalTitle, clearTerminalTitle, updateTerminalProgress, clearTerminalProgress, registerStatusLineHook };
}
