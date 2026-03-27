import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { FeedbackLearner } = jiti("../src/feedback-learner.ts");

describe("FeedbackLearner", () => {
  it("3 positive signals: 0.5 → 0.575 → 0.639 → 0.693", async () => {
    let currentWeight = 0.5;
    const mockStore = {
      async getById() {
        return { id: "a", metadata: JSON.stringify({ feedback_weight: currentWeight }) };
      },
      async patchMetadata(_id, patch) {
        currentWeight = patch.feedback_weight;
        return {};
      },
    };
    const learner = new FeedbackLearner(mockStore, 0.15);
    await learner.recordPositive("a");
    assert.ok(Math.abs(currentWeight - 0.575) < 0.001);
    await learner.recordPositive("a");
    assert.ok(Math.abs(currentWeight - 0.639) < 0.001);
    await learner.recordPositive("a");
    assert.ok(Math.abs(currentWeight - 0.693) < 0.001);
  });

  it("negative signal decreases weight", async () => {
    let currentWeight = 0.5;
    const mockStore = {
      async getById() {
        return { id: "a", metadata: JSON.stringify({ feedback_weight: currentWeight }) };
      },
      async patchMetadata(_id, patch) { currentWeight = patch.feedback_weight; return {}; },
    };
    const learner = new FeedbackLearner(mockStore, 0.15);
    await learner.recordNegative("a");
    assert.ok(currentWeight < 0.5);
    assert.ok(Math.abs(currentWeight - 0.425) < 0.001);
  });

  it("missing memory is no-op", async () => {
    const mockStore = { async getById() { return null; }, async patchMetadata() {} };
    const learner = new FeedbackLearner(mockStore, 0.15);
    await learner.recordPositive("nonexistent"); // should not throw
  });

  it("setDirect clamps to [0, 1]", async () => {
    let currentWeight = 0.5;
    const mockStore = {
      async getById() {
        return { id: "a", metadata: JSON.stringify({ feedback_weight: currentWeight }) };
      },
      async patchMetadata(_id, patch) { currentWeight = patch.feedback_weight; return {}; },
    };
    const learner = new FeedbackLearner(mockStore, 0.15);
    await learner.setDirect("a", 1.5);
    assert.equal(currentWeight, 1);
    await learner.setDirect("a", -0.5);
    assert.equal(currentWeight, 0);
  });
});
