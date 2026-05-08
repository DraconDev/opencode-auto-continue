import type { PluginConfig, SessionState } from "./shared.js";
import { shouldBlockPrompt } from "./shared.js";
import type { TypedPluginInput } from "./types.js";

export interface ReviewDeps {
  config: Pick<PluginConfig, "reviewMessage" | "showToasts" | "shortContinueMessage">;
  sessions: Map<string, SessionState>;
  log: (...args: unknown[]) => void;
  input: TypedPluginInput;
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
          await input.client.tui.showToast({
            query: { directory: input.directory || "" },
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

      // Prompt guard: prevent duplicate review prompts
      const isDuplicate = await shouldBlockPrompt(sessionId, config.reviewMessage, input, log);
      if (isDuplicate) {
        log('prompt guard blocked duplicate review, skipping');
        return;
      }

      // Send review prompt (NOT synthetic - we want AI to respond with tests/fixes)
      s.messageCount++;
      await input.client.session.prompt({
        path: { id: sessionId },
        query: { directory: input.directory || "" },
        body: {
          parts: [{
            type: "text",
            text: config.reviewMessage,
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
    // NOTE: We do NOT clear needsContinue here — only on success

    log('sending continue prompt from event handler');

    try {
      s.messageCount++;
      await input.client.session.prompt({
        path: { id: sessionId },
        query: { directory: input.directory || "" },
        body: {
          parts: [{
            type: "text",
            text: messageText,
            synthetic: true,
          }],
        },
      });

      // Only clear after successful send
      s.needsContinue = false;
      s.continueMessageText = '';

      log('continue sent successfully');
      s.recoverySuccessful++;
      s.lastRecoverySuccess = Date.now();
      if (s.recoveryStartTime > 0) {
        const recoveryTime = Date.now() - s.recoveryStartTime;
        s.totalRecoveryTimeMs += recoveryTime;
        s.recoveryTimes.push(recoveryTime);
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
          await new Promise(r => setTimeout(r, 2000));
          try {
            s.messageCount++;
            await input.client.session.prompt({
              path: { id: sessionId },
              query: { directory: input.directory || "" },
              body: {
                parts: [{
                  type: "text",
                  text: config.shortContinueMessage,
                  synthetic: true,
                }],
              },
            });
            // Only clear after retry success
            s.needsContinue = false;
            s.continueMessageText = '';
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