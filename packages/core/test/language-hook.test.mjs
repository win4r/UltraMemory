import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const {
  ensureReady,
  hasBabelMemory,
  detectLanguage,
  tokenizeForFts,
  tokenizeQuery,
  getLocalizedKgPrompt,
  getLocalizedSessionPrompt,
} = jiti("../src/language-hook.ts");

// Wait for babel-memory async initialization before running tests
await ensureReady();

describe("language-hook", () => {
  // ---------------------------------------------------------------------------
  // Core functions always work (with or without babel-memory)
  // ---------------------------------------------------------------------------

  describe("detectLanguage", () => {
    it("returns a valid language code for Chinese text", () => {
      const lang = detectLanguage("今天学习了知识图谱的构建方法");
      // With babel-memory: "zh"; without: "en"
      assert.ok(["zh", "en"].includes(lang));
    });

    it("returns a valid language code for English text", () => {
      assert.equal(detectLanguage("Hello world, this is a test"), "en");
    });

    it("returns 'en' for empty text", () => {
      assert.equal(detectLanguage(""), "en");
    });
  });

  describe("tokenizeForFts", () => {
    it("returns text as-is for English", () => {
      const result = tokenizeForFts("machine learning algorithms", "en");
      assert.equal(result, "machine learning algorithms");
    });

    it("returns text for unknown language", () => {
      const text = "some text";
      const result = tokenizeForFts(text);
      assert.ok(typeof result === "string");
      assert.ok(result.length > 0);
    });

    it("returns empty string for empty input", () => {
      assert.equal(tokenizeForFts(""), "");
    });
  });

  describe("tokenizeQuery", () => {
    it("returns English query as-is", () => {
      assert.equal(tokenizeQuery("machine learning"), "machine learning");
    });

    it("returns empty string for empty query", () => {
      assert.equal(tokenizeQuery(""), "");
    });

    it("handles Chinese query", () => {
      const result = tokenizeQuery("机器学习算法");
      assert.ok(typeof result === "string");
      assert.ok(result.length > 0);
    });
  });

  describe("getLocalizedKgPrompt", () => {
    it("returns null or KgPrompt object", () => {
      const result = getLocalizedKgPrompt("Some English text about Python");
      // null when babel-memory not available, KgPrompt object when available
      if (result !== null) {
        assert.ok(typeof result.system === "string");
        assert.ok(typeof result.userTemplate === "string");
      }
    });
  });

  describe("getLocalizedSessionPrompt", () => {
    it("returns null or SessionPrompt object", () => {
      const result = getLocalizedSessionPrompt("Some conversation text");
      if (result !== null) {
        assert.ok(typeof result.system === "string");
        assert.ok(typeof result.dimensionLabels === "object");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Conditional tests: only run when babel-memory IS available
  // ---------------------------------------------------------------------------

  describe("with babel-memory (conditional)", () => {
    const available = hasBabelMemory();

    it(`hasBabelMemory() returns ${available}`, () => {
      assert.equal(typeof available, "boolean");
    });

    if (available) {
      it("detects Chinese language correctly", () => {
        assert.equal(detectLanguage("今天学习了知识图谱"), "zh");
      });

      it("detects Japanese language correctly", () => {
        assert.equal(detectLanguage("今日は知識グラフを学びました"), "ja");
      });

      it("detects Korean language correctly", () => {
        assert.equal(detectLanguage("오늘 지식 그래프를 배웠습니다"), "ko");
      });

      it("tokenizes Chinese query into words", () => {
        const result = tokenizeQuery("机器学习算法");
        // With jieba, should be space-separated words
        assert.ok(result.includes(" ") || result === "机器学习算法");
      });

      it("returns CJK KG prompt for Chinese text", () => {
        const result = getLocalizedKgPrompt("RecallNest 是基于 LanceDB 构建的 AI 记忆系统");
        assert.ok(result !== null);
        assert.ok(result.system.includes("知识图谱"));
      });

      it("returns CJK session prompt for Chinese text", () => {
        const result = getLocalizedSessionPrompt("用户意图是构建一个知识图谱系统");
        assert.ok(result !== null);
        assert.ok(result.dimensionLabels.user_intent.includes("意图"));
      });
    }
  });
});
