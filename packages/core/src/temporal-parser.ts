/**
 * Temporal Query Filters
 *
 * Parses date expressions from queries (e.g. "after 2024-01", "last week",
 * "yesterday", "去年", "上个月") and converts them to date range filters
 * for post-retrieval filtering.
 *
 * Design: rule-based (zero LLM calls), bilingual (EN + ZH).
 * Falls back gracefully — if no time expression detected, returns unchanged query.
 *
 * Ported from RecallNest temporal-parser.ts with adaptations for UltraMemory.
 */

// ============================================================================
// Types
// ============================================================================

export interface TemporalFilter {
  /** Start of range (inclusive), undefined = unbounded */
  after?: Date;
  /** End of range (exclusive), undefined = unbounded */
  before?: Date;
  /** Original query with temporal expressions removed (for semantic search) */
  cleanedQuery: string;
  /** Original matched expression (for debug/trace) */
  anchor?: string;
}

// ============================================================================
// Date Helpers
// ============================================================================

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
}

function startOfMonth(year: number, month: number): Date {
  return new Date(year, month, 1);
}

function endOfMonth(year: number, month: number): Date {
  return new Date(year, month + 1, 1);
}

function startOfYear(year: number): Date {
  return new Date(year, 0, 1);
}

function endOfYear(year: number): Date {
  return new Date(year + 1, 0, 1);
}

function daysAgo(n: number, ref: Date): Date {
  const d = new Date(ref);
  d.setDate(d.getDate() - n);
  return startOfDay(d);
}

// ============================================================================
// Month Mapping
// ============================================================================

const MONTH_EN: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const MONTH_ZH: Record<string, number> = {
  "\u4e00": 0, "\u4e8c": 1, "\u4e09": 2, "\u56db": 3, "\u4e94": 4, "\u516d": 5,
  "\u4e03": 6, "\u516b": 7, "\u4e5d": 8, "\u5341": 9, "\u5341\u4e00": 10, "\u5341\u4e8c": 11,
};

// ============================================================================
// Pattern Definitions (ordered by specificity — most specific first)
// ============================================================================

interface PatternDef {
  pattern: RegExp;
  handler: (m: RegExpMatchArray, now: Date) => { after?: Date; before?: Date; anchor: string } | null;
}

