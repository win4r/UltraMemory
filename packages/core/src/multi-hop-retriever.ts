/**
 * Multi-Hop Retrieval
 *
 * Ported from RecallNest LME-5. After a first-round search, extracts salient
 * entities from the results and performs a second round of queries to discover
 * cross-session evidence that the initial search missed.
 *
 * This is an OPTIONAL retrieval mode — an additional function callers can use
 * when deeper search is desired. It does NOT modify the main retrieve() flow.
 */

import type { MemoryStore, MemorySearchResult } from "./store.js";
import type { Embedder } from "./embedder.js";

// ============================================================================
// Types
// ============================================================================

export interface MultiHopConfig {
  /** Maximum number of entity-focused follow-up queries (default: 3). */
  maxRound2Entities: number;
  /** Max results per round-2 query (default: 5). */
  round2Limit: number;
  /** Minimum score to retain in final results (default: 0.25). */
  minScore: number;
  /** Scope filter passed to both rounds. */
  scopeFilter?: string[];
  /** Round-1 result limit (default: 10). */
  round1Limit: number;
}

export const DEFAULT_MULTI_HOP_CONFIG: MultiHopConfig = {
  maxRound2Entities: 3,
  round2Limit: 5,
  minScore: 0.25,
  round1Limit: 10,
};

export interface MultiHopResult {
  entry: MemorySearchResult["entry"];
  score: number;
  /** Which round found this result ("round1" | "round2" | "both"). */
  source: "round1" | "round2" | "both";
}

// ============================================================================
// Stop-word list — exclude from entity extraction
// ============================================================================

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been",
  "have", "has", "had", "will", "would", "can", "could", "should",
  "do", "does", "did", "not", "no", "but", "and", "or", "if",
  "this", "that", "these", "those", "it", "its", "user", "assistant",
  "my", "your", "his", "her", "our", "their", "i", "you", "he", "she",
  "we", "they", "me", "him", "us", "them", "who", "what", "where",
  "when", "how", "why", "which", "about", "with", "from", "for",
  "into", "also", "just", "very", "some", "more", "most", "other",
]);

const CJK_STOP_RE =
  /^(用户|助手|可以|需要|已经|没有|什么|这个|那个|因为|所以|但是|如果)$/;

// ============================================================================
// Entity extraction from retrieval results
// ============================================================================

/**
 * Extract salient entities from memory texts.
 * Targets: capitalized phrases, quoted terms, file paths, URLs, CJK names.
 * Returns unique entities sorted by frequency (most common first).
 */
