import type { PluginConfig, SessionState } from "./shared.js";
import { formatMessage } from "./shared.js";

export interface RecoveryDeps {
  config: PluginConfig;
  sessions: Map<string, SessionState>;
  log: (...args: unknown[]) => void;
  input: unknown;
  isDisposed: () => boolean;
  writeStatusFile: (sessionId: string) => void;
  cancelNudge: (sessionId: string) => void;
}

export function createRecoveryModule(deps: RecoveryDeps) {
  const { config, sessions, log, input, isDisposed, writeStatusFile, cancelNudge } = deps;

  async function recover(sessionId: string) {
    if (isDisposed()) return;
    const s = sessions.get(sessionId);
    if (!s) return;

    if (s.aborting) return;
    if (s.userCancelled) return;
    if (s.planning) return;
    if (s.compacting) return;
    if (s.attempts >= config.maxRecoveries) {
      const backoffDelay = Math.min(
        config.stallTimeoutMs * Math.pow(2, s.backoffAttempts),
        config.maxBackoffMs
      );
      s.backoffAttempts++;
      log('max recoveries reached, using exponential backoff:', backoffDelay, 'ms (attempt', s.backoffAttempts, ')');
      s.timer = setTimeout(() => recover(sessionId), backoffDelay);
      return;
    }

    const now = Date.now();

    if (now - s.lastRecoveryTime < config.cooldownMs) return;

    if (config.maxSessionAgeMs > 0 && now - s.sessionCreatedAt > config.maxSessionAgeMs) {
      log('session too old, giving up:', sessionId, 'age:', now - s.sessionCreatedAt, 'ms');
      s.aborting = false;
      return;
    }

    s.aborting = true;
    s.stallDetections++;
    s.recoveryStartTime = Date.now();

    if (config.stallPatternDetection && s.lastStallPartType) {
      s.stallPatterns[s.lastStallPartType] = (s.stallPatterns[s.lastStallPartType] || 0) + 1;
    }

    writeStatusFile(sessionId);

    try {
      const statusResult = await (input as any).client.session.status({});
      const statusData = statusResult.data as Record<string, { type: string }>;
      const sessionStatus = statusData[sessionId];

      if (sessionStatus && typeof sessionStatus === 'object') {
        const st = sessionStatus as any;
        if (typeof st.tokensInput === 'number' || typeof st.totalTokens === 'number') {
          const actualTokens = st.totalTokens || (st.tokensInput + (st.tokensOutput || 0));
          if (actualTokens > 0) {
            s.estimatedTokens = Math.max(s.estimatedTokens, actualTokens);
            log('read actual tokens from session status:', actualTokens);
          }
        }
      }

      if (!sessionStatus || sessionStatus.type !== "busy") {
        s.aborting = false;
        return;
      }

      const currentTime = Date.now();

      if (currentTime - s.lastProgressAt < config.stallTimeoutMs) {
        s.aborting = false;
        const remaining = config.stallTimeoutMs - (currentTime - s.lastProgressAt);
        s.timer = setTimeout(() => recover(sessionId), Math.max(remaining, 100));
        return;
      }

      if (config.autoCompact) {
        try {
          log('attempting auto-compaction for session:', sessionId);
          await (input as any).client.session.summarize({
            path: { id: sessionId },
            query: { directory: (input as any).directory || "" }
          });
          log('auto-compaction successful, waiting for session to resume');
          await new Promise(r => setTimeout(r, 3000));

          const postCompactStatus = await (input as any).client.session.status({});
          const postData = postCompactStatus.data as Record<string, { type: string }>;
          if (postData[sessionId]?.type === "busy") {
            log('session still busy after compaction, proceeding with abort');
          } else {
            log('session recovered after compaction');
            s.aborting = false;
            return;
          }
        } catch (e) {
          log('auto-compaction failed:', e);
        }
      }

      try {
        await (input as any).client.session.abort({
          path: { id: sessionId },
          query: { directory: (input as any).directory || "" }
        });
      } catch (e) {
        log('abort failed:', e);
        s.aborting = false;
        s.timer = setTimeout(() => recover(sessionId), config.stallTimeoutMs * 2);
        return;
      }

      const startTime = Date.now();
      let isIdle = false;
      let statusFailures = 0;

      if (config.abortPollMaxTimeMs > 0) {
        while (!isIdle && Date.now() - startTime < config.abortPollMaxTimeMs && statusFailures < config.abortPollMaxFailures) {
          await new Promise(r => setTimeout(r, config.abortPollIntervalMs));
          try {
            const pollResult = await (input as any).client.session.status({});
            const pollData = pollResult.data as Record<string, { type: string }>;
            const pollStatus = pollData[sessionId];
            if (pollStatus?.type === "idle") {
              isIdle = true;
            }
            statusFailures = 0;
          } catch (e) {
            statusFailures++;
            log('status poll failed:', e);
          }
        }
      }

      const remainingWait = config.waitAfterAbortMs - (Date.now() - startTime);
      if (remainingWait > 0) {
        await new Promise(r => setTimeout(r, remainingWait));
      }

      if (s.autoSubmitCount >= config.maxAutoSubmits) {
        log('loop protection: max auto-submits reached:', s.autoSubmitCount);
        s.aborting = false;
        return;
      }

      let messageText = config.continueMessage;
      const templateVars: Record<string, string> = {
        attempts: String(s.attempts + 1),
        maxAttempts: String(config.maxRecoveries),
      };

      if (config.includeTodoContext) {
        try {
          const todoResult = await (input as any).client.session.todo({ path: { id: sessionId } });
          const todos = Array.isArray(todoResult.data) ? todoResult.data : [];
          const pending = todos.filter((t: any) => t.status === 'in_progress' || t.status === 'pending');
          const completed = todos.filter((t: any) => t.status === 'completed' || t.status === 'cancelled');

          templateVars.total = String(todos.length);
          templateVars.completed = String(completed.length);
          templateVars.pending = String(pending.length);

          if (pending.length > 0) {
            const todoList = pending.slice(0, 5).map((t: any) => t.content || t.title || t.id).join(', ');
            templateVars.todoList = todoList + (pending.length > 5 ? '...' : '');
            messageText = formatMessage(config.continueWithTodosMessage, templateVars);
            log('todo context added:', pending.length, 'pending tasks');
          } else {
            log('no pending todos');
          }
        } catch (e) {
          log('todo fetch failed:', e);
        }
      }

      if (messageText === config.continueMessage) {
        messageText = formatMessage(config.continueMessage, templateVars);
      }

      if (s.tokenLimitHits > 0) {
        log('using short continue message due to previous token limit hits:', s.tokenLimitHits);
        messageText = config.shortContinueMessage;
      }

      s.needsContinue = true;
      s.continueMessageText = messageText;
      log('queued continue message, waiting for stable state');

      s.attempts++;
      s.autoSubmitCount++;
      s.lastRecoveryTime = Date.now();
      s.backoffAttempts = 0;
      s.messageCount++;

      cancelNudge(sessionId);
    } catch (e) {
      log('recovery failed:', e);
      s.timer = setTimeout(() => recover(sessionId), config.stallTimeoutMs * 2);
    } finally {
      s.aborting = false;
    }
  }

  return { recover };
}