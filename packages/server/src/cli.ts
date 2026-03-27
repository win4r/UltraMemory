#!/usr/bin/env node
import { Command } from "commander";
import { MemoryService } from "./service.js";
import { startMcpServer } from "./mcp.js";
import { createHttpApp } from "./http.js";
import { loadConfigFile, resolveConfig } from "./config.js";
import { serve } from "@hono/node-server";

const program = new Command();

program
  .name("ultramemory")
  .description("Universal AI Agent Long-Term Memory Engine")
  .version("0.1.0");

program
  .command("serve")
  .description("Start UltraMemory server")
  .option("--mcp", "Enable MCP server (stdio)")
  .option("--http", "Enable REST API server")
  .option("--port <port>", "HTTP port", "1933")
  .option("--db-path <path>", "Database path")
  .option("--config <path>", "Config file path")
  .option("--embedding-api-key <key>", "Embedding API key")
  .option("--embedding-model <model>", "Embedding model")
  .option("--embedding-base-url <url>", "Embedding base URL")
  .action(async (opts) => {
    const fileConfig = await loadConfigFile(opts.config);
    const embeddingApiKey = opts.embeddingApiKey
      || fileConfig.embedding?.apiKey
      || process.env.OPENAI_API_KEY
      || "";

    if (!embeddingApiKey) {
      console.error("Error: embedding API key required. Set OPENAI_API_KEY or use --embedding-api-key");
      process.exit(1);
    }

    const config = resolveConfig({
      ...fileConfig,
      dbPath: opts.dbPath || fileConfig.dbPath,
      embedding: {
        apiKey: embeddingApiKey,
        model: opts.embeddingModel || fileConfig.embedding?.model,
        baseURL: opts.embeddingBaseUrl || fileConfig.embedding?.baseURL,
        ...fileConfig.embedding,
        // CLI flags override file config
        ...(opts.embeddingApiKey ? { apiKey: opts.embeddingApiKey } : {}),
        ...(opts.embeddingModel ? { model: opts.embeddingModel } : {}),
        ...(opts.embeddingBaseUrl ? { baseURL: opts.embeddingBaseUrl } : {}),
      },
    });

    const service = new MemoryService(config);
    await service.initialize();

    if (!opts.mcp && !opts.http) {
      console.error("Specify --mcp and/or --http");
      process.exit(1);
    }

    if (opts.http) {
      const app = createHttpApp(service);
      const port = parseInt(opts.port);
      serve({ fetch: app.fetch, port });
      console.error(`UltraMemory REST API listening on http://localhost:${port}`);
    }

    if (opts.mcp) {
      console.error("UltraMemory MCP server starting on stdio...");
      await startMcpServer(service, config);
    }
  });

program
  .command("upgrade")
  .description("Upgrade memory database (run migrations and optional backfills)")
  .option("--backfill-vectors", "Backfill L0/L1/L2 multi-vector columns for all memories")
  .option("--db-path <path>", "Database path")
  .option("--config <path>", "Config file path")
  .option("--embedding-api-key <key>", "Embedding API key")
  .option("--embedding-model <model>", "Embedding model")
  .option("--embedding-base-url <url>", "Embedding base URL")
  .action(async (opts) => {
    if (!opts.backfillVectors) {
      console.error("No upgrade flags specified. Available flags: --backfill-vectors");
      process.exit(1);
    }

    const fileConfig = await loadConfigFile(opts.config);
    const embeddingApiKey = opts.embeddingApiKey
      || fileConfig.embedding?.apiKey
      || process.env.OPENAI_API_KEY
      || "";

    if (!embeddingApiKey) {
      console.error("Error: embedding API key required. Set OPENAI_API_KEY or use --embedding-api-key");
      process.exit(1);
    }

    const config = resolveConfig({
      ...fileConfig,
      dbPath: opts.dbPath || fileConfig.dbPath,
      embedding: {
        apiKey: embeddingApiKey,
        model: opts.embeddingModel || fileConfig.embedding?.model,
        baseURL: opts.embeddingBaseUrl || fileConfig.embedding?.baseURL,
        ...fileConfig.embedding,
        // CLI flags override file config
        ...(opts.embeddingApiKey ? { apiKey: opts.embeddingApiKey } : {}),
        ...(opts.embeddingModel ? { model: opts.embeddingModel } : {}),
        ...(opts.embeddingBaseUrl ? { baseURL: opts.embeddingBaseUrl } : {}),
      },
    });

    const service = new MemoryService(config);
    await service.initialize();

    if (opts.backfillVectors) {
      const updated = await service.backfillVectors(console.error);
      console.error(`upgrade: backfill-vectors done — ${updated} memories updated`);
    }

    await service.shutdown();
  });

program.parse();
