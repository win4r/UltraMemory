import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const {
  parseTemporalQuery,
  matchesTemporalFilter,
  applyTemporalFilter,
} = jiti("../packages/core/src/temporal-parser.ts");

// Fixed reference date for deterministic tests: 2025-06-15 12:00:00 UTC
const REF = new Date(2025, 5, 15, 12, 0, 0);

// ============================================================================
// parseTemporalQuery — Explicit operator syntax
// ============================================================================

describe("parseTemporalQuery - explicit operators", () => {
  it("parses after:YYYY-MM", () => {
    const r = parseTemporalQuery("meetings after:2024-03", REF);
    assert.ok(r.after);
    assert.equal(r.after.getFullYear(), 2024);
    assert.equal(r.after.getMonth(), 2); // March = 2
    assert.equal(r.after.getDate(), 1);
    assert.equal(r.before, undefined);
    assert.equal(r.cleanedQuery, "meetings");
    assert.equal(r.anchor, "after:2024-03");
  });

  it("parses before:YYYY-MM-DD", () => {
    const r = parseTemporalQuery("projects before:2024-06-15", REF);
    assert.ok(r.before);
    assert.equal(r.before.getFullYear(), 2024);
    assert.equal(r.before.getMonth(), 5); // June = 5
    assert.equal(r.before.getDate(), 16); // day+1 for exclusive end
    assert.equal(r.after, undefined);
    assert.equal(r.cleanedQuery, "projects");
  });

  it("parses after:YYYY-MM-DD", () => {
    const r = parseTemporalQuery("after:2025-01-10 deployment notes", REF);
    assert.ok(r.after);
    assert.equal(r.after.getFullYear(), 2025);
    assert.equal(r.after.getMonth(), 0);
    assert.equal(r.after.getDate(), 10);
    assert.equal(r.cleanedQuery, "deployment notes");
  });
});

// ============================================================================
// parseTemporalQuery — ISO date
// ============================================================================

describe("parseTemporalQuery - ISO date", () => {
  it("parses YYYY-MM-DD as single-day range", () => {
    const r = parseTemporalQuery("what happened on 2024-12-25", REF);
    assert.ok(r.after);
    assert.ok(r.before);
    assert.equal(r.after.getFullYear(), 2024);
    assert.equal(r.after.getMonth(), 11);
    assert.equal(r.after.getDate(), 25);
    assert.equal(r.before.getDate(), 26);
    assert.ok(r.cleanedQuery.includes("what happened on"));
  });
});

// ============================================================================
// parseTemporalQuery — English natural language
// ============================================================================

describe("parseTemporalQuery - English natural language", () => {
  it("parses 'last week'", () => {
    const r = parseTemporalQuery("what did we discuss last week", REF);
    assert.ok(r.after);
    assert.ok(r.before);
    assert.ok(r.after < r.before);
    assert.equal(r.anchor, "last week");
    assert.ok(r.cleanedQuery.includes("what did we discuss"));
  });

  it("parses 'last month'", () => {
    const r = parseTemporalQuery("changes last month", REF);
    assert.ok(r.after);
    assert.ok(r.before);
    assert.equal(r.after.getMonth(), 4); // May (June-1)
    assert.equal(r.cleanedQuery, "changes");
  });

  it("parses 'last year'", () => {
    const r = parseTemporalQuery("highlights last year", REF);
    assert.ok(r.after);
    assert.ok(r.before);
    assert.equal(r.after.getFullYear(), 2024);
    assert.equal(r.after.getMonth(), 0);
    assert.equal(r.before.getFullYear(), 2025);
  });

  it("parses 'yesterday'", () => {
    const r = parseTemporalQuery("tasks from yesterday", REF);
    assert.ok(r.after);
    assert.ok(r.before);
    assert.equal(r.after.getDate(), 14);
    assert.equal(r.cleanedQuery, "tasks from");
  });

  it("parses 'today'", () => {
    const r = parseTemporalQuery("today meetings", REF);
    assert.ok(r.after);
    assert.ok(r.before);
    assert.equal(r.after.getDate(), 15);
    assert.equal(r.before.getDate(), 16);
    assert.equal(r.cleanedQuery, "meetings");
  });

  it("parses 'this month'", () => {
    const r = parseTemporalQuery("this month progress", REF);
    assert.ok(r.after);
    assert.ok(r.before);
    assert.equal(r.after.getMonth(), 5); // June
    assert.equal(r.after.getDate(), 1);
    assert.equal(r.cleanedQuery, "progress");
  });

  it("parses 'this year'", () => {
    const r = parseTemporalQuery("goals this year", REF);
    assert.ok(r.after);
    assert.equal(r.after.getFullYear(), 2025);
    assert.equal(r.after.getMonth(), 0);
  });

  it("parses 'in YYYY'", () => {
    const r = parseTemporalQuery("decisions in 2024", REF);
    assert.ok(r.after);
    assert.ok(r.before);
    assert.equal(r.after.getFullYear(), 2024);
    assert.equal(r.before.getFullYear(), 2025);
    assert.equal(r.cleanedQuery, "decisions");
  });

  it("parses 'since March' (current year)", () => {
    const r = parseTemporalQuery("PRs since March", REF);
    assert.ok(r.after);
    assert.equal(r.after.getFullYear(), 2025);
    assert.equal(r.after.getMonth(), 2); // March
    assert.equal(r.before, undefined);
  });

  it("parses 'last 7 days'", () => {
    const r = parseTemporalQuery("commits last 7 days", REF);
    assert.ok(r.after);
    assert.ok(r.before);
    const diffMs = r.before.getTime() - r.after.getTime();
    const diffDays = diffMs / (24 * 60 * 60 * 1000);
    // Should span approximately 7 days (7 + fraction of current day)
    assert.ok(diffDays >= 7 && diffDays <= 8);
  });

  it("parses 'March 2023' (month + year)", () => {
    const r = parseTemporalQuery("notes from March 2023", REF);
    assert.ok(r.after);
    assert.ok(r.before);
    assert.equal(r.after.getFullYear(), 2023);
    assert.equal(r.after.getMonth(), 2);
  });

  it("parses '3 days ago'", () => {
    const r = parseTemporalQuery("error logs 3 days ago", REF);
    assert.ok(r.after);
    assert.ok(r.before);
    assert.equal(r.after.getDate(), 12); // June 15 - 3 = June 12
  });

  it("parses 'this week'", () => {
    const r = parseTemporalQuery("bugs this week", REF);
    assert.ok(r.after);
    assert.ok(r.before);
    // June 15, 2025 is a Sunday, so Monday is June 9
    assert.equal(r.after.getDate(), 9);
  });
});

