import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { parseSmartMetadata, buildSmartMetadata } = jiti("../src/smart-metadata.ts");

describe("trust_level in SmartMemoryMetadata", () => {
  it("defaults to 'source' when not set", () => {
    const meta = parseSmartMetadata("{}", { text: "hello" });
    assert.equal(meta.trust_level, "source");
  });

  it("preserves 'generated' trust_level", () => {
    const meta = parseSmartMetadata(
      JSON.stringify({ trust_level: "generated" }),
      { text: "abstract" },
    );
    assert.equal(meta.trust_level, "generated");
  });

  it("buildSmartMetadata can set trust_level", () => {
    const meta = buildSmartMetadata(
      { text: "test" },
      { trust_level: "generated" },
    );
    assert.equal(meta.trust_level, "generated");
  });

  it("normalizes consolidation as valid MemorySource", () => {
    const meta = parseSmartMetadata(
      JSON.stringify({ source: "consolidation" }),
      { text: "test" },
    );
    assert.equal(meta.source, "consolidation");
  });
});
