import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { shouldCapture, extractHeuristic } = jiti("../src/auto-capture.ts");

describe("shouldCapture", () => {
  it("rejects short text", () => {
    assert.equal(shouldCapture("hi"), false);
  });

  it("rejects empty/null text", () => {
    assert.equal(shouldCapture(""), false);
    assert.equal(shouldCapture(null), false);
    assert.equal(shouldCapture(undefined), false);
  });

  it("rejects greetings", () => {
    assert.equal(shouldCapture("hello!"), false);
    assert.equal(shouldCapture("hey"), false);
    assert.equal(shouldCapture("thanks!"), false);
  });

  it("rejects Chinese greetings", () => {
    assert.equal(shouldCapture("好的"), false);
    assert.equal(shouldCapture("谢谢"), false);
    assert.equal(shouldCapture("是的"), false);
  });

  it("rejects noise (agent denials)", () => {
    assert.equal(shouldCapture("I don't have any information about that topic"), false);
  });

  it("accepts substantial text", () => {
    assert.equal(shouldCapture("I prefer using TypeScript for all my projects"), true);
  });

  it("accepts longer conversational text", () => {
    assert.equal(
      shouldCapture("My name is Alice and I work at Google on the Cloud team"),
      true,
    );
  });
});

describe("extractHeuristic", () => {
  it("extracts preference signals", () => {
    const items = extractHeuristic("I prefer dark mode for all my editors. Also the sky is blue.");
    assert.ok(items.length >= 1);
    assert.equal(items[0].category, "preferences");
    assert.equal(items[0].importance, 0.8);
    assert.equal(items[0].sourceContext, "preference signal");
  });

  it("extracts identity signals", () => {
    const items = extractHeuristic("My name is Alice and I work at Google.");
    assert.ok(items.length >= 1);
    assert.equal(items[0].category, "profile");
    assert.equal(items[0].importance, 0.9);
  });

  it("extracts decision signals", () => {
    const items = extractHeuristic("We decided to use PostgreSQL for the database layer.");
    assert.ok(items.length >= 1);
    assert.equal(items[0].category, "events");
    assert.equal(items[0].importance, 0.7);
  });

  it("extracts correction signals", () => {
    const items = extractHeuristic("Actually, that's wrong. The API limit is 200, not 100.");
    assert.ok(items.length >= 1);
    assert.equal(items[0].category, "cases");
    assert.equal(items[0].importance, 0.85);
  });

  it("extracts Chinese preference signals", () => {
    const items = extractHeuristic("我喜欢使用 TypeScript 来开发所有项目");
    assert.ok(items.length >= 1);
    assert.equal(items[0].category, "preferences");
  });

  it("extracts Chinese identity signals", () => {
    const items = extractHeuristic("我叫小明，我在谷歌工作。");
    assert.ok(items.length >= 1);
    assert.equal(items[0].category, "profile");
  });

  it("caps at 5 items", () => {
    const text = Array(10)
      .fill(0)
      .map((_, i) => `I prefer thing number ${i} over anything else`)
      .join(". ");
    const items = extractHeuristic(text);
    assert.ok(items.length <= 5);
  });

  it("returns empty for text with no signals", () => {
    const items = extractHeuristic("The weather today is quite nice and sunny outside.");
    assert.equal(items.length, 0);
  });

  it("filters out short sentences (<=15 chars)", () => {
    const items = extractHeuristic("I like it. That is all I have to say about the topic.");
    // "I like it" is only 9 chars — should be skipped even though it matches preference pattern
    assert.equal(items.length, 0);
  });

  it("first matching pattern wins per sentence", () => {
    // This sentence matches both preference ("I prefer") and identity ("I am a") — preference comes first
    const items = extractHeuristic("I prefer to say that I am a developer when asked about my job.");
    assert.ok(items.length >= 1);
    assert.equal(items[0].category, "preferences");
  });
});
