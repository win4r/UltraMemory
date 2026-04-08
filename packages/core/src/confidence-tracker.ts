/**
 * Confidence Tracker — observation-based confidence scoring for memories.
 *
 * When a user corrects information ("actually it's X not Y"), the corrected
 * version gets higher confidence while the old version gets demoted. This
 * prevents stale/wrong information from having equal weight to verified facts.
 *
 * Confidence semantics:
 * - 1.0  = explicitly confirmed by user
 * - 0.8  = confirmed (standard confirmation bump)
 * - 0.5  = default (unverified)
 * - 0.2  = corrected / superseded
 * - 0.0  = explicitly contradicted
 *
 * Retrieval integration: confidence multiplies into the score pipeline
 * as `score *= (0.5 + 0.5 * confidence)` — same pattern used by
 * importance weighting in the decay engine.
 *
 * Time decay: confidence decays toward 0.5 (neutral) over time without
 * reconfirmation, using a gentle half-life of 90 days.
 *
 * Ported from RecallNest's confidence-tracker.ts, adapted for UltraMemory's
 * SmartMemoryMetadata structure.
 */

import type { SmartMemoryMetadata } from "./smart-metadata.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Unverified default confidence */
export const CONFIDENCE_DEFAULT = 0.5;

/** User explicitly confirmed */
export const CONFIDENCE_CONFIRMED = 0.8;

/** Strongly confirmed (repeated confirmations) */
export const CONFIDENCE_STRONG = 1.0;

/** Corrected / superseded by newer info */
export const CONFIDENCE_CORRECTED = 0.2;

/** Explicitly contradicted — should almost never surface */
export const CONFIDENCE_CONTRADICTED = 0.0;

/** Days for confidence to decay halfway back toward CONFIDENCE_DEFAULT */
export const CONFIDENCE_DECAY_HALF_LIFE_DAYS = 90;

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Confidence history — stored in metadata.confidence_history
// ---------------------------------------------------------------------------

export interface ConfidenceHistoryEntry {
  action: "confirmed" | "corrected" | "contradicted" | "decayed";
  from: number;
  to: number;
  date: string;
  /** For corrections: the ID of the memory that replaced this one */
  correctedBy?: string;
}

export interface ConfidenceUpdate {
  entryId: string;
  oldConfidence: number;
  newConfidence: number;
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/**
 * Extract confidence from a SmartMemoryMetadata object.
 * Returns CONFIDENCE_DEFAULT (0.5) if not set or invalid.
 */
export function getConfidence(metadata: Pick<SmartMemoryMetadata, "confidence">): number {
  const c = metadata.confidence;
  return typeof c === "number" && Number.isFinite(c) ? clamp01(c) : CONFIDENCE_DEFAULT;
}

/**
 * Extract confidence_history from metadata's extra fields.
 */
export function getConfidenceHistory(
  metadata: Record<string, unknown>,
): ConfidenceHistoryEntry[] {
  const raw = metadata.confidence_history;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is ConfidenceHistoryEntry =>
      !!e &&
      typeof e === "object" &&
      typeof (e as Record<string, unknown>).action === "string" &&
      typeof (e as Record<string, unknown>).from === "number" &&
      typeof (e as Record<string, unknown>).to === "number",
  );
}

// ---------------------------------------------------------------------------
// Core operations — return metadata patches (no store dependency)
// ---------------------------------------------------------------------------

