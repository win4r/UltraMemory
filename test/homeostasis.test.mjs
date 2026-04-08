import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const {
  homeostasisAdjustedThresholds,
  DEFAULT_HOMEOSTASIS_CONFIG,
} = jiti("../src/homeostasis.ts");

const { DEFAULT_TIER_CONFIG } = jiti("../src/tier-manager.ts");

// ============================================================================
// Helpers
// ============================================================================

function counts(core, working = 100, peripheral = 200) {
  return { core, working, peripheral };
}

// ============================================================================
// Tests
// ============================================================================

describe("homeostasisAdjustedThresholds", () => {
  it("returns base thresholds unchanged when core count is below cap", () => {
    const result = homeostasisAdjustedThresholds(
      counts(200),
      DEFAULT_TIER_CONFIG,
    );
    assert.deepEqual(result, DEFAULT_TIER_CONFIG);
  });

  it("returns base thresholds unchanged when core count equals cap", () => {
    const result = homeostasisAdjustedThresholds(
      counts(500),
      DEFAULT_TIER_CONFIG,
    );
    assert.deepEqual(result, DEFAULT_TIER_CONFIG);
  });

  it("scales up core thresholds when core count exceeds cap", () => {
    const result = homeostasisAdjustedThresholds(
      counts(1000),
      DEFAULT_TIER_CONFIG,
    );
    // overshoot = (1000 - 500) / 500 = 1.0
    // multiplier = 1 + 1.0 * 0.5 = 1.5
    assert.equal(result.coreAccessThreshold, Math.ceil(DEFAULT_TIER_CONFIG.coreAccessThreshold * 1.5));
    // coreCompositeThreshold = 0.7 * 1.5 = 1.05, clamped to 1.0
    assert.equal(result.coreCompositeThreshold, Math.min(DEFAULT_TIER_CONFIG.coreCompositeThreshold * 1.5, 1));
    // coreImportanceThreshold = 0.8 * 1.5 = 1.2, clamped to 1.0
    assert.equal(result.coreImportanceThreshold, Math.min(DEFAULT_TIER_CONFIG.coreImportanceThreshold * 1.5, 1));
  });

  it("does not modify working or peripheral thresholds", () => {
    const result = homeostasisAdjustedThresholds(
      counts(1500),
      DEFAULT_TIER_CONFIG,
    );
    assert.equal(result.workingAccessThreshold, DEFAULT_TIER_CONFIG.workingAccessThreshold);
    assert.equal(result.workingCompositeThreshold, DEFAULT_TIER_CONFIG.workingCompositeThreshold);
    assert.equal(result.peripheralCompositeThreshold, DEFAULT_TIER_CONFIG.peripheralCompositeThreshold);
    assert.equal(result.peripheralAgeDays, DEFAULT_TIER_CONFIG.peripheralAgeDays);
  });

  it("clamps multiplier at maxMultiplier", () => {
    // At 5x the cap (2500), overshoot = 4.0, multiplier = 1 + 4.0 * 0.5 = 3.0, clamped to 2.0
    const result = homeostasisAdjustedThresholds(
      counts(2500),
      DEFAULT_TIER_CONFIG,
    );
    assert.equal(result.coreAccessThreshold, Math.ceil(DEFAULT_TIER_CONFIG.coreAccessThreshold * 2.0));
  });

  it("clamps importance threshold at 1.0", () => {
    // coreImportanceThreshold = 0.8, with multiplier 2.0 -> 1.6, clamped to 1.0
    const base = { ...DEFAULT_TIER_CONFIG, coreImportanceThreshold: 0.8 };
    const result = homeostasisAdjustedThresholds(
      counts(2500),
      base,
      { cap: 500, scalingFactor: 0.5, maxMultiplier: 2.0 },
    );
    assert.equal(result.coreImportanceThreshold, 1.0);
  });

  it("clamps composite threshold at 1.0", () => {
    const base = { ...DEFAULT_TIER_CONFIG, coreCompositeThreshold: 0.9 };
    const result = homeostasisAdjustedThresholds(
      counts(2500),
      base,
      { cap: 500, scalingFactor: 0.5, maxMultiplier: 2.0 },
    );
    assert.equal(result.coreCompositeThreshold, 1.0);
  });

  it("accepts custom cap, scalingFactor, and maxMultiplier", () => {
    const result = homeostasisAdjustedThresholds(
      counts(200),
      DEFAULT_TIER_CONFIG,
      { cap: 100, scalingFactor: 1.0, maxMultiplier: 3.0 },
    );
    // overshoot = (200 - 100) / 100 = 1.0
    // multiplier = 1 + 1.0 * 1.0 = 2.0
    assert.equal(result.coreAccessThreshold, Math.ceil(DEFAULT_TIER_CONFIG.coreAccessThreshold * 2.0));
  });

  it("ceils coreAccessThreshold to an integer", () => {
    const base = { ...DEFAULT_TIER_CONFIG, coreAccessThreshold: 7 };
    const result = homeostasisAdjustedThresholds(
      counts(750),
      base,
      { cap: 500, scalingFactor: 0.5, maxMultiplier: 2.0 },
    );
    // overshoot = (750 - 500) / 500 = 0.5
    // multiplier = 1 + 0.5 * 0.5 = 1.25
    // 7 * 1.25 = 8.75 -> ceil -> 9
    assert.equal(result.coreAccessThreshold, 9);
  });

  it("returns a new object, does not mutate the input", () => {
    const base = { ...DEFAULT_TIER_CONFIG };
    const original = { ...base };
    homeostasisAdjustedThresholds(counts(1000), base);
    assert.deepEqual(base, original);
  });

  it("applies partial config overrides correctly", () => {
    // Only override cap, scalingFactor and maxMultiplier use defaults
    const result = homeostasisAdjustedThresholds(
      counts(300),
      DEFAULT_TIER_CONFIG,
      { cap: 200 },
    );
    // overshoot = (300 - 200) / 200 = 0.5
    // multiplier = 1 + 0.5 * 0.5 = 1.25 (default scalingFactor = 0.5)
    assert.equal(result.coreAccessThreshold, Math.ceil(DEFAULT_TIER_CONFIG.coreAccessThreshold * 1.25));
  });

  it("DEFAULT_HOMEOSTASIS_CONFIG has expected values", () => {
    assert.equal(DEFAULT_HOMEOSTASIS_CONFIG.cap, 500);
    assert.equal(DEFAULT_HOMEOSTASIS_CONFIG.scalingFactor, 0.5);
    assert.equal(DEFAULT_HOMEOSTASIS_CONFIG.maxMultiplier, 2.0);
  });
});
