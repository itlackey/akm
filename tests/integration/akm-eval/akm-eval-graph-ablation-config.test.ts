// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * GR-D4 regression: the graph-ablation harness's `graphOff` sandbox must
 * actually disable graph extraction.
 *
 * `writeGraphOffConfig` used to write `<sandbox root>/.config/akm/config.json`
 * with a retired key (`llm.features.graph_extraction`, dropped in 0.8.0) and
 * a mistyped one (`index.graph.llm: false` — `llm` is a per-pass
 * invocation-overrides object, not a boolean), while the sandboxed `akm`
 * resolves config from `AKM_CONFIG_DIR` (`<stash>/.akm`). The off arm's
 * config was never read, so both sides of the ablation ran with graph
 * extraction on.
 *
 * These tests exercise the real config-resolution path (`loadConfig` +
 * `isProcessEnabled`/`isLlmFeatureEnabled`) against a sandbox built the same
 * way the harness builds it, instead of spawning the full ablation (which
 * would need a configured LLM engine and two real `akm index`/`akm improve`
 * runs to observe the same thing).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { writeGraphOffConfig } from "../../../scripts/akm-eval/src/graph-ablation";
import { createSandbox, type Sandbox } from "../../../scripts/akm-eval/src/sources/sandbox";
import { loadConfig, resetConfigCache } from "../../../src/core/config/config";
import { isLlmFeatureEnabled, isProcessEnabled } from "../../../src/llm/feature-gate";
import { withEnvSync } from "../../_helpers/sandbox";

describe("graph-ablation writeGraphOffConfig (GR-D4)", () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox({ prefix: "akm-eval-graph-ablation-test-" });
    resetConfigCache();
  });

  afterEach(() => {
    sandbox.cleanup();
    resetConfigCache();
  });

  test("writes config.json under AKM_CONFIG_DIR, the path the sandboxed akm actually reads", () => {
    const configPath = writeGraphOffConfig(sandbox);

    // AKM_CONFIG_DIR is `<stashDir>/.akm` (sources/sandbox.ts) — NOT a
    // `.config/akm` home carve-out under the sandbox root.
    expect(configPath).toBe(path.join(sandbox.env.AKM_CONFIG_DIR!, "config.json"));
    expect(configPath).toBe(path.join(sandbox.stashDir, ".akm", "config.json"));
    expect(fs.existsSync(configPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
      index: { graph: { enabled: false } },
    });
  });

  test("the written config disables graph_extraction when akm resolves config from this sandbox's env", () => {
    writeGraphOffConfig(sandbox);

    const config = withEnvSync(sandbox.env, () => {
      resetConfigCache();
      return loadConfig();
    });

    expect(isProcessEnabled("index", "graph_extraction", config)).toBe(false);
    expect(isLlmFeatureEnabled(config, "graph_extraction")).toBe(false);
  });

  test("without the off-config (the graphOn shape), graph_extraction defaults on for the same sandbox env", () => {
    // No writeGraphOffConfig call — mirrors the harness's `graphOn` side.
    const config = withEnvSync(sandbox.env, () => {
      resetConfigCache();
      return loadConfig();
    });

    expect(isProcessEnabled("index", "graph_extraction", config)).toBe(true);
    expect(isLlmFeatureEnabled(config, "graph_extraction")).toBe(true);
  });

  test("the retired half of the old content (llm.features.graph_extraction) does not disable graph_extraction, even at the right path", () => {
    // `llm.features.*` was retired in 0.8.0 (src/core/config/schema/search.ts);
    // an unrecognized top-level key is dropped, not gated on.
    const configDir = path.join(sandbox.stashDir, ".akm");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ llm: { features: { graph_extraction: false } } }, null, 2),
    );

    const config = withEnvSync(sandbox.env, () => {
      resetConfigCache();
      return loadConfig();
    });

    expect(isProcessEnabled("index", "graph_extraction", config)).toBe(true);
    expect(isLlmFeatureEnabled(config, "graph_extraction")).toBe(true);
  });

  test("the other half of the old content (index.graph.llm: false) is a type error, even at the right path", () => {
    // `index.graph.llm` is `LlmInvocationOverridesSchema` (per-pass LLM
    // invocation overrides: temperature/maxTokens/etc.), not a boolean gate.
    // Had the old script written this shape to the path akm actually reads,
    // the graphOff sandbox's `akm index`/`akm improve` would have crashed
    // outright, not merely failed to gate — worse than the silent no-op the
    // wrong path caused.
    const configDir = path.join(sandbox.stashDir, ".akm");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ index: { graph: { llm: false } } }, null, 2),
    );

    expect(() =>
      withEnvSync(sandbox.env, () => {
        resetConfigCache();
        return loadConfig();
      }),
    ).toThrow(/index\.graph\.llm/);
  });
});
