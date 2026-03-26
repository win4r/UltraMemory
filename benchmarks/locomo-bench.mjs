#!/usr/bin/env node
/**
 * LoCoMo Benchmark for UltraMemory
 *
 * Evaluates UltraMemory's retrieval quality on the LoCoMo10 dataset
 * (ACL 2024: "Evaluating Very Long-Term Conversational Memory of LLM Agents").
 *
 * Usage:
 *   node benchmarks/locomo-bench.mjs [options]
 *
 * Options:
 *   --samples N       Run only first N conversations (default: all 10)
 *   --top-k K         Number of memories to retrieve per question (default: 5)
 *   --model MODEL     LLM model for answering (default: qwen3.5-flash)
 *   --embedding-model  Embedding model (default: text-embedding-v4)
 *   --category CAT    Only evaluate category 1-5 (default: all)
 *   --dry-run         Ingest only, skip QA evaluation
 *   --verbose         Print each QA result
 *
 * Supports any OpenAI-compatible API (DashScope, SiliconFlow, OpenAI, etc.)
 * Configure via --config <path> or environment variables.
 */

import { createRequire } from "node:module";
if (typeof globalThis.require === "undefined") {
  globalThis.require = createRequire(import.meta.url);
}

import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Dynamic import of MemoryService (TS source via tsx)
const { MemoryService } = await import("../packages/server/src/service.ts");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return args[idx + 1] || fallback;
}
const hasFlag = (name) => args.includes(`--${name}`);

const MAX_SAMPLES = parseInt(getArg("samples", "10"));
const TOP_K = parseInt(getArg("top-k", "10"));
const MAX_QA = parseInt(getArg("max-qa", "0")) || Infinity;
const CATEGORY_FILTER = getArg("category", null);
const DRY_RUN = hasFlag("dry-run");
const VERBOSE = hasFlag("verbose");

// Load config: --config <path> or inline defaults (DashScope)
const CONFIG_PATH = getArg("config", null);
let externalConfig = {};
if (CONFIG_PATH) {
  externalConfig = JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
}

const DASHSCOPE_KEY = process.env.DASHSCOPE_API_KEY || "";
if (!DASHSCOPE_KEY && !externalConfig.embedding?.apiKey && !process.env.EMBEDDING_API_KEY && !process.env.OPENAI_API_KEY) {
  console.error("Error: API key required. Set DASHSCOPE_API_KEY, OPENAI_API_KEY, or EMBEDDING_API_KEY");
  process.exit(1);
}
const DASHSCOPE_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1";

const EMBEDDING_API_KEY = externalConfig.embedding?.apiKey || process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || DASHSCOPE_KEY;
const EMBEDDING_MODEL = getArg("embedding-model", externalConfig.embedding?.model || "text-embedding-v4");
const EMBEDDING_BASE_URL = externalConfig.embedding?.baseURL || process.env.EMBEDDING_BASE_URL || DASHSCOPE_BASE;
const EMBEDDING_DIMS = externalConfig.embedding?.dimensions || (EMBEDDING_MODEL === "text-embedding-v4" ? 1024 : undefined);

const LLM_API_KEY = externalConfig.llm?.apiKey || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || DASHSCOPE_KEY;
const LLM_MODEL = getArg("model", externalConfig.llm?.model || "qwen3.5-flash");
const LLM_BASE_URL = externalConfig.llm?.baseURL || process.env.LLM_BASE_URL || DASHSCOPE_BASE;

// ---------------------------------------------------------------------------
// LoCoMo data loading
// ---------------------------------------------------------------------------

const CATEGORY_NAMES = {
  "1": "single-hop",
  "2": "multi-hop",
  "3": "temporal",
  "4": "open-domain",
  "5": "adversarial",
};

async function loadDataset() {
  const raw = await readFile(join(__dirname, "locomo10.json"), "utf-8");
  return JSON.parse(raw);
}

