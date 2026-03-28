/**
 * Ingestion Pipeline — unified write path for all memory ingestion.
 *
 * Coordinates: noise filtering → embedding → dedup → conflict detection →
 * metadata building → multi-layer vectors → store → supersede → auto-link.
 */

import { isNoise } from "./noise-filter.js";
import {
  deriveFactKey,
  buildSmartMetadata,
  stringifySmartMetadata,
  parseSmartMetadata,
  appendRelation,
  type MemorySource,
  type MemoryState,
  type SmartMemoryMetadata,
} from "./smart-metadata.js";
import { detectFactKeyConflict } from "./conflict-detector.js";
import type { MemoryCategory } from "./memory-categories.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IngestionPipelineConfig {
  /** Duck-typed store — needs store(), vectorSearch(), patchMetadata(), getById() */
  store: any;
  /** Duck-typed embedder — needs embedPassage(), embedBatchPassage() */
  embedder: any;
  /** Cosine similarity threshold above which an entry is considered a duplicate (default 0.98) */
  dupThreshold?: number;
  /** Enable fact-key conflict detection (default true) */
  conflictEnabled?: boolean;
}

export interface IngestionInput {
  text: string;
  category: string; // MemoryCategory value
  importance: number;
  scope: string;
  source: string; // MemorySource value
  l0_abstract?: string;
  l1_overview?: string;
  l2_content?: string;
  provenance?: Record<string, unknown>;
  conflictStrategy?: "supersede" | "coexist" | "ask";
}

export type IngestionAction =
  | "created"
  | "duplicate"
  | "noise_filtered"
  | "superseded"
  | "conflict_detected";

export interface IngestionResult {
  id: string;
  action: IngestionAction;
  conflictWith?: string;
  relationsAdded: number;
}

// ---------------------------------------------------------------------------
// Category mapping: MemoryCategory → legacy store category
// ---------------------------------------------------------------------------

type LegacyStoreCategory =
  | "preference"
  | "fact"
  | "decision"
  | "entity"
  | "other"
  | "reflection";

const CATEGORY_TO_LEGACY: Record<string, LegacyStoreCategory> = {
  profile: "fact",
  preferences: "preference",
  entities: "entity",
  events: "decision",
  cases: "fact",
  patterns: "other",
};

function toLegacyCategory(cat: string): LegacyStoreCategory {
  return CATEGORY_TO_LEGACY[cat] ?? "other";
}

// ---------------------------------------------------------------------------
// IngestionPipeline
// ---------------------------------------------------------------------------

export class IngestionPipeline {
  private store: any;
  private embedder: any;
  private dupThreshold: number;
  private conflictEnabled: boolean;

  constructor(config: IngestionPipelineConfig) {
    this.store = config.store;
    this.embedder = config.embedder;
    this.dupThreshold = config.dupThreshold ?? 0.98;
    this.conflictEnabled = config.conflictEnabled ?? true;
  }

