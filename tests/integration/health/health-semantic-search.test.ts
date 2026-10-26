// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * End to end: `akm index` records its semantic-search state in index.db, `akm
 * health`'s `semantic-search` check reads it (no model, no request), and the
 * health report's "Semantic Search" line shows that check.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmHealth } from "../../../src/commands/health";
import { buildHealthHtmlReplacements } from "../../../src/commands/health/html-report";
import { buildHealthReportViewModel } from "../../../src/commands/health/report-view-model";
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

function reportFor(result: AkmHealthResult) {
  const opts = { window: "24h", compare: "24h", proposals: [] };
  return { vm: buildHealthReportViewModel(result, opts), html: buildHealthHtmlReplacements(result, opts) };
}

describe("semantic-search health check, end to end", () => {
  test("a ready index passes and the report shows OK", async () => {
    const { result, check } = await indexAndCheck({ semanticSearchMode: "auto" }, { AKM_EMBED_DETERMINISTIC: "1" });

    expect(check?.status).toBe("pass");
    expect(check?.message).toBe("Semantic search ready (2/2 embeddings).");
    expect(check?.evidence).toMatchObject({ status: "ready-js", provider: "local", entryCount: 2, embeddingCount: 2 });
    expect(reportFor(result).vm.sem).toEqual({ label: "OK", status: "pass", detail: check?.message ?? "" });
  });

  test("a native library that does not load fails as unavailable, and the report says UNAVAILABLE in red with the reason", async () => {
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

    const { vm, html } = reportFor(result);
    expect(vm.sem.label).toBe("UNAVAILABLE");
    expect(html["%%KPI_CARDS_HTML%%"]).toMatch(
      /<div class="kpi-card red">\s*<div class="label">Semantic Search<\/div>\s*<div class="value"[^>]*>UNAVAILABLE<\/div>\s*<div class="sub">Semantic search was unavailable on this machine[^<]*failed to map segment/,
    );
    expect(html["%%ACTION_ITEMS_HTML%%"]).toContain("Semantic search unavailable");
  });

  test("a platform with no native library warns, and the report says UNAVAILABLE in yellow with no action item", async () => {
    overrideSeam(_setLocalPipelineLoaderForTests, async () => {
      throw new LocalRuntimeUnavailableError("no native library is available for this platform", "platform");
    });
    const { result, check } = await indexAndCheck({ semanticSearchMode: "auto" });

    expect(check?.status).toBe("warn");
    expect(check?.evidence).toMatchObject({ status: "unavailable", unavailable: "platform" });
    expect(check?.message).toContain("unavailable on this platform");
    expect(check?.message).toContain('Set semanticSearchMode to "off"');
    expect(result.status).toBe("warn");

    const { vm, html } = reportFor(result);
    expect(vm.sem).toMatchObject({ label: "UNAVAILABLE", status: "warn" });
    expect(html["%%KPI_CARDS_HTML%%"]).toMatch(
      /<div class="kpi-card yellow">\s*<div class="label">Semantic Search<\/div>\s*<div class="value"[^>]*>UNAVAILABLE<\/div>/,
    );
    expect(html["%%ACTION_ITEMS_HTML%%"]).not.toContain("Semantic search");
  });

  test("an unreachable embedding endpoint fails as blocked, with the recorded reason", async () => {
    const { result, check } = await indexAndCheck({
      semanticSearchMode: "auto",
      embedding: { endpoint: "http://127.0.0.1:9/v1", model: "m" },
    });

    expect(check?.status).toBe("fail");
    expect(check?.evidence).toMatchObject({ status: "blocked", provider: "remote" });
    expect(check?.message).toContain("Semantic search was blocked at the last index");
    expect(reportFor(result).vm.sem.label).toBe("BLOCKED");
  });

  test("semantic search off passes and the report shows OFF", async () => {
    const { result, check } = await indexAndCheck({ semanticSearchMode: "off" });

    expect(check?.status).toBe("pass");
    expect(reportFor(result).vm.sem.label).toBe("OFF");
  });
});
