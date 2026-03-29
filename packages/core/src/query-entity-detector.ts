/**
 * Query Entity Detector
 * Extracts entities from search queries for KG graph traversal.
 * Combines heuristic extraction with KG entity matching.
 */

import { normalizeEntity } from "./kg-extractor.js";
import type { KGStore } from "./kg-store.js";

// ============================================================================
// Types
// ============================================================================

export interface DetectedEntities {
  /** Entities found in the query */
  entities: string[];
  /** Whether the query signals multi-hop intent */
  isMultiHop: boolean;
  /** Detected multi-hop predicate (e.g. "friend_of", "uses") */
  hopPredicate?: string;
}

// ============================================================================
// Multi-hop signal patterns
// ============================================================================

interface HopPattern {
  pattern: RegExp;
  predicate: string;
}

const MULTI_HOP_PATTERNS: HopPattern[] = [
  // English patterns
  { pattern: /(\w+)'s\s+friends?/i, predicate: "friend_of" },
  { pattern: /friends?\s+of\s+(\w+)/i, predicate: "friend_of" },
  { pattern: /who\s+(?:does|did)\s+(\w+)\s+(?:work|collaborate)\s+with/i, predicate: "works_with" },
  { pattern: /what\s+does\s+(\w+)\s+use/i, predicate: "uses" },
  { pattern: /what\s+(?:tools?|tech|technologies?)\s+does\s+(\w+)\s+use/i, predicate: "uses" },
  { pattern: /who\s+(?:uses?|works?\s+with)\s+(\w+)/i, predicate: "uses" },
  { pattern: /who\s+(?:created|built|wrote|made)\s+(\w+)/i, predicate: "created_by" },
  { pattern: /who\s+(?:knows?|is\s+familiar\s+with)\s+(\w+)/i, predicate: "knows" },
  { pattern: /what\s+depends\s+on\s+(\w+)/i, predicate: "depends_on" },
  { pattern: /(\w+)\s+depend(?:s|encies)/i, predicate: "depends_on" },
  { pattern: /who\s+manages?\s+(\w+)/i, predicate: "manages" },
  { pattern: /(\w+)'s\s+team/i, predicate: "member_of" },
  // Chinese patterns
  { pattern: /(.+?)的朋友/u, predicate: "friend_of" },
  { pattern: /谁和(.+?)一起/u, predicate: "works_with" },
  { pattern: /(.+?)用(?:了|什么)/u, predicate: "uses" },
  { pattern: /谁(?:创建|开发|写)了(.+)/u, predicate: "created_by" },
  { pattern: /(.+?)(?:依赖|需要)什么/u, predicate: "depends_on" },
  { pattern: /谁(?:认识|了解)(.+)/u, predicate: "knows" },
  { pattern: /(.+?)的(?:团队|成员)/u, predicate: "member_of" },
  { pattern: /谁管理(.+)/u, predicate: "manages" },
];

// ============================================================================
// Heuristic entity extraction
// ============================================================================

/**
 * Extract candidate entities from query text using heuristics:
 * - Quoted strings: "RecallNest", 'LanceDB'
 * - Capitalized words/phrases: Alice, OpenAI, Claude Code
 * - CamelCase compound words: RecallNest, LanceDB
 */
function extractCandidates(query: string): string[] {
  const candidates: string[] = [];

  // 1. Quoted strings (single, double, backtick)
  const quoted = query.match(/["'`]([^"'`]+)["'`]/g);
  if (quoted) {
    for (const q of quoted) {
      const inner = q.slice(1, -1).trim();
      if (inner.length >= 2) candidates.push(inner);
    }
  }

  // 2. Capitalized words/phrases (English)
  // Match sequences of capitalized words: "Claude Code", "Open AI", "LanceDB"
  const capPattern = /\b([A-Z][a-zA-Z]*(?:[\s-][A-Z][a-zA-Z]*)*)\b/g;
  let match;
  while ((match = capPattern.exec(query)) !== null) {
    const word = match[1].trim();
    // Skip common English words that happen to be at start of sentence
    if (STOP_WORDS.has(word.toLowerCase())) continue;
    if (word.length >= 2) candidates.push(word);
  }

  // 3. CamelCase / PascalCase compound words: "RecallNest", "LanceDB"
  const camelPattern = /\b([A-Z][a-z]+(?:[A-Z][a-z]*)+)\b/g;
  while ((match = camelPattern.exec(query)) !== null) {
    candidates.push(match[1]);
  }

  return candidates;
}

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been",
  "do", "does", "did", "have", "has", "had", "will", "would",
  "can", "could", "should", "may", "might", "must", "shall",
  "what", "who", "where", "when", "why", "how", "which",
  "this", "that", "these", "those", "it", "its",
  "not", "no", "nor", "but", "and", "or", "if", "then",
  "use", "uses", "used", "using",
  "important", "search", "find", "get", "set", "let", "new",
  "all", "any", "some", "each", "every", "many", "much",
  "my", "your", "his", "her", "our", "their",
  "i", "you", "he", "she", "we", "they", "me", "him", "us", "them",
]);

// ============================================================================
// Main detection
// ============================================================================

/**
 * Detect entities in a query for KG graph traversal.
 * Optionally validates against KG-known entities.
 */
export async function detectEntities(
  query: string,
  kgStore?: KGStore,
  scope?: string,
): Promise<DetectedEntities> {
  // Check for multi-hop signals
  let isMultiHop = false;
  let hopPredicate: string | undefined;

  for (const hp of MULTI_HOP_PATTERNS) {
    if (hp.pattern.test(query)) {
      isMultiHop = true;
      hopPredicate = hp.predicate;
      break;
    }
  }

  // Extract candidates
  const raw = extractCandidates(query);

  // Normalize
  const normalized = raw
    .map(normalizeEntity)
    .filter(e => e.length >= 2);

  // Deduplicate (case-insensitive)
  const seen = new Set<string>();
  const unique = normalized.filter(e => {
    const key = e.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // If KG store available, validate entities exist in KG
  if (kgStore && unique.length > 0) {
    const validated: string[] = [];
    const kgEntities = await kgStore.getAllEntities(scope);
    const kgEntitySet = new Set(kgEntities.map(e => e.toLowerCase()));

    for (const entity of unique) {
      if (kgEntitySet.has(entity.toLowerCase())) {
        // Find the KG-canonical casing
        const canonical = kgEntities.find(e => e.toLowerCase() === entity.toLowerCase());
        validated.push(canonical ?? entity);
      }
    }

    // If validation eliminated everything, fall back to heuristic candidates
    if (validated.length === 0 && unique.length > 0) {
      return { entities: unique, isMultiHop, hopPredicate };
    }

    return { entities: validated, isMultiHop, hopPredicate };
  }

  return { entities: unique, isMultiHop, hopPredicate };
}

/**
 * Synchronous version without KG validation — for testing or lightweight use.
 */
export function detectEntitiesSync(query: string): DetectedEntities {
  let isMultiHop = false;
  let hopPredicate: string | undefined;

  for (const hp of MULTI_HOP_PATTERNS) {
    if (hp.pattern.test(query)) {
      isMultiHop = true;
      hopPredicate = hp.predicate;
      break;
    }
  }

  const raw = extractCandidates(query);
  const normalized = raw.map(normalizeEntity).filter(e => e.length >= 2);

  const seen = new Set<string>();
  const unique = normalized.filter(e => {
    const key = e.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { entities: unique, isMultiHop, hopPredicate };
}
