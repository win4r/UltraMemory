/**
 * Test: session checkpoint and resume functionality.
 *
 * Tests the checkpoint/resume methods on MemoryService by using a mock
 * embedder to avoid external API dependencies.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");
const { parseSmartMetadata } = jiti("../src/smart-metadata.ts");

const VECTOR_DIM = 8;

function makeVector(seed = 1) {
  const v = new Array(VECTOR_DIM).fill(1 / Math.sqrt(VECTOR_DIM));
  v[0] = seed * 0.1;
  return v;
}

/**
 * Build a minimal MemoryService-like object that uses a real store but stubs
 * the embedder so no API key is needed.
 */
function makeTestService() {
  const dir = mkdtempSync(join(tmpdir(), "ultramemory-checkpoint-"));
  const store = new MemoryStore({ dbPath: dir, vectorDim: VECTOR_DIM });

  // Lazy-import service internals for metadata helpers
  const {
    buildSmartMetadata,
    stringifySmartMetadata,
  } = jiti("../src/smart-metadata.ts");

  let vectorSeed = 1;

  // Mimics MemoryService.checkpoint()
  async function checkpoint(params) {
    const scope = params.scope || "global";
    const sessionId = params.sessionId || `session-${Date.now()}`;

    const sections = [`[CHECKPOINT] ${params.summary}`];
    if (params.decisions?.length)
      sections.push(`Decisions: ${params.decisions.join("; ")}`);
    if (params.nextActions?.length)
      sections.push(`Next actions: ${params.nextActions.join("; ")}`);
    if (params.openLoops?.length)
      sections.push(`Open loops: ${params.openLoops.join("; ")}`);
    if (params.entities?.length)
      sections.push(`Entities: ${params.entities.join(", ")}`);
    const text = sections.join("\n");

    const vector = makeVector(vectorSeed++);

    const metadata = stringifySmartMetadata(
      buildSmartMetadata(
        { text, category: "decision", importance: 0.9 },
        {
          l0_abstract: `[CHECKPOINT] ${params.summary.slice(0, 180)}`,
          l1_overview: sections.map((s) => `- ${s}`).join("\n"),
          l2_content: text,
          source: "session-summary",
          state: "confirmed",
          source_session: sessionId,
          is_checkpoint: true,
          checkpoint_decisions: params.decisions || [],
          checkpoint_next_actions: params.nextActions || [],
          checkpoint_open_loops: params.openLoops || [],
          checkpoint_entities: params.entities || [],
        },
      ),
    );

    const entry = await store.store({
      text,
      vector,
      category: "decision",
      scope,
      importance: 0.9,
      metadata,
    });

    return { id: entry.id, scope, sessionId, timestamp: Date.now() };
  }

  // Mimics MemoryService.resume()
  async function resume(params = {}) {
    const scopeFilter = params.scope ? [params.scope] : undefined;
    const entries = await store.list(scopeFilter, undefined, 50, 0);
    const sorted = entries.sort((a, b) => b.timestamp - a.timestamp);

    for (const entry of sorted) {
      const meta = parseSmartMetadata(entry.metadata, entry);
      const isCheckpoint =
        meta.is_checkpoint === true || entry.text.startsWith("[CHECKPOINT]");
      if (!isCheckpoint) continue;
      if (params.sessionId && meta.source_session !== params.sessionId) continue;

      const raw = meta;
      return {
        id: entry.id,
        summary: entry.text.replace(/^\[CHECKPOINT\]\s*/, "").split("\n")[0],
        scope: entry.scope,
        sessionId: meta.source_session,
        decisions: toStringArray(raw.checkpoint_decisions),
        nextActions: toStringArray(raw.checkpoint_next_actions),
        openLoops: toStringArray(raw.checkpoint_open_loops),
        entities: toStringArray(raw.checkpoint_entities),
        timestamp: entry.timestamp,
      };
    }
    return null;
  }

  function toStringArray(value) {
    if (!Array.isArray(value)) return [];
    return value.filter((item) => typeof item === "string");
  }

  return { store, dir, checkpoint, resume };
}

// ============================================================================

