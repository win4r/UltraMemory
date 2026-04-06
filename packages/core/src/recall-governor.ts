/**
 * Recall Governor — auto-recall governance layer
 *
 * Sits between retriever output and context injection.
 * Applies 4 layers of governance to prevent wasteful/redundant memory injection:
 *
 *   1. Query truncation — cap overly long queries before embedding (save cost)
 *   2. State filter    — exclude archived/superseded entries (defense-in-depth)
 *   3. Session dedup   — don't re-inject already-injected memories this session
 *   4. Budget control  — enforce char budget + entry count limit
 *
 * Ported from RecallNest's recall-governor.ts, adapted for UltraMemory types.
 */

import { isMemoryActiveAt, parseSmartMetadata } from "./smart-metadata.js";
import type { MemorySearchResult } from "./store.js";

// ============================================================================
// Configuration
// ============================================================================

export interface GovernorConfig {
  /** Max query length before truncation (default: 1000) */
  maxQueryChars: number;
  /** Max total characters across all injected memories (default: 8000) */
  charBudget: number;
  /** Max number of memories to inject per recall (default: 10) */
  maxItems: number;
}

const DEFAULT_GOVERNOR_CONFIG: GovernorConfig = {
  maxQueryChars: 1000,
  charBudget: 8000,
  maxItems: 10,
};

export function resolveGovernorConfig(
  overrides?: Partial<GovernorConfig>,
): GovernorConfig {
  return { ...DEFAULT_GOVERNOR_CONFIG, ...overrides };
}

// ============================================================================
// Governor Session — tracks per-session dedup state
// ============================================================================

export class GovernorSession {
  private readonly injectedIds = new Set<string>();

  /** Mark a memory ID as already injected in this session. */
  markInjected(id: string): void {
    this.injectedIds.add(id);
  }

  /** Check whether a memory ID was already injected. */
  wasInjected(id: string): boolean {
    return this.injectedIds.has(id);
  }

  /** Bulk-mark results after governing. */
  markAll(results: MemorySearchResult[]): void {
    for (const r of results) {
      this.injectedIds.add(r.entry.id);
    }
  }

  /** Number of unique IDs tracked so far. */
  get size(): number {
    return this.injectedIds.size;
  }
}

// ============================================================================
// Layer 1: Query Truncation
// ============================================================================

export function truncateQuery(query: string, maxChars: number): string {
  if (query.length <= maxChars) return query;
  return query.slice(0, maxChars);
}

// ============================================================================
// Layer 2: State Filter (defense-in-depth)
// ============================================================================

function filterByState(results: MemorySearchResult[]): MemorySearchResult[] {
  return results.filter((r) => {
    const metadata = parseSmartMetadata(r.entry.metadata, r.entry);
    return isMemoryActiveAt(metadata);
  });
}

// ============================================================================
// Layer 3: Session Dedup
// ============================================================================

function deduplicateBySession(
  results: MemorySearchResult[],
  session: GovernorSession | undefined,
): MemorySearchResult[] {
  if (!session) return results;
  return results.filter((r) => !session.wasInjected(r.entry.id));
}

// ============================================================================
// Layer 4: Budget Control
// ============================================================================

function applyBudget(
  results: MemorySearchResult[],
  config: GovernorConfig,
): MemorySearchResult[] {
  const kept: MemorySearchResult[] = [];
  let totalChars = 0;

  for (const r of results) {
    if (kept.length >= config.maxItems) break;
    const textLen = r.entry.text.length;
    if (totalChars + textLen > config.charBudget && kept.length > 0) break;
    // Always allow at least one result even if it exceeds budget
    kept.push(r);
    totalChars += textLen;
  }

  return kept;
}

// ============================================================================
// Public API — compose all layers
// ============================================================================

/**
 * Run the full governance pipeline on retrieval results.
 * Call this after retrieval, before injecting into context.
 *
 * @param results - Pre-sorted retrieval results (score descending)
 * @param session - Optional GovernorSession for cross-call dedup
 * @param config  - Optional config overrides
 * @returns Governed results, ready for injection
 */
export function governResults(
  results: MemorySearchResult[],
  session?: GovernorSession,
  config?: Partial<GovernorConfig>,
): MemorySearchResult[] {
  if (results.length === 0) return results;

  const cfg = resolveGovernorConfig(config);

  // Layer 2: state filter (exclude archived/superseded)
  let governed = filterByState(results);

  // Layer 3: session dedup (before budget so deduped items don't waste budget slots)
  governed = deduplicateBySession(governed, session);

  // Layer 4: budget control (char limit + entry count)
  governed = applyBudget(governed, cfg);

  // Mark newly injected IDs for future dedup
  if (session) {
    session.markAll(governed);
  }

  return governed;
}
