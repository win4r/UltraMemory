/**
 * Test: Gemini-inspired memory features.
 *
 * Tests provenance tracking, memory consolidation, and digest generation
 * on MemoryService using a mock embedder.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../packages/core/src/store.ts");
const { parseSmartMetadata, buildSmartMetadata, stringifySmartMetadata } = jiti(
  "../packages/core/src/smart-metadata.ts",
);

const VECTOR_DIM = 8;

function makeVector(seed = 1) {
  const v = new Array(VECTOR_DIM).fill(1 / Math.sqrt(VECTOR_DIM));
  v[0] = seed * 0.1;
  return v;
}

/** Identical vectors for similarity=1.0 consolidation tests */
function makeSimilarVector(seed = 1, noise = 0.001) {
  const v = makeVector(seed);
  v[1] += noise;
  return v;
}

function makeTestService() {
  const dir = mkdtempSync(join(tmpdir(), "ultramemory-gemini-"));
  const store = new MemoryStore({ dbPath: dir, vectorDim: VECTOR_DIM });
  let vectorSeed = 1;

  /** Store a memory with provenance */
  async function storeWithProvenance(params) {
    const text = params.text;
    const scope = params.scope || "global";
    const importance = params.importance ?? 0.7;
    const category = params.category || "fact";

    const vector = params.vector || makeVector(vectorSeed++);

    const metadataPatch = {
      l0_abstract: text,
      l1_overview: `- ${text}`,
      l2_content: text,
      source: params.source || "manual",
      state: "confirmed",
    };
    if (params.provenance) {
      metadataPatch.provenance = {
        ...params.provenance,
        date: params.provenance.date || new Date().toISOString().slice(0, 10),
      };
    }

    const metadata = stringifySmartMetadata(
      buildSmartMetadata({ text, category, importance }, metadataPatch),
    );

    return store.store({ text, vector, category, scope, importance, metadata });
  }

  /** Get provenance for an entry */
  async function getProvenance(id) {
    const entry = await store.getById(id);
    if (!entry) return null;
    const meta = parseSmartMetadata(entry.metadata, entry);
    return {
      id: entry.id,
      text: entry.text.slice(0, 200),
      source: meta.source,
      source_session: meta.source_session,
      provenance: meta.provenance || null,
      created_at: entry.timestamp,
      tier: meta.tier,
      confidence: meta.confidence,
    };
  }

  return { store, dir, storeWithProvenance, getProvenance };
}

// ============================================================================

