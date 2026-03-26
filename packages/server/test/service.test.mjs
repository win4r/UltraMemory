import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

// Shim `require` for ESM context (needed by store.ts's loadLanceDB)
if (typeof globalThis.require === "undefined") {
  globalThis.require = createRequire(import.meta.url);
}

const { MemoryService } = await import("../src/service.ts");

describe("MemoryService", () => {
  let service;
  let tempDir;

  after(async () => {
    if (service) await service.shutdown();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("initializes, stores, lists, stats, and forgets", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ultramemory-test-"));

    service = new MemoryService({
      dbPath: join(tempDir, "db"),
      embedding: {
        // Use a deterministic 4-dim embedding via SiliconFlow or fallback
        apiKey: process.env.OPENAI_API_KEY || "test-key",
        model: "text-embedding-3-small",
        baseURL: process.env.EMBEDDING_BASE_URL || "https://api.openai.com/v1",
        dimensions: 4,
      },
      smartExtraction: false,
      decay: { enabled: false },
    });

    await service.initialize();
    assert.ok(service.isReady(), "service should be ready after initialize");

    // Skip embed-dependent tests if no real API key
    if (!process.env.OPENAI_API_KEY && !process.env.EMBEDDING_BASE_URL) {
      console.log("  ⚠ Skipping store/recall tests — no OPENAI_API_KEY set");
      return;
    }

    // Store
    const storeResult = await service.store({
      text: "TypeScript is a typed superset of JavaScript",
      category: "fact",
      scope: "global",
      importance: 0.8,
    });
    assert.ok(storeResult.id, "store should return an id");
    assert.equal(storeResult.action, "created");

    // List
    const entries = await service.list({ limit: 10 });
    assert.ok(entries.length >= 1, "should have at least 1 memory");
    assert.ok(entries[0].text.includes("TypeScript"));

    // Stats
    const stats = await service.stats();
    assert.ok(stats.totalCount >= 1, "should count at least 1 memory");

    // Forget
    const id = entries[0].id;
    const forgetResult = await service.forget({ id });
    assert.equal(forgetResult.ok, true, "forget should succeed");

    const statsAfter = await service.stats();
    assert.equal(statsAfter.totalCount, 0, "should have 0 memories after forget");
  });
});
