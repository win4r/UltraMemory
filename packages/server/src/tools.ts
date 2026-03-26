export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function createMcpToolDefinitions(): McpToolDefinition[] {
  return [
    {
      name: "memory_store",
      description: "Store a new memory",
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
  ];
}
