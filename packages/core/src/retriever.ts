/**
 * Hybrid Retrieval System
 * Combines vector search + BM25 full-text search with RRF fusion
 */

import type { MemoryEntry, MemoryStore, MemorySearchResult } from "./store.js";
import type { Embedder } from "./embedder.js";
import {
  AccessTracker,
  computeEffectiveHalfLife,
  parseAccessMetadata,
} from "./access-tracker.js";
import { filterNoise } from "./noise-filter.js";
import { filterInterference } from "./rif-filter.js";
import type { DecayEngine, DecayableMemory } from "./decay-engine.js";
import type { KGStore } from "./kg-store.js";
import { isKGModeEnabled } from "./kg-extractor.js";
import { detectEntities } from "./query-entity-detector.js";
import { buildGraph, pprTraverse } from "./ppr-traversal.js";
import type { TierManager } from "./tier-manager.js";
import {
  getDecayableFromEntry,
  isMemoryActiveAt,
  parseSmartMetadata,
  toLifecycleMemory,
  type ScoringTrace,
} from "./smart-metadata.js";
import { parseTemporalQuery, applyTemporalFilter } from "./temporal-parser.js";

// ============================================================================
// Types & Configuration
// ============================================================================

export interface RetrievalConfig {
  mode: "hybrid" | "vector";
  vectorWeight: number;
  bm25Weight: number;
  minScore: number;
  rerank: "cross-encoder" | "lightweight" | "none";
  candidatePoolSize: number;
  /** Recency boost half-life in days (default: 14). Set 0 to disable. */
  recencyHalfLifeDays: number;
  /** Max recency boost factor (default: 0.10) */
  recencyWeight: number;
  /** Filter noise from results (default: true) */
  filterNoise: boolean;
  /** Reranker API key (enables cross-encoder reranking) */
  rerankApiKey?: string;
  /** Reranker model (default: jina-reranker-v3) */
  rerankModel?: string;
  /** Reranker API endpoint (default: https://api.jina.ai/v1/rerank). */
  rerankEndpoint?: string;
  /** Reranker provider format. Determines request/response shape and auth header.
   *  - "jina" (default): Authorization: Bearer, string[] documents, results[].relevance_score
   *  - "siliconflow": same format as jina (alias, for clarity)
   *  - "voyage": Authorization: Bearer, string[] documents, data[].relevance_score
   *  - "pinecone": Api-Key header, {text}[] documents, data[].score
   *  - "tei": Authorization: Bearer, string[] texts, top-level [{ index, score }] */
  rerankProvider?:
    | "jina"
    | "siliconflow"
    | "voyage"
    | "pinecone"
    | "dashscope"
    | "tei";
  /**
   * Length normalization: penalize long entries that dominate via sheer keyword
   * density. Formula: score *= 1 / (1 + log2(charLen / anchor)).
   * anchor = reference length (default: 500 chars). Entries shorter than anchor
   * get a slight boost; longer entries get penalized progressively.
   * Set 0 to disable. (default: 300)
   */
  lengthNormAnchor: number;
  /**
   * Hard cutoff after rerank: discard results below this score.
   * Applied after all scoring stages (rerank, recency, importance, length norm).
   * Higher = fewer but more relevant results. (default: 0.35)
   */
  hardMinScore: number;
  /**
   * Time decay half-life in days. Entries older than this lose score.
   * Different from recencyBoost (additive bonus for new entries):
   * this is a multiplicative penalty for old entries.
   * Formula: score *= 0.5 + 0.5 * exp(-ageDays / halfLife)
   * At halfLife days: ~0.68x. At 2*halfLife: ~0.59x. At 4*halfLife: ~0.52x.
   * Set 0 to disable. (default: 60)
   */
  timeDecayHalfLifeDays: number;
  /** Access reinforcement factor for time decay half-life extension.
   *  Higher = stronger reinforcement. 0 to disable. (default: 0.5) */
  reinforcementFactor: number;
  /** Maximum half-life multiplier from access reinforcement.
   *  Prevents frequently accessed memories from becoming immortal. (default: 3) */
  maxHalfLifeMultiplier: number;
  /** Tag prefixes for exact-match queries (default: ["proj", "env", "team", "scope"]).
   *  Queries containing these prefixes (e.g. "proj:AIF") will use BM25-only + mustContain
   *  to avoid semantic false positives from vector search. */
  tagPrefixes: string[];
  /** RRF constant k (default: 60). Higher values reduce the influence of high-ranked items. */
  rrfK: number;
  /** MMR lambda (default: 0.7, range 0-1). Higher = more relevance, lower = more diversity. */
  mmrLambda?: number;
  /** Enable Retrieval Interference Filter (RIF) — demotes near-duplicate weak results. Default: false. */
  enableRIF?: boolean;
  /** RIF cosine similarity threshold for "near-duplicate" (default: 0.85). */
  rifThreshold?: number;
  /** RIF score ratio: demote if score < ratio * stronger result's score (default: 0.80). */
  rifScoreRatio?: number;
  /**
   * Per-category score thresholds. When a result's category matches a key,
   * that threshold is used instead of hardMinScore. Unknown categories fall
   * back to hardMinScore.
   */
  categoryScoreThresholds?: Record<string, number>;
  /** L0 (concept-level) vector channel weight (default: 0.15). */
  l0Weight?: number;
  /** L1 (structure-level) vector channel weight (default: 0.10). */
  l1Weight?: number;
  /** L2 (detail-level) vector channel weight (default: 0.10). */
  l2Weight?: number;
}

export interface RetrievalContext {
  query: string;
  limit: number;
  scopeFilter?: string[];
  category?: string;
  /** Retrieval source: "manual" for user-triggered, "auto-recall" for system-initiated, "cli" for CLI commands. */
  source?: "manual" | "auto-recall" | "cli";
  /** Enable debug scoring trace. When true, each result will have scoringTrace populated. Default: false. */
  debug?: boolean;
  /** Enable KG graph traversal (PPR) as an additional retrieval signal. */
  graph?: boolean;
}

export type QueryType = "question" | "temporal" | "lookup" | "general";

export interface RetrievalResult extends MemorySearchResult {
  sources: {
    vector?: { score: number; rank: number };
    bm25?: { score: number; rank: number };
    graph?: { score: number; rank: number };
    fused?: { score: number };
    reranked?: { score: number };
  };
  /** Detected query type from the query understanding layer. */
  queryType?: QueryType;
  /** Scoring breakdown for each pipeline stage (populated when debug=true). */
  scoringTrace?: ScoringTrace;
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  mode: "hybrid",
  vectorWeight: 0.35,
  bm25Weight: 0.30,
  l0Weight: 0.15,
  l1Weight: 0.10,
  l2Weight: 0.10,
  minScore: 0.3,
  rerank: "cross-encoder",
  candidatePoolSize: 20,
  recencyHalfLifeDays: 14,
  recencyWeight: 0.1,
  filterNoise: true,
  rerankModel: "jina-reranker-v3",
  rerankEndpoint: "https://api.jina.ai/v1/rerank",
  lengthNormAnchor: 500,
  hardMinScore: 0.35,
  timeDecayHalfLifeDays: 60,
  reinforcementFactor: 0.5,
  maxHalfLifeMultiplier: 3,
  tagPrefixes: ["proj", "env", "team", "scope"],
  rrfK: 60,
  mmrLambda: 0.7,
  categoryScoreThresholds: {
    profile: 0.25, preferences: 0.25, entities: 0.30,
    events: 0.35, cases: 0.45, patterns: 0.45,
  },
};

