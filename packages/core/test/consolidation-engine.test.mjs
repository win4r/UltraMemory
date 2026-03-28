import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { ConsolidationEngine, DEFAULT_CONSOLIDATION_CONFIG } = jiti(
  "../src/consolidation-engine.ts",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] ** 2;
    normB += b[i] ** 2;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

/**
 * Create a stub store backed by an in-memory array. vectorSearch uses
 * real cosine similarity so we can test threshold behaviour.
 */
function createStubStore(entries) {
  return {
    list: async (_scopeFilter, _category, limit, offset) =>
      entries
        .map((e) => ({ ...e, vector: [] })) // list() returns empty vectors
        .slice(offset, offset + limit),

    getById: async (id) => entries.find((e) => e.id === id) || null,

    vectorSearch: async (vector, limit, threshold, _scopeFilter, _opts) => {
      return entries
        .filter((e) => e.vector && e.vector.length > 0)
        .map((e) => ({
          entry: e,
          score: cosineSim(vector, e.vector),
        }))
        .filter((s) => s.score >= threshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },

    patchMetadata: async (id, patch) => {
      const entry = entries.find((e) => e.id === id);
      if (entry) {
        const meta = JSON.parse(entry.metadata || "{}");
        Object.assign(meta, patch);
        entry.metadata = JSON.stringify(meta);
      }
      return entry || null;
    },
  };
}

/** Build a minimal memory entry with sensible defaults. */
function makeEntry(overrides) {
  return {
    id: overrides.id || `m-${Math.random().toString(36).slice(2, 8)}`,
    text: overrides.text || "some memory text",
    vector: overrides.vector || [1, 0, 0],
    category: overrides.category || "fact",
    scope: overrides.scope || "global",
    importance: overrides.importance ?? 0.7,
    timestamp: overrides.timestamp || Date.now(),
    metadata: overrides.metadata || JSON.stringify({ memory_category: overrides.category || "fact" }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DEFAULT_CONSOLIDATION_CONFIG", () => {
  it("has expected default values", () => {
    assert.equal(DEFAULT_CONSOLIDATION_CONFIG.clusterThreshold, 0.82);
    assert.equal(DEFAULT_CONSOLIDATION_CONFIG.mergeThreshold, 0.92);
    assert.equal(DEFAULT_CONSOLIDATION_CONFIG.abstractionMinClusterSize, 5);
    assert.equal(DEFAULT_CONSOLIDATION_CONFIG.maxEntriesPerRun, 500);
  });
});

describe("ConsolidationEngine", () => {
  describe("empty corpus", () => {
    it("returns zeroed result for no entries", async () => {
      const store = createStubStore([]);
      const engine = new ConsolidationEngine(store);
      const result = await engine.run("global");

      assert.equal(result.originalCount, 0);
      assert.equal(result.clustersFound, 0);
      assert.equal(result.mergedCount, 0);
      assert.equal(result.relationsAdded, 0);
      assert.deepEqual(result.conflictsDetected, []);
      assert.equal(result.scope, "global");
    });
  });

  describe("single entry", () => {
    it("returns no clusters for a single entry", async () => {
      const entries = [makeEntry({ id: "m1", vector: [1, 0, 0] })];
      const store = createStubStore(entries);
      const engine = new ConsolidationEngine(store);
      const result = await engine.run("global");

      assert.equal(result.originalCount, 1);
      assert.equal(result.clustersFound, 0);
      assert.equal(result.mergedCount, 0);
    });
  });

  describe("merging", () => {
    it("merges entries with identical vectors (similarity = 1.0 > 0.92)", async () => {
      const entries = [
        makeEntry({ id: "m1", text: "user prefers vim", vector: [1, 0, 0], importance: 0.9 }),
        makeEntry({ id: "m2", text: "user prefers vim editor", vector: [1, 0, 0], importance: 0.5 }),
      ];
      const store = createStubStore(entries);
      const engine = new ConsolidationEngine(store);
      const result = await engine.run("global");

      assert.equal(result.mergedCount, 1);
      assert.equal(result.clustersFound, 1);

      // m2 (lower importance) should be archived with superseded_by pointing to m1
      const m2Meta = JSON.parse(entries[1].metadata);
      assert.equal(m2Meta.state, "archived");
      assert.equal(m2Meta.superseded_by, "m1");
      assert.equal(m2Meta.canonical_id, "m1");
    });

    it("selects canonical by importance * access_count", async () => {
      const entries = [
        makeEntry({
          id: "m1",
          text: "a fact",
          vector: [1, 0, 0],
          importance: 0.5,
          metadata: JSON.stringify({ memory_category: "fact", access_count: 10 }),
        }),
        makeEntry({
          id: "m2",
          text: "same fact",
          vector: [1, 0, 0],
          importance: 0.9,
          metadata: JSON.stringify({ memory_category: "fact", access_count: 0 }),
        }),
      ];
      const store = createStubStore(entries);
      const engine = new ConsolidationEngine(store);
      const result = await engine.run("global");

      assert.equal(result.mergedCount, 1);
      // m1 has score 0.5 * (1 + ln(11)) ≈ 0.5 * 3.4 = 1.7
      // m2 has score 0.9 * (1 + ln(1)) ≈ 0.9 * 1.0 = 0.9
      // m1 wins as canonical, m2 is archived
      const m2Meta = JSON.parse(entries[1].metadata);
      assert.equal(m2Meta.state, "archived");
      assert.equal(m2Meta.superseded_by, "m1");
    });
  });

  describe("linking (cluster without merge)", () => {
    it("adds clustered_with for entries between cluster and merge thresholds", async () => {
      // Vectors with cosine similarity ~0.87 (between 0.82 and 0.92)
      const v1 = [1, 0, 0, 0];
      const v2 = [0.87, 0.5, 0, 0]; // cos(v1, v2) ≈ 0.87
      const sim = cosineSim(v1, v2);
      // Verify our vectors produce the right similarity range
      assert.ok(sim >= 0.82 && sim < 0.92, `Expected sim 0.82-0.92 but got ${sim}`);

      const entries = [
        makeEntry({ id: "m1", text: "user likes python", vector: v1 }),
        makeEntry({ id: "m2", text: "user enjoys python programming", vector: v2 }),
      ];
      const store = createStubStore(entries);
      const engine = new ConsolidationEngine(store);
      const result = await engine.run("global");

      assert.equal(result.clustersFound, 1);
      assert.equal(result.mergedCount, 0);
      assert.equal(result.relationsAdded, 1);

      // Both entries should have clustered_with metadata
      const m1Meta = JSON.parse(entries[0].metadata);
      const m2Meta = JSON.parse(entries[1].metadata);
      assert.equal(m1Meta.clustered_with, "m2");
      assert.equal(m2Meta.clustered_with, "m1");
    });
  });

  describe("category boundaries", () => {
    it("does not cluster entries from different categories", async () => {
      const entries = [
        makeEntry({
          id: "m1",
          text: "likes coffee",
          vector: [1, 0, 0],
          category: "preference",
          metadata: JSON.stringify({ memory_category: "preference" }),
        }),
        makeEntry({
          id: "m2",
          text: "likes coffee a lot",
          vector: [1, 0, 0],
          category: "fact",
          metadata: JSON.stringify({ memory_category: "fact" }),
        }),
      ];
      const store = createStubStore(entries);
      const engine = new ConsolidationEngine(store);
      const result = await engine.run("global");

      assert.equal(result.clustersFound, 0);
      assert.equal(result.mergedCount, 0);
      assert.equal(result.relationsAdded, 0);
    });
  });

  describe("conflict detection", () => {
    it("detects heuristic contradictions within a cluster", async () => {
      const entries = [
        makeEntry({ id: "m1", text: "likes coffee", vector: [1, 0, 0] }),
        makeEntry({ id: "m2", text: "doesn't like coffee", vector: [1, 0, 0] }),
      ];
      const store = createStubStore(entries);
      const engine = new ConsolidationEngine(store);
      const result = await engine.run("global");

      assert.ok(result.conflictsDetected.length >= 1);
      const heuristic = result.conflictsDetected.find(
        (c) => c.type === "heuristic_contradiction",
      );
      assert.ok(heuristic, "Should detect heuristic contradiction");
      const ids = [heuristic.memoryA, heuristic.memoryB].sort();
      assert.deepEqual(ids, ["m1", "m2"]);
    });

    it("detects fact-key conflicts within a cluster", async () => {
      const entries = [
        makeEntry({
          id: "m1",
          text: "user prefers vim",
          vector: [1, 0, 0],
          metadata: JSON.stringify({ memory_category: "fact", fact_key: "pref:editor" }),
        }),
        makeEntry({
          id: "m2",
          text: "user prefers vscode",
          vector: [1, 0, 0],
          metadata: JSON.stringify({ memory_category: "fact", fact_key: "pref:editor" }),
        }),
      ];
      const store = createStubStore(entries);
      const engine = new ConsolidationEngine(store);
      const result = await engine.run("global");

      const fkConflict = result.conflictsDetected.find(
        (c) => c.type === "fact_key_conflict",
      );
      assert.ok(fkConflict, "Should detect fact-key conflict");
    });
  });

  describe("archived entries", () => {
    it("skips already-archived entries", async () => {
      const entries = [
        makeEntry({
          id: "m1",
          text: "active memory",
          vector: [1, 0, 0],
          metadata: JSON.stringify({ memory_category: "fact", state: "confirmed" }),
        }),
        makeEntry({
          id: "m2",
          text: "archived memory",
          vector: [1, 0, 0],
          metadata: JSON.stringify({ memory_category: "fact", state: "archived" }),
        }),
      ];
      const store = createStubStore(entries);
      const engine = new ConsolidationEngine(store);
      const result = await engine.run("global");

      // Only 1 active entry, so no clusters
      assert.equal(result.originalCount, 1);
      assert.equal(result.clustersFound, 0);
    });
  });

  describe("maxEntriesPerRun", () => {
    it("limits the number of entries scanned", async () => {
      const entries = [];
      for (let i = 0; i < 10; i++) {
        entries.push(
          makeEntry({
            id: `m${i}`,
            text: `memory ${i}`,
            vector: [1, 0, 0],
          }),
        );
      }
      const store = createStubStore(entries);
      const engine = new ConsolidationEngine(store, {
        ...DEFAULT_CONSOLIDATION_CONFIG,
        maxEntriesPerRun: 3,
      });
      const result = await engine.run("global");

      // Should only process 3 entries
      assert.equal(result.originalCount, 3);
    });
  });

  describe("result counts", () => {
    it("returns correct aggregate counts", async () => {
      // 2 identical entries (will merge) + 1 similar but not merge-worthy
      const v1 = [1, 0, 0, 0];
      const vSimilar = [0.87, 0.5, 0, 0]; // ~0.87 similarity
      const entries = [
        makeEntry({ id: "m1", text: "mem a", vector: v1, importance: 0.9 }),
        makeEntry({ id: "m2", text: "mem a dup", vector: v1, importance: 0.5 }),
        makeEntry({ id: "m3", text: "mem a related", vector: vSimilar, importance: 0.6 }),
      ];
      const store = createStubStore(entries);
      const engine = new ConsolidationEngine(store);
      const result = await engine.run("global");

      assert.equal(result.originalCount, 3);
      assert.equal(result.scope, "global");
      // At least 1 cluster found
      assert.ok(result.clustersFound >= 1);
      // m2 merged into m1
      assert.ok(result.mergedCount >= 1);
    });
  });

  describe("multiple categories", () => {
    it("clusters independently per category", async () => {
      const entries = [
        makeEntry({
          id: "pref1",
          text: "likes dark mode",
          vector: [1, 0, 0],
          category: "preference",
          metadata: JSON.stringify({ memory_category: "preference" }),
        }),
        makeEntry({
          id: "pref2",
          text: "likes dark theme",
          vector: [1, 0, 0],
          category: "preference",
          metadata: JSON.stringify({ memory_category: "preference" }),
        }),
        makeEntry({
          id: "fact1",
          text: "works at acme",
          vector: [0, 1, 0],
          category: "fact",
          metadata: JSON.stringify({ memory_category: "fact" }),
        }),
        makeEntry({
          id: "fact2",
          text: "employed at acme",
          vector: [0, 1, 0],
          category: "fact",
          metadata: JSON.stringify({ memory_category: "fact" }),
        }),
      ];
      const store = createStubStore(entries);
      const engine = new ConsolidationEngine(store);
      const result = await engine.run("global");

      // Two clusters: one in preference, one in fact
      assert.equal(result.clustersFound, 2);
      assert.equal(result.mergedCount, 2);
    });
  });
});
