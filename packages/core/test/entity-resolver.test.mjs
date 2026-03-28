import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { EntityResolver, BUILTIN_ALIASES } = jiti("../src/entity-resolver.ts");

describe("EntityResolver", () => {
  it("resolves TS to typescript", () => {
    const resolver = new EntityResolver(BUILTIN_ALIASES);
    assert.equal(resolver.resolve("TS"), "typescript");
  });

  it("resolves React.js to react", () => {
    const resolver = new EntityResolver(BUILTIN_ALIASES);
    assert.equal(resolver.resolve("React.js"), "react");
  });

  it("unknown terms pass through lowercase", () => {
    const resolver = new EntityResolver(BUILTIN_ALIASES);
    assert.equal(resolver.resolve("MyCustomLib"), "mycustomlib");
  });

  it("user alias overrides builtin", () => {
    const resolver = new EntityResolver(BUILTIN_ALIASES, { ts: "my-typescript-fork" });
    assert.equal(resolver.resolve("TS"), "my-typescript-fork");
  });

  it("is case-insensitive", () => {
    const resolver = new EntityResolver(BUILTIN_ALIASES);
    assert.equal(resolver.resolve("kubernetes"), "kubernetes");
    assert.equal(resolver.resolve("K8S"), "kubernetes");
    assert.equal(resolver.resolve("k8s"), "kubernetes");
  });

  it("tf is not mapped (ambiguous)", () => {
    const resolver = new EntityResolver(BUILTIN_ALIASES);
    assert.equal(resolver.resolve("tf"), "tf");
  });

  it("resolves common programming languages", () => {
    const resolver = new EntityResolver(BUILTIN_ALIASES);
    assert.equal(resolver.resolve("js"), "javascript");
    assert.equal(resolver.resolve("py"), "python");
    assert.equal(resolver.resolve("rs"), "rust");
    assert.equal(resolver.resolve("go"), "golang");
  });

  it("resolves database aliases", () => {
    const resolver = new EntityResolver(BUILTIN_ALIASES);
    assert.equal(resolver.resolve("pg"), "postgresql");
    assert.equal(resolver.resolve("postgres"), "postgresql");
    assert.equal(resolver.resolve("mongo"), "mongodb");
  });
});
