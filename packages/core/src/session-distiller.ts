/**
 * Session Distiller — three-layer session distillation system
 *
 * Compresses conversation context and extracts durable knowledge.
 *
 * Layer 1: Microcompact (zero cost, pure rules — clear old tool results)
 * Layer 2: LLM structured summary (9 dimensions)
 * Layer 3: Memory persistence (extract knowledge → IngestionPipeline)
 *
 * Ported from RecallNest session-distiller, adapted for UltraMemory:
 * - Uses LlmClient.completeJson() (not chatRaw)
 * - Uses IngestionPipeline for persistence (not persistMemory)
 * - Uses MemoryCategory (profile/preferences/entities/events/cases/patterns)
 */

import type { LlmClient } from "./llm-client.js";
import type { MemoryCategory } from "./memory-categories.js";
import type { IngestionPipeline, IngestionInput } from "./ingestion-pipeline.js";

// ============================================================================
// Types
// ============================================================================

export interface ConversationMessage {
  role: "user" | "assistant" | "system";
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result";
  /** tool_use / tool_result: tool name */
  name?: string;
  /** tool_use: tool call ID */
  id?: string;
  /** tool_use: input params */
  input?: Record<string, unknown>;
  /** tool_result: the result content */
  content?: string;
  /** text block content */
  text?: string;
  /** tool_result: the tool_use_id this result corresponds to */
  tool_use_id?: string;
}

export interface MicrocompactResult {
  messages: ConversationMessage[];
  tokensFreed: number;
  toolsCleared: number;
}

export interface SummaryDimensions {
  userIntent: string;
  keyConcepts: string;
  filesAndCode: string;
  errorsAndFixes: string;
  problemSolving: string;
  userQuotes: string;
  pendingTasks: string;
  currentWork: string;
  suggestedNext: string;
}

export interface SummarizeResult {
  text: string;
  dimensions: SummaryDimensions;
}

export interface PersistResult {
  memoriesStored: number;
  memoriesDuplicated: number;
  memoriesFiltered: number;
  ids: string[];
}

export interface DistillSessionResult {
  microcompact: {
    tokensFreed: number;
    toolsCleared: number;
  };
  summary: SummarizeResult | null;
  persisted: PersistResult | null;
  compactedMessages: ConversationMessage[];
}

// ============================================================================
// Constants
// ============================================================================

/** Tools whose old results can be safely cleared */
const COMPACTABLE_TOOLS = new Set([
  "Read",
  "read_file",
  "Bash",
  "bash",
  "Grep",
  "grep",
  "Glob",
  "glob",
  "WebSearch",
  "web_search",
  "WebFetch",
  "web_fetch",
  "Edit",
  "edit_file",
  "Write",
  "write_file",
]);

const CLEARED_MARKER = "[Cleared]";

const DEFAULT_KEEP_RECENT_TOOLS = 5;
const DEFAULT_PRESERVE_RECENT = 6;

// ============================================================================
// Layer 1: Microcompact (zero cost, pure rules)
// ============================================================================

/** Estimate tokens from text: ~1 token per 4 chars, conservative. */
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Extract text content from a message (handles both string and ContentBlock[]).
 */
function getMessageText(msg: ConversationMessage): string {
  if (typeof msg.content === "string") return msg.content;
  return msg.content
    .map((b) => b.text || b.content || "")
    .filter(Boolean)
    .join("\n");
}

/**
 * Collect all tool_use block IDs from compactable tools in message order.
 */
function collectCompactableToolUseIds(
  messages: ConversationMessage[],
): string[] {
  const ids: string[] = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (
        block.type === "tool_use" &&
        block.id &&
        block.name &&
        COMPACTABLE_TOOLS.has(block.name)
      ) {
        ids.push(block.id);
      }
    }
  }
  return ids;
}

/**
 * Layer 1: Microcompact — clear old tool results, keep recent N.
 *
 * Pure function. Returns a deep copy with cleared results + stats.
 * Does NOT call LLM.
 */
