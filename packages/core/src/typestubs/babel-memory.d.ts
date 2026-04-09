/**
 * Minimal type stub for babel-memory (optional dependency).
 * Full types are provided at runtime when babel-memory is installed.
 * @see https://github.com/AliceLJY/babel-memory
 */
declare module "babel-memory" {
  export type Language = "zh" | "ja" | "ko" | "th" | "ar" | "hi" | "ru" | "en";

  export interface KgPrompt {
    system: string;
    userTemplate: string;
  }

  export interface SessionPrompt {
    system: string;
    dimensionLabels: Record<string, string>;
  }

  export function detectLanguage(text: string): Language;
  export function tokenizeForFts(text: string, language: Language | string): string;
  export function initTokenizer(): Promise<void>;
  export function getKgPrompt(lang: string): KgPrompt;
  export function getSessionPrompt(lang: string): SessionPrompt;
}
