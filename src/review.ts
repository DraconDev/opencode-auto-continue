import type { PluginConfig, SessionState } from "./shared.js";

export interface ReviewDeps {
  config: Pick<PluginConfig, "reviewMessage" | "showToasts" | "shortContinueMessage">;
  sessions: Map<string, SessionState>;
  log: (...args: unknown[]) => void;
  input: unknown;
  isDisposed: () => boolean;
  writeStatusFile: (sessionId: string) => void;
  isTokenLimitError: (error: any) => boolean;
  forceCompact: (sessionId: string) => Promise<boolean>;
}

export function createReviewModule(deps: ReviewDeps) {
  const { config, sessions, log, input, isDisposed, writeStatusFile, isTokenLimitError, forceCompact } = deps;

  async function triggerReview(sessionId: string) {
    if (isDisposed()) return;
    const s = sessions.get(sessionId);
    if (!s || s.reviewFired) return;

    s.reviewFired = true;
    log('triggering review for session:', sessionId);

    try {
      // Show toast if enabled
      if (config.showToasts) {
        try {
          await (input as any).client.tui.showToast({
            query: { directory: (input as any).directory || "" },
            body: {
              title: "Session Complete",
              message: "All tasks completed. Initiating review...",
              variant: "info",
            },
          });
        } catch (e) {
          log('toast error (ignored):', e);
        }
      }

      // Send review prompt
      s.messageCount++;
      await (input as any).client.session.prompt({
        path: { id: sessionId },
        query: { directory: (input as any).directory || "" },
        body: {
          parts: [{
            type: "text",
            text: config.reviewMessage,
            synthetic: true,
          }],
        },
      });

      log('review sent successfully');
    } catch (e: any) {
      log('review failed:', e);
      if (isTokenLimitError(e)) {
        log('token limit error in review, forcing compaction');
        await forceCompact(sessionId);
      }
    }
  }

  async function sendContinue(sessionId: string) {
    if (isDisposed()) return;
    const s = sessions.get(sessionId);
    if (!s || !s.needsContinue) return;

    const messageText = s.continueMessageText;
    s.needsContinue = false;
    s.continueMessageText = '';

    log('sending continue prompt from event handler');

    try {
      s.messageCount++;
      await (input as any).client.session.prompt({
        path: { id: sessionId },
        query: { directory: (input as any).directory || "" },
        body: {
          parts: [{
            type: "text",
            text: messageText,
            synthetic: true,
          }],
        },
      });

      log('continue sent successfully');
      s.recoverySuccessful++;
      s.lastRecoverySuccess = Date.now();
      if (s.recoveryStartTime > 0) {
        const recoveryTime = Date.now() - s.recoveryStartTime;
        s.totalRecoveryTimeMs += recoveryTime;
        s.recoveryTimes.push(recoveryTime);
        // Keep only last 100 recovery times to prevent memory bloat
        if (s.recoveryTimes.length > 100) {
          s.recoveryTimes.shift();
        }
        s.recoveryStartTime = 0;
      }
      writeStatusFile(sessionId);
    } catch (e: any) {
      log('continue failed:', e);
      s.recoveryFailed++;
      writeStatusFile(sessionId);

      // Handle token limit error
      if (isTokenLimitError(e)) {
        s.tokenLimitHits++;
        log('token limit error detected (hit #' + s.tokenLimitHits + '), forcing compaction');
        const compacted = await forceCompact(sessionId);
        if (compacted) {
          log('compaction succeeded, retrying continue with short message');
          // Retry after compaction with very short message
          await new Promise(r => setTimeout(r, 2000));
          try {
            s.messageCount++;
            await (input as any).client.session.prompt({
              path: { id: sessionId },
              query: { directory: (input as any).directory || "" },
              body: {
                parts: [{
                  type: "text",
                  text: config.shortContinueMessage,
                  synthetic: true,
                }],
              },
            });
            log('retry after compaction succeeded');
          } catch (e2) {
            log('retry after compaction failed:', e2);
          }
        } else {
          log('compaction failed, giving up on this recovery');
        }
      }
    }
  }

  return { triggerReview, sendContinue };
}