export function microcompact(
  messages: ConversationMessage[],
  keepRecent = DEFAULT_KEEP_RECENT_TOOLS,
): MicrocompactResult {
  const toolUseIds = collectCompactableToolUseIds(messages);

  // Keep the most recent N tool results
  // Note: slice(-0) === slice(0) in JS, so handle keepRecent=0 explicitly
  const keepSet = new Set(
    keepRecent > 0 ? toolUseIds.slice(-keepRecent) : [],
  );

  let tokensFreed = 0;
  let toolsCleared = 0;

  // Deep copy + clear old results
  const result: ConversationMessage[] = messages.map((msg) => {
    if (typeof msg.content === "string") {
      return { ...msg };
    }
    const newContent: ContentBlock[] = msg.content.map((block) => {
      if (
        block.type === "tool_result" &&
        block.tool_use_id &&
        !keepSet.has(block.tool_use_id) &&
        block.content
      ) {
        // Check if this tool_use_id belongs to a compactable tool
        const isCompactable = toolUseIds.includes(block.tool_use_id);
        if (isCompactable) {
          const freed = estimateTokens(block.content);
          tokensFreed += freed;
          toolsCleared++;
          return {
            ...block,
            content: CLEARED_MARKER,
          };
        }
      }
      return { ...block };
    });
    return { ...msg, content: newContent };
  });

  return { messages: result, tokensFreed, toolsCleared };
}

// ============================================================================
// Layer 2: LLM Structured Summary (9 dimensions)
// ============================================================================

/**
 * Build the extraction prompt for LLM summarization.
 * Instructs the LLM to return JSON with 9 dimension fields.
 */
function buildSummarizePrompt(conversationText: string): string {
  return `You are a session distillation assistant. Compress the following conversation into a structured summary with exactly 9 dimensions.

Return valid JSON only, with these exact keys:
{
  "userIntent": "All explicit user requests, listed completely",
  "keyConcepts": "Technical concepts, frameworks, patterns, terminology discussed",
  "filesAndCode": "Each file viewed or modified, with line numbers and key code snippets",
  "errorsAndFixes": "Each error encountered, its cause, and solution",
  "problemSolving": "Methods attempted, which succeeded/failed, and why",
  "userQuotes": "Non-instruction user statements (preferences, opinions, style requests) — preserve verbatim",
  "pendingTasks": "Explicitly requested but not yet completed work",
  "currentWork": "Detailed status of work in progress at distillation time",
  "suggestedNext": "Most reasonable next steps based on context"
}

Rules:
- If a dimension has no relevant content, use "none"
- Preserve file paths, URLs, port numbers, API names verbatim
- Be concise but complete — don't omit key information
- Output valid JSON only, no markdown fences, no explanation

Conversation:
${conversationText}`;
}

/**
 * Parse LLM JSON response into SummaryDimensions.
 * Falls back to empty strings for missing fields.
 */
function parseDimensionsFromJson(
  raw: Record<string, unknown>,
): SummaryDimensions {
  const str = (key: string): string => {
    const val = raw[key];
    return typeof val === "string" ? val : "";
  };
  return {
    userIntent: str("userIntent"),
    keyConcepts: str("keyConcepts"),
    filesAndCode: str("filesAndCode"),
    errorsAndFixes: str("errorsAndFixes"),
    problemSolving: str("problemSolving"),
    userQuotes: str("userQuotes"),
    pendingTasks: str("pendingTasks"),
    currentWork: str("currentWork"),
    suggestedNext: str("suggestedNext"),
  };
}

/**
 * Build a flat text from messages for LLM input.
 */
function flattenMessages(messages: ConversationMessage[]): string {
  return messages
    .map((msg) => {
      const text = getMessageText(msg);
      return `[${msg.role}]: ${text}`;
    })
    .join("\n\n");
}

/**
 * Format dimensions into a readable summary text.
 */
