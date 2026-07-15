// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getDefaultLlmConfig, loadUserConfig, resetConfigCache, saveConfig } from "../../src/core/config/config";
import { validateConfigShape } from "../../src/core/config/config-schema";
import { configSet } from "../../src/core/config/config-walker";
import { ConfigError } from "../../src/core/errors";
import { getConfigPath } from "../../src/core/paths";

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

  test("rejects profile vocabulary and literal LLM credentials", () => {
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
    expect(() => loadUserConfig()).toThrow(ConfigError);
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

  test("resolves direct LLM consumers from defaults.llmEngine", () => {
    const config = {
      configVersion: "0.9.0" as const,
      semanticSearchMode: "auto" as const,
      engines: {
        fast: { kind: "llm" as const, endpoint: "https://example.test/v1/chat/completions", model: "fast-model" },
      },
      defaults: { llmEngine: "fast" },
    };
    expect(getDefaultLlmConfig(config)).toMatchObject({
      endpoint: "https://example.test/v1/chat/completions",
      model: "fast-model",
    });
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

  test("rejects retired improve process selectors", () => {
    writeConfig({
      configVersion: "0.9.0",
      improve: { strategies: { default: { processes: { reflect: { profile: "fast", mode: "llm" } } } } },
    });
    expect(() => loadUserConfig()).toThrow(ConfigError);
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

  test("normalizes model aliases to lowercase and rejects case-insensitive collisions", () => {
    const normalized = validateConfigShape({
      configVersion: "0.9.0",
      engines: { agent: { kind: "agent", platform: "pi", modelAliases: { FAST: "model-a" } } },
      modelAliases: { DEEP: { pi: "model-b" } },
    });
    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.value.engines?.agent?.modelAliases).toEqual({ fast: "model-a" });
      expect(normalized.value.modelAliases).toEqual({ deep: { pi: "model-b" } });
    }

    expect(
      validateConfigShape({
        configVersion: "0.9.0",
        engines: { agent: { kind: "agent", platform: "pi", modelAliases: { FAST: "a", fast: "b" } } },
      }).ok,
    ).toBe(false);
    expect(
      validateConfigShape({
        configVersion: "0.9.0",
        modelAliases: { DEEP: { pi: "a" }, deep: { pi: "b" } },
      }).ok,
    ).toBe(false);
  });
});
