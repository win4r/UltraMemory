export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function createMcpToolDefinitions(opts?: { enableFeedbackTool?: boolean }): McpToolDefinition[] {
  const tools: McpToolDefinition[] = [
    {
      name: "memory_store",
      description:
        "Store a new memory. " +
        "PROACTIVE STORE GUIDANCE — call this tool during the conversation, not just at the end: " +
        "(1) Reusable pattern discovered — store solutions, workarounds, or design patterns immediately (importance: 0.8+). " +
        "(2) Non-obvious preference confirmed — store when the user explicitly confirms an uncommon preference (importance: 0.8). " +
        "(3) Corrected misconception — store corrections to previous wrong assumptions so they are never repeated (importance: 0.85). " +
        "(4) Complex problem solved — store root cause and fix after multi-step debugging or tricky integration (importance: 0.8). " +
        "Do NOT store greetings, small talk, transient task status, or duplicates (auto-deduplicated).",
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "Information to remember",
          },
          importance: {
            type: "number",
            description: "Importance score from 0 to 1",
            minimum: 0,
            maximum: 1,
            default: 0.7,
          },
          category: {
            type: "string",
            description: "Memory category",
            enum: [
              "preference",
              "fact",
              "decision",
              "entity",
              "reflection",
              "other",
            ],
          },
          scope: {
            type: "string",
            description: "Memory scope",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
    {
      name: "memory_recall",
      description: "Search for relevant memories",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query",
          },
          limit: {
            type: "number",
            description: "Maximum number of results to return",
            minimum: 1,
            maximum: 20,
            default: 5,
          },
          scope: {
            type: "string",
            description: "Filter by scope",
          },
          category: {
            type: "string",
            description: "Filter by category",
          },
          depth: {
            type: "string",
            description: "Content depth: l0 (one-sentence ~100 tokens), l1 (bullet list ~2K tokens), l2/full (complete text). Default: full",
            enum: ["l0", "l1", "l2", "full"],
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "memory_update",
      description: "Update an existing memory",
      inputSchema: {
        type: "object",
        properties: {
          memoryId: {
            type: "string",
            description: "ID of the memory to update",
          },
          text: {
            type: "string",
            description: "New text content (triggers re-embedding)",
          },
          importance: {
            type: "number",
            description: "New importance score from 0 to 1",
            minimum: 0,
            maximum: 1,
          },
          category: {
            type: "string",
            description: "New category",
          },
        },
        required: ["memoryId"],
        additionalProperties: false,
      },
    },
    {
      name: "memory_forget",
      description: "Delete a memory",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Memory ID to delete",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "memory_list",
      description: "List memories with optional filters",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Maximum number of results to return",
            minimum: 1,
            maximum: 50,
            default: 20,
          },
          offset: {
            type: "number",
            description: "Number of entries to skip",
            minimum: 0,
          },
          scope: {
            type: "string",
            description: "Filter by scope",
          },
          category: {
            type: "string",
            description: "Filter by category",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "memory_stats",
      description: "Get memory statistics",
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            description: "Filter by scope",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "memory_checkpoint",
      description:
        "Save a session checkpoint — captures current progress, decisions, and next actions so the session can be resumed later",
      inputSchema: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description:
              "Summary of the current session state (what was done, where things stand)",
          },
          scope: {
            type: "string",
            description: "Scope for the checkpoint (default: global)",
          },
          sessionId: {
            type: "string",
            description:
              "Session identifier for grouping checkpoints (auto-generated if omitted)",
          },
          decisions: {
            type: "array",
            items: { type: "string" },
            description: "Key decisions made in the session",
          },
          nextActions: {
            type: "array",
            items: { type: "string" },
            description: "Pending actions for the next session",
          },
          openLoops: {
            type: "array",
            items: { type: "string" },
            description: "Unresolved items that need follow-up",
          },
          entities: {
            type: "array",
            items: { type: "string" },
            description:
              "Relevant entities (people, projects, tools) for context",
          },
        },
        required: ["summary"],
        additionalProperties: false,
      },
    },
    {
      name: "memory_provenance",
      description:
        "Query the provenance (origin story) of a memory — shows where it came from, which session created it, and why",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Memory ID to query provenance for",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "memory_resume",
      description:
        "Resume a previous session — retrieves the latest checkpoint to restore context and continue where you left off",
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            description:
              "Scope to search for the latest checkpoint (default: all scopes)",
          },
          sessionId: {
            type: "string",
            description: "Resume a specific session by its ID",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "memory_consolidate",
      description:
        "Consolidate memories — merge near-duplicates and generate a compressed user profile digest. Run periodically (e.g. weekly) to keep memory clean and efficient.",
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            description: "Scope to consolidate (default: global)",
          },
          maxEntries: {
            type: "number",
            description: "Max memories to scan (default: 100, max: 500)",
            minimum: 10,
            maximum: 500,
          },
          similarityThreshold: {
            type: "number",
            description: "Cosine similarity threshold for merging (default: 0.85, range: 0.7-0.99)",
            minimum: 0.7,
            maximum: 0.99,
          },
          generateDigest: {
            type: "boolean",
            description: "Whether to generate a compressed digest entry (default: true)",
          },
        },
        additionalProperties: false,
      },
    },
  ];

  tools.push(
    {
      name: "memory_health",
      description: "Get corpus health metrics — category distribution, staleness, conflict count, tier balance, and source distribution",
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string", description: "Filter by scope" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "memory_conflicts",
      description: "List unresolved memory conflicts — memories that contradict each other",
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string", description: "Filter by scope" },
        },
        additionalProperties: false,
      },
    },
  );

  if (opts?.enableFeedbackTool) {
    tools.push({
      name: "memory_feedback",
      description:
        "Record feedback on a recalled memory. Positive feedback makes the memory more prominent in future recalls; negative feedback makes it fade faster.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Memory ID to provide feedback on",
          },
          helpful: {
            type: "boolean",
            description: "Was this memory helpful? true = positive, false = negative",
          },
        },
        required: ["id", "helpful"],
        additionalProperties: false,
      },
    });
  }

  return tools;
}
