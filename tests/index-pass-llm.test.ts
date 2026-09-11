// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for standalone index-pass engine resolution.
 *
 * index-redesign B5e: restored after the reconcile rewrite (`cec41361`)
 * deleted this file along with `akm index`'s only caller of the metadata-
 * enrichment pass. `resolveIndexPassExecution` and the `index.<pass>` config
 * shape it resolves against were never touched by that rewrite — the pass
 * itself is restored on the new reconcile path in `src/indexer/enrich.ts`,
 * which calls this same function. One adaptation: the old
 * `createEnrichmentDeadline` (a per-entry-timeout-times-entry-count
 * `AbortSignal.timeout` budget for the old directory-batched pass) is not
 * restored — the new content-addressed, per-blob-hash pass has no equivalent
 * aggregate deadline, only each call's own `tryLlmFeature` timeout
 * (`engines.<name>.timeoutMs`, default 10 minutes) — so the one test that
 * exercised it now only asserts the unbounded `timeoutMs: null` passes
 * through `resolveIndexPassExecution` untouched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../src/core/config/config";
import { loadUserConfig, resetConfigCache } from "../src/core/config/config";
import { getConfigPath } from "../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import type { LoweringNotice } from "../src/execution/resolved-request";
import { resolveIndexPassExecution } from "../src/llm/index-passes";
import { type Cleanup, sandboxXdgConfigHome } from "./_helpers/sandbox";
import { overrideSeam } from "./_helpers/seams";

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cfgResult = sandboxXdgConfigHome();
  envCleanup = cfgResult.cleanup;
  resetConfigCache();
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
  resetConfigCache();
});

function writeUserConfig(raw: object): void {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2));
}

const SAMPLE_LLM = {
  endpoint: "http://localhost:11434/v1/chat/completions",
  model: "llama3.2",
};

function resolvedConnection(passName: string, config: AkmConfig): Record<string, unknown> | undefined {
  const runner = resolveIndexPassExecution(passName, config).runner;
  return runner
    ? {
        ...runner.connection,
        ...(Object.hasOwn(runner, "timeoutMs") ? { timeoutMs: runner.timeoutMs } : {}),
      }
    : undefined;
}