function formatDimensionsText(dims: SummaryDimensions): string {
  const sections: [string, string][] = [
    ["User Intent", dims.userIntent],
    ["Key Concepts", dims.keyConcepts],
    ["Files & Code", dims.filesAndCode],
    ["Errors & Fixes", dims.errorsAndFixes],
    ["Problem Solving", dims.problemSolving],
    ["User Quotes", dims.userQuotes],
    ["Pending Tasks", dims.pendingTasks],
    ["Current Work", dims.currentWork],
    ["Suggested Next", dims.suggestedNext],
  ];
  return sections
    .filter(([, content]) => content && content !== "none")
    .map(([heading, content]) => `## ${heading}\n${content}`)
    .join("\n\n");
}

/**
 * Layer 2: Summarize session via LLM into 9 structured dimensions.
 *
 * Uses LlmClient.completeJson() since UltraMemory's LlmClient doesn't
 * have a chatRaw method. Returns null if LLM is unavailable or fails.
 */
export async function summarizeSession(
  messages: ConversationMessage[],
  llm: LlmClient,
  preserveRecent = DEFAULT_PRESERVE_RECENT,
): Promise<{
  summary: SummarizeResult;
  compactedMessages: ConversationMessage[];
} | null> {
  if (messages.length <= preserveRecent) {
    // Nothing old enough to summarize
    return null;
  }

  const older = messages.slice(0, -preserveRecent);
  const newer = messages.slice(-preserveRecent);

  const conversationText = flattenMessages(older);
  if (!conversationText.trim()) return null;

  const prompt = buildSummarizePrompt(conversationText);

  // Use completeJson — UltraMemory's LlmClient parses JSON automatically
  const rawJson = await llm.completeJson<Record<string, unknown>>(
    prompt,
    "session-distill",
  );
  if (!rawJson) return null;

  const dimensions = parseDimensionsFromJson(rawJson);
  const text = formatDimensionsText(dimensions);
  const summary: SummarizeResult = { text, dimensions };

  // Build compacted messages: [summary as synthetic user msg] + [recent preserved]
  const summaryMsg: ConversationMessage = {
    role: "user",
    content:
      "This session continues from a previous conversation. The following summary covers the earlier portion.\n\n" +
      text +
      "\n\nRecent messages have been preserved as-is." +
      "\nPlease continue from where we left off — do not ask further questions. Resume directly without confirming the summary or restating prior content.",
  };

  return {
    summary,
    compactedMessages: [summaryMsg, ...newer],
  };
}

// ============================================================================
// Layer 3: Memory Persistence (UltraMemory IngestionPipeline)
// ============================================================================

interface DimensionMapping {
  dimension: keyof SummaryDimensions;
  category: MemoryCategory;
  importance: number;
  /** Skip if content matches this */
  skipIfEmpty: string;
}

const DIMENSION_MAPPINGS: DimensionMapping[] = [
  {
    dimension: "userIntent",
    category: "events",
    importance: 0.5,
    skipIfEmpty: "none",
  },
  {
    dimension: "errorsAndFixes",
    category: "cases",
    importance: 0.7,
    skipIfEmpty: "none",
  },
  {
    dimension: "problemSolving",
    category: "patterns",
    importance: 0.8,
    skipIfEmpty: "none",
  },
  {
    dimension: "userQuotes",
    category: "preferences",
    importance: 0.7,
    skipIfEmpty: "none",
  },
  {
    dimension: "filesAndCode",
    category: "entities",
    importance: 0.6,
    skipIfEmpty: "none",
  },
];

/** Min content length to bother persisting (skip trivial extractions). */
const MIN_PERSIST_LENGTH = 20;

/**
 * Layer 3: Extract knowledge from structured summary and persist via IngestionPipeline.
 *
 * Uses UltraMemory's IngestionPipeline which handles dedup, conflict detection,
 * metadata building, and multi-layer vectors.
 */
