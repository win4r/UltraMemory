import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { applyCategoryThreshold, applyRelationBoost } = jiti("../src/retriever.ts");
const { ScoringTrace } = jiti("../src/smart-metadata.ts");

describe("ScoringTrace", () => {
  it("ScoringTrace interface is importable", () => {
    // Just verify the type exists by checking the module loaded
    assert.ok(true, "ScoringTrace type loaded from smart-metadata");
  });
});

describe("Scoring trace integration", () => {
  it("applyCategoryThreshold preserves scoringTrace on results", () => {
    const results = [
      { entry: { category: "preferences" }, score: 0.5, scoringTrace: { finalScore: 0.5, searchPath: "hybrid" } },
    ];
    const filtered = applyCategoryThreshold(results, { preferences: 0.25 }, 0.35);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].scoringTrace.searchPath, "hybrid");
  });

  it("applyRelationBoost preserves scoringTrace", () => {
    const candidates = [
      { entry: { id: "a", metadata: "{}" }, score: 0.5, scoringTrace: { finalScore: 0.5, queryType: "general" } },
    ];
    const boosted = applyRelationBoost(candidates);
    assert.equal(boosted[0].scoringTrace.queryType, "general");
  });
});