function extractConversationTurns(conversation) {
  const turns = [];
  const sessionKeys = Object.keys(conversation)
    .filter((k) => k.match(/^session_\d+$/) && !k.includes("date"))
    .sort((a, b) => {
      const na = parseInt(a.replace("session_", ""));
      const nb = parseInt(b.replace("session_", ""));
      return na - nb;
    });

  for (const sessionKey of sessionKeys) {
    const sessionDate = conversation[sessionKey + "_date_time"] || "";
    const session = conversation[sessionKey];
    if (!Array.isArray(session)) continue;

    for (const turn of session) {
      turns.push({
        sessionKey,
        sessionDate,
        speaker: turn.speaker || "",
        dialogId: turn.dia_id || "",
        text: turn.text || "",
      });
    }
  }
  return turns;
}

// ---------------------------------------------------------------------------
// Memory ingestion
// ---------------------------------------------------------------------------

async function ingestConversation(service, conversation, sampleId) {
  const turns = extractConversationTurns(conversation);
  let ingested = 0;

  // Strategy: 2-turn sliding window (speaker A + speaker B as a dialogue pair)
  // Each memory includes session date + speaker names for temporal grounding.
  // Also ingest a per-session summary for cross-session questions.

  // Pass 1: dialogue pairs (consecutive turns within same session)
  let i = 0;
  while (i < turns.length) {
    const t = turns[i];
    // Pair with next turn if same session
    const next = turns[i + 1];
    let text;
    if (next && next.sessionKey === t.sessionKey) {
      text = `[${t.sessionDate}] ${t.speaker}: ${t.text}\n${next.speaker}: ${next.text}`;
      i += 2;
    } else {
      text = `[${t.sessionDate}] ${t.speaker}: ${t.text}`;
      i += 1;
    }

    if (text.trim().length < 15) continue;

    try {
      await service.store({ text, category: "fact", scope: "global", importance: 0.7 });
      ingested++;
    } catch (err) {
      if (VERBOSE) console.error(`  Ingest error: ${err.message}`);
    }
  }

  // Pass 2: per-session summaries (concatenate all turns, truncate to ~2000 chars)
  const sessionKeys = [...new Set(turns.map((t) => t.sessionKey))];
  for (const sk of sessionKeys) {
    const sessionTurns = turns.filter((t) => t.sessionKey === sk);
    if (sessionTurns.length === 0) continue;
    const date = sessionTurns[0].sessionDate;
    const summary = sessionTurns
      .map((t) => `${t.speaker}: ${t.text}`)
      .join("\n")
      .slice(0, 2000);
    const text = `[Session ${sk} on ${date}]\n${summary}`;
    try {
      await service.store({ text, category: "fact", scope: "global", importance: 0.8 });
      ingested++;
    } catch (err) {
      if (VERBOSE) console.error(`  Ingest session summary error: ${err.message}`);
    }
  }

  return { totalTurns: turns.length, ingested };
}

// ---------------------------------------------------------------------------
// LLM answering
// ---------------------------------------------------------------------------

async function askLLM(question, context, model) {
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({
    apiKey: LLM_API_KEY,
    baseURL: LLM_BASE_URL,
  });

  const systemPrompt = `You are answering factual questions about a long conversation between two people. Answer based on the retrieved memory fragments below. Each fragment has a timestamp in brackets. Be concise — answer with just the key fact (a name, date, place, or short phrase). If the answer requires inference from dates (e.g., "yesterday" relative to the timestamp), do the math. If truly unanswerable, say "unanswerable".`;

  const userPrompt = `Retrieved memories:\n${context}\n\nQuestion: ${question}\n\nAnswer (concise, factual):`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const resp = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 200,
      temperature: 0,
    }, { signal: controller.signal });
    clearTimeout(timeout);
    return resp.choices[0]?.message?.content?.trim() || "";
  } catch (err) {
    console.error(`  LLM error: ${String(err).slice(0, 120)}`);
    return "";
  }
}

