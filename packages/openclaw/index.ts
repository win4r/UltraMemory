/**
 * @ultramemory/openclaw — OpenClaw plugin entry point.
 *
 * Drop-in replacement for the legacy memory-lancedb-pro plugin.
 * Delegates all work to MemoryService from @ultramemory/server.
 */

import { MemoryService, resolveConfig, type UltraMemoryConfig } from "@ultramemory/server";
import { createOpenClawAdapter, type OpenClawPluginApi } from "./src/adapter.js";

export default {
  id: "ultramemory",
  name: "UltraMemory",
  description: "Universal AI Agent Long-Term Memory Engine",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    const rawConfig = (api.pluginConfig || {}) as Record<string, unknown>;
    const embeddingRaw = (rawConfig.embedding || {}) as Record<string, unknown>;

    // Map OpenClaw plugin config to UltraMemoryConfig
    const config = resolveConfig({
      dbPath: api.resolvePath(
        typeof rawConfig.dbPath === "string"
          ? rawConfig.dbPath
          : "~/.openclaw/memory/ultramemory",
      ),
      embedding: {
        apiKey: (embeddingRaw.apiKey as string | string[]) || process.env.OPENAI_API_KEY || "",
        model: embeddingRaw.model as string | undefined,
        baseURL: embeddingRaw.baseURL as string | undefined,
        dimensions: embeddingRaw.dimensions as number | undefined,
        omitDimensions: embeddingRaw.omitDimensions as boolean | undefined,
        taskQuery: embeddingRaw.taskQuery as string | undefined,
        taskPassage: embeddingRaw.taskPassage as string | undefined,
        normalized: embeddingRaw.normalized as boolean | undefined,
        chunking: embeddingRaw.chunking as boolean | undefined,
      },
      smartExtraction: rawConfig.smartExtraction as boolean | undefined,
      decay: rawConfig.decay as UltraMemoryConfig["decay"],
      tier: rawConfig.tier as UltraMemoryConfig["tier"],
      scopes: rawConfig.scopes as UltraMemoryConfig["scopes"],
      retrieval: rawConfig.retrieval as UltraMemoryConfig["retrieval"],
      llm: rawConfig.llm as UltraMemoryConfig["llm"],
    });

    const service = new MemoryService(config);

    service
      .initialize()
      .then(() => {
        createOpenClawAdapter(api, service, {
          autoRecall: rawConfig.autoRecall !== false,
          autoRecallMinLength: rawConfig.autoRecallMinLength as number | undefined,
          autoRecallMaxItems: rawConfig.autoRecallMaxItems as number | undefined,
          autoRecallMaxChars: rawConfig.autoRecallMaxChars as number | undefined,
          autoCapture: rawConfig.autoCapture !== false,
        });
      })
      .catch((err) => {
        api.logger.error(`ultramemory: initialization failed: ${err}`);
      });
  },
};
