// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * End to end: `akm index` records its semantic-search state in index.db, `akm
 * health`'s `semantic-search` check reads it (no model, no request).
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmHealth } from "../../../src/commands/health";
import type { AkmHealthResult, HealthCheckResult } from "../../../src/commands/health/types";
import { akmIndex } from "../../../src/indexer/indexer";
import { _setLocalPipelineLoaderForTests } from "../../../src/llm/embedder";
import { LocalRuntimeUnavailableError } from "../../../src/llm/embedders/local";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";
import { overrideSeam } from "../../_helpers/seams";

// Each case runs the real indexer and the health DB round-trip probe.
setDefaultTimeout(30_000);

let storage: IsolatedAkmStorage | undefined;

afterEach(() => {
  storage?.cleanup();
  storage = undefined;
});

async function indexAndCheck(
  config: Record<string, unknown>,
  env?: Record<string, string>,
): Promise<{ result: AkmHealthResult; check: HealthCheckResult | undefined }> {
  storage = withIsolatedAkmStorage(env);
  writeSandboxConfig({
    ...config,
    defaultBundle: "fixture",
    bundles: { fixture: { path: storage.stashDir, components: { main: { root: ".", adapter: "akm" } } } },
  });
  for (const name of ["alpha", "beta"]) {
    const file = path.join(storage.stashDir, "knowledge", `${name}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\ndescription: ${name} note\n---\n# ${name}\n`);
  }
  await akmIndex({ stashDir: storage.stashDir, full: true });
  const result = await akmHealth({ since: "24h" });
  return { result, check: result.hardChecks.find((c) => c.name === "semantic-search") };
}

describe("semantic-search health check, end to end", () => {
  test("a ready index passes", async () => {
    const { check } = await indexAndCheck({ semanticSearchMode: "auto" }, { AKM_EMBED_DETERMINISTIC: "1" });

    expect(check?.status).toBe("pass");
    expect(check?.message).toBe("Semantic search ready (2/2 embeddings).");
    expect(check?.evidence).toMatchObject({ status: "ready-js", provider: "local", entryCount: 2, embeddingCount: 2 });
  });

  test("a native library that does not load fails as unavailable", async () => {
    overrideSeam(_setLocalPipelineLoaderForTests, async () => {
      throw new LocalRuntimeUnavailableError("libonnxruntime.so.1: failed to map segment from shared object", "load");
    });
    const { result, check } = await indexAndCheck({ semanticSearchMode: "auto" });

    expect(check?.status).toBe("fail");
    expect(check?.evidence).toMatchObject({
      status: "unavailable",
      unavailable: "load",
      entryCount: 2,
      embeddingCount: 0,
    });
    expect(check?.message).toContain("failed to map segment from shared object");
    expect(result.status).toBe("fail");
  });

  test("a platform with no native library warns", async () => {
    overrideSeam(_setLocalPipelineLoaderForTests, async () => {
      throw new LocalRuntimeUnavailableError("no native library is available for this platform", "platform");
    });
    const { result, check } = await indexAndCheck({ semanticSearchMode: "auto" });

    expect(check?.status).toBe("warn");
    expect(check?.evidence).toMatchObject({ status: "unavailable", unavailable: "platform" });
    expect(check?.message).toContain("unavailable on this platform");
    expect(check?.message).toContain("akm setup --embedding off");
    expect(result.status).toBe("warn");
  });

  test("an unreachable embedding endpoint fails as blocked, with the recorded reason", async () => {
    const { check } = await indexAndCheck({
      semanticSearchMode: "auto",
      embedding: { endpoint: "http://127.0.0.1:9/v1", model: "m" },
    });

    expect(check?.status).toBe("fail");
    expect(check?.evidence).toMatchObject({ status: "blocked", provider: "remote" });
    expect(check?.message).toContain("Semantic search was blocked at the last index");
  });

  test("semantic search off passes", async () => {
    const { check } = await indexAndCheck({ semanticSearchMode: "off" });

    expect(check?.status).toBe("pass");
  });
});
