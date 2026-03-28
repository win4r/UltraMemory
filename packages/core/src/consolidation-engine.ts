/**
 * Semantic Consolidation Engine (P1-1)
 *
 * Clusters, merges, and detects conflicts among memory entries within a scope.
 * Uses vector similarity from the store to find near-duplicate and related
 * memories, then:
 *   - Archives near-duplicates (similarity > mergeThreshold) into a canonical
 *   - Links related entries (clusterThreshold < similarity < mergeThreshold)
 *   - Runs heuristic contradiction & fact-key conflict detection on clusters
 *
 * LLM-based abstraction is intentionally deferred — this engine handles the
 * deterministic clustering and merge logic only.
 */

import { detectFactKeyConflict, detectHeuristicContradiction } from "./conflict-detector.js";

// ---------------------------------------------------------------------------
// Config & result types
// ---------------------------------------------------------------------------

export interface ConsolidationConfig {
  /** Minimum cosine similarity to form a cluster (default 0.82) */
  clusterThreshold: number;
  /** Minimum cosine similarity to merge (archive the weaker entry) (default 0.92) */
  mergeThreshold: number;
  /** Minimum cluster size before abstraction would kick in (future) (default 5) */
  abstractionMinClusterSize: number;
  /** Maximum entries to scan per consolidation run (default 500) */
  maxEntriesPerRun: number;
}

export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = {
  clusterThreshold: 0.82,
  mergeThreshold: 0.92,
  abstractionMinClusterSize: 5,
  maxEntriesPerRun: 500,
};

export interface ConflictEvent {
  memoryA: string;
  memoryB: string;
  type: "heuristic_contradiction" | "fact_key_conflict";
}

export interface ConsolidationResult {
  originalCount: number;
  clustersFound: number;
  mergedCount: number;
  relationsAdded: number;
  conflictsDetected: ConflictEvent[];
  scope: string;
}

// ---------------------------------------------------------------------------
// Duck-typed store interface (avoids hard dependency on MemoryStore class)
// ---------------------------------------------------------------------------

interface MemoryEntryLike {
  id: string;
  text: string;
  vector: number[];
  category: string;
  scope: string;
  importance: number;
  timestamp: number;
  metadata?: string;
}

interface SearchResultLike {
  entry: MemoryEntryLike;
  score: number;
}

interface StoreLike {
  list(
    scopeFilter?: string[],
    category?: string,
    limit?: number,
    offset?: number,
  ): Promise<MemoryEntryLike[]>;

  getById(id: string, scopeFilter?: string[]): Promise<MemoryEntryLike | null>;

  vectorSearch(
    vector: number[],
    limit?: number,
    minScore?: number,
    scopeFilter?: string[],
    options?: { excludeInactive?: boolean; column?: string },
  ): Promise<SearchResultLike[]>;

  patchMetadata(
    id: string,
    patch: Record<string, unknown>,
    scopeFilter?: string[],
  ): Promise<MemoryEntryLike | null>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the effective memory_category from an entry, falling back to
 * the top-level `category` field.
 */
function entryCategory(entry: MemoryEntryLike): string {
  if (entry.metadata) {
    try {
      const meta = JSON.parse(entry.metadata);
      if (meta.memory_category) return meta.memory_category;
    } catch { /* use fallback */ }
  }
  return entry.category;
}

/**
 * Extract a fact_key from metadata (if present).
 */
function entryFactKey(entry: MemoryEntryLike): string | undefined {
  if (entry.metadata) {
    try {
      const meta = JSON.parse(entry.metadata);
      return meta.fact_key ?? undefined;
    } catch { /* ignore */ }
  }
  return undefined;
}

/**
 * Check whether an entry is active (not archived/superseded).
 */
function isActive(entry: MemoryEntryLike): boolean {
  if (entry.metadata) {
    try {
      const meta = JSON.parse(entry.metadata);
      if (meta.state === "archived" || meta.state === "superseded") return false;
    } catch { /* treat as active */ }
  }
  return true;
}

/**
 * Canonical ranking score: importance * (1 + log(access_count + 1)).
 * Entries with more accesses and higher importance become the canonical.
 */
function canonicalScore(entry: MemoryEntryLike): number {
  let accessCount = 0;
  if (entry.metadata) {
    try {
      const meta = JSON.parse(entry.metadata);
      accessCount = typeof meta.access_count === "number" ? meta.access_count : 0;
    } catch { /* 0 */ }
  }
  return entry.importance * (1 + Math.log(accessCount + 1));
}

// ---------------------------------------------------------------------------
// ConsolidationEngine
// ---------------------------------------------------------------------------

export class ConsolidationEngine {
  constructor(
    private store: StoreLike,
    private config: ConsolidationConfig = DEFAULT_CONSOLIDATION_CONFIG,
  ) {}

