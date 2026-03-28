#!/bin/bash
# Codex review with pre-loaded project context
# Usage: ./scripts/codex-review.sh [base-branch] [extra-instructions]

BASE="${1:-master}"
EXTRA="${2:-}"

CONTEXT="PROJECT CONTEXT (pre-loaded, do NOT re-read these files):
- Monorepo: @ultramemory/core (37 modules), @ultramemory/server (MCP+REST+CLI), @ultramemory/openclaw (adapter)
- RAG pipeline: 9 stages (query understanding, vector+BM25, RRF k=60, cross-encoder rerank, recency boost, length norm, hard cutoff, time decay, MMR lambda=0.7)
- Conventions: fail-open, add-then-delete updates, Bearer auth via ULTRAMEMORY_API_KEY, structured errors {error:{code,message}}
- Pre-existing: 14 type errors in packages/core/src/ (LanceDB type mismatches, accepted tech debt — do NOT flag these)
- Focus review on: packages/server/src/ and packages/openclaw/src/ only
- Tests: 17 tests in packages/server/test/ (must all pass)
- Key patterns: MemoryService is the single service layer, MCP/REST/OpenClaw are thin shells
- Known: store update is add-then-delete (not atomic), list() has fetchLimit cap, embedder retries 3x with backoff

${EXTRA}"

exec codex review --base "$BASE" -c 'model_reasoning_effort="xhigh"' --enable web_search_cached "$CONTEXT"
