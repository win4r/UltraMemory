import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Shim require for ESM context
if (typeof globalThis.require === "undefined") {
  globalThis.require = createRequire(import.meta.url);
}

const { createHttpApp } = await import("../src/http.ts");

describe("REST API routes", () => {
  it("creates an app without error", () => {
    const mockService = {};
    const app = createHttpApp(mockService);
    assert.ok(app, "should create Hono app");
  });

  // ---------------------------------------------------------------------------
  // GET /health
  // ---------------------------------------------------------------------------

  it("GET /health returns ok", async () => {
    const mockService = {};
    const app = createHttpApp(mockService);
    const res = await app.request("/health");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.version, "0.1.0");
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/memory — store
  // ---------------------------------------------------------------------------

  it("POST /api/v1/memory delegates to service.store()", async () => {
    let captured;
    const mockService = {
      store: async (params) => {
        captured = params;
        return {
          id: "new-id",
          action: "created",
          scope: params.scope || "global",
          category: params.category || "fact",
          importance: params.importance ?? 0.8,
        };
      },
    };
    const app = createHttpApp(mockService);
    const res = await app.request("/api/v1/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "test memory",
        category: "fact",
        scope: "agent:test",
        importance: 0.9,
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.id, "new-id");
    assert.equal(body.action, "created");
    // Verify the service received the correct params
    assert.equal(captured.text, "test memory");
    assert.equal(captured.category, "fact");
    assert.equal(captured.scope, "agent:test");
    assert.equal(captured.importance, 0.9);
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/memory/recall — recall
  // ---------------------------------------------------------------------------

  it("GET /api/v1/memory/recall delegates to service.recall()", async () => {
    let captured;
    const mockService = {
      recall: async (params) => {
        captured = params;
        return [
          { id: "r1", text: "recalled", category: "fact", scope: "global", importance: 0.8, score: 0.95, timestamp: 1000 },
        ];
      },
    };
    const app = createHttpApp(mockService);
    const res = await app.request("/api/v1/memory/recall?query=hello&limit=3&scope=global,agent:test&category=fact");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.equal(body[0].id, "r1");
    assert.equal(body[0].score, 0.95);
    // Verify parsed params
    assert.equal(captured.query, "hello");
    assert.equal(captured.limit, 3);
    assert.deepEqual(captured.scopeFilter, ["global", "agent:test"]);
    assert.equal(captured.category, "fact");
  });

  it("GET /api/v1/memory/recall rejects empty query with 400", async () => {
    const mockService = {};
    const app = createHttpApp(mockService);
    const res = await app.request("/api/v1/memory/recall");
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error);
  });

  // ---------------------------------------------------------------------------
  // PATCH /api/v1/memory/:id — update
  // ---------------------------------------------------------------------------

  it("PATCH /api/v1/memory/:id delegates to service.update()", async () => {
    let captured;
    const mockService = {
      update: async (params) => {
        captured = params;
        return { ok: true, id: params.id, fieldsUpdated: ["text", "importance"] };
      },
    };
    const app = createHttpApp(mockService);
    const res = await app.request("/api/v1/memory/entry-42", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "updated text", importance: 0.5 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.id, "entry-42");
    assert.deepEqual(body.fieldsUpdated, ["text", "importance"]);
    // Verify params passed to service
    assert.equal(captured.id, "entry-42");
    assert.equal(captured.text, "updated text");
    assert.equal(captured.importance, 0.5);
  });

  it("PATCH /api/v1/memory/:id returns 404 when not found", async () => {
    const mockService = {
      update: async () => ({ ok: false, id: "missing", fieldsUpdated: [] }),
    };
    const app = createHttpApp(mockService);
    const res = await app.request("/api/v1/memory/missing", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "nope" }),
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error);
    assert.equal(body.error.code, "NOT_FOUND");
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/v1/memory/:id — forget
  // ---------------------------------------------------------------------------

  it("DELETE /api/v1/memory/:id delegates to service.forget()", async () => {
    let captured;
    const mockService = {
      forget: async (params) => {
        captured = params;
        return { ok: true };
      },
    };
    const app = createHttpApp(mockService);
    const res = await app.request("/api/v1/memory/some-id", { method: "DELETE" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(captured.id, "some-id");
  });

  it("DELETE /api/v1/memory/:id returns 404 when not found", async () => {
    const mockService = {
      forget: async () => ({ ok: false }),
    };
    const app = createHttpApp(mockService);
    const res = await app.request("/api/v1/memory/gone", { method: "DELETE" });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error);
    assert.equal(body.error.code, "NOT_FOUND");
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/memory — list
  // ---------------------------------------------------------------------------

  it("GET /api/v1/memory delegates to service.list()", async () => {
    let captured;
    const mockService = {
      list: async (params) => {
        captured = params;
        return [
          { id: "abc", text: "hello", category: "fact", scope: "global", importance: 0.8, timestamp: 1000 },
        ];
      },
    };
    const app = createHttpApp(mockService);
    const res = await app.request("/api/v1/memory?limit=5&offset=10&scope=global&category=fact");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.equal(body[0].id, "abc");
    // Verify parsed params
    assert.equal(captured.limit, 5);
    assert.equal(captured.offset, 10);
    assert.deepEqual(captured.scopeFilter, ["global"]);
    assert.equal(captured.category, "fact");
  });

  it("GET /api/v1/memory passes undefined for missing query params", async () => {
    let captured;
    const mockService = {
      list: async (params) => {
        captured = params;
        return [];
      },
    };
    const app = createHttpApp(mockService);
    const res = await app.request("/api/v1/memory");
    assert.equal(res.status, 200);
    assert.equal(captured.limit, undefined);
    assert.equal(captured.offset, undefined);
    assert.equal(captured.scopeFilter, undefined);
    assert.equal(captured.category, undefined);
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/stats — stats
  // ---------------------------------------------------------------------------

  it("GET /api/v1/stats delegates to service.stats()", async () => {
    let captured;
    const mockService = {
      stats: async (scopeFilter) => {
        captured = scopeFilter;
        return { totalCount: 42, scopeCounts: { global: 42 }, categoryCounts: { fact: 42 } };
      },
    };
    const app = createHttpApp(mockService);
    const res = await app.request("/api/v1/stats");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.totalCount, 42);
    assert.deepEqual(body.scopeCounts, { global: 42 });
    assert.deepEqual(body.categoryCounts, { fact: 42 });
    // No scope filter provided
    assert.equal(captured, undefined);
  });

  it("GET /api/v1/stats parses scope filter", async () => {
    let captured;
    const mockService = {
      stats: async (scopeFilter) => {
        captured = scopeFilter;
        return { totalCount: 10, scopeCounts: {}, categoryCounts: {} };
      },
    };
    const app = createHttpApp(mockService);
    const res = await app.request("/api/v1/stats?scope=global,agent:test");
    assert.equal(res.status, 200);
    assert.deepEqual(captured, ["global", "agent:test"]);
  });
});
