# UltraMemory Design Spec

> Universal AI Agent Long-Term Memory Engine

**Date**: 2026-03-26
**Status**: Approved
**Origin**: mlp-forge (memory-lancedb-pro) refactor into universal agent memory

---

## Problem

mlp-forge has a mature memory engine (LanceDB storage, hybrid Vector+BM25 retrieval, cross-encoder reranking, Weibull decay, LLM smart extraction, semantic dedup, L0/L1/L2 tiered content, 6-category classification) but its interface is locked to OpenClaw's plugin SDK. No other agent framework (Claude Code, Cursor, Codex, AutoGen, CrewAI) can use it.

## Solution

Refactor into a monorepo with three packages:
- **@ultramemory/core** — framework-agnostic memory engine (existing `src/` modules, unchanged logic)
- **@ultramemory/server** — MCP + REST server exposing the engine to any agent
- **@ultramemory/openclaw** — thin OpenClaw adapter for backward compatibility

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Package structure | Monorepo (pnpm workspace) | Core and server co-evolve rapidly |
| OpenClaw compat | Separate adapter package | Zero migration cost for existing users |
| Interfaces | MCP + REST simultaneously | Share one service layer, both are thin shells |
| Embedding backend | OpenAI SDK only | Already supports any OpenAI-compatible endpoint via baseURL |
| Storage backend | LanceDB only | Embedded/zero-ops is the core differentiator, YAGNI |
| Project name | UltraMemory | Not tied to any specific technology |

## Architecture

```
┌─────────────────────────────────────────────────┐
│              Interface Layer                     │
│  ┌───────────┐  ┌───────────┐  ┌──────────────┐ │
│  │ MCP Server│  │ REST API  │  │ OpenClaw     │ │
│  │ (stdio/sse)│  │ (:1933)   │  │ Adapter      │ │
│  └─────┬─────┘  └─────┬─────┘  └──────┬───────┘ │
│        └───────────────┼───────────────┘         │
│                  ┌─────▼─────┐                   │
│                  │MemoryService│                  │
│                  └─────┬─────┘                   │
├────────────────────────┼─────────────────────────┤
│              Core Engine (unchanged)             │
│  store │ retriever │ embedder │ decay-engine     │
│  smart-extractor │ tier-manager │ chunker        │
│  smart-metadata │ reflection-store │ scopes      │
└─────────────────────────────────────────────────┘
```

## Package Structure

```
ultramemory/
├── packages/
│   ├── core/                    # @ultramemory/core
│   │   ├── src/
│   │   │   ├── store.ts                # LanceDB storage layer
│   │   │   ├── retriever.ts            # Hybrid Vector+BM25 retrieval
│   │   │   ├── embedder.ts             # Embedding with chunking
│   │   │   ├── decay-engine.ts         # Weibull decay model
│   │   │   ├── tier-manager.ts         # Core/Working/Peripheral promotion
│   │   │   ├── smart-extractor.ts      # LLM-driven 6-category extraction
│   │   │   ├── smart-metadata.ts       # L0/L1/L2 metadata management
│   │   │   ├── chunker.ts             # Long-context chunking
│   │   │   ├── memory-categories.ts   # 6-category classification
│   │   │   ├── noise-filter.ts        # Auto-capture noise filtering
│   │   │   ├── scopes.ts             # Multi-scope isolation
│   │   │   ├── llm-client.ts         # LLM client for extraction/dedup
│   │   │   ├── admission-control.ts   # Quality gate for memory writes
│   │   │   └── ...remaining src/ modules
│   │   ├── index.ts              # Public API exports
│   │   └── package.json
│   │
│   ├── server/                  # @ultramemory/server
│   │   ├── src/
│   │   │   ├── service.ts             # MemoryService (business logic from index.ts)
│   │   │   ├── mcp.ts                 # MCP stdio/SSE adapter
│   │   │   ├── http.ts               # REST API (Hono)
│   │   │   ├── tools.ts              # Tool definitions (from src/tools.ts)
│   │   │   └── cli.ts                # CLI entry point
│   │   └── package.json
│   │
│   └── openclaw/                # @ultramemory/openclaw
│       ├── src/
│       │   └── adapter.ts             # OpenClaw plugin wrapper
│       ├── index.ts              # Plugin entry (register function)
│       └── package.json
│
├── pnpm-workspace.yaml
├── package.json                  # Workspace root
├── turbo.json                    # Build orchestration
└── README.md
```

## MemoryService Interface

The central abstraction shared by all interface layers:

