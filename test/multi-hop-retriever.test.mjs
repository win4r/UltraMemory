import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const {
  extractEntitiesFromTexts,
  multiHopRetrieve,
  DEFAULT_MULTI_HOP_CONFIG,
} = jiti("../packages/core/src/multi-hop-retriever.ts");

// ============================================================================
// Test helpers
// ============================================================================

function makeEntry(id, text, opts = {}) {
  return {
    id,
    text,
    vector: new Array(384).fill(0.1),
    category: opts.category ?? "fact",
    scope: opts.scope ?? "global",
    importance: opts.importance ?? 5,
    timestamp: opts.timestamp ?? Date.now(),
    metadata: opts.metadata ?? "{}",
  };
}

/**
 * Create a mock store.
 * vectorResults / bm25Results are arrays returned from each search.
 * Supports per-call override via callIndex tracking.
 */
function createMockStore(opts = {}) {
  const vectorCalls = [];
  const bm25Calls = [];
  let vectorCallIndex = 0;
  let bm25CallIndex = 0;

  // vectorResultSets: array of result arrays, one per call
  const vectorResultSets = opts.vectorResultSets ?? [opts.vectorResults ?? []];
  const bm25ResultSets = opts.bm25ResultSets ?? [opts.bm25Results ?? []];

  return {
    hasFtsSupport: opts.hasFtsSupport ?? true,
    vectorCalls,
    bm25Calls,
    async vectorSearch(vector, limit, minScore, scopeFilter) {
      vectorCalls.push({ vector, limit, minScore, scopeFilter });
      const idx = Math.min(vectorCallIndex, vectorResultSets.length - 1);
      vectorCallIndex++;
      return vectorResultSets[idx].slice(0, limit);
    },
    async bm25Search(query, limit, scopeFilter) {
      bm25Calls.push({ query, limit, scopeFilter });
      const idx = Math.min(bm25CallIndex, bm25ResultSets.length - 1);
      bm25CallIndex++;
      return bm25ResultSets[idx].slice(0, limit);
    },
  };
}

function createMockEmbedder(opts = {}) {
  const calls = [];
  return {
    calls,
    async embedQuery(text) {
      calls.push(text);
      return new Array(opts.dim ?? 384).fill(0.1);
    },
  };
}

// ============================================================================
// extractEntitiesFromTexts
// ============================================================================

describe("extractEntitiesFromTexts", () => {
  it("should extract capitalized entities", () => {
    const entities = extractEntitiesFromTexts([
      "Alice uses LanceDB for vector storage",
      "Bob prefers LanceDB over Pinecone",
    ]);
    assert.ok(entities.includes("Alice"), "should find Alice");
    assert.ok(entities.includes("LanceDB"), "should find LanceDB");
    assert.ok(entities.includes("Bob"), "should find Bob");
    assert.ok(entities.includes("Pinecone"), "should find Pinecone");
  });

  it("should extract quoted terms", () => {
    const entities = extractEntitiesFromTexts([
      'The project uses "memory-lancedb-pro" as the core engine',
    ]);
    assert.ok(
      entities.includes("memory-lancedb-pro"),
      "should find quoted term",
    );
  });

  it("should extract file paths", () => {
    const entities = extractEntitiesFromTexts([
      "Edit the file at /src/retriever.ts to add multi-hop",
      "Also check ./packages/core/src/store.ts",
    ]);
    assert.ok(
      entities.some((e) => e.includes("/src/retriever.ts")),
      "should find absolute path",
    );
    assert.ok(
      entities.some((e) => e.includes("./packages/core")),
      "should find relative path",
    );
  });

  it("should extract URLs", () => {
    const entities = extractEntitiesFromTexts([
      "See https://github.com/win4r/UltraMemory for the repo",
    ]);
    assert.ok(
      entities.some((e) => e.startsWith("https://github.com")),
      "should find URL",
    );
  });

  it("should extract CJK entities and filter CJK stop words", () => {
    // CJK regex captures 2-8 consecutive Han characters as a single token.
    // Use natural separators (punctuation, Latin chars) to create boundaries.
    const entities = extractEntitiesFromTexts([
      "用户 张三 提交了 LanceDB 的配置",
      "因为 需要 更新",
    ]);
    assert.ok(entities.includes("张三"), "should find CJK name with boundary");
    // Stop words that appear as standalone 2-char tokens should be filtered
    assert.ok(!entities.includes("用户"), "should filter CJK stop word 用户");
    assert.ok(!entities.includes("因为"), "should filter CJK stop word 因为");
    assert.ok(!entities.includes("需要"), "should filter CJK stop word 需要");
    // Non-stop CJK tokens should be kept
    assert.ok(entities.includes("LanceDB"), "should find Latin entity in mixed text");
  });

  it("should filter English stop words", () => {
    const entities = extractEntitiesFromTexts(["The user was very happy"]);
    assert.ok(!entities.includes("The"), "should filter stop word 'The'");
  });

  it("should sort by frequency descending", () => {
    const entities = extractEntitiesFromTexts([
      "LanceDB is great. Alice likes LanceDB. Bob likes LanceDB too.",
      "Alice also uses Pinecone.",
    ]);
    // LanceDB appears 3 times, Alice 2 times
    assert.equal(entities[0], "LanceDB", "most frequent entity first");
  });

  it("should return empty for empty input", () => {
    assert.deepEqual(extractEntitiesFromTexts([]), []);
    assert.deepEqual(extractEntitiesFromTexts([""]), []);
  });
});

