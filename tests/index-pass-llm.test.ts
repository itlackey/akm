import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../src/core/config/config";
import { loadUserConfig, resetConfigCache } from "../src/core/config/config";
import { getConfigPath } from "../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import type { LoweringNotice } from "../src/execution/resolved-request";
import { resolveIndexPassExecution } from "../src/llm/index-passes";
import { asLlmRunner } from "./_helpers/llm-runner";
import { type Cleanup, sandboxXdgConfigHome } from "./_helpers/sandbox";
import { overrideSeam } from "./_helpers/seams";

// Tests for standalone index-pass engine resolution.

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
        ...asLlmRunner(runner).connection,
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

    const resolved = resolveIndexPassExecution("memory", config);

    expect(asLlmRunner(resolved.runner).connection.model).toBe("exact-index-model");
    expect(asLlmRunner(resolved.runner).connection).not.toHaveProperty("effort");
    expect(resolved.notices).toEqual([
      expect.objectContaining({
        code: "untranslated-field",
        severity: "warning",
        adapter: "llm",
        field: "inference.effort",
      }) as LoweringNotice,
    ]);
  });

  test("returns undefined when no index engine is configured", () => {
    const config: AkmConfig = { semanticSearchMode: "auto" };
    expect(resolveIndexPassExecution("enrichment", config).runner).toBeUndefined();
    expect(resolveIndexPassExecution("memory", config).runner).toBeUndefined();
  });

  test("returns the index default engine for any pass", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      engines: { index: { kind: "llm", ...SAMPLE_LLM } },
      index: { defaults: { engine: "index" } },
    };
    expect(resolvedConnection("enrichment", config)).toEqual({ ...SAMPLE_LLM, timeoutMs: 600_000 });
    expect(resolvedConnection("memory", config)).toEqual({ ...SAMPLE_LLM, timeoutMs: 600_000 });
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
    expect(asLlmRunner(runner).connection).toEqual(SAMPLE_LLM);
    expect(asLlmRunner(runner).connection).not.toHaveProperty("apiKey");
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

    test("rejects a missing per-pass engine instead of silently using the default", () => {
      const config: AkmConfig = {
        semanticSearchMode: "auto",
        engines: { primary: { kind: "llm", ...PRIMARY } },
        index: { defaults: { engine: "primary" }, memory: { engine: "missing" } },
      };
      expect(() => resolveIndexPassExecution("memory", config)).toThrow(/missing/i);
    });

    test("a non-LLM engine on a pass degrades to no runner (with a warning) instead of aborting the whole index run", () => {
      const seen: unknown[][] = [];
      overrideSeam(_setWarnSinkForTests, (level, args) => {
        if (level === "warn") seen.push(args);
      });
      const config: AkmConfig = {
        semanticSearchMode: "auto",
        engines: { wrong: { kind: "agent", platform: "pi" } },
        index: { defaults: { engine: "primary" }, memory: { engine: "wrong" } },
      };
      expect(() => resolveIndexPassExecution("memory", config)).not.toThrow();
      const resolved = resolveIndexPassExecution("memory", config);
      expect(resolved.runner).toBeUndefined();
      expect(resolved.notices).toEqual([]);
      expect(seen.some((args) => args.some((a) => String(a).includes("memory")))).toBe(true);
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
        memory: { enabled: true },
      },
    };
    expect(resolveIndexPassExecution("enrichment", config).runner).toBeUndefined();
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
    expect(resolvedConnection("memory", config)).toEqual({ ...SAMPLE_LLM, timeoutMs: 600_000 });
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
    expect(asLlmRunner(runner).connection).toMatchObject({
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
            processes: { memoryInference: { enabled: true } },
          },
        },
      },
    };
    expect(resolveIndexPassExecution("memory", config).runner).toBeUndefined();
  });
});

describe("config loader: `index` block parsing", () => {
  test("loads valid index default and per-pass engine selectors", () => {
    writeUserConfig({
      configVersion: "0.9.0",
      engines: {
        primary: { kind: "llm", ...SAMPLE_LLM },
        secondary: { kind: "llm", ...SAMPLE_LLM, model: "secondary-model" },
      },
      index: {
        defaults: { engine: "primary" },
        enrichment: { enabled: false },
        memory: { engine: "secondary" },
      },
    });
    const config = loadUserConfig();
    expect(config.index?.defaults?.engine).toBe("primary");
    expect((config.index?.enrichment as Record<string, unknown> | undefined)?.enabled).toBe(false);
    expect(config.index?.memory?.engine).toBe("secondary");
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
      expect((config.index?.enrichment as Record<string, unknown> | undefined)?.model).toBe("other-model");
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
    expect(asLlmRunner(resolved).connection).toMatchObject({ temperature: 0.2, maxTokens: 64 });
  });

  test("keeps an unknown key under a pass entry and names it once instead of failing config load", () => {
    writeUserConfig({
      configVersion: "0.9.0",
      index: { enrichment: { enabled: true, foo: true } },
    });
    resetConfigCache();
    _resetWarnOnceForTests();
    const warnings: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    try {
      const config = loadUserConfig();
      expect((config.index?.enrichment as Record<string, unknown> | undefined)?.enabled).toBe(true);
      expect((config.index?.enrichment as Record<string, unknown> | undefined)?.foo).toBe(true);
      expect(warnings.filter((w) => w.includes("index.enrichment.foo"))).toHaveLength(1);
    } finally {
      _setWarnSinkForTests(undefined);
    }
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
