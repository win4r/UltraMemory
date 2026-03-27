import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { applyRelationBoost, RELATION_BOOST_PER_HIT, RELATION_BOOST_CAP } = jiti("../src/retriever.ts");

describe("applyRelationBoost", () => {
  it("two related candidates boost each other", () => {
    const candidates = [
      { entry: { id: "a", metadata: JSON.stringify({ relations: [{ type: "related_to", targetId: "b" }] }) }, score: 0.5 },
      { entry: { id: "b", metadata: JSON.stringify({ relations: [{ type: "related_to", targetId: "a" }] }) }, score: 0.4 },
    ];
    const boosted = applyRelationBoost(candidates);
    assert.ok(boosted[0].score > 0.5, "a should be boosted");
    assert.ok(boosted[1].score > 0.4, "b should be boosted");
  });

  it("unrelated candidates unchanged", () => {
    const candidates = [
      { entry: { id: "a", metadata: JSON.stringify({ relations: [] }) }, score: 0.5 },
      { entry: { id: "b", metadata: JSON.stringify({ relations: [] }) }, score: 0.4 },
    ];
    const boosted = applyRelationBoost(candidates);
    assert.equal(boosted[0].score, 0.5);
    assert.equal(boosted[1].score, 0.4);
  });

  it("caps at RELATION_BOOST_CAP (0.09)", () => {
    const relations = [
      { type: "r", targetId: "b" }, { type: "r", targetId: "c" },
      { type: "r", targetId: "d" }, { type: "r", targetId: "e" },
    ];
    const candidates = [
      { entry: { id: "a", metadata: JSON.stringify({ relations }) }, score: 0.5 },
      { entry: { id: "b", metadata: "{}" }, score: 0.3 },
      { entry: { id: "c", metadata: "{}" }, score: 0.3 },
      { entry: { id: "d", metadata: "{}" }, score: 0.3 },
      { entry: { id: "e", metadata: "{}" }, score: 0.3 },
    ];
    const boosted = applyRelationBoost(candidates);
    assert.ok(boosted[0].score <= 0.5 + RELATION_BOOST_CAP + 0.001, "should be capped");
    assert.ok(boosted[0].score >= 0.5 + RELATION_BOOST_CAP - 0.001, "should reach cap");
  });

  it("no metadata is safe", () => {
    const candidates = [
      { entry: { id: "a" }, score: 0.5 },
      { entry: { id: "b", metadata: undefined }, score: 0.4 },
    ];
    const boosted = applyRelationBoost(candidates);
    assert.equal(boosted[0].score, 0.5);
    assert.equal(boosted[1].score, 0.4);
  });

  it("bidirectional: reverse relation also counted", () => {
    const candidates = [
      { entry: { id: "a", metadata: JSON.stringify({ relations: [{ type: "related_to", targetId: "b" }] }) }, score: 0.5 },
      { entry: { id: "b", metadata: "{}" }, score: 0.4 },
    ];
    const boosted = applyRelationBoost(candidates);
    // a has 1 forward hit → +0.03
    assert.ok(Math.abs(boosted[0].score - 0.53) < 0.001, `a should be ~0.53, got ${boosted[0].score}`);
    // b has 1 reverse hit (a points to b) → +0.03
    assert.ok(Math.abs(boosted[1].score - 0.43) < 0.001, `b should be ~0.43, got ${boosted[1].score}`);
  });
});
