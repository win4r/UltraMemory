import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { detectTopicTag, extractTopicTag } = jiti("../src/topic-tag.ts");

describe("detectTopicTag", () => {
  it("detects auth-related content", () => {
    assert.equal(detectTopicTag("Implement JWT authentication with OAuth2 flow"), "auth");
  });

  it("detects deploy-related content", () => {
    assert.equal(detectTopicTag("Set up CI/CD pipeline with GitHub Actions for production deployment"), "deploy");
  });

  it("detects infra-related content", () => {
    assert.equal(detectTopicTag("Configure Docker containers and Kubernetes cluster"), "infra");
  });

  it("detects testing-related content", () => {
    assert.equal(detectTopicTag("Write unit tests with bun test and add coverage for the new module"), "testing");
  });

  it("detects database-related content", () => {
    assert.equal(detectTopicTag("Run SQL migration to add new columns to postgres users table"), "database");
  });

  it("detects api-related content", () => {
    assert.equal(detectTopicTag("Design REST API endpoints for the new webhook integration"), "api");
  });

  it("detects ui-related content", () => {
    assert.equal(detectTopicTag("Build React component with Tailwind CSS for the dashboard layout"), "ui");
  });

  it("detects performance-related content", () => {
    assert.equal(detectTopicTag("Profile cache hit rates and optimize latency bottleneck"), "perf");
  });

  it("detects security-related content", () => {
    assert.equal(detectTopicTag("Fix XSS vulnerability and add CSRF protection"), "security");
  });

  it("detects memory/recall content", () => {
    assert.equal(detectTopicTag("Improve recall retrieval with better embedding vectors for LanceDB"), "memory");
  });

  it("detects mcp-related content", () => {
    assert.equal(detectTopicTag("Register new MCP tool in the Model Context Protocol server"), "mcp");
  });

  it("detects llm-related content", () => {
    assert.equal(detectTopicTag("Optimize prompt engineering for better token efficiency with Claude"), "llm");
  });

  it("returns undefined for generic text", () => {
    assert.equal(detectTopicTag("Had a great day today"), undefined);
  });

  it("returns undefined for empty text", () => {
    assert.equal(detectTopicTag(""), undefined);
  });

  it("picks strongest match when multiple topics present", () => {
    const tag = detectTopicTag("Deploy the authentication service to production using Docker");
    assert.ok(tag !== undefined, "should detect a topic");
    assert.ok(["auth", "deploy", "infra"].includes(tag), `expected auth/deploy/infra, got ${tag}`);
  });

  it("handles Chinese text with English tech terms", () => {
    assert.equal(detectTopicTag("配置 Docker 容器编排和 Kubernetes 集群"), "infra");
  });

  it("truncates very long text for efficiency", () => {
    const longText = "Fix authentication bug. ".repeat(500);
    assert.equal(detectTopicTag(longText), "auth");
  });
});

describe("extractTopicTag", () => {
  it("extracts topic_tag from metadata JSON", () => {
    assert.equal(extractTopicTag('{"topic_tag":"auth","source":"manual"}'), "auth");
  });

  it("returns undefined when no topic_tag", () => {
    assert.equal(extractTopicTag('{"source":"manual"}'), undefined);
  });

  it("returns undefined for invalid JSON", () => {
    assert.equal(extractTopicTag("not json"), undefined);
  });

  it("returns undefined for undefined metadata", () => {
    assert.equal(extractTopicTag(undefined), undefined);
  });
});