describe("resolveIndexPassExecution", () => {
  test("returns the symbolic runner with stable initial lowering notices", () => {
    const modelMapPath = path.join(path.dirname(getConfigPath()), "models.json");
    fs.writeFileSync(
      modelMapPath,
      JSON.stringify({
        version: 1,
        aliases: {
          reasoning: {
            index: { model: "exact-index-model", inference: { effort: "high" } },
          },
        },
      }),
    );
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      engines: { index: { kind: "llm", ...SAMPLE_LLM, model: "reasoning" } },
      index: { defaults: { engine: "index" } },
    };

    const resolved = resolveIndexPassExecution("graph", config);

    expect(resolved.runner?.connection.model).toBe("exact-index-model");
    expect(resolved.runner?.connection).not.toHaveProperty("effort");
    expect(resolved.notices).toEqual([
      expect.objectContaining({
        code: "untranslated-field",
        severity: "warning",
        adapter: "llm",
        field: "inference.effort",
      }) as LoweringNotice,
    ]);
    expect(Object.isFrozen(resolved.notices)).toBe(true);
  });

  test("returns undefined when no index engine is configured", () => {
    const config: AkmConfig = { semanticSearchMode: "auto" };
    expect(resolveIndexPassExecution("enrichment", config).runner).toBeUndefined();
    expect(resolveIndexPassExecution("graph", config).runner).toBeUndefined();
  });

  test("returns the index default engine for any pass", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      engines: { index: { kind: "llm", ...SAMPLE_LLM } },
      index: { defaults: { engine: "index" } },
    };
    expect(resolvedConnection("enrichment", config)).toEqual({ ...SAMPLE_LLM, timeoutMs: 600_000 });
    expect(resolvedConnection("memory", config)).toEqual({ ...SAMPLE_LLM, timeoutMs: 600_000 });
    expect(resolvedConnection("graph", config)).toEqual({ ...SAMPLE_LLM, timeoutMs: 600_000 });
  });

  test("keeps a required credential symbolic until the resolved request dispatches", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      engines: {
        index: {
          kind: "llm",
          ...SAMPLE_LLM,
          apiKey: "$AKM_INDEX_PASS_REQUIRED_KEY",
        },
      },
      index: { defaults: { engine: "index" } },
    };

    expect(() => resolveIndexPassExecution("enrichment", config)).not.toThrow();
    const runner = resolveIndexPassExecution("enrichment", config).runner;
    expect(runner).toMatchObject({
      kind: "llm",
      engine: "index",
      credential: { names: ["AKM_INDEX_PASS_REQUIRED_KEY"], required: true },
    });
    expect(runner?.connection).toEqual(SAMPLE_LLM);
    expect(runner?.connection).not.toHaveProperty("apiKey");
  });

  test("standalone enrichment preserves an explicit unbounded timeout", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      engines: { index: { kind: "llm", ...SAMPLE_LLM, timeoutMs: null } },
      index: { defaults: { engine: "index" } },
    };

    expect(resolveIndexPassExecution("enrichment", config).runner?.timeoutMs).toBeNull();
  });

  describe("per-pass engines", () => {
    const PRIMARY = { endpoint: "http://localhost:11434/v1/chat/completions", model: "primary" };
    const MINISTRAL = { endpoint: "http://localhost:11434/v1/chat/completions", model: "ministral-3b" };

    test("memory pass uses index.memory.engine when set", () => {
      const config: AkmConfig = {
        semanticSearchMode: "auto",
        engines: {
          primary: { kind: "llm", ...PRIMARY },
          ministral: { kind: "llm", ...MINISTRAL },
        },
        index: { defaults: { engine: "primary" }, memory: { engine: "ministral" } },
      };
      expect(resolvedConnection("memory", config)).toEqual({ ...MINISTRAL, timeoutMs: 600_000 });
      // Default LLM still wins for passes WITHOUT a per-process override.
      expect(resolvedConnection("enrichment", config)).toEqual({ ...PRIMARY, timeoutMs: 600_000 });
    });

    test("graph pass uses index.graph.engine when set", () => {
      const config: AkmConfig = {
        semanticSearchMode: "auto",
        engines: {
          primary: { kind: "llm", ...PRIMARY },
          ministral: { kind: "llm", ...MINISTRAL },
        },
        index: { defaults: { engine: "primary" }, graph: { engine: "ministral" } },
      };
      expect(resolvedConnection("graph", config)).toEqual({ ...MINISTRAL, timeoutMs: 600_000 });
      // Memory pass still falls through to default — no override for memory.
      expect(resolvedConnection("memory", config)).toEqual({ ...PRIMARY, timeoutMs: 600_000 });
    });

    test("rejects a missing per-pass engine instead of silently using the default", () => {
      const config: AkmConfig = {
        semanticSearchMode: "auto",
        engines: { primary: { kind: "llm", ...PRIMARY } },
        index: { defaults: { engine: "primary" }, graph: { engine: "missing" } },
      };
      expect(() => resolveIndexPassExecution("graph", config)).toThrow(/missing/i);
    });

    test("a non-LLM engine on a pass degrades to no runner (with a warning) instead of aborting the whole index run", () => {
      const seen: unknown[][] = [];
      overrideSeam(_setWarnSinkForTests, (level, args) => {
        if (level === "warn") seen.push(args);
      });
      const config: AkmConfig = {
        semanticSearchMode: "auto",
        engines: { wrong: { kind: "agent", platform: "pi" } },
        index: { defaults: { engine: "primary" }, graph: { engine: "wrong" } },
      };
      expect(() => resolveIndexPassExecution("graph", config)).not.toThrow();
      const resolved = resolveIndexPassExecution("graph", config);
      expect(resolved.runner).toBeUndefined();
      expect(resolved.notices).toEqual([]);
      expect(seen.some((args) => args.some((a) => String(a).includes("graph")))).toBe(true);
    });

    test("index.<pass>.enabled === false opts the pass out", () => {
      const config: AkmConfig = {
        semanticSearchMode: "auto",
        engines: { primary: { kind: "llm", ...PRIMARY } },
        index: { defaults: { engine: "primary" }, memory: { enabled: false } },
      };
      expect(resolveIndexPassExecution("memory", config).runner).toBeUndefined();
    });
  });

  test("per-pass enabled false opts that pass out, leaving siblings intact", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      engines: { index: { kind: "llm", ...SAMPLE_LLM } },
      index: {
        defaults: { engine: "index" },
        enrichment: { enabled: false },
        graph: { enabled: true },
      },
    };
    expect(resolveIndexPassExecution("enrichment", config).runner).toBeUndefined();
    expect(resolvedConnection("graph", config)).toEqual({ ...SAMPLE_LLM, timeoutMs: 600_000 });
    expect(resolvedConnection("memory", config)).toEqual({ ...SAMPLE_LLM, timeoutMs: 600_000 });
  });

  test("per-pass model overrides the selected engine without mutating siblings", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      engines: { index: { kind: "llm", ...SAMPLE_LLM } },
      index: { defaults: { engine: "index" }, enrichment: { model: "override" } },
    };
    expect(resolvedConnection("enrichment", config)).toEqual({
      ...SAMPLE_LLM,
      model: "override",
      timeoutMs: 600_000,
    });
    expect(resolvedConnection("graph", config)).toEqual({ ...SAMPLE_LLM, timeoutMs: 600_000 });
  });

  test("projects pass-over-default model, merged inference, and timeout onto the symbolic runner", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      engines: {
        index: {
          kind: "llm",
          ...SAMPLE_LLM,
          temperature: 0.9,
          maxTokens: 999,
          supportsJsonSchema: true,
          timeoutMs: 9_000,
        },
      },
      index: {
        defaults: {
          engine: "index",
          model: "default-model",
          timeoutMs: 4_000,
          llm: { temperature: 0.4, maxTokens: 400 },
        },
        enrichment: {
          model: "pass-model",
          timeoutMs: 2_000,
          llm: { temperature: 0.2 },
        },
      },
    };

    const runner = resolveIndexPassExecution("enrichment", config).runner;
    expect(runner?.connection).toMatchObject({
      model: "pass-model",
      temperature: 0.2,
      maxTokens: 400,
      supportsJsonSchema: true,
    });
    expect(runner?.timeoutMs).toBe(2_000);
  });

  test("improve strategy engines never configure standalone index passes", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      engines: { improve: { kind: "llm", ...SAMPLE_LLM } },
      defaults: { improveStrategy: "default" },
      improve: {
        strategies: {
          default: {
            engine: "improve",
            processes: { memoryInference: { enabled: true }, graphExtraction: { enabled: true } },
          },
        },
      },
    };
    expect(resolveIndexPassExecution("memory", config).runner).toBeUndefined();
    expect(resolveIndexPassExecution("graph", config).runner).toBeUndefined();
  });
});

