import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { scoreBenchmarkResult, computeSuiteMetrics } = jiti(
  "../src/eval/benchmark.ts",
);

describe("scoreBenchmarkResult", () => {
  it("perfect recall scores 1.0", () => {
    const query = {
      text: "What is the user's favorite color?",
      expectedIds: ["m1", "m2", "m3"],
      notExpectedIds: [],
    };
    const results = [
      { id: "m1", score: 0.95 },
      { id: "m2", score: 0.90 },
      { id: "m3", score: 0.85 },
    ];

    const score = scoreBenchmarkResult(query, results);

    assert.equal(score.recall, 1.0, "all expected IDs found => recall=1.0");
    assert.equal(
      score.precision,
      1.0,
      "all results are expected => precision=1.0",
    );
    assert.equal(score.mrr, 1.0, "first result is expected => mrr=1.0");
    assert.equal(
      score.contamination,
      0,
      "no notExpected IDs found => contamination=0",
    );
  });

  it("partial recall scores between 0 and 1", () => {
    const query = {
      text: "User preferences",
      expectedIds: ["m1", "m2", "m3", "m4"],
      notExpectedIds: [],
    };
    // Only m1 and m3 returned; m2, m4 missing; extra m99 not in expected
    const results = [
      { id: "m99", score: 0.95 },
      { id: "m1", score: 0.90 },
      { id: "m3", score: 0.80 },
    ];

    const score = scoreBenchmarkResult(query, results);

    // recall: 2 found / 4 expected = 0.5
    assert.ok(
      Math.abs(score.recall - 0.5) < 0.001,
      `recall expected 0.5, got ${score.recall}`,
    );
    // precision: 2 relevant / 3 total results = 0.667
    assert.ok(
      Math.abs(score.precision - 2 / 3) < 0.001,
      `precision expected ~0.667, got ${score.precision}`,
    );
    // mrr: first expected result is m1 at rank 2 => 1/2 = 0.5
    assert.ok(
      Math.abs(score.mrr - 0.5) < 0.001,
      `mrr expected 0.5, got ${score.mrr}`,
    );
    assert.equal(score.contamination, 0, "no notExpected IDs");
  });

  it("detects conflict contamination", () => {
    const query = {
      text: "What is the capital?",
      expectedIds: ["m1"],
      notExpectedIds: ["bad1", "bad2"],
    };
    const results = [
      { id: "m1", score: 0.95 },
      { id: "bad1", score: 0.80 },
      { id: "other", score: 0.70 },
      { id: "bad2", score: 0.60 },
    ];

    const score = scoreBenchmarkResult(query, results);

    assert.equal(score.recall, 1.0, "expected m1 found");
    assert.equal(
      score.contamination,
      2,
      "both bad1 and bad2 are contamination",
    );
  });

  it("handles empty results gracefully", () => {
    const query = {
      text: "anything",
      expectedIds: ["m1", "m2"],
      notExpectedIds: ["bad1"],
    };
    const results = [];

    const score = scoreBenchmarkResult(query, results);

    assert.equal(score.recall, 0, "no results => recall=0");
    assert.equal(score.precision, 0, "no results => precision=0");
    assert.equal(score.mrr, 0, "no results => mrr=0");
    assert.equal(score.contamination, 0, "no results => contamination=0");
  });

  it("only scores top 5 results", () => {
    const query = {
      text: "What is the user's favorite color?",
      expectedIds: ["m1"],
      notExpectedIds: ["bad1"],
    };
    // m1 is at rank 6 — should not be found within top 5
    const results = [
      { id: "x1", score: 0.99 },
      { id: "x2", score: 0.98 },
      { id: "x3", score: 0.97 },
      { id: "x4", score: 0.96 },
      { id: "x5", score: 0.95 },
      { id: "m1", score: 0.90 },
      { id: "bad1", score: 0.80 },
    ];

    const score = scoreBenchmarkResult(query, results);

    assert.equal(score.recall, 0, "m1 is beyond top 5 => recall=0");
    assert.equal(score.contamination, 0, "bad1 is beyond top 5 => contamination=0");
    assert.equal(score.precision, 0, "no expected in top 5 => precision=0");
  });

  it("handles empty expectedIds", () => {
    const query = {
      text: "anything",
      expectedIds: [],
      notExpectedIds: ["bad1"],
    };
    const results = [
      { id: "m1", score: 0.9 },
      { id: "bad1", score: 0.8 },
    ];

    const score = scoreBenchmarkResult(query, results);

    assert.equal(score.recall, 0, "no expected => recall=0");
    assert.equal(score.precision, 0, "no expected => precision=0");
    assert.equal(score.mrr, 0, "no expected => mrr=0");
    assert.equal(score.contamination, 1, "bad1 found");
  });
});

