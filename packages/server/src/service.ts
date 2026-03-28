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
import { FeedbackLearner, IngestionPipeline, reverseMapLegacyCategory } from "@ultramemory/core";
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
  action: "created" | "duplicate" | "noise_filtered" | "conflict_detected";
  scope: string;
  category: string;
  importance: number;
  existingId?: string;
  conflictWith?: string;
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
  private pipeline!: IngestionPipeline;
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

    this.pipeline = new IngestionPipeline({
      store: this._store,
      embedder: this.embedder,
    });

    // Run migrations
    const migrator = createMigrator(this._store);
    await migrator.migrate().catch(() => {
      // Migration is best-effort — may fail on first run with empty DB
    });

    // Category model unification: ensure all entries have memory_category.
    // Sample first to skip when already migrated; paginate to handle large corpora.
    try {
      const { batchMigrateCategories } = await import("@ultramemory/core");
      const sample = await this._store.list(undefined, undefined, 50, 0);
      const needsMigration = sample.some((e) => {
        try {
          const parsed = JSON.parse(e.metadata || "{}");
          return !parsed.memory_category;
        } catch { return false; }
      });

      if (needsMigration) {
        let offset = 0;
        const batchSize = 500;
        let totalMigrated = 0;
        while (true) {
          const batch = await this._store.list(undefined, undefined, batchSize, offset);
          if (batch.length === 0) break;
          const updates = batchMigrateCategories(batch as any);
          for (const { id, updatedMetadata } of updates) {
            await this._store.update(id, { metadata: updatedMetadata }).catch(() => {});
          }
          totalMigrated += updates.length;
          offset += batchSize;
          if (batch.length < batchSize) break;
        }
        if (totalMigrated > 0) {
          process.stderr.write(`[MemoryService] migrated ${totalMigrated} entries to unified categories\n`);
        }
      }
    } catch {
      // Category migration is best-effort
    }

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
    this.pipeline = null!;
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

    const category = (params.category || "other") as string;
    const scope = params.scope || this.scopeManager.getDefaultScope?.("main") || "global";
    const importance = clamp01(params.importance ?? 0.7);

    // Map legacy store category to MemoryCategory for pipeline
    const memoryCategory = reverseMapLegacyCategory(category as any, params.text);

    const result = await this.pipeline.ingest({
      text: params.text,
      category: memoryCategory,
      importance,
      scope,
      source: "manual",
      conflictStrategy: "coexist",
    });

    // Map pipeline result back to StoreResult
    // "superseded" means a new record was created that supersedes an old one — surface as "created".
    // "conflict_detected" means coexist/ask strategy found a conflict but did NOT store — pass through.
    const action = result.action === "superseded" ? "created" as const
      : result.action as StoreResult["action"];

    return {
      id: result.id,
      action,
      scope,
      category,
      importance,
      existingId: result.action === "duplicate" ? result.id : undefined,
      conflictWith: result.conflictWith,
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
        const { memory, meta } = getDecayableFromEntry(r.entry);
        const decayScore = this.decayEngine.score(memory, undefined, meta.memory_category);
        const transition = this.tierManager.evaluate(memory, decayScore);
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

  // NOTE: update() intentionally bypasses IngestionPipeline. The pipeline handles
  // new memory creation (with dedup, conflict detection, and relation linking).
  // update() patches existing records in-place (text, importance, category).
  // For temporal fact updates (e.g., "user now prefers Python"), callers should
  // use store() which routes through the pipeline with conflict detection.
  async update(params: UpdateParams): Promise<UpdateResult> {
    this.ensureInitialized();

    const updates: Record<string, unknown> = {};
    const fieldsUpdated: string[] = [];

    if (params.text !== undefined) {
      updates.text = params.text;
      const newVector = await this.embedder.embedPassage(params.text);
      updates.vector = newVector;

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
      const l0 = params.text.slice(0, 200);
      const l1 = `- ${params.text.slice(0, 1000)}`;
      const l2 = params.text;
      const updatedMeta = {
        ...existingMeta,
        l0_abstract: l0,
        l1_overview: l1,
        l2_content: l2,
      };
      updates.metadata = stringifySmartMetadata(
        buildSmartMetadata(
          { text: params.text, category: undefined, importance: undefined },
          updatedMeta as any,
        ),
      );

      // Re-embed L0/L1/L2 vectors to keep multi-channel search in sync
      const [vectorL0, vectorL1, vectorL2] = await this.embedMultiLayer(
        params.text, newVector, l0, l1, l2,
      );
      updates.vector_l0 = vectorL0;
      updates.vector_l1 = vectorL1;
      updates.vector_l2 = vectorL2;

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

  async health(scopeFilter?: string[]): Promise<import("@ultramemory/core").CorpusHealth> {
    this.ensureInitialized();
    const entries = await this._store.list(scopeFilter, undefined, 10000, 0);
    const { computeCorpusHealth } = await import("@ultramemory/core");
    return computeCorpusHealth(entries as any);
  }

  async conflicts(scopeFilter?: string[]): Promise<Array<{ id: string; text: string; conflictWith: string[] }>> {
    this.ensureInitialized();
    const entries = await this._store.list(scopeFilter, undefined, 10000, 0);
    const conflicts: Array<{ id: string; text: string; conflictWith: string[] }> = [];

    for (const entry of entries) {
      const meta = parseSmartMetadata(entry.metadata, entry);
      const conflictIds: string[] = [];
      // Check relations for contradicts and supersedes
      if (meta.relations) {
        for (const rel of meta.relations as any[]) {
          if (rel.type === "contradicts" || rel.type === "supersedes") {
            conflictIds.push(rel.targetId);
          }
        }
      }
      // Check supersedes/superseded_by fields
      if (meta.supersedes) conflictIds.push(meta.supersedes);
      if (meta.superseded_by) conflictIds.push(meta.superseded_by);
      // Dedup
      const unique = [...new Set(conflictIds)];
      if (unique.length > 0) {
        conflicts.push({ id: entry.id, text: entry.text.slice(0, 200), conflictWith: unique });
      }
    }

    return conflicts;
  }

  async feedback(params: { id: string; helpful: boolean }): Promise<{ ok: boolean; id: string }> {
    this.ensureInitialized();
    if (!this.feedbackLearner) {
      return { ok: false, id: params.id };
    }
    await this.feedbackLearner.recordExplicit(params.id, params.helpful);
    return { ok: true, id: params.id };
  }

  /**
   * Backfill multi-vector columns (vector_l0/l1/l2) for all memories that
   * still have zero vectors in those columns. Reads L0/L1/L2 texts from
   * smart metadata and embeds each layer, reusing the main vector when the
   * layer text is identical to the stored text.
   *
   * @param log  Progress logger (defaults to console.error)
   * @returns    Number of memories updated
   */
  async backfillVectors(
    log: (msg: string) => void = console.error,
  ): Promise<number> {
    this.ensureInitialized();

    // list() returns entries without vectors for performance; we use it only
    // for IDs/text/metadata, then fetch the full entry (with vector) via getById.
    const entries = await this._store.list(undefined, undefined, 10000, 0);
    const total = entries.length;
    log(`backfill-vectors: scanning ${total} memories...`);

    let done = 0;
    let errors = 0;

    for (const entry of entries) {
      try {
        // Fetch the full entry including the stored main vector
        const full = await this._store.getById(entry.id);
        if (!full) continue;

        // If the main vector is already populated, we can use the reuse
        // optimisation in embedMultiLayer; otherwise embed the text fresh.
        const mainVector = full.vector.length > 0
          ? full.vector
          : await this.embedder.embedPassage(full.text);

        const meta = parseSmartMetadata(full.metadata, full);
        const l0 = meta.l0_abstract || full.text.slice(0, 200);
        const l1 = meta.l1_overview || `- ${full.text.slice(0, 1000)}`;
        const l2 = meta.l2_content || full.text;

        const [vector_l0, vector_l1, vector_l2] = await this.embedMultiLayer(
          full.text,
          mainVector,
          l0,
          l1,
          l2,
        );

        await this._store.update(full.id, { vector_l0, vector_l1, vector_l2 });
        done++;
        if (done % 50 === 0) {
          log(`backfill-vectors: backfilled ${done}/${total} memories`);
        }
      } catch (err) {
        errors++;
        log(`backfill-vectors: ERROR on ${entry.id} — ${String(err)}`);
      }
    }

    log(`backfill-vectors: complete — ${done} updated, ${errors} errors`);
    return done;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  /**
   * Embed L0/L1/L2 layer texts, reusing the main text vector when a layer
   * text is identical to the original text (avoids redundant API calls).
   */
  private async embedMultiLayer(
    text: string,
    textVector: number[],
    l0: string,
    l1: string,
    l2: string,
  ): Promise<[number[], number[], number[]]> {
    const needsEmbed: string[] = [];
    const mapping: Array<number | "reuse"> = [];

    for (const layerText of [l0, l1, l2]) {
      if (layerText === text) {
        mapping.push("reuse");
      } else {
        mapping.push(needsEmbed.length);
        needsEmbed.push(layerText);
      }
    }

    const embedded = needsEmbed.length > 0
      ? await this.embedder.embedBatchPassage(needsEmbed)
      : [];

    return mapping.map((m) =>
      m === "reuse" ? textVector : embedded[m as number],
    ) as [number[], number[], number[]];
  }

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
