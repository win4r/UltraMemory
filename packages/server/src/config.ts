/**
 * UltraMemory configuration — shared between CLI, MCP, and REST.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface EmbeddingConfig {
  apiKey: string | string[];
  model?: string;
  baseURL?: string;
  dimensions?: number;
  omitDimensions?: boolean;
  taskQuery?: string;
  taskPassage?: string;
  normalized?: boolean;
  chunking?: boolean;
}

export interface LlmConfig {
  auth?: "api-key" | "oauth";
  apiKey?: string;
  model?: string;
  baseURL?: string;
  oauthProvider?: string;
  oauthPath?: string;
  timeoutMs?: number;
}

export interface RetrievalConfig {
  mode?: "hybrid" | "vector";
  vectorWeight?: number;
  bm25Weight?: number;
  minScore?: number;
  rerank?: "cross-encoder" | "lightweight" | "none";
  candidatePoolSize?: number;
  rerankApiKey?: string;
  rerankModel?: string;
  rerankEndpoint?: string;
  rerankProvider?: "jina" | "siliconflow" | "voyage" | "pinecone" | "dashscope" | "tei";
  recencyHalfLifeDays?: number;
  recencyWeight?: number;
  filterNoise?: boolean;
  lengthNormAnchor?: number;
  hardMinScore?: number;
  timeDecayHalfLifeDays?: number;
  reinforcementFactor?: number;
  maxHalfLifeMultiplier?: number;
}

export interface DecayConfig {
  enabled?: boolean;
  recencyHalfLifeDays?: number;
  recencyWeight?: number;
  frequencyWeight?: number;
  intrinsicWeight?: number;
  staleThreshold?: number;
  searchBoostMin?: number;
  importanceModulation?: number;
}

export interface TierConfig {
  coreAccessThreshold?: number;
  coreCompositeThreshold?: number;
  coreImportanceThreshold?: number;
  peripheralCompositeThreshold?: number;
  peripheralAgeDays?: number;
  workingAccessThreshold?: number;
  workingCompositeThreshold?: number;
}

export interface ScopeConfig {
  default?: string;
  definitions?: Record<string, { description: string }>;
  agentAccess?: Record<string, string[]>;
}

export interface UltraMemoryConfig {
  dbPath: string;
  embedding: EmbeddingConfig;
  llm?: LlmConfig;
  retrieval?: RetrievalConfig;
  decay?: DecayConfig;
  tier?: TierConfig;
  scopes?: ScopeConfig;
  smartExtraction?: boolean;
}

const DEFAULT_DB_PATH = join(homedir(), ".ultramemory", "db");

export function resolveConfig(
  partial: Partial<UltraMemoryConfig> & { embedding: EmbeddingConfig },
): UltraMemoryConfig {
  return {
    dbPath: partial.dbPath || DEFAULT_DB_PATH,
    embedding: {
      apiKey: partial.embedding.apiKey,
      model: partial.embedding.model || "text-embedding-3-small",
      baseURL: partial.embedding.baseURL || "https://api.openai.com/v1",
      dimensions: partial.embedding.dimensions,
      omitDimensions: partial.embedding.omitDimensions,
      taskQuery: partial.embedding.taskQuery,
      taskPassage: partial.embedding.taskPassage,
      normalized: partial.embedding.normalized,
      chunking: partial.embedding.chunking,
    },
    llm: partial.llm,
    retrieval: partial.retrieval,
    decay: partial.decay,
    tier: partial.tier,
    scopes: partial.scopes,
    smartExtraction: partial.smartExtraction ?? true,
  };
}

export async function loadConfigFile(
  path?: string,
): Promise<Partial<UltraMemoryConfig>> {
  const configPath =
    path || join(homedir(), ".ultramemory", "config.json");
  try {
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
