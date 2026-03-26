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

interface AdapterConfig {
  autoRecall?: boolean;
  autoRecallMinLength?: number;
  autoRecallMaxItems?: number;
  autoRecallMaxChars?: number;
  autoCapture?: boolean;
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

  // ── session_end: cleanup ────────────────────────────────────────────────
  api.on(
    "session_end",
    async () => {
      // Placeholder for session state cleanup
      // Full reflection cleanup will be added when reflection hooks are ported
    },
    { name: "ultramemory.session-cleanup", description: "Clean up session state", priority: 20 },
  );

  // TODO: Port remaining hooks from index.ts:
  // - agent:bootstrap (self-improvement reminder injection)
  // - command:new / command:reset (self-improvement notes)
  // - after_tool_call (reflection error tracking)
  // - before_prompt_build priority 12 (reflection inheritance injection)
  // - before_prompt_build priority 15 (reflection derived injection)
  // - command:new / command:reset (memory reflection LLM pass)
  // - command:new (session memory storage)
  // These require SmartExtractor, reflection store, and session state
  // management that need to be exposed from MemoryService first.
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
    ...config,
  };

  registerTools(api, service);
  registerHooks(api, service, resolvedConfig);

  api.logger.info(
    `ultramemory: OpenClaw adapter ready — 6 tools, ` +
    `auto-recall=${resolvedConfig.autoRecall !== false}, ` +
    `auto-capture=${resolvedConfig.autoCapture !== false}`,
  );
}