describe("computeSuiteMetrics", () => {
  it("aggregates scores across queries", () => {
    const scores = [
      {
        query: "q1",
        recall: 1.0,
        precision: 1.0,
        mrr: 1.0,
        contamination: 0,
        latencyMs: 50,
      },
      {
        query: "q2",
        recall: 0.5,
        precision: 0.8,
        mrr: 0.5,
        contamination: 2,
        latencyMs: 100,
      },
      {
        query: "q3",
        recall: 0.75,
        precision: 0.6,
        mrr: 0.33,
        contamination: 1,
        latencyMs: 200,
      },
    ];

    const metrics = computeSuiteMetrics(scores);

    // recall_at_5: avg of (1.0, 0.5, 0.75) = 0.75
    assert.ok(
      Math.abs(metrics.recall_at_5 - 0.75) < 0.001,
      `recall_at_5 expected 0.75, got ${metrics.recall_at_5}`,
    );
    // precision_at_5: avg of (1.0, 0.8, 0.6) = 0.8
    assert.ok(
      Math.abs(metrics.precision_at_5 - 0.8) < 0.001,
      `precision_at_5 expected 0.8, got ${metrics.precision_at_5}`,
    );
    // mrr: avg of (1.0, 0.5, 0.33) = 0.61
    assert.ok(
      Math.abs(metrics.mrr - 0.61) < 0.01,
      `mrr expected ~0.61, got ${metrics.mrr}`,
    );
    // conflictContamination: avg of (0, 2, 1) = 1.0
    assert.ok(
      Math.abs(metrics.conflictContamination - 1.0) < 0.001,
      `conflictContamination expected 1.0, got ${metrics.conflictContamination}`,
    );

    // latency_p50_ms: median of [50, 100, 200] = 100
    assert.equal(metrics.latency_p50_ms, 100, "p50 latency");
    // latency_p99_ms: p99 of [50, 100, 200] = 200 (with 3 entries, p99 is max)
    assert.equal(metrics.latency_p99_ms, 200, "p99 latency");
  });

  it("handles single query", () => {
    const scores = [
      {
        query: "q1",
        recall: 0.8,
        precision: 0.9,
        mrr: 1.0,
        contamination: 0,
        latencyMs: 42,
      },
    ];

    const metrics = computeSuiteMetrics(scores);

    assert.ok(Math.abs(metrics.recall_at_5 - 0.8) < 0.001);
    assert.ok(Math.abs(metrics.precision_at_5 - 0.9) < 0.001);
    assert.ok(Math.abs(metrics.mrr - 1.0) < 0.001);
    assert.equal(metrics.conflictContamination, 0);
    assert.equal(metrics.latency_p50_ms, 42);
    assert.equal(metrics.latency_p99_ms, 42);
  });

  it("handles empty scores array", () => {
    const metrics = computeSuiteMetrics([]);

    assert.equal(metrics.recall_at_5, 0);
    assert.equal(metrics.precision_at_5, 0);
    assert.equal(metrics.mrr, 0);
    assert.equal(metrics.conflictContamination, 0);
    assert.equal(metrics.latency_p50_ms, 0);
    assert.equal(metrics.latency_p99_ms, 0);
  });
});
