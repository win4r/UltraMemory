/**
 * Confidence Tracker Tests
 *
 * Verifies confidence scoring, time decay, and retrieval weighting.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  CONFIDENCE_DEFAULT,
  CONFIDENCE_CONFIRMED,
  CONFIDENCE_STRONG,
  CONFIDENCE_CORRECTED,
  CONFIDENCE_CONTRADICTED,
  CONFIDENCE_DECAY_HALF_LIFE_DAYS,
  getConfidence,
  getConfidenceHistory,
  buildConfirmPatch,
  buildCorrectPatch,
  buildContradictPatch,
  decayConfidence,
  buildDecayPatch,
  applyConfidenceWeight,
} = jiti("../packages/core/src/confidence-tracker.ts");

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("confidence constants", () => {
  it("should have correct default values", () => {
    assert.equal(CONFIDENCE_DEFAULT, 0.5);
    assert.equal(CONFIDENCE_CONFIRMED, 0.8);
    assert.equal(CONFIDENCE_STRONG, 1.0);
    assert.equal(CONFIDENCE_CORRECTED, 0.2);
    assert.equal(CONFIDENCE_CONTRADICTED, 0.0);
    assert.equal(CONFIDENCE_DECAY_HALF_LIFE_DAYS, 90);
  });
});

// ---------------------------------------------------------------------------
// getConfidence
// ---------------------------------------------------------------------------

describe("getConfidence", () => {
  it("should return confidence from metadata", () => {
    assert.equal(getConfidence({ confidence: 0.8 }), 0.8);
  });

  it("should return default when confidence is missing", () => {
    assert.equal(getConfidence({}), CONFIDENCE_DEFAULT);
  });

  it("should clamp out-of-range values", () => {
    assert.equal(getConfidence({ confidence: 1.5 }), 1.0);
    assert.equal(getConfidence({ confidence: -0.3 }), 0.0);
  });

  it("should return default for non-numeric confidence", () => {
    assert.equal(getConfidence({ confidence: "high" }), CONFIDENCE_DEFAULT);
    assert.equal(getConfidence({ confidence: NaN }), CONFIDENCE_DEFAULT);
  });
});

// ---------------------------------------------------------------------------
// getConfidenceHistory
// ---------------------------------------------------------------------------

describe("getConfidenceHistory", () => {
  it("should return empty array when no history", () => {
    assert.deepEqual(getConfidenceHistory({}), []);
    assert.deepEqual(getConfidenceHistory({ confidence_history: "not-array" }), []);
  });

  it("should filter invalid entries", () => {
    const history = getConfidenceHistory({
      confidence_history: [
        { action: "confirmed", from: 0.5, to: 0.8, date: "2026-01-01" },
        { bad: "entry" },
        null,
        { action: "corrected", from: 0.8, to: 0.2, date: "2026-01-02" },
      ],
    });
    assert.equal(history.length, 2);
    assert.equal(history[0].action, "confirmed");
    assert.equal(history[1].action, "corrected");
  });
});

// ---------------------------------------------------------------------------
// buildConfirmPatch
// ---------------------------------------------------------------------------

describe("buildConfirmPatch", () => {
  it("should raise unverified confidence to CONFIRMED", () => {
    const patch = buildConfirmPatch({ confidence: CONFIDENCE_DEFAULT });
    assert.equal(patch.confidence, CONFIDENCE_CONFIRMED);
    assert.equal(patch.confidence_history.length, 1);
    assert.equal(patch.confidence_history[0].action, "confirmed");
    assert.equal(patch.confidence_history[0].from, CONFIDENCE_DEFAULT);
    assert.equal(patch.confidence_history[0].to, CONFIDENCE_CONFIRMED);
  });

  it("should raise already-confirmed to STRONG", () => {
    const patch = buildConfirmPatch({ confidence: CONFIDENCE_CONFIRMED });
    assert.equal(patch.confidence, CONFIDENCE_STRONG);
    assert.equal(patch.confidence_history[0].from, CONFIDENCE_CONFIRMED);
    assert.equal(patch.confidence_history[0].to, CONFIDENCE_STRONG);
  });

  it("should use default confidence when field is missing", () => {
    const patch = buildConfirmPatch({});
    assert.equal(patch.confidence, CONFIDENCE_CONFIRMED);
    assert.equal(patch.confidence_history[0].from, CONFIDENCE_DEFAULT);
  });

  it("should preserve existing history", () => {
    const existing = {
      confidence: 0.6,
      confidence_history: [
        { action: "decayed", from: 0.8, to: 0.6, date: "2026-01-01" },
      ],
    };
    const patch = buildConfirmPatch(existing);
    assert.equal(patch.confidence_history.length, 2);
    assert.equal(patch.confidence_history[0].action, "decayed");
    assert.equal(patch.confidence_history[1].action, "confirmed");
  });
});

// ---------------------------------------------------------------------------
// buildCorrectPatch
// ---------------------------------------------------------------------------

describe("buildCorrectPatch", () => {
  it("should drop confidence to CORRECTED", () => {
    const patch = buildCorrectPatch({ confidence: CONFIDENCE_CONFIRMED });
    assert.equal(patch.confidence, CONFIDENCE_CORRECTED);
    assert.equal(patch.confidence_history[0].action, "corrected");
    assert.equal(patch.confidence_history[0].from, CONFIDENCE_CONFIRMED);
  });

  it("should include correctedBy when provided", () => {
    const patch = buildCorrectPatch(
      { confidence: 0.8 },
      "abc12345-long-id",
    );
    assert.equal(patch.confidence_history[0].correctedBy, "abc12345");
  });

  it("should not include correctedBy when omitted", () => {
    const patch = buildCorrectPatch({ confidence: 0.8 });
    assert.equal(patch.confidence_history[0].correctedBy, undefined);
  });
});

// ---------------------------------------------------------------------------
// buildContradictPatch
// ---------------------------------------------------------------------------

describe("buildContradictPatch", () => {
  it("should drop confidence to CONTRADICTED", () => {
    const patch = buildContradictPatch({ confidence: CONFIDENCE_DEFAULT });
    assert.equal(patch.confidence, CONFIDENCE_CONTRADICTED);
    assert.equal(patch.confidence_history[0].action, "contradicted");
    assert.equal(patch.confidence_history[0].from, CONFIDENCE_DEFAULT);
    assert.equal(patch.confidence_history[0].to, CONFIDENCE_CONTRADICTED);
  });
});

// ---------------------------------------------------------------------------
// decayConfidence
// ---------------------------------------------------------------------------

describe("decayConfidence", () => {
  it("should not change confidence when no time elapsed", () => {
    assert.equal(decayConfidence(1.0, 0), 1.0);
    assert.equal(decayConfidence(0.2, 0), 0.2);
  });

  it("should decay confirmed confidence toward default over time", () => {
    const halfLife = CONFIDENCE_DECAY_HALF_LIFE_DAYS;
    const elapsed = halfLife * MS_PER_DAY;
    const decayed = decayConfidence(CONFIDENCE_STRONG, elapsed);
    // After one half-life: 0.5 + (1.0 - 0.5) * 0.5 = 0.75
    assert.ok(Math.abs(decayed - 0.75) < 0.01, `expected ~0.75, got ${decayed}`);
  });

  it("should decay corrected confidence back toward default", () => {
    const halfLife = CONFIDENCE_DECAY_HALF_LIFE_DAYS;
    const elapsed = halfLife * MS_PER_DAY;
    const decayed = decayConfidence(CONFIDENCE_CORRECTED, elapsed);
    // After one half-life: 0.5 + (0.2 - 0.5) * 0.5 = 0.35
    assert.ok(Math.abs(decayed - 0.35) < 0.01, `expected ~0.35, got ${decayed}`);
  });

  it("should not move if already at default", () => {
    const decayed = decayConfidence(CONFIDENCE_DEFAULT, 365 * MS_PER_DAY);
    assert.equal(decayed, CONFIDENCE_DEFAULT);
  });

  it("should stay clamped in [0, 1]", () => {
    // Even extreme values should never escape bounds
    assert.ok(decayConfidence(0.0, 1000 * MS_PER_DAY) >= 0);
    assert.ok(decayConfidence(1.0, 1000 * MS_PER_DAY) <= 1);
  });

  it("should handle negative elapsed gracefully", () => {
    assert.equal(decayConfidence(0.8, -100), 0.8);
  });
});

// ---------------------------------------------------------------------------
// buildDecayPatch
// ---------------------------------------------------------------------------

describe("buildDecayPatch", () => {
  it("should return null when decay is insignificant", () => {
    const now = Date.now();
    const result = buildDecayPatch(
      { confidence: 0.8 },
      now - MS_PER_DAY, // just 1 day ago — tiny decay
      now,
    );
    assert.equal(result, null);
  });

  it("should return a patch when decay is significant", () => {
    const now = Date.now();
    const result = buildDecayPatch(
      { confidence: 1.0 },
      now - 90 * MS_PER_DAY, // one full half-life
      now,
    );
    assert.notEqual(result, null);
    assert.ok(result.confidence < 1.0);
    assert.ok(Math.abs(result.confidence - 0.75) < 0.01);
    assert.equal(result.confidence_history.length, 1);
    assert.equal(result.confidence_history[0].action, "decayed");
  });

  it("should return null when already at default", () => {
    const now = Date.now();
    const result = buildDecayPatch(
      { confidence: CONFIDENCE_DEFAULT },
      now - 365 * MS_PER_DAY,
      now,
    );
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// applyConfidenceWeight
// ---------------------------------------------------------------------------

describe("applyConfidenceWeight", () => {
  it("should apply correct multiplier at confidence=1.0", () => {
    assert.equal(applyConfidenceWeight(1.0, 1.0), 1.0);
  });

  it("should apply correct multiplier at confidence=0.5", () => {
    assert.equal(applyConfidenceWeight(1.0, 0.5), 0.75);
  });

  it("should apply correct multiplier at confidence=0.0", () => {
    assert.equal(applyConfidenceWeight(1.0, 0.0), 0.5);
  });

  it("should scale the input score proportionally", () => {
    assert.equal(applyConfidenceWeight(2.0, 1.0), 2.0);
    assert.equal(applyConfidenceWeight(2.0, 0.0), 1.0);
  });

  it("should clamp out-of-range confidence", () => {
    assert.equal(applyConfidenceWeight(1.0, 1.5), 1.0);
    assert.equal(applyConfidenceWeight(1.0, -0.5), 0.5);
  });
});

// ---------------------------------------------------------------------------
// History cap
// ---------------------------------------------------------------------------

describe("history cap", () => {
  it("should cap history at 20 entries", () => {
    const metadata = {
      confidence: 0.5,
      confidence_history: Array.from({ length: 25 }, (_, i) => ({
        action: "confirmed",
        from: 0.5,
        to: 0.8,
        date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      })),
    };
    const patch = buildConfirmPatch(metadata);
    // 25 existing + 1 new = 26, capped to most recent 20
    assert.equal(patch.confidence_history.length, 20);
    // The newest entry should be the confirmation we just added
    assert.equal(patch.confidence_history[19].action, "confirmed");
  });
});
