import { type PluginConfig, type SessionState, formatDuration } from "./shared.js";

export interface TerminalDeps {
  config: Pick<PluginConfig, "terminalTitleEnabled" | "terminalProgressEnabled" | "stallTimeoutMs">;
  sessions: Map<string, SessionState>;
  log: (message: string, ...args: unknown[]) => void;
}

export function createTerminalModule(deps: TerminalDeps) {
  const { config, sessions, log } = deps;

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
      // OSC 0: set icon name and window title
      process.stdout.write(`\x1b]0;${title}\x07`);
      // OSC 2: set window title (fallback for some terminals)
      process.stdout.write(`\x1b]2;${title}\x07`);
    } catch {
      // ignore
    }
  }

  function clearTerminalTitle() {
    if (!config.terminalTitleEnabled) return;
    try {
      process.stdout.write('\x1b]0;opencode\x07');
      process.stdout.write('\x1b]2;opencode\x07');
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
      // OSC 9;4;1;p - set progress (mode 1 = normal, p = percentage 0-100)
      process.stdout.write(`\x1b]9;4;1;${progress}\x07`);
    } catch {
      // ignore
    }
  }

  function clearTerminalProgress() {
    if (!config.terminalProgressEnabled) return;
    try {
      // OSC 9;4;0 - clear progress
      process.stdout.write('\x1b]9;4;0\x07');
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