describe("Gemini-inspired features", () => {
  // --------------------------------------------------------------------------
  // Provenance tracking
  // --------------------------------------------------------------------------

  describe("provenance tracking", () => {
    it("stores and retrieves provenance metadata", async () => {
      const { dir, storeWithProvenance, getProvenance } = makeTestService();
      try {
        const entry = await storeWithProvenance({
          text: "User prefers dark mode",
          provenance: {
            session: "sess-xyz",
            trigger: "User explicitly stated preference",
            date: "2026-03-27",
          },
        });

        const prov = await getProvenance(entry.id);
        assert.ok(prov, "should find the entry");
        assert.ok(prov.provenance, "should have provenance");
        assert.strictEqual(prov.provenance.session, "sess-xyz");
        assert.strictEqual(prov.provenance.trigger, "User explicitly stated preference");
        assert.strictEqual(prov.provenance.date, "2026-03-27");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("stores provenance with derived_from", async () => {
      const { dir, storeWithProvenance, getProvenance } = makeTestService();
      try {
        const parent1 = await storeWithProvenance({ text: "Parent memory 1" });
        const parent2 = await storeWithProvenance({ text: "Parent memory 2" });

        const child = await storeWithProvenance({
          text: "Merged memory",
          provenance: {
            trigger: "consolidation merge",
            derived_from: [parent1.id, parent2.id],
          },
        });

        const prov = await getProvenance(child.id);
        assert.ok(prov?.provenance, "should have provenance");
        assert.deepStrictEqual(prov.provenance.derived_from, [parent1.id, parent2.id]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("returns null provenance for entries without it", async () => {
      const { dir, storeWithProvenance, getProvenance } = makeTestService();
      try {
        const entry = await storeWithProvenance({
          text: "No provenance entry",
        });

        const prov = await getProvenance(entry.id);
        assert.ok(prov, "should find the entry");
        assert.strictEqual(prov.provenance, null);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // --------------------------------------------------------------------------
  // Memory consolidation
  // --------------------------------------------------------------------------

  describe("memory consolidation", () => {
    it("generates a digest from stored memories", async () => {
      const { dir, store, storeWithProvenance } = makeTestService();
      try {
        // Store several memories
        await storeWithProvenance({ text: "User likes TypeScript", importance: 0.8 });
        await storeWithProvenance({ text: "User works at TechCorp", importance: 0.7 });
        await storeWithProvenance({ text: "User prefers dark mode", importance: 0.6 });

        // Simulate consolidation: list entries and build a digest
        const entries = await store.list(["global"], undefined, 50, 0);
        assert.ok(entries.length >= 3, "should have at least 3 entries");

        // Build digest
        const bullets = entries
          .sort((a, b) => b.importance - a.importance)
          .slice(0, 30)
          .map((e) => {
            const meta = parseSmartMetadata(e.metadata, e);
            return `[${meta.memory_category}] ${e.text.slice(0, 150)}`;
          });

        const digestText = `[DIGEST] User profile consolidated from ${entries.length} memories (global):\n${bullets.join("\n")}`;
        const digestVector = makeVector(99);

        const digestMeta = stringifySmartMetadata(
          buildSmartMetadata(
            { text: digestText, category: "other", importance: 0.85 },
            {
              l0_abstract: `[DIGEST] global: ${entries.length} memories consolidated`,
              l1_overview: bullets.slice(0, 10).map((b) => `- ${b}`).join("\n"),
              l2_content: digestText,
              source: "consolidation",
              state: "confirmed",
              tier: "core",
              memory_category: "profile",
              provenance: {
                trigger: `consolidation: ${entries.length} memories`,
                date: new Date().toISOString().slice(0, 10),
                derived_from: entries.slice(0, 20).map((e) => e.id),
              },
            },
          ),
        );

        const digest = await store.store({
          text: digestText,
          vector: digestVector,
          category: "other",
          scope: "global",
          importance: 0.85,
          metadata: digestMeta,
        });

        assert.ok(digest.id, "digest should have an id");

        // Verify digest provenance
        const meta = parseSmartMetadata(digest.metadata, digest);
        assert.strictEqual(meta.source, "consolidation");
        assert.strictEqual(meta.tier, "core");
        assert.ok(meta.provenance, "digest should have provenance");
        assert.ok(meta.provenance.derived_from.length > 0, "digest should track source IDs");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("archives merged entries with superseded_by via metadata", async () => {
      const { dir, store } = makeTestService();
      try {
        // Directly build metadata representing a consolidated/archived entry
        const keepId = "keep-001";
        const archivedMeta = stringifySmartMetadata(
          buildSmartMetadata(
            { text: "Less important duplicate", category: "fact", importance: 0.5 },
            {
              l0_abstract: "Less important duplicate",
              l2_content: "Less important duplicate",
              source: "manual",
              state: "archived",
              superseded_by: keepId,
              provenance: {
                trigger: `consolidated: merged into ${keepId}`,
                date: "2026-03-27",
              },
            },
          ),
        );

        const entry = await store.store({
          text: "Less important duplicate",
          vector: makeVector(42),
          category: "fact",
          scope: "global",
          importance: 0.5,
          metadata: archivedMeta,
        });

        // Verify that metadata round-trips correctly
        const fetched = await store.getById(entry.id);
        assert.ok(fetched, "entry should exist");
        const meta = parseSmartMetadata(fetched.metadata, fetched);
        assert.strictEqual(meta.state, "archived");
        assert.strictEqual(meta.superseded_by, keepId);
        assert.ok(meta.provenance, "should have provenance");
        assert.ok(meta.provenance.trigger.includes("consolidated"));
        assert.strictEqual(meta.provenance.date, "2026-03-27");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("consolidation source type is recognized", () => {
      // Verify that "consolidation" is a valid MemorySource
      const meta = parseSmartMetadata(
        JSON.stringify({ source: "consolidation" }),
        { text: "test" },
      );
      assert.strictEqual(meta.source, "consolidation");
    });
  });

  // --------------------------------------------------------------------------
  // Provenance normalization
  // --------------------------------------------------------------------------

  describe("provenance normalization", () => {
    it("normalizes provenance from raw JSON", () => {
      const meta = parseSmartMetadata(
        JSON.stringify({
          provenance: {
            session: "  sess-123  ",
            trigger: "user said remember this",
            date: "2026-03-27",
            derived_from: ["id-1", "id-2", "", null],
          },
        }),
        { text: "test" },
      );

      assert.ok(meta.provenance, "should parse provenance");
      assert.strictEqual(meta.provenance.session, "sess-123");
      assert.strictEqual(meta.provenance.trigger, "user said remember this");
      assert.deepStrictEqual(meta.provenance.derived_from, ["id-1", "id-2"]);
    });

    it("returns undefined for empty provenance", () => {
      const meta = parseSmartMetadata(
        JSON.stringify({ provenance: {} }),
        { text: "test" },
      );
      assert.strictEqual(meta.provenance, undefined);
    });

    it("preserves provenance through buildSmartMetadata", () => {
      const meta = buildSmartMetadata(
        { text: "test" },
        {
          provenance: {
            session: "s1",
            trigger: "manual save",
            derived_from: ["parent-1"],
          },
        },
      );
      assert.ok(meta.provenance);
      assert.strictEqual(meta.provenance.session, "s1");
      assert.deepStrictEqual(meta.provenance.derived_from, ["parent-1"]);
    });
  });
});
