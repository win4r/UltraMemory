# AGENTS.md — UltraMemory

Universal AI Agent Long-Term Memory Engine. This file is readable by any AI coding agent (Claude Code, Codex, Cursor, Cline, Jules).

## Architecture

Monorepo with 3 packages (pnpm workspaces):

- `packages/core/` — @ultramemory/core: 37 modules, framework-agnostic engine
- `packages/server/` — @ultramemory/server: MemoryService + MCP (6 tools) + REST (7 routes) + CLI
- `packages/openclaw/` — @ultramemory/openclaw: OpenClaw plugin adapter with hooks

Entry points:
- Server: `packages/server/src/service.ts` (MemoryService class)
- CLI: `packages/server/src/cli.ts` (ultramemory serve --mcp --http)
- Plugin: `packages/openclaw/index.ts` (register function)

## Testing

```bash
cd packages/server && npx tsx --test test/service.test.mjs test/mcp-e2e.test.mjs test/http-e2e.test.mjs
```
17 tests must pass. Core has 14 pre-existing type errors (accepted tech debt).

## Typecheck

```bash
pnpm typecheck  # runs server + openclaw only (core excluded due to pre-existing errors)
```

## Coding Conventions

- TypeScript, ESM (`"type": "module"`), `.js` extensions in imports (Node16 resolution)
- Fail-open pattern: duplicate detection, metadata patching, noise filtering never block operations
- Add-then-delete for updates: store new entry first, then delete old (duplicate beats data loss)
- All HTTP routes must validate input + return structured errors `{ "error": { "code", "message" } }`
- Bearer token auth via `ULTRAMEMORY_API_KEY` env var

## Key Design Decisions

- Storage: LanceDB only (embedded, zero-ops — core differentiator)
- Retrieval: 9-stage pipeline (query understanding, vector+BM25, RRF fusion, reranking, decay, MMR)
- Lifecycle: Weibull decay + 3-tier promotion (core/working/peripheral)
- Cross-encoder reranking hurts temporal QA — disabled by default for LoCoMo-style benchmarks

## Build

```bash
pnpm run build   # tsc to dist/ in each package
pnpm install     # install dependencies
```
