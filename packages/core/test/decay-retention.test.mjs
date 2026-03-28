import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createDecayEngine } = jiti("../src/decay-engine.ts");

describe("decay engine with retention policies", () => {
  it("applies retention floor during minRetentionDays", () => {
    const engine = createDecayEngine({
      recencyHalfLifeDays: 14,
      retentionPolicies: {
        profile: { minRetentionDays: 365, decayMultiplier: 0.2 },
      },
    });

    const score = engine.score({
      id: "a", importance: 0.9, confidence: 0.9, tier: "working",
      accessCount: 1, createdAt: Date.now() - 30 * 86400000,
      lastAccessedAt: Date.now() - 30 * 86400000,
    }, Date.now(), "profile");

    assert.ok(score.composite >= 0.7, `Expected >= 0.7, got ${score.composite}`);
  });

  it("applies faster decay with high decayMultiplier", () => {
    const engine = createDecayEngine({
      recencyHalfLifeDays: 14,
      retentionPolicies: {
        events: { minRetentionDays: 7, decayMultiplier: 2.0 },
      },
    });

    const withPolicy = engine.score({
      id: "a", importance: 0.5, confidence: 0.7, tier: "working",
      accessCount: 1, createdAt: Date.now() - 30 * 86400000,
      lastAccessedAt: Date.now() - 30 * 86400000,
    }, Date.now(), "events");

    const withoutPolicy = engine.score({
      id: "a", importance: 0.5, confidence: 0.7, tier: "working",
      accessCount: 1, createdAt: Date.now() - 30 * 86400000,
      lastAccessedAt: Date.now() - 30 * 86400000,
    }, Date.now());

    assert.ok(withPolicy.composite < withoutPolicy.composite,
      `With policy (${withPolicy.composite}) should be < without (${withoutPolicy.composite})`);
  });

  it("behaves identically when no category provided", () => {
    const engine = createDecayEngine({
      recencyHalfLifeDays: 14,
      retentionPolicies: {
        profile: { minRetentionDays: 365, decayMultiplier: 0.2 },
      },
    });

    const withCategory = engine.score({
      id: "a", importance: 0.5, confidence: 0.7, tier: "working",
      accessCount: 1, createdAt: Date.now() - 30 * 86400000,
      lastAccessedAt: Date.now() - 30 * 86400000,
    }, Date.now(), "events"); // no policy for "events"

    const withoutCategory = engine.score({
      id: "a", importance: 0.5, confidence: 0.7, tier: "working",
      accessCount: 1, createdAt: Date.now() - 30 * 86400000,
      lastAccessedAt: Date.now() - 30 * 86400000,
    }, Date.now());

    assert.equal(withCategory.composite, withoutCategory.composite);
  });
});
