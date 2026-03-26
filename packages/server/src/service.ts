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
  type MemoryProvenance,
} from "@ultramemory/core";
import { resolveConfig, type UltraMemoryConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Public parameter / result types
// ---------------------------------------------------------------------------

export interface StoreParams {
  text: string;
  category?: string;
  scope?: string;
  importance?: number;
  /** Provenance — tracks where and why this memory was created (Gemini-inspired) */
  provenance?: MemoryProvenance;
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
// Provenance query types (Gemini-inspired)
// ---------------------------------------------------------------------------

export interface ProvenanceResult {
  id: string;
  text: string;
  source: string;
  source_session?: string;
  provenance: MemoryProvenance | null;
  created_at: number;
  tier: string;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Consolidation types (Gemini-inspired)
// ---------------------------------------------------------------------------

export interface ConsolidateParams {
  /** Scope to consolidate (default: "global") */
  scope?: string;
  /** Max memories to scan (default: 100, max: 500) */
  maxEntries?: number;
  /** Cosine similarity threshold for merging (default: 0.85) */
  similarityThreshold?: number;
  /** Whether to generate a digest entry (default: true) */
  generateDigest?: boolean;
}

export interface ConsolidateResult {
  originalCount: number;
  mergedCount: number;
  digestId: string | null;
  scope: string;
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

    // Build metadata with optional provenance
    const metadataPatch: Record<string, unknown> = {
      l0_abstract: text,
      l1_overview: `- ${text}`,
      l2_content: text,
      source: "manual",
      state: "confirmed",
      last_confirmed_use_at: Date.now(),
    };
    if (params.provenance) {
      metadataPatch.provenance = {
        ...params.provenance,
        date: params.provenance.date || new Date().toISOString().slice(0, 10),
      };
    }
    const metadata = stringifySmartMetadata(
      buildSmartMetadata({ text, category, importance }, metadataPatch as any),
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
      const scoringTrace: ScoringTrace = {
        vectorRank: sources.vector?.rank,
        vectorScore: sources.vector?.score,
        bm25Rank: sources.bm25?.rank,
        bm25Score: sources.bm25?.score,
        rrfFused: sources.fused?.score,
        rerankScore: sources.rerank?.score,
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
  // Provenance query (Gemini-inspired)
  // -----------------------------------------------------------------------

  async getProvenance(id: string): Promise<ProvenanceResult | null> {
    this.ensureInitialized();

    const entry = await this._store.getById(id);
    if (!entry) return null;

    const meta = parseSmartMetadata(entry.metadata, entry);
    return {
      id: entry.id,
      text: entry.text.slice(0, 200),
      source: meta.source,
      source_session: meta.source_session,
      provenance: meta.provenance || null,
      created_at: entry.timestamp,
      tier: meta.tier,
      confidence: meta.confidence,
    };
  }

  // -----------------------------------------------------------------------
  // Memory consolidation (Gemini-inspired)
  // -----------------------------------------------------------------------

  async consolidate(params: ConsolidateParams): Promise<ConsolidateResult> {
    this.ensureInitialized();

    const scope = params.scope || "global";
    const maxEntries = clampInt(params.maxEntries ?? 100, 10, 500);
    const similarityThreshold = params.similarityThreshold ?? 0.85;

    // Fetch all memories in scope
    const entries = await this._store.list([scope], undefined, maxEntries, 0);
    if (entries.length === 0) {
      return { mergedCount: 0, digestId: null, scope, originalCount: 0 };
    }

    // Group by category for smarter merging
    const byCategory = new Map<string, typeof entries>();
    for (const e of entries) {
      const meta = parseSmartMetadata(e.metadata, e);
      const cat = meta.memory_category || e.category;
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(e);
    }

    // Find near-duplicates within each category and merge
    let mergedCount = 0;
    const mergedIds: string[] = [];

    for (const [_cat, catEntries] of byCategory) {
      if (catEntries.length < 2) continue;

      // Embed all entries for pairwise comparison
      const vectors = await Promise.all(
        catEntries.map((e) =>
          e.vector?.length ? Promise.resolve(e.vector) : this.embedder.embedPassage(e.text),
        ),
      );

      const merged = new Set<number>();
      for (let i = 0; i < catEntries.length; i++) {
        if (merged.has(i)) continue;
        for (let j = i + 1; j < catEntries.length; j++) {
          if (merged.has(j)) continue;
          const sim = cosineSimilarity(vectors[i], vectors[j]);
          if (sim >= similarityThreshold) {
            // Merge j into i: keep the higher-importance one, archive the other
            const keep = catEntries[i].importance >= catEntries[j].importance ? i : j;
            const drop = keep === i ? j : i;

            // Mark dropped entry as archived with provenance
            const dropMeta = parseSmartMetadata(catEntries[drop].metadata, catEntries[drop]);
            await this._store.patchMetadata(catEntries[drop].id, {
              state: "archived",
              superseded_by: catEntries[keep].id,
              provenance: {
                ...(dropMeta.provenance || {}),
                trigger: `consolidated: merged into ${catEntries[keep].id} (similarity=${sim.toFixed(3)})`,
                date: new Date().toISOString().slice(0, 10),
              },
            }, [scope]).catch(() => {});

            // Add relation on keeper
            await this._store.patchMetadata(catEntries[keep].id, {
              provenance: {
                ...(parseSmartMetadata(catEntries[keep].metadata, catEntries[keep]).provenance || {}),
                derived_from: [
                  ...((parseSmartMetadata(catEntries[keep].metadata, catEntries[keep]).provenance?.derived_from) || []),
                  catEntries[drop].id,
                ],
              },
            }, [scope]).catch(() => {});

            merged.add(drop);
            mergedIds.push(catEntries[drop].id);
            mergedCount++;
          }
        }
      }
    }

    // Generate a digest — compressed user profile from remaining active memories
    const activeEntries = entries.filter((e) => !mergedIds.includes(e.id));
    let digestId: string | null = null;

    if (activeEntries.length > 0 && params.generateDigest !== false) {
      const bullets = activeEntries
        .sort((a, b) => b.importance - a.importance)
        .slice(0, 30)
        .map((e) => {
          const meta = parseSmartMetadata(e.metadata, e);
          return `[${meta.memory_category}] ${e.text.slice(0, 150)}`;
        });

      const digestText = `[DIGEST] User profile consolidated from ${activeEntries.length} memories (${scope}):\n${bullets.join("\n")}`;
      const digestVector = await this.embedder.embedPassage(digestText);

      const digestMetadata = stringifySmartMetadata(
        buildSmartMetadata(
          { text: digestText, category: "other", importance: 0.85 },
          {
            l0_abstract: `[DIGEST] ${scope}: ${activeEntries.length} memories consolidated`,
            l1_overview: bullets.slice(0, 10).map((b) => `- ${b}`).join("\n"),
            l2_content: digestText,
            source: "consolidation",
            state: "confirmed",
            tier: "core",
            memory_category: "profile",
            provenance: {
              trigger: `consolidation: ${entries.length} memories → ${activeEntries.length} active + ${mergedCount} merged`,
              date: new Date().toISOString().slice(0, 10),
              derived_from: activeEntries.slice(0, 20).map((e) => e.id),
            },
          },
        ),
      );

      const digestEntry = await this._store.store({
        text: digestText,
        vector: digestVector,
        category: "other" as MemoryEntry["category"],
        scope,
        importance: 0.85,
        metadata: digestMetadata,
      });

      digestId = digestEntry.id;
    }

    return {
      originalCount: entries.length,
      mergedCount,
      digestId,
      scope,
    };
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

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}
