# UltraMemory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor memory-lancedb-pro into a universal agent memory engine with MCP + REST interfaces, published as three packages under the @ultramemory scope.

**Architecture:** Monorepo with pnpm workspaces. Core engine (`src/*.ts`) moves to `packages/core/`. A new `MemoryService` class in `packages/server/` wraps core and exposes MCP + REST. Existing OpenClaw plugin becomes a thin adapter in `packages/openclaw/`.

**Tech Stack:** TypeScript, pnpm workspaces, LanceDB, OpenAI SDK, `@modelcontextprotocol/sdk`, Hono (REST), Commander (CLI)

**Spec:** `docs/superpowers/specs/2026-03-26-ultramemory-design.md`

---

## File Map

### packages/core/
All existing `src/*.ts` files move here unchanged. Public API re-exported from index.ts.

| Source (current) | Destination | Notes |
|-----------------|-------------|-------|
| `src/store.ts` | `packages/core/src/store.ts` | No changes |
| `src/retriever.ts` | `packages/core/src/retriever.ts` | No changes |
| `src/embedder.ts` | `packages/core/src/embedder.ts` | No changes |
| `src/decay-engine.ts` | `packages/core/src/decay-engine.ts` | No changes |
| `src/tier-manager.ts` | `packages/core/src/tier-manager.ts` | No changes |
| `src/smart-extractor.ts` | `packages/core/src/smart-extractor.ts` | No changes |
| `src/smart-metadata.ts` | `packages/core/src/smart-metadata.ts` | No changes |
| `src/chunker.ts` | `packages/core/src/chunker.ts` | No changes |
| `src/memory-categories.ts` | `packages/core/src/memory-categories.ts` | No changes |
| `src/noise-filter.ts` | `packages/core/src/noise-filter.ts` | No changes |
| `src/noise-prototypes.ts` | `packages/core/src/noise-prototypes.ts` | No changes |
| `src/scopes.ts` | `packages/core/src/scopes.ts` | No changes |
| `src/llm-client.ts` | `packages/core/src/llm-client.ts` | No changes |
| `src/llm-oauth.ts` | `packages/core/src/llm-oauth.ts` | No changes |
| `src/admission-control.ts` | `packages/core/src/admission-control.ts` | No changes |
| `src/admission-stats.ts` | `packages/core/src/admission-stats.ts` | No changes |
| `src/memory-upgrader.ts` | `packages/core/src/memory-upgrader.ts` | No changes |
| `src/migrate.ts` | `packages/core/src/migrate.ts` | No changes |
| `src/extraction-prompts.ts` | `packages/core/src/extraction-prompts.ts` | No changes |
| `src/preference-slots.ts` | `packages/core/src/preference-slots.ts` | No changes |
| `src/reflection-*.ts` (7 files) | `packages/core/src/reflection-*.ts` | No changes |
| `src/adaptive-retrieval.ts` | `packages/core/src/adaptive-retrieval.ts` | No changes |
| `src/auto-capture-cleanup.ts` | `packages/core/src/auto-capture-cleanup.ts` | No changes |
| `src/clawteam-scope.ts` | `packages/core/src/clawteam-scope.ts` | No changes |
| `src/identity-addressing.ts` | `packages/core/src/identity-addressing.ts` | No changes |
| `src/self-improvement-files.ts` | `packages/core/src/self-improvement-files.ts` | No changes |
| `src/session-recovery.ts` | `packages/core/src/session-recovery.ts` | No changes |
| `src/workspace-boundary.ts` | `packages/core/src/workspace-boundary.ts` | No changes |
| `src/access-tracker.ts` | `packages/core/src/access-tracker.ts` | No changes |

### packages/server/
New files. `MemoryService` extracts business logic from `index.ts`.

| File | Responsibility |
|------|---------------|
| `src/service.ts` | `MemoryService` class — init, store, recall, update, forget, list, stats, extract, maintenance |
| `src/mcp.ts` | MCP stdio/SSE server — translates MCP tool calls → MemoryService methods |
| `src/http.ts` | REST API — Hono routes → MemoryService methods |
| `src/tools.ts` | Tool definitions shared between MCP and REST (schemas, descriptions) |
| `src/config.ts` | Config loading — CLI args, env vars, config file (~/.ultramemory/config.json) |
| `src/cli.ts` | CLI entry — `ultramemory serve --mcp --http --port 1933` |
| `index.ts` | Public exports (MemoryService, createServer) |

