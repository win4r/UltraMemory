/**
 * OpenClaw adapter — registers UltraMemory tools and lifecycle hooks
 * via the OpenClaw plugin API.
 *
 * P1-3 fix: uses the correct factory-based registerTool() signature.
 * P1-4 fix: ports before_prompt_build (auto-recall), agent_end (auto-capture),
 *           and session cleanup hooks from the original index.ts.
 */

import type {
  MemoryService,
  StoreParams,
  RecallParams,
  UpdateParams,
  ForgetParams,
  ListParams,
} from "@ultramemory/server";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Minimal OpenClaw Plugin API surface
// ---------------------------------------------------------------------------

export interface OpenClawPluginApi {
  registerTool(
    factory: (toolCtx: Record<string, unknown>) => {
      name: string;
      label: string;
      description: string;
      parameters: unknown;
      execute(toolCallId: string, params: unknown): Promise<{
        content: Array<{ type: string; text: string }>;
        details?: Record<string, unknown>;
      }>;
    },
    options?: { name?: string },
  ): void;
  on(
    event: string,
    handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown,
    options?: { name?: string; description?: string; priority?: number },
  ): void;
  registerHook?(
    event: string,
    handler: (event: unknown) => Promise<unknown> | unknown,
    options?: { name?: string; description?: string },
  ): void;
  registerService?(config: { id: string; start: () => Promise<void> }): void;
  pluginConfig: unknown;
  logger: {
    info(msg: string): void;
    warn(msg: string): void;
    debug?(msg: string): void;
    error?(msg: string): void;
  };
  resolvePath(path: string): string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;

function stringEnum(values: string[]) {
  return Type.Union(values.map((v) => Type.Literal(v)));
}

const CATEGORIES = ["preference", "fact", "decision", "entity", "reflection", "other"] as const;

function formatResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data as Record<string, unknown>,
  };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

/** Extract text content from a tool result payload (OpenClaw format). */
function extractToolResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as any).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && (block as any).type === "text") {
        const t = (block as any).text;
        if (typeof t === "string") parts.push(t);
      }
    }
    return parts.join("\n");
  }
  return "";
}

/** Quick heuristic: does the text look like it contains an error? */
function looksLikeError(text: string): boolean {
  if (text.length < 10) return false;
  const lower = text.slice(0, 2000).toLowerCase();
  return (
    lower.includes("error:") ||
    lower.includes("error -") ||
    lower.includes("traceback") ||
    lower.includes("exception") ||
    lower.includes("enoent") ||
    lower.includes("permission denied") ||
    lower.includes("command failed") ||
    lower.includes("fatal:")
  );
}

// ---------------------------------------------------------------------------
// Readiness guard — returns an error result if service is not yet initialized
// ---------------------------------------------------------------------------

const NOT_READY_RESULT = {
  content: [{ type: "text" as const, text: "UltraMemory is still initializing. Please try again in a moment." }],
};

// ---------------------------------------------------------------------------
// Tool registration (P1-3 fix: factory pattern)
// ---------------------------------------------------------------------------

