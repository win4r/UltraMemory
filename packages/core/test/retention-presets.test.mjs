import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { RETENTION_PRESETS, resolveRetentionPreset } = jiti("../src/decay-engine.ts");

describe("RETENTION_PRESETS", () => {
  it("default preset has all 6 categories", () => {
    const preset = RETENTION_PRESETS.default;
    assert.ok(preset.profile);
    assert.ok(preset.preferences);
    assert.ok(preset.entities);
    assert.ok(preset.events);
    assert.ok(preset.cases);
    assert.ok(preset.patterns);
  });

  it("legal preset has decayMultiplier 0 for all categories", () => {
    for (const [, policy] of Object.entries(RETENTION_PRESETS.legal)) {
      assert.equal(policy.decayMultiplier, 0);
    }
  });

  it("ephemeral preset has short retention and fast decay", () => {
    assert.ok(RETENTION_PRESETS.ephemeral.events.minRetentionDays <= 7);
    assert.ok(RETENTION_PRESETS.ephemeral.events.decayMultiplier >= 2.0);
  });
});

describe("resolveRetentionPreset", () => {
  it("returns undefined when no preset or overrides", () => {
    assert.equal(resolveRetentionPreset(), undefined);
  });

  it("returns preset by name", () => {
    const result = resolveRetentionPreset("legal");
    assert.equal(result.profile.decayMultiplier, 0);
  });

  it("falls back to default for unknown preset", () => {
    const result = resolveRetentionPreset("nonexistent");
    assert.deepEqual(result, RETENTION_PRESETS.default);
  });

  it("merges custom overrides on top of preset", () => {
    const result = resolveRetentionPreset("default", {
      profile: { minRetentionDays: 9999, decayMultiplier: 0 },
    });
    assert.equal(result.profile.decayMultiplier, 0); // overridden
    assert.equal(result.preferences.decayMultiplier, 0.3); // from default
  });

  it("works with only custom overrides, no preset", () => {
    const result = resolveRetentionPreset(undefined, {
      events: { minRetentionDays: 1, decayMultiplier: 3.0 },
    });
    assert.equal(result.events.decayMultiplier, 3.0);
  });
});
