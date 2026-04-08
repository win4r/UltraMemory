import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  truncateQuery,
  resolveGovernorConfig,
  GovernorSession,
  governResults,
} = jiti("../packages/core/src/recall-governor.ts");

// ---------------------------------------------------------------------------
// Helpers — build minimal MemorySearchResult objects
// ---------------------------------------------------------------------------

function makeResult(id, text, opts = {}) {
  return {
    entry: {
      id,
      text,
      vector: [],
      category: opts.category ?? "fact",
      scope: opts.scope ?? "default",
      importance: opts.importance ?? 0.5,
      timestamp: opts.timestamp ?? Date.now(),
      metadata: opts.metadata ?? undefined,
    },
    score: opts.score ?? 0.8,
  };
}

// ---------------------------------------------------------------------------
// 1. truncateQuery
// ---------------------------------------------------------------------------

describe("truncateQuery", () => {
  it("returns query unchanged when within limit", () => {
    const q = "short query";
    assert.equal(truncateQuery(q, 1000), q);
  });

  it("truncates query exceeding maxChars", () => {
    const q = "a".repeat(2000);
    const result = truncateQuery(q, 500);
    assert.equal(result.length, 500);
    assert.equal(result, "a".repeat(500));
  });

  it("handles empty string", () => {
    assert.equal(truncateQuery("", 100), "");
  });
});

// ---------------------------------------------------------------------------
// 2. resolveGovernorConfig
// ---------------------------------------------------------------------------

describe("resolveGovernorConfig", () => {
  it("returns defaults when no overrides", () => {
    const cfg = resolveGovernorConfig();
    assert.equal(cfg.maxQueryChars, 1000);
    assert.equal(cfg.charBudget, 8000);
    assert.equal(cfg.maxItems, 10);
  });

  it("applies partial overrides", () => {
    const cfg = resolveGovernorConfig({ charBudget: 5000 });
    assert.equal(cfg.charBudget, 5000);
    assert.equal(cfg.maxQueryChars, 1000); // unchanged default
    assert.equal(cfg.maxItems, 10); // unchanged default
  });
});

// ---------------------------------------------------------------------------
// 3. GovernorSession — dedup tracking
// ---------------------------------------------------------------------------

describe("GovernorSession", () => {
  it("tracks injected IDs", () => {
    const session = new GovernorSession();
    assert.equal(session.wasInjected("id-1"), false);

    session.markInjected("id-1");
    assert.equal(session.wasInjected("id-1"), true);
    assert.equal(session.wasInjected("id-2"), false);
    assert.equal(session.size, 1);
  });

  it("bulk-marks from result array", () => {
    const session = new GovernorSession();
    const results = [makeResult("a", "text a"), makeResult("b", "text b")];
    session.markAll(results);
    assert.equal(session.wasInjected("a"), true);
    assert.equal(session.wasInjected("b"), true);
    assert.equal(session.size, 2);
  });
});

// ---------------------------------------------------------------------------
// 4. governResults — state filter
// ---------------------------------------------------------------------------

describe("governResults — state filter", () => {
  it("excludes entries with invalidated_at in the past", () => {
    const pastTimestamp = Date.now() - 500000;
    const activeResult = makeResult("active-1", "active memory");
    const invalidatedResult = makeResult("dead-1", "old memory", {
      timestamp: pastTimestamp,
      metadata: JSON.stringify({
        valid_from: pastTimestamp,
        invalidated_at: Date.now() - 100000,
      }),
    });

    const governed = governResults([activeResult, invalidatedResult]);
    assert.equal(governed.length, 1);
    assert.equal(governed[0].entry.id, "active-1");
  });

  it("keeps entries with future invalidated_at", () => {
    const result = makeResult("future-1", "still valid", {
      metadata: JSON.stringify({ invalidated_at: Date.now() + 9999999 }),
    });

    const governed = governResults([result]);
    assert.equal(governed.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 5. governResults — session dedup
// ---------------------------------------------------------------------------

describe("governResults — session dedup", () => {
  it("filters out already-injected IDs", () => {
    const session = new GovernorSession();
    session.markInjected("dup-1");

    const results = [
      makeResult("dup-1", "already seen"),
      makeResult("new-1", "fresh memory"),
    ];

    const governed = governResults(results, session);
    assert.equal(governed.length, 1);
    assert.equal(governed[0].entry.id, "new-1");
  });

  it("marks governed results for future dedup", () => {
    const session = new GovernorSession();
    const results = [makeResult("x", "text x"), makeResult("y", "text y")];

    governResults(results, session);
    assert.equal(session.wasInjected("x"), true);
    assert.equal(session.wasInjected("y"), true);
  });

  it("skips dedup when no session provided", () => {
    const results = [makeResult("a", "text a")];
    const governed = governResults(results, undefined);
    assert.equal(governed.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 6. governResults — budget control
// ---------------------------------------------------------------------------

describe("governResults — budget control", () => {
  it("enforces maxItems limit", () => {
    const results = Array.from({ length: 20 }, (_, i) =>
      makeResult(`item-${i}`, `short text ${i}`),
    );

    const governed = governResults(results, undefined, { maxItems: 5 });
    assert.equal(governed.length, 5);
  });

  it("enforces charBudget limit", () => {
    const results = [
      makeResult("a", "x".repeat(3000)),
      makeResult("b", "y".repeat(3000)),
      makeResult("c", "z".repeat(3000)),
    ];

    // Budget of 5000: first = 3000 (kept), second = 3000+3000=6000 > 5000 -> stop
    const governed = governResults(results, undefined, {
      charBudget: 5000,
      maxItems: 100,
    });
    assert.equal(governed.length, 1);
  });

  it("always allows at least one result even if it exceeds budget", () => {
    const results = [makeResult("big", "x".repeat(20000))];

    const governed = governResults(results, undefined, {
      charBudget: 100,
      maxItems: 10,
    });
    assert.equal(governed.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 7. governResults — edge cases
// ---------------------------------------------------------------------------

describe("governResults — edge cases", () => {
  it("returns empty array for empty input", () => {
    const governed = governResults([]);
    assert.equal(governed.length, 0);
  });

  it("composes all layers together", () => {
    const session = new GovernorSession();
    session.markInjected("already-seen");

    const results = [
      makeResult("already-seen", "dedup me"),
      makeResult("invalidated", "old", {
        timestamp: Date.now() - 500000,
        metadata: JSON.stringify({
          valid_from: Date.now() - 500000,
          invalidated_at: Date.now() - 1000,
        }),
      }),
      makeResult("good-1", "x".repeat(4000)),
      makeResult("good-2", "y".repeat(4000)),
      makeResult("good-3", "z".repeat(4000)),
    ];

    // State filter removes "invalidated", dedup removes "already-seen"
    // Budget (default 8000) keeps good-1 (4000) + good-2 (4000+4000=8000) but not good-3
    const governed = governResults(results, session);
    assert.equal(governed.length, 2);
    assert.equal(governed[0].entry.id, "good-1");
    assert.equal(governed[1].entry.id, "good-2");
    // Session should now contain good-1 and good-2 (plus already-seen)
    assert.equal(session.wasInjected("good-1"), true);
    assert.equal(session.wasInjected("good-2"), true);
    assert.equal(session.size, 3); // already-seen + good-1 + good-2
  });
});
