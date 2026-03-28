export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function createMcpToolDefinitions(opts?: { enableFeedbackTool?: boolean }): McpToolDefinition[] {
  const tools: McpToolDefinition[] = [
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