// ============================================================================
// parseTemporalQuery — Chinese expressions
// ============================================================================

describe("parseTemporalQuery - Chinese expressions", () => {
  it("parses '昨天'", () => {
    const r = parseTemporalQuery("昨天的会议", REF);
    assert.ok(r.after);
    assert.ok(r.before);
    assert.equal(r.after.getDate(), 14);
  });

  it("parses '今天'", () => {
    const r = parseTemporalQuery("今天讨论了什么", REF);
    assert.ok(r.after);
    assert.equal(r.after.getDate(), 15);
  });

  it("parses '本月'", () => {
    const r = parseTemporalQuery("本月的进展", REF);
    assert.ok(r.after);
    assert.equal(r.after.getMonth(), 5);
    assert.equal(r.after.getDate(), 1);
  });

  it("parses '今年'", () => {
    const r = parseTemporalQuery("今年的目标", REF);
    assert.ok(r.after);
    assert.equal(r.after.getFullYear(), 2025);
    assert.equal(r.after.getMonth(), 0);
  });

  it("parses '上个月'", () => {
    const r = parseTemporalQuery("上个月的报告", REF);
    assert.ok(r.after);
    assert.ok(r.before);
    assert.equal(r.after.getMonth(), 4); // May
    assert.equal(r.before.getMonth(), 5); // June 1
  });

  it("parses '去年'", () => {
    const r = parseTemporalQuery("去年的总结", REF);
    assert.ok(r.after);
    assert.ok(r.before);
    assert.equal(r.after.getFullYear(), 2024);
    assert.equal(r.before.getFullYear(), 2025);
  });

  it("parses '去年3月'", () => {
    const r = parseTemporalQuery("去年3月的事", REF);
    assert.ok(r.after);
    assert.ok(r.before);
    assert.equal(r.after.getFullYear(), 2024);
    assert.equal(r.after.getMonth(), 2); // March
  });

  it("parses '2024年三月'", () => {
    const r = parseTemporalQuery("2024年三月的记录", REF);
    assert.ok(r.after);
    assert.ok(r.before);
    assert.equal(r.after.getFullYear(), 2024);
    assert.equal(r.after.getMonth(), 2); // March
  });

  it("parses '2024年6月'", () => {
    const r = parseTemporalQuery("2024年6月的讨论", REF);
    assert.ok(r.after);
    assert.ok(r.before);
    assert.equal(r.after.getFullYear(), 2024);
    assert.equal(r.after.getMonth(), 5); // June
  });

  it("parses '最近7天'", () => {
    const r = parseTemporalQuery("最近7天的变更", REF);
    assert.ok(r.after);
    assert.ok(r.before);
    assert.equal(r.after.getDate(), 8); // June 15 - 7
  });

  it("parses '最近2周'", () => {
    const r = parseTemporalQuery("最近2周发生了什么", REF);
    assert.ok(r.after);
    assert.ok(r.before);
    assert.equal(r.after.getDate(), 1); // June 15 - 14
  });

  it("parses '前年'", () => {
    const r = parseTemporalQuery("前年的项目", REF);
    assert.ok(r.after);
    assert.ok(r.before);
    assert.equal(r.after.getFullYear(), 2023);
  });

  it("parses '上周'", () => {
    const r = parseTemporalQuery("上周的任务", REF);
    assert.ok(r.after);
    assert.ok(r.before);
    assert.ok(r.after < r.before);
    // June 15 is Sunday; this week Monday = June 9; last week = June 2-9
    assert.equal(r.after.getDate(), 2);
    assert.equal(r.before.getDate(), 9);
  });

  it("parses '这周'", () => {
    const r = parseTemporalQuery("这周的计划", REF);
    assert.ok(r.after);
    assert.ok(r.before);
  });
});

