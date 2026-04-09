/**
 * Language Hook — optional babel-memory integration for multilingual support.
 *
 * Auto-detects `babel-memory` at startup. When available, provides:
 * - Language detection (8 script systems: zh/ja/ko/th/ar/hi/ru/en)
 * - BM25 pre-tokenization for 27+ languages (CJK segmentation, stemming)
 * - Language-aware KG extraction prompts (EN/CJK)
 * - Language-aware session summary prompts (EN/CJK)
 *
 * When babel-memory is not installed, all functions gracefully degrade:
 * - detectLanguage() returns "en"
 * - tokenizeForFts() returns text as-is
 * - KG/session prompts return null (callers use their built-in defaults)
 *
 * @see https://github.com/AliceLJY/babel-memory
 */

// ============================================================================
// Types (mirrored from babel-memory to avoid hard dependency)
// ============================================================================

export type Language = "zh" | "ja" | "ko" | "th" | "ar" | "hi" | "ru" | "en";

export interface KgPrompt {
  system: string;
  userTemplate: string;
}

export interface SessionPrompt {
  system: string;
  dimensionLabels: Record<string, string>;
}

// ============================================================================
// Internal state
// ============================================================================

interface BabelMemoryModule {
  detectLanguage: (text: string) => Language;
  tokenizeForFts: (text: string, language: Language | string) => string;
  initTokenizer: () => Promise<void>;
  getKgPrompt: (lang: string) => KgPrompt;
  getSessionPrompt: (lang: string) => SessionPrompt;
}

let babelMemory: BabelMemoryModule | null = null;
let initAttempted = false;
let initPromise: Promise<void> | null = null;

// ============================================================================
// Initialization
// ============================================================================

/**
 * Attempt to load babel-memory. Safe to call multiple times (idempotent).
 * Non-fatal: logs a debug message if not available and continues.
 */
async function ensureInit(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const mod = await import("babel-memory");
      babelMemory = mod;
      // Initialize tokenizers in parallel (non-blocking, best-effort)
      await mod.initTokenizer();
      console.error("[UltraMemory] babel-memory loaded — multilingual FTS enabled");
    } catch {
      // babel-memory not installed — this is expected and fine
      babelMemory = null;
    } finally {
      initAttempted = true;
    }
  })();

  return initPromise;
}

// Kick off initialization immediately on module load (non-blocking)
ensureInit().catch(() => {});

// ============================================================================
// Public API
// ============================================================================

/**
 * Wait for babel-memory initialization to complete.
 * Useful for tests or startup sequences that need to guarantee readiness.
 */
export async function ensureReady(): Promise<void> {
  await ensureInit();
}

/**
 * Whether babel-memory is available and loaded.
 */
export function hasBabelMemory(): boolean {
  return babelMemory !== null;
}

/**
 * Detect the language of a text string.
 * Returns "en" if babel-memory is not available.
 */
export function detectLanguage(text: string): Language {
  if (!babelMemory) return "en";
  return babelMemory.detectLanguage(text);
}

/**
 * Pre-tokenize text for BM25 full-text search.
 *
 * For CJK languages, this segments text into words (e.g., jieba for Chinese,
 * kuromoji for Japanese) so BM25 matching works properly.
 * For European languages, applies stemming via Snowball.
 * Returns text as-is if babel-memory is not available.
 */
export function tokenizeForFts(text: string, language?: Language | string): string {
  if (!babelMemory || !text) return text;
  const lang = language ?? babelMemory.detectLanguage(text);
  return babelMemory.tokenizeForFts(text, lang);
}

/**
 * Get language-aware KG extraction prompt.
 * Returns null if babel-memory is not available (caller should use built-in default).
 */
export function getLocalizedKgPrompt(text: string): KgPrompt | null {
  if (!babelMemory) return null;
  const lang = babelMemory.detectLanguage(text);
  return babelMemory.getKgPrompt(lang);
}

/**
 * Get language-aware session summary prompt.
 * Returns null if babel-memory is not available (caller should use built-in default).
 */
export function getLocalizedSessionPrompt(text: string): SessionPrompt | null {
  if (!babelMemory) return null;
  const lang = babelMemory.detectLanguage(text);
  return babelMemory.getSessionPrompt(lang);
}

/**
 * Pre-tokenize a BM25 query string.
 * Detects language automatically and tokenizes for better CJK recall.
 */
export function tokenizeQuery(query: string): string {
  if (!babelMemory || !query) return query;
  const lang = babelMemory.detectLanguage(query);
  // Only tokenize non-English queries (English passthrough is already fine)
  if (lang === "en") return query;
  return babelMemory.tokenizeForFts(query, lang);
}
