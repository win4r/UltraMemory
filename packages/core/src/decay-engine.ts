/**
 * Decay Engine — Weibull stretched-exponential decay model
 *
 * Composite score = recencyWeight * recency + frequencyWeight * frequency + intrinsicWeight * intrinsic
 *
 * - Recency: Weibull decay with importance-modulated half-life and tier-specific beta
 * - Frequency: Logarithmic saturation with time-weighted access pattern bonus
 * - Intrinsic: importance × confidence
 */

import type { MemoryTier } from "./memory-categories.js";

// ============================================================================
// Types
// ============================================================================

const MS_PER_DAY = 86_400_000;

export interface RetentionPolicy {
  minRetentionDays: number;
  decayMultiplier: number;
  maxRetentionDays?: number;
}

export interface DecayConfig {
  /** Days until recency score halves (default: 30) */
  recencyHalfLifeDays: number;
  /** Weight of recency in composite (default: 0.4) */
  recencyWeight: number;
  /** Weight of access frequency (default: 0.3) */
  frequencyWeight: number;
  /** Weight of importance × confidence (default: 0.3) */
  intrinsicWeight: number;
  /** Below this composite = stale (default: 0.3) */
  staleThreshold: number;
  /** Minimum search boost (default: 0.3) */
  searchBoostMin: number;
  /** Importance modulation coefficient for half-life (default: 1.5) */
  importanceModulation: number;
  /** Weibull beta for Core tier — sub-exponential (default: 0.8) */
  betaCore: number;
  /** Weibull beta for Working tier — standard exponential (default: 1.0) */
  betaWorking: number;
  /** Weibull beta for Peripheral tier — super-exponential (default: 1.3) */
  betaPeripheral: number;
  /** Decay floor for Core memories (default: 0.9) */
  coreDecayFloor: number;
  /** Decay floor for Working memories (default: 0.7) */
  workingDecayFloor: number;
  /** Decay floor for Peripheral memories (default: 0.5) */
  peripheralDecayFloor: number;
  /** Category-specific retention policies */
  retentionPolicies?: Partial<Record<string, RetentionPolicy>>;
}

export const DEFAULT_DECAY_CONFIG: DecayConfig = {
  recencyHalfLifeDays: 30,
  recencyWeight: 0.4,
  frequencyWeight: 0.3,
  intrinsicWeight: 0.3,
  staleThreshold: 0.3,
  searchBoostMin: 0.3,
  importanceModulation: 1.5,
  betaCore: 0.8,
  betaWorking: 1.0,
  betaPeripheral: 1.3,
  coreDecayFloor: 0.9,
  workingDecayFloor: 0.7,
  peripheralDecayFloor: 0.5,
};

export const RETENTION_PRESETS: Record<string, Partial<Record<string, RetentionPolicy>>> = {
  default: {
    profile:     { minRetentionDays: 365, decayMultiplier: 0.2 },
    preferences: { minRetentionDays: 180, decayMultiplier: 0.3 },
    entities:    { minRetentionDays: 90,  decayMultiplier: 0.5 },
    events:      { minRetentionDays: 30,  decayMultiplier: 1.0 },
    cases:       { minRetentionDays: 60,  decayMultiplier: 0.8 },
    patterns:    { minRetentionDays: 180, decayMultiplier: 0.3 },
  },
  legal: {
    profile:     { minRetentionDays: 9999, decayMultiplier: 0 },
    preferences: { minRetentionDays: 9999, decayMultiplier: 0 },
    entities:    { minRetentionDays: 9999, decayMultiplier: 0 },
    events:      { minRetentionDays: 9999, decayMultiplier: 0 },
    cases:       { minRetentionDays: 9999, decayMultiplier: 0 },
    patterns:    { minRetentionDays: 9999, decayMultiplier: 0 },
  },
  ephemeral: {
    profile:     { minRetentionDays: 30, decayMultiplier: 0.5 },
    preferences: { minRetentionDays: 14, decayMultiplier: 1.0 },
    entities:    { minRetentionDays: 14, decayMultiplier: 1.5 },
    events:      { minRetentionDays: 7,  decayMultiplier: 2.0 },
    cases:       { minRetentionDays: 14, decayMultiplier: 1.5 },
    patterns:    { minRetentionDays: 14, decayMultiplier: 1.0 },
  },
};

export function resolveRetentionPreset(
  presetName?: string,
  customOverrides?: Partial<Record<string, RetentionPolicy>>,
): Partial<Record<string, RetentionPolicy>> | undefined {
  if (!presetName && !customOverrides) return undefined;
  const base = presetName ? (RETENTION_PRESETS[presetName] ?? RETENTION_PRESETS.default) : {};
  if (!customOverrides) return base;
  return { ...base, ...customOverrides };
}

export interface DecayScore {
  memoryId: string;
  recency: number;
  frequency: number;
  intrinsic: number;
  composite: number;
}

/** Minimal memory fields needed for decay calculation. */
export interface DecayableMemory {
  id: string;
  importance: number;
  confidence: number;
  tier: MemoryTier;
  accessCount: number;
  createdAt: number;
  lastAccessedAt: number;
  feedbackWeight?: number;
}

export interface DecayEngine {
  /** Calculate decay score for a single memory */
  score(memory: DecayableMemory, now?: number, category?: string): DecayScore;
  /** Calculate decay scores for multiple memories */
  scoreAll(memories: DecayableMemory[], now?: number, categoryMap?: Map<string, string>): DecayScore[];
  /** Apply decay boost to search results (multiplies each score by boost) */
  applySearchBoost(
    results: Array<{ memory: DecayableMemory; score: number; category?: string }>,
    now?: number,
  ): void;
  /** Find stale memories (composite below threshold) */
  getStaleMemories(
    memories: DecayableMemory[],
    now?: number,
    categoryMap?: Map<string, string>,
  ): DecayScore[];
}