  async ingest(input: IngestionInput): Promise<IngestionResult> {
    // -----------------------------------------------------------------------
    // 1. Noise check
    // -----------------------------------------------------------------------
    if (isNoise(input.text)) {
      return { id: "", action: "noise_filtered", relationsAdded: 0 };
    }

    // -----------------------------------------------------------------------
    // 2. Embed main vector
    // -----------------------------------------------------------------------
    const mainVector: number[] = await this.embedder.embedPassage(input.text);

    // -----------------------------------------------------------------------
    // 3. Dedup check
    // -----------------------------------------------------------------------
    let similar: Array<{ entry: any; score: number }> = [];
    try {
      similar = await this.store.vectorSearch(
        mainVector,
        5,
        0.1,
        [input.scope],
        { excludeInactive: true },
      );
    } catch {
      similar = [];
    }

    if (similar.length > 0 && similar[0].score > this.dupThreshold) {
      return { id: "", action: "duplicate", relationsAdded: 0 };
    }

    // -----------------------------------------------------------------------
    // 4. Conflict detection
    // -----------------------------------------------------------------------
    const memoryCategory = input.category as MemoryCategory;
    const l0 = input.l0_abstract ?? input.text;
    const factKey = deriveFactKey(memoryCategory, l0);

    let conflictWith: string | undefined;

    if (this.conflictEnabled && factKey) {
      // Build existing references from similar results that have fact_keys
      const existingRefs = similar
        .map((s) => {
          const meta = safeParseMetadata(s.entry.metadata);
          return {
            id: s.entry.id as string,
            factKey: meta?.fact_key as string | undefined,
            text: s.entry.text as string,
          };
        })
        .filter((ref) => ref.factKey !== undefined);

      const conflictResult = detectFactKeyConflict(
        { factKey, text: input.text },
        existingRefs,
      );

      if (conflictResult.hasConflict) {
        const strategy = input.conflictStrategy ?? "ask";

        if (strategy === "supersede") {
          // Will store the new entry and mark old as superseded (step 8)
          conflictWith = conflictResult.conflictWith;
        } else {
          // "coexist" or "ask" — return conflict without storing
          return {
            id: "",
            action: "conflict_detected",
            conflictWith: conflictResult.conflictWith,
            relationsAdded: 0,
          };
        }
      }
    }

    // -----------------------------------------------------------------------
    // 5. Build metadata
    // -----------------------------------------------------------------------
    const source = input.source as MemorySource;
    const state: MemoryState = source === "auto-capture" ? "pending" : "confirmed";
    const trustLevel: "source" | "generated" =
      source === "consolidation" ? "generated" : "source";

    const now = Date.now();
    const smartMeta = buildSmartMetadata(
      { text: input.text },
      {
        state,
        source,
        trust_level: trustLevel,
        valid_from: now,
        l0_abstract: l0,
        l1_overview: input.l1_overview ?? `- ${l0}`,
        l2_content: input.l2_content ?? input.text,
        memory_category: memoryCategory,
        fact_key: factKey,
        ...(conflictWith ? { supersedes: conflictWith } : {}),
        ...(input.provenance ? { provenance: input.provenance } : {}),
      },
    );

    const metadataStr = stringifySmartMetadata(smartMeta);

    // -----------------------------------------------------------------------
    // 6. Embed multi-layer vectors
    // -----------------------------------------------------------------------
    const l0Text = smartMeta.l0_abstract;
    const l1Text = smartMeta.l1_overview;
    const l2Text = smartMeta.l2_content;

    // Collect layers that differ from main text to batch-embed
    const layerTexts: string[] = [];
    const layerIndices: number[] = []; // which layer index (0=L0, 1=L1, 2=L2)
    const layerVectors: (number[] | null)[] = [null, null, null];

    const allLayerTexts = [l0Text, l1Text, l2Text];
    for (let i = 0; i < allLayerTexts.length; i++) {
      if (allLayerTexts[i] === input.text) {
        layerVectors[i] = mainVector;
      } else {
        layerTexts.push(allLayerTexts[i]);
        layerIndices.push(i);
      }
    }

    if (layerTexts.length > 0) {
      const batchVectors: number[][] =
        await this.embedder.embedBatchPassage(layerTexts);
      for (let j = 0; j < layerIndices.length; j++) {
        layerVectors[layerIndices[j]] = batchVectors[j];
      }
    }

    // -----------------------------------------------------------------------
    // 7. Store
    // -----------------------------------------------------------------------
    const storeResult = await this.store.store({
      text: input.text,
      vector: mainVector,
      category: toLegacyCategory(input.category),
      scope: input.scope,
      importance: input.importance,
      metadata: metadataStr,
      vector_l0: layerVectors[0],
      vector_l1: layerVectors[1],
      vector_l2: layerVectors[2],
    });

    const newId: string = storeResult.id ?? "";

    // -----------------------------------------------------------------------
    // 8. Handle supersede — patch old entry
    // -----------------------------------------------------------------------
    if (conflictWith) {
      try {
        const oldEntry = await this.store.getById(conflictWith);
        if (oldEntry) {
          const oldMeta = parseSmartMetadata(oldEntry.metadata, oldEntry);
          const patchedMeta = stringifySmartMetadata({
            ...oldMeta,
            invalidated_at: now,
            superseded_by: newId,
          });
          await this.store.patchMetadata(conflictWith, patchedMeta);
        }
      } catch {
        // Best-effort; don't fail the ingest if supersede patch fails
      }
    }

    // -----------------------------------------------------------------------
    // 9. Auto-link relations — similar memories with score 0.6-0.98
    // -----------------------------------------------------------------------
    let relationsAdded = 0;
    const relCandidates = similar.filter(
      (s) => s.score >= 0.6 && s.score <= this.dupThreshold,
    );
    const relTargets = relCandidates.slice(0, 3);

    for (const target of relTargets) {
      try {
        const targetId = target.entry.id as string;

        // Add relation on new entry's metadata
        const newMeta = safeParseMetadata(metadataStr) ?? {};
        const updatedRelations = appendRelation(
          newMeta.relations,
          { type: "related_to", targetId },
        );
        newMeta.relations = updatedRelations;
        await this.store.patchMetadata(newId, JSON.stringify(newMeta));

        // Add reverse relation on target's metadata
        const targetEntry = await this.store.getById(targetId);
        if (targetEntry) {
          const targetMeta = safeParseMetadata(targetEntry.metadata) ?? {};
          const reverseRelations = appendRelation(
            targetMeta.relations,
            { type: "related_to", targetId: newId },
          );
          targetMeta.relations = reverseRelations;
          await this.store.patchMetadata(targetId, JSON.stringify(targetMeta));
        }

        relationsAdded++;
      } catch {
        // Best-effort relation linking
      }
    }

    // -----------------------------------------------------------------------
    // Result
    // -----------------------------------------------------------------------
    const action: IngestionAction = conflictWith ? "superseded" : "created";

    return {
      id: newId,
      action,
      ...(conflictWith ? { conflictWith } : {}),
      relationsAdded,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParseMetadata(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}
