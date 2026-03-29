/**
 * Retrieval Interference Filter (RIF)
 *
 * Brain-inspired: retrieval-induced forgetting — retrieving A actively
 * suppresses similar-but-not-selected B, improving future signal-to-noise.
 *
 * In practice: after scoring, demote near-duplicate results from the same
 * topic that are significantly weaker than a higher-ranked result.
 * They're moved to the end (not removed) as fallback.
 */

import type { RetrievalResult } from "./retriever.js";

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Filter interference: demote near-duplicate results that are significantly
 * weaker than a higher-ranked similar result.
 *
 * @param results - Scored results sorted by score descending
 * @param similarityThreshold - Cosine similarity above which two results are "near-duplicate" (default: 0.85)
 * @param scoreRatio - A result scoring below this ratio of its near-duplicate is demoted (default: 0.80)
 */
export function filterInterference(
  results: RetrievalResult[],
  similarityThreshold = 0.85,
  scoreRatio = 0.80,
): RetrievalResult[] {
  if (results.length <= 2) return results;

  const kept: RetrievalResult[] = [];
  const demoted: RetrievalResult[] = [];

  for (const candidate of results) {
    // Check if this candidate is a weak near-duplicate of any kept result
    let isDemoted = false;

    for (const selected of kept) {
      const sim = cosineSimilarity(candidate.entry.vector, selected.entry.vector);
      if (sim > similarityThreshold && candidate.score < selected.score * scoreRatio) {
        isDemoted = true;
        break;
      }
    }

    if (isDemoted) {
      demoted.push(candidate);
    } else {
      kept.push(candidate);
    }
  }

  // Demoted results go to the end as fallback
  return [...kept, ...demoted];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cosineSimilarity(a: number[] | Float32Array, b: number[] | Float32Array): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}