// ============================================================================
// Factory
// ============================================================================

export function createDecayEngine(
  config: Partial<DecayConfig> = {},
): DecayEngine {
  const merged = { ...DEFAULT_DECAY_CONFIG, ...config };
  const {
    recencyHalfLifeDays: halfLife,
    recencyWeight: rw,
    frequencyWeight: fw,
    intrinsicWeight: iw,
    staleThreshold,
    searchBoostMin: boostMin,
    importanceModulation: mu,
    betaCore,
    betaWorking,
    betaPeripheral,
    coreDecayFloor,
    workingDecayFloor,
    peripheralDecayFloor,
    retentionPolicies,
  } = merged;

  function getTierBeta(tier: MemoryTier): number {
    switch (tier) {
      case "core":
        return betaCore;
      case "working":
        return betaWorking;
      case "peripheral":
        return betaPeripheral;
    }
  }

  function getTierFloor(tier: MemoryTier): number {
    switch (tier) {
      case "core":
        return coreDecayFloor;
      case "working":
        return workingDecayFloor;
      case "peripheral":
        return peripheralDecayFloor;
    }
  }

  /**
   * Recency: Weibull stretched-exponential decay with importance-modulated half-life.
   * effectiveHL = halfLife * exp(mu * importance)
   * lambda = ln(2) / effectiveHL
   * recency = exp(-lambda * daysSince^beta)
   */
  function recency(memory: DecayableMemory, now: number): number {
    const lastActive =
      memory.accessCount > 0 ? memory.lastAccessedAt : memory.createdAt;
    const daysSince = Math.max(0, (now - lastActive) / MS_PER_DAY);
    const effectiveHL = halfLife * Math.exp(mu * memory.importance);
    const lambda = Math.LN2 / effectiveHL;
    const beta = getTierBeta(memory.tier);
    return Math.exp(-lambda * Math.pow(daysSince, beta));
  }

  /**
   * Frequency: logarithmic saturation curve with time-weighted access pattern bonus.
   * base = 1 - exp(-accessCount / 5)
   * For memories with >1 access, a recentness bonus is applied.
   */
  function frequency(memory: DecayableMemory): number {
    const base = 1 - Math.exp(-memory.accessCount / 5);
    if (memory.accessCount <= 1) return base;

    const lastActive =
      memory.accessCount > 0 ? memory.lastAccessedAt : memory.createdAt;
    const accessSpanDays = Math.max(
      1,
      (lastActive - memory.createdAt) / MS_PER_DAY,
    );
    const avgGapDays = accessSpanDays / Math.max(memory.accessCount - 1, 1);
    const recentnessBonus = Math.exp(-avgGapDays / 30);
    return base * (0.5 + 0.5 * recentnessBonus);
  }

  /**
   * Intrinsic value: importance × confidence × feedbackMultiplier.
   */
  function intrinsic(memory: DecayableMemory): number {
    const feedbackWeight = memory.feedbackWeight ?? 0.5;
    const feedbackMultiplier = 0.6 + 0.8 * feedbackWeight;
    return memory.importance * (memory.confidence ?? 1) * feedbackMultiplier;
  }

  function scoreOne(memory: DecayableMemory, now: number, category?: string): DecayScore {
    const r = recency(memory, now);
    const f = frequency(memory);
    const i = intrinsic(memory);
    let composite = rw * r + fw * f + iw * i;

    // Apply retention policy if category provided
    if (category && retentionPolicies?.[category]) {
      const policy = retentionPolicies[category]!;
      const ageDays = (now - memory.createdAt) / MS_PER_DAY;

      if (policy.maxRetentionDays && ageDays > policy.maxRetentionDays) {
        composite = Math.min(composite, 0.05); // Force near-stale
      } else if (ageDays <= policy.minRetentionDays) {
        composite = Math.max(composite, 0.95);
      } else if (policy.decayMultiplier > 0 && policy.decayMultiplier !== 1.0) {
        // Recompute recency with modified half-life
        const modifiedHL = halfLife / policy.decayMultiplier;
        const effHL = modifiedHL * Math.exp(mu * memory.importance);
        const modLambda = Math.LN2 / effHL;
        const beta = getTierBeta(memory.tier);
        const modRecency = Math.exp(-modLambda * Math.pow(ageDays, beta));
        composite = rw * modRecency + fw * f + iw * i;
      }
    }

    // Apply tier floor to prevent floor-protected memories from appearing stale
    const tierFloor = getTierFloor(memory.tier);
    composite = Math.max(composite, tierFloor);

    return {
      memoryId: memory.id,
      recency: r,
      frequency: f,
      intrinsic: i,
      composite,
    };
  }

  return {
    score(memory, now = Date.now(), category?) {
      return scoreOne(memory, now, category);
    },

    scoreAll(memories, now = Date.now(), categoryMap?) {
      return memories.map((m) => scoreOne(m, now, categoryMap?.get(m.id)));
    },

    applySearchBoost(results, now = Date.now()) {
      for (const r of results) {
        const ds = scoreOne(r.memory, now, r.category);
        // scoreOne already applies tier floor, so ds.composite >= tierFloor
        const multiplier = boostMin + ((1 - boostMin) * ds.composite);
        r.score *= Math.min(1, Math.max(boostMin, multiplier));
      }
    },

    getStaleMemories(memories, now = Date.now(), categoryMap?) {
      const scores = memories.map((m) => scoreOne(m, now, categoryMap?.get(m.id)));
      return scores
        .filter((s) => s.composite < staleThreshold)
        .sort((a, b) => a.composite - b.composite);
    },
  };
}