const PATTERNS: PatternDef[] = [
  // -- Explicit operator syntax: after:YYYY-MM-DD or after:YYYY-MM --
  {
    pattern: /after:(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/i,
    handler: (m) => {
      const year = parseInt(m[1], 10);
      const month = parseInt(m[2], 10) - 1;
      const day = m[3] ? parseInt(m[3], 10) : 1;
      return { after: new Date(year, month, day), anchor: m[0] };
    },
  },
  {
    pattern: /before:(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/i,
    handler: (m) => {
      const year = parseInt(m[1], 10);
      const month = parseInt(m[2], 10) - 1;
      if (m[3]) {
        const day = parseInt(m[3], 10);
        return { before: new Date(year, month, day + 1), anchor: m[0] };
      }
      return { before: endOfMonth(year, month), anchor: m[0] };
    },
  },

  // -- Absolute: YYYY-MM-DD (ISO date) --
  {
    pattern: /\b(\d{4})-(\d{2})-(\d{2})\b/,
    handler: (m) => {
      const year = parseInt(m[1], 10);
      const month = parseInt(m[2], 10) - 1;
      const day = parseInt(m[3], 10);
      const d = new Date(year, month, day);
      return { after: startOfDay(d), before: endOfDay(d), anchor: m[0] };
    },
  },

  // -- Absolute year+month (ZH): "2023\u5e74\u4e09\u6708" / "2023\u5e746\u6708" --
  {
    pattern: /(\d{4})\u5e74((?:\u5341\u4e00|\u5341\u4e8c|[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341])\u6708|\d{1,2}\u6708)/,
    handler: (m) => {
      const year = parseInt(m[1], 10);
      const monthStr = m[2].replace("\u6708", "");
      let month: number;
      if (/^\d+$/.test(monthStr)) {
        month = parseInt(monthStr, 10) - 1;
      } else {
        month = MONTH_ZH[monthStr] ?? -1;
      }
      if (month < 0 || month > 11) return null;
      return {
        after: startOfMonth(year, month),
        before: endOfMonth(year, month),
        anchor: m[0],
      };
    },
  },

  // -- Absolute year+month (EN): "March 2023" / "in March 2023" --
  {
    pattern: /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{4})\b/i,
    handler: (m) => {
      const month = MONTH_EN[m[1].toLowerCase()];
      const year = parseInt(m[2], 10);
      if (month === undefined) return null;
      return {
        after: startOfMonth(year, month),
        before: endOfMonth(year, month),
        anchor: m[0],
      };
    },
  },

  // -- "since March" / "after March" (month in current year) --
  {
    pattern: /\b(?:since|after)\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/i,
    handler: (m, now) => {
      const month = MONTH_EN[m[1].toLowerCase()];
      if (month === undefined) return null;
      return {
        after: startOfMonth(now.getFullYear(), month),
        anchor: m[0],
      };
    },
  },

  // -- Absolute year (ZH): "2023\u5e74" (standalone, not followed by month) --
  {
    pattern: /(\d{4})\u5e74(?:\u7684)?/,
    handler: (m) => {
      const year = parseInt(m[1], 10);
      return {
        after: startOfYear(year),
        before: endOfYear(year),
        anchor: m[0],
      };
    },
  },

  // -- "in YYYY" / "from YYYY" / "during YYYY" --
  {
    pattern: /\b(?:in|from|during)\s+(\d{4})\b/i,
    handler: (m) => {
      const year = parseInt(m[1], 10);
      return {
        after: startOfYear(year),
        before: endOfYear(year),
        anchor: m[0],
      };
    },
  },

  // -- Relative: "\u6700\u8fd1N\u5929/\u5468/\u6708" --
  {
    pattern: /\u6700\u8fd1(\d+)\s*(\u5929|\u5468|\u6708|\u4e2a\u6708)/,
    handler: (m, now) => {
      const n = parseInt(m[1], 10);
      let days: number;
      switch (m[2]) {
        case "\u5929": days = n; break;
        case "\u5468": days = n * 7; break;
        case "\u6708": case "\u4e2a\u6708": days = n * 30; break;
        default: days = n;
      }
      return { after: daysAgo(days, now), before: endOfDay(now), anchor: m[0] };
    },
  },

  // -- Relative: "last N days/weeks/months" --
  {
    pattern: /\blast\s+(\d+)\s*(days?|weeks?|months?)\b/i,
    handler: (m, now) => {
      const n = parseInt(m[1], 10);
      let days: number;
      if (/week/i.test(m[2])) days = n * 7;
      else if (/month/i.test(m[2])) days = n * 30;
      else days = n;
      return { after: daysAgo(days, now), before: endOfDay(now), anchor: m[0] };
    },
  },

  // -- "today" / "\u4eca\u5929" --
  {
    pattern: /\b(today)\b|\u4eca\u5929/i,
    handler: (m, now) => {
      return { after: startOfDay(now), before: endOfDay(now), anchor: m[0] };
    },
  },

  // -- "yesterday" / "\u6628\u5929" --
  {
    pattern: /\b(yesterday)\b|\u6628\u5929/i,
    handler: (m, now) => {
      const y = daysAgo(1, now);
      return { after: y, before: endOfDay(y), anchor: m[0] };
    },
  },

  // -- "this week" / "\u672c\u5468" / "\u8fd9\u5468" --
  {
    pattern: /\b(this week)\b|\u672c\u5468|\u8fd9\u5468/i,
    handler: (m, now) => {
      const dayOfWeek = now.getDay();
      const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      return { after: daysAgo(mondayOffset, now), before: endOfDay(now), anchor: m[0] };
    },
  },

  // -- "this month" / "\u672c\u6708" / "\u8fd9\u4e2a\u6708" --
  {
    pattern: /\b(this month)\b|\u672c\u6708|\u8fd9\u4e2a\u6708/i,
    handler: (m, now) => {
      return {
        after: startOfMonth(now.getFullYear(), now.getMonth()),
        before: endOfDay(now),
        anchor: m[0],
      };
    },
  },

  // -- "this year" / "\u4eca\u5e74" --
  {
    pattern: /\b(this year)\b|\u4eca\u5e74/i,
    handler: (m, now) => {
      return {
        after: startOfYear(now.getFullYear()),
        before: endOfDay(now),
        anchor: m[0],
      };
    },
  },

  // -- Relative: "\u53bb\u5e74N\u6708" (must come before standalone \u53bb\u5e74) --
  {
    pattern: /\u53bb\u5e74(\d{1,2})\u6708/,
    handler: (m, now) => {
      const month = parseInt(m[1], 10) - 1;
      const year = now.getFullYear() - 1;
      return {
        after: startOfMonth(year, month),
        before: endOfMonth(year, month),
        anchor: m[0],
      };
    },
  },

  // -- "\u4e0a\u4e2a\u6708N\u53f7" --
  {
    pattern: /\u4e0a\u4e2a\u6708(\d{1,2})[\u53f7\u65e5]/,
    handler: (m, now) => {
      const day = parseInt(m[1], 10);
      const year = now.getFullYear();
      const month = now.getMonth() - 1;
      const d = new Date(year, month, day);
      return { after: startOfDay(d), before: endOfDay(d), anchor: m[0] };
    },
  },

  // -- Relative: "\u4e0a\u5468/\u4e0a\u4e2a\u6708/\u53bb\u5e74/\u524d\u5e74/\u5927\u524d\u5e74" --
  {
    pattern: /(\u4e0a\u5468|\u4e0a\u4e2a\u6708|\u53bb\u5e74|\u524d\u5e74|\u5927\u524d\u5e74)/,
    handler: (m, now) => {
      const year = now.getFullYear();
      const month = now.getMonth();
      switch (m[1]) {
        case "\u4e0a\u5468": {
          const dayOfWeek = now.getDay();
          const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
          return { after: daysAgo(mondayOffset + 7, now), before: daysAgo(mondayOffset, now), anchor: m[0] };
        }
        case "\u4e0a\u4e2a\u6708":
          return { after: startOfMonth(year, month - 1), before: endOfMonth(year, month - 1), anchor: m[0] };
        case "\u53bb\u5e74":
          return { after: startOfYear(year - 1), before: endOfYear(year - 1), anchor: m[0] };
        case "\u524d\u5e74":
          return { after: startOfYear(year - 2), before: endOfYear(year - 2), anchor: m[0] };
        case "\u5927\u524d\u5e74":
          return { after: startOfYear(year - 3), before: endOfYear(year - 3), anchor: m[0] };
        default:
          return null;
      }
    },
  },

  // -- "last week/month/year" --
  {
    pattern: /\blast\s+(week|month|year)\b/i,
    handler: (m, now) => {
      const year = now.getFullYear();
      const month = now.getMonth();
      switch (m[1].toLowerCase()) {
        case "week": {
          const dayOfWeek = now.getDay();
          const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
          return { after: daysAgo(mondayOffset + 7, now), before: daysAgo(mondayOffset, now), anchor: m[0] };
        }
        case "month":
          return { after: startOfMonth(year, month - 1), before: endOfMonth(year, month - 1), anchor: m[0] };
        case "year":
          return { after: startOfYear(year - 1), before: endOfYear(year - 1), anchor: m[0] };
        default:
          return null;
      }
    },
  },

  // -- "N days/weeks/months ago" --
  {
    pattern: /\b(\d+)\s*(days?|weeks?|months?)\s*ago\b/i,
    handler: (m, now) => {
      const n = parseInt(m[1], 10);
      let days: number;
      if (/week/i.test(m[2])) days = n * 7;
      else if (/month/i.test(m[2])) days = n * 30;
      else days = n;
      const target = daysAgo(days, now);
      return { after: target, before: endOfDay(target), anchor: m[0] };
    },
  },
];

// ============================================================================
// Main Parser
// ============================================================================

/**
 * Parse a query string for temporal expressions and extract date range filters.
 * Returns `{ after, before, cleanedQuery }`.
 *
 * If no temporal expression is detected, `after` and `before` are both undefined
 * and `cleanedQuery` equals the original query.
 *
 * @param query - The raw search query
 * @param now   - Reference date (defaults to current time; pass explicit Date for testing)
 */
export function parseTemporalQuery(query: string, now?: Date): TemporalFilter {
  const ref = now ?? new Date();
  for (const { pattern, handler } of PATTERNS) {
    const match = query.match(pattern);
    if (match) {
      const result = handler(match, ref);
      if (result && (result.after || result.before)) {
        const cleanedQuery = query
          .replace(match[0], "")
          .replace(/\s+/g, " ")
          .trim();
        return {
          after: result.after,
          before: result.before,
          cleanedQuery: cleanedQuery || query,
          anchor: result.anchor,
        };
      }
    }
  }
  return { cleanedQuery: query };
}

// ============================================================================
// Post-Retrieval Filter
// ============================================================================

/**
 * Check whether a Unix-ms timestamp falls within a temporal filter range.
 * Returns true if the timestamp satisfies the filter (or if the filter has no bounds).
 */
export function matchesTemporalFilter(timestampMs: number, filter: TemporalFilter): boolean {
  if (filter.after && timestampMs < filter.after.getTime()) return false;
  if (filter.before && timestampMs >= filter.before.getTime()) return false;
  return true;
}

/**
 * Filter an array of retrieval results by temporal range.
 * Each result must have `entry.timestamp` (Unix ms).
 * Results outside the range are removed; order is preserved.
 */
export function applyTemporalFilter<T extends { entry: { timestamp: number } }>(
  results: T[],
  filter: TemporalFilter,
): T[] {
  if (!filter.after && !filter.before) return results;
  return results.filter((r) => matchesTemporalFilter(r.entry.timestamp, filter));
}
