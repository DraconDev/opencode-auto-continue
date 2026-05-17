import type { PluginConfig } from "./config.js";
import type { SessionState } from "./session-state.js";
import { formatMessage, shouldBlockPrompt, todoMdInstruction } from "./shared.js";
import type { TypedPluginInput } from "./types.js";
import type { TestRunner } from "./test-runner.js";

export interface ReviewDeps {
  config: Pick<PluginConfig, "reviewMessage" | "reviewWithoutTestsMessage" | "showToasts" | "shortContinueMessage" | "reviewCooldownMs" | "todoMdPath" | "todoMdSync">;
  sessions: Map<string, SessionState>;
  log: (...args: unknown[]) => void;
  input: TypedPluginInput;
  isDisposed: () => boolean;
  writeStatusFile: (sessionId: string) => void;
  isTokenLimitError: (error: any) => boolean;
  forceCompact: (sessionId: string) => Promise<boolean>;
  maybeHardCompact?: (sessionId: string) => Promise<boolean>;
  testRunner?: TestRunner;
}

/**
 * Create the review module. Triggers a post-task review when the AI
 * signals completion (e.g., all todos done or stop condition met).
 * Optionally runs test commands and sends a review prompt with
 * the test results.
 */
export function createReviewModule(deps: ReviewDeps) {
  const { config, sessions, log, input, isDisposed, writeStatusFile, isTokenLimitError, forceCompact } = deps;

  async function triggerReview(sessionId: string) {
    if (isDisposed()) return;
    const s = sessions.get(sessionId);
    if (!s || s.reviewFired) return;

    if (s.compacting || s.hardCompactionInProgress) {
      log('review deferred — compaction in progress, scheduling retry:', sessionId);
      if (s.reviewRetryTimer) clearTimeout(s.reviewRetryTimer);
      s.reviewRetryTimer = setTimeout(() => {
        s.reviewRetryTimer = null;
        if (!isDisposed() && sessions.has(sessionId)) {
          const current = sessions.get(sessionId)!;
          if (current.reviewFired) return;
          triggerReview(sessionId).catch((e: unknown) => log('review retry failed:', e));
        }
      }, 5000);
      if (s.reviewRetryTimer && (s.reviewRetryTimer as any).unref) (s.reviewRetryTimer as any).unref();
      return;
    }

    // Cooldown check — prevent rapid-fire review loop
    const now = Date.now();
    if (s.lastReviewAt > 0 && (now - s.lastReviewAt) < config.reviewCooldownMs) {
      log('review cooldown active, skipping:', sessionId, 'elapsed:', now - s.lastReviewAt, 'ms, cooldown:', config.reviewCooldownMs, 'ms');
      return;
    }

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

      // Run tests before review to inject test output
      // Only include test output if there are real (non-skipped) results.
      // If all commands were skipped by gates, the AI must be entirely unaware
      // that a test loop exists — no mention of tests in the prompt at all.
      let testOutput = "";
      let hasRealTests = false;
      if (deps.testRunner && s && !s.testRunInProgress) {
        if (config.showToasts) {
          try {
            await input.client.tui.showToast({
              query: { directory: input.directory || "" },
              body: {
                title: "Running Tests",
                message: "Running tests for review...",
                variant: "info",
              },
            });
          } catch (e) {
            log('test runner start toast error (ignored):', e);
          }
        }
        s.testRunInProgress = true;
        try {
          const results = await deps.testRunner.runTests();
          s.lastTestRunAt = Date.now();
          hasRealTests = deps.testRunner.hasRealResults(results);
          if (hasRealTests) {
            testOutput = deps.testRunner.formatResults(results);
            log('test results for review:', testOutput ? 'output captured' : 'all passing');
          } else {
            log('no real test results (all skipped), review will not mention tests, session:', sessionId);
          }
        } catch (e) {
          log('test runner error during review (non-fatal):', e);
        } finally {
          s.testRunInProgress = false;
        }
      }

      // Build review message — only include test section if real results exist
      let messageText: string;
      if (hasRealTests) {
        messageText = formatMessage(config.reviewMessage, { testOutput: testOutput || "(no test output)", todoMdInstruction: todoMdInstruction(config.todoMdPath, config.todoMdSync) });
      } else {
        messageText = formatMessage(config.reviewWithoutTestsMessage, { todoMdInstruction: todoMdInstruction(config.todoMdPath, config.todoMdSync) });
      }

      // Prompt guard: prevent duplicate review prompts
      const isDuplicate = await shouldBlockPrompt(sessionId, messageText, input, log);
      if (isDuplicate) {
        log('prompt guard blocked duplicate review, skipping');
        return;
      }

      // Send review prompt
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

      // FIX 9: Only mark as fired after successful send
      s.reviewFired = true;
      s.lastReviewAt = Date.now();
      s.reviewCount++;
      log('review sent successfully (count:', s.reviewCount, ')');
    } catch (e: any) {
      log('review failed:', e);
      // FIX 9: Reset reviewFired on failure so it can retry
      s.reviewFired = false;
      log('reviewFired reset to false for retry:', sessionId);
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

    // FIX 2: Concurrency guard - prevent duplicate prompts from concurrent idle events
    if (s.continueInProgress) {
      log('sendContinue already in progress, skipping duplicate:', sessionId);
      return;
    }
    s.continueInProgress = true;

    const CONTINUE_SAFETY_TIMEOUT_MS = 60000;
    const continueSafetyTimer = setTimeout(() => {
      const current = sessions.get(sessionId);
      if (current && current.continueInProgress) {
        log('continue safety timeout — force-clearing continueInProgress for:', sessionId);
        current.continueInProgress = false;
      }
    }, CONTINUE_SAFETY_TIMEOUT_MS);
    if ((continueSafetyTimer as any).unref) (continueSafetyTimer as any).unref();

    try {
      const rawMessageText = s.continueMessageText;
      const messageText = rawMessageText.includes('{todoMdInstruction}')
        ? formatMessage(rawMessageText, { todoMdInstruction: todoMdInstruction(config.todoMdPath, config.todoMdSync) })
        : rawMessageText;
      const MAX_CONTINUE_RETRIES = 3;
      const CONTINUE_RETRY_BACKOFF_MS = 5000;
      const CONTINUE_RETRY_STALE_MS = 60000;

      if (s.continueRetryCount > 0 && s.lastContinueRetryAt > 0 && Date.now() - s.lastContinueRetryAt > CONTINUE_RETRY_STALE_MS) {
        log('continue retry count reset — stale retries from previous cycle:', sessionId, 'stale count:', s.continueRetryCount, 'age:', Date.now() - s.lastContinueRetryAt, 'ms');
        s.continueRetryCount = 0;
        s.lastContinueRetryAt = 0;
      }

      if (s.continueRetryCount >= MAX_CONTINUE_RETRIES) {
        log('continue retry limit reached, giving up:', sessionId, 'retries:', s.continueRetryCount);
        s.needsContinue = false;
        s.continueMessageText = '';
        s.continueRetryCount = 0;
        writeStatusFile(sessionId);
        return;
      }

      // FIX 1: Enforce backoff between continue retries
      const now = Date.now();
      if (s.continueRetryCount > 0 && now - s.lastContinueRetryAt < CONTINUE_RETRY_BACKOFF_MS) {
        log('continue retry backoff active, skipping:', sessionId);
        return;
      }

      // FIX 7: Prompt guard - prevent duplicate continue messages in recovery loops
      const isDuplicate = await shouldBlockPrompt(sessionId, messageText, input, log);
      if (isDuplicate) {
        log('prompt guard blocked duplicate continue, skipping:', sessionId);
        return;
      }

      log('sending continue prompt from event handler (retry:', s.continueRetryCount, ')');

      if (deps.maybeHardCompact) {
        try {
          const compacted = await deps.maybeHardCompact(sessionId);
          if (compacted) {
            log('hard compaction succeeded before continue:', sessionId);
          }
        } catch (e) {
          log('hard compaction before continue failed (proceeding anyway):', e);
        }
      }

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
      s.continueRetryCount = 0;
      s.lastContinueRetryAt = 0;
      s.lastContinueAt = Date.now();

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
      // FIX 1: Track retry count on failure
      s.continueRetryCount++;
      s.lastContinueRetryAt = Date.now();
      writeStatusFile(sessionId);

      // Handle token limit error
      if (isTokenLimitError(e)) {
        s.tokenLimitHits++;
        log('token limit error detected (hit #' + s.tokenLimitHits + '), forcing compaction');
        const compacted = await forceCompact(sessionId);
        if (compacted) {
          log('compaction succeeded, retrying continue with short message');
          await new Promise(r => setTimeout(r, 2000));
          // Check session is idle before sending prompt
          try {
            const statusResult = await input.client.session.status({});
            const statusData = statusResult.data as Record<string, { type: string }>;
            if (statusData[sessionId]?.type !== "idle") {
              log('session not idle after compaction, queueing continue for later:', sessionId);
              return;
            }
          } catch {
            log('status check after compaction failed, proceeding anyway');
          }
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
            s.lastContinueAt = Date.now();
            log('retry after compaction succeeded');
          } catch (e2) {
            log('retry after compaction failed:', e2);
          }
        } else {
          log('compaction failed, giving up on this recovery');
        }
      }
    } finally {
      clearTimeout(continueSafetyTimer);
      s.continueInProgress = false;
    }
  }

  return { triggerReview, sendContinue };
}