/**
 * Cascade Forget — Directed forgetting with association propagation.
 *
 * When a user says "forget X", the primary memory gets deleted. But if
 * related memories (meeting notes, decisions, preferences mentioning X)
 * keep their original importance, X still surfaces indirectly through
 * retrieval. Cascade forget finds related entries and demotes them so
 * X doesn't leak back via associations.
 *
 * Rules:
 * - Does NOT delete related entries — only demotes importance
 * - Demotion is proportional to similarity (higher sim = bigger demotion)
 * - Writes metadata breadcrumb for auditability
 * - No LLM calls — pure vector search + arithmetic
 */

import type { MemoryStore, MemoryEntry } from "./store.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CascadeForgetConfig {
  /** Minimum vector similarity to consider "related" (default: 0.70) */
  similarityThreshold: number;
  /** Maximum entries to demote per forget operation (default: 10) */
  maxDemotePerForget: number;
  /** Maximum importance reduction at similarity=1.0 (default: 0.3) */
  maxDemotion: number;
  /** Floor: importance never drops below this (default: 0.05) */
  importanceFloor: number;
}

export const DEFAULT_CASCADE_FORGET_CONFIG: CascadeForgetConfig = {
  similarityThreshold: 0.70,
  maxDemotePerForget: 10,
  maxDemotion: 0.3,
  importanceFloor: 0.05,
};

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface CascadeForgetResult {
  demotedCount: number;
  demotedIds: string[];
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * After deleting/archiving a memory, cascade-demote related entries.
 *
 * @param store  - UltraMemory store instance
 * @param forgottenEntry - The entry that was just deleted/archived (need its vector + scope)
 * @param config - Cascade config overrides
 */
export async function cascadeForget(
  store: MemoryStore,
  forgottenEntry: Pick<MemoryEntry, "id" | "vector" | "scope">,
  config: CascadeForgetConfig = DEFAULT_CASCADE_FORGET_CONFIG,
): Promise<CascadeForgetResult> {
  if (!forgottenEntry.vector?.length) {
    return { demotedCount: 0, demotedIds: [] };
  }

  // Find related entries in the same scope
  const candidates = await store.vectorSearch(
    forgottenEntry.vector,
    config.maxDemotePerForget * 2, // over-fetch, filter down
    config.similarityThreshold,
    [forgottenEntry.scope],
  );

  const demotedIds: string[] = [];

  for (const candidate of candidates) {
    if (demotedIds.length >= config.maxDemotePerForget) break;

    const entry = candidate.entry;

    // Skip the forgotten entry itself (may still be in the index)
    if (entry.id === forgottenEntry.id) continue;

    // Skip already-archived or superseded entries
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(entry.metadata || "{}") as Record<string, unknown>;
    } catch {
      /* skip parse errors */
    }
    if (meta.state === "archived" || meta.state === "superseded") continue;

    // Proportional demotion: higher similarity -> bigger cut
    // At sim=1.0 -> full maxDemotion, at threshold -> near-zero
    const simRange = 1.0 - config.similarityThreshold;
    const simNormalized =
      simRange > 0
        ? (candidate.score - config.similarityThreshold) / simRange
        : 1.0;
    const demotion = config.maxDemotion * simNormalized;

    const newImportance = Math.max(
      entry.importance - demotion,
      config.importanceFloor,
    );

    // Skip if no meaningful change
    if (Math.abs(newImportance - entry.importance) < 0.01) continue;

    // Audit trail
    if (!Array.isArray(meta.cascade_forget)) meta.cascade_forget = [];
    (meta.cascade_forget as unknown[]).push({
      forgottenId: forgottenEntry.id.slice(0, 8),
      from: entry.importance,
      to: newImportance,
      similarity: candidate.score,
      date: new Date().toISOString().slice(0, 10),
    });

    await store.update(
      entry.id,
      {
        importance: newImportance,
        metadata: JSON.stringify(meta),
      },
      [forgottenEntry.scope],
    );

    demotedIds.push(entry.id);
  }

  return { demotedCount: demotedIds.length, demotedIds };
}
