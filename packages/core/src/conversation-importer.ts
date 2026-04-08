/**
 * Conversation Import Pipeline — multi-format conversation normalization + ingestion.
 *
 * Supports: Claude Code JSONL, Claude.ai JSON, ChatGPT JSON, Slack JSON, plaintext.
 * Normalized messages are fed through the caller-provided ingest callback.
 */

import { readFileSync } from "node:fs";

export interface NormalizedMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
}

export type ConversationFormat =
  | "claude-code"
  | "claude-ai"
  | "chatgpt"
  | "slack"
  | "plaintext";

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

export function detectFormat(content: string): ConversationFormat {
  const trimmed = content.trimStart();

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);

      if (Array.isArray(parsed)) {
        if (parsed.length > 0 && parsed[0].chat_messages !== undefined) return "claude-ai";
        if (parsed.length > 0 && parsed[0].mapping !== undefined) return "chatgpt";
        if (parsed.length > 0 && parsed[0].ts !== undefined && parsed[0].text !== undefined) return "slack";
      }

      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if (parsed.chat_conversations !== undefined) return "claude-ai";
        if (parsed.mapping !== undefined) return "chatgpt";
        if (parsed.messages !== undefined && Array.isArray(parsed.messages)) {
          const first = parsed.messages[0];
          if (first && first.ts !== undefined) return "slack";
        }
      }
    } catch {
      // Not valid JSON
    }
  }

  // JSONL: each line is a JSON object with type field
  const firstLine = trimmed.split("\n")[0]?.trim();
  if (firstLine?.startsWith("{")) {
    try {
      const obj = JSON.parse(firstLine);
      if (obj.type === "human" || obj.type === "assistant" || obj.message !== undefined) {
        return "claude-code";
      }
    } catch {
      // Not JSONL
    }
  }

  return "plaintext";
}

// ---------------------------------------------------------------------------
// Claude Code JSONL normalizer
// ---------------------------------------------------------------------------

interface ClaudeCodeLine {
  type?: string;
  message?: {
    content?: string | Array<{ type?: string; text?: string }>;
    role?: string;
  };
  timestamp?: string;
}

