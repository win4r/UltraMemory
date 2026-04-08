import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const {
  detectFormat,
  normalizeClaudeCode,
  normalizeClaudeAi,
  normalizeChatGPT,
  normalizeSlack,
  normalizePlaintext,
  normalizeConversation,
  ingestNormalizedMessages,
} = jiti("../src/conversation-importer.ts");

// ============================================================================
// Format detection
// ============================================================================

describe("detectFormat", () => {
  it("detects Claude Code JSONL", () => {
    const content = '{"type":"human","message":{"content":"hello"}}\n{"type":"assistant","message":{"content":"hi"}}';
    assert.equal(detectFormat(content), "claude-code");
  });

  it("detects Claude.ai JSON (wrapper)", () => {
    const content = JSON.stringify({ chat_conversations: [{ chat_messages: [] }] });
    assert.equal(detectFormat(content), "claude-ai");
  });

  it("detects Claude.ai JSON (array)", () => {
    const content = JSON.stringify([{ chat_messages: [{ sender: "human", text: "hi" }] }]);
    assert.equal(detectFormat(content), "claude-ai");
  });

  it("detects ChatGPT JSON", () => {
    const content = JSON.stringify([{ mapping: { "1": { id: "1", message: null } } }]);
    assert.equal(detectFormat(content), "chatgpt");
  });

  it("detects Slack JSON (array)", () => {
    const content = JSON.stringify([{ ts: "1234567890.123", text: "hello", user: "U123" }]);
    assert.equal(detectFormat(content), "slack");
  });

  it("detects Slack JSON (wrapper)", () => {
    const content = JSON.stringify({ messages: [{ ts: "1234567890.123", text: "hello" }] });
    assert.equal(detectFormat(content), "slack");
  });

  it("falls back to plaintext", () => {
    assert.equal(detectFormat("User: hello\nAssistant: hi"), "plaintext");
  });
});

// ============================================================================
// Claude Code JSONL
// ============================================================================

describe("normalizeClaudeCode", () => {
  it("parses human/assistant types", () => {
    const content = [
      '{"type":"human","message":{"content":"What is 2+2?"}}',
      '{"type":"assistant","message":{"content":"4"}}',
    ].join("\n");
    const msgs = normalizeClaudeCode(content);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, "user");
    assert.equal(msgs[0].content, "What is 2+2?");
    assert.equal(msgs[1].role, "assistant");
  });

  it("handles array content blocks", () => {
    const content = '{"type":"human","message":{"content":[{"type":"text","text":"Hello"},{"type":"text","text":"World"}]}}';
    const msgs = normalizeClaudeCode(content);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].content, "Hello\nWorld");
  });

  it("skips empty lines and invalid JSON", () => {
    const content = "\n{invalid}\n";
    assert.equal(normalizeClaudeCode(content).length, 0);
  });

  it("preserves timestamp", () => {
    const content = '{"type":"human","message":{"content":"hi"},"timestamp":"2024-01-01T00:00:00Z"}';
    const msgs = normalizeClaudeCode(content);
    assert.equal(msgs[0].timestamp, "2024-01-01T00:00:00Z");
  });
});

// ============================================================================
// Claude.ai
// ============================================================================

describe("normalizeClaudeAi", () => {
  it("parses chat_messages array", () => {
    const content = JSON.stringify([{
      chat_messages: [
        { sender: "human", text: "hello" },
        { sender: "assistant", text: "hi there" },
      ],
    }]);
    const msgs = normalizeClaudeAi(content);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, "user");
    assert.equal(msgs[1].role, "assistant");
  });

  it("handles wrapper object", () => {
    const content = JSON.stringify({
      chat_conversations: [{
        chat_messages: [{ sender: "human", text: "test" }],
      }],
    });
    const msgs = normalizeClaudeAi(content);
    assert.equal(msgs.length, 1);
  });
});

// ============================================================================
// ChatGPT
// ============================================================================