```typescript
interface UltraMemoryConfig {
  dbPath?: string;           // default: ~/.ultramemory/db
  embedding: {
    apiKey: string;
    model?: string;          // default: text-embedding-3-small
    baseURL?: string;        // default: https://api.openai.com/v1
    dimensions?: number;     // default: 1536
  };
  llm?: {
    apiKey?: string;         // defaults to embedding.apiKey
    model?: string;          // default: gpt-4o-mini
    baseURL?: string;
  };
  smartExtraction?: boolean; // default: true
  decay?: {
    enabled?: boolean;       // default: true
    halfLifeDays?: number;   // default: 14
  };
  scopes?: string[];         // default: ["global"]
}

class MemoryService {
  constructor(config: UltraMemoryConfig)

  // Lifecycle
  async initialize(): Promise<void>
  async shutdown(): Promise<void>

  // Core CRUD
  async store(params: {
    text: string;
    category?: string;
    scope?: string;
    importance?: number;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string }>

  async recall(params: {
    query: string;
    limit?: number;
    scopeFilter?: string[];
    category?: string;
  }): Promise<Array<{ id: string; text: string; score: number; metadata: Record<string, unknown> }>>

  async update(params: {
    id: string;
    text?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ ok: boolean }>

  async forget(params: {
    id: string;
  }): Promise<{ ok: boolean }>

  // Management
  async list(params?: {
    scopeFilter?: string[];
    category?: string;
    limit?: number;
    offset?: number;
  }): Promise<Array<{ id: string; text: string; category: string; scope: string; importance: number; timestamp: number }>>

  async stats(): Promise<{
    totalMemories: number;
    byCategory: Record<string, number>;
    byScope: Record<string, number>;
    dbSizeBytes: number;
  }>

  // Advanced
  async extractFromConversation(messages: Array<{
    role: string;
    content: string;
  }>): Promise<{ created: number; merged: number; skipped: number }>

  async runLifecycleMaintenance(): Promise<{
    decayed: number;
    promoted: number;
    demoted: number;
  }>
}
```

## MCP Tools

6 tools exposed via MCP protocol:

| Tool | Description | Key Params |
|------|-------------|------------|
| `memory_store` | Store a new memory | text, category?, scope?, importance? |
| `memory_recall` | Semantic search for relevant memories | query, limit?, scopeFilter?, category? |
| `memory_update` | Update memory content or metadata | id, text?, metadata? |
| `memory_forget` | Delete a memory | id |
| `memory_list` | List memories with filters | scopeFilter?, category?, limit?, offset? |
| `memory_stats` | Storage statistics | (none) |

## REST API

```
POST   /api/v1/memory          → store
GET    /api/v1/memory/recall    → recall (?query=&limit=&scope=)
PATCH  /api/v1/memory/:id       → update
DELETE /api/v1/memory/:id       → forget
GET    /api/v1/memory           → list (?scope=&category=&limit=&offset=)
GET    /api/v1/stats            → stats
GET    /health                  → health check
```

## CLI Usage

```bash
# Install
npm install -g @ultramemory/server

# MCP mode (for Claude Code, Cursor, Windsurf)
ultramemory serve --mcp

# REST mode
ultramemory serve --http --port 1933

# Both simultaneously
ultramemory serve --mcp --http

# Configuration
ultramemory serve --mcp --db-path ~/.ultramemory/db \
  --embedding-api-key $OPENAI_API_KEY \
  --embedding-model text-embedding-3-small
```

Config file (`~/.ultramemory/config.json`):
```json
{
  "dbPath": "~/.ultramemory/db",
  "embedding": {
    "apiKey": "${OPENAI_API_KEY}",
    "model": "text-embedding-3-small"
  },
  "smartExtraction": true,
  "decay": { "enabled": true }
}
```

## Claude Code Integration

```json
// ~/.claude/settings.json
{
  "mcpServers": {
    "memory": {
      "command": "ultramemory",
      "args": ["serve", "--mcp"],
      "env": {
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

## Migration Strategy

### Phase 1: Extract core (no behavior change)
- Move `src/*.ts` → `packages/core/src/`
- Adjust import paths
- Export public API from `packages/core/index.ts`
- Verify all existing tests pass against core package

### Phase 2: Build service layer
- Extract business logic from `index.ts` into `MemoryService`
- Map existing tool handlers (from `src/tools.ts`) to service methods
- Verify behavior parity with existing plugin

### Phase 3: Add MCP + REST interfaces
- Implement MCP server using `@modelcontextprotocol/sdk`
- Implement REST API using Hono
- CLI entry point with commander

### Phase 4: OpenClaw adapter
- Slim down `index.ts` to thin wrapper calling `MemoryService`
- Keep all existing hooks (agent_end, before_prompt_build, etc.)
- Verify OpenClaw integration still works

### Phase 5: Publish
- Configure npm publishing for all 3 packages
- Update README with universal usage instructions
- Publish `@ultramemory/core`, `@ultramemory/server`, `@ultramemory/openclaw`

## What We Are NOT Doing

- No storage backend abstraction (LanceDB only)
- No embedding provider abstraction (OpenAI SDK only)
- No filesystem paradigm (viking:// paths)
- No Python SDK
- No Web UI
- No multi-tenancy beyond existing scope isolation
- No breaking changes to existing LanceDB schema

## Success Criteria

1. `npx @ultramemory/server --mcp` starts a working MCP server
2. Claude Code can `memory_store` and `memory_recall` via MCP
3. `curl localhost:1933/api/v1/memory/recall?query=...` returns results
4. Existing OpenClaw users install `@ultramemory/openclaw` with zero config change
5. All existing tests pass
6. Existing LanceDB databases work without migration