export function normalizeClaudeCode(content: string): NormalizedMessage[] {
  const messages: NormalizedMessage[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: ClaudeCodeLine;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    let role: NormalizedMessage["role"];
    if (parsed.type === "human") role = "user";
    else if (parsed.type === "assistant") role = "assistant";
    else if (parsed.message?.role === "user" || parsed.type === "user") role = "user";
    else if (parsed.message?.role === "assistant") role = "assistant";
    else continue;

    let text = "";
    const rawContent = parsed.message?.content;
    if (typeof rawContent === "string") {
      text = rawContent;
    } else if (Array.isArray(rawContent)) {
      text = rawContent
        .filter((part): part is { type?: string; text?: string } =>
          typeof part === "object" && part !== null && typeof part.text === "string")
        .map((part) => part.text!)
        .join("\n");
    }

    if (!text.trim()) continue;

    messages.push({
      role,
      content: text.trim(),
      ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {}),
    });
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Claude.ai JSON export normalizer
// ---------------------------------------------------------------------------

interface ClaudeAiConversation {
  chat_messages?: Array<{
    sender?: string;
    text?: string;
    created_at?: string;
  }>;
}

export function normalizeClaudeAi(content: string): NormalizedMessage[] {
  const parsed = JSON.parse(content);
  const messages: NormalizedMessage[] = [];

  let conversations: ClaudeAiConversation[];
  if (Array.isArray(parsed)) conversations = parsed;
  else if (parsed.chat_conversations) conversations = parsed.chat_conversations;
  else conversations = [parsed];

  for (const conv of conversations) {
    if (!conv.chat_messages) continue;
    for (const msg of conv.chat_messages) {
      let role: NormalizedMessage["role"];
      if (msg.sender === "human") role = "user";
      else if (msg.sender === "assistant") role = "assistant";
      else continue;

      const text = msg.text?.trim();
      if (!text) continue;

      messages.push({
        role,
        content: text,
        ...(msg.created_at ? { timestamp: msg.created_at } : {}),
      });
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// ChatGPT conversations.json normalizer
// ---------------------------------------------------------------------------

interface ChatGPTMapping {
  [id: string]: {
    id: string;
    parent?: string | null;
    children?: string[];
    message?: {
      author?: { role?: string };
      content?: { parts?: Array<string | Record<string, unknown>> };
      create_time?: number;
    } | null;
  };
}

interface ChatGPTConversation {
  mapping?: ChatGPTMapping;
}

export function normalizeChatGPT(content: string): NormalizedMessage[] {
  const parsed = JSON.parse(content);
  const messages: NormalizedMessage[] = [];
  const conversations: ChatGPTConversation[] = Array.isArray(parsed) ? parsed : [parsed];

  for (const conv of conversations) {
    if (!conv.mapping) continue;
    const mapping = conv.mapping;

    let rootId: string | null = null;
    for (const [id, node] of Object.entries(mapping)) {
      if (!node.parent || !mapping[node.parent]) {
        rootId = id;
        break;
      }
    }
    if (!rootId) continue;

    const queue: string[] = [rootId];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      const node = mapping[nodeId];
      if (!node) continue;

      if (node.message?.author?.role && node.message.content?.parts) {
        const authorRole = node.message.author.role;
        let role: NormalizedMessage["role"] | null = null;
        if (authorRole === "user") role = "user";
        else if (authorRole === "assistant") role = "assistant";
        else if (authorRole === "system") role = "system";

        if (role) {
          const text = node.message.content.parts
            .filter((part): part is string => typeof part === "string")
            .join("\n")
            .trim();

          if (text) {
            const msg: NormalizedMessage = { role, content: text };
            if (node.message.create_time) {
              msg.timestamp = new Date(node.message.create_time * 1000).toISOString();
            }
            messages.push(msg);
          }
        }
      }

      if (node.children) {
        for (const childId of node.children) queue.push(childId);
      }
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Slack JSON export normalizer
// ---------------------------------------------------------------------------

interface SlackMessage {
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
}

export function normalizeSlack(content: string): NormalizedMessage[] {
  const parsed = JSON.parse(content);
  const messages: NormalizedMessage[] = [];

  let rawMessages: SlackMessage[];
  if (Array.isArray(parsed)) rawMessages = parsed;
  else if (parsed.messages && Array.isArray(parsed.messages)) rawMessages = parsed.messages;
  else return messages;

  for (const msg of rawMessages) {
    const text = msg.text?.trim();
    if (!text) continue;

    const role: NormalizedMessage["role"] = msg.bot_id ? "assistant" : "user";
    const result: NormalizedMessage = { role, content: text };
    if (msg.ts) {
      result.timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
    }
    messages.push(result);
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Plaintext normalizer
// ---------------------------------------------------------------------------

const ROLE_PREFIXES: Array<[RegExp, NormalizedMessage["role"]]> = [
  [/^User:\s*/i, "user"],
  [/^Human:\s*/i, "user"],
  [/^Assistant:\s*/i, "assistant"],
  [/^AI:\s*/i, "assistant"],
  [/^System:\s*/i, "system"],
];

export function normalizePlaintext(content: string): NormalizedMessage[] {
  const messages: NormalizedMessage[] = [];
  let currentRole: NormalizedMessage["role"] | null = null;
  let currentLines: string[] = [];

  function flush() {
    if (currentRole && currentLines.length > 0) {
      const text = currentLines.join("\n").trim();
      if (text) messages.push({ role: currentRole, content: text });
    }
    currentLines = [];
  }

  for (const line of content.split("\n")) {
    let matched = false;
    for (const [pattern, role] of ROLE_PREFIXES) {
      const match = line.match(pattern);
      if (match) {
        flush();
        currentRole = role;
        const remainder = line.slice(match[0].length).trim();
        if (remainder) currentLines.push(remainder);
        matched = true;
        break;
      }
    }
    if (!matched && currentRole) currentLines.push(line);
  }
  flush();

  return messages;
}

// ---------------------------------------------------------------------------
// Unified normalize dispatcher
// ---------------------------------------------------------------------------

export function normalizeConversation(content: string, format: ConversationFormat): NormalizedMessage[] {
  switch (format) {
    case "claude-code": return normalizeClaudeCode(content);
    case "claude-ai": return normalizeClaudeAi(content);
    case "chatgpt": return normalizeChatGPT(content);
    case "slack": return normalizeSlack(content);
    case "plaintext": return normalizePlaintext(content);
  }
}

// ---------------------------------------------------------------------------
// Batch import: file → normalize → ingest callback
// ---------------------------------------------------------------------------

export interface ImportResult {
  total: number;
  stored: number;
  skipped: number;
  errors: string[];
}

export type IngestFn = (text: string, scope: string, role: string, timestamp?: string) => Promise<"stored" | "skipped">;

export async function importConversationFile(
  filePath: string,
  scope: string,
  format: ConversationFormat | "auto",
  ingestFn: IngestFn,
): Promise<ImportResult> {
  const content = readFileSync(filePath, "utf-8");
  const resolvedFormat = format === "auto" ? detectFormat(content) : format;
  const messages = normalizeConversation(content, resolvedFormat);
  return ingestNormalizedMessages(messages, scope, ingestFn);
}

export async function ingestNormalizedMessages(
  messages: NormalizedMessage[],
  scope: string,
  ingestFn: IngestFn,
): Promise<ImportResult> {
  const result: ImportResult = { total: messages.length, stored: 0, skipped: 0, errors: [] };

  for (const msg of messages) {
    try {
      const outcome = await ingestFn(msg.content, scope, msg.role, msg.timestamp);
      if (outcome === "stored") result.stored++;
      else result.skipped++;
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return result;
}
