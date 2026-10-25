import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../src/core/config/config";
import { loadUserConfig, normalizeConfigFile, resetConfigCache } from "../src/core/config/config";
import { effectiveRequestFields } from "../src/core/llm-inference";
import { getConfigPath } from "../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import type { LoweringNotice } from "../src/execution/resolved-request";
import { resolveIndexPassExecution } from "../src/llm/index-passes";
import { asLlmRunner } from "./_helpers/llm-runner";
import { type Cleanup, sandboxXdgConfigHome } from "./_helpers/sandbox";

// Tests for standalone index-pass connection resolution.

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
  models: { fast: "llama3.2" },
};

function resolvedConnection(passName: string, config: AkmConfig): Record<string, unknown> | undefined {
  const runner = resolveIndexPassExecution(passName, config).runner;
  if (!runner) return undefined;
  const { endpoint, model, timeoutMs } = asLlmRunner(runner);
  return { endpoint, model, timeoutMs };
}

describe("resolveIndexPassExecution", () => {
  test("returns the symbolic runner with stable initial lowering notices", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      connections: { index: { ...SAMPLE_LLM } },
      index: { connection: "index", memory: { llm: { topP: 0.9 } as never } },
    };

    const resolved = resolveIndexPassExecution("memory", config);

    expect(asLlmRunner(resolved.runner).model).toBe("llama3.2");
    expect(asLlmRunner(resolved.runner).request).not.toHaveProperty("topP");
    expect(resolved.notices).toEqual([
      expect.objectContaining({
        code: "untranslated-field",
        severity: "warning",
        adapter: "connection",
        field: "inference.topP",
      }) as LoweringNotice,
    ]);
  });

  test("returns undefined when no connection or harness is configured", () => {
    const config: AkmConfig = { semanticSearchMode: "auto" };
    expect(resolveIndexPassExecution("enrichment", config).runner).toBeUndefined();
    expect(resolveIndexPassExecution("memory", config).runner).toBeUndefined();
  });

  test("returns the default connection for any pass", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      connections: { index: { ...SAMPLE_LLM } },
      index: { connection: "index" },
    };
    const expected = { endpoint: SAMPLE_LLM.endpoint, model: "llama3.2", timeoutMs: 600_000 };
    expect(resolvedConnection("enrichment", config)).toEqual(expected);
    expect(resolvedConnection("memory", config)).toEqual(expected);
  });

  test("keeps a required credential symbolic until the resolved request dispatches", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      connections: { index: { ...SAMPLE_LLM, apiKey: "$AKM_INDEX_PASS_REQUIRED_KEY" } },
      index: { connection: "index" },
    };

    expect(() => resolveIndexPassExecution("enrichment", config)).not.toThrow();
    const runner = resolveIndexPassExecution("enrichment", config).runner;
    expect(runner).toMatchObject({ kind: "connection", name: "index", apiKey: "$AKM_INDEX_PASS_REQUIRED_KEY" });
    expect(JSON.stringify(runner)).not.toContain("secret");
  });

  test("standalone enrichment preserves an explicit unbounded timeout", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      connections: { index: { ...SAMPLE_LLM, timeoutMs: null } },
      index: { connection: "index" },
    };

    expect(resolveIndexPassExecution("enrichment", config).runner?.timeoutMs).toBeNull();
  });

  describe("per-pass connections", () => {
    const PRIMARY = { endpoint: "http://localhost:11434/v1/chat/completions", models: { fast: "primary" } };
    const MINISTRAL = { endpoint: "http://localhost:11434/v1/chat/completions", models: { fast: "ministral-3b" } };

    test("memory pass uses index.memory.connection when set", () => {
      const config: AkmConfig = {
        semanticSearchMode: "auto",
        connections: { primary: PRIMARY, ministral: MINISTRAL },
        index: { connection: "primary", memory: { connection: "ministral" } },
      };
      expect(resolvedConnection("memory", config)).toEqual({
        endpoint: MINISTRAL.endpoint,
        model: "ministral-3b",
        timeoutMs: 600_000,
      });
      // The index-wide connection still serves passes WITHOUT a per-pass override.
      expect(resolvedConnection("enrichment", config)).toEqual({
        endpoint: PRIMARY.endpoint,
        model: "primary",
        timeoutMs: 600_000,
      });
    });

    test("a per-pass connection that is not configured is an error naming it, not a reason to use the default one", () => {
      const config: AkmConfig = {
        semanticSearchMode: "auto",
        connections: { default: PRIMARY },
        index: { memory: { connection: "missing" } },
      };
      expect(() => resolveIndexPassExecution("memory", config)).toThrow('Connection "missing" is not configured.');
    });

    test("with no connection, a harness that confines the model-work tool policy runs the pass", () => {
      const config: AkmConfig = {
        semanticSearchMode: "auto",
        harnesses: { agent: { platform: "claude" } },
      };
      const resolved = resolveIndexPassExecution("memory", config);
      expect(resolved.runner).toMatchObject({ kind: "harness", name: "agent" });
    });

    test("a harness that cannot confine the policy runs the pass unrestricted, with a notice", () => {
      const config: AkmConfig = {
        semanticSearchMode: "auto",
        harnesses: { wrong: { platform: "pi" } },
      };
      const resolved = resolveIndexPassExecution("memory", config);
      expect(resolved.runner).toMatchObject({ kind: "harness", name: "wrong" });
      expect(resolved.notices.map((notice) => notice.code)).toContain("model-work-unrestricted");
    });

    test("index.<pass>.enabled === false opts the pass out", () => {
      const config: AkmConfig = {
        semanticSearchMode: "auto",
        connections: { primary: PRIMARY },
        index: { connection: "primary", memory: { enabled: false } },
      };
      expect(resolveIndexPassExecution("memory", config).runner).toBeUndefined();
    });
  });

  test("per-pass enabled false opts that pass out, leaving siblings intact", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      connections: { index: { ...SAMPLE_LLM } },
      index: {
        connection: "index",
        enrichment: { enabled: false },
        memory: { enabled: true },
      },
    };
    expect(resolveIndexPassExecution("enrichment", config).runner).toBeUndefined();
    expect(resolvedConnection("memory", config)).toEqual({
      endpoint: SAMPLE_LLM.endpoint,
      model: "llama3.2",
      timeoutMs: 600_000,
    });
  });

  test("per-pass model overrides the selected connection without mutating siblings", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      connections: { index: { ...SAMPLE_LLM } },
      index: { connection: "index", enrichment: { model: "override" } },
    };
    expect(resolvedConnection("enrichment", config)).toEqual({
      endpoint: SAMPLE_LLM.endpoint,
      model: "override",
      timeoutMs: 600_000,
    });
    expect(resolvedConnection("memory", config)).toEqual({
      endpoint: SAMPLE_LLM.endpoint,
      model: "llama3.2",
      timeoutMs: 600_000,
    });
  });

  test("projects pass-over-index model, merged inference, and timeout onto the symbolic runner", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      connections: {
        index: {
          ...SAMPLE_LLM,
          models: { fast: "llama3.2", "default-model": "alias-target", "pass-model": "pass-target" },
          temperature: 0.9,
          max_tokens: 999,
          timeoutMs: 9_000,
        },
      },
      index: {
        connection: "index",
        model: "default-model",
        timeoutMs: 4_000,
        llm: { temperature: 0.4, maxTokens: 400 },
        enrichment: {
          model: "pass-model",
          timeoutMs: 2_000,
          llm: { temperature: 0.2 },
        },
      },
    };

    const runner = asLlmRunner(resolveIndexPassExecution("enrichment", config).runner);
    expect(runner.model).toBe("pass-target");
    // The connection's own fields as written; the pass's settings (over the index's) beside them.
    expect(runner.request).toEqual({ temperature: 0.9, max_tokens: 999 });
    expect(runner.inference).toEqual({ temperature: 0.2, maxTokens: 400 });
    expect(effectiveRequestFields(runner.request, runner.inference)).toEqual({ temperature: 0.2, max_tokens: 400 });
    expect(runner.timeoutMs).toBe(2_000);
  });

  test("improve's connection never configures standalone index passes", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      connections: { default: { ...SAMPLE_LLM }, improve: { ...SAMPLE_LLM, models: { fast: "improve-model" } } },
      improve: {
        connection: "improve",
        strategy: "default",
        strategies: { default: { processes: { memoryInference: { enabled: true } } } },
      },
    };
    expect(asLlmRunner(resolveIndexPassExecution("memory", config).runner)).toMatchObject({
      name: "default",
      model: "llama3.2",
    });
  });
});

