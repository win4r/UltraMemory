import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const {
  AutoConsolidation,
  DEFAULT_AUTO_CONSOLIDATION_CONFIG,
} = jiti("../packages/core/src/auto-consolidation.ts");

// ============================================================================
// Mock store — minimal duck-typed interface for ConsolidationEngine
// ============================================================================

function createMockStore() {
  return {
    _entries: /** @type {Map<string, object>} */ (new Map()),
    _listCalls: 0,

    async list(_scopeFilter, _category, _limit, _offset) {
      this._listCalls++;
      return [...this._entries.values()];
    },
    async getById(id) {
      return this._entries.get(id) ?? null;
    },
    async vectorSearch(_vector, _limit, _minScore, _scopeFilter, _options) {
      return [];
    },
    async patchMetadata(id, patch) {
      const entry = this._entries.get(id);
      if (!entry) return null;
      const meta = JSON.parse(/** @type {any} */ (entry).metadata || "{}");
      Object.assign(meta, patch);
      /** @type {any} */ (entry).metadata = JSON.stringify(meta);
      return entry;
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("AutoConsolidation", () => {
  /** @type {ReturnType<typeof createMockStore>} */
  let store;
  /** @type {InstanceType<typeof AutoConsolidation>} */
  let auto;

  beforeEach(() => {
    store = createMockStore();
  });

  describe("default config", () => {
    it("exports sensible defaults", () => {
      assert.strictEqual(DEFAULT_AUTO_CONSOLIDATION_CONFIG.minWritesSinceLastRun, 50);
      assert.strictEqual(DEFAULT_AUTO_CONSOLIDATION_CONFIG.minMsSinceLastRun, 3_600_000);
      assert.ok(DEFAULT_AUTO_CONSOLIDATION_CONFIG.consolidation);
    });
  });

  describe("insufficient_writes gate", () => {
    it("does not trigger when write count is below threshold", async () => {
      auto = new AutoConsolidation(store, { minWritesSinceLastRun: 3, minMsSinceLastRun: 0 });

      const r1 = await auto.maybeConsolidate("test-scope");
      assert.strictEqual(r1.triggered, false);
      assert.strictEqual(r1.reason, "insufficient_writes");
      assert.strictEqual(auto.writeCount, 1);

      const r2 = await auto.maybeConsolidate("test-scope");
      assert.strictEqual(r2.triggered, false);
      assert.strictEqual(r2.reason, "insufficient_writes");
      assert.strictEqual(auto.writeCount, 2);
    });
  });

  describe("too_soon gate", () => {
    it("does not trigger when not enough time has passed", async () => {
      // Set write threshold to 1 so it passes immediately, but time to 1 hour
      auto = new AutoConsolidation(store, {
        minWritesSinceLastRun: 1,
        minMsSinceLastRun: 3_600_000,
      });

      // First call: lastRunTimestamp is 0, so elapsed = Date.now() - 0 > 1h → triggers
      const r1 = await auto.maybeConsolidate("test-scope");
      assert.strictEqual(r1.triggered, true);

      // Second call: just ran, so elapsed < 1h → too_soon
      const r2 = await auto.maybeConsolidate("test-scope");
      assert.strictEqual(r2.triggered, false);
      assert.strictEqual(r2.reason, "too_soon");
    });
  });

  describe("dual threshold — triggers consolidation", () => {
    it("triggers when both write count and time thresholds are exceeded", async () => {
      auto = new AutoConsolidation(store, {
        minWritesSinceLastRun: 2,
        minMsSinceLastRun: 0, // no time gate for this test
      });

      // First write — not enough writes yet
      const r1 = await auto.maybeConsolidate("test-scope");
      assert.strictEqual(r1.triggered, false);

      // Second write — threshold met, should trigger
      const r2 = await auto.maybeConsolidate("test-scope");
      assert.strictEqual(r2.triggered, true);
      assert.ok(r2.consolidation);
      assert.strictEqual(r2.consolidation.scope, "test-scope");
      assert.strictEqual(typeof r2.consolidation.mergedCount, "number");

      // After trigger, counters reset — next call should not trigger
      const r3 = await auto.maybeConsolidate("test-scope");
      assert.strictEqual(r3.triggered, false);
      assert.strictEqual(r3.reason, "insufficient_writes");
    });
  });

  describe("consolidation result shape", () => {
    it("returns full ConsolidationResult when triggered", async () => {
      // Seed some entries so consolidation has data to process
      store._entries.set("a", {
        id: "a",
        text: "hello world",
        vector: [1, 0, 0],
        category: "fact",
        scope: "s",
        importance: 0.5,
        timestamp: Date.now(),
        metadata: "{}",
      });
      store._entries.set("b", {
        id: "b",
        text: "hello earth",
        vector: [1, 0, 0],
        category: "fact",
        scope: "s",
        importance: 0.3,
        timestamp: Date.now(),
        metadata: "{}",
      });

      auto = new AutoConsolidation(store, {
        minWritesSinceLastRun: 1,
        minMsSinceLastRun: 0,
      });

      const r = await auto.maybeConsolidate("s");
      assert.strictEqual(r.triggered, true);

      const c = r.consolidation;
      assert.ok(c);
      assert.strictEqual(typeof c.originalCount, "number");
      assert.strictEqual(typeof c.clustersFound, "number");
      assert.strictEqual(typeof c.mergedCount, "number");
      assert.strictEqual(typeof c.relationsAdded, "number");
      assert.ok(Array.isArray(c.conflictsDetected));
      assert.strictEqual(c.scope, "s");
    });
  });

  describe("reset()", () => {
    it("resets internal state", async () => {
      auto = new AutoConsolidation(store, {
        minWritesSinceLastRun: 5,
        minMsSinceLastRun: 0,
      });

      // Accumulate some writes
      await auto.maybeConsolidate("s");
      await auto.maybeConsolidate("s");
      assert.strictEqual(auto.writeCount, 2);

      auto.reset();
      assert.strictEqual(auto.writeCount, 0);
      assert.strictEqual(auto.lastRunTime, 0);
    });
  });

  describe("concurrent run guard", () => {
    it("prevents re-entrant consolidation", async () => {
      // Create a slow store that delays list() to simulate a long-running consolidation
      let resolveList;
      const slowStore = {
        ...createMockStore(),
        async list() {
          return new Promise((resolve) => {
            resolveList = () => resolve([]);
          });
        },
      };

      auto = new AutoConsolidation(slowStore, {
        minWritesSinceLastRun: 1,
        minMsSinceLastRun: 0,
      });

      // Start first consolidation (will hang on list)
      const p1 = auto.maybeConsolidate("s");

      // Try a second one immediately — should get already_running
      // Need enough writes to pass the write gate
      const r2 = await auto.maybeConsolidate("s");
      assert.strictEqual(r2.triggered, false);
      assert.strictEqual(r2.reason, "already_running");

      // Unblock the first consolidation
      resolveList();
      const r1 = await p1;
      assert.strictEqual(r1.triggered, true);
    });
  });

  describe("custom consolidation config passthrough", () => {
    it("passes consolidation config to the engine", async () => {
      auto = new AutoConsolidation(store, {
        minWritesSinceLastRun: 1,
        minMsSinceLastRun: 0,
        consolidation: {
          clusterThreshold: 0.90,
          mergeThreshold: 0.95,
          abstractionMinClusterSize: 10,
          maxEntriesPerRun: 100,
        },
      });

      // Just verify it doesn't throw with custom config
      const r = await auto.maybeConsolidate("s");
      assert.strictEqual(r.triggered, true);
    });
  });
});
