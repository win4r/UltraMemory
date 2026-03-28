import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { computeCorpusHealth } = jiti("../src/eval/corpus-health.ts");

// Helper: build a minimal MemoryEntry-like object with metadata JSON
function makeEntry(overrides = {}) {
  const now = Date.now();
  const defaults = {
    id: `e-${Math.random().toString(36).slice(2, 8)}`,
    text: "test memory",
    category: "fact",
    importance: 0.7,
    timestamp: now,
    metadata: JSON.stringify({
      state: "confirmed",
      source: "manual",
      memory_category: "cases",
      tier: "working",
      confidence: 0.8,
      access_count: 5,
      feedback_weight: 0.6,
    }),
  };
  return { ...defaults, ...overrides };
}

describe("computeCorpusHealth", () => {
  it("computes health from entries with mixed active/archived states", () => {
    const now = Date.now();
    const sixtyOneDaysAgo = now - 61 * 24 * 60 * 60 * 1000;

    const entries = [
      // Active entry: high importance, manual source
      makeEntry({
        id: "a1",
        importance: 0.9,
        metadata: JSON.stringify({
          state: "confirmed",
          source: "manual",
          memory_category: "profile",
          tier: "core",
          confidence: 0.95,
          access_count: 10,
          feedback_weight: 0.8,
        }),
      }),
      // Active entry: auto-capture source, stale candidate (old, low access, low importance)
      makeEntry({
        id: "a2",
        importance: 0.3,
        timestamp: sixtyOneDaysAgo,
        metadata: JSON.stringify({
          state: "confirmed",
          source: "auto-capture",
          memory_category: "cases",
          tier: "peripheral",
          confidence: 0.5,
          access_count: 1,
          feedback_weight: 0.4,
        }),
      }),
      // Active entry with conflict
      makeEntry({
        id: "a3",
        importance: 0.7,
        metadata: JSON.stringify({
          state: "confirmed",
          source: "manual",
          memory_category: "preferences",
          tier: "working",
          confidence: 0.7,
          access_count: 3,
          feedback_weight: 0.5,
          conflict_with: "a4",
        }),
      }),
      // Archived entry
      makeEntry({
        id: "a4",
        importance: 0.6,
        metadata: JSON.stringify({
          state: "archived",
          source: "reflection",
          memory_category: "patterns",
          tier: "peripheral",
          confidence: 0.6,
          access_count: 2,
          feedback_weight: 0.3,
        }),
      }),
      // Active entry: duplicate canonical_id
      makeEntry({
        id: "a5",
        importance: 0.5,
        metadata: JSON.stringify({
          state: "confirmed",
          source: "auto-capture",
          memory_category: "entities",
          tier: "working",
          confidence: 0.65,
          access_count: 4,
          feedback_weight: 0.55,
          canonical_id: "a1",
        }),
      }),
    ];

    const health = computeCorpusHealth(entries);

    // Counts
    assert.equal(health.totalActive, 4, "4 active (non-archived) entries");
    assert.equal(health.totalArchived, 1, "1 archived entry");

    // Category distribution: profile=1, cases=1, preferences=1, patterns=1, entities=1
    assert.equal(health.categoryDistribution.profile, 1);
    assert.equal(health.categoryDistribution.cases, 1);
    assert.equal(health.categoryDistribution.preferences, 1);
    assert.equal(health.categoryDistribution.patterns, 1);
    assert.equal(health.categoryDistribution.entities, 1);

    // Source distribution: manual=2, auto-capture=2, reflection=1
    assert.equal(health.sourceDistribution.manual, 2);
    assert.equal(health.sourceDistribution["auto-capture"], 2);
    assert.equal(health.sourceDistribution.reflection, 1);

    // Tier distribution: core=1, working=2, peripheral=2
    assert.equal(health.tierDistribution.core, 1);
    assert.equal(health.tierDistribution.working, 2);
    assert.equal(health.tierDistribution.peripheral, 2);

    // Averages (active entries only: a1, a2, a3, a5)
    // avgImportance: (0.9 + 0.3 + 0.7 + 0.5) / 4 = 0.6
    assert.ok(
      Math.abs(health.avgImportance - 0.6) < 0.001,
      `avgImportance expected ~0.6, got ${health.avgImportance}`,
    );
    // avgConfidence: (0.95 + 0.5 + 0.7 + 0.65) / 4 = 0.7
    assert.ok(
      Math.abs(health.avgConfidence - 0.7) < 0.001,
      `avgConfidence expected ~0.7, got ${health.avgConfidence}`,
    );
    // avgFeedbackWeight: (0.8 + 0.4 + 0.5 + 0.55) / 4 = 0.5625
    assert.ok(
      Math.abs(health.avgFeedbackWeight - 0.5625) < 0.001,
      `avgFeedbackWeight expected ~0.5625, got ${health.avgFeedbackWeight}`,
    );

    // Stale count: a2 is stale (age > 60d, access_count=1 < 2, importance=0.3 < 0.5)
    assert.equal(health.staleCount, 1, "1 stale entry (a2)");

    // Conflict count: a3 has conflict_with
    assert.equal(health.conflictCount, 1, "1 conflicting entry");

    // Auto-capture %: 2 auto-capture out of 5 total = 40%
    assert.ok(
      Math.abs(health.autoCapturePct - 0.4) < 0.001,
      `autoCapturePct expected ~0.4, got ${health.autoCapturePct}`,
    );

    // Duplicate rate: a5 has canonical_id pointing to a1 => 1 duplicate out of 5
    assert.ok(
      Math.abs(health.duplicateRate - 0.2) < 0.001,
      `duplicateRate expected ~0.2, got ${health.duplicateRate}`,
    );
  });

  it("handles empty corpus (all zeros)", () => {
    const health = computeCorpusHealth([]);

    assert.equal(health.totalActive, 0);
    assert.equal(health.totalArchived, 0);
    assert.deepEqual(health.categoryDistribution, {});
    assert.deepEqual(health.sourceDistribution, {});
    assert.deepEqual(health.tierDistribution, {});
    assert.equal(health.avgImportance, 0);
    assert.equal(health.avgConfidence, 0);
    assert.equal(health.avgFeedbackWeight, 0);
    assert.equal(health.staleCount, 0);
    assert.equal(health.conflictCount, 0);
    assert.equal(health.autoCapturePct, 0);
    assert.equal(health.duplicateRate, 0);
  });
});