// ============================================================================
// Category Threshold Filtering
// ============================================================================

/**
 * Filter retrieval results using per-category score thresholds.
 * If a result's category has an entry in `thresholds`, that value is used;
 * otherwise `hardMinScore` is the fallback.
 */
export function applyCategoryThreshold(
  results: Array<{ entry: { category: string }; score: number }>,
  thresholds: Record<string, number>,
  hardMinScore: number,
): Array<{ entry: { category: string }; score: number }> {
  return results.filter((r) => {
    const threshold = thresholds[r.entry.category] ?? hardMinScore;
    return r.score >= threshold;
  });
}

// ============================================================================
// Relation-Aware Reranking
// ============================================================================

export const RELATION_BOOST_PER_HIT = 0.03;
export const RELATION_BOOST_CAP = 0.09;

/**
 * Boost scores of candidates that are connected to other candidates via
 * relations stored in their metadata. Both forward (this → other) and reverse
 * (other → this) relation hits are counted. Total boost is capped at
 * RELATION_BOOST_CAP to avoid overwhelming relevance signals.
 */
export function applyRelationBoost(
  candidates: Array<{ entry: { id: string; metadata?: string }; score: number }>,
): typeof candidates {
  const poolIds = new Set(candidates.map((c) => c.entry.id));

  // Build reverse index: targetId → Set<sourceId>
  const reverseIndex = new Map<string, Set<string>>();
  const forwardMap = new Map<string, string[]>();

  for (const c of candidates) {
    let relations: Array<{ targetId: string }> = [];
    try {
      const meta = typeof c.entry.metadata === "string" ? JSON.parse(c.entry.metadata) : {};
      relations = Array.isArray(meta.relations) ? meta.relations : [];
    } catch { /* ignore parse errors */ }

    const forwardHits: string[] = [];
    for (const rel of relations) {
      if (poolIds.has(rel.targetId)) forwardHits.push(rel.targetId);
      const set = reverseIndex.get(rel.targetId);
      if (set) set.add(c.entry.id);
      else reverseIndex.set(rel.targetId, new Set([c.entry.id]));
    }
    forwardMap.set(c.entry.id, forwardHits);
  }

  for (const c of candidates) {
    const forwardHits = forwardMap.get(c.entry.id)?.length ?? 0;
    const reverseHits = reverseIndex.get(c.entry.id)?.size ?? 0;
    const totalHits = forwardHits + reverseHits;
    if (totalHits > 0) {
      const boost = Math.min(totalHits * RELATION_BOOST_PER_HIT, RELATION_BOOST_CAP);
      c.score = Math.min(1, c.score + boost);
    }
  }
  return candidates;
}

/**
 * Wrapper around applyRelationBoost that also records the boost delta on
 * scoringTrace when debug mode is active.
 */
function applyRelationBoostWithTrace<T extends { score: number; scoringTrace?: import("./smart-metadata.js").ScoringTrace }>(
  candidates: Array<T & { entry: { id: string; metadata?: string } }>,
  debug?: boolean,
): typeof candidates {
  if (!debug) {
    return applyRelationBoost(candidates);
  }
  // Snapshot pre-boost scores
  const preBoost = new Map(candidates.map((c) => [c.entry.id, c.score]));
  const boosted = applyRelationBoost(candidates);
  for (const c of boosted) {
    if (c.scoringTrace) {
      const delta = c.score - (preBoost.get(c.entry.id) ?? c.score);
      if (delta > 0) {
        c.scoringTrace.relationBoost = delta;
      }
    }
  }
  return boosted;
}

// ============================================================================
// Query Understanding (lightweight heuristic — no LLM calls)
// ============================================================================

/**
 * Classify query intent using simple regex heuristics.
 * Used to adjust retrieval weights without requiring an LLM call.
 */
function classifyQuery(query: string): QueryType {
  const q = query.toLowerCase().trim();
  // Temporal: contains date/time keywords
  if (/\b(when|date|time|ago|yesterday|last week|last month|before|after|during)\b/i.test(q)) return "temporal";
  // Question: starts with question word or ends with ?
  if (/^(what|who|where|why|how|which|did|does|is|are|was|were|can|could)\b/i.test(q) || q.endsWith("?")) return "question";
  // Lookup: short, likely entity name (3 words or fewer, no question mark)
  if (q.split(/\s+/).length <= 3 && !q.endsWith("?")) return "lookup";
  return "general";
}

/**
 * Expand temporal queries with date-related keywords.
 * Placeholder — classification alone provides enough signal for now.
 */
function expandTemporalQuery(query: string): string {
  // Future: could append date-pattern tokens to broaden recall
  return query;
}

/**
 * Build a shallow copy of RetrievalConfig with query-type-aware weight
 * adjustments. Never mutates the original config.
 *
 * - temporal:  2x recencyWeight (recent memories matter more)
 * - lookup:    swap vectorWeight/bm25Weight emphasis toward BM25
 * - question / general: no change
 */