  /**
   * Run consolidation over all active memories in the given scope.
   *
   * Algorithm:
   * 1. List entries in scope (up to maxEntriesPerRun)
   * 2. Filter active entries, group by memory_category
   * 3. For each category group, cluster entries by vector similarity
   * 4. Within each cluster: merge high-similarity pairs, link moderate ones,
   *    and detect contradictions / fact-key conflicts
   */
  async run(scope: string): Promise<ConsolidationResult> {
    const { clusterThreshold, mergeThreshold, maxEntriesPerRun } = this.config;

    // 1. Fetch entries
    const entries = await this.store.list(
      [scope],
      undefined,
      maxEntriesPerRun,
      0,
    );

    // 2. Filter active only
    const active = entries.filter(isActive);
    const originalCount = active.length;

    if (originalCount === 0) {
      return {
        originalCount: 0,
        clustersFound: 0,
        mergedCount: 0,
        relationsAdded: 0,
        conflictsDetected: [],
        scope,
      };
    }

    // 3. Group by category
    const byCategory = new Map<string, MemoryEntryLike[]>();
    for (const e of active) {
      const cat = entryCategory(e);
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(e);
    }

    // Accumulators
    let clustersFound = 0;
    let mergedCount = 0;
    let relationsAdded = 0;
    const conflictsDetected: ConflictEvent[] = [];

    // 4. Cluster within each category
    for (const [_cat, catEntries] of byCategory) {
      if (catEntries.length < 2) continue;

      const clustered = new Set<string>();
      // Map canonical entry ID -> list of member IDs (including canonical itself)
      const clusters = new Map<string, string[]>();

      for (const entry of catEntries) {
        if (clustered.has(entry.id)) continue;

        // Retrieve the full entry with vector
        const full = await this.store.getById(entry.id);
        if (!full || !full.vector || full.vector.length === 0) continue;

        // Find similar entries via vector search
        const similar = await this.store.vectorSearch(
          full.vector,
          10,
          clusterThreshold,
          [scope],
          { excludeInactive: true },
        );

        // Filter: skip self, skip already-clustered, must be same category
        const clusterMembers = similar.filter(
          (s) =>
            s.entry.id !== entry.id &&
            !clustered.has(s.entry.id) &&
            entryCategory(s.entry) === entryCategory(entry),
        );

        if (clusterMembers.length === 0) continue;

        // Build cluster: entry is the seed
        const memberIds = [entry.id, ...clusterMembers.map((s) => s.entry.id)];
        clusters.set(entry.id, memberIds);

        clustered.add(entry.id);
        for (const m of clusterMembers) clustered.add(m.entry.id);
      }

      clustersFound += clusters.size;

      // 5. Process each cluster
      for (const [seedId, memberIds] of clusters) {
        // Resolve full entries for all members
        const memberEntries: MemoryEntryLike[] = [];
        for (const id of memberIds) {
          const full = await this.store.getById(id);
          if (full) memberEntries.push(full);
        }

        if (memberEntries.length < 2) continue;

        // Determine canonical: highest canonicalScore
        const sorted = [...memberEntries].sort(
          (a, b) => canonicalScore(b) - canonicalScore(a),
        );
        const canonical = sorted[0];

        // Re-query similarity for each non-canonical member against canonical
        const canonicalVector = canonical.vector;
        if (!canonicalVector || canonicalVector.length === 0) continue;

        const pairResults = await this.store.vectorSearch(
          canonicalVector,
          memberEntries.length + 5,
          clusterThreshold,
          [scope],
          { excludeInactive: true },
        );
        const scoreMap = new Map<string, number>();
        for (const r of pairResults) {
          scoreMap.set(r.entry.id, r.score);
        }

        for (const member of sorted.slice(1)) {
          const sim = scoreMap.get(member.id) ?? clusterThreshold;

          if (sim >= mergeThreshold) {
            // Merge: archive the weaker member
            await this.store
              .patchMetadata(
                member.id,
                {
                  state: "archived",
                  superseded_by: canonical.id,
                  canonical_id: canonical.id,
                  provenance: {
                    trigger: `consolidated: merged into ${canonical.id} (similarity=${sim.toFixed(3)})`,
                    date: new Date().toISOString().slice(0, 10),
                  },
                },
                [scope],
              )
              .catch(() => {});
            mergedCount++;
          } else {
            // Link: add clustered_with relation
            await this.store
              .patchMetadata(
                member.id,
                { clustered_with: canonical.id },
                [scope],
              )
              .catch(() => {});
            await this.store
              .patchMetadata(
                canonical.id,
                { clustered_with: member.id },
                [scope],
              )
              .catch(() => {});
            relationsAdded++;
          }
        }

        // Conflict detection within the cluster
        for (let i = 0; i < memberEntries.length; i++) {
          for (let j = i + 1; j < memberEntries.length; j++) {
            const a = memberEntries[i];
            const b = memberEntries[j];

            // Heuristic contradiction
            if (detectHeuristicContradiction(a.text, b.text)) {
              conflictsDetected.push({
                memoryA: a.id,
                memoryB: b.id,
                type: "heuristic_contradiction",
              });
            }

            // Fact-key conflict
            const fkA = entryFactKey(a);
            const fkB = entryFactKey(b);
            if (fkA && fkB && fkA === fkB) {
              const result = detectFactKeyConflict(
                { factKey: fkA, text: a.text },
                [{ id: b.id, factKey: fkB, text: b.text }],
              );
              if (result.hasConflict) {
                conflictsDetected.push({
                  memoryA: a.id,
                  memoryB: b.id,
                  type: "fact_key_conflict",
                });
              }
            }
          }
        }
      }
    }

    return {
      originalCount,
      clustersFound,
      mergedCount,
      relationsAdded,
      conflictsDetected,
      scope,
    };
  }
}
