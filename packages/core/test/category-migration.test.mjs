import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { migrateCategoryForEntry } = jiti("../src/category-migrator.ts");

describe("migrateCategoryForEntry", () => {
  it("sets memory_category from legacy category when missing", () => {
    const entry = {
      text: "user likes coffee",
      category: "preference",
      metadata: JSON.stringify({ l0_abstract: "user likes coffee" }),
    };
    const result = migrateCategoryForEntry(entry);
    assert.equal(result.memory_category, "preferences");
    assert.equal(result.changed, true);
  });

  it("preserves existing memory_category", () => {
    const entry = {
      text: "user likes coffee",
      category: "preference",
      metadata: JSON.stringify({ memory_category: "profile", l0_abstract: "user likes coffee" }),
    };
    const result = migrateCategoryForEntry(entry);
    assert.equal(result.memory_category, "profile");
    assert.equal(result.changed, false);
  });

  it("maps fact to profile for identity text", () => {
    const entry = { text: "my name is Alice", category: "fact", metadata: "{}" };
    const result = migrateCategoryForEntry(entry);
    assert.equal(result.memory_category, "profile");
  });

  it("maps fact to cases for non-identity text", () => {
    const entry = { text: "the API rate limit is 100/min", category: "fact", metadata: "{}" };
    const result = migrateCategoryForEntry(entry);
    assert.equal(result.memory_category, "cases");
  });

  it("maps reflection to patterns", () => {
    const entry = { text: "agent observed a pattern", category: "reflection", metadata: "{}" };
    const result = migrateCategoryForEntry(entry);
    assert.equal(result.memory_category, "patterns");
    assert.equal(result.changed, true);
  });

  it("maps decision to events", () => {
    const entry = { text: "decided to use TypeScript", category: "decision", metadata: "{}" };
    const result = migrateCategoryForEntry(entry);
    assert.equal(result.memory_category, "events");
  });

  it("maps entity to entities", () => {
    const entry = { text: "Bob is a coworker", category: "entity", metadata: "{}" };
    const result = migrateCategoryForEntry(entry);
    assert.equal(result.memory_category, "entities");
  });

  it("maps other to patterns", () => {
    const entry = { text: "some observation", category: "other", metadata: "{}" };
    const result = migrateCategoryForEntry(entry);
    assert.equal(result.memory_category, "patterns");
  });

  it("handles malformed JSON metadata gracefully", () => {
    const entry = { text: "user likes coffee", category: "preference", metadata: "not-json{" };
    const result = migrateCategoryForEntry(entry);
    assert.equal(result.changed, true);
    assert.ok(result.memory_category, "should derive a category despite bad metadata");
  });
});