export async function extractAndPersist(
  dimensions: SummaryDimensions,
  scope: string,
  pipeline: IngestionPipeline,
): Promise<PersistResult> {
  const result: PersistResult = {
    memoriesStored: 0,
    memoriesDuplicated: 0,
    memoriesFiltered: 0,
    ids: [],
  };

  for (const mapping of DIMENSION_MAPPINGS) {
    const content = dimensions[mapping.dimension];
    if (
      !content ||
      content.trim() === mapping.skipIfEmpty ||
      content.trim().length < MIN_PERSIST_LENGTH
    ) {
      continue;
    }

    try {
      const input: IngestionInput = {
        text: content.slice(0, 4000), // Respect reasonable text limits
        category: mapping.category,
        importance: mapping.importance,
        scope,
        source: "session-summary",
      };

      const ingested = await pipeline.ingest(input);

      switch (ingested.action) {
        case "created":
        case "superseded":
          result.memoriesStored++;
          result.ids.push(ingested.id);
          break;
        case "duplicate":
          result.memoriesDuplicated++;
          break;
        case "noise_filtered":
        case "conflict_detected":
          result.memoriesFiltered++;
          break;
      }
    } catch {
      // Non-fatal: skip this dimension on error
      result.memoriesFiltered++;
    }
  }

  return result;
}

// ============================================================================
// Orchestrator: distillSession (combines all 3 layers)
// ============================================================================

export interface DistillSessionInput {
  messages: ConversationMessage[];
  scope: string;
  preserveRecent?: number;
  keepRecentTools?: number;
  persist?: boolean;
}

export interface DistillSessionDeps {
  llm: LlmClient | null;
  pipeline: IngestionPipeline | null;
}

/**
 * Full session distillation: microcompact -> LLM summary -> persist to UltraMemory.
 *
 * All three layers are optional and degrade gracefully:
 * - No LLM? Layer 1 only (still saves tokens by clearing tool results).
 * - No pipeline? Layers 1+2 (summary without persistence).
 * - persist=false? Same as no pipeline.
 */
export async function distillSession(
  input: DistillSessionInput,
  deps: DistillSessionDeps,
): Promise<DistillSessionResult> {
  const preserveRecent = input.preserveRecent ?? DEFAULT_PRESERVE_RECENT;
  const keepRecentTools = input.keepRecentTools ?? DEFAULT_KEEP_RECENT_TOOLS;
  const shouldPersist = input.persist !== false;

  // Layer 1: Microcompact
  const mc = microcompact(input.messages, keepRecentTools);

  // Layer 2: LLM summary (if LLM available)
  let summaryResult: {
    summary: SummarizeResult;
    compactedMessages: ConversationMessage[];
  } | null = null;
  if (deps.llm) {
    summaryResult = await summarizeSession(
      mc.messages,
      deps.llm,
      preserveRecent,
    );
  }

  // Layer 3: Persist (if summary succeeded and persist enabled)
  let persistResult: PersistResult | null = null;
  if (shouldPersist && summaryResult && deps.pipeline) {
    persistResult = await extractAndPersist(
      summaryResult.summary.dimensions,
      input.scope,
      deps.pipeline,
    );
  }

  return {
    microcompact: {
      tokensFreed: mc.tokensFreed,
      toolsCleared: mc.toolsCleared,
    },
    summary: summaryResult?.summary ?? null,
    persisted: persistResult,
    compactedMessages: summaryResult?.compactedMessages ?? mc.messages,
  };
}

// ============================================================================
// Exported helpers (for testing)
// ============================================================================

export {
  estimateTokens as _estimateTokens,
  getMessageText as _getMessageText,
  flattenMessages as _flattenMessages,
  parseDimensionsFromJson as _parseDimensionsFromJson,
  formatDimensionsText as _formatDimensionsText,
  COMPACTABLE_TOOLS as _COMPACTABLE_TOOLS,
  DIMENSION_MAPPINGS as _DIMENSION_MAPPINGS,
  CLEARED_MARKER as _CLEARED_MARKER,
};