function adjustConfigForQueryType(
  config: RetrievalConfig,
  queryType: QueryType,
): RetrievalConfig {
  switch (queryType) {
    case "temporal":
      return {
        ...config,
        recencyWeight: Math.min(config.recencyWeight * 2, 1),
      };
    case "lookup":
      return {
        ...config,
        // Boost BM25 weight for entity/name lookups; keep total weight sum stable
        vectorWeight: Math.max(config.vectorWeight - 0.15, 0.1),
        bm25Weight: Math.min(config.bm25Weight + 0.15, 0.9),
      };
    case "question":
    case "general":
    default:
      return config;
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return Number.isFinite(fallback) ? fallback : 0;
  return Math.min(1, Math.max(0, value));
}

function clamp01WithFloor(value: number, floor: number): number {
  const safeFloor = clamp01(floor, 0);
  return Math.max(safeFloor, clamp01(value, safeFloor));
}

// ============================================================================
// Rerank Provider Adapters
// ============================================================================

type RerankProvider =
  | "jina"
  | "siliconflow"
  | "voyage"
  | "pinecone"
  | "dashscope"
  | "tei";

interface RerankItem {
  index: number;
  score: number;
}

/** Build provider-specific request headers and body */
function buildRerankRequest(
  provider: RerankProvider,
  apiKey: string,
  model: string,
  query: string,
  candidates: string[],
  topN: number,
): { headers: Record<string, string>; body: Record<string, unknown> } {
  switch (provider) {
    case "tei":
      return {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: {
          query,
          texts: candidates,
        },
      };
    case "dashscope":
      // DashScope wraps query+documents under `input` and does not use top_n.
      // Endpoint: https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank
      return {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: {
          model,
          input: {
            query,
            documents: candidates,
          },
        },
      };
    case "pinecone":
      return {
        headers: {
          "Content-Type": "application/json",
          "Api-Key": apiKey,
          "X-Pinecone-API-Version": "2024-10",
        },
        body: {
          model,
          query,
          documents: candidates.map((text) => ({ text })),
          top_n: topN,
          rank_fields: ["text"],
        },
      };
    case "voyage":
      return {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: {
          model,
          query,
          documents: candidates,
          // Voyage uses top_k (not top_n) to limit reranked outputs.
          top_k: topN,
        },
      };
    case "siliconflow":
    case "jina":
    default:
      return {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: {
          model,
          query,
          documents: candidates,
          top_n: topN,
        },
      };
  }
}

/** Parse provider-specific response into unified format */
function parseRerankResponse(
  provider: RerankProvider,
  data: unknown,
): RerankItem[] | null {
  const parseItems = (
    items: unknown,
    scoreKeys: Array<"score" | "relevance_score">,
  ): RerankItem[] | null => {
    if (!Array.isArray(items)) return null;
    const parsed: RerankItem[] = [];
    for (const raw of items as Array<Record<string, unknown>>) {
      const index =
        typeof raw?.index === "number" ? raw.index : Number(raw?.index);
      if (!Number.isFinite(index)) continue;
      let score: number | null = null;
      for (const key of scoreKeys) {
        const value = raw?.[key];
        const n = typeof value === "number" ? value : Number(value);
        if (Number.isFinite(n)) {
          score = n;
          break;
        }
      }
      if (score === null) continue;
      parsed.push({ index, score });
    }
    return parsed.length > 0 ? parsed : null;
  };
  const objectData =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;

  switch (provider) {
    case "tei":
      return (
        parseItems(data, ["score", "relevance_score"]) ??
        parseItems(objectData?.results, ["score", "relevance_score"]) ??
        parseItems(objectData?.data, ["score", "relevance_score"])
      );
    case "dashscope": {
      // DashScope: { output: { results: [{ index, relevance_score }] } }
      const output = objectData?.output as Record<string, unknown> | undefined;
      if (output) {
        return parseItems(output.results, ["relevance_score", "score"]);
      }
      // Fallback: try top-level results in case API format changes
      return parseItems(objectData?.results, ["relevance_score", "score"]);
    }
    case "pinecone": {
      // Pinecone: usually { data: [{ index, score, ... }] }
      // Also tolerate results[] with score/relevance_score for robustness.
      return (
        parseItems(objectData?.data, ["score", "relevance_score"]) ??
        parseItems(objectData?.results, ["score", "relevance_score"])
      );
    }
    case "voyage": {
      // Voyage: usually { data: [{ index, relevance_score }] }
      // Also tolerate results[] for compatibility across gateways.
      return (
        parseItems(objectData?.data, ["relevance_score", "score"]) ??
        parseItems(objectData?.results, ["relevance_score", "score"])
      );
    }
    case "siliconflow":
    case "jina":
    default: {
      // Jina / SiliconFlow: usually { results: [{ index, relevance_score }] }
      // Also tolerate data[] for compatibility across gateways.
      return (
        parseItems(objectData?.results, ["relevance_score", "score"]) ??
        parseItems(objectData?.data, ["relevance_score", "score"])
      );
    }
  }
}

// Cosine similarity for reranking fallback
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Vector dimensions must match for cosine similarity");
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const norm = Math.sqrt(normA) * Math.sqrt(normB);
  return norm === 0 ? 0 : dotProduct / norm;
}

// ============================================================================
// 5-Channel RRF Fusion
// ============================================================================

interface ChannelInput {
  results: MemorySearchResult[];
  weight: number;
  channelName: string;  // "vector", "l0", "l1", "l2", "bm25"
}

function setChannelTrace(trace: ScoringTrace, channel: string, score: number, rank: number): void {
  switch (channel) {
    case "vector": trace.vectorScore = score; trace.vectorRank = rank; break;
    case "l0": trace.l0Score = score; break;
    case "l1": trace.l1Score = score; break;
    case "l2": trace.l2Score = score; break;
    case "bm25": trace.bm25Score = score; trace.bm25Rank = rank; break;
  }
}

function fuseMultiChannelResults(
  channels: ChannelInput[],
  rrfK: number,
  bm25Results: MemorySearchResult[],
  debug?: boolean,
): Map<string, RetrievalResult> {
  const fusionMap = new Map<string, RetrievalResult>();

  for (const ch of channels) {
    for (let rank = 0; rank < ch.results.length; rank++) {
      const r = ch.results[rank];
      const rrfScore = ch.weight / (rrfK + rank + 1);
      const existing = fusionMap.get(r.entry.id);

      if (existing) {
        existing.score += rrfScore;
        if (debug && existing.scoringTrace) {
          setChannelTrace(existing.scoringTrace, ch.channelName, r.score, rank + 1);
        }
      } else {
        const result: RetrievalResult = {
          entry: r.entry,
          score: rrfScore,
          sources: {},
        };
        if (debug) {
          result.scoringTrace = { finalScore: 0, searchPath: "hybrid" };
          setChannelTrace(result.scoringTrace, ch.channelName, r.score, rank + 1);
        }
        fusionMap.set(r.entry.id, result);
      }
    }
  }

  // BM25 high-score floor: if bm25Score >= 0.75, ensure fused >= bm25Score * 0.92
  for (const bm25r of bm25Results) {
    if (bm25r.score >= 0.75) {
      const existing = fusionMap.get(bm25r.entry.id);
      if (existing && existing.score < bm25r.score * 0.92) {
        existing.score = bm25r.score * 0.92;
      }
    }
  }

  return fusionMap;
}

// ============================================================================
// Memory Retriever
// ============================================================================

export class MemoryRetriever {
  private accessTracker: AccessTracker | null = null;
  private tierManager: TierManager | null = null;
  private kgStore?: KGStore;

  constructor(
    private store: MemoryStore,
    private embedder: Embedder,
    private config: RetrievalConfig = DEFAULT_RETRIEVAL_CONFIG,
    private decayEngine: DecayEngine | null = null,
  ) { }

  setAccessTracker(tracker: AccessTracker): void {
    this.accessTracker = tracker;
  }

  /** Attach a KGStore to enable graph-based retrieval (PPR). */
  setKGStore(kgStore: KGStore): void {
    this.kgStore = kgStore;
  }

  private filterActiveResults<T extends MemorySearchResult>(results: T[]): T[] {
    return results.filter((result) =>
      isMemoryActiveAt(parseSmartMetadata(result.entry.metadata, result.entry)),
    );
  }

  async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
    const { query, limit, scopeFilter, category, source, debug, graph } = context;
    const safeLimit = clampInt(limit, 1, 20);

    // ── Temporal filter extraction ──
    const temporalFilter = parseTemporalQuery(query);
    const searchQuery = temporalFilter.anchor ? temporalFilter.cleanedQuery : query;

    // ── Query understanding layer (lightweight heuristic) ──
    const queryType = classifyQuery(searchQuery);
    const effectiveQuery = queryType === "temporal"
      ? expandTemporalQuery(searchQuery)
      : searchQuery;

    // Apply query-type-aware weight adjustments into a LOCAL copy so
    // concurrent retrieve() calls never corrupt each other's config.
    const effectiveConfig = adjustConfigForQueryType(this.config, queryType);

    // Check if query contains tag prefixes -> use BM25-only + mustContain
    const tagTokens = this.extractTagTokens(effectiveQuery);
    let results: RetrievalResult[];

    if (tagTokens.length > 0) {
      results = await this.bm25OnlyRetrieval(
        effectiveQuery,
        tagTokens,
        safeLimit,
        scopeFilter,
        category,
        effectiveConfig,
        debug,
      );
    } else if (effectiveConfig.mode === "vector" || !this.store.hasFtsSupport) {
      results = await this.vectorOnlyRetrieval(
        effectiveQuery,
        safeLimit,
        scopeFilter,
        category,
        effectiveConfig,
        debug,
      );
    } else {
      results = await this.hybridRetrieval(
        effectiveQuery,
        safeLimit,
        scopeFilter,
        category,
        effectiveConfig,
        debug,
        graph,
      );
    }

