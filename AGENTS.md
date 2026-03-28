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

## Agent Self-Store Guidance

Agents using UltraMemory should **proactively** call `memory_store` during a conversation, not only at the end. The tool description includes inline guidance, but the principles are summarized here for system prompt authors and agent framework integrators.

### When to store (during the conversation)

| Trigger | Category | Importance | Example |
|---------|----------|------------|---------|
| Reusable pattern or solution discovered | `decision` or `fact` | 0.8+ | "LanceDB requires `--legacy-peer-deps` when installing on Node 22" |
| User confirms a non-obvious preference | `preference` | 0.8 | "User prefers snake_case for all DB column names" |
| Corrected misconception | `reflection` | 0.85 | "Corrected: scope isolation is per-agent, not per-session" |
| Complex problem resolved | `fact` or `decision` | 0.8 | "Root cause: stale vector cache after compaction; fix: call `optimizeTable()` after delete" |

### When NOT to store

- Greetings, small talk, or filler
- Transient task status ("currently running tests")
- Information that is already in memory (auto-deduplicated at 0.98 cosine similarity)
- Common-sense knowledge that any model already knows

### Implementation notes

- The guidance lives in the `memory_store` tool description (`src/tools.ts`, `packages/core/src/tools.ts`, `packages/server/src/tools.ts`). Most MCP/tool-use frameworks surface tool descriptions in the system prompt automatically, so agents see the guidance without extra configuration.
- No code logic changes are required — this is purely a prompt-level intervention.
- The noise filter (`isNoise()`) will reject obvious junk even if an agent stores too eagerly.

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
