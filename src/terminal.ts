import { type PluginConfig, type SessionState, formatDuration } from "./shared.js";

export interface TerminalDeps {
  config: Pick<PluginConfig, "terminalTitleEnabled" | "terminalProgressEnabled" | "stallTimeoutMs">;
  sessions: Map<string, SessionState>;
  log: (message: string, ...args: unknown[]) => void;
}

export function createTerminalModule(deps: TerminalDeps) {
  const { config, sessions, log } = deps;

  function updateTerminalTitle(sessionId: string) {
    if (!config.terminalTitleEnabled) return;
    const s = sessions.get(sessionId);
    if (!s || s.actionStartedAt === 0) return;

    const now = Date.now();
    const actionDuration = now - s.actionStartedAt;
    const progressAgo = now - s.lastProgressAt;
    const title = `⏱️ ${formatDuration(actionDuration)} | Last: ${formatDuration(progressAgo)} ago`;

    try {
      process.stdout.write(`\x1b]0;${title}\x07`);
      process.stdout.write(`\x1b]2;${title}\x07`);
    } catch {
      // ignore
    }
  }

  function clearTerminalTitle() {
    if (!config.terminalTitleEnabled) return;
    try {
      process.stdout.write("\x1b]0;opencode\x07");
      process.stdout.write("\x1b]2;opencode\x07");
    } catch {
      // ignore
    }
  }

  function updateTerminalProgress(sessionId: string) {
    if (!config.terminalProgressEnabled) return;
    const s = sessions.get(sessionId);
    if (!s || s.actionStartedAt === 0) return;

    const now = Date.now();
    const progressAgo = now - s.lastProgressAt;
    const progress = Math.min(Math.floor((progressAgo / config.stallTimeoutMs) * 100), 99);

    try {
      process.stdout.write(`\x1b]9;4;1;${progress}\x07`);
    } catch {
      // ignore
    }
  }

  function clearTerminalProgress() {
    if (!config.terminalProgressEnabled) return;
    try {
      process.stdout.write("\x1b]9;4;0\x07");
    } catch {
      // ignore
    }
  }

  function registerStatusLineHook(input: unknown) {
    try {
      const pluginSystem = input as { hook?: (name: string, fn: (input: unknown, result: { variables: Record<string, string> }) => unknown) => void };
      if (typeof pluginSystem.hook === "function") {
        pluginSystem.hook("tui.statusLine.variables", (_input: unknown, result: { variables: Record<string, string> }) => {
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
        log("statusLine hook registered");
      }
    } catch {
      // Hook not available in this OpenCode version
    }
  }

  return { updateTerminalTitle, clearTerminalTitle, updateTerminalProgress, clearTerminalProgress, registerStatusLineHook };
}