function registerTools(api: OpenClawPluginApi, service: MemoryService): void {
  // memory_store
  api.registerTool(
    (_toolCtx) => ({
      name: "memory_store",
      label: "Memory Store",
      description: "Store a new memory for long-term retention.",
      parameters: Type.Object({
        text: Type.String({ description: "Information to remember" }),
        importance: Type.Optional(Type.Number({ description: "Importance score 0-1 (default: 0.7)" })),
        category: Type.Optional(stringEnum([...CATEGORIES])),
        scope: Type.Optional(Type.String({ description: "Memory scope" })),
      }),
      async execute(_toolCallId, params) {
        if (!service.isReady()) return NOT_READY_RESULT;
        const a = params as Args;
        const result = await service.store({
          text: String(a.text ?? ""),
          category: a.category as string | undefined,
          scope: a.scope as string | undefined,
          importance: a.importance as number | undefined,
        });
        return formatResult(result);
      },
    }),
    { name: "memory_store" },
  );

  // memory_recall
  api.registerTool(
    (_toolCtx) => ({
      name: "memory_recall",
      label: "Memory Recall",
      description:
        "Search through long-term memories using hybrid retrieval (vector + keyword search). " +
        "Use when you need context about user preferences, past decisions, or previously discussed topics.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query for finding relevant memories" }),
        limit: Type.Optional(Type.Number({ description: "Max results (default: 5, max: 20)" })),
        scope: Type.Optional(Type.String({ description: "Filter by scope" })),
        category: Type.Optional(stringEnum([...CATEGORIES])),
      }),
      async execute(_toolCallId, params) {
        if (!service.isReady()) return NOT_READY_RESULT;
        const a = params as Args;
        const results = await service.recall({
          query: String(a.query ?? ""),
          limit: a.limit as number | undefined,
          scopeFilter: a.scope ? [String(a.scope)] : undefined,
          category: a.category as string | undefined,
        });
        const text = results.length === 0
          ? "No relevant memories found."
          : `Found ${results.length} memories:\n` +
            results.map((r, i) => `${i + 1}. [${r.id.slice(0, 8)}] [${r.category}] ${truncate(r.text, 180)}`).join("\n");
        return {
          content: [{ type: "text" as const, text }],
          details: { count: results.length, memories: results, query: a.query },
        };
      },
    }),
    { name: "memory_recall" },
  );

  // memory_update
  api.registerTool(
    (_toolCtx) => ({
      name: "memory_update",
      label: "Memory Update",
      description: "Update an existing memory's text, importance, or category.",
      parameters: Type.Object({
        memoryId: Type.String({ description: "ID of the memory to update" }),
        text: Type.Optional(Type.String({ description: "New text content (triggers re-embedding)" })),
        importance: Type.Optional(Type.Number({ description: "New importance score 0-1" })),
        category: Type.Optional(stringEnum([...CATEGORIES])),
      }),
      async execute(_toolCallId, params) {
        if (!service.isReady()) return NOT_READY_RESULT;
        const a = params as Args;
        const result = await service.update({
          id: String(a.memoryId ?? ""),
          text: a.text as string | undefined,
          importance: a.importance as number | undefined,
          category: a.category as string | undefined,
        });
        return formatResult(result);
      },
    }),
    { name: "memory_update" },
  );

  // memory_forget
  api.registerTool(
    (_toolCtx) => ({
      name: "memory_forget",
      label: "Memory Forget",
      description: "Delete a memory by ID.",
      parameters: Type.Object({
        id: Type.String({ description: "Memory ID to delete" }),
      }),
      async execute(_toolCallId, params) {
        if (!service.isReady()) return NOT_READY_RESULT;
        const a = params as Args;
        const result = await service.forget({ id: String(a.id ?? "") });
        return formatResult(result);
      },
    }),
    { name: "memory_forget" },
  );

  // memory_list
  api.registerTool(
    (_toolCtx) => ({
      name: "memory_list",
      label: "Memory List",
      description: "List stored memories with optional filters.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Max results (default: 20, max: 50)" })),
        offset: Type.Optional(Type.Number({ description: "Skip N entries" })),
        scope: Type.Optional(Type.String({ description: "Filter by scope" })),
        category: Type.Optional(stringEnum([...CATEGORIES])),
      }),
      async execute(_toolCallId, params) {
        if (!service.isReady()) return NOT_READY_RESULT;
        const a = params as Args;
        const entries = await service.list({
          scopeFilter: a.scope ? [String(a.scope)] : undefined,
          category: a.category as string | undefined,
          limit: a.limit as number | undefined,
          offset: a.offset as number | undefined,
        });
        const text = entries.length === 0
          ? "No memories found."
          : `Recent memories (${entries.length}):\n` +
            entries.map((e, i) => `${i + 1}. [${e.id.slice(0, 8)}] [${e.category}] ${truncate(e.text, 100)} (${new Date(e.timestamp).toISOString().slice(0, 10)})`).join("\n");
        return {
          content: [{ type: "text" as const, text }],
          details: { count: entries.length, memories: entries },
        };
      },
    }),
    { name: "memory_list" },
  );

  // memory_stats
  api.registerTool(
    (_toolCtx) => ({
      name: "memory_stats",
      label: "Memory Stats",
      description: "Get memory storage statistics.",
      parameters: Type.Object({
        scope: Type.Optional(Type.String({ description: "Filter by scope" })),
      }),
      async execute(_toolCallId, params) {
        if (!service.isReady()) return NOT_READY_RESULT;
        const a = params as Args;
        const scopeFilter = a.scope ? [String(a.scope)] : undefined;
        const stats = await service.stats(scopeFilter);
        const text = [
          `Memory Statistics:`,
          `  Total memories: ${stats.totalCount}`,
          `  Scopes: ${Object.entries(stats.scopeCounts).map(([s, c]) => `${s}(${c})`).join(", ") || "none"}`,
          `  Categories: ${Object.entries(stats.categoryCounts).map(([c, n]) => `${c}(${n})`).join(", ") || "none"}`,
        ].join("\n");
        return {
          content: [{ type: "text" as const, text }],
          details: { stats },
        };
      },
    }),
    { name: "memory_stats" },
  );
}

