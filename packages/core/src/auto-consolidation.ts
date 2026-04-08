/**
 * Auto Consolidation — dual-threshold trigger for the consolidation engine.
 *
 * Instead of requiring manual consolidation calls, this module tracks write
 * count and elapsed time since the last consolidation run. When BOTH thresholds
 * are exceeded, it fires the existing ConsolidationEngine automatically.
 *
 * Usage: call `maybeConsolidate()` after each memory write (e.g. in the
 * ingestion pipeline or MCP store tool). The call is cheap when thresholds
 * are not met — just two comparisons.
 */

import {
  ConsolidationEngine,
  type ConsolidationConfig,
  type ConsolidationResult,
  DEFAULT_CONSOLIDATION_CONFIG,
} from "./consolidation-engine.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AutoConsolidationConfig {
  /** Minimum writes since last consolidation before triggering (default 50) */
  minWritesSinceLastRun: number;
  /** Minimum milliseconds since last consolidation (default 3_600_000 = 1 hour) */
  minMsSinceLastRun: number;
  /** Consolidation engine config (cluster/merge thresholds) */
  consolidation: ConsolidationConfig;
}

export const DEFAULT_AUTO_CONSOLIDATION_CONFIG: AutoConsolidationConfig = {
  minWritesSinceLastRun: 50,
  minMsSinceLastRun: 3_600_000, // 1 hour
  consolidation: DEFAULT_CONSOLIDATION_CONFIG,
};

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type AutoConsolidationSkipReason =
  | "insufficient_writes"
  | "too_soon"
  | "already_running";

export interface AutoConsolidationResult {
  triggered: boolean;
  reason?: AutoConsolidationSkipReason;
  consolidation?: ConsolidationResult;
}

// ---------------------------------------------------------------------------
// Duck-typed store interface (same shape as ConsolidationEngine expects)
// ---------------------------------------------------------------------------

interface StoreLike {
  list(
    scopeFilter?: string[],
    category?: string,
    limit?: number,
    offset?: number,
  ): Promise<unknown[]>;

  getById(id: string, scopeFilter?: string[]): Promise<unknown | null>;

  vectorSearch(
    vector: number[],
    limit?: number,
    minScore?: number,
    scopeFilter?: string[],
    options?: { excludeInactive?: boolean; column?: string },
  ): Promise<unknown[]>;

  patchMetadata(
    id: string,
    patch: Record<string, unknown>,
    scopeFilter?: string[],
  ): Promise<unknown | null>;
}

// ---------------------------------------------------------------------------
// AutoConsolidation
// ---------------------------------------------------------------------------

export class AutoConsolidation {
  private writesSinceLastRun = 0;
  private lastRunTimestamp = 0;
  private running = false;
  private readonly config: AutoConsolidationConfig;
  private readonly store: StoreLike;

  constructor(store: StoreLike, config?: Partial<AutoConsolidationConfig>) {
    this.store = store;
    this.config = {
      ...DEFAULT_AUTO_CONSOLIDATION_CONFIG,
      ...config,
      consolidation: {
        ...DEFAULT_CONSOLIDATION_CONFIG,
        ...config?.consolidation,
      },
    };
  }

  /**
   * Record a write and check whether consolidation should fire.
   * Returns immediately (no-op) when thresholds are not met or a run is
   * already in progress.
   */
  async maybeConsolidate(scope: string): Promise<AutoConsolidationResult> {
    this.writesSinceLastRun++;

    // Gate 1: enough writes?
    if (this.writesSinceLastRun < this.config.minWritesSinceLastRun) {
      return { triggered: false, reason: "insufficient_writes" };
    }

    // Gate 2: enough time elapsed?
    const elapsed = Date.now() - this.lastRunTimestamp;
    if (elapsed < this.config.minMsSinceLastRun) {
      return { triggered: false, reason: "too_soon" };
    }

    // Gate 3: prevent concurrent runs
    if (this.running) {
      return { triggered: false, reason: "already_running" };
    }

    // Both thresholds met — run consolidation
    this.running = true;
    try {
      const engine = new ConsolidationEngine(
        this.store as any,
        this.config.consolidation,
      );
      const result = await engine.run(scope);

      // Reset counters on success
      this.writesSinceLastRun = 0;
      this.lastRunTimestamp = Date.now();

      return { triggered: true, consolidation: result };
    } finally {
      this.running = false;
    }
  }

  /** Current write count since last consolidation. */
  get writeCount(): number {
    return this.writesSinceLastRun;
  }

  /** Timestamp (ms) of the last consolidation run (0 if never). */
  get lastRunTime(): number {
    return this.lastRunTimestamp;
  }

  /** Reset internal state (for testing). */
  reset(): void {
    this.writesSinceLastRun = 0;
    this.lastRunTimestamp = 0;
    this.running = false;
  }
}
