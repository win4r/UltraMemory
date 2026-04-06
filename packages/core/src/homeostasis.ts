/**
 * Homeostasis — Synaptic Scaling for Memory Tier Thresholds
 *
 * When the core memory tier grows too large, retrieval quality degrades because
 * too many entries compete for limited context window space. Homeostasis
 * counteracts this by proportionally raising the thresholds required for core
 * promotion, ensuring only the most relevant entries surface.
 *
 * This is a pure function — no store access, no LLM, just arithmetic.
 *
 * Ported from RecallNest's decay-engine.ts (synaptic homeostasis).
 */

import type { TierConfig } from "./tier-manager.js";

// ============================================================================
// Types
// ============================================================================

export interface HomeostasisConfig {
  /** Maximum core tier entries before scaling kicks in (default: 500) */
  cap: number;
  /** How aggressively thresholds scale with overshoot (default: 0.5) */
  scalingFactor: number;
  /** Upper bound on the threshold multiplier (default: 2.0) */
  maxMultiplier: number;
}

export const DEFAULT_HOMEOSTASIS_CONFIG: HomeostasisConfig = {
  cap: 500,
  scalingFactor: 0.5,
  maxMultiplier: 2.0,
};

export interface TierCounts {
  core: number;
  working: number;
  peripheral: number;
}

// ============================================================================
// Core function
// ============================================================================

/**
 * Compute homeostasis-adjusted tier thresholds.
 *
 * When `tierCounts.core` exceeds `config.cap`, the core-promotion thresholds
 * in `baseThresholds` are scaled up proportionally:
 *
 *   overshoot = max(0, (coreCount - cap) / cap)
 *   multiplier = clamp(1 + overshoot * scalingFactor, 1, maxMultiplier)
 *
 * Only core-promotion fields are affected:
 * - `coreAccessThreshold` is scaled and ceil'd to an integer
 * - `coreCompositeThreshold` is scaled and clamped to [0, 1]
 * - `coreImportanceThreshold` is scaled and clamped to [0, 1]
 *
 * Demotion and working-promotion thresholds are left unchanged — homeostasis
 * only tightens the gate into core, it does not alter other transitions.
 */
export function homeostasisAdjustedThresholds(
  tierCounts: TierCounts,
  baseThresholds: TierConfig,
  config: Partial<HomeostasisConfig> = {},
): TierConfig {
  const { cap, scalingFactor, maxMultiplier } = {
    ...DEFAULT_HOMEOSTASIS_CONFIG,
    ...config,
  };

  const coreCount = tierCounts.core;
  if (coreCount <= cap) return { ...baseThresholds };

  const overshoot = Math.max(0, (coreCount - cap) / cap);
  const multiplier = Math.min(1 + overshoot * scalingFactor, maxMultiplier);

  return {
    ...baseThresholds,
    coreAccessThreshold: Math.ceil(baseThresholds.coreAccessThreshold * multiplier),
    coreCompositeThreshold: Math.min(baseThresholds.coreCompositeThreshold * multiplier, 1),
    coreImportanceThreshold: Math.min(baseThresholds.coreImportanceThreshold * multiplier, 1),
  };
}