/** Max history entries to keep per memory */
const MAX_CONFIDENCE_HISTORY = 20;

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function pushHistory(
  existing: ConfidenceHistoryEntry[],
  entry: ConfidenceHistoryEntry,
): ConfidenceHistoryEntry[] {
  const next = [...existing, entry];
  if (next.length > MAX_CONFIDENCE_HISTORY) {
    return next.slice(next.length - MAX_CONFIDENCE_HISTORY);
  }
  return next;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Build a metadata patch for confirming a memory.
 * Bumps confidence to CONFIDENCE_CONFIRMED (0.8), or to CONFIDENCE_STRONG
 * (1.0) if already at or above CONFIDENCE_CONFIRMED.
 */
export function buildConfirmPatch(
  metadata: Record<string, unknown>,
): { confidence: number; confidence_history: ConfidenceHistoryEntry[] } {
  const oldConfidence = typeof metadata.confidence === "number"
    ? clamp01(metadata.confidence)
    : CONFIDENCE_DEFAULT;
  const newConfidence = oldConfidence >= CONFIDENCE_CONFIRMED
    ? CONFIDENCE_STRONG
    : CONFIDENCE_CONFIRMED;
  const history = getConfidenceHistory(metadata);
  return {
    confidence: newConfidence,
    confidence_history: pushHistory(history, {
      action: "confirmed",
      from: oldConfidence,
      to: newConfidence,
      date: today(),
    }),
  };
}

/**
 * Build a metadata patch for correcting a memory (user provided updated info).
 * Drops confidence to CONFIDENCE_CORRECTED (0.2).
 */
export function buildCorrectPatch(
  metadata: Record<string, unknown>,
  correctedById?: string,
): { confidence: number; confidence_history: ConfidenceHistoryEntry[] } {
  const oldConfidence = typeof metadata.confidence === "number"
    ? clamp01(metadata.confidence)
    : CONFIDENCE_DEFAULT;
  const history = getConfidenceHistory(metadata);
  const entry: ConfidenceHistoryEntry = {
    action: "corrected",
    from: oldConfidence,
    to: CONFIDENCE_CORRECTED,
    date: today(),
  };
  if (correctedById) {
    entry.correctedBy = correctedById.slice(0, 8);
  }
  return {
    confidence: CONFIDENCE_CORRECTED,
    confidence_history: pushHistory(history, entry),
  };
}

/**
 * Build a metadata patch for contradicting a memory (explicitly wrong).
 * Drops confidence to CONFIDENCE_CONTRADICTED (0.0).
 */
export function buildContradictPatch(
  metadata: Record<string, unknown>,
): { confidence: number; confidence_history: ConfidenceHistoryEntry[] } {
  const oldConfidence = typeof metadata.confidence === "number"
    ? clamp01(metadata.confidence)
    : CONFIDENCE_DEFAULT;
  const history = getConfidenceHistory(metadata);
  return {
    confidence: CONFIDENCE_CONTRADICTED,
    confidence_history: pushHistory(history, {
      action: "contradicted",
      from: oldConfidence,
      to: CONFIDENCE_CONTRADICTED,
      date: today(),
    }),
  };
}

// ---------------------------------------------------------------------------
// Time decay
// ---------------------------------------------------------------------------

/**
 * Compute confidence after time decay. Confidence drifts toward
 * CONFIDENCE_DEFAULT (0.5) over time without reconfirmation.
 *
 * Formula: decayed = default + (current - default) * 2^(-elapsed / halfLife)
 *
 * At halfLife days, confidence moves halfway back to 0.5.
 * A memory confirmed at 1.0 would be 0.75 after 90 days, 0.625 after 180 days.
 * A memory corrected to 0.2 would be 0.35 after 90 days, 0.425 after 180 days.
 *
 * @param currentConfidence - The stored confidence value
 * @param elapsedMs - Milliseconds since last confidence update
 * @param halfLifeDays - Days for half-decay (default: CONFIDENCE_DECAY_HALF_LIFE_DAYS)
 * @returns The decayed confidence value, clamped to [0, 1]
 */
export function decayConfidence(
  currentConfidence: number,
  elapsedMs: number,
  halfLifeDays: number = CONFIDENCE_DECAY_HALF_LIFE_DAYS,
): number {
  if (elapsedMs <= 0 || halfLifeDays <= 0) return currentConfidence;
  const elapsedDays = elapsedMs / MS_PER_DAY;
  const decayFactor = Math.pow(2, -elapsedDays / halfLifeDays);
  const decayed = CONFIDENCE_DEFAULT + (currentConfidence - CONFIDENCE_DEFAULT) * decayFactor;
  return clamp01(decayed);
}

/**
 * Build a metadata patch applying time decay to confidence.
 * Only produces a patch if the decayed value differs meaningfully
 * from the current value (> 0.01 delta).
 *
 * @param metadata - Current metadata record
 * @param lastUpdateMs - Timestamp (ms) of the last confidence update
 * @param now - Current timestamp (ms), defaults to Date.now()
 * @returns A patch object, or null if no meaningful decay occurred
 */
export function buildDecayPatch(
  metadata: Record<string, unknown>,
  lastUpdateMs: number,
  now: number = Date.now(),
): { confidence: number; confidence_history: ConfidenceHistoryEntry[] } | null {
  const current = typeof metadata.confidence === "number"
    ? clamp01(metadata.confidence)
    : CONFIDENCE_DEFAULT;
  const elapsed = now - lastUpdateMs;
  const decayed = decayConfidence(current, elapsed);
  if (Math.abs(decayed - current) < 0.01) return null;

  const history = getConfidenceHistory(metadata);
  return {
    confidence: decayed,
    confidence_history: pushHistory(history, {
      action: "decayed",
      from: current,
      to: decayed,
      date: new Date(now).toISOString().slice(0, 10),
    }),
  };
}

// ---------------------------------------------------------------------------
// Retrieval weighting
// ---------------------------------------------------------------------------

/**
 * Apply confidence weighting to a retrieval score.
 *
 * Formula: score *= (0.5 + 0.5 * confidence)
 *
 * At confidence=1.0 -> x1.0  (no penalty)
 * At confidence=0.8 -> x0.9  (mild boost vs default)
 * At confidence=0.5 -> x0.75 (baseline)
 * At confidence=0.2 -> x0.6  (significant penalty)
 * At confidence=0.0 -> x0.5  (heavy penalty)
 */
export function applyConfidenceWeight(score: number, confidence: number): number {
  const c = clamp01(confidence);
  return score * (0.5 + 0.5 * c);
}
