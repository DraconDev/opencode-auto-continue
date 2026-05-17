/**
 * Plugin hooks: system transform and compaction hooks.
 * Handles: experimental.chat.system.transform, experimental.session.compacting,
 * experimental.compaction.autocontinue
 */

import { formatDangerousBlocklist } from "./dangerous-commands.js";
import type { HandlerContext } from "./handler-context.js";

// ─── experimental.chat.system.transform ───────────────────────────────────────

export function handleSystemTransform(
  ctx: HandlerContext,
  _input: Record<string, unknown>,
  output: { system: string[] },
): void {
  const { config, sessions, log } = ctx;
  const sid = _input?.sessionID as string | undefined;
  if (config.dangerousCommandBlocking && config.dangerousCommandInjection) {
    output.system = output.system || [];
    const policy = `## ⚠️ Dangerous Commands Policy\n\nThe following commands are blocked by policy and must never be used:\n\n${formatDangerousBlocklist()}\n\nIf you need one of these for a legitimate reason, explain why and it can be approved manually.`;
    output.system.push(policy);
    if (sid) {
      const s = sessions.get(sid);
      if (s) s.systemTransformHookCalled = true;
    }
    log('dangerous commands policy injected via system transform hook, session:', sid);
  }
}

// ─── experimental.session.compacting ───────────────────────────────────────────

export function handleSessionCompacting(
  ctx: HandlerContext,
  _input: Record<string, unknown>,
  output: { context: string[]; prompt?: string },
): void {
  const { sessions, log } = ctx;
  const sid = _input?.sessionID as string | undefined;
  if (!sid) {
    log('experimental.session.compacting hook called without sessionID, skipping');
    return;
  }

  const s = sessions.get(sid);
  if (!s) {
    log('session not found for compaction hook:', sid);
    return;
  }

  const contextLines: string[] = [];

  // Add token context
  if (s.realTokens > 0 || s.estimatedTokens > 0) {
    contextLines.push(`## Token Context`);
    contextLines.push(s.realTokens > 0 ? `Tokens: ${s.realTokens.toLocaleString()} (actual)` : `Estimated tokens: ~${s.estimatedTokens}`);
    if (s.tokenLimitHits > 0) {
      contextLines.push(`Token limit hits: ${s.tokenLimitHits}`);
    }
  }

  // Add stall pattern context
  if (s.stallDetections > 0) {
    contextLines.push(`## Stall Context`);
    contextLines.push(`Stall detections: ${s.stallDetections}`);
    const patterns = Object.entries(s.stallPatterns);
    if (patterns.length > 0) {
      contextLines.push(`Stall patterns: ${patterns.slice(0, 5).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
    }
  }

  // Add nudge context
  if (s.nudgeCount > 0) {
    contextLines.push(`## Nudge Context`);
    contextLines.push(`Nudges sent: ${s.nudgeCount}`);
  }

  if (contextLines.length > 0) {
    output.context = output.context || [];
    output.context.push(contextLines.join("\n"));
    log('injected session context into compaction:', sid, 'lines:', contextLines.length);
  }
}

// ─── experimental.compaction.autocontinue ─────────────────────────────────────

export function handleCompactionAutocontinue(
  ctx: HandlerContext,
  _input: Record<string, unknown>,
  output: { enabled: boolean },
): void {
  const { sessions, log } = ctx;
  output.enabled = false;

  const sid = _input?.sessionID as string | undefined;
  if (!sid) {
    log('experimental.compaction.autocontinue hook called without sessionID, skipping');
    return;
  }
  const s = sessions.get(sid);
  if (s && s.needsContinue) {
    log('autocontinue disabled for session:', sid, '- using custom continue');
  }
}