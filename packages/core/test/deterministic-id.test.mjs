import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { deterministicId } = jiti("../src/utils/deterministic-id.ts");

describe("deterministicId", () => {
  it("returns the same ID for same scope+text", () => {
    const id1 = deterministicId("global", "user likes dark mode");
    const id2 = deterministicId("global", "user likes dark mode");
    assert.equal(id1, id2);
  });

  it("returns different IDs for different scopes", () => {
    const id1 = deterministicId("global", "user likes dark mode");
    const id2 = deterministicId("agent:claude", "user likes dark mode");
    assert.notEqual(id1, id2);
  });

  it("returns different IDs for different text", () => {
    const id1 = deterministicId("global", "user likes dark mode");
    const id2 = deterministicId("global", "user likes light mode");
    assert.notEqual(id1, id2);
  });

  it("produces valid UUID v5 format", () => {
    const id = deterministicId("global", "test");
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("handles empty text", () => {
    const id = deterministicId("global", "");
    assert.match(id, /^[0-9a-f]{8}-/);
  });

  it("handles unicode text", () => {
    const id1 = deterministicId("global", "用户喜欢深色模式");
    const id2 = deterministicId("global", "用户喜欢深色模式");
    assert.equal(id1, id2);
  });
});