// ---------------------------------------------------------------------------
// Hook registration (P1-4 fix: port core hooks from index.ts)
// ---------------------------------------------------------------------------

export interface AdapterConfig {
  autoRecall?: boolean;
  autoRecallMinLength?: number;
  autoRecallMaxItems?: number;
  autoRecallMaxChars?: number;
  autoCapture?: boolean;
  /** Enable self-improvement hooks (agent:bootstrap, command:new/reset notes). Default: false */
  selfImprovement?: boolean;
  /** Enable memory-reflection hooks (error tracking, reflection recall). Default: false */
  memoryReflection?: boolean;
}

function registerHooks(
  api: OpenClawPluginApi,
  service: MemoryService,
  config: AdapterConfig,
): void {

  // ── before_prompt_build: auto-recall ────────────────────────────────────
  if (config.autoRecall !== false) {
    const minLength = config.autoRecallMinLength ?? 15;
    const maxItems = config.autoRecallMaxItems ?? 3;
    const maxChars = config.autoRecallMaxChars ?? 600;

    api.on(
      "before_prompt_build",
      async (event: any, _ctx: any) => {
        try {
          if (!service.isReady()) return {};
          const prompt = typeof event?.prompt === "string" ? event.prompt.trim() : "";
          if (prompt.length < minLength) return {};

          const query = prompt.slice(0, 1000);
          const results = await service.recall({ query, limit: maxItems });

          if (results.length === 0) return {};

          // Build prepend context within budget
          const lines: string[] = [];
          let chars = 0;
          for (const r of results) {
            const line = `- [${r.category}] ${r.text}`;
            if (chars + line.length > maxChars) break;
            lines.push(line);
            chars += line.length;
          }

          if (lines.length === 0) return {};

          const prependContext =
            "<relevant-memories>\n" +
            lines.join("\n") +
            "\n</relevant-memories>";

          api.logger.debug?.(`ultramemory: auto-recall injected ${lines.length} memories`);
          return { prependContext };
        } catch (err) {
          api.logger.warn(`ultramemory: auto-recall failed: ${String(err)}`);
          return {};
        }
      },
      { name: "ultramemory.auto-recall", description: "Inject relevant memories before prompt", priority: 10 },
    );
  }

  // ── agent_end: auto-capture ─────────────────────────────────────────────
  if (config.autoCapture !== false) {
    api.on(
      "agent_end",
      async (event: any, ctx: any) => {
        // Fire-and-forget: don't block agent shutdown
        try {
          if (!service.isReady()) return;
          if (event?.success === false) return;

          const messages = Array.isArray(event?.messages) ? event.messages : [];
          if (messages.length < 2) return;

          // Extract text from messages
          const texts: string[] = [];
          for (const msg of messages) {
            if (!msg || typeof msg !== "object") continue;
            const content = (msg as any).content;
            if (typeof content === "string" && content.trim().length > 0) {
              texts.push(content.trim());
            } else if (Array.isArray(content)) {
              for (const block of content) {
                if (block && typeof block === "object" && (block as any).type === "text") {
                  const t = (block as any).text;
                  if (typeof t === "string" && t.trim().length > 0) {
                    texts.push(t.trim());
                  }
                }
              }
            }
          }

          if (texts.length === 0) return;

          // Store a summary of the conversation as a memory
          const combined = texts.slice(-5).join("\n\n").slice(0, 4000);
          if (combined.length < 50) return;

          await service.store({
            text: combined,
            category: "other",
            importance: 0.5,
          });

          api.logger.debug?.(`ultramemory: auto-captured conversation summary (${combined.length} chars)`);
        } catch (err) {
          api.logger.warn(`ultramemory: auto-capture failed: ${String(err)}`);
        }
      },
      { name: "ultramemory.auto-capture", description: "Auto-capture conversation memories", priority: 10 },
    );
  }

  // ── self-improvement: agent:bootstrap ───────────────────────────────────
  if (config.selfImprovement) {
    const SELF_IMPROVEMENT_REMINDER =
      "## Self-Improvement Reminder\n" +
      "- If you learn something non-obvious, store it with memory_store (category: fact, importance >= 0.8).\n" +
      "- If user corrects you, store the correction immediately.\n" +
      "- Distill reusable rules to project memory when appropriate.";

    const registerBootstrapHook = api.registerHook ?? api.on;
    registerBootstrapHook.call(
      api,
      "agent:bootstrap",
      async (event: any) => {
        try {
          const bootstrapFiles = event?.context?.bootstrapFiles;
          if (!Array.isArray(bootstrapFiles)) return;

          // Avoid duplicate injection
          const exists = bootstrapFiles.some((f: any) =>
            f && typeof f === "object" && f.path === "SELF_IMPROVEMENT_REMINDER.md",
          );
          if (exists) return;

          bootstrapFiles.push({
            path: "SELF_IMPROVEMENT_REMINDER.md",
            content: SELF_IMPROVEMENT_REMINDER,
            virtual: true,
          });
          api.logger.debug?.(`ultramemory: injected self-improvement reminder into bootstrap`);
        } catch (err) {
          api.logger.warn(`ultramemory: agent:bootstrap self-improvement hook failed: ${String(err)}`);
        }
      },
      { name: "ultramemory.self-improvement.bootstrap", description: "Inject self-improvement reminder on agent bootstrap" },
    );

    // ── self-improvement: command:new / command:reset ──────────────────────
    const SELF_IMPROVEMENT_NOTE_PREFIX = "[ultramemory:self-improvement]";
    const appendSelfImprovementNote = async (event: any) => {
      try {
        const action = String(event?.action || "unknown");
        if (!Array.isArray(event?.messages)) {
          api.logger.warn(`ultramemory: command:${action} missing event.messages; skip note`);
          return;
        }

        // Avoid duplicate
        const exists = event.messages.some(
          (m: unknown) => typeof m === "string" && (m as string).includes(SELF_IMPROVEMENT_NOTE_PREFIX),
        );
        if (exists) return;

        event.messages.push(
          [
            SELF_IMPROVEMENT_NOTE_PREFIX,
            "- If anything was learned/corrected, log it now with memory_store.",
            "- Then proceed with the new session.",
          ].join("\n"),
        );
        api.logger.info(`ultramemory: command:${action} injected self-improvement note`);
      } catch (err) {
        api.logger.warn(`ultramemory: self-improvement note inject failed: ${String(err)}`);
      }
    };

    const registerCommandHook = api.registerHook ?? api.on;
    registerCommandHook.call(api, "command:new", appendSelfImprovementNote, {
      name: "ultramemory.self-improvement.command-new",
      description: "Append self-improvement note before /new",
    });
    registerCommandHook.call(api, "command:reset", appendSelfImprovementNote, {
      name: "ultramemory.self-improvement.command-reset",
      description: "Append self-improvement note before /reset",
    });

    api.logger.info("ultramemory: self-improvement hooks registered (agent:bootstrap, command:new, command:reset)");
  }

  // ── reflection: after_tool_call (error tracking) ────────────────────────
  if (config.memoryReflection) {
    api.on(
      "after_tool_call",
      async (event: any, _ctx: any) => {
        try {
          if (!service.isReady()) return;
          // Check for explicit error field
          let errorText: string | undefined;
          if (typeof event?.error === "string" && event.error.trim().length > 0) {
            errorText = event.error.trim();
          }

          // Check result text for error signals if no explicit error
          if (!errorText) {
            const resultText = extractToolResultText(event?.result);
            if (resultText && looksLikeError(resultText)) {
              errorText = resultText;
            }
          }

          if (!errorText) return;

          const toolName = event?.toolName || "unknown";
          const summary = errorText.length > 200 ? errorText.slice(0, 197) + "..." : errorText;

          await service.store({
            text: `[error:${toolName}] ${summary}`,
            category: "other",
            importance: 0.3,
          });

          api.logger.debug?.(`ultramemory: stored error signal from tool ${toolName}`);
        } catch (err) {
          api.logger.warn(`ultramemory: after_tool_call error tracking failed: ${String(err)}`);
        }
      },
      { name: "ultramemory.reflection.error-tracking", description: "Track tool errors as memories", priority: 15 },
    );

    // ── reflection: before_prompt_build priority 12 (inheritance) ─────────
    api.on(
      "before_prompt_build",
      async (event: any, _ctx: any) => {
        try {
          if (!service.isReady()) return {};
          const results = await service.recall({
            query: "reflection rules invariants constraints",
            limit: 6,
            category: "reflection",
          });

          if (results.length === 0) return {};

          const body = results.map((r, i) => `${i + 1}. ${truncate(r.text, 200)}`).join("\n");
          const prependContext = [
            "<inherited-rules>",
            "Stable rules from memory reflections. Treat as long-term behavioral constraints unless user overrides.",
            body,
            "</inherited-rules>",
          ].join("\n");

          api.logger.debug?.(`ultramemory: reflection inheritance injected ${results.length} rules`);
          return { prependContext };
        } catch (err) {
          api.logger.warn(`ultramemory: reflection inheritance injection failed: ${String(err)}`);
          return {};
        }
      },
      { name: "ultramemory.reflection.inheritance", description: "Inject inherited reflection rules", priority: 12 },
    );

    // ── reflection: before_prompt_build priority 15 (derived) ─────────────
    // TODO: This hook needs the full reflection LLM pipeline to produce
    // derived execution deltas. The original implementation uses
    // loadAgentReflectionSlices(), session-scoped caching, and pending
    // error signal aggregation. To port this properly, MemoryService would
    // need to expose a reflection slice loader and session-scoped error
    // signal state. Skipping for now — the priority-12 inheritance hook
    // provides the core reflection context.

    api.logger.info("ultramemory: memory-reflection hooks registered (after_tool_call, before_prompt_build:12)");
  }

  // ── session_end: cleanup ────────────────────────────────────────────────
  api.on(
    "session_end",
    async (_event: any, _ctx: any) => {
      try {
        // MemoryService has no session-scoped state to clean up.
        // The original index.ts cleaned in-memory Maps for reflection
        // session state. In the adapter, reflection state is not held
        // locally, so this is a no-op log for observability.
        api.logger.debug?.("ultramemory: session_end — no adapter-local state to clean");
      } catch (err) {
        api.logger.warn(`ultramemory: session_end cleanup failed: ${String(err)}`);
      }
    },
    { name: "ultramemory.session-cleanup", description: "Clean up session state", priority: 20 },
  );
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function createOpenClawAdapter(
  api: OpenClawPluginApi,
  service: MemoryService,
  config?: AdapterConfig,
): void {
  const resolvedConfig: AdapterConfig = {
    autoRecall: true,
    autoCapture: true,
    selfImprovement: false,
    memoryReflection: false,
    ...config,
  };

  registerTools(api, service);
  registerHooks(api, service, resolvedConfig);

  api.logger.info(
    `ultramemory: OpenClaw adapter ready — 6 tools, ` +
    `auto-recall=${resolvedConfig.autoRecall !== false}, ` +
    `auto-capture=${resolvedConfig.autoCapture !== false}, ` +
    `self-improvement=${!!resolvedConfig.selfImprovement}, ` +
    `memory-reflection=${!!resolvedConfig.memoryReflection}`,
  );
}
