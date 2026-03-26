/**
 * REST API for UltraMemory — Hono-based HTTP adapter.
 *
 * Delegates all operations to MemoryService.
 */

import { Hono } from "hono";
import type { MemoryService } from "./service.js";

/**
 * Parse a comma-separated scope string into an array, or return undefined.
 */
function parseScopeFilter(scope: string | undefined): string[] | undefined {
  if (!scope) return undefined;
  return scope
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function createHttpApp(service: MemoryService): Hono {
  const app = new Hono();

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  app.get("/health", (c) => {
    return c.json({ status: "ok", version: "0.1.0" });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/memory — store
  // -------------------------------------------------------------------------

  app.post("/api/v1/memory", async (c) => {
    const body = await c.req.json();
    const result = await service.store({
      text: body.text,
      category: body.category,
      scope: body.scope,
      importance: body.importance,
    });
    return c.json(result, 201);
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/memory/recall — recall
  // -------------------------------------------------------------------------

  app.get("/api/v1/memory/recall", async (c) => {
    const query = c.req.query("query") ?? "";
    const limit = c.req.query("limit");
    const scope = c.req.query("scope");
    const category = c.req.query("category");

    const results = await service.recall({
      query,
      limit: limit ? Number(limit) : undefined,
      scopeFilter: parseScopeFilter(scope),
      category: category || undefined,
    });

    return c.json(results, 200);
  });

  // -------------------------------------------------------------------------
  // PATCH /api/v1/memory/:id — update
  // -------------------------------------------------------------------------

  app.patch("/api/v1/memory/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();

    const result = await service.update({
      id,
      text: body.text,
      importance: body.importance,
      category: body.category,
    });

    if (!result.ok) {
      return c.json(result, 404);
    }
    return c.json(result, 200);
  });

  // -------------------------------------------------------------------------
  // DELETE /api/v1/memory/:id — forget
  // -------------------------------------------------------------------------

  app.delete("/api/v1/memory/:id", async (c) => {
    const id = c.req.param("id");
    const result = await service.forget({ id });

    if (!result.ok) {
      return c.json(result, 404);
    }
    return c.json(result, 200);
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/memory — list
  // -------------------------------------------------------------------------

  app.get("/api/v1/memory", async (c) => {
    const limit = c.req.query("limit");
    const offset = c.req.query("offset");
    const scope = c.req.query("scope");
    const category = c.req.query("category");

    const results = await service.list({
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      scopeFilter: parseScopeFilter(scope),
      category: category || undefined,
    });

    return c.json(results, 200);
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/stats — stats
  // -------------------------------------------------------------------------

  app.get("/api/v1/stats", async (c) => {
    const scope = c.req.query("scope");
    const result = await service.stats(parseScopeFilter(scope));
    return c.json(result, 200);
  });

  return app;
}