// ============================================================================
// parseTemporalQuery — No temporal expression
// ============================================================================

describe("parseTemporalQuery - no match", () => {
  it("returns original query when no temporal expression found", () => {
    const r = parseTemporalQuery("how to deploy", REF);
    assert.equal(r.cleanedQuery, "how to deploy");
    assert.equal(r.after, undefined);
    assert.equal(r.before, undefined);
    assert.equal(r.anchor, undefined);
  });

  it("returns original query for empty string", () => {
    const r = parseTemporalQuery("", REF);
    assert.equal(r.cleanedQuery, "");
    assert.equal(r.after, undefined);
    assert.equal(r.before, undefined);
  });
});

// ============================================================================
// matchesTemporalFilter
// ============================================================================

describe("matchesTemporalFilter", () => {
  it("returns true for no-bound filter", () => {
    assert.equal(matchesTemporalFilter(Date.now(), { cleanedQuery: "test" }), true);
  });

  it("returns false when timestamp is before 'after' bound", () => {
    const filter = {
      after: new Date(2024, 6, 1),
      cleanedQuery: "test",
    };
    const ts = new Date(2024, 5, 15).getTime(); // June 15 < July 1
    assert.equal(matchesTemporalFilter(ts, filter), false);
  });

  it("returns true when timestamp is after 'after' bound", () => {
    const filter = {
      after: new Date(2024, 6, 1),
      cleanedQuery: "test",
    };
    const ts = new Date(2024, 7, 15).getTime(); // Aug 15 > July 1
    assert.equal(matchesTemporalFilter(ts, filter), true);
  });

  it("returns false when timestamp is at or after 'before' bound (exclusive)", () => {
    const filter = {
      before: new Date(2024, 6, 1),
      cleanedQuery: "test",
    };
    const ts = new Date(2024, 6, 1).getTime(); // exact boundary
    assert.equal(matchesTemporalFilter(ts, filter), false);
  });

  it("respects both bounds together", () => {
    const filter = {
      after: new Date(2024, 0, 1),
      before: new Date(2025, 0, 1),
      cleanedQuery: "test",
    };
    assert.equal(matchesTemporalFilter(new Date(2024, 6, 1).getTime(), filter), true);
    assert.equal(matchesTemporalFilter(new Date(2023, 11, 31).getTime(), filter), false);
    assert.equal(matchesTemporalFilter(new Date(2025, 0, 1).getTime(), filter), false);
  });
});

// ============================================================================
// applyTemporalFilter
// ============================================================================

describe("applyTemporalFilter", () => {
  const entries = [
    { entry: { timestamp: new Date(2024, 0, 15).getTime() }, score: 0.9 },
    { entry: { timestamp: new Date(2024, 6, 15).getTime() }, score: 0.8 },
    { entry: { timestamp: new Date(2025, 0, 15).getTime() }, score: 0.7 },
  ];

  it("returns all entries when filter has no bounds", () => {
    const filtered = applyTemporalFilter(entries, { cleanedQuery: "test" });
    assert.equal(filtered.length, 3);
  });

  it("filters entries outside date range", () => {
    const filter = {
      after: new Date(2024, 3, 1),
      before: new Date(2024, 11, 31),
      cleanedQuery: "test",
    };
    const filtered = applyTemporalFilter(entries, filter);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].score, 0.8);
  });

  it("filters with only 'after' bound", () => {
    const filter = {
      after: new Date(2024, 3, 1),
      cleanedQuery: "test",
    };
    const filtered = applyTemporalFilter(entries, filter);
    assert.equal(filtered.length, 2);
  });
});
