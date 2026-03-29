import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { filterInterference } = jiti("../src/rif-filter.ts");

// ============================================================================
// Test helpers
// ============================================================================

function makeResult(id, text, score, vector) {
  return {
    entry: {
      id,
      text,
      vector,
      category: "events",
      scope: "project:test",
      importance: 0.7,
      timestamp: Date.now(),
      metadata: "{}",
    },
    score,
    sources: {},
  };
}

// ============================================================================
// filterInterference tests
// ============================================================================

describe("filterInterference", () => {
  it("returns same results when <= 2 items", () => {
    const results = [makeResult("a", "text a", 0.9, [1, 0, 0])];
    const filtered = filterInterference(results);
    assert.equal(filtered.length, 1);
  });

  it("demotes near-duplicate weak results", () => {
    const results = [
      makeResult("strong", "TypeScript config", 0.95, [1, 0, 0]),
      makeResult("weak-dup", "TypeScript config setup", 0.60, [0.99, 0.1, 0]),
      makeResult("different", "Python setup", 0.70, [0, 1, 0]),
    ];

    const filtered = filterInterference(results, 0.85, 0.80);

    // "weak-dup" is similar to "strong" (high cosine) but much weaker score
    // → should be demoted to end
    assert.equal(filtered[0].entry.id, "strong");
    assert.equal(filtered[1].entry.id, "different");
    assert.equal(filtered[2].entry.id, "weak-dup");
  });

  it("keeps strong near-duplicates (score ratio above threshold)", () => {
    const results = [
      makeResult("a", "TypeScript", 0.90, [1, 0, 0]),
      makeResult("b", "TypeScript lang", 0.85, [0.99, 0.1, 0]),
      makeResult("c", "Python", 0.70, [0, 1, 0]),
    ];

    const filtered = filterInterference(results, 0.85, 0.80);

    // b's score (0.85) > a's score * 0.80 (0.72) → NOT demoted
    assert.equal(filtered[0].entry.id, "a");
    assert.equal(filtered[1].entry.id, "b");
    assert.equal(filtered[2].entry.id, "c");
  });

  it("keeps dissimilar results even if weak", () => {
    const results = [
      makeResult("a", "TypeScript", 0.95, [1, 0, 0]),
      makeResult("b", "Python", 0.40, [0, 1, 0]),
      makeResult("c", "Rust", 0.35, [0, 0, 1]),
    ];

    const filtered = filterInterference(results, 0.85, 0.80);

    // All are dissimilar → no demotion
    assert.equal(filtered.length, 3);
    assert.equal(filtered[0].entry.id, "a");
    assert.equal(filtered[1].entry.id, "b");
    assert.equal(filtered[2].entry.id, "c");
  });

  it("handles empty array", () => {
    assert.deepEqual(filterInterference([]), []);
  });

  it("demotes multiple near-duplicates of the same strong result", () => {
    const results = [
      makeResult("strong", "config", 0.95, [1, 0, 0]),
      makeResult("dup1", "config1", 0.50, [0.98, 0.15, 0]),
      makeResult("dup2", "config2", 0.45, [0.97, 0.2, 0]),
      makeResult("other", "unrelated", 0.60, [0, 1, 0]),
    ];

    const filtered = filterInterference(results, 0.85, 0.80);

    // Both dup1 and dup2 are near-duplicates of strong with weak scores
    assert.equal(filtered[0].entry.id, "strong");
    assert.equal(filtered[1].entry.id, "other");
    // Demoted at end
    assert.equal(filtered.length, 4);
  });

  it("preserves total count (demoted results are appended, not removed)", () => {
    const results = [
      makeResult("a", "text", 0.95, [1, 0, 0]),
      makeResult("b", "text2", 0.40, [0.99, 0.1, 0]),
      makeResult("c", "text3", 0.35, [0.98, 0.15, 0]),
    ];

    const filtered = filterInterference(results, 0.85, 0.80);

    // All 3 results should still be present
    assert.equal(filtered.length, 3);
  });
});
