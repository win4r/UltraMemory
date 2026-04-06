/**
 * Retroactive Boost Tests
 *
 * Verifies that high-importance new memories boost related older
 * low-importance entries, and respects all config thresholds.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../packages/core/src/store.ts");
const { retroactiveBoost, DEFAULT_RETROACTIVE_BOOST_CONFIG } = jiti(
  "../packages/core/src/retroactive-boost.ts",
);

const DIM = 4;

describe("retroactiveBoost", () => {
  let workDir;
  let store;

  beforeEach(async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "retro-boost-test-"));
    store = new MemoryStore({
      dbPath: path.join(workDir, "db"),
      vectorDim: DIM,
    });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  // Helper: store an entry with a specific timestamp in the past
  async function storeOldEntry(overrides = {}) {
    const base = {
      text: "old memory",
      vector: [1, 0, 0, 0],
      category: "fact",
      scope: "test",
      importance: 0.3,
      metadata: JSON.stringify({ tier: "peripheral" }),
      ...overrides,
    };
    const entry = await store.store(base);
    // Backdate the entry to make it old enough for boosting
    const twoDaysAgo = Date.now() - 2 * 86_400_000;
    await store.update(entry.id, { importance: base.importance }, ["test"]);
    // Use direct update to backdate timestamp (patchMetadata can't set timestamp)
    // We'll configure minAgeDays=0 in tests instead for simplicity
    return entry;
  }

  it("should skip when new entry importance is below threshold", async () => {
    const result = await retroactiveBoost(store, {
      id: "new-id",
      text: "low importance entry",
      vector: [1, 0, 0, 0],
      importance: 0.5, // below default threshold of 0.8
      scope: "test",
      timestamp: Date.now(),
    });

    assert.equal(result.triggered, false);
    assert.equal(result.reason, "below_importance_threshold");
    assert.equal(result.boostedCount, 0);
  });

  it("should skip when new entry has no vector", async () => {
    const result = await retroactiveBoost(store, {
      id: "new-id",
      text: "no vector",
      vector: [],
      importance: 0.9,
      scope: "test",
      timestamp: Date.now(),
    });

    assert.equal(result.triggered, false);
    assert.equal(result.reason, "no_vector");
  });

  it("should boost low-importance related entries", async () => {
    // Store an old low-importance entry with a similar vector
    const old = await store.store({
      text: "old related memory",
      vector: [0.9, 0.1, 0, 0],
      category: "fact",
      scope: "test",
      importance: 0.3,
      metadata: JSON.stringify({ tier: "peripheral" }),
    });

    // Trigger boost with a high-importance entry and similar vector
    const config = {
      ...DEFAULT_RETROACTIVE_BOOST_CONFIG,
      triggerImportanceMin: 0.8,
      similarityThreshold: 0.1, // low threshold for test vectors
      minAgeDays: 0, // disable age check for tests
    };

    const result = await retroactiveBoost(
      store,
      {
        id: "new-high-importance",
        text: "important new memory",
        vector: [1, 0, 0, 0],
        importance: 0.9,
        scope: "test",
        timestamp: Date.now(),
      },
      config,
    );

    assert.equal(result.triggered, true);
    assert.equal(result.boostedCount, 1);
    assert.ok(result.boostedIds.includes(old.id));

    // Verify the old entry was updated
    const updated = await store.getById(old.id);
    assert.ok(updated.importance > 0.3, `Expected importance > 0.3, got ${updated.importance}`);
    assert.ok(
      updated.importance <= config.maxBoostedImportance,
      `Expected importance <= ${config.maxBoostedImportance}, got ${updated.importance}`,
    );

    // Verify audit trail in metadata
    const meta = JSON.parse(updated.metadata);
    assert.ok(Array.isArray(meta.stc_boosts), "Should have stc_boosts array");
    assert.equal(meta.stc_boosts.length, 1);
    assert.equal(meta.stc_boosts[0].from, 0.3);
    assert.equal(meta.stc_boosts[0].to, 0.3 + config.boostAmount);
  });

  it("should not boost entries already above candidate threshold", async () => {
    await store.store({
      text: "already important memory",
      vector: [0.9, 0.1, 0, 0],
      category: "fact",
      scope: "test",
      importance: 0.7, // above default boostCandidateMaxImportance (0.6)
    });

    const config = {
      ...DEFAULT_RETROACTIVE_BOOST_CONFIG,
      similarityThreshold: 0.1,
      minAgeDays: 0,
    };

    const result = await retroactiveBoost(
      store,
      {
        id: "new-id",
        text: "trigger memory",
        vector: [1, 0, 0, 0],
        importance: 0.9,
        scope: "test",
        timestamp: Date.now(),
      },
      config,
    );

    assert.equal(result.triggered, true);
    assert.equal(result.boostedCount, 0);
  });

  it("should not boost entries in different scopes", async () => {
    await store.store({
      text: "other scope memory",
      vector: [0.9, 0.1, 0, 0],
      category: "fact",
      scope: "other-scope",
      importance: 0.2,
    });

    const config = {
      ...DEFAULT_RETROACTIVE_BOOST_CONFIG,
      similarityThreshold: 0.1,
      minAgeDays: 0,
    };

    const result = await retroactiveBoost(
      store,
      {
        id: "new-id",
        text: "trigger memory",
        vector: [1, 0, 0, 0],
        importance: 0.9,
        scope: "test", // different scope
        timestamp: Date.now(),
      },
      config,
    );

    assert.equal(result.triggered, true);
    assert.equal(result.boostedCount, 0);
  });

  it("should cap boosted importance at maxBoostedImportance", async () => {
    const old = await store.store({
      text: "entry near ceiling",
      vector: [0.9, 0.1, 0, 0],
      category: "fact",
      scope: "test",
      importance: 0.55, // below 0.6 candidate max
    });

    const config = {
      ...DEFAULT_RETROACTIVE_BOOST_CONFIG,
      boostAmount: 0.5, // would push to 1.05 without cap
      maxBoostedImportance: 0.75,
      similarityThreshold: 0.1,
      minAgeDays: 0,
    };

    const result = await retroactiveBoost(
      store,
      {
        id: "new-id",
        text: "trigger memory",
        vector: [1, 0, 0, 0],
        importance: 0.9,
        scope: "test",
        timestamp: Date.now(),
      },
      config,
    );

    assert.equal(result.boostedCount, 1);

    const updated = await store.getById(old.id);
    assert.equal(
      updated.importance,
      config.maxBoostedImportance,
      `Importance should be capped at ${config.maxBoostedImportance}`,
    );
  });

  it("should respect maxBoostPerTrigger limit", async () => {
    // Store more candidates than the limit
    for (let i = 0; i < 5; i++) {
      await store.store({
        text: `low importance memory ${i}`,
        vector: [0.9 + i * 0.01, 0.1, 0, 0],
        category: "fact",
        scope: "test",
        importance: 0.2,
      });
    }

    const config = {
      ...DEFAULT_RETROACTIVE_BOOST_CONFIG,
      maxBoostPerTrigger: 2,
      similarityThreshold: 0.1,
      minAgeDays: 0,
    };

    const result = await retroactiveBoost(
      store,
      {
        id: "new-id",
        text: "trigger memory",
        vector: [1, 0, 0, 0],
        importance: 0.9,
        scope: "test",
        timestamp: Date.now(),
      },
      config,
    );

    assert.equal(result.triggered, true);
    assert.ok(
      result.boostedCount <= config.maxBoostPerTrigger,
      `Expected at most ${config.maxBoostPerTrigger} boosts, got ${result.boostedCount}`,
    );
  });

  it("should promote tier from peripheral to working when boosted above 0.5", async () => {
    const old = await store.store({
      text: "peripheral tier memory",
      vector: [0.9, 0.1, 0, 0],
      category: "fact",
      scope: "test",
      importance: 0.3,
      metadata: JSON.stringify({ tier: "peripheral" }),
    });

    const config = {
      ...DEFAULT_RETROACTIVE_BOOST_CONFIG,
      boostAmount: 0.25, // 0.3 + 0.25 = 0.55, above 0.5
      similarityThreshold: 0.1,
      minAgeDays: 0,
    };

    const result = await retroactiveBoost(
      store,
      {
        id: "new-id",
        text: "trigger memory",
        vector: [1, 0, 0, 0],
        importance: 0.9,
        scope: "test",
        timestamp: Date.now(),
      },
      config,
    );

    assert.equal(result.boostedCount, 1);

    const updated = await store.getById(old.id);
    const meta = JSON.parse(updated.metadata);
    assert.equal(meta.tier, "working", "Tier should be promoted to working");
  });

  it("should use default config when none provided", async () => {
    // Just verify it doesn't throw with default config
    const result = await retroactiveBoost(store, {
      id: "new-id",
      text: "test memory",
      vector: [1, 0, 0, 0],
      importance: 0.9,
      scope: "test",
      timestamp: Date.now(),
    });

    assert.equal(result.triggered, true);
    assert.equal(typeof result.boostedCount, "number");
  });
});
