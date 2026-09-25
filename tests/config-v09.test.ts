// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../src/core/config/config";
import {
  bundlesToSourceEntries,
  loadUserConfig,
  resetConfigCache,
  resolveConfiguredSources,
  saveConfig,
} from "../src/core/config/config";
import { validateConfigShape } from "../src/core/config/config-schema";
import { configSet } from "../src/core/config/config-walker";
import { ConfigError } from "../src/core/errors";
import { getConfigPath } from "../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";

beforeEach(() => resetConfigCache());
afterEach(() => resetConfigCache());

function writeConfig(value: unknown): void {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(value));
}

describe("0.9 config contract", () => {
  test("requires an exact persisted config version before defaults are applied", () => {
    writeConfig({ engines: {} });
    expect(() => loadUserConfig()).toThrow(ConfigError);
    expect(() => loadUserConfig()).toThrow(/UNSUPPORTED_CONFIG_VERSION|configVersion/);
  });

  test("loads a config with retired profile vocabulary and a literal engine apiKey, using both as configured", () => {
    writeConfig({
      configVersion: "0.9.0" as const,
      profiles: { llm: {} },
      engines: {
        fast: {
          kind: "llm",
          endpoint: "https://example.test/v1/chat/completions",
          model: "test",
          apiKey: "not-symbolic",
        },
      },
    });
    const config = loadUserConfig();
    expect(config.engines?.fast?.apiKey).toBe("not-symbolic");
  });

  test("accepts symbolic engine credentials and retains them on save", () => {
    const config = {
      configVersion: "0.9.0" as const,
      semanticSearchMode: "auto" as const,
      engines: {
        fast: {
          kind: "llm" as const,
          endpoint: "https://example.test/v1/chat/completions",
          model: "test",
          apiKey: `\${FAST_API_KEY}`,
        },
      },
      defaults: { llmEngine: "fast" },
    };
    saveConfig(config);
    expect(loadUserConfig().engines?.fast?.apiKey).toBe(`\${FAST_API_KEY}`);
  });

  test("accepts first-class reasoningEffort on an LLM engine", () => {
    const config = {
      configVersion: "0.9.0" as const,
      semanticSearchMode: "auto" as const,
      engines: {
        fast: {
          kind: "llm" as const,
          endpoint: "https://example.test/v1/chat/completions",
          model: "fast-model",
          reasoningEffort: "none",
        },
      },
      defaults: { llmEngine: "fast" },
    };
    expect(validateConfigShape(config).ok).toBe(true);
    expect(
      validateConfigShape({
        ...config,
        engines: { fast: { ...config.engines.fast, reasoningEffort: "" } },
      }).ok,
    ).toBe(false);
  });

  test("workflow.judgeEngine accepts named LLM or agent engines and rejects unknown names", () => {
    const engines = {
      fast: { kind: "llm" as const, endpoint: "https://example.test/v1/chat/completions", model: "fast-model" },
      reviewer: { kind: "agent" as const, platform: "codex" as const },
    };
    expect(validateConfigShape({ configVersion: "0.9.0", engines, workflow: { judgeEngine: "fast" } }).ok).toBe(true);
    expect(validateConfigShape({ configVersion: "0.9.0", engines, workflow: { judgeEngine: "reviewer" } }).ok).toBe(
      true,
    );
    const invalid = validateConfigShape({
      configVersion: "0.9.0",
      engines,
      workflow: { judgeEngine: "missing" },
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.errors).toContainEqual(expect.objectContaining({ path: "workflow.judgeEngine" }));
  });

  test("permits only symbolic engine apiKey values through config set", () => {
    const current = {
      configVersion: "0.9.0",
      engines: {
        fast: {
          kind: "llm",
          endpoint: "https://example.test/v1/chat/completions",
          model: "test",
        },
      },
    };
    expect(configSet(current, "engines.fast.apiKey", "$FAST_API_KEY")).toMatchObject({
      engines: { fast: { apiKey: "$FAST_API_KEY" } },
    });
    expect(() => configSet(current, "engines.fast.apiKey", "literal-secret")).toThrow();
  });

  test("rejects protected and credential-shaped extraParams keys", () => {
    writeConfig({
      configVersion: "0.9.0",
      engines: {
        fast: {
          kind: "llm",
          endpoint: "https://example.test/v1/chat/completions",
          model: "test",
          extraParams: { nested: { "API-Key": "leak" } },
        },
      },
    });
    expect(() => loadUserConfig()).toThrow(ConfigError);
  });

  test("rejects normalized protected top-level keys and secret keys inside arrays", () => {
    writeConfig({
      configVersion: "0.9.0",
      engines: {
        fast: {
          kind: "llm",
          endpoint: "https://example.test/v1/chat/completions",
          model: "test",
          extraParams: { "Response-Format": {}, provider: [{ auth: [{ API_KEY: "leak" }] }] },
        },
      },
    });
    expect(() => loadUserConfig()).toThrow(ConfigError);
  });

  test("rejects chat_template_kwargs overrides", () => {
    writeConfig({
      configVersion: "0.9.0",
      engines: {
        fast: {
          kind: "llm",
          endpoint: "https://example.test/v1/chat/completions",
          model: "test",
          extraParams: { chat_template_kwargs: { enable_thinking: true } },
        },
      },
    });
    expect(() => loadUserConfig()).toThrow(ConfigError);
  });

  // #852 (following #815): `extraParams.reasoning_effort` was the documented
  // 0.9.1 workaround for LM Studio, where `enableThinking` is a no-op.
  // `reasoningEffort` became a first-class — and therefore protected — field
  // in 0.9.2. AGENTS.md cites this exact guard as already fixed to
  // warn-and-auto-lift; loads onto the first-class field in memory, warning
  // once and naming `akm migrate apply` as the way to persist it.
  test("loads a legacy reasoning_effort extraParams override by lifting it, naming akm migrate apply in the warning", () => {
    writeConfig({
      configVersion: "0.9.0",
      engines: {
        fast: {
          kind: "llm",
          endpoint: "https://example.test/v1/chat/completions",
          model: "test",
          extraParams: { reasoning_effort: "high" },
        },
      },
    });
    const warnings: string[] = [];
    _resetWarnOnceForTests();
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    try {
      const config = loadUserConfig();
      expect(config.engines?.fast?.reasoningEffort).toBe("high");
      expect(warnings.some((w) => w.includes("akm migrate apply"))).toBe(true);
    } finally {
      _setWarnSinkForTests(undefined);
    }
  });

  test("rejects a reasoning_effort extraParams override that conflicts with a different first-class reasoningEffort", () => {
    writeConfig({
      configVersion: "0.9.0",
      engines: {
        fast: {
          kind: "llm",
          endpoint: "https://example.test/v1/chat/completions",
          model: "test",
          reasoningEffort: "none",
          extraParams: { reasoning_effort: "high" },
        },
      },
    });
    expect(() => loadUserConfig()).toThrow(ConfigError);
  });

  test("tolerates retired improve process selectors like any unknown key", () => {
    writeConfig({
      configVersion: "0.9.0",
      improve: { strategies: { default: { processes: { reflect: { profile: "fast", mode: "llm" } } } } },
    });
    expect(() => loadUserConfig()).not.toThrow();
  });

  test("rejects an improve process that selects a missing or incompatible engine", () => {
    writeConfig({
      configVersion: "0.9.0",
      engines: { reviewer: { kind: "agent", platform: "pi" } },
      improve: { strategies: { default: { processes: { reflect: { engine: "reviewer" } } } } },
    });
    expect(() => loadUserConfig()).toThrow(ConfigError);
  });

  test("cross-validates default strategies, strategy engines, and nested judgment engines", () => {
    const base = {
      configVersion: "0.9.0",
      engines: {
        llm: { kind: "llm", endpoint: "https://example.test/v1/chat/completions", model: "test" },
        agent: { kind: "agent", platform: "pi" },
      },
    };
    expect(validateConfigShape({ ...base, defaults: { improveStrategy: "missing" } }).ok).toBe(false);
    expect(validateConfigShape({ ...base, defaults: { improveStrategy: "quick" } }).ok).toBe(true);
    expect(validateConfigShape({ ...base, improve: { strategies: { custom: { engine: "agent" } } } }).ok).toBe(false);
    expect(
      validateConfigShape({
        ...base,
        improve: { strategies: { custom: { processes: { triage: { judgment: { engine: "agent" } } } } } },
      }).ok,
    ).toBe(true);
    expect(
      validateConfigShape({
        ...base,
        improve: { strategies: { custom: { processes: { triage: { judgment: { engine: "llm" } } } } } },
      }).ok,
    ).toBe(true);
  });

  test("accepts a bundles + defaultBundle config (0.9.0 shape, spec §10.1 / D-R5)", () => {
    const ok = validateConfigShape({
      configVersion: "0.9.0",
      bundles: {
        primary: { path: "/home/u/akm", writable: true },
        catalog: { git: "https://example.test/catalog.git" },
        docs: { website: { url: "https://example.test/docs/", maxPages: 50 } },
      },
      defaultBundle: "primary",
    });
    expect(ok.ok).toBe(true);
  });

  test("rejects coercion-shaped website options at the config boundary", () => {
    for (const options of [
      { maxPages: "25" },
      { maxDepth: false },
      { respectRobots: null },
      { respectRobots: "false" },
      { crawlTimeoutMs: "300" },
      { crawlTimeoutMs: false },
      { crawlTimeoutMs: -1 },
    ]) {
      expect(
        validateConfigShape({
          configVersion: "0.9.0",
          bundles: { docs: { website: { url: "https://example.test/docs/", ...options } } },
          defaultBundle: "docs",
        }).ok,
      ).toBe(false);
    }
  });

  test("rejects a half-migrated config carrying bundles alongside the retired source keys", () => {
    for (const legacy of [{ stashDir: "/s" }, { sources: [] }, { installed: [] }]) {
      const res = validateConfigShape({
        configVersion: "0.9.0",
        bundles: { primary: { path: "/s" } },
        defaultBundle: "primary",
        ...legacy,
      });
      expect(res.ok).toBe(false);
    }
  });

  test("still rejects removed bundle-option runtime compatibility settings", () => {
    expect(
      validateConfigShape({
        configVersion: "0.9.0",
        bundles: { primary: { path: "/s", options: { pushOnCommit: true } } },
      }).ok,
    ).toBe(false);
  });

  test("ignores retired top-level writable and index.stalenessDetection instead of failing config load", () => {
    expect(validateConfigShape({ configVersion: "0.9.0", writable: true }).ok).toBe(true);
    expect(validateConfigShape({ configVersion: "0.9.0", index: { stalenessDetection: { enabled: true } } }).ok).toBe(
      true,
    );
  });

  test("rejects a bundle key that is not a legal slug and a non-source or multi-source entry", () => {
    // Illegal slug key (contains ':').
    expect(validateConfigShape({ configVersion: "0.9.0", bundles: { "github:owner/repo": { path: "/s" } } }).ok).toBe(
      false,
    );
    // Zero source descriptors.
    expect(validateConfigShape({ configVersion: "0.9.0", bundles: { a: { writable: true } } }).ok).toBe(false);
    // Two source descriptors.
    expect(
      validateConfigShape({ configVersion: "0.9.0", bundles: { a: { path: "/s", git: "https://x.test/y.git" } } }).ok,
    ).toBe(false);
  });

  test("resolveConfiguredSources consumes bundles: defaultBundle first, then map insertion order (D-R4/D-R5)", () => {
    const config = {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      bundles: {
        catalog: { git: "https://example.test/catalog.git" },
        primary: { path: "/home/u/akm", writable: true },
        docs: { website: { url: "https://example.test/docs/", maxPages: 25 } },
      },
      defaultBundle: "primary",
    } as unknown as AkmConfig;

    // defaultBundle first, then remaining keys in insertion order.
    expect(bundlesToSourceEntries(config)?.map((e) => e.name)).toEqual(["primary", "catalog", "docs"]);

    const resolved = resolveConfiguredSources(config);
    expect(resolved.map((s) => s.name)).toEqual(["primary", "catalog", "docs"]);
    expect(resolved[0]).toMatchObject({ name: "primary", primary: true, writable: true });
    expect(resolved[0]!.source).toEqual({ type: "filesystem", path: "/home/u/akm" });
    expect(resolved[1]!.source).toEqual({ type: "git", url: "https://example.test/catalog.git" });
    expect(resolved[2]!.source).toMatchObject({ type: "website", url: "https://example.test/docs/", maxPages: 25 });
  });

  test("rejects defaultBundle that names no bundle", () => {
    expect(
      validateConfigShape({ configVersion: "0.9.0", bundles: { a: { path: "/s" } }, defaultBundle: "missing" }).ok,
    ).toBe(false);
  });

  test("ignores a stray top-level bindings block instead of failing config load", () => {
    expect(validateConfigShape({ configVersion: "0.9.0", bindings: { release: { export: "a//x" } } }).ok).toBe(true);
  });

  test("rejects a per-engine model alias table (still meaningful on an engine, unlike the retired top-level table)", () => {
    expect(
      validateConfigShape({
        configVersion: "0.9.0",
        engines: { agent: { kind: "agent", platform: "pi", modelAliases: { fast: "model-a" } } },
      }).ok,
    ).toBe(false);
  });

  test("ignores the retired top-level modelAliases table instead of failing config load", () => {
    expect(validateConfigShape({ configVersion: "0.9.0", modelAliases: { deep: { pi: "model-b" } } }).ok).toBe(true);
  });
});
