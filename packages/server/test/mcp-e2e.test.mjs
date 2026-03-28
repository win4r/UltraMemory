import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Shim require for ESM context
if (typeof globalThis.require === "undefined") {
  globalThis.require = createRequire(import.meta.url);
}

const { createMcpToolDefinitions } = await import("../src/tools.ts");

describe("MCP tool definitions", () => {
  it("defines 8 tools with valid schemas", () => {
    const tools = createMcpToolDefinitions();
    const names = tools.map(t => t.name).sort();
    assert.deepEqual(names, [
      "memory_consolidate",
      "memory_forget",
      "memory_list",
      "memory_provenance",
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

  it("all schemas have type object", () => {
    const tools = createMcpToolDefinitions();
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, "object", `${tool.name} schema must be type object`);
    }
  });
});

describe("MCP server module", () => {
  it("exports startMcpServer function", async () => {
    const mod = await import("../src/mcp.ts");
    assert.equal(typeof mod.startMcpServer, "function");
  });
});
