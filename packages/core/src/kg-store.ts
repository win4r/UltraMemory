/**
 * Knowledge Graph Triple Store
 * Stores (subject, predicate, object) triples in a dedicated LanceDB table.
 * Pure relational — no vector columns.
 */

import type * as LanceDB from "@lancedb/lancedb";
import { createHash } from "node:crypto";
import { loadLanceDB } from "./store.js";

// ============================================================================
// Types
// ============================================================================

export interface KGTriple {
  /** Deterministic ID: sha256(scope + subject + predicate + object) */
  id: string;
  scope: string;
  subject: string;
  predicate: string;
  object: string;
  /** Extraction confidence 0-1 */
  confidence: number;
  /** ID of the source memory entry */
  source_memory_id: string;
  /** Original text snippet used for extraction */
  source_text: string;
  timestamp: number;
}

export interface KGStoreConfig {
  /** Reuse the same LanceDB connection path as MemoryStore */
  dbPath: string;
}

export interface NeighborhoodResult {
  entity: string;
  triples: KGTriple[];
  /** How many hops from the seed entity */
  hops: number;
}

// ============================================================================
// Helpers
// ============================================================================

const KG_TABLE_NAME = "kg_triples";

/** Deterministic triple ID for dedup */
export function tripleId(scope: string, subject: string, predicate: string, object: string): string {
  const raw = `${scope}\x00${subject}\x00${predicate}\x00${object}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

// ============================================================================
// KG Store
// ============================================================================

export class KGStore {
  private db: LanceDB.Connection | null = null;
  private table: LanceDB.Table | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(private readonly config: KGStoreConfig) {}

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  private async ensureInitialized(): Promise<void> {
    if (this.table) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInitialize().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const lancedb = await loadLanceDB();
    const db = await lancedb.connect(this.config.dbPath);

    let table: LanceDB.Table;
    try {
      table = await db.openTable(KG_TABLE_NAME);
    } catch {
      // Table doesn't exist — create with schema entry then remove it
      const schemaEntry: KGTriple = {
        id: "__schema__",
        scope: "global",
        subject: "",
        predicate: "",
        object: "",
        confidence: 0,
        source_memory_id: "",
        source_text: "",
        timestamp: 0,
      };

      try {
        table = await db.createTable(KG_TABLE_NAME, [schemaEntry] as unknown as Record<string, unknown>[]);
        await table.delete('id = "__schema__"');
      } catch (createErr) {
        if (String(createErr).includes("already exists")) {
          table = await db.openTable(KG_TABLE_NAME);
        } else {
          throw createErr;
        }
      }
    }

    // Create FTS index on subject for entity lookup (optional)
    try {
      const indices = await table.listIndices();
      const hasSubjectFts = indices?.some(
        (idx: any) => idx.indexType === "FTS" && idx.columns?.includes("subject"),
      );
      if (!hasSubjectFts) {
        const lance = await loadLanceDB();
        await table.createIndex("subject", { config: (lance as any).Index.fts() });
      }
    } catch {
      // FTS on subject is optional — BFS still works without it
    }

    this.db = db;
    this.table = table;
  }

  // --------------------------------------------------------------------------
  // Write
  // --------------------------------------------------------------------------

  async createTriple(triple: Omit<KGTriple, "id" | "timestamp">): Promise<KGTriple> {
    await this.ensureInitialized();

    const full: KGTriple = {
      ...triple,
      id: tripleId(triple.scope, triple.subject, triple.predicate, triple.object),
      timestamp: Date.now(),
    };

    // Upsert: delete old then add new (LanceDB has no native upsert)
    try {
      await this.table!.delete(`id = '${escapeSql(full.id)}'`);
    } catch {
      // OK if not found
    }
    await this.table!.add([full] as unknown as Record<string, unknown>[]);
    return full;
  }

  async createTriples(triples: Array<Omit<KGTriple, "id" | "timestamp">>): Promise<KGTriple[]> {
    if (triples.length === 0) return [];
    await this.ensureInitialized();

    const now = Date.now();
    const fullTriples: KGTriple[] = triples.map((t) => ({
      ...t,
      id: tripleId(t.scope, t.subject, t.predicate, t.object),
      timestamp: now,
    }));

    // Deduplicate by id (same triple in batch)
    const seen = new Set<string>();
    const deduped = fullTriples.filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });

    // Batch delete existing then add
    const ids = deduped.map((t) => `'${escapeSql(t.id)}'`).join(", ");
    try {
      await this.table!.delete(`id IN (${ids})`);
    } catch {
      // OK if none found
    }
    await this.table!.add(deduped as unknown as Record<string, unknown>[]);
    return deduped;
  }

  // --------------------------------------------------------------------------
  // Read — Edge queries
  // --------------------------------------------------------------------------

  /** Get all triples where entity is the subject */
  async getOutgoingEdges(entity: string, scope?: string): Promise<KGTriple[]> {
    await this.ensureInitialized();

    let filter = `subject = '${escapeSql(entity)}'`;
    if (scope) filter += ` AND scope = '${escapeSql(scope)}'`;

    const rows = await this.table!.query().where(filter).limit(500).toArray();
    return rows.map(rowToTriple);
  }

  /** Get all triples where entity is the object */
  async getIncomingEdges(entity: string, scope?: string): Promise<KGTriple[]> {
    await this.ensureInitialized();

    let filter = `object = '${escapeSql(entity)}'`;
    if (scope) filter += ` AND scope = '${escapeSql(scope)}'`;

    const rows = await this.table!.query().where(filter).limit(500).toArray();
    return rows.map(rowToTriple);
  }

  /**
   * BFS neighborhood traversal up to `maxHops` hops.
   * Returns all triples reachable from the seed entity.
   */
  async getNeighborhood(
    seedEntities: string[],
    maxHops = 2,
    scope?: string,
  ): Promise<NeighborhoodResult[]> {
    await this.ensureInitialized();

    const visited = new Map<string, number>(); // entity -> min hops
    const allTriples: KGTriple[] = [];
    let frontier = [...seedEntities];

    for (const seed of seedEntities) {
      visited.set(seed, 0);
    }

    for (let hop = 1; hop <= maxHops; hop++) {
      if (frontier.length === 0) break;

      const nextFrontier: string[] = [];

      for (const entity of frontier) {
        const [outgoing, incoming] = await Promise.all([
          this.getOutgoingEdges(entity, scope),
          this.getIncomingEdges(entity, scope),
        ]);

        for (const t of [...outgoing, ...incoming]) {
          allTriples.push(t);

          for (const neighbor of [t.subject, t.object]) {
            if (!visited.has(neighbor)) {
              visited.set(neighbor, hop);
              nextFrontier.push(neighbor);
            }
          }
        }
      }

      frontier = nextFrontier;
    }

    // Group by entity
    const results: NeighborhoodResult[] = [];
    for (const [entity, hops] of visited) {
      const related = allTriples.filter(
        (t) => t.subject === entity || t.object === entity,
      );
      if (related.length > 0 || seedEntities.includes(entity)) {
        results.push({ entity, triples: related, hops });
      }
    }

    return results;
  }

  // --------------------------------------------------------------------------
  // Read — Entity listing
  // --------------------------------------------------------------------------

  /** Get all unique entities in scope */
  async getAllEntities(scope?: string): Promise<string[]> {
    await this.ensureInitialized();

    const filter = scope ? `scope = '${escapeSql(scope)}'` : "1=1";
    const rows = await this.table!.query()
      .select(["subject", "object"])
      .where(filter)
      .limit(10000)
      .toArray();

    const entities = new Set<string>();
    for (const row of rows) {
      if (row.subject) entities.add(row.subject as string);
      if (row.object) entities.add(row.object as string);
    }
    return [...entities];
  }

  /** Check if an entity exists in the KG */
  async hasEntity(entity: string, scope?: string): Promise<boolean> {
    await this.ensureInitialized();

    const safeEntity = escapeSql(entity);
    let filter = `subject = '${safeEntity}' OR object = '${safeEntity}'`;
    if (scope) filter = `(${filter}) AND scope = '${escapeSql(scope)}'`;

    const rows = await this.table!.query().where(filter).limit(1).toArray();
    return rows.length > 0;
  }

  // --------------------------------------------------------------------------
  // Delete
  // --------------------------------------------------------------------------

  /** Delete all triples extracted from a given source memory */
  async deleteBySource(sourceMemoryId: string): Promise<void> {
    await this.ensureInitialized();
    await this.table!.delete(`source_memory_id = '${escapeSql(sourceMemoryId)}'`);
  }

  /** Delete all triples in scope */
  async deleteByScope(scope: string): Promise<void> {
    await this.ensureInitialized();
    await this.table!.delete(`scope = '${escapeSql(scope)}'`);
  }

  // --------------------------------------------------------------------------
  // Stats
  // --------------------------------------------------------------------------

  async countTriples(scope?: string): Promise<number> {
    await this.ensureInitialized();
    const filter = scope ? `scope = '${escapeSql(scope)}'` : "1=1";
    const rows = await this.table!.query().where(filter).select(["id"]).limit(100000).toArray();
    return rows.length;
  }
}

// ============================================================================
// Row mapping
// ============================================================================

function rowToTriple(row: Record<string, unknown>): KGTriple {
  return {
    id: row.id as string,
    scope: (row.scope as string) ?? "global",
    subject: row.subject as string,
    predicate: row.predicate as string,
    object: row.object as string,
    confidence: Number(row.confidence),
    source_memory_id: row.source_memory_id as string,
    source_text: row.source_text as string,
    timestamp: Number(row.timestamp),
  };
}