describe("config loader: `index` block parsing", () => {
  test("loads valid index-wide and per-pass connection selectors", () => {
    writeUserConfig({
      configVersion: "0.9.0",
      connections: {
        primary: { ...SAMPLE_LLM },
        secondary: { ...SAMPLE_LLM, models: { fast: "secondary-model" } },
      },
      index: {
        connection: "primary",
        enrichment: { enabled: false },
        memory: { connection: "secondary" },
      },
    });
    const config = loadUserConfig();
    expect(config.index?.connection).toBe("primary");
    expect((config.index?.enrichment as Record<string, unknown> | undefined)?.enabled).toBe(false);
    expect(config.index?.memory?.connection).toBe("secondary");
  });

  test("per-pass inline connection settings load like any unknown key: warned once with the dotted path, kept on disk, dropped by migrate apply", () => {
    const retired = ["endpoint", "provider", "apiKey", "baseUrl", "temperature", "maxTokens", "capabilities"];
    writeUserConfig({
      configVersion: "0.9.0",
      index: { enrichment: { model: "other-model", ...Object.fromEntries(retired.map((key) => [key, "anything"])) } },
    });
    const warnings: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    try {
      const config = loadUserConfig();
      expect((config.index?.enrichment as Record<string, unknown> | undefined)?.model).toBe("other-model");
      for (const key of retired) {
        const named = warnings.filter((w) => w.includes(`Unknown config key "index.enrichment.${key}"`));
        expect(named, key).toHaveLength(1);
      }
    } finally {
      _setWarnSinkForTests(undefined);
    }

    // Kept on disk until an explicit `akm migrate apply`.
    const onDisk = () => JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).index.enrichment;
    expect(onDisk().endpoint).toBe("anything");
    expect(normalizeConfigFile(getConfigPath(), { apply: true }).applied).toBe(true);
    expect(onDisk()).toEqual({ model: "other-model" });
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
      connections: { index: { ...SAMPLE_LLM } },
      index: { enrichment: { llm: { temperature: 0.2, maxTokens: 64 } } },
    });
    const resolved = resolveIndexPassExecution("enrichment", loadUserConfig()).runner;
    expect(asLlmRunner(resolved).inference).toEqual({ temperature: 0.2, maxTokens: 64 });
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
