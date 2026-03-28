/**
 * Retrieval Benchmark Harness — scores individual query results and
 * aggregates them into suite-level metrics for evaluating retrieval quality.
 */

// ============================================================================
// Types
// ============================================================================

export interface BenchmarkQuery {
  text: string;
  expectedIds: string[];
  notExpectedIds: string[];
}

export interface BenchmarkResult {
  id: string;
  score: number;
}

export interface QueryScore {
  query: string;
  recall: number;
  precision: number;
  mrr: number;
  contamination: number;
  latencyMs: number;
}

export interface SuiteMetrics {
  recall_at_5: number;
  precision_at_5: number;
  mrr: number;
  conflictContamination: number;
  latency_p50_ms: number;
  latency_p99_ms: number;
}

// ============================================================================
// Single-query scoring
// ============================================================================

/**
 * Score a single benchmark query against its retrieval results.
 *
 * - **recall**: fraction of expectedIds found in results
 * - **precision**: fraction of results that are in expectedIds
 * - **mrr**: reciprocal rank of the first expected result found
 * - **contamination**: count of notExpectedIds found in results
 */
export function scoreBenchmarkResult(
  query: BenchmarkQuery,
  results: BenchmarkResult[],
): Omit<QueryScore, "latencyMs"> {
  const topResults = results.slice(0, 5); // Only score top 5
  const resultIds = topResults.map((r) => r.id);
  const expectedSet = new Set(query.expectedIds);
  const notExpectedSet = new Set(query.notExpectedIds);

  // Recall: fraction of expected IDs that appear in results
  let foundExpected = 0;
  for (const eid of query.expectedIds) {
    if (resultIds.includes(eid)) foundExpected++;
  }
  const recall = query.expectedIds.length > 0
    ? foundExpected / query.expectedIds.length
    : 0;

  // Precision: fraction of results that are in the expected set
  let relevantResults = 0;
  for (const rid of resultIds) {
    if (expectedSet.has(rid)) relevantResults++;
  }
  const precision = resultIds.length > 0
    ? relevantResults / resultIds.length
    : 0;

  // MRR: reciprocal rank of the first expected result
  let mrr = 0;
  for (let i = 0; i < resultIds.length; i++) {
    if (expectedSet.has(resultIds[i])) {
      mrr = 1 / (i + 1);
      break;
    }
  }

  // Contamination: count of not-expected IDs found in results
  let contamination = 0;
  for (const rid of resultIds) {
    if (notExpectedSet.has(rid)) contamination++;
  }

  return {
    query: query.text,
    recall,
    precision,
    mrr,
    contamination,
  };
}

// ============================================================================
// Suite-level aggregation
// ============================================================================

/**
 * Aggregate an array of QueryScore results into suite-level metrics.
 *
 * - **recall_at_5**, **precision_at_5**, **mrr**: arithmetic mean across queries
 * - **conflictContamination**: arithmetic mean of contamination counts
 * - **latency_p50_ms**, **latency_p99_ms**: percentile latency values
 */
export function computeSuiteMetrics(scores: QueryScore[]): SuiteMetrics {
  if (scores.length === 0) {
    return {
      recall_at_5: 0,
      precision_at_5: 0,
      mrr: 0,
      conflictContamination: 0,
      latency_p50_ms: 0,
      latency_p99_ms: 0,
    };
  }

  const n = scores.length;

  const recall_at_5 = sum(scores.map((s) => s.recall)) / n;
  const precision_at_5 = sum(scores.map((s) => s.precision)) / n;
  const mrr = sum(scores.map((s) => s.mrr)) / n;
  const conflictContamination = sum(scores.map((s) => s.contamination)) / n;

  const latencies = scores.map((s) => s.latencyMs).sort((a, b) => a - b);
  const latency_p50_ms = percentile(latencies, 0.5);
  const latency_p99_ms = percentile(latencies, 0.99);

  return {
    recall_at_5,
    precision_at_5,
    mrr,
    conflictContamination,
    latency_p50_ms,
    latency_p99_ms,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function sum(values: number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/**
 * Compute a percentile value from a sorted array using nearest-rank method.
 * For p=0.5 (median), picks the middle element. For p=0.99, picks near-max.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  // Nearest-rank: rank = ceil(p * n) then clamp to [1, n]
  const rank = Math.max(1, Math.min(sorted.length, Math.ceil(p * sorted.length)));
  return sorted[rank - 1];
}