describe("normalizeChatGPT", () => {
  it("rebuilds message order from mapping tree", () => {
    const content = JSON.stringify({
      mapping: {
        root: {
          id: "root",
          parent: null,
          children: ["msg1"],
          message: null,
        },
        msg1: {
          id: "msg1",
          parent: "root",
          children: ["msg2"],
          message: {
            author: { role: "user" },
            content: { parts: ["Hello ChatGPT"] },
            create_time: 1700000000,
          },
        },
        msg2: {
          id: "msg2",
          parent: "msg1",
          children: [],
          message: {
            author: { role: "assistant" },
            content: { parts: ["Hello! How can I help?"] },
            create_time: 1700000001,
          },
        },
      },
    });
    const msgs = normalizeChatGPT(content);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, "user");
    assert.equal(msgs[0].content, "Hello ChatGPT");
    assert.equal(msgs[1].role, "assistant");
    assert.ok(msgs[0].timestamp);
  });

  it("handles array of conversations", () => {
    const content = JSON.stringify([
      { mapping: { r: { id: "r", parent: null, children: ["m"], message: null }, m: { id: "m", parent: "r", children: [], message: { author: { role: "user" }, content: { parts: ["hi"] } } } } },
    ]);
    const msgs = normalizeChatGPT(content);
    assert.equal(msgs.length, 1);
  });
});

// ============================================================================
// Slack
// ============================================================================

describe("normalizeSlack", () => {
  it("maps bot_id to assistant, user to user", () => {
    const content = JSON.stringify([
      { user: "U123", text: "question", ts: "1700000000.000" },
      { bot_id: "B456", text: "answer", ts: "1700000001.000" },
    ]);
    const msgs = normalizeSlack(content);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, "user");
    assert.equal(msgs[1].role, "assistant");
    assert.ok(msgs[0].timestamp);
  });

  it("handles wrapper with messages array", () => {
    const content = JSON.stringify({
      messages: [{ user: "U1", text: "hi", ts: "1700000000.000" }],
    });
    assert.equal(normalizeSlack(content).length, 1);
  });

  it("skips empty text", () => {
    const content = JSON.stringify([{ user: "U1", text: "", ts: "1" }]);
    assert.equal(normalizeSlack(content).length, 0);
  });
});

// ============================================================================
// Plaintext
// ============================================================================

describe("normalizePlaintext", () => {
  it("splits by role prefixes", () => {
    const content = "User: What is 2+2?\nAssistant: The answer is 4.";
    const msgs = normalizePlaintext(content);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, "user");
    assert.equal(msgs[0].content, "What is 2+2?");
    assert.equal(msgs[1].role, "assistant");
  });

  it("handles Human:/AI: prefixes", () => {
    const content = "Human: hello\nAI: hi";
    const msgs = normalizePlaintext(content);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, "user");
    assert.equal(msgs[1].role, "assistant");
  });

  it("handles multi-line content", () => {
    const content = "User: Line 1\nLine 2\nAssistant: Reply";
    const msgs = normalizePlaintext(content);
    assert.equal(msgs.length, 2);
    assert.ok(msgs[0].content.includes("Line 2"));
  });

  it("returns empty for text without role prefixes", () => {
    assert.equal(normalizePlaintext("just some text").length, 0);
  });
});

// ============================================================================
// Dispatcher
// ============================================================================

describe("normalizeConversation", () => {
  it("dispatches to correct normalizer", () => {
    const jsonl = '{"type":"human","message":{"content":"test"}}';
    const msgs = normalizeConversation(jsonl, "claude-code");
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, "user");
  });
});

// ============================================================================
// Batch ingest
// ============================================================================

describe("ingestNormalizedMessages", () => {
  it("calls ingestFn for each message and tracks results", async () => {
    const calls = [];
    const ingestFn = async (text, scope, role) => {
      calls.push({ text, scope, role });
      return "stored";
    };

    const messages = [
      { role: "user", content: "hello", timestamp: "2024-01-01T00:00:00Z" },
      { role: "assistant", content: "hi" },
    ];

    const result = await ingestNormalizedMessages(messages, "project:test", ingestFn);
    assert.equal(result.total, 2);
    assert.equal(result.stored, 2);
    assert.equal(result.skipped, 0);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].scope, "project:test");
  });

  it("tracks skipped messages", async () => {
    const ingestFn = async () => "skipped";
    const result = await ingestNormalizedMessages(
      [{ role: "user", content: "x" }],
      "scope",
      ingestFn,
    );
    assert.equal(result.skipped, 1);
    assert.equal(result.stored, 0);
  });

  it("tracks errors", async () => {
    const ingestFn = async () => { throw new Error("fail"); };
    const result = await ingestNormalizedMessages(
      [{ role: "user", content: "x" }],
      "scope",
      ingestFn,
    );
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].includes("fail"));
  });
});
