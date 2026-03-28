/**
 * Corpus Health Metrics — evaluates the overall quality and hygiene of a
 * memory corpus by analyzing distribution, staleness, conflicts, and
 * duplicate rates across all stored entries.
 */

import { parseSmartMetadata, type SmartMemoryMetadata } from "../smart-metadata.js";

// ============================================================================
// Types
// ============================================================================

interface EntryLike {
  id?: string;
  text?: string;
  category?: string;
  importance?: number;
  timestamp?: number;
  metadata?: string;
}

export interface CorpusHealth {
  /** Number of entries whose state is NOT "archived" */
  totalActive: number;
  /** Number of entries whose state is "archived" */
  totalArchived: number;

  /** Count per memory_category across ALL entries */
  categoryDistribution: Record<string, number>;
  /** Count per source across ALL entries */
  sourceDistribution: Record<string, number>;
  /** Count per tier across ALL entries */
  tierDistribution: Record<string, number>;

  /** Average importance of ACTIVE entries */
  avgImportance: number;
  /** Average confidence of ACTIVE entries */
  avgConfidence: number;
  /** Average feedback_weight of ACTIVE entries */
  avgFeedbackWeight: number;

  /**
   * Count of ACTIVE entries that are stale:
   * age > 60 days AND access_count < 2 AND importance < 0.5
   */
  staleCount: number;
  /** Count of entries (all) that have a conflict_with field in metadata */
  conflictCount: number;

  /** Fraction of ALL entries whose source is "auto-capture" */
  autoCapturePct: number;
  /** Fraction of ALL entries that have a canonical_id (indicating duplicates) */
  duplicateRate: number;
}

// ============================================================================
// Constants
// ============================================================================

const STALE_AGE_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
const STALE_ACCESS_THRESHOLD = 2;
const STALE_IMPORTANCE_THRESHOLD = 0.5;

// ============================================================================
// Implementation
// ============================================================================

function inc(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

/**
 * Compute corpus-wide health metrics from a list of memory entries.
 *
 * Each entry's metadata JSON is parsed via `parseSmartMetadata` to extract
 * SmartMemoryMetadata fields (state, source, tier, category, confidence, etc.).
 */
export function computeCorpusHealth(entries: EntryLike[]): CorpusHealth {
  const categoryDistribution: Record<string, number> = {};
  const sourceDistribution: Record<string, number> = {};
  const tierDistribution: Record<string, number> = {};

  let totalActive = 0;
  let totalArchived = 0;
  let staleCount = 0;
  let conflictCount = 0;
  let autoCaptureCount = 0;
  let duplicateCount = 0;

  let sumImportance = 0;
  let sumConfidence = 0;
  let sumFeedbackWeight = 0;

  const now = Date.now();

  for (const entry of entries) {
    const meta: SmartMemoryMetadata = parseSmartMetadata(entry.metadata, entry as any);

    // --- Distribution buckets (all entries) ---
    inc(categoryDistribution, meta.memory_category);
    inc(sourceDistribution, meta.source);
    inc(tierDistribution, meta.tier);

    // --- Active vs archived ---
    const isArchived = meta.state === "archived";
    if (isArchived) {
      totalArchived++;
    } else {
      totalActive++;

      // Averages — active entries only
      const importance =
        typeof entry.importance === "number" && Number.isFinite(entry.importance)
          ? entry.importance
          : 0.7;
      sumImportance += importance;
      sumConfidence += meta.confidence;
      sumFeedbackWeight += meta.feedback_weight;

      // Stale check — active entries only
      const age = now - (entry.timestamp ?? now);
      if (
        age > STALE_AGE_MS &&
        meta.access_count < STALE_ACCESS_THRESHOLD &&
        importance < STALE_IMPORTANCE_THRESHOLD
      ) {
        staleCount++;
      }
    }

    // --- Conflict detection (all entries) ---
    const raw = entry.metadata ? safeParseJson(entry.metadata) : null;
    if (raw && typeof raw === "object" && (raw as Record<string, unknown>).conflict_with) {
      conflictCount++;
    }

    // --- Auto-capture and duplicate tracking (all entries) ---
    if (meta.source === "auto-capture") {
      autoCaptureCount++;
    }
    if (meta.canonical_id) {
      duplicateCount++;
    }
  }

  const total = entries.length;

  return {
    totalActive,
    totalArchived,
    categoryDistribution,
    sourceDistribution,
    tierDistribution,
    avgImportance: totalActive > 0 ? sumImportance / totalActive : 0,
    avgConfidence: totalActive > 0 ? sumConfidence / totalActive : 0,
    avgFeedbackWeight: totalActive > 0 ? sumFeedbackWeight / totalActive : 0,
    staleCount,
    conflictCount,
    autoCapturePct: total > 0 ? autoCaptureCount / total : 0,
    duplicateRate: total > 0 ? duplicateCount / total : 0,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
