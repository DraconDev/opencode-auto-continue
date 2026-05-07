import { type PluginConfig, type SessionState, formatDuration } from "./shared.js";
import type { TypedPluginInput } from "./types.js";

export interface NotificationDeps {
  config: Pick<PluginConfig, "timerToastEnabled" | "timerToastIntervalMs" | "notifyChildSessions" | "notificationDedupeMs">;
  sessions: Map<string, SessionState>;
  log: (message: string, ...args: unknown[]) => void;
  isDisposed: boolean;
  input: TypedPluginInput;
}

export function createNotificationModule(deps: NotificationDeps) {
  const { config, sessions, log, isDisposed, input } = deps;

  // Track recent notifications for deduping
  const recentNotifications = new Map<string, number>();

  async function isParentSession(sessionId: string): Promise<boolean> {
    try {
      const session = await input.client.session.get({ path: { id: sessionId } });
      return !(session.data as any)?.parentID;
    } catch {
      return true; // Fail-open: notify if we can't determine
    }
  }

  function shouldSendNotification(sessionId: string, now: number = Date.now()): boolean {
    // Check deduping window
    const lastSent = recentNotifications.get(sessionId);
    if (lastSent && now - lastSent < config.notificationDedupeMs) {
      return false;
    }
    recentNotifications.set(sessionId, now);

    // Clean up old entries
    for (const [sid, timestamp] of recentNotifications) {
      if (now - timestamp > config.notificationDedupeMs * 2) {
        recentNotifications.delete(sid);
      }
    }

    return true;
  }

  async function showTimerToast(sessionId: string) {
    if (isDisposed) return;
    if (!config.timerToastEnabled) return;
    
    // Skip child sessions if configured
    if (!config.notifyChildSessions) {
      const isParent = await isParentSession(sessionId);
      if (!isParent) {
        log('timer toast skipped: child session', sessionId);
        return;
      }
    }

    // Deduping check
    if (!shouldSendNotification(sessionId)) {
      log('timer toast skipped: deduping window active', sessionId);
      return;
    }
    
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
      await input.client.tui.showToast({
        query: { directory: input.directory || "" },
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