export function extractEntitiesFromTexts(texts: string[]): string[] {
  const freq = new Map<string, number>();

  for (const text of texts) {
    // 1. Capitalized multi-word entities: "Adobe Premiere Pro", "Sony A7III"
    const capPattern = /\b([A-Z][a-zA-Z0-9]*(?:[\s\-][A-Z][a-zA-Z0-9]*)*)\b/g;
    let match: RegExpExecArray | null;
    while ((match = capPattern.exec(text)) !== null) {
      const entity = match[1].trim();
      if (entity.length < 2 || STOP_WORDS.has(entity.toLowerCase())) continue;
      freq.set(entity, (freq.get(entity) ?? 0) + 1);
    }

    // 2. Quoted terms: "LanceDB", 'RecallNest'
    const quotedPattern = /["'`]([^"'`]{2,40})["'`]/g;
    while ((match = quotedPattern.exec(text)) !== null) {
      const entity = match[1].trim();
      if (entity.length < 2 || STOP_WORDS.has(entity.toLowerCase())) continue;
      freq.set(entity, (freq.get(entity) ?? 0) + 1);
    }

    // 3. File paths: /foo/bar.ts, ./src/index.ts
    const pathPattern = /(?:\.?\/[\w\-.]+){2,}/g;
    while ((match = pathPattern.exec(text)) !== null) {
      const entity = match[0];
      freq.set(entity, (freq.get(entity) ?? 0) + 1);
    }

    // 4. URLs: https://example.com/path
    const urlPattern = /https?:\/\/[^\s)>"']+/g;
    while ((match = urlPattern.exec(text)) !== null) {
      const entity = match[0];
      freq.set(entity, (freq.get(entity) ?? 0) + 1);
    }

    // 5. CJK named entities: sequences of 2-8 CJK chars
    const cjkPattern = /([\p{Script=Han}]{2,8})/gu;
    while ((match = cjkPattern.exec(text)) !== null) {
      const entity = match[1];
      if (CJK_STOP_RE.test(entity)) continue;
      freq.set(entity, (freq.get(entity) ?? 0) + 1);
    }
  }

  // Sort by frequency descending, then by specificity (length descending)
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([entity]) => entity);
}

// ============================================================================
// Multi-Hop Retrieval
// ============================================================================

/**
 * Perform two-round retrieval:
 * 1. Standard vector + BM25 search for the query.
 * 2. Extract entities from round-1 results, run focused follow-up searches,
 *    merge with dedup by memory ID (keep highest score).
 *
 * @param store   - MemoryStore instance (provides vectorSearch + bm25Search)
 * @param embedder - Embedder instance (provides embedQuery)
 * @param query   - The user's search query
 * @param opts    - Optional config overrides
 * @returns Combined results sorted by score descending
 */
export async function multiHopRetrieve(
  store: MemoryStore,
  embedder: Embedder,
  query: string,
  opts?: Partial<MultiHopConfig>,
): Promise<MultiHopResult[]> {
  const config: MultiHopConfig = { ...DEFAULT_MULTI_HOP_CONFIG, ...opts };

  // ── Round 1: standard retrieval ──
  const queryVector = await embedder.embedQuery(query);

  const [vectorResults, bm25Results] = await Promise.all([
    store.vectorSearch(queryVector, config.round1Limit, config.minScore, config.scopeFilter),
    store.hasFtsSupport
      ? store.bm25Search(query, config.round1Limit, config.scopeFilter)
      : Promise.resolve([] as MemorySearchResult[]),
  ]);

  // Merge round-1 candidates by ID, keep highest score
  const round1Map = new Map<string, MemorySearchResult>();
  for (const r of [...vectorResults, ...bm25Results]) {
    const existing = round1Map.get(r.entry.id);
    if (!existing || r.score > existing.score) {
      round1Map.set(r.entry.id, r);
    }
  }
  const round1 = [...round1Map.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, config.round1Limit);

  if (round1.length === 0) return [];

  // ── Extract entities from round-1 results ──
  const texts = round1.map((r) => r.entry.text);
  const allEntities = extractEntitiesFromTexts(texts);

  // Remove entities that are already substrings of the query
  const queryLower = query.toLowerCase();
  const novelEntities = allEntities
    .filter((e) => !queryLower.includes(e.toLowerCase()))
    .slice(0, config.maxRound2Entities);

  // If no novel entities found, return round-1 as-is
  if (novelEntities.length === 0) {
    return round1.map((r) => ({
      entry: r.entry,
      score: r.score,
      source: "round1" as const,
    }));
  }

  // ── Round 2: entity-focused follow-up queries ──
  const round1Ids = new Set(round1.map((r) => r.entry.id));

  const followUpPromises = novelEntities.map(async (entity) => {
    const combinedQuery = `${entity} ${query}`;
    const entityVector = await embedder.embedQuery(combinedQuery);

    const [vRes, bRes] = await Promise.all([
      store.vectorSearch(entityVector, config.round2Limit, config.minScore, config.scopeFilter),
      store.hasFtsSupport
        ? store.bm25Search(combinedQuery, config.round2Limit, config.scopeFilter)
        : Promise.resolve([] as MemorySearchResult[]),
    ]);

    return [...vRes, ...bRes];
  });

  let round2Results: MemorySearchResult[];
  try {
    const batches = await Promise.all(followUpPromises);
    round2Results = batches.flat();
  } catch {
    // If follow-up queries fail, gracefully return round-1 results
    return round1.map((r) => ({
      entry: r.entry,
      score: r.score,
      source: "round1" as const,
    }));
  }

  // ── Merge round 1 + round 2, dedup by ID, keep highest score ──
  const merged = new Map<string, MultiHopResult>();

  for (const r of round1) {
    merged.set(r.entry.id, {
      entry: r.entry,
      score: r.score,
      source: "round1",
    });
  }

  for (const r of round2Results) {
    const existing = merged.get(r.entry.id);
    if (!existing) {
      merged.set(r.entry.id, {
        entry: r.entry,
        score: r.score,
        source: "round2",
      });
    } else if (r.score > existing.score) {
      // Found in both rounds — upgrade score and mark source
      merged.set(r.entry.id, {
        entry: r.entry,
        score: r.score,
        source: round1Ids.has(r.entry.id) ? "both" : "round2",
      });
    } else if (!round1Ids.has(r.entry.id)) {
      // Already in merged from a previous round-2 batch; keep higher score
    } else {
      // Round-1 score was higher, but mark as "both" since it appeared in both
      existing.source = "both";
    }
  }

  // Sort by score descending
  return [...merged.values()].sort((a, b) => b.score - a.score);
}
