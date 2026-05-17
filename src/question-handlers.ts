/**
 * Question event handlers.
 * Handles: question.asked
 */

import type { PluginEvent } from "./types.js";
import type { HandlerContext } from "./event-handlers.js";
import { getHttpClient } from "./typed-helpers.js";

// ─── question.asked ───────────────────────────────────────────────────────────

export async function handleQuestionAsked(
  ctx: HandlerContext,
  sid: string,
  e: PluginEvent,
): Promise<void> {
  const { config, log, getSession, writeStatusFile, input, nudge } = ctx;
  if (!config.autoAnswerQuestions) return;

  const props = e.properties as Record<string, unknown>;
  const requestID = props.id as string | undefined;
  const questions = (props.questions || []) as Array<{ header?: string; question?: string; options?: Array<{ label?: string }> }>;
  log('question.asked:', requestID, 'session:', sid, 'questions:', questions.length);

  if (requestID && questions.length > 0) {
    const SAFE_PATTERNS = /^(yes|ok|okay|confirm|continue|proceed|accept|agree|got it|sure|y)$/i;
    const answers: string[][] = [];
    let allSafe = true;

    for (const q of questions) {
      const opts = q.options || [];
      if (opts.length === 0) { allSafe = false; break; }
      if (opts.length === 1) {
        answers.push([opts[0].label || ""]);
      } else if (config.autoAnswerSafeOnly) {
        const safeOpt = opts.find((o) => SAFE_PATTERNS.test(o.label?.trim() || ""));
        if (safeOpt) {
          answers.push([safeOpt.label || ""]);
        } else {
          allSafe = false;
          break;
        }
      } else {
        answers.push([opts[0]?.label || ""]);
      }
    }

    if (!allSafe) {
      log('skipping auto-answer: interactive question without safe default');
      writeStatusFile(sid);
      return;
    }

    for (let i = 0; i < questions.length; i++) {
      log('auto-answering question:', questions[i].header || questions[i].question, '→', answers[i][0]);
    }

    try {
      const httpClient = getHttpClient(input);
      if (httpClient) {
        await httpClient.post({
          url: `/question/${requestID}/reply`,
          headers: { "Content-Type": "application/json" },
          body: { answers },
        });
        log('auto-replied to question:', requestID);
      } else {
        log('no HTTP client available for question reply');
      }

      const s = getSession(sid);
      s.lastOutputAt = Date.now();
      s.lastProgressAt = Date.now();
      nudge.cancelNudge(sid);
    } catch (err) {
      log('question auto-reply FAILED:', err);
    }
  }

  writeStatusFile(sid);
}