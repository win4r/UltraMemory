#!/usr/bin/env node
/**
 * LoCoMo Benchmark — OpenClaw Plugin Integration Test
 *
 * Loads memory-lancedb-pro as an OpenClaw plugin (via jiti, same as
 * the OpenClaw host does), stores LoCoMo conversations through the
 * plugin's registerTool handlers, recalls via memory_recall tool,
 * and scores against ground truth.
 *
 * This tests the REAL plugin code path — same as OpenViking's benchmark.
 *
 * Usage:
 *   node benchmarks/locomo-openclaw.mjs [--verbose]
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const VERBOSE = process.argv.includes("--verbose");
const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const DASHSCOPE_KEY = process.env.DASHSCOPE_API_KEY || "";
if (!DASHSCOPE_KEY) {
  console.error("Error: DASHSCOPE_API_KEY env var required");
  process.exit(1);
}
const DASHSCOPE_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const CATEGORY_NAMES = { "1": "single-hop", "2": "multi-hop", "3": "temporal", "4": "open-domain", "5": "adversarial" };

// ---------------------------------------------------------------------------
// Mock OpenClaw host — captures registered tools so we can call them
// ---------------------------------------------------------------------------

function createMockOpenClawApi(pluginConfig, dbPath) {
  const tools = {};

  return {
    pluginConfig,
    logger: {
      info: (msg) => { if (VERBOSE) console.log(`  [plugin] ${msg}`); },
      warn: (msg) => { if (VERBOSE) console.log(`  [plugin:warn] ${msg}`); },
      debug: (msg) => {},
      error: (msg) => console.error(`  [plugin:error] ${msg}`),
    },
    resolvePath: (p) => {
      if (p.startsWith("~")) return join(tmpdir(), p.slice(2));
      return p;
    },
    registerTool: (factory, opts) => {
      // OpenClaw registerTool: factory(toolCtx) => { name, execute, ... }
      const toolDef = factory({ agentId: "bench", workspaceDir: tmpdir() });
      tools[toolDef.name] = toolDef;
    },
    on: (_event, _handler, _opts) => {},
    registerHook: (_event, _handler, _opts) => {},
    registerService: (_config) => {},
    registerCli: (_cli) => {},
    // Expose registered tools for benchmark use
    _tools: tools,
  };
}

// ---------------------------------------------------------------------------
// LLM answering
// ---------------------------------------------------------------------------

async function askLLM(question, context) {
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({ apiKey: DASHSCOPE_KEY, baseURL: DASHSCOPE_BASE });
  try {
    const resp = await client.chat.completions.create({
      model: "qwen3.5-flash",
      messages: [
        { role: "system", content: "You are answering factual questions about a long conversation. Answer based on the retrieved memories. Each memory has a timestamp. Be concise — answer with just the key fact. If dates require inference (e.g. 'yesterday' relative to timestamp), do the math. If unanswerable, say 'unanswerable'." },
        { role: "user", content: `Retrieved memories:\n${context}\n\nQuestion: ${question}\n\nAnswer (concise):` },
      ],
      max_tokens: 150,
      temperature: 0,
    });
    return resp.choices[0]?.message?.content?.trim() || "";
  } catch (err) {
    console.error(`  LLM error: ${String(err).slice(0, 100)}`);
    return "";
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function tokenize(text) {
  return String(text || "").toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter(t => t.length > 0);
}

function computeF1(pred, gt) {
  const p = tokenize(pred), g = tokenize(gt);
  if (!p.length && !g.length) return 1;
  if (!p.length || !g.length) return 0;
  const ps = new Set(p), gs = new Set(g);
  let common = 0;
  for (const t of ps) if (gs.has(t)) common++;
  if (!common) return 0;
  const prec = common / p.length, rec = common / g.length;
  return (2 * prec * rec) / (prec + rec);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=".repeat(60));
  console.log("LoCoMo Benchmark — OpenClaw Plugin (jiti host)");
  console.log("=".repeat(60));
  console.log("Plugin: @ultramemory/openclaw (new monorepo packages)");
  console.log("Embedding: text-embedding-v4 (DashScope 1024d)");
  console.log("LLM: qwen3.5-flash (DashScope)");
  console.log("Retrieval: hybrid vector+bm25");
  console.log();

  // Load dataset
  const dataset = JSON.parse(readFileSync(join(__dirname, "locomo10.json"), "utf8"));
  const sample = dataset[0];
  const sampleId = sample.sample_id;

  // Temp DB
  const runDir = mkdtempSync(join(tmpdir(), "locomo-oc-"));
  const dbPath = join(runDir, "db");

  // Plugin config (same shape as openclaw.json entries)
  const pluginConfig = {
    embedding: {
      provider: "openai-compatible",
      apiKey: DASHSCOPE_KEY,
      model: "text-embedding-v4",
      baseURL: DASHSCOPE_BASE,
      dimensions: 1024,
    },
    dbPath,
    autoCapture: false,
    autoRecall: false,
    smartExtraction: false,
    retrieval: {
      mode: "hybrid", vectorWeight: 0.7, bm25Weight: 0.3, minScore: 0.1, hardMinScore: 0.1,
      rerank: "none", // Jina reranker tested but hurts LoCoMo temporal QA (50%→30%)
      candidatePoolSize: 20,
    },
    sessionMemory: { enabled: false },
    sessionStrategy: "none",
    scopes: { default: "global" },
  };

  // Load the NEW @ultramemory/openclaw package (not the old index.ts)
  console.log("Loading @ultramemory/openclaw via jiti...");
  const openclawModule = jiti(join(repoRoot, "packages", "openclaw", "index.ts"));
  const plugin = openclawModule.default || openclawModule;

  const api = createMockOpenClawApi(pluginConfig, dbPath);
  plugin.register(api);

  // Wait for async MemoryService initialization
  console.log("Waiting for MemoryService initialization...");
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (Object.keys(api._tools).length >= 4) break;
  }

  const memoryStore = api._tools["memory_store"];
  const memoryRecall = api._tools["memory_recall"];

  if (!memoryStore || !memoryRecall) {
    console.error("FATAL: memory_store or memory_recall not registered!");
    console.log("Registered tools:", Object.keys(api._tools).join(", "));
    process.exit(1);
  }
  console.log(`Registered tools: ${Object.keys(api._tools).join(", ")}`);

  // ── Phase 1: Ingest ─────────────────────────────────────────────────
  console.log(`\n--- Ingesting ${sampleId} ---`);

  const sessionKeys = Object.keys(sample.conversation)
    .filter(k => k.match(/^session_\d+$/) && Array.isArray(sample.conversation[k]))
    .sort((a, b) => parseInt(a.replace("session_", "")) - parseInt(b.replace("session_", "")));

  let ingested = 0;
  const t0 = Date.now();

  for (const sk of sessionKeys) {
    const date = sample.conversation[sk + "_date_time"] || "";
    const turns = sample.conversation[sk];

    // 2-turn dialogue pairs
    for (let i = 0; i < turns.length; i += 2) {
      const t1 = turns[i];
      const t2 = turns[i + 1];
      let text = `[${date}] ${t1.speaker}: ${t1.text}`;
      if (t2) text += `\n${t2.speaker}: ${t2.text}`;

      try {
        await memoryStore.execute("bench-store", { text, category: "fact", importance: 0.7 });
        ingested++;
      } catch (err) {
        if (VERBOSE) console.log(`  Store error: ${String(err).slice(0, 80)}`);
      }
    }

    // Session summary
    const summary = turns.map(t => `${t.speaker}: ${t.text}`).join("\n").slice(0, 2000);
    try {
      await memoryStore.execute("bench-store", { text: `[Session on ${date}]\n${summary}`, category: "fact", importance: 0.8 });
      ingested++;
    } catch (err) {
      if (VERBOSE) console.log(`  Session store error: ${String(err).slice(0, 80)}`);
    }

    if (ingested % 20 === 0) process.stdout.write(`  ${ingested}...`);
  }
  console.log(`\n  Ingested ${ingested} memories in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ── Phase 2: QA ─────────────────────────────────────────────────────
  console.log(`\n--- Evaluating QA (10 questions) ---`);

  const qaList = sample.qa.slice(0, 10);
  const results = [];

  for (const qa of qaList) {
    const question = qa.question;
    const groundTruth = String(qa.answer || "");
    const category = String(qa.category);

    // Recall via the REAL plugin tool
    let recallText = "(no memories)";
    try {
      const recallResult = await memoryRecall.execute("bench-recall", { query: question, limit: 10, includeFullText: true });
      // Extract text from the tool result
      if (recallResult?.content?.[0]?.text) {
        recallText = recallResult.content[0].text;
      }
      if (recallResult?.details?.memories) {
        recallText = recallResult.details.memories
          .map((m, i) => `[${i + 1}] ${m.text}`)
          .join("\n\n");
      }
    } catch (err) {
      if (VERBOSE) console.log(`  Recall error: ${String(err).slice(0, 100)}`);
    }

    // Ask LLM
    const prediction = await askLLM(question, recallText);
    const f1 = computeF1(prediction, groundTruth);
    const status = f1 >= 0.5 ? "OK" : "MISS";
    results.push({ question, groundTruth, prediction, f1, category });

    console.log(`  [${status}] cat=${category}(${CATEGORY_NAMES[category] || "?"}) f1=${f1.toFixed(3)} Q: ${question.slice(0, 55)}...`);
    if (VERBOSE) console.log(`    GT: ${groundTruth} | Pred: ${prediction.slice(0, 80)}`);
  }

  // ── Phase 3: Summary ─────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log("RESULTS (OpenClaw plugin path, memory-lancedb-pro)");
  console.log("=".repeat(60));

  const totalF1 = results.reduce((s, r) => s + r.f1, 0) / results.length;
  const totalAcc = results.filter(r => r.f1 >= 0.5).length / results.length;

  console.log(`\n  Questions:  ${results.length}`);
  console.log(`  Mean F1:    ${totalF1.toFixed(4)}`);
  console.log(`  Acc@0.5:    ${(totalAcc * 100).toFixed(1)}%`);

  const cats = {};
  for (const r of results) {
    if (!cats[r.category]) cats[r.category] = { f1: 0, n: 0, ok: 0 };
    cats[r.category].f1 += r.f1;
    cats[r.category].n++;
    if (r.f1 >= 0.5) cats[r.category].ok++;
  }
  console.log("\n  By category:");
  for (const [c, s] of Object.entries(cats).sort()) {
    console.log(`    ${c}(${CATEGORY_NAMES[c]}): n=${s.n} F1=${(s.f1/s.n).toFixed(3)} Acc=${(s.ok/s.n*100).toFixed(0)}%`);
  }

  console.log("\n  Comparison:");
  console.log("    OpenClaw baseline:          35.65%");
  console.log("    +OpenViking (mem off):      52.08%");
  console.log(`    +memory-lancedb-pro (ours): ${(totalAcc * 100).toFixed(1)}%`);

  const outPath = join(__dirname, "locomo-openclaw-results.json");
  writeFileSync(outPath, JSON.stringify({
    method: "openclaw-plugin-jiti",
    plugin: "memory-lancedb-pro",
    embedding: "text-embedding-v4",
    llm: "qwen3.5-flash",
    retrieval: "hybrid",
    results,
    summary: { n: results.length, meanF1: totalF1, accAt05: totalAcc },
  }, null, 2));
  console.log(`\n  Saved: ${outPath}`);

  // Cleanup
  try { rmSync(runDir, { recursive: true, force: true }); } catch {}
}

main().catch(err => { console.error("Failed:", err); process.exit(1); });