    // ── Apply temporal post-filter ──
    results = applyTemporalFilter(results, temporalFilter);
    if (results.length > safeLimit) results = results.slice(0, safeLimit);

    // Stamp queryType on every result and finalize scoringTrace
    results = results.map((r) => {
      const stamped = { ...r, queryType };
      if (debug && stamped.scoringTrace) {
        stamped.scoringTrace.finalScore = stamped.score;
        stamped.scoringTrace.queryType = queryType;
      }
      return stamped;
    });

    // Record access for reinforcement (manual recall only)
    if (this.accessTracker && source === "manual" && results.length > 0) {
      this.accessTracker.recordAccess(results.map((r) => r.entry.id));
    }

    return results;
  }

  private extractTagTokens(query: string): string[] {
    if (!this.config.tagPrefixes?.length) return [];
    
    const pattern = this.config.tagPrefixes.join("|");
    const regex = new RegExp(`(?:${pattern}):[\\w-]+`, "gi");
    const matches = query.match(regex);
    return matches || [];
  }

  private async vectorOnlyRetrieval(
    query: string,
    limit: number,
    scopeFilter?: string[],
    category?: string,
    cfg?: RetrievalConfig,
    debug?: boolean,
  ): Promise<RetrievalResult[]> {
    const c = cfg ?? this.config;
    const queryVector = await this.embedder.embedQuery(query);
    const poolSize = Math.max(c.candidatePoolSize, limit * 2);

    // Run 4 vector channels in parallel (no BM25)
    const [vectorRes, l0Res, l1Res, l2Res] = await Promise.all([
      this.store.vectorSearch(queryVector, poolSize, c.minScore, scopeFilter, { excludeInactive: true }),
      this.store.vectorSearch(queryVector, poolSize, c.minScore, scopeFilter, { excludeInactive: true, column: "vector_l0" }),
      this.store.vectorSearch(queryVector, poolSize, c.minScore, scopeFilter, { excludeInactive: true, column: "vector_l1" }),
      this.store.vectorSearch(queryVector, poolSize, c.minScore, scopeFilter, { excludeInactive: true, column: "vector_l2" }),
    ]);

    // Apply category filter
    const filterCat = <T extends MemorySearchResult>(results: T[]): T[] =>
      category ? results.filter((r) => r.entry.category === category) : results;

    // Vector-only weight allocation: vector=0.50, l0=0.20, l1=0.15, l2=0.15
    const fusionMap = fuseMultiChannelResults(
      [
        { results: filterCat(vectorRes), weight: 0.50, channelName: "vector" },
        { results: filterCat(l0Res), weight: 0.20, channelName: "l0" },
        { results: filterCat(l1Res), weight: 0.15, channelName: "l1" },
        { results: filterCat(l2Res), weight: 0.15, channelName: "l2" },
      ],
      c.rrfK,
      [], // no BM25 results
      debug,
    );

    // Override searchPath for vector-only mode
    if (debug) {
      for (const result of fusionMap.values()) {
        if (result.scoringTrace) {
          result.scoringTrace.searchPath = "vector-only";
        }
      }
    }

    const mapped = Array.from(fusionMap.values()).sort((a, b) => b.score - a.score);

    const weighted = this.decayEngine ? mapped : this.applyImportanceWeight(this.applyRecencyBoost(mapped, c, debug), debug);
    const lengthNormalized = this.applyLengthNormalization(weighted, debug);
    const relationBoosted = applyRelationBoostWithTrace(lengthNormalized, debug);
    const hardFiltered = applyCategoryThreshold(
      relationBoosted,
      c.categoryScoreThresholds ?? {},
      c.hardMinScore,
    );
    const lifecycleRanked = this.decayEngine
      ? this.applyDecayBoost(hardFiltered, debug)
      : this.applyTimeDecay(hardFiltered, debug);
    const denoised = c.filterNoise
      ? filterNoise(lifecycleRanked, r => r.entry.text)
      : lifecycleRanked;

    // RIF: demote near-duplicate weak results to improve diversity
    const rifFiltered = c.enableRIF
      ? filterInterference(denoised, c.rifThreshold ?? 0.85, c.rifScoreRatio ?? 0.80)
      : denoised;

    // MMR deduplication: avoid top-k filled with near-identical memories
    const deduplicated = this.applyMMR(rifFiltered, limit, c.mmrLambda ?? 0.7, debug);

    return deduplicated.slice(0, limit);
  }

  private async bm25OnlyRetrieval(
    query: string,
    tagTokens: string[],
    limit: number,
    scopeFilter?: string[],
    category?: string,
    cfg?: RetrievalConfig,
    debug?: boolean,
  ): Promise<RetrievalResult[]> {
    const c = cfg ?? this.config;
    const candidatePoolSize = Math.max(c.candidatePoolSize, limit * 2);

    // Run BM25 search
    const bm25Results = await this.store.bm25Search(
      query,
      candidatePoolSize,
      scopeFilter,
      { excludeInactive: true },
    );

    // Filter by category if specified
    const categoryFiltered = category
      ? bm25Results.filter((r) => r.entry.category === category)
      : bm25Results;

    // mustContain: only keep entries that literally contain all tag tokens (case-insensitive)
    const mustContainFiltered = categoryFiltered.filter((r) => {
      const textLower = r.entry.text.toLowerCase();
      return tagTokens.every((t) => textLower.includes(t.toLowerCase()));
    });

    const mapped = mustContainFiltered.map(
      (result, index) => {
        const r: RetrievalResult = {
          ...result,
          sources: {
            bm25: { score: result.score, rank: index + 1 },
          },
        };
        if (debug) {
          r.scoringTrace = {
            finalScore: 0,
            searchPath: "bm25-only",
            bm25Score: result.score,
            bm25Rank: index + 1,
          };
        }
        return r;
      },
    );

    // Apply same post-processing as hybrid retrieval to avoid behavior regression
    const temporallyRanked = this.decayEngine
      ? mapped
      : this.applyImportanceWeight(this.applyRecencyBoost(mapped, c, debug), debug);

    const lengthNormalized = this.applyLengthNormalization(temporallyRanked, debug);
    const relationBoosted = applyRelationBoostWithTrace(lengthNormalized, debug);
    const hardFiltered = applyCategoryThreshold(
      relationBoosted,
      c.categoryScoreThresholds ?? {},
      c.hardMinScore,
    );

    const lifecycleRanked = this.decayEngine
      ? this.applyDecayBoost(hardFiltered, debug)
      : this.applyTimeDecay(hardFiltered, debug);

    const denoised = c.filterNoise
      ? filterNoise(lifecycleRanked, r => r.entry.text)
      : lifecycleRanked;

    const rifFiltered = c.enableRIF
      ? filterInterference(denoised, c.rifThreshold ?? 0.85, c.rifScoreRatio ?? 0.80)
      : denoised;

    const deduplicated = this.applyMMR(rifFiltered, limit, c.mmrLambda ?? 0.7, debug);
    return deduplicated.slice(0, limit);
  }

  private async hybridRetrieval(
    query: string,
    limit: number,
    scopeFilter?: string[],
    category?: string,
    cfg?: RetrievalConfig,
    debug?: boolean,
    graph?: boolean,
  ): Promise<RetrievalResult[]> {
    const c = cfg ?? this.config;
    const candidatePoolSize = Math.max(
      c.candidatePoolSize,
      limit * 2,
    );

    // Compute query embedding once, reuse for vector search + reranking
    const queryVector = await this.embedder.embedQuery(query);
    const poolSize = candidatePoolSize;

    // Run 5 channels in parallel: vector + L0 + L1 + L2 + BM25
    const [vectorRes, l0Res, l1Res, l2Res, bm25Res] = await Promise.all([
      this.store.vectorSearch(queryVector, poolSize, c.minScore, scopeFilter, { excludeInactive: true }),
      this.store.vectorSearch(queryVector, poolSize, c.minScore, scopeFilter, { excludeInactive: true, column: "vector_l0" }),
      this.store.vectorSearch(queryVector, poolSize, c.minScore, scopeFilter, { excludeInactive: true, column: "vector_l1" }),
      this.store.vectorSearch(queryVector, poolSize, c.minScore, scopeFilter, { excludeInactive: true, column: "vector_l2" }),
      this.store.bm25Search(query, poolSize, scopeFilter, { excludeInactive: true }),
    ]);

    // Apply category filter to all channels
    const filterCat = <T extends MemorySearchResult>(results: T[]): T[] =>
      category ? results.filter((r) => r.entry.category === category) : results;

    const vectorFiltered = filterCat(vectorRes);
    const l0Filtered = filterCat(l0Res);
    const l1Filtered = filterCat(l1Res);
    const l2Filtered = filterCat(l2Res);
    const bm25Filtered = filterCat(bm25Res);

    // Validate BM25-only entries (ghost entry check)
    const vectorIds = new Set(vectorFiltered.map((r) => r.entry.id));
    const validatedBm25: MemorySearchResult[] = [];
    for (const r of bm25Filtered) {
      if (vectorIds.has(r.entry.id)) {
        validatedBm25.push(r);
      } else {
        try {
          const exists = await this.store.hasId(r.entry.id);
          if (exists) validatedBm25.push(r);
        } catch {
          validatedBm25.push(r); // fail-open
        }
      }
    }

    const fusionMap = fuseMultiChannelResults(
      [
        { results: vectorFiltered, weight: c.vectorWeight, channelName: "vector" },
        { results: l0Filtered, weight: c.l0Weight ?? 0.15, channelName: "l0" },
        { results: l1Filtered, weight: c.l1Weight ?? 0.10, channelName: "l1" },
        { results: l2Filtered, weight: c.l2Weight ?? 0.10, channelName: "l2" },
        { results: validatedBm25, weight: c.bm25Weight, channelName: "bm25" },
      ],
      c.rrfK,
      validatedBm25,
      debug,
    );

    // BM25-only results (no vector match) fall back to raw BM25 score
    for (const bm25r of validatedBm25) {
      if (!vectorIds.has(bm25r.entry.id)) {
        const existing = fusionMap.get(bm25r.entry.id);
        if (existing) {
          existing.score = clamp01(bm25r.score, 0.1);
        }
      }
    }

    // KG graph traversal (PPR) — boost existing results or add graph-only results
    if (graph && isKGModeEnabled() && this.kgStore) {
      try {
        const scope = scopeFilter?.[0];
        const graphResults = await this.runPPRSearch(query, scope);
        for (const gr of graphResults) {
          const existing = fusionMap.get(gr.entry.id);
          if (existing) {
            // Boost existing result by up to 20% of graph score
            existing.score = clamp01(existing.score + gr.score * 0.20, 0.1);
            existing.sources.graph = gr.sources.graph;
          } else {
            // Graph-only result: use graph score directly
            fusionMap.set(gr.entry.id, gr);
          }
        }
      } catch (err) {
        console.error(`[PPR] graph traversal failed, continuing without: ${String(err)}`);
      }
    }

    // Convert fusion map to sorted array
    const fusedResults = Array.from(fusionMap.values()).sort((a, b) => b.score - a.score);

    // Populate sources for backward compat
    for (const result of fusedResults) {
      result.sources.fused = { score: result.score };
      if (debug && result.scoringTrace) {
        result.scoringTrace.rrfFused = result.score;
      }
    }

    // Apply minimum score threshold
    const filtered = fusedResults.filter(
      (r) => r.score >= c.minScore,
    );

    // Rerank if enabled
    const reranked =
      c.rerank !== "none"
        ? await this.rerankResults(
          query,
          queryVector,
          filtered.slice(0, limit * 2),
          debug,
        )
        : filtered;

    const temporallyRanked = this.decayEngine
      ? reranked
      : this.applyImportanceWeight(this.applyRecencyBoost(reranked, c, debug), debug);

    // Apply length normalization (penalize long entries dominating via keyword density)
    const lengthNormalized = this.applyLengthNormalization(temporallyRanked, debug);

    // Boost candidates connected by relations within the result pool
    const relationBoosted = applyRelationBoostWithTrace(lengthNormalized, debug);

    // Hard minimum score cutoff should be based on semantic / lexical relevance.
    // Lifecycle decay and time-decay are used for re-ranking, not for dropping
    // otherwise relevant fresh memories.
    const hardFiltered = applyCategoryThreshold(
      relationBoosted,
      c.categoryScoreThresholds ?? {},
      c.hardMinScore,
    );

    // Apply lifecycle-aware decay or legacy time decay after thresholding
    const lifecycleRanked = this.decayEngine
      ? this.applyDecayBoost(hardFiltered, debug)
      : this.applyTimeDecay(hardFiltered, debug);

    // Filter noise
    const denoised = c.filterNoise
      ? filterNoise(lifecycleRanked, r => r.entry.text)
      : lifecycleRanked;

    // RIF: demote near-duplicate weak results to improve diversity
    const rifFiltered = c.enableRIF
      ? filterInterference(denoised, c.rifThreshold ?? 0.85, c.rifScoreRatio ?? 0.80)
      : denoised;

    // MMR deduplication: avoid top-k filled with near-identical memories
    const deduplicated = this.applyMMR(rifFiltered, limit, c.mmrLambda ?? 0.7, debug);

    return deduplicated.slice(0, limit);
  }

  /**
   * Run PPR graph traversal: detect entities -> BFS neighborhood -> PPR -> map to MemoryEntry.
   * Returns RetrievalResult[] with graph source scores.
   */
  private async runPPRSearch(
    query: string,
    scope?: string,
  ): Promise<RetrievalResult[]> {
    if (!this.kgStore) return [];

    const detected = await detectEntities(query, this.kgStore, scope);
    if (detected.entities.length === 0) return [];

    // BFS neighborhood from KG
    const hopLimit = detected.isMultiHop ? 3 : 2;
    const neighborhood = await this.kgStore.getNeighborhood(detected.entities, hopLimit, scope);
    if (neighborhood.length === 0) return [];

    // Run PPR
    const graph = buildGraph(neighborhood);
    const pprResults = pprTraverse(graph, detected.entities, { hopLimit, topK: 20 });
    if (pprResults.length === 0) return [];

    // Map PPR entity scores back to source memory entries
    const entityScoreMap = new Map(pprResults.map(r => [r.entity, r.score]));
    const memoryScoreMap = new Map<string, number>();

    for (const nr of neighborhood) {
      for (const triple of nr.triples) {
        const subjectScore = entityScoreMap.get(triple.subject) ?? 0;
        const objectScore = entityScoreMap.get(triple.object) ?? 0;
        const tripleScore = Math.max(subjectScore, objectScore) * triple.confidence;

        if (tripleScore > 0 && triple.source_memory_id) {
          const existing = memoryScoreMap.get(triple.source_memory_id) ?? 0;
          memoryScoreMap.set(triple.source_memory_id, Math.max(existing, tripleScore));
        }
      }
    }

    // Fetch memory entries for the top scored memories
    const sortedMemories = [...memoryScoreMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);

    const results: RetrievalResult[] = [];
    let rank = 0;
    for (const [memId, score] of sortedMemories) {
      const entry = await this.store.getById(memId);
      if (!entry) continue;
      rank++;
      results.push({
        entry,
        score,
        sources: {
          graph: { score, rank },
        },
      });
    }

    return results;
  }

  private async runVectorSearch(
    queryVector: number[],
    limit: number,
    scopeFilter?: string[],
    category?: string,
  ): Promise<Array<MemorySearchResult & { rank: number }>> {
    const results = await this.store.vectorSearch(
      queryVector,
      limit,
      0.1,
      scopeFilter,
      { excludeInactive: true },
    );

    // Filter by category if specified
    const filtered = category
      ? results.filter((r) => r.entry.category === category)
      : results;

    return filtered.map((result, index) => ({
      ...result,
      rank: index + 1,
    }));
  }

  private async runBM25Search(
    query: string,
    limit: number,
    scopeFilter?: string[],
    category?: string,
  ): Promise<Array<MemorySearchResult & { rank: number }>> {
    const results = await this.store.bm25Search(query, limit, scopeFilter, { excludeInactive: true });

    // Filter by category if specified
    const filtered = category
      ? results.filter((r) => r.entry.category === category)
      : results;

    return filtered.map((result, index) => ({
      ...result,
      rank: index + 1,
    }));
  }

  private async fuseResults(
    vectorResults: Array<MemorySearchResult & { rank: number }>,
    bm25Results: Array<MemorySearchResult & { rank: number }>,
    cfg?: RetrievalConfig,
    debug?: boolean,
  ): Promise<RetrievalResult[]> {
    const c = cfg ?? this.config;
    // Create maps for quick lookup
    const vectorMap = new Map<string, MemorySearchResult & { rank: number }>();
    const bm25Map = new Map<string, MemorySearchResult & { rank: number }>();

    vectorResults.forEach((result) => {
      vectorMap.set(result.entry.id, result);
    });

    bm25Results.forEach((result) => {
      bm25Map.set(result.entry.id, result);
    });

    // Get all unique document IDs
    const allIds = new Set([...vectorMap.keys(), ...bm25Map.keys()]);

    // True RRF uses rank positions rather than raw scores, making it robust
    // to score distribution differences between vector and BM25 systems.
    const k = c.rrfK;
    const fusedResults: RetrievalResult[] = [];

    for (const id of allIds) {
      const vectorResult = vectorMap.get(id);
      const bm25Result = bm25Map.get(id);

      // FIX(#15): BM25-only results may be "ghost" entries whose vector data was
      // deleted but whose FTS index entry lingers until the next index rebuild.
      // Validate that the entry actually exists in the store before including it.
      if (!vectorResult && bm25Result) {
        try {
          const exists = await this.store.hasId(id);
          if (!exists) continue; // Skip ghost entry
        } catch {
          // If hasId fails, keep the result (fail-open)
        }
      }

      // Use the result with more complete data (prefer vector result if both exist)
      const baseResult = vectorResult || bm25Result!;

      // RRF: score = Σ (weight_i / (k + rank_i))
      const vectorRRF = vectorResult
        ? c.vectorWeight / (k + vectorResult.rank)
        : 0;
      const bm25RRF = bm25Result
        ? c.bm25Weight / (k + bm25Result.rank)
        : 0;
      let fusedScore = vectorRRF + bm25RRF;

      // High-score floor fallback: if a BM25 result has normalized score >= 0.75,
      // ensure its fused score is at least bm25Score * 0.92. This preserves exact
      // keyword matches (e.g. API keys, ticket numbers) that may rank poorly in
      // vector search.
      if (bm25Result && bm25Result.score >= 0.75) {
        fusedScore = Math.max(fusedScore, bm25Result.score * 0.92);
      }

      // BM25-only results (no vector match) fall back to raw BM25 score
      if (!vectorResult) {
        fusedScore = clamp01(bm25Result!.score, 0.1);
      }

      const fusedEntry: RetrievalResult = {
        entry: baseResult.entry,
        score: fusedScore,
        sources: {
          vector: vectorResult
            ? { score: vectorResult.score, rank: vectorResult.rank }
            : undefined,
          bm25: bm25Result
            ? { score: bm25Result.score, rank: bm25Result.rank }
            : undefined,
          fused: { score: fusedScore },
        },
      };
      if (debug) {
        fusedEntry.scoringTrace = {
          finalScore: 0,
          searchPath: "hybrid",
          vectorScore: vectorResult?.score,
          vectorRank: vectorResult?.rank,
          bm25Score: bm25Result?.score,
          bm25Rank: bm25Result?.rank,
          rrfFused: fusedScore,
        };
      }
      fusedResults.push(fusedEntry);
    }

    // Sort by fused score descending
    return fusedResults.sort((a, b) => b.score - a.score);
  }

  /**
   * Rerank results using cross-encoder API (Jina, Pinecone, or compatible).
   * Falls back to cosine similarity if API is unavailable or fails.
   */
  private async rerankResults(
    query: string,
    queryVector: number[],
    results: RetrievalResult[],
    debug?: boolean,
  ): Promise<RetrievalResult[]> {
    if (results.length === 0) {
      return results;
    }

    // Try cross-encoder rerank via configured provider API
    if (this.config.rerank === "cross-encoder" && this.config.rerankApiKey) {
      try {
        const provider = this.config.rerankProvider || "jina";
        const model = this.config.rerankModel || "jina-reranker-v3";
        const endpoint =
          this.config.rerankEndpoint || "https://api.jina.ai/v1/rerank";
        const documents = results.map((r) => r.entry.text);

        // Build provider-specific request
        const { headers, body } = buildRerankRequest(
          provider,
          this.config.rerankApiKey,
          model,
          query,
          documents,
          results.length,
        );

        // Timeout: 5 seconds to prevent stalling retrieval pipeline
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (response.ok) {
          const data: unknown = await response.json();

          // Parse provider-specific response into unified format
          const parsed = parseRerankResponse(provider, data);

          if (!parsed) {
            console.warn(
              "Rerank API: invalid response shape, falling back to cosine",
            );
          } else {
            // Build a Set of returned indices to identify unreturned candidates
            const returnedIndices = new Set(parsed.map((r) => r.index));

            const reranked = parsed
              .filter((item) => item.index >= 0 && item.index < results.length)
              .map((item) => {
                const original = results[item.index];
                const floor = this.getRerankPreservationFloor(original, false);
                // Blend: 60% cross-encoder score + 40% original fused score
                const blendedScore = clamp01WithFloor(
                  item.score * 0.6 + original.score * 0.4,
                  floor,
                );
                const out: RetrievalResult = {
                  ...original,
                  score: blendedScore,
                  sources: {
                    ...original.sources,
                    reranked: { score: item.score },
                  },
                };
                if (debug && out.scoringTrace) {
                  out.scoringTrace.rerankScore = item.score;
                  out.scoringTrace.rerankBlended = blendedScore;
                }
                return out;
              });

            // Keep unreturned candidates with their original scores (slightly penalized)
            const unreturned = results
              .filter((_, idx) => !returnedIndices.has(idx))
              .map(r => ({
                ...r,
                score: clamp01WithFloor(
                  r.score * 0.8,
                  this.getRerankPreservationFloor(r, true),
                ),
              }));

            return [...reranked, ...unreturned].sort(
              (a, b) => b.score - a.score,
            );
          }
        } else {
          const errText = await response.text().catch(() => "");
          console.warn(
            `Rerank API returned ${response.status}: ${errText.slice(0, 200)}, falling back to cosine`,
          );
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          console.warn("Rerank API timed out (5s), falling back to cosine");
        } else {
          console.warn("Rerank API failed, falling back to cosine:", error);
        }
      }
    }

    // Fallback: lightweight cosine similarity rerank
    try {
      const reranked = results.map((result) => {
        const cosineScore = cosineSimilarity(queryVector, result.entry.vector);
        const combinedScore = result.score * 0.7 + cosineScore * 0.3;
        const blendedScore = clamp01(combinedScore, result.score);
        const out: RetrievalResult = {
          ...result,
          score: blendedScore,
          sources: {
            ...result.sources,
            reranked: { score: cosineScore },
          },
        };
        if (debug && out.scoringTrace) {
          out.scoringTrace.rerankScore = cosineScore;
          out.scoringTrace.rerankBlended = blendedScore;
        }
        return out;
      });

      return reranked.sort((a, b) => b.score - a.score);
    } catch (error) {
      console.warn("Reranking failed, returning original results:", error);
      return results;
    }
  }

  private getRerankPreservationFloor(result: RetrievalResult, unreturned: boolean): number {
    const bm25Score = result.sources.bm25?.score ?? 0;

    // Exact lexical hits (IDs, env vars, ticket numbers) should not disappear
    // just because a reranker under-scores symbolic or mixed-language queries.
    if (bm25Score >= 0.75) {
      return result.score * (unreturned ? 1.0 : 0.95);
    }
    if (bm25Score >= 0.6) {
      return result.score * (unreturned ? 0.95 : 0.9);
    }
    return result.score * (unreturned ? 0.8 : 0.5);
  }

  /**
   * Apply recency boost: newer memories get a small score bonus.
   * This ensures corrections/updates naturally outrank older entries
   * when semantic similarity is close.
   * Formula: boost = exp(-ageDays / halfLife) * weight
   */
  private applyRecencyBoost(results: RetrievalResult[], cfg?: RetrievalConfig, debug?: boolean): RetrievalResult[] {
    const { recencyHalfLifeDays, recencyWeight } = cfg ?? this.config;
    if (!recencyHalfLifeDays || recencyHalfLifeDays <= 0 || !recencyWeight) {
      return results;
    }

    const now = Date.now();
    const boosted = results.map((r) => {
      const ts =
        r.entry.timestamp && r.entry.timestamp > 0 ? r.entry.timestamp : now;
      const ageDays = (now - ts) / 86_400_000;
      const boost = Math.exp(-ageDays / recencyHalfLifeDays) * recencyWeight;
      const out: RetrievalResult = {
        ...r,
        score: clamp01(r.score + boost, r.score),
      };
      if (debug && out.scoringTrace) {
        out.scoringTrace.recencyBoost = boost;
      }
      return out;
    });

    return boosted.sort((a, b) => b.score - a.score);
  }

  /**
   * Apply importance weighting: memories with higher importance get a score boost.
   * This ensures critical memories (importance=1.0) outrank casual ones (importance=0.5)
   * when semantic similarity is close.
   * Formula: score *= (baseWeight + (1 - baseWeight) * importance)
   * With baseWeight=0.7: importance=1.0 → ×1.0, importance=0.5 → ×0.85, importance=0.0 → ×0.7
   */
  private applyImportanceWeight(results: RetrievalResult[], debug?: boolean): RetrievalResult[] {
    const baseWeight = 0.7;
    const weighted = results.map((r) => {
      const importance = r.entry.importance ?? 0.7;
      const factor = baseWeight + (1 - baseWeight) * importance;
      const out: RetrievalResult = {
        ...r,
        score: clamp01(r.score * factor, r.score * baseWeight),
      };
      if (debug && out.scoringTrace) {
        out.scoringTrace.importanceWeight = factor;
      }
      return out;
    });
    return weighted.sort((a, b) => b.score - a.score);
  }

  private applyDecayBoost(results: RetrievalResult[], debug?: boolean): RetrievalResult[] {
    if (!this.decayEngine || results.length === 0) return results;

    const scored = results.map((result) => {
      const meta = parseSmartMetadata(result.entry.metadata, result.entry);
      return {
        memory: toLifecycleMemory(result.entry.id, result.entry),
        score: result.score,
        category: meta.memory_category,
      };
    });

    this.decayEngine.applySearchBoost(scored);

    const reranked = results.map((result, index) => {
      const newScore = clamp01(scored[index].score, result.score * 0.3);
      const out: RetrievalResult = { ...result, score: newScore };
      if (debug && out.scoringTrace) {
        out.scoringTrace.lifecycleDecay = newScore / (result.score || 1);
      }
      return out;
    });

    return reranked.sort((a, b) => b.score - a.score);
  }

  /**
   * Length normalization: penalize long entries that dominate search results
   * via sheer keyword density and broad semantic coverage.
   * Short, focused entries (< anchor) get a slight boost.
   * Long, sprawling entries (> anchor) get penalized.
   * Formula: score *= 1 / (1 + log2(charLen / anchor))
   */
  private applyLengthNormalization(
    results: RetrievalResult[],
    debug?: boolean,
  ): RetrievalResult[] {
    const anchor = this.config.lengthNormAnchor;
    if (!anchor || anchor <= 0) return results;

    const normalized = results.map((r) => {
      const charLen = r.entry.text.length;
      const ratio = charLen / anchor;
      // No penalty for entries at or below anchor length.
      // Gentle logarithmic decay for longer entries:
      //   anchor (500) → 1.0, 800 → 0.75, 1000 → 0.67, 1500 → 0.56, 2000 → 0.50
      // This prevents long, keyword-rich entries from dominating top-k
      // while keeping their scores reasonable.
      const logRatio = Math.log2(Math.max(ratio, 1)); // no boost for short entries
      const factor = 1 / (1 + 0.5 * logRatio);
      const out: RetrievalResult = {
        ...r,
        score: clamp01(r.score * factor, r.score * 0.3),
      };
      if (debug && out.scoringTrace) {
        out.scoringTrace.lengthNorm = factor;
      }
      return out;
    });

    return normalized.sort((a, b) => b.score - a.score);
  }

  /**
   * Time decay: multiplicative penalty for old entries.
   * Unlike recencyBoost (additive bonus for new entries), this actively
   * penalizes stale information so recent knowledge wins ties.
   * Formula: score *= 0.5 + 0.5 * exp(-ageDays / halfLife)
   * At 0 days: 1.0x (no penalty)
   * At halfLife: ~0.68x
   * At 2*halfLife: ~0.59x
   * Floor at 0.5x (never penalize more than half)
   */
  private applyTimeDecay(results: RetrievalResult[], debug?: boolean): RetrievalResult[] {
    const halfLife = this.config.timeDecayHalfLifeDays;
    if (!halfLife || halfLife <= 0) return results;

    const now = Date.now();
    const decayed = results.map((r) => {
      const ts =
        r.entry.timestamp && r.entry.timestamp > 0 ? r.entry.timestamp : now;
      const ageDays = (now - ts) / 86_400_000;

      // Access reinforcement: frequently recalled memories decay slower
      const { accessCount, lastAccessedAt } = parseAccessMetadata(
        r.entry.metadata,
      );
      const effectiveHL = computeEffectiveHalfLife(
        halfLife,
        accessCount,
        lastAccessedAt,
        this.config.reinforcementFactor,
        this.config.maxHalfLifeMultiplier,
      );

      // floor at 0.5: even very old entries keep at least 50% of their score
      const factor = 0.5 + 0.5 * Math.exp(-ageDays / effectiveHL);
      const out: RetrievalResult = {
        ...r,
        score: clamp01(r.score * factor, r.score * 0.5),
      };
      if (debug && out.scoringTrace) {
        out.scoringTrace.timeDecay = factor;
      }
      return out;
    });

    return decayed.sort((a, b) => b.score - a.score);
  }

  /**
   * Apply lifecycle-aware score adjustment (decay + tier floors).
   *
   * This is intentionally lightweight:
   * - reads tier/access metadata (if any)
   * - multiplies scores by max(tierFloor, decayComposite)
   */
  private applyLifecycleBoost(results: RetrievalResult[]): RetrievalResult[] {
    if (!this.decayEngine) return results;

    const now = Date.now();
    const pairs = results.map(r => {
      const { memory, meta } = getDecayableFromEntry(r.entry);
      return { r, memory, category: meta.memory_category };
    });

    const scored = pairs.map(p => ({ memory: p.memory, score: p.r.score, category: p.category }));
    this.decayEngine.applySearchBoost(scored, now);

    const boosted = pairs.map((p, i) => ({ ...p.r, score: scored[i].score }));
    return boosted.sort((a, b) => b.score - a.score);
  }

  /**
   * Record access stats (access_count, last_accessed_at) and apply tier
   * promotion/demotion for a small number of top results.
   *
   * Note: this writes back to LanceDB via delete+readd; keep it bounded.
   */
  private async recordAccessAndMaybeTransition(results: RetrievalResult[]): Promise<void> {
    if (!this.decayEngine && !this.tierManager) return;

    const now = Date.now();
    const toUpdate = results.slice(0, 3);

    for (const r of toUpdate) {
      const { memory, meta } = getDecayableFromEntry(r.entry);

      // Update access stats in-memory first
      const nextAccess = memory.accessCount + 1;
      meta.access_count = nextAccess;
      meta.last_accessed_at = now;
      if (meta.created_at === undefined && meta.createdAt === undefined) {
        meta.created_at = memory.createdAt;
      }
      if (meta.tier === undefined) {
        meta.tier = memory.tier;
      }
      if (meta.confidence === undefined) {
        meta.confidence = memory.confidence;
      }

      const updatedMemory: DecayableMemory = {
        ...memory,
        accessCount: nextAccess,
        lastAccessedAt: now,
      };

      // Tier transition (optional)
      if (this.decayEngine && this.tierManager) {
        const ds = this.decayEngine.score(updatedMemory, now, meta.memory_category);
        const transition = this.tierManager.evaluate(updatedMemory, ds, now);
        if (transition) {
          meta.tier = transition.toTier;
        }
      }

      try {
        await this.store.update(r.entry.id, {
          metadata: JSON.stringify(meta),
        });
      } catch {
        // best-effort: ignore
      }
    }
  }

  /**
   * True MMR (Maximal Marginal Relevance) diversity selection.
   *
   * Greedily picks results that maximize:
   *   MMR(r) = lambda * relevance(r) - (1 - lambda) * max_sim(r, selected)
   *
   * lambda=1 is pure relevance ranking, lambda=0 is pure diversity.
   * If vectors are missing (e.g. list results), returns candidates as-is.
   */
  private applyMMR(
    candidates: RetrievalResult[],
    limit: number,
    lambda: number,
    debug?: boolean,
  ): RetrievalResult[] {
    if (candidates.length <= 1) return candidates;

    // Check if vectors are available; if not, skip MMR
    const hasVectors = candidates.some(
      (c) => c.entry.vector && c.entry.vector.length > 0,
    );
    if (!hasVectors) return candidates;

    const selected: RetrievalResult[] = [];
    const remaining = [...candidates];

    // First pick: highest relevance score
    remaining.sort((a, b) => b.score - a.score);
    selected.push(remaining.shift()!);

    while (selected.length < limit && remaining.length > 0) {
      let bestIdx = 0;
      let bestMMR = -Infinity;
      let bestMaxSim = 0;

      for (let i = 0; i < remaining.length; i++) {
        const relevance = remaining[i].score;
        const cVec = remaining[i].entry.vector;

        // If this candidate lacks a vector, fall back to relevance only
        if (!cVec?.length) {
          const mmrScore = lambda * relevance;
          if (mmrScore > bestMMR) {
            bestMMR = mmrScore;
            bestIdx = i;
            bestMaxSim = 0;
          }
          continue;
        }

        const cArr = Array.from(cVec as Iterable<number>);

        // Max similarity to any already-selected result
        let maxSim = 0;
        for (const s of selected) {
          const sVec = s.entry.vector;
          if (!sVec?.length) continue;
          const sArr = Array.from(sVec as Iterable<number>);
          const sim = cosineSimilarity(cArr, sArr);
          if (sim > maxSim) maxSim = sim;
        }

        const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
        if (mmrScore > bestMMR) {
          bestMMR = mmrScore;
          bestIdx = i;
          bestMaxSim = maxSim;
        }
      }

      const picked = remaining.splice(bestIdx, 1)[0];
      if (debug && picked.scoringTrace && bestMaxSim > 0) {
        picked.scoringTrace.mmrPenalty = (1 - lambda) * bestMaxSim;
      }
      selected.push(picked);
    }

    return selected;
  }

  // Update configuration
  updateConfig(newConfig: Partial<RetrievalConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  // Get current configuration
  getConfig(): RetrievalConfig {
    return { ...this.config };
  }

  // Test retrieval system
  async test(query = "test query"): Promise<{
    success: boolean;
    mode: string;
    hasFtsSupport: boolean;
    error?: string;
  }> {
    try {
      const results = await this.retrieve({
        query,
        limit: 1,
      });

      return {
        success: true,
        mode: this.config.mode,
        hasFtsSupport: this.store.hasFtsSupport,
      };
    } catch (error) {
      return {
        success: false,
        mode: this.config.mode,
        hasFtsSupport: this.store.hasFtsSupport,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export interface RetrieverLifecycleOptions {
  decayEngine?: DecayEngine;
  tierManager?: TierManager;
}

export function createRetriever(
  store: MemoryStore,
  embedder: Embedder,
  config?: Partial<RetrievalConfig>,
  options?: { decayEngine?: DecayEngine | null },
): MemoryRetriever {
  const fullConfig = { ...DEFAULT_RETRIEVAL_CONFIG, ...config };
  return new MemoryRetriever(store, embedder, fullConfig, options?.decayEngine ?? null);
}
