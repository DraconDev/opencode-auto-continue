import { type PluginConfig } from "./config.js";
import { type SessionState, getTokenCount } from "./session-state.js";
import { formatDuration } from "./shared.js";

export interface TerminalDeps {
  config: Pick<PluginConfig, "terminalTitleEnabled" | "terminalProgressEnabled" | "stallTimeoutMs" | "hardCompactAtTokens" | "proactiveCompactAtTokens">;
  sessions: Map<string, SessionState>;
  log: (message: string, ...args: unknown[]) => void;
}

export function createTerminalModule(deps: TerminalDeps) {
  const { config, sessions, log } = deps;

  // ── Terminal Title (OSC sequences) ────────────────────────────────────

  function formatTokenCount(tokens: number): string {
    if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
    return String(tokens);
  }

  function updateTerminalTitle(sessionId: string) {
    if (!config.terminalTitleEnabled) return;
    const s = sessions.get(sessionId);
    if (!s || s.actionStartedAt === 0) return;

    const now = Date.now();
    const actionDuration = now - s.actionStartedAt;
    const progressAgo = now - s.lastProgressAt;

    let title = `⏱️ ${formatDuration(actionDuration)} | Last: ${formatDuration(progressAgo)} ago`;

    const threshold = config.hardCompactAtTokens || config.proactiveCompactAtTokens;
    const tokenCount = getTokenCount(s);
    if (threshold > 0 && tokenCount >= threshold * 0.5) {
      const tok = formatTokenCount(tokenCount);
      title = tokenCount >= threshold
        ? `⏱️ ${formatDuration(actionDuration)} | ${tok}⚠️ | Last: ${formatDuration(progressAgo)} ago`
        : `⏱️ ${formatDuration(actionDuration)} | ${tok} | Last: ${formatDuration(progressAgo)} ago`;
    }

    try {
      if (process.stdout.isTTY) {
        process.stdout.write(`\x1b]0;${title}\x07`);
        process.stdout.write(`\x1b]2;${title}\x07`);
      }
    } catch (e) {
      log('terminal title write failed:', e);
    }
  }

  function clearTerminalTitle() {
    if (!config.terminalTitleEnabled) return;
    try {
      if (process.stdout.isTTY) {
        process.stdout.write('\x1b]0;opencode\x07');
        process.stdout.write('\x1b]2;opencode\x07');
      }
    } catch (e) {
      log('terminal title clear failed:', e);
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
    } catch (e) {
      log('terminal progress write failed:', e);
    }
  }

  function clearTerminalProgress() {
    if (!config.terminalProgressEnabled) return;
    try {
      if (process.stdout.isTTY) {
        process.stdout.write('\x1b]9;4;0\x07');
      }
    } catch (e) {
      log('terminal progress clear failed:', e);
    }
  }

  return { updateTerminalTitle, clearTerminalTitle, updateTerminalProgress, clearTerminalProgress };
}
