export type RenderMode = "verbatim" | "highlight" | "synthesize";

export interface RenderableMemory {
  id: string;
  text: string;
  score: number;
  category: string;
}

export interface RenderedMemory {
  id: string;
  text: string;
  relevance: number;    // 0-1, how relevant to current query
}

export interface RenderResult {
  mode: RenderMode;
  memories: RenderedMemory[];
}

/**
 * Render recalled memories adapted to the current context.
 *
 * - verbatim: return as-is (current behavior)
 * - highlight: reorder by relevance to query, annotate with relevance score
 * - synthesize: requires LLM (not implemented in P1, falls back to highlight)
 */
export function renderMemories(
  memories: RenderableMemory[],
  query: string,
  mode: RenderMode = "verbatim",
  taskContext?: string,
): RenderResult {
  if (mode === "verbatim" || memories.length === 0) {
    return {
      mode: "verbatim",
      memories: memories.map(m => ({
        id: m.id,
        text: m.text,
        relevance: m.score,
      })),
    };
  }

  if (mode === "synthesize") {
    // Synthesize requires LLM — fall back to highlight for now
    mode = "highlight";
  }

  // Highlight mode: reorder by contextual relevance
  const queryTerms = extractTerms(query + (taskContext ? " " + taskContext : ""));

  const scored = memories.map(m => {
    const memTerms = extractTerms(m.text);
    const overlap = computeTermOverlap(queryTerms, memTerms);
    // Combine vector score (from retrieval) with term overlap for contextual relevance
    const relevance = 0.6 * m.score + 0.4 * overlap;
    return { ...m, relevance };
  });

  // Sort by contextual relevance (highest first)
  scored.sort((a, b) => b.relevance - a.relevance);

  return {
    mode: "highlight",
    memories: scored.map(m => ({
      id: m.id,
      text: m.text,
      relevance: Math.round(m.relevance * 1000) / 1000,
    })),
  };
}

/** Extract significant terms from text (lowercase, deduped, stop words removed) */
function extractTerms(text: string): Set<string> {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "to", "of", "in",
    "for", "on", "with", "at", "by", "from", "as", "into", "through",
    "during", "before", "after", "about", "between", "under", "above",
    "this", "that", "these", "those", "it", "its", "i", "me", "my",
    "we", "our", "you", "your", "he", "she", "they", "them", "and",
    "or", "but", "if", "then", "so", "not", "no", "just", "also",
  ]);
  const words = text.toLowerCase().replace(/[^\w\s\u4e00-\u9fff]/g, " ").split(/\s+/);
  return new Set(words.filter(w => w.length > 2 && !stopWords.has(w)));
}

/** Compute Jaccard-like overlap between two term sets */
function computeTermOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const term of a) {
    if (b.has(term)) overlap++;
  }
  return overlap / Math.max(a.size, b.size);
}
