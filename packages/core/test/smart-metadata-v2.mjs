/**
 * Smart Metadata V2 Test — SupportInfo / ContextualSupport
 * Tests the contextual support extension to OpenViking's SmartMemoryMetadata.
 * Imports production code via jiti (same pattern as other tests in this repo).
 */

import assert from "node:assert/strict";
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
    normalizeContext,
    parseSupportInfo,
    updateSupportStats,
    SUPPORT_CONTEXT_VOCABULARY,
    stringifySmartMetadata,
} = jiti("../src/smart-metadata.ts");

// --- Test 1: normalizeContext maps Chinese aliases ---
console.log("Test 1: normalizeContext maps Chinese aliases...");
const testCases = [
    ["晚上", "evening"], ["早上", "morning"], ["周末", "weekend"],
    ["工作", "work"], ["旅行", "travel"], ["冬天", "winter"],
    ["evening", "evening"], ["morning", "morning"],
    ["下午", "afternoon"], // Fix #4: previously mapped to evening
    ["", "general"], [undefined, "general"],
];
for (const [input, expected] of testCases) {
    const result = normalizeContext(input);
    assert.strictEqual(result, expected, `normalizeContext("${input}") should be "${expected}", got "${result}"`);
}
console.log("  ✅ Chinese alias mapping works correctly");

// --- Test 2: parseSupportInfo handles V1 flat format ---
console.log("\nTest 2: parseSupportInfo handles V1 flat format...");
const v2FromV1 = parseSupportInfo({ confirmations: 3, contradictions: 1 });
assert.strictEqual(v2FromV1.global_strength, 0.75, "V1 {3 conf, 1 contra} → strength 0.75");
assert.strictEqual(v2FromV1.total_observations, 4);
assert.strictEqual(v2FromV1.slices.length, 1);
assert.strictEqual(v2FromV1.slices[0].context, "general");
assert.strictEqual(v2FromV1.slices[0].confirmations, 3);
assert.strictEqual(v2FromV1.slices[0].contradictions, 1);
console.log("  ✅ V1 → V2 migration preserves data");

// --- Test 3: parseSupportInfo handles V2 sliced format with field validation ---
console.log("\nTest 3: parseSupportInfo validates V2 slice fields...");
const v2WithBadFields = parseSupportInfo({
    global_strength: 0.8,
    total_observations: 5,
    slices: [
        { context: "morning", confirmations: 3, contradictions: 0, strength: 1.0, last_observed_at: 1000 },
        { context: "evening", confirmations: -1, contradictions: "bad", strength: 2.0, last_observed_at: null },
        { context: 123 }, // invalid — should be filtered out
    ],
});
assert.strictEqual(v2WithBadFields.slices.length, 2, "Invalid slice (context=123) should be filtered");
assert.strictEqual(v2WithBadFields.slices[1].confirmations, 0, "Negative confirmations should be clamped to 0");
assert.strictEqual(v2WithBadFields.slices[1].contradictions, 0, "Non-number contradictions should default to 0");
assert.strictEqual(v2WithBadFields.slices[1].strength, 0.5, "Out-of-range strength should default to 0.5");
console.log("  ✅ V2 field validation works correctly");

// --- Test 4: updateSupportStats adds new context slice ---
console.log("\nTest 4: updateSupportStats adds new context slice...");
const existing = parseSupportInfo({
    global_strength: 0.75, total_observations: 4,
    slices: [{ context: "general", confirmations: 3, contradictions: 1, strength: 0.75, last_observed_at: 1000 }],
});
const updated = updateSupportStats(existing, "evening", "support");
assert.strictEqual(updated.slices.length, 2, "Should have 2 slices (general + evening)");
assert.strictEqual(updated.total_observations, 5, "Total observations should be 5");
assert.strictEqual(updated.global_strength, 4 / 5, "Global strength = 4/5 = 0.8");
const eveningSlice = updated.slices.find(s => s.context === "evening");
assert.ok(eveningSlice, "Evening slice should exist");
assert.strictEqual(eveningSlice.confirmations, 1);
assert.strictEqual(eveningSlice.strength, 1.0, "1 confirm, 0 contra = 1.0");
console.log("  ✅ New context slice added correctly");

// --- Test 5: updateSupportStats handles contradict event ---
console.log("\nTest 5: updateSupportStats handles contradict event...");
const contradicted = updateSupportStats(updated, "evening", "contradict");
const eveningAfter = contradicted.slices.find(s => s.context === "evening");
assert.strictEqual(eveningAfter.contradictions, 1);
assert.strictEqual(eveningAfter.strength, 0.5, "1 conf + 1 contra = 0.5");
console.log("  ✅ Contradict event recorded correctly");

// --- Test 6: Support slices capped at MAX_SUPPORT_SLICES=8 ---
console.log("\nTest 6: Support slices capped at MAX_SUPPORT_SLICES=8...");
let big = { global_strength: 0.5, total_observations: 0, slices: [] };
for (let i = 0; i < 10; i++) {
    big = updateSupportStats(big, `ctx_${i}`, "support");
}
assert.ok(big.slices.length <= 8, `Should cap at 8 slices, got ${big.slices.length}`);
// total_observations may be slightly less than 10 due to slice truncation drift:
// each updateSupportStats only recovers evidence from slices dropped in *that* call,
// not from earlier truncation cycles. This is the documented trade-off (see code comment).
assert.ok(big.total_observations >= 9, `total_observations should be >=9, got ${big.total_observations}`);
console.log(`  ✅ Slice cap works correctly (${big.slices.length} slices, ${big.total_observations} observations)`);

// --- Test 7: stringifySmartMetadata caps array fields ---
console.log("\nTest 7: stringifySmartMetadata caps sources/history/relations...");
const bigMeta = {
    l0_abstract: "test",
    sources: Array.from({ length: 30 }, (_, i) => `src_${i}`),
    history: Array.from({ length: 60 }, (_, i) => `hist_${i}`),
    relations: Array.from({ length: 20 }, (_, i) => ({ type: "ref", targetId: `t_${i}` })),
};
const serialized = JSON.parse(stringifySmartMetadata(bigMeta));
assert.ok(serialized.sources.length <= 20, `sources should be capped at 20, got ${serialized.sources.length}`);
assert.ok(serialized.history.length <= 50, `history should be capped at 50, got ${serialized.history.length}`);
assert.ok(serialized.relations.length <= 16, `relations should be capped at 16, got ${serialized.relations.length}`);
console.log("  ✅ Metadata caps work correctly");

console.log("\n=== All Smart Metadata V2 tests passed! ===");
