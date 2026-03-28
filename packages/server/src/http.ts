/**
 * REST API for UltraMemory — Hono-based HTTP adapter.
 *
 * Delegates all operations to MemoryService.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { MemoryService } from "./service.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_CATEGORIES = [
  "preference",
  "fact",
  "decision",
  "entity",
  "reflection",
  "other",
] as const;

const MAX_TEXT_LENGTH = 50_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 100;

// ---------------------------------------------------------------------------
// Structured error helper
// ---------------------------------------------------------------------------

interface ErrorBody {
  error: { code: string; message: string };
}

function errorJson(
  code: string,
  message: string,
): ErrorBody {
  return { error: { code, message } };
}

// ---------------------------------------------------------------------------
// In-memory rate limiter (per IP)
// ---------------------------------------------------------------------------

const hits = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = hits.get(ip);

  if (!entry || now >= entry.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

// Periodic cleanup so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hits) {
    if (now >= entry.resetAt) hits.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS).unref?.();

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

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

function toFiniteNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

export function createHttpApp(service: MemoryService): Hono {
  const app = new Hono();

  // -----------------------------------------------------------------------
  // CORS
  // -----------------------------------------------------------------------

  app.use("*", cors());

  // -----------------------------------------------------------------------
  // Bearer-token auth middleware
  // -----------------------------------------------------------------------

  const apiKey = process.env.ULTRAMEMORY_API_KEY;

  app.use("/api/*", async (c, next) => {
    if (!apiKey) return next(); // dev mode — auth disabled

    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";

    if (token !== apiKey) {
      return c.json(errorJson("UNAUTHORIZED", "invalid or missing bearer token"), 401);
    }
    return next();
  });

  // -----------------------------------------------------------------------
  // Rate limiting middleware
  // -----------------------------------------------------------------------

  app.use("/api/*", async (c, next) => {
    // Hono exposes the remote address differently depending on the adapter;
    // fall back to a constant so the limiter still works in test harnesses.
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      "unknown";

    if (isRateLimited(ip)) {
      return c.json(
        errorJson("RATE_LIMITED", "too many requests — limit 100/min"),
        429,
      );
    }
    return next();
  });

  // -----------------------------------------------------------------------
  // Health
  // -----------------------------------------------------------------------

  app.get("/health", (c) => {
    return c.json({ status: "ok", version: "0.1.0" });
  });

  // -----------------------------------------------------------------------
  // POST /api/v1/memory — store
  // -----------------------------------------------------------------------

  app.post("/api/v1/memory", async (c) => {
    try {
      const body = await c.req.json().catch(() => null);
      if (!body || typeof body !== "object") {
        return c.json(errorJson("VALIDATION_ERROR", "request body must be JSON"), 400);
      }

      // text — required, string, max length
      if (typeof body.text !== "string" || body.text.trim() === "") {
        return c.json(errorJson("VALIDATION_ERROR", "text is required"), 400);
      }
      if (body.text.length > MAX_TEXT_LENGTH) {
        return c.json(
          errorJson("VALIDATION_ERROR", `text exceeds max length of ${MAX_TEXT_LENGTH} characters`),
          400,
        );
      }

      // category — optional, must be one of the valid values
      if (body.category !== undefined) {
        if (!(VALID_CATEGORIES as readonly string[]).includes(body.category)) {
          return c.json(
            errorJson("VALIDATION_ERROR", `category must be one of: ${VALID_CATEGORIES.join(", ")}`),
            400,
          );
        }
      }

      // importance — optional, number 0-1
      if (body.importance !== undefined) {
        if (typeof body.importance !== "number" || !Number.isFinite(body.importance)) {
          return c.json(errorJson("VALIDATION_ERROR", "importance must be a number"), 400);
        }
        if (body.importance < 0 || body.importance > 1) {
          return c.json(errorJson("VALIDATION_ERROR", "importance must be between 0 and 1"), 400);
        }
      }

      const result = await service.store({
        text: body.text,
        category: body.category,
        scope: body.scope,
        importance: body.importance,
      });

      return c.json(result, 201, {
        Location: `/api/v1/memory/${result.id}`,
      });
    } catch (err) {
      return c.json(errorJson("INTERNAL_ERROR", "an unexpected error occurred"), 500);
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/v1/memory/recall — recall
  // -----------------------------------------------------------------------

  app.get("/api/v1/memory/recall", async (c) => {
    try {
      const query = c.req.query("query");
      const limitRaw = c.req.query("limit");
      const scope = c.req.query("scope");
      const category = c.req.query("category");
      const depth = c.req.query("depth") as "l0" | "l1" | "l2" | "full" | undefined;

      // query — required
      if (!query || query.trim() === "") {
        return c.json(errorJson("VALIDATION_ERROR", "query is required"), 400);
      }

      // limit — optional, 1-20
      const limit = toFiniteNumber(limitRaw);
      if (limitRaw !== undefined) {
        if (limit === undefined || !Number.isInteger(limit) || limit < 1 || limit > 20) {
          return c.json(errorJson("VALIDATION_ERROR", "limit must be an integer between 1 and 20"), 400);
        }
      }

      // depth — optional, must be l0/l1/l2/full
      if (depth !== undefined && !["l0", "l1", "l2", "full"].includes(depth)) {
        return c.json(errorJson("VALIDATION_ERROR", "depth must be one of: l0, l1, l2, full"), 400);
      }

      const results = await service.recall({
        query,
        limit: limit ?? undefined,
        scopeFilter: parseScopeFilter(scope),
        category: category || undefined,
        depth,
      });

      return c.json(results, 200);
    } catch (err) {
      return c.json(errorJson("INTERNAL_ERROR", "an unexpected error occurred"), 500);
    }
  });

  // -----------------------------------------------------------------------
  // PATCH /api/v1/memory/:id — update
  // -----------------------------------------------------------------------

  app.patch("/api/v1/memory/:id", async (c) => {
    try {
      const id = c.req.param("id");

      const body = await c.req.json().catch(() => null);
      if (!body || typeof body !== "object") {
        return c.json(errorJson("VALIDATION_ERROR", "request body must be JSON"), 400);
      }

      // At least one updatable field required
      const hasText = body.text !== undefined;
      const hasImportance = body.importance !== undefined;
      const hasCategory = body.category !== undefined;

      if (!hasText && !hasImportance && !hasCategory) {
        return c.json(
          errorJson("VALIDATION_ERROR", "at least one field (text, importance, category) is required"),
          400,
        );
      }

      // text
      if (hasText) {
        if (typeof body.text !== "string" || body.text.trim() === "") {
          return c.json(errorJson("VALIDATION_ERROR", "text must be a non-empty string"), 400);
        }
        if (body.text.length > MAX_TEXT_LENGTH) {
          return c.json(
            errorJson("VALIDATION_ERROR", `text exceeds max length of ${MAX_TEXT_LENGTH} characters`),
            400,
          );
        }
      }

      // category
      if (hasCategory) {
        if (!(VALID_CATEGORIES as readonly string[]).includes(body.category)) {
          return c.json(
            errorJson("VALIDATION_ERROR", `category must be one of: ${VALID_CATEGORIES.join(", ")}`),
            400,
          );
        }
      }

      // importance
      if (hasImportance) {
        if (typeof body.importance !== "number" || !Number.isFinite(body.importance)) {
          return c.json(errorJson("VALIDATION_ERROR", "importance must be a number"), 400);
        }
        if (body.importance < 0 || body.importance > 1) {
          return c.json(errorJson("VALIDATION_ERROR", "importance must be between 0 and 1"), 400);
        }
      }

      const result = await service.update({
        id,
        text: body.text,
        importance: body.importance,
        category: body.category,
      });

      if (!result.ok) {
        return c.json(errorJson("NOT_FOUND", `memory ${id} not found`), 404);
      }
      return c.json(result, 200);
    } catch (err) {
      return c.json(errorJson("INTERNAL_ERROR", "an unexpected error occurred"), 500);
    }
  });

  // -----------------------------------------------------------------------
  // DELETE /api/v1/memory/:id — forget
  // -----------------------------------------------------------------------

  app.delete("/api/v1/memory/:id", async (c) => {
    try {
      const id = c.req.param("id");

      if (!id || id.trim() === "") {
        return c.json(errorJson("VALIDATION_ERROR", "id is required"), 400);
      }

      const result = await service.forget({ id });

      if (!result.ok) {
        return c.json(errorJson("NOT_FOUND", `memory ${id} not found`), 404);
      }
      return c.json(result, 200);
    } catch (err) {
      return c.json(errorJson("INTERNAL_ERROR", "an unexpected error occurred"), 500);
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/v1/memory — list
  // -----------------------------------------------------------------------

  app.get("/api/v1/memory", async (c) => {
    try {
      const limitRaw = c.req.query("limit");
      const offsetRaw = c.req.query("offset");
      const scope = c.req.query("scope");
      const category = c.req.query("category");

      const limit = toFiniteNumber(limitRaw);
      if (limitRaw !== undefined) {
        if (limit === undefined || !Number.isInteger(limit) || limit < 1 || limit > 20) {
          return c.json(errorJson("VALIDATION_ERROR", "limit must be an integer between 1 and 20"), 400);
        }
      }

      const offset = toFiniteNumber(offsetRaw);
      if (offsetRaw !== undefined) {
        if (offset === undefined || !Number.isInteger(offset) || offset < 0 || offset > 10_000) {
          return c.json(
            errorJson("VALIDATION_ERROR", "offset must be an integer between 0 and 10000"),
            400,
          );
        }
      }

      const results = await service.list({
        limit: limit ?? undefined,
        offset: offset ?? undefined,
        scopeFilter: parseScopeFilter(scope),
        category: category || undefined,
      });

      return c.json(results, 200);
    } catch (err) {
      return c.json(errorJson("INTERNAL_ERROR", "an unexpected error occurred"), 500);
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/v1/checkpoint — save session checkpoint
  // -----------------------------------------------------------------------

  app.post("/api/v1/checkpoint", async (c) => {
    try {
      const body = await c.req.json().catch(() => null);
      if (!body || typeof body !== "object") {
        return c.json(errorJson("VALIDATION_ERROR", "request body must be JSON"), 400);
      }

      if (typeof body.summary !== "string" || body.summary.trim() === "") {
        return c.json(errorJson("VALIDATION_ERROR", "summary is required"), 400);
      }
      if (body.summary.length > MAX_TEXT_LENGTH) {
        return c.json(
          errorJson("VALIDATION_ERROR", `summary exceeds max length of ${MAX_TEXT_LENGTH} characters`),
          400,
        );
      }

      const result = await service.checkpoint({
        summary: body.summary,
        scope: body.scope,
        sessionId: body.sessionId,
        decisions: body.decisions,
        nextActions: body.nextActions,
        openLoops: body.openLoops,
        entities: body.entities,
      });

      return c.json(result, 201);
    } catch (err) {
      return c.json(errorJson("INTERNAL_ERROR", "an unexpected error occurred"), 500);
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/v1/checkpoint/latest — resume latest checkpoint
  // -----------------------------------------------------------------------

  app.get("/api/v1/checkpoint/latest", async (c) => {
    try {
      const scope = c.req.query("scope");
      const sessionId = c.req.query("sessionId");

      const result = await service.resume({
        scope: scope || undefined,
        sessionId: sessionId || undefined,
      });

      if (!result) {
        return c.json(errorJson("NOT_FOUND", "no checkpoint found"), 404);
      }

      return c.json(result, 200);
    } catch (err) {
      return c.json(errorJson("INTERNAL_ERROR", "an unexpected error occurred"), 500);
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/v1/memory/:id/provenance — provenance query (Gemini-inspired)
  // -----------------------------------------------------------------------

  app.get("/api/v1/memory/:id/provenance", async (c) => {
    try {
      const id = c.req.param("id");
      if (!id || id.trim() === "") {
        return c.json(errorJson("VALIDATION_ERROR", "id is required"), 400);
      }

      const result = await service.getProvenance(id);
      if (!result) {
        return c.json(errorJson("NOT_FOUND", `memory ${id} not found`), 404);
      }

      return c.json(result, 200);
    } catch (err) {
      return c.json(errorJson("INTERNAL_ERROR", "an unexpected error occurred"), 500);
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/v1/consolidate — memory consolidation (Gemini-inspired)
  // -----------------------------------------------------------------------

  app.post("/api/v1/consolidate", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));

      if (body.similarityThreshold !== undefined) {
        const t = body.similarityThreshold;
        if (typeof t !== "number" || !Number.isFinite(t) || t < 0.7 || t > 0.99) {
          return c.json(
            errorJson("VALIDATION_ERROR", "similarityThreshold must be a number between 0.7 and 0.99"),
            400,
          );
        }
      }

      if (body.maxEntries !== undefined) {
        const m = body.maxEntries;
        if (typeof m !== "number" || !Number.isInteger(m) || m < 10 || m > 500) {
          return c.json(
            errorJson("VALIDATION_ERROR", "maxEntries must be an integer between 10 and 500"),
            400,
          );
        }
      }

      const result = await service.consolidate({
        scope: body.scope,
        maxEntries: body.maxEntries,
        similarityThreshold: body.similarityThreshold,
        generateDigest: body.generateDigest,
      });

      return c.json(result, 200);
    } catch (err) {
      return c.json(errorJson("INTERNAL_ERROR", "an unexpected error occurred"), 500);
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/v1/stats — stats
  // -----------------------------------------------------------------------

  app.get("/api/v1/stats", async (c) => {
    try {
      const scope = c.req.query("scope");
      const result = await service.stats(parseScopeFilter(scope));
      return c.json(result, 200);
    } catch (err) {
      return c.json(errorJson("INTERNAL_ERROR", "an unexpected error occurred"), 500);
    }
  });

  return app;
}
