/**
 * Multi-Vector Fanout Test
 * Tests that vector_l0/l1/l2 columns are created, written, and searchable
 * via the `column` option in vectorSearch().
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import Module from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.NODE_PATH = [
    process.env.NODE_PATH,
    "/opt/homebrew/lib/node_modules/openclaw/node_modules",
    "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

import jitiFactory from "jiti";
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");

const DIM = 64;
const workDir = mkdtempSync(path.join(tmpdir(), "multi-vector-test-"));
const dbPath = path.join(workDir, "db");

try {
    const store = new MemoryStore({ dbPath, vectorDim: DIM });

    // Create vectors for different "concepts"
    const conceptVec = new Array(DIM).fill(0); conceptVec[0] = 1.0;
    const detailVec = new Array(DIM).fill(0); detailVec[1] = 1.0;
    const mainVec = new Array(DIM).fill(0); mainVec[0] = 0.7; mainVec[1] = 0.7;

    // Store a memory with distinct vectors per layer
    console.log("Storing entry with multi-vector columns...");
    const entry = await store.store({
        text: "Main text about TypeScript",
        vector: mainVec,
        category: "fact",
        scope: "global",
        importance: 0.7,
        metadata: "{}",
        vector_l0: conceptVec,   // concept-level
        vector_l1: mainVec,      // structure-level (same as main)
        vector_l2: detailVec,    // detail-level
    });

    assert.ok(entry.id, "Entry should have an ID");
    console.log(`  Entry stored with id=${entry.id}`);

    // Test 1: Default vector column search
    console.log("Test 1: Default vector column search...");
    const defaultResults = await store.vectorSearch(mainVec, 5, 0.1, ["global"]);
    assert.ok(defaultResults.length > 0, "Default vector search should find the entry");
    console.log(`  Found ${defaultResults.length} result(s), score=${defaultResults[0].score.toFixed(3)}`);

    // Test 2: Search on vector_l0 column with concept vector
    console.log("Test 2: Search on vector_l0 column...");
    const l0Results = await store.vectorSearch(conceptVec, 5, 0.1, ["global"], { column: "vector_l0" });
    assert.ok(l0Results.length > 0, "L0 column search should find the entry");
    assert.ok(l0Results[0].score > 0.9, `L0 score should be high (exact match), got ${l0Results[0].score}`);
    console.log(`  L0 score=${l0Results[0].score.toFixed(3)}`);

    // Test 3: Search on vector_l2 column with detail vector
    console.log("Test 3: Search on vector_l2 column...");
    const l2Results = await store.vectorSearch(detailVec, 5, 0.1, ["global"], { column: "vector_l2" });
    assert.ok(l2Results.length > 0, "L2 column search should find the entry");
    assert.ok(l2Results[0].score > 0.9, `L2 score should be high (exact match), got ${l2Results[0].score}`);
    console.log(`  L2 score=${l2Results[0].score.toFixed(3)}`);

    // Test 4: Cross-column: search L0 with detail vector should score low
    console.log("Test 4: Cross-column search (L0 with detail vector)...");
    const crossResults = await store.vectorSearch(detailVec, 5, 0.01, ["global"], { column: "vector_l0" });
    if (crossResults.length > 0) {
        assert.ok(crossResults[0].score < 0.6, `Cross-column score should be low, got ${crossResults[0].score}`);
        console.log(`  Cross-column score=${crossResults[0].score.toFixed(3)} (correctly low)`);
    } else {
        console.log("  Cross-column returned no results (orthogonal vectors, expected)");
    }

    console.log("\n=== All multi-vector fanout tests passed! ===");
} finally {
    rmSync(workDir, { recursive: true, force: true });
}