// ---------------------------------------------------------------------------
// Scoring (partial-match F1)
// ---------------------------------------------------------------------------

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function computeF1(prediction, groundTruth) {
  const predTokens = tokenize(prediction);
  const gtTokens = tokenize(groundTruth);

  if (predTokens.length === 0 && gtTokens.length === 0) return 1.0;
  if (predTokens.length === 0 || gtTokens.length === 0) return 0.0;

  const predSet = new Set(predTokens);
  const gtSet = new Set(gtTokens);

  let common = 0;
  for (const t of predSet) {
    if (gtSet.has(t)) common++;
  }

  if (common === 0) return 0.0;

  const precision = common / predTokens.length;
  const recall = common / gtTokens.length;
  return (2 * precision * recall) / (precision + recall);
}

// ---------------------------------------------------------------------------
// Main evaluation loop
// ---------------------------------------------------------------------------

async function runBenchmark() {
  console.log("=".repeat(60));
  console.log("UltraMemory LoCoMo Benchmark");
  console.log("=".repeat(60));
  console.log(`Embedding: ${EMBEDDING_MODEL} | LLM: ${LLM_MODEL} | top-k: ${TOP_K}`);
  console.log(`Samples: ${MAX_SAMPLES} | Category: ${CATEGORY_FILTER || "all"}`);
  console.log();

  const dataset = await loadDataset();
  const samples = dataset.slice(0, MAX_SAMPLES);

  const allResults = [];
  const categoryScores = {};
  let totalTokensIn = 0;

  for (const sample of samples) {
    const sampleId = sample.sample_id;
    console.log(`\n--- ${sampleId} ---`);

    // Create fresh MemoryService for this conversation
    const tempDir = await mkdtemp(join(tmpdir(), `locomo-${sampleId}-`));
    const service = new MemoryService({
      dbPath: join(tempDir, "db"),
      embedding: {
        apiKey: EMBEDDING_API_KEY,
        model: EMBEDDING_MODEL,
        baseURL: EMBEDDING_BASE_URL,
        dimensions: EMBEDDING_DIMS,
      },
      smartExtraction: false,
      decay: { enabled: false },
    });

    await service.initialize();

    // Ingest conversation
    const ingestStart = Date.now();
    const { totalTurns, ingested } = await ingestConversation(
      service,
      sample.conversation,
      sampleId,
    );
    const ingestMs = Date.now() - ingestStart;
    console.log(`  Ingested: ${ingested} chunks from ${totalTurns} turns (${ingestMs}ms)`);

    if (DRY_RUN) {
      await service.shutdown();
      await rm(tempDir, { recursive: true, force: true });
      continue;
    }

    // Evaluate QA
    const qaAll = CATEGORY_FILTER
      ? sample.qa.filter((q) => String(q.category) === CATEGORY_FILTER)
      : sample.qa;
    const qaRemaining = MAX_QA - allResults.length;
    const qaList = qaRemaining < qaAll.length ? qaAll.slice(0, qaRemaining) : qaAll;
    if (qaRemaining <= 0) break;

    let correct = 0;
    let total = 0;
    let f1Sum = 0;

    for (const qa of qaList) {
      const question = qa.question;
      const groundTruth = qa.answer;
      const category = String(qa.category);

      // Recall from UltraMemory
      let memories;
      try {
        memories = await service.recall({ query: question, limit: TOP_K });
      } catch {
        memories = [];
      }

      const context = memories.length > 0
        ? memories.map((m, i) => `[${i + 1}] ${m.text}`).join("\n\n")
        : "(no relevant memories found)";

      // Estimate input tokens (rough: 4 chars per token)
      totalTokensIn += Math.ceil((context.length + question.length + 200) / 4);

      // Ask LLM
      const prediction = await askLLM(question, context, LLM_MODEL);
      const f1 = computeF1(prediction, groundTruth);

      f1Sum += f1;
      total++;
      if (f1 >= 0.5) correct++;

      if (!categoryScores[category]) categoryScores[category] = { f1Sum: 0, total: 0, correct: 0 };
      categoryScores[category].f1Sum += f1;
      categoryScores[category].total++;
      if (f1 >= 0.5) categoryScores[category].correct++;

      allResults.push({
        sampleId,
        question,
        groundTruth,
        prediction,
        f1,
        category,
        memoriesRetrieved: memories.length,
      });

      if (VERBOSE) {
        const status = f1 >= 0.5 ? "OK" : "MISS";
        console.log(`  [${status}] cat=${category} f1=${f1.toFixed(3)} Q: ${question.slice(0, 60)}...`);
      }
    }

    const sampleF1 = total > 0 ? f1Sum / total : 0;
    const sampleAcc = total > 0 ? correct / total : 0;
    console.log(`  QA: ${total} questions, F1=${sampleF1.toFixed(3)}, Acc@0.5=${(sampleAcc * 100).toFixed(1)}%`);

    await service.shutdown();
    // LanceDB may hold file locks briefly after shutdown — retry cleanup
    for (let i = 0; i < 3; i++) {
      try { await rm(tempDir, { recursive: true, force: true }); break; } catch { await new Promise(r => setTimeout(r, 500)); }
    }
  }

  if (DRY_RUN) {
    console.log("\n[dry-run] Ingestion complete. Skipping QA evaluation.");
    return;
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("RESULTS");
  console.log("=".repeat(60));

  const totalQA = allResults.length;
  const totalF1 = allResults.reduce((s, r) => s + r.f1, 0) / totalQA;
  const totalAcc = allResults.filter((r) => r.f1 >= 0.5).length / totalQA;

  console.log(`\nOverall: ${totalQA} questions`);
  console.log(`  Mean F1:    ${totalF1.toFixed(4)}`);
  console.log(`  Acc@0.5:    ${(totalAcc * 100).toFixed(2)}%`);
  console.log(`  Est. input tokens: ${(totalTokensIn / 1_000_000).toFixed(2)}M`);

  console.log("\nBy category:");
  for (const [cat, scores] of Object.entries(categoryScores).sort()) {
    const catF1 = scores.f1Sum / scores.total;
    const catAcc = scores.correct / scores.total;
    const name = CATEGORY_NAMES[cat] || cat;
    console.log(
      `  ${cat} (${name}): n=${scores.total}, F1=${catF1.toFixed(4)}, Acc=${(catAcc * 100).toFixed(1)}%`,
    );
  }

  console.log("\nComparison (OpenViking LoCoMo10 reported):");
  console.log("  OpenClaw baseline:         35.65%");
  console.log("  +LanceDB:                  44.55%");
  console.log("  +OpenViking (mem off):     52.08%");
  console.log("  +OpenViking (mem on):      51.23%");
  console.log(`  +UltraMemory (this run):   ${(totalAcc * 100).toFixed(2)}%`);

  // Save detailed results
  const outPath = join(__dirname, "locomo-results.json");
  await writeFile(
    outPath,
    JSON.stringify(
      {
        config: {
          embeddingModel: EMBEDDING_MODEL,
          llmModel: LLM_MODEL,
          topK: TOP_K,
          categoryFilter: CATEGORY_FILTER,
          samples: MAX_SAMPLES,
          timestamp: new Date().toISOString(),
        },
        summary: {
          totalQA: totalQA,
          meanF1: totalF1,
          accAt05: totalAcc,
          estInputTokens: totalTokensIn,
        },
        byCategory: Object.fromEntries(
          Object.entries(categoryScores).map(([cat, s]) => [
            cat,
            {
              name: CATEGORY_NAMES[cat],
              n: s.total,
              meanF1: s.f1Sum / s.total,
              accAt05: s.correct / s.total,
            },
          ]),
        ),
        results: allResults,
      },
      null,
      2,
    ),
  );
  console.log(`\nDetailed results saved to: ${outPath}`);
}

runBenchmark().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