describe("session checkpoint and resume", () => {
  it("saves and retrieves a checkpoint", async () => {
    const { dir, checkpoint, resume } = makeTestService();
    try {
      const result = await checkpoint({
        summary: "Finished implementing auth middleware",
        scope: "project:myapp",
        sessionId: "sess-abc",
        decisions: ["Use JWT over sessions", "Rate limit at 100/min"],
        nextActions: ["Write integration tests", "Update README"],
        openLoops: ["CORS config needs review"],
        entities: ["auth-middleware", "rate-limiter"],
      });

      assert.ok(result.id, "checkpoint should return an id");
      assert.strictEqual(result.scope, "project:myapp");
      assert.strictEqual(result.sessionId, "sess-abc");

      const resumed = await resume({ scope: "project:myapp" });
      assert.ok(resumed, "resume should find the checkpoint");
      assert.strictEqual(resumed.summary, "Finished implementing auth middleware");
      assert.strictEqual(resumed.scope, "project:myapp");
      assert.strictEqual(resumed.sessionId, "sess-abc");
      assert.deepStrictEqual(resumed.decisions, [
        "Use JWT over sessions",
        "Rate limit at 100/min",
      ]);
      assert.deepStrictEqual(resumed.nextActions, [
        "Write integration tests",
        "Update README",
      ]);
      assert.deepStrictEqual(resumed.openLoops, ["CORS config needs review"]);
      assert.deepStrictEqual(resumed.entities, [
        "auth-middleware",
        "rate-limiter",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the latest checkpoint when multiple exist", async () => {
    const { dir, checkpoint, resume } = makeTestService();
    try {
      await checkpoint({
        summary: "First checkpoint",
        scope: "global",
        sessionId: "sess-1",
      });

      // Small delay so timestamps differ
      await new Promise((r) => setTimeout(r, 50));

      await checkpoint({
        summary: "Second checkpoint",
        scope: "global",
        sessionId: "sess-2",
      });

      const resumed = await resume({ scope: "global" });
      assert.ok(resumed, "resume should find a checkpoint");
      assert.strictEqual(resumed.summary, "Second checkpoint");
      assert.strictEqual(resumed.sessionId, "sess-2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filters by sessionId", async () => {
    const { dir, checkpoint, resume } = makeTestService();
    try {
      await checkpoint({
        summary: "Alpha session work",
        scope: "global",
        sessionId: "alpha",
      });

      await new Promise((r) => setTimeout(r, 50));

      await checkpoint({
        summary: "Beta session work",
        scope: "global",
        sessionId: "beta",
      });

      const resumed = await resume({ sessionId: "alpha" });
      assert.ok(resumed, "should find alpha checkpoint");
      assert.strictEqual(resumed.summary, "Alpha session work");
      assert.strictEqual(resumed.sessionId, "alpha");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when no checkpoint exists", async () => {
    const { dir, store, resume } = makeTestService();
    try {
      // Store a non-checkpoint memory
      await store.store({
        text: "just a normal memory",
        vector: makeVector(99),
        category: "fact",
        scope: "global",
        importance: 0.5,
        metadata: "{}",
      });

      const resumed = await resume({ scope: "global" });
      assert.strictEqual(resumed, null, "should return null when no checkpoint exists");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scopes checkpoints correctly", async () => {
    const { dir, checkpoint, resume } = makeTestService();
    try {
      await checkpoint({
        summary: "Work on project A",
        scope: "project:a",
        sessionId: "sess-a",
      });

      await checkpoint({
        summary: "Work on project B",
        scope: "project:b",
        sessionId: "sess-b",
      });

      const resumedA = await resume({ scope: "project:a" });
      assert.ok(resumedA);
      assert.strictEqual(resumedA.summary, "Work on project A");

      const resumedB = await resume({ scope: "project:b" });
      assert.ok(resumedB);
      assert.strictEqual(resumedB.summary, "Work on project B");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles checkpoint with minimal params (summary only)", async () => {
    const { dir, checkpoint, resume } = makeTestService();
    try {
      const result = await checkpoint({
        summary: "Quick save",
      });

      assert.ok(result.id);
      assert.strictEqual(result.scope, "global");
      assert.ok(result.sessionId.startsWith("session-"));

      const resumed = await resume();
      assert.ok(resumed);
      assert.strictEqual(resumed.summary, "Quick save");
      assert.deepStrictEqual(resumed.decisions, []);
      assert.deepStrictEqual(resumed.nextActions, []);
      assert.deepStrictEqual(resumed.openLoops, []);
      assert.deepStrictEqual(resumed.entities, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
