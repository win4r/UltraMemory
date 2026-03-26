import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { syncManifestVersion } from "../scripts/sync-plugin-version.mjs";

test("syncManifestVersion only updates the top-level manifest version", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "sync-plugin-version-"));

  try {
    const packagePath = path.join(tempDir, "package.json");
    const manifestPath = path.join(tempDir, "openclaw.plugin.json");
    const originalManifest = `{
  "id": "memory-lancedb-pro",
  "version": "1.1.0-beta.5",
  "uiHints": {
    "llm.apiKey": {
      "label": "Legacy help text"
    },
    "llm.apiKey": {
      "label": "Current help text"
    }
  }
}
`;

    writeFileSync(
      packagePath,
      JSON.stringify({ name: "memory-lancedb-pro", version: "1.1.1-beta.0" }, null, 2),
    );
    writeFileSync(manifestPath, originalManifest);

    syncManifestVersion({ manifestPath, packagePath });

    const updatedManifest = readFileSync(manifestPath, "utf8");
    assert.equal(
      updatedManifest,
      originalManifest.replace('"version": "1.1.0-beta.5"', '"version": "1.1.1-beta.0"'),
    );
    assert.equal(updatedManifest.match(/"llm\.apiKey"/g)?.length, 2);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