describe("config loader: `index` block parsing", () => {
  test("loads valid index default and per-pass engine selectors", () => {
    writeUserConfig({
      configVersion: "0.9.0",
      engines: {
        primary: { kind: "llm", ...SAMPLE_LLM },
        graph: { kind: "llm", ...SAMPLE_LLM, model: "graph-model" },
      },
      index: {
        defaults: { engine: "primary" },
        enrichment: { enabled: false },
        graph: { engine: "graph" },
      },
    });
    const config = loadUserConfig();
    expect(config.index?.defaults?.engine).toBe("primary");
    expect(config.index?.enrichment?.enabled).toBe(false);
    expect(config.index?.graph?.engine).toBe("graph");
  });

  test("loads graphExtractionIncludeTypes for graph pass", async () => {
    writeUserConfig({
      configVersion: "0.9.0",
      index: {
        graph: { graphExtractionIncludeTypes: ["memory", "command"] },
      },
    });
    const config = loadUserConfig();
    const { getIndexPassConfig } = await import("../src/core/config/config");
    expect(getIndexPassConfig(config.index, "graph")?.graphExtractionIncludeTypes).toEqual(["memory", "command"]);
  });

  test("warns and drops per-pass provider configuration instead of failing config load (duplicate provider path)", () => {
    writeUserConfig({
      configVersion: "0.9.0",
      index: {
        enrichment: {
          endpoint: "http://other-host/v1/chat/completions",
          model: "other-model",
        },
      },
    });
    const warnings: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    try {
      const config = loadUserConfig();
      expect(config.index?.enrichment?.model).toBe("other-model");
      expect((config.index?.enrichment as Record<string, unknown> | undefined)?.endpoint).toBeUndefined();
      expect(warnings.some((w) => w.includes("index.enrichment.endpoint") && w.includes("retired"))).toBe(true);
    } finally {
      _setWarnSinkForTests(undefined);
    }
  });

  test("warns and drops per-pass provider configuration fields instead of failing config load", () => {
    for (const key of ["provider", "apiKey", "temperature", "maxTokens", "baseUrl", "capabilities"]) {
      writeUserConfig({
        configVersion: "0.9.0",
        index: { enrichment: { [key]: "anything" } },
      });
      resetConfigCache();
      _resetWarnOnceForTests();
      const warnings: string[] = [];
      _setWarnSinkForTests((level, args) => {
        if (level === "warn") warnings.push(args.map(String).join(" "));
      });
      try {
        const config = loadUserConfig();
        expect((config.index?.enrichment as Record<string, unknown> | undefined)?.[key]).toBeUndefined();
        expect(warnings.some((w) => w.includes(`index.enrichment.${key}`))).toBe(true);
      } finally {
        _setWarnSinkForTests(undefined);
      }
    }
  });

  test("rejects a retired boolean llm selector under a pass", () => {
    writeUserConfig({
      configVersion: "0.9.0",
      index: { enrichment: { llm: false } },
    });
    expect(() => loadUserConfig()).toThrow(/typed invocation|object/i);
  });

  test("accepts typed per-pass llm invocation overrides", () => {
    writeUserConfig({
      configVersion: "0.9.0",
      engines: { index: { kind: "llm", ...SAMPLE_LLM } },
      defaults: { llmEngine: "index" },
      index: { enrichment: { llm: { temperature: 0.2, maxTokens: 64 } } },
    });
    const resolved = resolveIndexPassExecution("enrichment", loadUserConfig()).runner;
    expect(resolved?.connection).toMatchObject({ temperature: 0.2, maxTokens: 64 });
  });

  test("warns and drops an unknown key under a pass entry instead of failing config load", () => {
    writeUserConfig({
      configVersion: "0.9.0",
      index: { enrichment: { enabled: true, foo: true } },
    });
    const warnings: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    try {
      const config = loadUserConfig();
      expect(config.index?.enrichment?.enabled).toBe(true);
      expect((config.index?.enrichment as Record<string, unknown> | undefined)?.foo).toBeUndefined();
      expect(warnings.some((w) => w.includes("Unknown key `index.enrichment.foo`"))).toBe(true);
    } finally {
      _setWarnSinkForTests(undefined);
    }
  });

  test("accepts arbitrary graphExtractionIncludeTypes values (WI-9.6c: accept-any until Chunk 2)", () => {
    // The hardcoded type allowlist (GRAPH_EXTRACTION_INCLUDE_TYPES_ALLOWED) was
    // deleted — it had already drifted from the runtime consumer's own
    // supported-type set (stale `wiki` entry, missing `fact`). The field is
    // now an array of arbitrary non-empty strings; an unrecognized type is
    // handled gracefully at runtime (silently yields zero eligible files for
    // that type — see src/indexer/graph/graph-extraction.ts's
    // SUPPORTED_GRAPH_EXTRACTION_INCLUDE_TYPES / collectEligibleFiles), not
    // rejected at config-load time.
    writeUserConfig({
      configVersion: "0.9.0",
      index: { graph: { graphExtractionIncludeTypes: ["memory", "bogus-type"] } },
    });
    const config = loadUserConfig();
    expect(config.index?.graph?.graphExtractionIncludeTypes).toEqual(["memory", "bogus-type"]);
  });

  test("rejects array-shaped `index` block", () => {
    writeUserConfig({
      configVersion: "0.9.0",
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid runtime input
      index: [{ llm: false }] as any,
    });
    expect(() => loadUserConfig()).toThrow(/expected an object keyed by pass name/);
  });

  test("rejects non-object pass entry", () => {
    writeUserConfig({
      configVersion: "0.9.0",
      index: { enrichment: false },
    });
    expect(() => loadUserConfig()).toThrow(/expected an object like/);
  });

  test("missing `index` block is fine", () => {
    writeUserConfig({ configVersion: "0.9.0" });
    const config = loadUserConfig();
    expect(config.index).toBeUndefined();
    expect(resolveIndexPassExecution("enrichment", config).runner).toBeUndefined();
  });
});