### packages/openclaw/
Thin adapter wrapping MemoryService with OpenClaw hooks.

| File | Responsibility |
|------|---------------|
| `src/adapter.ts` | Maps OpenClaw hooks (agent_end, before_prompt_build, etc.) → MemoryService |
| `index.ts` | Plugin entry with `register(api)` |

---

## Task 1: Initialize monorepo scaffolding

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Modify: `package.json` (root workspace config)
- Create: `packages/core/package.json`
- Create: `packages/server/package.json`
- Create: `packages/openclaw/package.json`

- [ ] **Step 1: Install pnpm if needed**

Run: `which pnpm || npm install -g pnpm`

- [ ] **Step 2: Create pnpm-workspace.yaml**

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 3: Create turbo.json**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["build"] },
    "typecheck": {}
  }
}
```

- [ ] **Step 4: Update root package.json**

Keep existing fields (name, version, license). Add:
```json
{
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck"
  },
  "devDependencies": {
    "turbo": "^2",
    "typescript": "^5.9.3"
  }
}
```

Remove `main`, `openclaw`, `dependencies`, and `scripts.test` (they move to sub-packages).

- [ ] **Step 5: Create packages/core/package.json**

```json
{
  "name": "@ultramemory/core",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "license": "MIT",
  "dependencies": {
    "@lancedb/lancedb": "^0.26.2",
    "@sinclair/typebox": "0.34.48",
    "apache-arrow": "18.1.0",
    "json5": "^2.2.3",
    "openai": "^6.21.0",
    "proper-lockfile": "^4.1.2"
  },
  "scripts": {
    "test": "echo 'core tests run from root'",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 6: Create packages/server/package.json**

```json
{
  "name": "@ultramemory/server",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "bin": {
    "ultramemory": "src/cli.ts"
  },
  "license": "MIT",
  "dependencies": {
    "@ultramemory/core": "workspace:*",
    "@modelcontextprotocol/sdk": "^1",
    "hono": "^4",
    "@hono/node-server": "^1",
    "commander": "^14.0.0"
  },
  "scripts": {
    "test": "echo 'server tests run from root'",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 7: Create packages/openclaw/package.json**

```json
{
  "name": "@ultramemory/openclaw",
  "version": "0.1.0",
  "type": "module",
  "main": "index.ts",
  "license": "MIT",
  "dependencies": {
    "@ultramemory/core": "workspace:*",
    "@ultramemory/server": "workspace:*"
  },
  "openclaw": {
    "extensions": ["./index.ts"]
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 8: Run pnpm install**

Run: `pnpm install`
Expected: All workspace packages linked, node_modules created

- [ ] **Step 9: Commit**

```bash
git add pnpm-workspace.yaml turbo.json package.json packages/
git commit -m "chore: initialize monorepo scaffolding with pnpm workspaces"
```

---

## Task 2: Move core modules to packages/core/

**Files:**
- Move: all 37 files from `src/*.ts` → `packages/core/src/`
- Create: `packages/core/src/index.ts` (public API)
- Create: `packages/core/tsconfig.json`
- Move: `test/` → `packages/core/test/` (temporarily, tests stay with core)

- [ ] **Step 1: Copy source files**

```bash
cp -r src/* packages/core/src/
```

- [ ] **Step 2: Create packages/core/src/index.ts**

Export the public API that server and openclaw need:

```typescript
// Storage
export { MemoryStore, validateStoragePath } from "./store.js";
export type { MemoryEntry, MemorySearchResult, StoreConfig } from "./store.js";

// Embedding
export { createEmbedder, getVectorDimensions } from "./embedder.js";

// Retrieval
export { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "./retriever.js";
export type { RetrievalResult } from "./retriever.js";

// Scopes
export { createScopeManager, resolveScopeFilter, isSystemBypassId, parseAgentIdFromSessionKey } from "./scopes.js";

// Migration
export { createMigrator } from "./migrate.js";

// Smart features
export { SmartExtractor } from "./smart-extractor.js";
export { createLlmClient } from "./llm-client.js";
export { createDecayEngine, DEFAULT_DECAY_CONFIG } from "./decay-engine.js";
export { createTierManager, DEFAULT_TIER_CONFIG } from "./tier-manager.js";
export { createMemoryUpgrader } from "./memory-upgrader.js";
export { buildSmartMetadata, parseSmartMetadata, stringifySmartMetadata } from "./smart-metadata.js";

// Categories
export type { MemoryCategory, MemoryTier } from "./memory-categories.js";

// Noise filtering
export { isNoise } from "./noise-filter.js";
export { NoisePrototypeBank } from "./noise-prototypes.js";
export { normalizeAutoCaptureText } from "./auto-capture-cleanup.js";

// Admission control
export { createAdmissionController } from "./admission-control.js";

// Chunking
export { smartChunk } from "./chunker.js";
```

- [ ] **Step 3: Create packages/core/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": false,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: Copy test files**

```bash
cp -r test/ packages/core/test/
```

- [ ] **Step 5: Verify core typecheck passes**

Run: `cd packages/core && npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 6: Verify tests pass against core**

Run: `cd packages/core && node test/cli-smoke.mjs`
Expected: `OK: CLI smoke test passed`

- [ ] **Step 7: Commit**

```bash
git add packages/core/
git commit -m "feat: move core modules to packages/core"
```

---

## Task 3: Build MemoryService

**Files:**
- Create: `packages/server/src/service.ts`
- Create: `packages/server/src/config.ts`
- Create: `packages/server/tsconfig.json`
- Test: `packages/server/test/service.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/service.test.mjs`:

```javascript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryService } from "../src/service.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("MemoryService", () => {
  let service;
  let tempDir;

  it("initializes, stores, recalls, and shuts down", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ultramemory-test-"));
    service = new MemoryService({
      dbPath: join(tempDir, "db"),
      embedding: {
        apiKey: "test-key",
        model: "text-embedding-3-small",
        baseURL: "http://127.0.0.1:0/v1",
        dimensions: 4,
      },
      smartExtraction: false,
      decay: { enabled: false },
    });

    await service.initialize();

    const stored = await service.store({
      text: "TypeScript is a typed superset of JavaScript",
      category: "fact",
      scope: "global",
      importance: 0.8,
    });
    assert.ok(stored.id, "store should return an id");

    const stats = await service.stats();
    assert.equal(stats.totalMemories, 1);

    await service.shutdown();
    await rm(tempDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && node --test test/service.test.mjs`
Expected: FAIL — MemoryService not found

- [ ] **Step 3: Create packages/server/src/config.ts**

```typescript
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface UltraMemoryConfig {
  dbPath?: string;
  embedding: {
    apiKey: string;
    model?: string;
    baseURL?: string;
    dimensions?: number;
  };
  llm?: {
    apiKey?: string;
    model?: string;
    baseURL?: string;
  };
  smartExtraction?: boolean;
  decay?: {
    enabled?: boolean;
    halfLifeDays?: number;
  };
  scopes?: string[];
}

const DEFAULT_DB_PATH = join(homedir(), ".ultramemory", "db");

export function resolveConfig(partial: Partial<UltraMemoryConfig> & { embedding: UltraMemoryConfig["embedding"] }): UltraMemoryConfig {
  return {
    dbPath: partial.dbPath || DEFAULT_DB_PATH,
    embedding: {
      apiKey: partial.embedding.apiKey,
      model: partial.embedding.model || "text-embedding-3-small",
      baseURL: partial.embedding.baseURL || "https://api.openai.com/v1",
      dimensions: partial.embedding.dimensions || 1536,
    },
    llm: partial.llm,
    smartExtraction: partial.smartExtraction ?? true,
    decay: {
      enabled: partial.decay?.enabled ?? true,
      halfLifeDays: partial.decay?.halfLifeDays ?? 14,
    },
    scopes: partial.scopes || ["global"],
  };
}

export async function loadConfigFile(path?: string): Promise<Partial<UltraMemoryConfig>> {
  const configPath = path || join(homedir(), ".ultramemory", "config.json");
  try {
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
```

- [ ] **Step 4: Create packages/server/src/service.ts**

Implement `MemoryService` wrapping core modules. Extract the initialization, store, recall, update, forget, list, and stats logic from `index.ts` into clean methods. Key pattern:

```typescript
import {
  MemoryStore, createEmbedder, getVectorDimensions,
  createRetriever, createScopeManager, createMigrator,
  createDecayEngine, createTierManager, parseSmartMetadata,
  buildSmartMetadata, stringifySmartMetadata,
} from "@ultramemory/core";
import { resolveConfig, type UltraMemoryConfig } from "./config.js";

export class MemoryService {
  private config: UltraMemoryConfig;
  private store!: MemoryStore;
  private retriever!: ReturnType<typeof createRetriever>;
  private embedder!: ReturnType<typeof createEmbedder>;
  private initialized = false;

  constructor(config: UltraMemoryConfig) {
    this.config = resolveConfig(config);
  }

  async initialize(): Promise<void> {
    // 1. Create embedder
    // 2. Create store with migrations
    // 3. Create retriever (hybrid Vector+BM25)
    // 4. Create decay engine + tier manager (if enabled)
    // Mirror the initialization sequence from index.ts lines ~1580-1700
    this.initialized = true;
  }

  async store(params: StoreParams): Promise<{ id: string }> {
    this.ensureInitialized();
    // Embed text, write to store
    // Apply smart metadata if smartExtraction enabled
  }

  async recall(params: RecallParams): Promise<RecallResult[]> {
    this.ensureInitialized();
    // Retrieve via hybrid search
    // Apply decay boost if enabled
    // Return scored results
  }

  async update(params: UpdateParams): Promise<{ ok: boolean }> { /* ... */ }
  async forget(params: ForgetParams): Promise<{ ok: boolean }> { /* ... */ }
  async list(params?: ListParams): Promise<ListEntry[]> { /* ... */ }
  async stats(): Promise<StatsResult> { /* ... */ }
  async shutdown(): Promise<void> { /* ... */ }

  private ensureInitialized() {
    if (!this.initialized) throw new Error("MemoryService not initialized. Call initialize() first.");
  }
}
```

The full implementation extracts logic from `index.ts` — specifically the plugin `register()` function's initialization block (lines ~1576-1700) and the tool handlers (from `src/tools.ts`).

- [ ] **Step 5: Create packages/server/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": false,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/server && node --test test/service.test.mjs`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/server/
git commit -m "feat: implement MemoryService with store/recall/stats"
```

---

## Task 4: Add MCP Server

**Files:**
- Create: `packages/server/src/mcp.ts`
- Create: `packages/server/src/tools.ts`
- Test: `packages/server/test/mcp.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/mcp.test.mjs`:

```javascript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMcpToolDefinitions } from "../src/tools.ts";

describe("MCP tool definitions", () => {
  it("defines 6 tools with valid schemas", () => {
    const tools = createMcpToolDefinitions();
    const names = tools.map(t => t.name);
    assert.deepEqual(names.sort(), [
      "memory_forget",
      "memory_list",
      "memory_recall",
      "memory_stats",
      "memory_store",
      "memory_update",
    ]);
    for (const tool of tools) {
      assert.ok(tool.description, `${tool.name} must have description`);
      assert.ok(tool.inputSchema, `${tool.name} must have inputSchema`);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && node --test test/mcp.test.mjs`
Expected: FAIL

- [ ] **Step 3: Create packages/server/src/tools.ts**

Define 6 MCP tool schemas (memory_store, memory_recall, memory_update, memory_forget, memory_list, memory_stats) with JSON Schema input definitions.

- [ ] **Step 4: Create packages/server/src/mcp.ts**

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MemoryService } from "./service.js";
import { createMcpToolDefinitions } from "./tools.js";

export async function startMcpServer(service: MemoryService): Promise<void> {
  const server = new Server(
    { name: "ultramemory", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: createMcpToolDefinitions(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // Route to MemoryService methods based on tool name
    switch (name) {
      case "memory_store": return formatResult(await service.store(args));
      case "memory_recall": return formatResult(await service.recall(args));
      case "memory_update": return formatResult(await service.update(args));
      case "memory_forget": return formatResult(await service.forget(args));
      case "memory_list": return formatResult(await service.list(args));
      case "memory_stats": return formatResult(await service.stats());
      default: throw new Error(`Unknown tool: ${name}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function formatResult(data: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/server && node --test test/mcp.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/mcp.ts packages/server/src/tools.ts packages/server/test/
git commit -m "feat: add MCP server with 6 memory tools"
```

---

## Task 5: Add REST API

**Files:**
- Create: `packages/server/src/http.ts`
- Test: `packages/server/test/http.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/http.test.mjs`:

```javascript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHttpApp } from "../src/http.ts";

describe("REST API routes", () => {
  it("creates app with expected routes", () => {
    const app = createHttpApp(null); // null service for route-only test
    assert.ok(app, "should create Hono app");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && node --test test/http.test.mjs`
Expected: FAIL

- [ ] **Step 3: Create packages/server/src/http.ts**

```typescript
import { Hono } from "hono";
import type { MemoryService } from "./service.js";

export function createHttpApp(service: MemoryService) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.post("/api/v1/memory", async (c) => {
    const body = await c.req.json();
    const result = await service.store(body);
    return c.json(result, 201);
  });

  app.get("/api/v1/memory/recall", async (c) => {
    const query = c.req.query("query") || "";
    const limit = parseInt(c.req.query("limit") || "10");
    const scope = c.req.query("scope");
    const category = c.req.query("category");
    const result = await service.recall({
      query, limit,
      scopeFilter: scope ? scope.split(",") : undefined,
      category: category || undefined,
    });
    return c.json(result);
  });

  app.patch("/api/v1/memory/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const result = await service.update({ id, ...body });
    return c.json(result);
  });

  app.delete("/api/v1/memory/:id", async (c) => {
    const id = c.req.param("id");
    const result = await service.forget({ id });
    return c.json(result);
  });

  app.get("/api/v1/memory", async (c) => {
    const scope = c.req.query("scope");
    const category = c.req.query("category");
    const limit = parseInt(c.req.query("limit") || "50");
    const offset = parseInt(c.req.query("offset") || "0");
    const result = await service.list({
      scopeFilter: scope ? scope.split(",") : undefined,
      category: category || undefined,
      limit, offset,
    });
    return c.json(result);
  });

  app.get("/api/v1/stats", async (c) => {
    const result = await service.stats();
    return c.json(result);
  });

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && node --test test/http.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/http.ts packages/server/test/http.test.mjs
git commit -m "feat: add REST API with Hono"
```

---

## Task 6: Add CLI entry point

**Files:**
- Create: `packages/server/src/cli.ts`
- Create: `packages/server/src/index.ts`

- [ ] **Step 1: Create packages/server/src/cli.ts**

```typescript
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
    const config = resolveConfig({
      ...fileConfig,
      dbPath: opts.dbPath || fileConfig.dbPath,
      embedding: {
        apiKey: opts.embeddingApiKey || fileConfig.embedding?.apiKey || process.env.OPENAI_API_KEY || "",
        model: opts.embeddingModel || fileConfig.embedding?.model,
        baseURL: opts.embeddingBaseUrl || fileConfig.embedding?.baseURL,
        ...fileConfig.embedding,
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
      await startMcpServer(service);
    }
  });

program.parse();
```

- [ ] **Step 2: Create packages/server/src/index.ts**

```typescript
export { MemoryService } from "./service.js";
export { startMcpServer } from "./mcp.js";
export { createHttpApp } from "./http.js";
export type { UltraMemoryConfig } from "./config.js";
```

- [ ] **Step 3: Verify CLI runs**

Run: `cd packages/server && node src/cli.ts serve --help`
Expected: Shows help with --mcp, --http, --port options

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/cli.ts packages/server/src/index.ts
git commit -m "feat: add CLI entry point (ultramemory serve)"
```

---

## Task 7: Build OpenClaw adapter

**Files:**
- Create: `packages/openclaw/src/adapter.ts`
- Create: `packages/openclaw/index.ts`
- Create: `packages/openclaw/tsconfig.json`

- [ ] **Step 1: Create packages/openclaw/src/adapter.ts**

Thin wrapper that translates OpenClaw plugin hooks into MemoryService calls. Extract the hook registration logic from `index.ts` (agent_end, before_prompt_build, command:new, etc.) and route them through MemoryService.

Key pattern:
```typescript
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { MemoryService } from "@ultramemory/server";

export function createOpenClawAdapter(api: OpenClawPluginApi, service: MemoryService) {
  // Auto-capture: agent_end → service.extractFromConversation()
  // Auto-recall: before_prompt_build → service.recall()
  // Self-improvement hooks
  // Reflection hooks
  // Session memory hooks
  // Register tools via api.registerTool
  // Register CLI via api.registerCli
}
```

- [ ] **Step 2: Create packages/openclaw/index.ts**

```typescript
import { MemoryService } from "@ultramemory/server";
import { createOpenClawAdapter } from "./src/adapter.js";

export default {
  register(api) {
    const config = parsePluginConfig(api.pluginConfig);
    const service = new MemoryService(config);
    service.initialize().then(() => {
      createOpenClawAdapter(api, service);
    });
  },
};
```

- [ ] **Step 3: Create packages/openclaw/tsconfig.json**

Same as core/server tsconfig.

- [ ] **Step 4: Verify typecheck**

Run: `cd packages/openclaw && npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add packages/openclaw/
git commit -m "feat: add OpenClaw adapter package"
```

---

## Task 8: Integration test — MCP end-to-end

**Files:**
- Create: `packages/server/test/mcp-e2e.test.mjs`

- [ ] **Step 1: Write e2e test**

Test that starts MCP server in a subprocess, sends tool calls via MCP protocol, verifies store/recall round-trip works.

```javascript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

describe("MCP e2e", () => {
  it("store and recall via MCP protocol", async () => {
    const transport = new StdioClientTransport({
      command: "node",
      args: ["src/cli.ts", "serve", "--mcp"],
      env: { ...process.env, OPENAI_API_KEY: "test" },
    });
    const client = new Client({ name: "test", version: "1.0" });
    await client.connect(transport);

    const tools = await client.listTools();
    assert.ok(tools.tools.length >= 6);

    // Store
    const storeResult = await client.callTool({
      name: "memory_store",
      arguments: { text: "test memory", category: "fact" },
    });
    assert.ok(storeResult.content[0].text.includes("id"));

    await client.close();
  });
});
```

- [ ] **Step 2: Run test**

Run: `cd packages/server && node --test test/mcp-e2e.test.mjs`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/server/test/mcp-e2e.test.mjs
git commit -m "test: add MCP end-to-end integration test"
```

---

## Task 9: Integration test — REST end-to-end

**Files:**
- Create: `packages/server/test/http-e2e.test.mjs`

- [ ] **Step 1: Write e2e test**

Test that starts HTTP server, sends requests to all endpoints, verifies store/recall/list/stats.

- [ ] **Step 2: Run test**

Run: `cd packages/server && node --test test/http-e2e.test.mjs`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/server/test/http-e2e.test.mjs
git commit -m "test: add REST API end-to-end integration test"
```

---

## Task 10: Update root README and publish config

**Files:**
- Modify: `README.md`
- Create: `.npmrc`

- [ ] **Step 1: Update README.md**

Add universal usage section at top:

```markdown
# UltraMemory

Universal AI Agent Long-Term Memory Engine.

## Quick Start

### As MCP Server (Claude Code, Cursor, Windsurf)
\`\`\`bash
npx @ultramemory/server serve --mcp
\`\`\`

### As REST API
\`\`\`bash
npx @ultramemory/server serve --http --port 1933
\`\`\`

### As OpenClaw Plugin
\`\`\`bash
openclaw plugin add @ultramemory/openclaw
\`\`\`
```

- [ ] **Step 2: Create .npmrc for workspace publishing**

```
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
```

- [ ] **Step 3: Commit**

```bash
git add README.md .npmrc
git commit -m "docs: update README for universal UltraMemory usage"
```

---

## Execution Order & Dependencies

```
Task 1 (scaffolding)
  └→ Task 2 (move core)
       └→ Task 3 (MemoryService)
            ├→ Task 4 (MCP)
            ├→ Task 5 (REST)
            └→ Task 6 (CLI)
                 ├→ Task 7 (OpenClaw adapter)
                 ├→ Task 8 (MCP e2e test)
                 └→ Task 9 (REST e2e test)
                      └→ Task 10 (README + publish)
```

Tasks 4, 5, 6 can be parallelized after Task 3.
Tasks 7, 8, 9 can be parallelized after Task 6.
