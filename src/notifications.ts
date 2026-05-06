import { type PluginConfig, type SessionState, formatDuration } from "./shared.js";
import type { TypedPluginInput } from "./types.js";

export interface NotificationDeps {
  config: Pick<PluginConfig, "timerToastEnabled" | "timerToastIntervalMs">;
  sessions: Map<string, SessionState>;
  log: (message: string, ...args: unknown[]) => void;
  isDisposed: boolean;
  input: TypedPluginInput;
}

export function createNotificationModule(deps: NotificationDeps) {
  const { config, sessions, log, isDisposed, input } = deps;

  async function showTimerToast(sessionId: string) {
    if (isDisposed) return;
    if (!config.timerToastEnabled) return;
    
    const s = sessions.get(sessionId);
    if (!s || s.actionStartedAt === 0) return;
    
    const now = Date.now();
    const actionDuration = now - s.actionStartedAt;
    const lastProgressDuration = now - s.lastProgressAt;
    
    const actionStr = formatDuration(actionDuration);
    const progressStr = formatDuration(lastProgressDuration);
    
    const message = `⏱️ Action: ${actionStr} | Last progress: ${progressStr} ago`;
    
    try {
      log('showing timer toast for session:', sessionId, message);
      const client = input as any;
      await client.tui.showToast({
        query: { directory: (input as any).directory || "" },
        body: {
          title: "Session Timer",
          message: message,
          variant: "info",
        },
      });
    } catch (e) {
      log('timer toast error (ignored):', e);
    }
  }

  function startTimerToast(sessionId: string) {
    const s = sessions.get(sessionId);
    if (!s) return;
    
    // Clear existing timer
    if (s.toastTimer) {
      clearInterval(s.toastTimer);
      s.toastTimer = null;
    }
    
    if (!config.timerToastEnabled) return;
    
    s.actionStartedAt = Date.now();
    
    // Show first toast immediately
    showTimerToast(sessionId);
    
    // Set up recurring timer
    s.toastTimer = setInterval(() => {
      showTimerToast(sessionId);
    }, config.timerToastIntervalMs);
    
    log('timer toast started for session:', sessionId, 'interval:', config.timerToastIntervalMs);
  }

  function stopTimerToast(sessionId: string) {
    const s = sessions.get(sessionId);
    if (!s) return;
    
    if (s.toastTimer) {
      clearInterval(s.toastTimer);
      s.toastTimer = null;
      log('timer toast stopped for session:', sessionId);
    }
    
    s.actionStartedAt = 0;
  }

  return { showTimerToast, startTimerToast, stopTimerToast };
}
