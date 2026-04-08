import assert from "node:assert/strict";
import { describe, test } from "node:test";
import Module from "node:module";

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules",
  "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

import jitiFactory from "jiti";
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  microcompact,
  summarizeSession,
  extractAndPersist,
  distillSession,
  _estimateTokens,
  _getMessageText,
  _flattenMessages,
  _parseDimensionsFromJson,
  _formatDimensionsText,
  _COMPACTABLE_TOOLS,
  _DIMENSION_MAPPINGS,
  _CLEARED_MARKER,
} = jiti("../packages/core/src/session-distiller.ts");

// ============================================================================
// Helper factories
// ============================================================================

/** Create a simple text message */
function textMsg(role, text) {
  return { role, content: text };
}

/** Create a message with tool_use + tool_result blocks */
function toolMsg(toolName, toolId, resultContent) {
  return [
    {
      role: "assistant",
      content: [
        { type: "tool_use", name: toolName, id: toolId, input: {} },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: toolId, content: resultContent },
      ],
    },
  ];
}

/** Create a mock LlmClient that returns the given dimensions JSON */
function mockLlm(dimensionsJson) {
  return {
    async completeJson(_prompt, _label) {
      return dimensionsJson;
    },
    getLastError() { return null; },
  };
}

/** Create a mock LlmClient that fails */
function failingLlm() {
  return {
    async completeJson() { return null; },
    getLastError() { return "mock error"; },
  };
}

/** Create a mock IngestionPipeline */
function mockPipeline(action = "created") {
  const ingested = [];
  let idCounter = 0;
  return {
    ingested,
    async ingest(input) {
      ingested.push(input);
      idCounter++;
      return { id: `mem-${idCounter}`, action, relationsAdded: 0 };
    },
  };
}

// ============================================================================
// _estimateTokens
// ============================================================================

describe("estimateTokens", () => {
  test("empty string returns 0", () => {
    assert.equal(_estimateTokens(""), 0);
  });

  test("short string returns at least 1", () => {
    assert.equal(_estimateTokens("hi"), 1);
  });

  test("longer string returns length/4 ceiling", () => {
    const text = "a".repeat(100);
    assert.equal(_estimateTokens(text), 25);
  });
});

// ============================================================================
// _getMessageText
// ============================================================================

describe("getMessageText", () => {
  test("string content", () => {
    assert.equal(_getMessageText({ role: "user", content: "hello" }), "hello");
  });

  test("ContentBlock array", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    };
    assert.equal(_getMessageText(msg), "first\nsecond");
  });

  test("mixed blocks with tool_result content", () => {
    const msg = {
      role: "user",
      content: [
        { type: "tool_result", content: "result data", tool_use_id: "x" },
        { type: "text", text: "after" },
      ],
    };
    assert.equal(_getMessageText(msg), "result data\nafter");
  });
});

// ============================================================================
// microcompact — Layer 1
// ============================================================================

describe("microcompact", () => {
  test("returns same messages when no tool results", () => {
    const msgs = [textMsg("user", "hello"), textMsg("assistant", "hi")];
    const result = microcompact(msgs);
    assert.equal(result.tokensFreed, 0);
    assert.equal(result.toolsCleared, 0);
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0].content, "hello");
  });

  test("clears old compactable tool results, keeps recent", () => {
    // Create 3 tool calls — with keepRecent=1, only the last should survive
    const msgs = [
      ...toolMsg("Read", "t1", "file content 1 that is quite long"),
      ...toolMsg("Bash", "t2", "command output here"),
      ...toolMsg("Read", "t3", "recent file content"),
    ];

    const result = microcompact(msgs, 1);
    assert.equal(result.toolsCleared, 2);
    assert.ok(result.tokensFreed > 0);

    // t1 and t2 should be cleared, t3 should be preserved
    const t1Result = result.messages[1].content.find(
      (b) => b.tool_use_id === "t1"
    );
    assert.equal(t1Result.content, _CLEARED_MARKER);

    const t3Result = result.messages[5].content.find(
      (b) => b.tool_use_id === "t3"
    );
    assert.equal(t3Result.content, "recent file content");
  });

  test("does not clear non-compactable tool results", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", name: "CustomTool", id: "c1", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "c1", content: "custom output" },
        ],
      },
    ];

    const result = microcompact(msgs, 0);
    assert.equal(result.toolsCleared, 0);
    const resultBlock = result.messages[1].content[0];
    assert.equal(resultBlock.content, "custom output");
  });

  test("returns deep copy — original not mutated", () => {
    const msgs = [...toolMsg("Read", "t1", "original content")];
    const result = microcompact(msgs, 0);

    // Original should be unmodified
    assert.equal(msgs[1].content[0].content, "original content");
    // Result should be cleared
    assert.equal(result.messages[1].content[0].content, _CLEARED_MARKER);
  });

  test("handles string-only messages mixed with block messages", () => {
    const msgs = [
      textMsg("user", "do something"),
      ...toolMsg("Grep", "g1", "search results"),
      textMsg("assistant", "found it"),
    ];

    const result = microcompact(msgs, 0);
    assert.equal(result.toolsCleared, 1);
    assert.equal(result.messages[0].content, "do something");
    assert.equal(result.messages[3].content, "found it");
  });
});

