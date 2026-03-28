import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { IngestionPipeline } = jiti("../src/ingestion-pipeline.ts");

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function createStubStore(entries = []) {
  const stored = [];
  return {
    store: async (entry) => {
      stored.push(entry);
      return { ...entry, id: "new-id", timestamp: Date.now() };
    },
    vectorSearch: async () => [],
    getById: async (id) => entries.find((e) => e.id === id) || null,
    patchMetadata: async () => null,
    list: async () => entries,
    _stored: stored,
  };
}

function createStubEmbedder() {
  return {
    embedPassage: async () => new Array(8).fill(0.1),
    embedBatchPassage: async (texts) => texts.map(() => new Array(8).fill(0.1)),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IngestionPipeline", () => {
  it("stores a new memory with uniform metadata", async () => {
    const store = createStubStore();
    const embedder = createStubEmbedder();
    const pipeline = new IngestionPipeline({ store, embedder });

    const result = await pipeline.ingest({
      text: "user prefers dark mode in all editors",
      category: "preferences",
      importance: 0.9,
      scope: "agent:test",
      source: "manual",
    });

    assert.equal(result.action, "created");
    assert.equal(result.id, "new-id");
    assert.equal(typeof result.relationsAdded, "number");

    // Verify stored entry metadata
    const entry = store._stored[0];
    assert.ok(entry, "entry should be stored");
    const meta = JSON.parse(entry.metadata);
    assert.equal(meta.source, "manual");
    assert.equal(meta.trust_level, "source");
    assert.equal(typeof meta.valid_from, "number");
    assert.ok(meta.valid_from > 0);
    assert.equal(meta.memory_category, "preferences");
  });

  it("filters noise (short text)", async () => {
    const store = createStubStore();
    const embedder = createStubEmbedder();
    const pipeline = new IngestionPipeline({ store, embedder });

    const result = await pipeline.ingest({
      text: "hi",
      category: "preferences",
      importance: 0.5,
      scope: "agent:test",
      source: "manual",
    });

    assert.equal(result.action, "noise_filtered");
    assert.equal(store._stored.length, 0);
  });

  it("deduplicates high-similarity entries", async () => {
    const store = createStubStore();
    const embedder = createStubEmbedder();
    const pipeline = new IngestionPipeline({ store, embedder });

    // Override vectorSearch to return a near-duplicate
    store.vectorSearch = async () => [
      {
        entry: {
          id: "existing",
          text: "user prefers dark mode",
          category: "preference",
          scope: "global",
          importance: 0.8,
          timestamp: Date.now(),
          metadata: "{}",
        },
        score: 0.99,
      },
    ];

    const result = await pipeline.ingest({
      text: "user prefers dark mode in editors",
      category: "preferences",
      importance: 0.8,
      scope: "global",
      source: "manual",
    });

    assert.equal(result.action, "duplicate");
    assert.equal(store._stored.length, 0);
  });

  it("tags auto-capture source as pending state", async () => {
    const store = createStubStore();
    const embedder = createStubEmbedder();
    const pipeline = new IngestionPipeline({ store, embedder });

    await pipeline.ingest({
      text: "user mentioned they like sushi for lunch",
      category: "preferences",
      importance: 0.6,
      scope: "agent:test",
      source: "auto-capture",
    });

    const entry = store._stored[0];
    assert.ok(entry);
    const meta = JSON.parse(entry.metadata);
    assert.equal(meta.state, "pending");
    assert.equal(meta.source, "auto-capture");
  });

  it("tags manual source as confirmed state", async () => {
    const store = createStubStore();
    const embedder = createStubEmbedder();
    const pipeline = new IngestionPipeline({ store, embedder });

    await pipeline.ingest({
      text: "user explicitly confirmed they prefer TypeScript",
      category: "preferences",
      importance: 0.9,
      scope: "agent:test",
      source: "manual",
    });

    const entry = store._stored[0];
    assert.ok(entry);
    const meta = JSON.parse(entry.metadata);
    assert.equal(meta.state, "confirmed");
    assert.equal(meta.source, "manual");
  });
});
