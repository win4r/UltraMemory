/**
 * @ultramemory/core — Universal AI Agent Long-Term Memory Engine
 *
 * Re-exports all core modules. Consumer packages (@ultramemory/server,
 * @ultramemory/openclaw) import from here instead of reaching into
 * individual files.
 */

// Storage
export * from "./store.js";

// Embedding
export * from "./embedder.js";

// Retrieval
export * from "./retriever.js";

// Scopes
export * from "./scopes.js";

// Migration & upgrading
export * from "./migrate.js";
export * from "./memory-upgrader.js";

// Smart extraction
export * from "./smart-extractor.js";
export * from "./extraction-prompts.js";

// Smart metadata
export * from "./smart-metadata.js";

// Decay & tier management
export * from "./decay-engine.js";
export * from "./tier-manager.js";

// Cascade forget
export * from "./cascade-forget.js";

// Memory categories
export * from "./memory-categories.js";

// Category migration
export { migrateCategoryForEntry, batchMigrateCategories } from "./category-migrator.js";

// Noise filtering
export * from "./noise-filter.js";
export * from "./noise-prototypes.js";
export * from "./auto-capture-cleanup.js";

// Auto-capture (heuristic extraction for MCP)
export { shouldCapture, extractHeuristic, type AutoCaptureItem, type AutoCaptureResult } from "./auto-capture.js";

// Chunking
export * from "./chunker.js";

// LLM client
export * from "./llm-client.js";
export * from "./llm-oauth.js";

// Admission control
export * from "./admission-control.js";
export * from "./admission-stats.js";

// Knowledge Graph (Tier 4.1/4.2)
export * from "./kg-store.js";
export * from "./kg-extractor.js";
export * from "./ppr-traversal.js";
export * from "./query-entity-detector.js";

// Access tracking
export * from "./access-tracker.js";

// Adaptive retrieval
export * from "./adaptive-retrieval.js";

// Reflection system
export * from "./reflection-store.js";
// reflection-slices re-declares ReflectionMappedKind (canonical in reflection-mapped-metadata)
export {
  type ReflectionSlices,
  type ReflectionMappedMemory,
  // ReflectionMappedKind intentionally omitted — use reflection-mapped-metadata
  type ReflectionMappedMemoryItem,
  type ReflectionSliceItem,
  type ReflectionGovernanceEntry,
  extractSectionMarkdown,
  parseSectionBullets,
  isPlaceholderReflectionSliceLine,
  normalizeReflectionSliceLine,
  sanitizeReflectionSliceLines,
  isUnsafeInjectableReflectionLine,
  sanitizeInjectableReflectionLines,
  extractReflectionLessons,
  extractReflectionLearningGovernanceCandidates,
  extractReflectionMappedMemories,
  extractReflectionMappedMemoryItems,
  extractInjectableReflectionMappedMemoryItems,
  extractInjectableReflectionMappedMemories,
  extractReflectionSlices,
  extractInjectableReflectionSlices,
  extractReflectionSliceItems,
  extractInjectableReflectionSliceItems,
} from "./reflection-slices.js";
export * from "./reflection-event-store.js";
export * from "./reflection-item-store.js";
export * from "./reflection-mapped-metadata.js";
export * from "./reflection-metadata.js";
export * from "./reflection-ranking.js";
export * from "./reflection-retry.js";

// Session recovery
export * from "./session-recovery.js";

// Identity & preferences
export * from "./identity-addressing.js";
export * from "./preference-slots.js";

// Self-improvement
export * from "./self-improvement-files.js";

// Workspace boundary
export * from "./workspace-boundary.js";

// ClawTeam scopes
export * from "./clawteam-scope.js";

// Feedback learning
export * from "./feedback-learner.js";

// Entity resolution
export * from "./entity-resolver.js";

// Deterministic IDs
export * from "./utils/deterministic-id.js";

// Ingestion pipeline
export { IngestionPipeline, type IngestionInput, type IngestionResult, type IngestionAction } from "./ingestion-pipeline.js";

// Retroactive boost
export { retroactiveBoost, DEFAULT_RETROACTIVE_BOOST_CONFIG, type RetroactiveBoostConfig, type BoostResult } from "./retroactive-boost.js";

// Conflict detection
export { detectFactKeyConflict, detectHeuristicContradiction } from "./conflict-detector.js";

// Consolidation engine
export { ConsolidationEngine, DEFAULT_CONSOLIDATION_CONFIG, type ConsolidationConfig, type ConsolidationResult, type ConflictEvent } from "./consolidation-engine.js";

// Auto-consolidation (dual-threshold trigger)
export { AutoConsolidation, DEFAULT_AUTO_CONSOLIDATION_CONFIG, type AutoConsolidationConfig, type AutoConsolidationResult, type AutoConsolidationSkipReason } from "./auto-consolidation.js";

// Contextual recall rendering
export { renderMemories, type RenderMode, type RenderResult, type RenderedMemory, type RenderableMemory } from "./context-renderer.js";

// Evaluation
export { computeCorpusHealth, type CorpusHealth } from "./eval/corpus-health.js";
export { scoreBenchmarkResult, computeSuiteMetrics, type BenchmarkQuery, type QueryScore, type SuiteMetrics } from "./eval/benchmark.js";

// Tools (registration functions for OpenClaw plugin)
// tools.ts re-declares MEMORY_CATEGORIES — canonical is memory-categories.ts
export {
  type MdMirrorWriter,
  _resetWarnedMissingAgentIdState,
  registerSelfImprovementLogTool,
  registerSelfImprovementExtractSkillTool,
  registerSelfImprovementReviewTool,
  registerMemoryRecallTool,
  registerMemoryStoreTool,
  registerMemoryForgetTool,
  registerMemoryUpdateTool,
  registerMemoryStatsTool,
  registerMemoryListTool,
  registerMemoryPromoteTool,
  registerMemoryArchiveTool,
  registerMemoryCompactTool,
  registerMemoryExplainRankTool,
  registerAllMemoryTools,
  registerEphemeralTools,
  isEphemeral,
} from "./tools.js";
