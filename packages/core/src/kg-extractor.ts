/**
 * Knowledge Graph Triple Extractor
 * Uses LLM few-shot OpenIE to extract (subject, predicate, object) triples from memory text.
 * Gated by ULTRAMEMORY_KG_MODE env var.
 */

import type { LlmClient } from "./llm-client.js";
import type { KGStore } from "./kg-store.js";

// ============================================================================
// Types
// ============================================================================

export interface RawTriple {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
}

export interface KGExtractorConfig {
  /** Minimum confidence to keep a triple (0-1). Default: 0.6 */
  minConfidence?: number;
  /** LLM client for extraction */
  llmClient: LlmClient;
  /** KG store for persisting triples */
  kgStore: KGStore;
}

interface LlmExtractionResponse {
  triples: RawTriple[];
}

// ============================================================================
// Feature Gate
// ============================================================================

/** Check if KG mode is enabled (env var) */
export function isKGModeEnabled(): boolean {
  return process.env.ULTRAMEMORY_KG_MODE === "true";
}

// ============================================================================
// Entity Normalization
// ============================================================================

/**
 * Normalize entity names for consistent matching:
 * - Trim whitespace, collapse internal whitespace
 * - Title case for Latin text, CJK unchanged
 * - Strip surrounding quotes/brackets
 */
export function normalizeEntity(raw: string): string {
  let entity = raw.trim();

  // Strip surrounding quotes and brackets
  entity = entity.replace(/^[\s"'""''「」『』【】\[\]()（）]+/, "");
  entity = entity.replace(/[\s"'""''「」『』【】\[\]()（）]+$/, "");

  // Collapse whitespace
  entity = entity.replace(/\s+/g, " ").trim();

  if (!entity) return "";

  // For CJK text, return as-is
  if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(entity)) {
    return entity;
  }

  // Title Case for English entities
  return entity
    .toLowerCase()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/**
 * Normalize predicate to snake_case for consistency.
 */
export function normalizePredicate(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_\u4e00-\u9fff]/g, "");
}

// ============================================================================
// Extraction Prompt
// ============================================================================

const KG_EXTRACT_SYSTEM = `You are a knowledge graph extraction assistant. Extract (subject, predicate, object) triples from text. Respond with valid JSON only.`;

function buildKGExtractionPrompt(text: string): string {
  return `Extract knowledge graph triples from the text below.

Rules:
- Extract relationships between named entities, concepts, tools, people, projects
- Use simple predicates: uses, created_by, works_with, friend_of, depends_on, located_in, member_of, prefers, knows, discussed, mentioned_in, related_to, is_a, has, manages, built, wrote, lives_in
- Assign confidence (0-1) based on how explicit the relationship is
- Skip vague or speculative relationships (confidence < 0.5)
- 3-8 triples per text typically

Examples:

Text: "Alice uses Python for her data science projects at Google"
{"triples":[{"subject":"Alice","predicate":"uses","object":"Python","confidence":0.95},{"subject":"Alice","predicate":"works_at","object":"Google","confidence":0.90}]}

Text: "RecallNest depends on LanceDB for vector storage and uses OpenAI for embeddings"
{"triples":[{"subject":"RecallNest","predicate":"depends_on","object":"LanceDB","confidence":0.95},{"subject":"RecallNest","predicate":"uses","object":"OpenAI","confidence":0.90}]}

Now extract triples from:

${text}`;
}

// ============================================================================
// Extractor
// ============================================================================

export class KGExtractor {
  private readonly minConfidence: number;
  private readonly llm: LlmClient;
  private readonly kgStore: KGStore;

  constructor(config: KGExtractorConfig) {
    this.minConfidence = config.minConfidence ?? 0.6;
    this.llm = config.llmClient;
    this.kgStore = config.kgStore;
  }

  /**
   * Extract triples from text and persist to KG store.
   * Returns the number of triples stored.
   */
  async extractAndStore(
    text: string,
    sourceMemoryId: string,
    scope: string,
  ): Promise<number> {
    const rawTriples = await this.extract(text);
    if (rawTriples.length === 0) return 0;

    const triples = await this.kgStore.createTriples(
      rawTriples.map((t) => ({
        scope,
        subject: t.subject,
        predicate: t.predicate,
        object: t.object,
        confidence: t.confidence,
        source_memory_id: sourceMemoryId,
        source_text: text.slice(0, 500), // Cap source text
      })),
    );

    console.error(`[KG] stored ${triples.length} triples from memory ${sourceMemoryId}`);
    return triples.length;
  }

  /**
   * Extract raw triples from text via LLM. Does not persist.
   */
  async extract(text: string): Promise<RawTriple[]> {
    if (!text || text.length < 10) return [];

    const prompt = buildKGExtractionPrompt(text);

    let response: LlmExtractionResponse | null = null;
    try {
      response = await this.llm.completeJson<LlmExtractionResponse>(
        KG_EXTRACT_SYSTEM + "\n\n" + prompt,
        "kg-extraction",
      );
    } catch (err) {
      console.error(`[KG] LLM extraction failed: ${String(err)}`);
      return [];
    }

    if (!response?.triples || !Array.isArray(response.triples)) {
      return [];
    }

    // Validate, normalize, filter
    const valid: RawTriple[] = [];
    for (const t of response.triples) {
      if (!t.subject || !t.predicate || !t.object) continue;

      const subject = normalizeEntity(t.subject);
      const predicate = normalizePredicate(t.predicate);
      const object = normalizeEntity(t.object);
      const confidence = Number(t.confidence) || 0;

      if (!subject || !predicate || !object) continue;
      if (confidence < this.minConfidence) continue;
      if (subject === object) continue; // Skip self-referencing

      valid.push({ subject, predicate, object, confidence });
    }

    // Deduplicate within batch
    const seen = new Set<string>();
    return valid.filter((t) => {
      const key = `${t.subject}\x00${t.predicate}\x00${t.object}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createKGExtractor(config: KGExtractorConfig): KGExtractor {
  return new KGExtractor(config);
}
