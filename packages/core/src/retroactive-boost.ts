/**
 * Retroactive Boost (STC — Synaptic Tagging & Capture)
 *
 * When a new high-importance memory is stored, older related but
 * low-importance memories become more valuable. This module finds
 * those older entries via vector search and bumps their importance
 * so they surface in future retrievals.
 *
 * Rules:
 * - Only triggers on high-importance writes (>= triggerImportanceMin)
 * - Only boosts entries whose current importance is below boostCandidateMaxImportance
 * - Boost is additive with a ceiling — never exceeds maxBoostedImportance
 * - Writes metadata breadcrumb (stc_boosts) for auditability
 * - No LLM calls — pure vector search + arithmetic
 */

import type { MemoryStore, MemoryEntry } from "./store.js";
import { parseSmartMetadata, stringifySmartMetadata } from "./smart-metadata.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface RetroactiveBoostConfig {
  /** Minimum importance of the NEW memory to trigger a boost sweep (default 0.8) */
  triggerImportanceMin: number;
  /** Only boost entries whose current importance is below this (default 0.6) */
  boostCandidateMaxImportance: number;
  /** Additive importance bump (default 0.15) */
  boostAmount: number;
  /** Ceiling: boosted importance never exceeds this (default 0.75) */
  maxBoostedImportance: number;
  /** Minimum vector similarity to consider "related" (default 0.72) */
  similarityThreshold: number;
  /** Maximum entries to boost per trigger (default 5) */
  maxBoostPerTrigger: number;
  /** Minimum age in days for a candidate (avoid boosting very recent entries) (default 1) */
  minAgeDays: number;
}

export const DEFAULT_RETROACTIVE_BOOST_CONFIG: RetroactiveBoostConfig = {
  triggerImportanceMin: 0.8,
  boostCandidateMaxImportance: 0.6,
  boostAmount: 0.15,
  maxBoostedImportance: 0.75,
  similarityThreshold: 0.72,
  maxBoostPerTrigger: 5,
  minAgeDays: 1,
};

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface BoostResult {
  triggered: boolean;
  reason?: string;
  boostedCount: number;
  boostedIds: string[];
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * After a high-importance memory is stored, search for related older
 * low-importance entries and boost them.
 *
 * Call this right after store.store() for the new entry.
 */
export async function retroactiveBoost(
  store: MemoryStore,
  newEntry: Pick<MemoryEntry, "id" | "text" | "vector" | "importance" | "scope" | "timestamp">,
  config: RetroactiveBoostConfig = DEFAULT_RETROACTIVE_BOOST_CONFIG,
): Promise<BoostResult> {
  // Gate: only trigger for high-importance new memories
  if (newEntry.importance < config.triggerImportanceMin) {
    return { triggered: false, reason: "below_importance_threshold", boostedCount: 0, boostedIds: [] };
  }

  if (!newEntry.vector?.length) {
    return { triggered: false, reason: "no_vector", boostedCount: 0, boostedIds: [] };
  }

  // Find related entries in the same scope
  let candidates;
  try {
    candidates = await store.vectorSearch(
      newEntry.vector,
      config.maxBoostPerTrigger * 3, // fetch more, filter down
      config.similarityThreshold,
      [newEntry.scope],
    );
  } catch {
    return { triggered: true, reason: "vector_search_failed", boostedCount: 0, boostedIds: [] };
  }

  const now = Date.now();
  const minAgeMs = config.minAgeDays * 86_400_000;
  const boostedIds: string[] = [];

  for (const candidate of candidates) {
    if (boostedIds.length >= config.maxBoostPerTrigger) break;

    const entry = candidate.entry;

    // Skip self
    if (entry.id === newEntry.id) continue;

    // Skip entries that are already high importance
    if (entry.importance >= config.boostCandidateMaxImportance) continue;

    // Skip very recent entries (they'll get their own natural scoring)
    const ageMs = now - entry.timestamp;
    if (ageMs < minAgeMs) continue;

    // Compute boost: additive, capped
    const newImportance = Math.min(
      entry.importance + config.boostAmount,
      config.maxBoostedImportance,
    );

    // Skip if no actual change
    if (newImportance <= entry.importance) continue;

    // Update metadata with audit trail
    let meta: Record<string, any> = {};
    try { meta = JSON.parse(entry.metadata || "{}"); } catch { /* skip */ }

    if (!Array.isArray(meta.stc_boosts)) meta.stc_boosts = [];
    meta.stc_boosts.push({
      triggeredBy: newEntry.id.slice(0, 8),
      from: entry.importance,
      to: newImportance,
      similarity: candidate.score,
      date: new Date().toISOString().slice(0, 10),
    });

    // Promote tier if appropriate
    if (meta.tier === "peripheral" && newImportance >= 0.5) {
      meta.tier = "working";
    }

    // Use delete + importEntry to work around LanceDB's add-then-delete
    // update pattern which removes both old and new rows when the ID is
    // unchanged (same deterministic ID for same scope+text).
    // Convert Arrow Vector to plain array for importEntry validation.
    const plainVector = Array.isArray(entry.vector)
      ? entry.vector
      : Array.from(entry.vector as Iterable<number>);
    try {
      await store.delete(entry.id, [newEntry.scope]);
      await store.importEntry({
        ...entry,
        vector: plainVector,
        importance: newImportance,
        metadata: JSON.stringify(meta),
      });
    } catch (err) {
      // Best-effort — don't fail the whole boost if one update fails
      if (process.env.ULTRAMEMORY_DEBUG) {
        console.warn("[retroactive-boost] update failed:", err);
      }
      continue;
    }

    boostedIds.push(entry.id);
  }

  return {
    triggered: true,
    boostedCount: boostedIds.length,
    boostedIds,
  };
}
