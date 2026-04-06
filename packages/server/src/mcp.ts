import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { MemoryService } from "./service.js";
import type { UltraMemoryConfig } from "./config.js";
import { createMcpToolDefinitions } from "./tools.js";

export async function startMcpServer(
  service: MemoryService,
  config?: Pick<UltraMemoryConfig, "enableFeedbackTool">,
): Promise<Server> {
  const server = new Server(
    { name: "ultramemory", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: createMcpToolDefinitions({ enableFeedbackTool: config?.enableFeedbackTool }),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    let result: unknown;

    switch (name) {
      case "memory_store":
        result = await service.store(args as any);
        break;
      case "memory_recall":
        result = await service.recall({
          query: (args as any).query,
          limit: (args as any).limit,
          scopeFilter: (args as any).scope
            ? [(args as any).scope]
            : undefined,
          category: (args as any).category,
          depth: (args as any).depth,
          render: (args as any).render,
          taskContext: (args as any).taskContext,
          graph: (args as any).graph,
        });
        break;
      case "memory_update":
        result = await service.update({
          id: (args as any).memoryId,
          text: (args as any).text,
          importance: (args as any).importance,
          category: (args as any).category,
        });
        break;
      case "memory_forget":
        result = await service.forget({ id: (args as any).id });
        break;
      case "memory_list":
        result = await service.list({
          limit: (args as any).limit,
          offset: (args as any).offset,
          scopeFilter: (args as any).scope
            ? [(args as any).scope]
            : undefined,
          category: (args as any).category,
        });
        break;
      case "memory_stats":
        result = await service.stats(
          (args as any).scope ? [(args as any).scope] : undefined,
        );
        break;
      case "memory_auto_capture":
        result = await service.autoCapture({
          conversationText: (args as any).conversationText,
          scope: (args as any).scope,
        });
        break;
      case "memory_health":
        result = await service.health(
          (args as any).scope ? [(args as any).scope] : undefined,
        );
        break;
      case "memory_conflicts":
        result = await service.conflicts(
          (args as any).scope ? [(args as any).scope] : undefined,
        );
        break;
      case "memory_checkpoint":
        result = await service.checkpoint({
          summary: (args as any).summary,
          scope: (args as any).scope,
          sessionId: (args as any).sessionId,
          decisions: (args as any).decisions,
          nextActions: (args as any).nextActions,
          openLoops: (args as any).openLoops,
          entities: (args as any).entities,
        });
        break;
      case "memory_resume":
        result = await service.resume({
          scope: (args as any).scope,
          sessionId: (args as any).sessionId,
        });
        if (result === null) {
          result = { message: "No checkpoint found for the given scope/session." };
        }
        break;
      case "memory_provenance":
        result = await service.getProvenance((args as any).id);
        if (result === null) {
          result = { message: "Memory not found." };
        }
        break;
      case "memory_consolidate":
        result = await service.consolidate({
          scope: (args as any).scope,
          maxEntries: (args as any).maxEntries,
          similarityThreshold: (args as any).similarityThreshold,
          generateDigest: (args as any).generateDigest,
        });
        break;
      case "memory_feedback":
        result = await service.feedback({
          id: (args as any).id,
          helpful: (args as any).helpful,
        });
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
