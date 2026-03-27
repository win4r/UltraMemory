/**
 * MemoryService — the unified service layer for UltraMemory.
 *
 * Wraps @ultramemory/core modules into a single class that MCP, REST, and
 * OpenClaw adapters all delegate to.
 */

import {
  MemoryStore,
  validateStoragePath,
  type MemoryEntry,
  type MemorySearchResult,
  createEmbedder,
  getVectorDimensions,
  type Embedder,
  createRetriever,
  DEFAULT_RETRIEVAL_CONFIG,
  type MemoryRetriever,
  createScopeManager,
  resolveScopeFilter,
  type MemoryScopeManager,
  createMigrator,
  createDecayEngine,
  DEFAULT_DECAY_CONFIG,
  type DecayEngine,
  createTierManager,
  DEFAULT_TIER_CONFIG,
  type TierManager,
  buildSmartMetadata,
  parseSmartMetadata,
  stringifySmartMetadata,
  toLifecycleMemory,
  isNoise,
  getDecayableFromEntry,
} from "@ultramemory/core";
import { FeedbackLearner } from "../../core/src/feedback-learner.ts";
import { resolveConfig, type UltraMemoryConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Public parameter / result types
// ---------------------------------------------------------------------------

export interface StoreParams {
  text: string;
  category?: string;
  scope?: string;
  importance?: number;
}

export interface StoreResult {
  id: string;
  action: "created" | "duplicate" | "noise_filtered";
  scope: string;
  category: string;
  importance: number;
  existingId?: string;
}

export interface RecallParams {
  query: string;
  limit?: number;
  scopeFilter?: string[];
  category?: string;
  /** Content depth: l0 (one-sentence), l1 (bullet list), l2 (full text), full (alias for l2). Default: "full" */
  depth?: "l0" | "l1" | "l2" | "full";
  /** Recall source: "manual" (user-triggered) or "auto" (system auto-recall). Only manual recalls reinforce access count. Default: "manual" */
  source?: "manual" | "auto";
  /** Enable debug scoring trace. When true, each result includes a full scoringTrace breakdown. Default: false. */
  debug?: boolean;
}

export interface ScoringTrace {
  vectorRank?: number;
  vectorScore?: number;
  bm25Rank?: number;
  bm25Score?: number;
  rrfFused?: number;
  rerankScore?: number;
  recencyBoost?: number;
  lengthNorm?: number;
  timeDecay?: number;
  finalScore: number;
  queryType?: string;
}

export interface RecallResult {
  id: string;
  text: string;
  category: string;
  scope: string;
  importance: number;
  score: number;
  timestamp: number;
  /** Scoring breakdown for explainability (when available) */
  scoringTrace?: ScoringTrace;
}

export interface UpdateParams {
  id: string;
  text?: string;
  importance?: number;
  category?: string;
}

export interface UpdateResult {
  ok: boolean;
  id: string;
  fieldsUpdated: string[];
}

export interface ForgetParams {
  id: string;
}

export interface ForgetResult {
  ok: boolean;
}

export interface ListParams {
  scopeFilter?: string[];
  category?: string;
  limit?: number;
  offset?: number;
}

export interface ListEntry {
  id: string;
  text: string;
  category: string;
  scope: string;
  importance: number;
  timestamp: number;
  metadata?: string;
}

export interface StatsResult {
  totalCount: number;
  scopeCounts: Record<string, number>;
  categoryCounts: Record<string, number>;
}

// ---------------------------------------------------------------------------
// MemoryService
// ---------------------------------------------------------------------------

export class MemoryService {
  private config: UltraMemoryConfig;
  private _store!: MemoryStore;
  private retriever!: MemoryRetriever;
  private embedder!: Embedder;
  private scopeManager!: MemoryScopeManager;
  private decayEngine!: DecayEngine;
  private tierManager!: TierManager;
  private feedbackLearner?: FeedbackLearner;
  private initialized = false;

  constructor(config: Partial<UltraMemoryConfig> & { embedding: UltraMemoryConfig["embedding"] }) {
    this.config = resolveConfig(config);
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      validateStoragePath(this.config.dbPath);
    } catch {
      // Non-fatal — writes may still succeed
    }

    const vectorDim = getVectorDimensions(
      this.config.embedding.model || "text-embedding-3-small",
      this.config.embedding.dimensions,
    );

    this._store = new MemoryStore({ dbPath: this.config.dbPath, vectorDim });

    this.embedder = createEmbedder({
      provider: "openai-compatible",
      apiKey: this.config.embedding.apiKey,
      model: this.config.embedding.model || "text-embedding-3-small",
      baseURL: this.config.embedding.baseURL,
      dimensions: this.config.embedding.dimensions,
      omitDimensions: this.config.embedding.omitDimensions,
      taskQuery: this.config.embedding.taskQuery,
      taskPassage: this.config.embedding.taskPassage,
      normalized: this.config.embedding.normalized,
      chunking: this.config.embedding.chunking,
    });

    this.decayEngine = createDecayEngine({
      ...DEFAULT_DECAY_CONFIG,
      ...(this.config.decay?.enabled === false ? {} : this.config.decay || {}),
    });

    this.tierManager = createTierManager({
      ...DEFAULT_TIER_CONFIG,
      ...(this.config.tier || {}),
    });

    this.feedbackLearner = new FeedbackLearner(this._store, this.config.decay?.feedbackAlpha ?? 0.15);

    this.retriever = createRetriever(
      this._store,
      this.embedder,
      { ...DEFAULT_RETRIEVAL_CONFIG, ...this.config.retrieval },
      { decayEngine: this.config.decay?.enabled === false ? null : this.decayEngine },
    );

    this.scopeManager = createScopeManager(this.config.scopes);

    // Run migrations
    const migrator = createMigrator(this._store);
    await migrator.migrate().catch(() => {
      // Migration is best-effort — may fail on first run with empty DB
    });

    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    if (!this.initialized) return;

    this._store?.close();
    this.embedder?.clearCache();

    this._store = null!;
    this.retriever = null!;
    this.embedder = null!;
    this.scopeManager = null!;
    this.decayEngine = null!;
    this.tierManager = null!;
    this.feedbackLearner = undefined;
    this.initialized = false;

    process.stderr.write("[MemoryService] shutdown complete\n");
  }

  isReady(): boolean {
    return this.initialized;
  }

  // -----------------------------------------------------------------------
  // Core operations
  // -----------------------------------------------------------------------

  async store(params: StoreParams): Promise<StoreResult> {
    this.ensureInitialized();

    const text = params.text;
    const category = (params.category || "other") as MemoryEntry["category"];
    const scope = params.scope || this.scopeManager.getDefaultScope?.("main") || "global";
    const importance = clamp01(params.importance ?? 0.7);

    // Noise check
    if (isNoise(text)) {
      return { id: "", action: "noise_filtered", scope, category, importance };
    }

    // Embed
    const vector = await this.embedder.embedPassage(text);

    // Duplicate check (fail-open — errors don't block storage)
    try {
      const existing = await this._store.vectorSearch(vector, 1, 0.1, [scope], { excludeInactive: true });
      if (existing.length > 0 && existing[0].score > 0.98) {
        return {
          id: existing[0].entry.id,
          action: "duplicate",
          scope,
          category,
          importance,
          existingId: existing[0].entry.id,
        };
      }
    } catch {
      // fail-open
    }

    // Build metadata
    const metadata = stringifySmartMetadata(
      buildSmartMetadata(
        { text, category, importance },
        {
          l0_abstract: text,
          l1_overview: `- ${text}`,
          l2_content: text,
          source: "manual",
          state: "confirmed",
          last_confirmed_use_at: Date.now(),
        },
      ),
    );

    const entry = await this._store.store({
      text,
      vector,
      category,
      scope,
      importance,
      metadata,
    });

    return {
      id: entry.id,
      action: "created",
      scope,
      category,
      importance,
    };
  }

  async recall(params: RecallParams): Promise<RecallResult[]> {
    this.ensureInitialized();

    const limit = clampInt(params.limit ?? 5, 1, 20);
    const scopeFilter = params.scopeFilter;
    const category = params.category;

    const results = await this.retriever.retrieve({
      query: params.query,
      limit,
      scopeFilter,
      category,
      debug: params.debug,
    });

    // Update access metadata only for manual recalls (not auto-recall)
    if (params.source !== "auto") {
      const now = Date.now();
      for (const r of results) {
        const meta = parseSmartMetadata(r.entry.metadata, r.entry);
        this._store.patchMetadata(
          r.entry.id,
          { access_count: (meta.access_count ?? 0) + 1, last_accessed_at: now },
          scopeFilter,
        ).catch(() => {});
      }
    }

    // Lifecycle evaluation (all sources, not just auto)
    if (this.decayEngine && this.tierManager) {
      for (const r of results) {
        const decayable = getDecayableFromEntry(r.entry);
        const decayScore = this.decayEngine.score(decayable.memory);
        const transition = this.tierManager.evaluate(decayable.memory, decayScore);
        if (transition) {
          this._store.patchMetadata(r.entry.id, { tier: transition.toTier }).catch(() => {});
        }
      }
    }

    // Positive feedback for manual recalls
    if (params.source !== "auto" && this.feedbackLearner) {
      for (const r of results) {
        this.feedbackLearner.recordPositive(r.entry.id).catch(() => {});
      }
    }

    const depth = params.depth || "full";

    return results.map((r) => {
      // L0/L1/L2 dynamic depth loading — return appropriate content tier
      const meta = parseSmartMetadata(r.entry.metadata, r.entry);
      let text: string;
      switch (depth) {
        case "l0":
          text = meta.l0_abstract || r.entry.text.slice(0, 200);
          break;
        case "l1":
          text = meta.l1_overview || r.entry.text.slice(0, 1000);
          break;
        case "l2":
        case "full":
        default:
          text = meta.l2_content || r.entry.text;
          break;
      }

      // Build scoring trace from retrieval result metadata (if available)
      const sources = (r as any).sources || {};
      // Use the richer per-stage trace when debug=true, otherwise build a
      // lightweight trace from the sources metadata (always available).
      const scoringTrace: ScoringTrace = (params.debug && (r as any).scoringTrace)
        ? (r as any).scoringTrace
        : {
            vectorRank: sources.vector?.rank,
            vectorScore: sources.vector?.score,
            bm25Rank: sources.bm25?.rank,
            bm25Score: sources.bm25?.score,
            rrfFused: sources.fused?.score,
            rerankScore: sources.reranked?.score,
            finalScore: r.score,
            queryType: (r as any).queryType,
          };

      return {
        id: r.entry.id,
        text,
        category: r.entry.category,
        scope: r.entry.scope,
        importance: r.entry.importance,
        score: r.score,
        timestamp: r.entry.timestamp,
        scoringTrace,
      };
    });
  }

  async update(params: UpdateParams): Promise<UpdateResult> {
    this.ensureInitialized();

    const updates: Record<string, unknown> = {};
    const fieldsUpdated: string[] = [];

    if (params.text !== undefined) {
      updates.text = params.text;
      updates.vector = await this.embedder.embedPassage(params.text);

      // Regenerate L0/L1/L2 metadata to match new text so recall with
      // depth=l0/l1/l2 returns up-to-date summaries.
      let existingMeta: Record<string, unknown> = {};
      try {
        const existing = await this._store.getById(params.id);
        if (existing?.metadata) {
          existingMeta = parseSmartMetadata(existing.metadata, existing) as unknown as Record<string, unknown>;
        }
      } catch {
        // fail-open: rebuild metadata from scratch if lookup fails
      }
      const updatedMeta = {
        ...existingMeta,
        l0_abstract: params.text.slice(0, 200),
        l1_overview: `- ${params.text.slice(0, 1000)}`,
        l2_content: params.text,
      };
      updates.metadata = stringifySmartMetadata(
        buildSmartMetadata(
          { text: params.text, category: undefined, importance: undefined },
          updatedMeta as any,
        ),
      );

      fieldsUpdated.push("text");
    }
    if (params.importance !== undefined) {
      updates.importance = clamp01(params.importance);
      fieldsUpdated.push("importance");
    }
    if (params.category !== undefined) {
      updates.category = params.category;
      fieldsUpdated.push("category");
    }

    if (fieldsUpdated.length === 0) {
      return { ok: false, id: params.id, fieldsUpdated: [] };
    }

    const result = await this._store.update(params.id, updates);
    return { ok: result !== null, id: params.id, fieldsUpdated };
  }

  async forget(params: ForgetParams): Promise<ForgetResult> {
    this.ensureInitialized();

    // Negative feedback propagation to related memories
    if (this.feedbackLearner) {
      const entry = await this._store.getById(params.id);
      if (entry) {
        const meta = parseSmartMetadata(entry.metadata, entry);
        for (const rel of meta.relations ?? []) {
          this.feedbackLearner.recordNegative(rel.targetId).catch(() => {});
        }
        this.feedbackLearner.setDirect(params.id, 0.1).catch(() => {});
      }
    }

    const ok = await this._store.delete(params.id);
    return { ok };
  }

  async list(params: ListParams = {}): Promise<ListEntry[]> {
    this.ensureInitialized();

    const limit = clampInt(params.limit ?? 20, 1, 100);
    const offset = clampInt(params.offset ?? 0, 0, 10000);

    const entries = await this._store.list(
      params.scopeFilter,
      params.category,
      limit,
      offset,
    );

    return entries.map((e) => ({
      id: e.id,
      text: e.text,
      category: e.category,
      scope: e.scope,
      importance: e.importance,
      timestamp: e.timestamp,
      metadata: e.metadata,
    }));
  }

  async stats(scopeFilter?: string[]): Promise<StatsResult> {
    this.ensureInitialized();
    return this._store.stats(scopeFilter);
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("MemoryService not initialized. Call initialize() first.");
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.7;
  return Math.min(1, Math.max(0, value));
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