// ============================================================================
// _parseDimensionsFromJson
// ============================================================================

describe("parseDimensionsFromJson", () => {
  test("extracts all 9 dimensions from complete JSON", () => {
    const raw = {
      userIntent: "build a feature",
      keyConcepts: "TypeScript, testing",
      filesAndCode: "src/index.ts:10",
      errorsAndFixes: "none",
      problemSolving: "tried X, Y worked",
      userQuotes: "I prefer concise code",
      pendingTasks: "none",
      currentWork: "implementing session distiller",
      suggestedNext: "write tests",
    };
    const dims = _parseDimensionsFromJson(raw);
    assert.equal(dims.userIntent, "build a feature");
    assert.equal(dims.suggestedNext, "write tests");
  });

  test("missing fields become empty strings", () => {
    const dims = _parseDimensionsFromJson({});
    assert.equal(dims.userIntent, "");
    assert.equal(dims.keyConcepts, "");
    assert.equal(dims.filesAndCode, "");
  });

  test("non-string values become empty strings", () => {
    const dims = _parseDimensionsFromJson({ userIntent: 42, keyConcepts: null });
    assert.equal(dims.userIntent, "");
    assert.equal(dims.keyConcepts, "");
  });
});

// ============================================================================
// _formatDimensionsText
// ============================================================================

describe("formatDimensionsText", () => {
  test("formats non-empty dimensions with headings", () => {
    const dims = {
      userIntent: "build X",
      keyConcepts: "none",
      filesAndCode: "",
      errorsAndFixes: "none",
      problemSolving: "",
      userQuotes: "I like clean code",
      pendingTasks: "none",
      currentWork: "none",
      suggestedNext: "write tests next",
    };
    const text = _formatDimensionsText(dims);
    assert.ok(text.includes("## User Intent"));
    assert.ok(text.includes("build X"));
    assert.ok(text.includes("## User Quotes"));
    assert.ok(!text.includes("## Key Concepts")); // "none" is filtered out
    assert.ok(!text.includes("## Files & Code")); // empty is filtered out
  });
});

// ============================================================================
// summarizeSession — Layer 2
// ============================================================================

describe("summarizeSession", () => {
  test("returns null when messages <= preserveRecent", async () => {
    const msgs = [textMsg("user", "hi"), textMsg("assistant", "hello")];
    const llm = mockLlm({});
    const result = await summarizeSession(msgs, llm, 5);
    assert.equal(result, null);
  });

  test("returns null when LLM returns null", async () => {
    const msgs = Array.from({ length: 10 }, (_, i) =>
      textMsg(i % 2 === 0 ? "user" : "assistant", `msg ${i}`)
    );
    const llm = failingLlm();
    const result = await summarizeSession(msgs, llm, 3);
    assert.equal(result, null);
  });

  test("returns summary with compacted messages on success", async () => {
    const msgs = Array.from({ length: 10 }, (_, i) =>
      textMsg(i % 2 === 0 ? "user" : "assistant", `message number ${i}`)
    );
    const llm = mockLlm({
      userIntent: "Port session distiller",
      keyConcepts: "TypeScript, LLM, memory",
      filesAndCode: "session-distiller.ts",
      errorsAndFixes: "none",
      problemSolving: "adapted RecallNest code",
      userQuotes: "Take care with the types",
      pendingTasks: "none",
      currentWork: "implementing",
      suggestedNext: "write tests",
    });

    const result = await summarizeSession(msgs, llm, 3);
    assert.ok(result);
    assert.ok(result.summary);
    assert.equal(result.summary.dimensions.userIntent, "Port session distiller");
    // compactedMessages: 1 (summary) + 3 (preserveRecent) = 4
    assert.equal(result.compactedMessages.length, 4);
    assert.equal(result.compactedMessages[0].role, "user");
    assert.ok(
      typeof result.compactedMessages[0].content === "string" &&
      result.compactedMessages[0].content.includes("summary")
    );
  });

  test("preserves exactly preserveRecent recent messages", async () => {
    const msgs = Array.from({ length: 8 }, (_, i) =>
      textMsg(i % 2 === 0 ? "user" : "assistant", `msg-${i}`)
    );
    const llm = mockLlm({ userIntent: "test" });
    const result = await summarizeSession(msgs, llm, 4);
    assert.ok(result);
    // 1 summary + 4 recent = 5
    assert.equal(result.compactedMessages.length, 5);
    // Last 4 should be the original recent messages
    assert.equal(result.compactedMessages[4].content, "msg-7");
  });
});

