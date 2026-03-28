/**
 * Auto-Capture — lightweight salience filter + heuristic extraction coordinator.
 *
 * Provides a standalone extraction pathway that does NOT depend on SmartExtractor
 * (which is tightly coupled to OpenClaw). Instead, it uses pattern-based heuristics
 * to identify memory-worthy items from conversation text.
 *
 * Designed to be called via the MCP `memory_auto_capture` tool so any agent
 * (not just OpenClaw) can extract and store memories from conversation turns.
 *
 * Persistence is the caller's responsibility (via IngestionPipeline).
 */

import { isNoise } from "./noise-filter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutoCaptureItem {
  text: string;
  category: string;
  importance: number;
  sourceContext: string;
}

export interface AutoCaptureResult {
  skippedSalience: boolean;
  items: AutoCaptureItem[];
}

// ---------------------------------------------------------------------------
// Salience pre-filter
// ---------------------------------------------------------------------------

/** Max items extracted per turn to avoid flooding the store. */
const MAX_ITEMS_PER_TURN = 5;

/** Minimum text length worth analyzing (below this is almost always noise). */
const MIN_TEXT_LENGTH = 20;

/** Greetings / affirmations / single-word responses (EN + ZH). */
const GREETING_RE =
  /^(hi|hello|hey|thanks|ok|yes|no|sure|got it|好的|谢谢|嗯|是的)[\s!.]*$/i;

/**
 * Heuristic salience check — should this conversation turn be analyzed for
 * memory extraction?
 */
export function shouldCapture(text: string): boolean {
  if (!text || text.trim().length < MIN_TEXT_LENGTH) return false;
  if (isNoise(text)) return false;
  // Skip greetings, affirmations, single-word responses
  const lower = text.trim().toLowerCase();
  if (GREETING_RE.test(lower)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Heuristic extraction patterns
// ---------------------------------------------------------------------------

interface SignalPattern {
  re: RegExp;
  category: string;
  importance: number;
  sourceContext: string;
}

const SIGNAL_PATTERNS: SignalPattern[] = [
  // Preference signals (\b doesn't work around CJK, so CJK terms are separate alternations)
  {
    re: /(?:\b(?:i prefer|i like|i don't like|i hate|i love|i want|i need)\b|我喜欢|我不喜欢|我偏好|我想要)/i,
    category: "preferences",
    importance: 0.8,
    sourceContext: "preference signal",
  },
  // Identity signals
  {
    re: /(?:\b(?:my name is|i am a|i'm a|i work at|i live in)\b|我叫|我是|我在)/i,
    category: "profile",
    importance: 0.9,
    sourceContext: "identity signal",
  },
  // Decision signals
  {
    re: /(?:\b(?:i decided|we decided|let's go with|the decision is)\b|决定了|我们选择)/i,
    category: "events",
    importance: 0.7,
    sourceContext: "decision signal",
  },
  // Correction signals (high value — user explicitly correcting agent)
  {
    re: /(?:\b(?:actually|no,? not|that's wrong|correction:)\b|更正|其实不是|不对)/i,
    category: "cases",
    importance: 0.85,
    sourceContext: "correction signal",
  },
];

/**
 * Extract memory-worthy items from conversation text using simple heuristics.
 *
 * This is a lightweight alternative to SmartExtractor's LLM-based extraction.
 * Returns items that should be stored via IngestionPipeline.
 */
export function extractHeuristic(text: string): AutoCaptureItem[] {
  const items: AutoCaptureItem[] = [];
  const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(text);
  const minSentenceLen = hasCJK ? 6 : 15;
  const sentences = text
    .split(/[.!?。！？\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > minSentenceLen);

  for (const sentence of sentences) {
    for (const pattern of SIGNAL_PATTERNS) {
      if (pattern.re.test(sentence)) {
        items.push({
          text: sentence,
          category: pattern.category,
          importance: pattern.importance,
          sourceContext: pattern.sourceContext,
        });
        break; // first matching pattern wins for this sentence
      }
    }

    if (items.length >= MAX_ITEMS_PER_TURN) break;
  }

  return items.slice(0, MAX_ITEMS_PER_TURN);
}
