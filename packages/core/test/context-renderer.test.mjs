import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { renderMemories } = jiti("../src/context-renderer.ts");

describe("renderMemories", () => {
  const memories = [
    { id: "a", text: "user prefers TypeScript for backend development", score: 0.8, category: "preferences" },
    { id: "b", text: "user works on machine learning projects", score: 0.9, category: "profile" },
    { id: "c", text: "user likes dark mode in all editors", score: 0.7, category: "preferences" },
  ];

  it("verbatim returns memories unchanged in original order", () => {
    const result = renderMemories(memories, "test query", "verbatim");
    assert.equal(result.mode, "verbatim");
    assert.equal(result.memories.length, 3);
    assert.equal(result.memories[0].id, "a");
  });

  it("highlight reorders by contextual relevance to query", () => {
    const result = renderMemories(memories, "machine learning project", "highlight");
    assert.equal(result.mode, "highlight");
    // "b" mentions "machine learning projects" — should be first
    assert.equal(result.memories[0].id, "b");
  });

  it("highlight uses taskContext for relevance scoring", () => {
    const result = renderMemories(memories, "editors dark mode", "highlight", "configuring editors");
    assert.equal(result.mode, "highlight");
    // "c" mentions "dark mode in all editors" — most relevant to editors + dark mode
    assert.equal(result.memories[0].id, "c");
  });

  it("synthesize falls back to highlight", () => {
    const result = renderMemories(memories, "test", "synthesize");
    assert.equal(result.mode, "highlight"); // fallback
  });

  it("handles empty memories", () => {
    const result = renderMemories([], "query", "highlight");
    assert.equal(result.memories.length, 0);
  });

  it("includes relevance score on each memory", () => {
    const result = renderMemories(memories, "TypeScript backend", "highlight");
    for (const m of result.memories) {
      assert.ok(typeof m.relevance === "number");
      assert.ok(m.relevance >= 0 && m.relevance <= 1);
    }
  });
});