// ============================================================================
// extractAndPersist — Layer 3
// ============================================================================

describe("extractAndPersist", () => {
  test("persists non-trivial dimensions via pipeline", async () => {
    const dims = {
      userIntent: "Build a session distiller with three layers of compression for UltraMemory",
      keyConcepts: "none",
      filesAndCode: "none",
      errorsAndFixes: "Fixed the import path from llm-client.js — was missing the .js extension suffix",
      problemSolving: "Tried using chatRaw first but UltraMemory only has completeJson, adapted prompt format accordingly",
      userQuotes: "I prefer TypeScript with strict types",
      pendingTasks: "none",
      currentWork: "none",
      suggestedNext: "none",
    };

    const pipeline = mockPipeline("created");
    const result = await extractAndPersist(dims, "test-scope", pipeline);

    // userIntent, errorsAndFixes, problemSolving, userQuotes should all be persisted
    // (filesAndCode is "none" so skipped)
    assert.equal(result.memoriesStored, 4);
    assert.equal(result.ids.length, 4);
    assert.equal(pipeline.ingested.length, 4);

    // Verify the scope was passed through
    for (const entry of pipeline.ingested) {
      assert.equal(entry.scope, "test-scope");
      assert.equal(entry.source, "session-summary");
    }
  });

  test("skips dimensions with 'none' content", async () => {
    const dims = {
      userIntent: "none",
      keyConcepts: "none",
      filesAndCode: "none",
      errorsAndFixes: "none",
      problemSolving: "none",
      userQuotes: "none",
      pendingTasks: "none",
      currentWork: "none",
      suggestedNext: "none",
    };

    const pipeline = mockPipeline("created");
    const result = await extractAndPersist(dims, "scope", pipeline);
    assert.equal(result.memoriesStored, 0);
    assert.equal(pipeline.ingested.length, 0);
  });

  test("skips dimensions shorter than MIN_PERSIST_LENGTH", async () => {
    const dims = {
      userIntent: "short",       // < 20 chars
      keyConcepts: "none",
      filesAndCode: "none",
      errorsAndFixes: "none",
      problemSolving: "none",
      userQuotes: "brief note",  // < 20 chars
      pendingTasks: "none",
      currentWork: "none",
      suggestedNext: "none",
    };

    const pipeline = mockPipeline("created");
    const result = await extractAndPersist(dims, "scope", pipeline);
    assert.equal(result.memoriesStored, 0);
    assert.equal(pipeline.ingested.length, 0);
  });

  test("counts duplicate actions correctly", async () => {
    const dims = {
      userIntent: "Build a large feature with many components involved",
      keyConcepts: "none",
      filesAndCode: "none",
      errorsAndFixes: "none",
      problemSolving: "none",
      userQuotes: "I want everything to be consistent and well-tested",
      pendingTasks: "none",
      currentWork: "none",
      suggestedNext: "none",
    };

    const pipeline = mockPipeline("duplicate");
    const result = await extractAndPersist(dims, "scope", pipeline);
    assert.equal(result.memoriesDuplicated, 2);
    assert.equal(result.memoriesStored, 0);
  });

  test("handles pipeline errors gracefully", async () => {
    const dims = {
      userIntent: "This is a long enough user intent to be persisted",
      keyConcepts: "none",
      filesAndCode: "none",
      errorsAndFixes: "none",
      problemSolving: "none",
      userQuotes: "none",
      pendingTasks: "none",
      currentWork: "none",
      suggestedNext: "none",
    };

    const pipeline = {
      async ingest() { throw new Error("store unavailable"); },
    };
    const result = await extractAndPersist(dims, "scope", pipeline);
    assert.equal(result.memoriesFiltered, 1);
    assert.equal(result.memoriesStored, 0);
  });

  test("maps dimensions to correct memory categories", async () => {
    const dims = {
      userIntent: "This intent is long enough to be persisted definitely",
      keyConcepts: "none",
      filesAndCode: "These are the files and code that were modified in detail",
      errorsAndFixes: "Fixed the authentication error by refreshing the token properly",
      problemSolving: "Tried approach A first but approach B worked much better in the end",
      userQuotes: "I always prefer clear variable names over short ones",
      pendingTasks: "none",
      currentWork: "none",
      suggestedNext: "none",
    };

    const pipeline = mockPipeline("created");
    await extractAndPersist(dims, "scope", pipeline);

    const categories = pipeline.ingested.map((e) => e.category);
    assert.ok(categories.includes("events"));      // userIntent
    assert.ok(categories.includes("cases"));        // errorsAndFixes
    assert.ok(categories.includes("patterns"));     // problemSolving
    assert.ok(categories.includes("preferences"));  // userQuotes
    assert.ok(categories.includes("entities"));     // filesAndCode
  });
});

