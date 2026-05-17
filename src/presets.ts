/**
 * Config presets — pre-configured profiles for common use cases.
 *
 * These presets provide sensible defaults for different scenarios.
 * Users can override any preset value by specifying it in their config.
 *
 * Usage in plugin config:
 *   preset: "balanced"   // default
 *   preset: "aggressive" // faster recovery, shorter stalls
 *   preset: "conservative" // slower recovery, longer stalls
 *
 * Usage programmatically:
 *   import { getPreset } from "./presets.js";
 *   const config = { ...getPreset("aggressive"), customField: "..." };
 */

import type { PluginConfig } from "./config.js";

export type PresetName = "conservative" | "balanced" | "aggressive";

/**
 * Returns the default preset name.
 */
export const DEFAULT_PRESET: PresetName = "balanced";

/**
 * Preset configuration values.
 * Each preset is a partial PluginConfig — missing fields use DEFAULT_CONFIG values.
 */
export const PRESETS: Record<PresetName, Partial<PluginConfig>> = {
  /**
   * Balanced preset — the default.
   * 3-minute stall timeout, moderate recovery settings, normal nudge timing.
   */
  balanced: {}, // All defaults — explicit but empty

  /**
   * Aggressive preset — faster recovery, shorter timeouts.
   * Use when you want the plugin to act quickly on stalls.
   * 1-minute stall timeout, faster nudges, quicker compaction.
   */
  aggressive: {
    stallTimeoutMs: 60000,
    waitAfterAbortMs: 2000,
    cooldownMs: 30000,
    continueMessage:
      "Continue. Act now — no confirmation needed.{todoMdInstruction}",
    nudgeIdleDelayMs: 0,
    nudgeCooldownMs: 15000,
    reviewCooldownMs: 30000,
    proactiveCompactAtTokens: 60000,
    opportunisticCompactAtTokens: 40000,
    hardCompactAtTokens: 80000,
    compactionGracePeriodMs: 5000,
    compactionSafetyTimeoutMs: 10000,
    compactionFailBackoffMs: 30000,
    compactionTimeoutBackoffMs: 10000,
    busyStallTimeoutMs: 60000,
    textOnlyStallTimeoutMs: 60000,
    planningTimeoutMs: 180000,
    maxRecoveries: 5,
  },

  /**
   * Conservative preset — slower recovery, longer timeouts.
   * Use when you want the AI to have more time before intervention.
   * 5-minute stall timeout, slower nudges, later compaction.
   */
  conservative: {
    stallTimeoutMs: 300000,
    waitAfterAbortMs: 10000,
    cooldownMs: 120000,
    continueMessage:
      "Continue when ready. No rush — take your time.{todoMdInstruction}",
    nudgeIdleDelayMs: 60000,
    nudgeCooldownMs: 120000,
    reviewCooldownMs: 180000,
    proactiveCompactAtTokens: 120000,
    opportunisticCompactAtTokens: 100000,
    hardCompactAtTokens: 150000,
    compactionGracePeriodMs: 30000,
    compactionSafetyTimeoutMs: 30000,
    compactionFailBackoffMs: 180000,
    compactionTimeoutBackoffMs: 60000,
    busyStallTimeoutMs: 300000,
    textOnlyStallTimeoutMs: 300000,
    planningTimeoutMs: 600000,
    maxRecoveries: 2,
  },
};

/**
 * Get the preset configuration for a given preset name.
 *
 * @param name - The preset name ("balanced" | "aggressive" | "conservative")
 * @returns The preset's partial config, or the balanced preset if name is unknown
 */
export function getPreset(name: PresetName): Partial<PluginConfig> {
  return PRESETS[name] ?? PRESETS.balanced;
}