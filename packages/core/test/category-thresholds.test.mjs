import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { applyCategoryThreshold } = jiti("../src/retriever.ts");

describe("applyCategoryThreshold", () => {
  const defaultThresholds = {
    profile: 0.25,
    preferences: 0.25,
    entities: 0.30,
    events: 0.35,
    cases: 0.45,
    patterns: 0.45,
  };

  it("preferences at 0.26 passes (threshold 0.25)", () => {
    const results = [{ entry: { category: "preferences" }, score: 0.26 }];
    const filtered = applyCategoryThreshold(results, defaultThresholds, 0.35);
    assert.equal(filtered.length, 1);
  });

  it("preferences at 0.24 fails (below 0.25 threshold)", () => {
    const results = [{ entry: { category: "preferences" }, score: 0.24 }];
    const filtered = applyCategoryThreshold(results, defaultThresholds, 0.35);
    assert.equal(filtered.length, 0);
  });

  it("pattern at 0.44 fails", () => {
    const results = [{ entry: { category: "other" }, score: 0.44 }];
    const thresholds = { other: 0.45 };
    const filtered = applyCategoryThreshold(results, thresholds, 0.35);
    assert.equal(filtered.length, 0);
  });

  it("unknown category falls back to hardMinScore", () => {
    const results = [{ entry: { category: "custom" }, score: 0.34 }];
    const filtered = applyCategoryThreshold(results, defaultThresholds, 0.35);
    assert.equal(filtered.length, 0);
  });

  it("unknown category at 0.36 passes with hardMinScore 0.35", () => {
    const results = [{ entry: { category: "custom" }, score: 0.36 }];
    const filtered = applyCategoryThreshold(results, defaultThresholds, 0.35);
    assert.equal(filtered.length, 1);
  });

  it("empty thresholds uses hardMinScore for all", () => {
    const results = [
      { entry: { category: "preferences" }, score: 0.34 },
      { entry: { category: "preferences" }, score: 0.36 },
    ];
    const filtered = applyCategoryThreshold(results, {}, 0.35);
    assert.equal(filtered.length, 1);
  });
});
