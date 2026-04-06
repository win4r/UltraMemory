import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { normalizeEntity, normalizePredicate, isKGModeEnabled } = jiti("../src/kg-extractor.ts");
const { tripleId } = jiti("../src/kg-store.ts");
const { buildGraph, pprTraverse, edgeWeight, DEFAULT_PPR_CONFIG } = jiti("../src/ppr-traversal.ts");
const { detectEntitiesSync } = jiti("../src/query-entity-detector.ts");

// ============================================================================
// kg-extractor
// ============================================================================

describe("kg-extractor", () => {
  it("isKGModeEnabled returns false when env not set", () => {
    assert.equal(isKGModeEnabled(), false);
  });

  it("normalizeEntity trims and title-cases English", () => {
    assert.equal(normalizeEntity("  hello world  "), "Hello World");
  });

  it("normalizeEntity preserves CJK", () => {
    assert.equal(normalizeEntity("刘备"), "刘备");
  });

  it("normalizeEntity strips surrounding quotes", () => {
    assert.equal(normalizeEntity('"RecallNest"'), "Recallnest");
  });

  it("normalizeEntity returns empty for blank input", () => {
    assert.equal(normalizeEntity("   "), "");
  });

  it("normalizePredicate snake_cases", () => {
    assert.equal(normalizePredicate("Works With"), "works_with");
    assert.equal(normalizePredicate("created-by"), "created_by");
    assert.equal(normalizePredicate("USES"), "uses");
  });
});

// ============================================================================
// kg-store (tripleId only — no DB in unit tests)
// ============================================================================

describe("kg-store", () => {
  it("tripleId produces 32-char hex", () => {
    const id = tripleId("global", "Alice", "uses", "Python");
    assert.equal(id.length, 32);
    assert.match(id, /^[0-9a-f]+$/);
  });

  it("tripleId is deterministic", () => {
    const a = tripleId("s", "a", "b", "c");
    const b = tripleId("s", "a", "b", "c");
    assert.equal(a, b);
  });

  it("tripleId varies with scope", () => {
    const a = tripleId("scope1", "a", "b", "c");
    const b = tripleId("scope2", "a", "b", "c");
    assert.notEqual(a, b);
  });
});

// ============================================================================
// ppr-traversal
// ============================================================================

describe("ppr-traversal", () => {
  it("edgeWeight returns known predicate weight", () => {
    assert.equal(edgeWeight("uses"), 0.90);
    assert.equal(edgeWeight("created_by"), 0.95);
    assert.equal(edgeWeight("related_to"), 0.50);
  });

  it("edgeWeight returns default for unknown predicate", () => {
    assert.equal(edgeWeight("some_unknown"), 0.60);
  });

  it("buildGraph creates undirected graph from neighborhood", () => {
    const neighborhood = [
      {
        entity: "Alice",
        triples: [
          { id: "t1", scope: "g", subject: "Alice", predicate: "uses", object: "Python", confidence: 0.9, source_memory_id: "m1", source_text: "", timestamp: 0 },
          { id: "t2", scope: "g", subject: "Alice", predicate: "works_at", object: "Google", confidence: 0.8, source_memory_id: "m2", source_text: "", timestamp: 0 },
        ],
        hops: 0,
      },
    ];
    const graph = buildGraph(neighborhood);
    assert.equal(graph.nodes.size, 3);
    assert.ok(graph.adj.has("Alice"));
    assert.ok(graph.adj.has("Python"));
    assert.ok(graph.adj.has("Google"));
    // Undirected: Python also has edge back to Alice
    assert.ok(graph.adj.get("Python").some((e) => e.neighbor === "Alice"));
  });

  it("pprTraverse returns scored entities", () => {
    const neighborhood = [
      {
        entity: "Alice",
        triples: [
          { id: "t1", scope: "g", subject: "Alice", predicate: "uses", object: "Python", confidence: 0.9, source_memory_id: "m1", source_text: "", timestamp: 0 },
          { id: "t2", scope: "g", subject: "Alice", predicate: "works_at", object: "Google", confidence: 0.8, source_memory_id: "m2", source_text: "", timestamp: 0 },
        ],
        hops: 0,
      },
    ];
    const graph = buildGraph(neighborhood);
    const results = pprTraverse(graph, ["Alice"]);
    assert.ok(results.length > 0);
    // Alice should have highest score as seed
    assert.equal(results[0].entity, "Alice");
    assert.ok(results[0].score > 0);
    // All results should have paths
    for (const r of results) {
      assert.ok(Array.isArray(r.path));
      assert.ok(r.path.length > 0);
    }
  });

  it("pprTraverse returns empty for empty graph", () => {
    const graph = { adj: new Map(), nodes: new Set() };
    const results = pprTraverse(graph, ["Alice"]);
    assert.equal(results.length, 0);
  });

  it("pprTraverse returns empty when seeds not in graph", () => {
    const neighborhood = [
      {
        entity: "Bob",
        triples: [
          { id: "t1", scope: "g", subject: "Bob", predicate: "uses", object: "Java", confidence: 0.9, source_memory_id: "m1", source_text: "", timestamp: 0 },
        ],
        hops: 0,
      },
    ];
    const graph = buildGraph(neighborhood);
    const results = pprTraverse(graph, ["Alice"]); // Alice not in graph
    assert.equal(results.length, 0);
  });
});

// ============================================================================
// query-entity-detector
// ============================================================================

describe("query-entity-detector", () => {
  it("detects capitalized entities", () => {
    const r = detectEntitiesSync("Tell me about Alice and RecallNest");
    assert.ok(r.entities.some((e) => e === "Alice"));
    assert.ok(r.entities.some((e) => e === "Recallnest"));
  });

  it("detects quoted entities", () => {
    const r = detectEntitiesSync('What is "LanceDB" used for?');
    assert.ok(r.entities.some((e) => e.toLowerCase() === "lancedb"));
  });

  it("detects multi-hop intent (English)", () => {
    const r = detectEntitiesSync("What tools does Alice use?");
    assert.equal(r.isMultiHop, true);
    assert.equal(r.hopPredicate, "uses");
  });

  it("detects multi-hop intent (Chinese)", () => {
    const r = detectEntitiesSync("谁和Bob一起工作？");
    assert.equal(r.isMultiHop, true);
    assert.equal(r.hopPredicate, "works_with");
  });

  it("no multi-hop for simple queries", () => {
    const r = detectEntitiesSync("Tell me about Python");
    assert.equal(r.isMultiHop, false);
    assert.equal(r.hopPredicate, undefined);
  });

  it("skips stop words", () => {
    const r = detectEntitiesSync("The important search");
    // None of these should be entities
    assert.equal(r.entities.length, 0);
  });
});
