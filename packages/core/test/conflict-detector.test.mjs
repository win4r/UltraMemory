import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { detectFactKeyConflict, detectHeuristicContradiction } = jiti(
  "../src/conflict-detector.ts",
);

// ---------------------------------------------------------------------------
// detectFactKeyConflict
// ---------------------------------------------------------------------------

describe("detectFactKeyConflict", () => {
  it("same factKey, different text → hasConflict: true", () => {
    const result = detectFactKeyConflict(
      { factKey: "pref:editor", text: "user prefers vim" },
      [{ id: "m1", factKey: "pref:editor", text: "user prefers vscode" }],
    );
    assert.equal(result.hasConflict, true);
    assert.equal(result.isDuplicate, false);
    assert.equal(result.conflictWith, "m1");
  });

  it("different factKey → hasConflict: false", () => {
    const result = detectFactKeyConflict(
      { factKey: "pref:editor", text: "user prefers vim" },
      [{ id: "m1", factKey: "pref:theme", text: "user likes dark mode" }],
    );
    assert.equal(result.hasConflict, false);
    assert.equal(result.isDuplicate, false);
    assert.equal(result.conflictWith, undefined);
  });

  it("same factKey, same text (case-insensitive) → isDuplicate: true", () => {
    const result = detectFactKeyConflict(
      { factKey: "pref:editor", text: "User Prefers Vim" },
      [{ id: "m1", factKey: "pref:editor", text: "user prefers vim" }],
    );
    assert.equal(result.hasConflict, false);
    assert.equal(result.isDuplicate, true);
    assert.equal(result.conflictWith, "m1");
  });

  it("duplicate first but later entry conflicts → detects conflict", () => {
    const result = detectFactKeyConflict(
      { factKey: "pref:editor", text: "user prefers vim" },
      [
        { id: "m1", factKey: "pref:editor", text: "user prefers vim" },
        { id: "m2", factKey: "pref:editor", text: "user prefers emacs" },
      ],
    );
    assert.equal(result.hasConflict, true);
    assert.equal(result.isDuplicate, false);
    assert.equal(result.conflictWith, "m2");
  });

  it("undefined factKey → hasConflict: false", () => {
    const result = detectFactKeyConflict(
      { factKey: undefined, text: "random fact" },
      [{ id: "m1", factKey: "pref:editor", text: "user prefers vim" }],
    );
    assert.equal(result.hasConflict, false);
    assert.equal(result.isDuplicate, false);
    assert.equal(result.conflictWith, undefined);
  });

  it("no matching factKey in existing → no conflict", () => {
    const result = detectFactKeyConflict(
      { factKey: "pref:language", text: "user speaks English" },
      [
        { id: "m1", factKey: "pref:editor", text: "user prefers vim" },
        { id: "m2", factKey: "pref:theme", text: "user likes dark mode" },
      ],
    );
    assert.equal(result.hasConflict, false);
    assert.equal(result.isDuplicate, false);
  });

  it("empty existing array → no conflict", () => {
    const result = detectFactKeyConflict(
      { factKey: "pref:editor", text: "user prefers vim" },
      [],
    );
    assert.equal(result.hasConflict, false);
    assert.equal(result.isDuplicate, false);
  });
});

// ---------------------------------------------------------------------------
// detectHeuristicContradiction
// ---------------------------------------------------------------------------

describe("detectHeuristicContradiction", () => {
  it("positive vs negative → true", () => {
    assert.equal(
      detectHeuristicContradiction(
        "user likes dark mode",
        "user doesn't like dark mode",
      ),
      true,
    );
  });

  it("'does not' negation → true", () => {
    assert.equal(
      detectHeuristicContradiction(
        "user prefers tabs",
        "user does not prefer tabs",
      ),
      true,
    );
  });

  it("unrelated statements → false", () => {
    assert.equal(
      detectHeuristicContradiction(
        "user likes dark mode",
        "user works at Google",
      ),
      false,
    );
  });

  it("reverse direction: negative first, positive second → true", () => {
    assert.equal(
      detectHeuristicContradiction(
        "user doesn't like dark mode",
        "user likes dark mode",
      ),
      true,
    );
  });

  it("'the user' prefix is stripped → true", () => {
    assert.equal(
      detectHeuristicContradiction(
        "the user likes dark mode",
        "the user doesn't like dark mode",
      ),
      true,
    );
  });

  it("'they' prefix is stripped → true", () => {
    assert.equal(
      detectHeuristicContradiction(
        "they prefer tabs",
        "they don't prefer tabs",
      ),
      true,
    );
  });

  it("verb with trailing 's': 'likes' vs 'like' → true", () => {
    assert.equal(
      detectHeuristicContradiction(
        "user likes dark mode",
        "user doesn't like dark mode",
      ),
      true,
    );
  });

  it("'do not' negation with 'they' prefix → true", () => {
    assert.equal(
      detectHeuristicContradiction(
        "they use vim",
        "they do not use vim",
      ),
      true,
    );
  });

  it("different objects → false", () => {
    assert.equal(
      detectHeuristicContradiction(
        "user likes dark mode",
        "user doesn't like light mode",
      ),
      false,
    );
  });
});