// ============================================================================
// distillSession — Orchestrator
// ============================================================================

describe("distillSession", () => {
  test("layer 1 only when no LLM", async () => {
    const msgs = [
      textMsg("user", "do something"),
      ...toolMsg("Read", "r1", "file content long enough"),
      textMsg("assistant", "done"),
    ];

    const result = await distillSession(
      { messages: msgs, scope: "test", keepRecentTools: 0 },
      { llm: null, pipeline: null }
    );

    assert.ok(result.microcompact.toolsCleared > 0);
    assert.equal(result.summary, null);
    assert.equal(result.persisted, null);
    assert.equal(result.compactedMessages.length, msgs.length);
  });

  test("layers 1+2 when LLM available but no pipeline", async () => {
    const msgs = Array.from({ length: 10 }, (_, i) =>
      textMsg(i % 2 === 0 ? "user" : "assistant", `message ${i}`)
    );

    const llm = mockLlm({
      userIntent: "orchestrator test",
      keyConcepts: "none",
      filesAndCode: "none",
      errorsAndFixes: "none",
      problemSolving: "none",
      userQuotes: "none",
      pendingTasks: "none",
      currentWork: "none",
      suggestedNext: "none",
    });

    const result = await distillSession(
      { messages: msgs, scope: "test", preserveRecent: 3 },
      { llm, pipeline: null }
    );

    assert.ok(result.summary);
    assert.equal(result.persisted, null);
    // 1 summary + 3 recent
    assert.equal(result.compactedMessages.length, 4);
  });

  test("all 3 layers when LLM + pipeline available", async () => {
    const msgs = Array.from({ length: 10 }, (_, i) =>
      textMsg(i % 2 === 0 ? "user" : "assistant", `long message content number ${i} with enough text`)
    );

    const llm = mockLlm({
      userIntent: "Full distillation test with all three layers working together",
      keyConcepts: "none",
      filesAndCode: "none",
      errorsAndFixes: "none",
      problemSolving: "none",
      userQuotes: "none",
      pendingTasks: "none",
      currentWork: "none",
      suggestedNext: "none",
    });

    const pipeline = mockPipeline("created");

    const result = await distillSession(
      { messages: msgs, scope: "test-scope", preserveRecent: 3 },
      { llm, pipeline }
    );

    assert.ok(result.summary);
    assert.ok(result.persisted);
    assert.equal(result.persisted.memoriesStored, 1); // only userIntent is long enough
    assert.equal(result.compactedMessages.length, 4);
  });

  test("persist=false skips layer 3", async () => {
    const msgs = Array.from({ length: 10 }, (_, i) =>
      textMsg(i % 2 === 0 ? "user" : "assistant", `msg ${i}`)
    );

    const llm = mockLlm({
      userIntent: "Should not be persisted because persist flag is false",
      keyConcepts: "none",
      filesAndCode: "none",
      errorsAndFixes: "none",
      problemSolving: "none",
      userQuotes: "none",
      pendingTasks: "none",
      currentWork: "none",
      suggestedNext: "none",
    });

    const pipeline = mockPipeline("created");

    const result = await distillSession(
      { messages: msgs, scope: "test", persist: false },
      { llm, pipeline }
    );

    assert.ok(result.summary);
    assert.equal(result.persisted, null);
    assert.equal(pipeline.ingested.length, 0);
  });
});

// ============================================================================
// Constants sanity
// ============================================================================

describe("constants", () => {
  test("COMPACTABLE_TOOLS contains expected tools", () => {
    assert.ok(_COMPACTABLE_TOOLS.has("Read"));
    assert.ok(_COMPACTABLE_TOOLS.has("Bash"));
    assert.ok(_COMPACTABLE_TOOLS.has("Grep"));
    assert.ok(_COMPACTABLE_TOOLS.has("Glob"));
    assert.ok(_COMPACTABLE_TOOLS.has("Edit"));
    assert.ok(_COMPACTABLE_TOOLS.has("Write"));
    assert.ok(!_COMPACTABLE_TOOLS.has("CustomTool"));
  });

  test("DIMENSION_MAPPINGS cover expected categories", () => {
    const categories = _DIMENSION_MAPPINGS.map((m) => m.category);
    assert.ok(categories.includes("events"));
    assert.ok(categories.includes("cases"));
    assert.ok(categories.includes("patterns"));
    assert.ok(categories.includes("preferences"));
    assert.ok(categories.includes("entities"));
  });

  test("CLEARED_MARKER is [Cleared]", () => {
    assert.equal(_CLEARED_MARKER, "[Cleared]");
  });
});
