/**
 * Conflict Detector
 *
 * Detects fact_key collisions and heuristic contradictions between memories.
 * Used by the ingestion pipeline to flag or supersede stale facts.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConflictCheckInput {
  factKey: string | undefined;
  text: string;
}

export interface ExistingMemoryRef {
  id: string;
  factKey: string | undefined;
  text: string;
}

export interface FactKeyConflictResult {
  hasConflict: boolean;
  isDuplicate: boolean;
  conflictWith?: string;
}

// ---------------------------------------------------------------------------
// detectFactKeyConflict
// ---------------------------------------------------------------------------

/**
 * Check whether an incoming memory conflicts with any existing memory on
 * the same `factKey`.
 *
 * - If incoming.factKey is undefined, there can be no key-based conflict.
 * - Same factKey + same text (case-insensitive) = duplicate, not a conflict.
 * - Same factKey + different text = conflict.
 */
export function detectFactKeyConflict(
  incoming: ConflictCheckInput,
  existing: ExistingMemoryRef[],
): FactKeyConflictResult {
  if (incoming.factKey === undefined) {
    return { hasConflict: false, isDuplicate: false };
  }

  const match = existing.find((e) => e.factKey === incoming.factKey);
  if (!match) {
    return { hasConflict: false, isDuplicate: false };
  }

  const sameText =
    incoming.text.toLowerCase().trim() === match.text.toLowerCase().trim();

  if (sameText) {
    return { hasConflict: false, isDuplicate: true };
  }

  return { hasConflict: true, isDuplicate: false, conflictWith: match.id };
}

// ---------------------------------------------------------------------------
// detectHeuristicContradiction
// ---------------------------------------------------------------------------

/** Regex for a positive statement: verb + object */
const POS_RE = /^(\w+)\s+(.+)$/;

/** Regex for a negated statement: doesn't/does not/don't/do not + verb + object */
const NEG_RE = /^(?:doesn't|does not|don't|do not)\s+(\w+)\s+(.+)$/;

/** Common subject prefixes to strip before comparison. */
const SUBJECT_PREFIXES = /^(?:the user|user|they)\s+/i;

/** Strip trailing 's' to get a rough verb root (likes -> like). */
function verbRoot(verb: string): string {
  const lower = verb.toLowerCase();
  return lower.endsWith("s") ? lower.slice(0, -1) : lower;
}

/**
 * Returns true if one statement appears to negate the other using simple
 * verb-negation patterns. Checks both directions (A pos + B neg, A neg + B pos).
 *
 * Strips common subject prefixes ("user", "the user", "they") before matching,
 * and normalises verb roots (strip trailing 's') for comparison.
 */
export function detectHeuristicContradiction(
  textA: string,
  textB: string,
): boolean {
  const a = textA.replace(SUBJECT_PREFIXES, "").trim();
  const b = textB.replace(SUBJECT_PREFIXES, "").trim();

  return checkOrdered(a, b) || checkOrdered(b, a);
}

/**
 * Check one direction: positive first, negative second.
 */
function checkOrdered(pos: string, neg: string): boolean {
  const posMatch = POS_RE.exec(pos);
  const negMatch = NEG_RE.exec(neg);
  if (!posMatch || !negMatch) return false;

  const posVerb = verbRoot(posMatch[1]);
  const posObj = posMatch[2].toLowerCase().trim();
  const negVerb = verbRoot(negMatch[1]);
  const negObj = negMatch[2].toLowerCase().trim();

  return posVerb === negVerb && posObj === negObj;
}