// ============================================================================
// multiHopRetrieve
// ============================================================================

describe("multiHopRetrieve", () => {
  it("should return empty array when round-1 finds nothing", async () => {
    const store = createMockStore({
      vectorResults: [],
      bm25Results: [],
    });
    const embedder = createMockEmbedder();

    const results = await multiHopRetrieve(store, embedder, "nothing here");
    assert.deepEqual(results, []);
  });

  it("should return round-1 results when no novel entities found", async () => {
    // Query already contains the entity name, so no novel entities
    const entry = makeEntry("1", "LanceDB vector storage engine");
    const store = createMockStore({
      vectorResults: [{ entry, score: 0.9 }],
      bm25Results: [],
    });
    const embedder = createMockEmbedder();

    const results = await multiHopRetrieve(
      store,
      embedder,
      "LanceDB storage",
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].entry.id, "1");
    assert.equal(results[0].source, "round1");
  });

  it("should perform round-2 queries for novel entities", async () => {
    const entry1 = makeEntry("1", "Alice prefers PostgreSQL for metadata");
    const entry2 = makeEntry(
      "2",
      "PostgreSQL configuration for production use",
    );

    const store = createMockStore({
      // Round 1: returns entry1
      vectorResultSets: [
        [{ entry: entry1, score: 0.85 }],
        // Round 2: returns entry2 (new finding)
        [{ entry: entry2, score: 0.75 }],
      ],
      bm25ResultSets: [[], []],
    });
    const embedder = createMockEmbedder();

    const results = await multiHopRetrieve(store, embedder, "database setup");
    assert.ok(results.length >= 2, "should have results from both rounds");

    const ids = results.map((r) => r.entry.id);
    assert.ok(ids.includes("1"), "should include round-1 result");
    assert.ok(ids.includes("2"), "should include round-2 result");
  });

  it("should deduplicate by ID across rounds (keep higher score)", async () => {
    const entry = makeEntry("1", "Alice uses LanceDB for retrieval");

    const store = createMockStore({
      // Round 1: lower score
      vectorResultSets: [
        [{ entry, score: 0.6 }],
        // Round 2: higher score for same entry
        [{ entry, score: 0.9 }],
      ],
      bm25ResultSets: [[], []],
    });
    const embedder = createMockEmbedder();

    const results = await multiHopRetrieve(store, embedder, "retrieval");
    // Should appear once with the higher score and "both" source
    const matches = results.filter((r) => r.entry.id === "1");
    assert.equal(matches.length, 1, "should deduplicate");
    assert.equal(matches[0].score, 0.9, "should keep higher score");
    assert.equal(matches[0].source, "both", "should mark as both");
  });

  it("should mark source correctly for round-2-only results", async () => {
    const entry1 = makeEntry("1", "Alice prefers PostgreSQL");
    const entry2 = makeEntry("2", "PostgreSQL cluster setup guide");

    const store = createMockStore({
      vectorResultSets: [
        [{ entry: entry1, score: 0.8 }],
        [{ entry: entry2, score: 0.7 }],
      ],
      bm25ResultSets: [[], []],
    });
    const embedder = createMockEmbedder();

    const results = await multiHopRetrieve(store, embedder, "database");
    const r2Only = results.find((r) => r.entry.id === "2");
    assert.ok(r2Only, "should find round-2 result");
    assert.equal(r2Only.source, "round2", "should be marked round2");
  });

  it("should respect maxRound2Entities config", async () => {
    const entry = makeEntry(
      "1",
      "Alice and Bob and Charlie and Diana and Eve discussed the project",
    );

    const store = createMockStore({
      vectorResultSets: [[{ entry, score: 0.8 }], [], []],
      bm25ResultSets: [[], [], []],
    });
    const embedder = createMockEmbedder();

    await multiHopRetrieve(store, embedder, "discussion", {
      maxRound2Entities: 2,
    });

    // Round 1 = 1 embedQuery call, then at most 2 entity calls
    // Each entity call = 1 embedQuery
    assert.ok(
      embedder.calls.length <= 3,
      "should make at most 3 embed calls (1 round-1 + 2 entity), got " +
        embedder.calls.length,
    );
  });

  it("should pass scopeFilter to both rounds", async () => {
    const entry = makeEntry("1", "Alice uses LanceDB", {
      scope: "proj:test",
    });

    const store = createMockStore({
      vectorResultSets: [
        [{ entry, score: 0.8 }],
        [{ entry, score: 0.7 }],
      ],
      bm25ResultSets: [[], []],
    });
    const embedder = createMockEmbedder();

    await multiHopRetrieve(store, embedder, "database", {
      scopeFilter: ["proj:test"],
    });

    // All vectorSearch calls should have the scope filter
    for (const call of store.vectorCalls) {
      assert.deepEqual(call.scopeFilter, ["proj:test"]);
    }
  });

  it("should skip bm25 when FTS not supported", async () => {
    const entry = makeEntry("1", "Alice uses PostgreSQL");

    const store = createMockStore({
      hasFtsSupport: false,
      vectorResultSets: [[{ entry, score: 0.8 }], []],
      bm25ResultSets: [[], []],
    });
    const embedder = createMockEmbedder();

    const results = await multiHopRetrieve(store, embedder, "database");
    assert.equal(store.bm25Calls.length, 0, "should not call bm25Search");
    assert.ok(results.length >= 1, "should still return vector results");
  });

  it("should gracefully handle round-2 failures", async () => {
    const entry = makeEntry("1", "Alice uses PostgreSQL");
    let callCount = 0;

    const store = {
      hasFtsSupport: true,
      async vectorSearch() {
        callCount++;
        if (callCount === 1) {
          return [{ entry, score: 0.8 }];
        }
        throw new Error("simulated failure");
      },
      async bm25Search() {
        return [];
      },
    };
    const embedder = createMockEmbedder();

    const results = await multiHopRetrieve(store, embedder, "database");
    // Should still return round-1 results despite round-2 failure
    assert.ok(results.length >= 1, "should return round-1 results on failure");
    assert.equal(results[0].source, "round1");
  });

  it("should sort final results by score descending", async () => {
    const entry1 = makeEntry("1", "Alice uses LanceDB for production");
    const entry2 = makeEntry(
      "2",
      "LanceDB benchmark results show high throughput",
    );
    const entry3 = makeEntry(
      "3",
      "Production database monitoring setup guide",
    );

    const store = createMockStore({
      vectorResultSets: [
        [
          { entry: entry1, score: 0.7 },
          { entry: entry2, score: 0.9 },
        ],
        [{ entry: entry3, score: 0.5 }],
      ],
      bm25ResultSets: [[], []],
    });
    const embedder = createMockEmbedder();

    const results = await multiHopRetrieve(store, embedder, "database");
    for (let i = 1; i < results.length; i++) {
      assert.ok(
        results[i - 1].score >= results[i].score,
        "results[" +
          (i - 1) +
          "].score (" +
          results[i - 1].score +
          ") >= results[" +
          i +
          "].score (" +
          results[i].score +
          ")",
      );
    }
  });
});
