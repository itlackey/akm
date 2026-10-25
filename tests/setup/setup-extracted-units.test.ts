// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Direct unit tests for the pure functions extracted out of the setup
 * monolith during the setup.ts decomposition:
 *   - `deepMergeConfig` / `isPlainObject`  (src/core/config/deep-merge.ts)
 *   - direct setup engine writers           (src/setup/engine-config.ts)
 *   - the cloud provider defaults table      (src/setup/providers.ts)
 *
 * These functions are now independently importable; the point of the move was
 * to make them testable without driving the whole wizard.
 */

import { describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../src/core/config/config";
import { deepMergeConfig, isPlainObject } from "../../src/core/config/deep-merge";
import {
  cloneLlmConnection,
  readAgentEngineSelection,
  readCurrentLlmEngine,
  type SetupConnection,
  writeAgentEngines,
  writeLlmEngine,
} from "../../src/setup/engine-config";
import { PROVIDER_DEFAULTS } from "../../src/setup/providers";

describe("deepMergeConfig", () => {
  test("merges nested plain objects key-by-key, preserving sibling subkeys", () => {
    const base = { output: { format: "json", detail: "brief" }, bundles: { local: { path: "/a" } } };
    const merged = deepMergeConfig(base, { output: { format: "text" } });
    expect(merged).toEqual({ output: { format: "text", detail: "brief" }, bundles: { local: { path: "/a" } } });
  });

  test("arrays replace wholesale (no element merge)", () => {
    const base = { registries: [{ url: "https://a.test" }, { url: "https://b.test" }] };
    const merged = deepMergeConfig(base, { registries: [{ url: "https://c.test" }] });
    expect(merged).toEqual({ registries: [{ url: "https://c.test" }] });
  });

  test("scalars replace and undefined values are skipped", () => {
    const base = { a: 1, b: 2 };
    const merged = deepMergeConfig(base, { a: 9, b: undefined });
    expect(merged).toEqual({ a: 9, b: 2 });
  });

  test("does not mutate the base object graph", () => {
    const base: Record<string, unknown> = { nested: { keep: true } };
    const merged = deepMergeConfig(base, { nested: { added: 1 } });
    expect(base).toEqual({ nested: { keep: true } });
    expect(merged).toEqual({ nested: { keep: true, added: 1 } });
  });

  test("scalar values replace at their configured key", () => {
    expect(deepMergeConfig({ a: 1 }, { a: 5 })).toEqual({ a: 5 });
  });

  test("isPlainObject rejects null and arrays", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject("x")).toBe(false);
  });

  test("rejects prototype-pollution keys at every depth", () => {
    expect(() => deepMergeConfig({}, JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow(/Unsafe/);
    expect(() => deepMergeConfig({}, { safe: JSON.parse('{"constructor":{"prototype":{"x":1}}}') })).toThrow(/Unsafe/);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

/** A config as setup reads it: the required `semanticSearchMode` plus what the test names. */
const cfg = (partial: Partial<AkmConfig> = {}): AkmConfig => ({ semanticSearchMode: "off", ...partial });

describe("setup connection writer", () => {
  test("readCurrentLlmEngine reads the default connection's endpoint, first model and key reference", () => {
    const config = cfg({
      connections: {
        default: {
          endpoint: "https://x/v1/chat/completions",
          models: { fast: "m" },
          apiKey: "$X_KEY",
          timeoutMs: null,
        },
      },
    });

    expect(readCurrentLlmEngine(config)).toEqual({
      endpoint: "https://x/v1/chat/completions",
      model: "m",
      apiKey: "$X_KEY",
    });
    expect(readCurrentLlmEngine(cfg())).toBeUndefined();
  });

  test("writeLlmEngine writes the default connection with the model under every standard alias", () => {
    const patch = writeLlmEngine(cfg(), { endpoint: "https://x/v1/chat/completions", model: "gpt-4o-mini" });
    expect(patch.connections).toEqual({
      default: {
        endpoint: "https://x/v1/chat/completions",
        models: { fast: "gpt-4o-mini", balanced: "gpt-4o-mini", reasoning: "gpt-4o-mini" },
      },
    });
  });

  test("writeLlmEngine updates the connection that is already the default and keeps what it holds", () => {
    const base = cfg({
      connections: {
        lab: {
          endpoint: "https://old/v1/chat/completions",
          models: { fast: "old", embedder: "keep-me" },
          timeoutMs: null,
          top_p: 0.9,
        },
      },
    });

    const patch = writeLlmEngine(base, { endpoint: "https://new/v1/chat/completions", model: "m", apiKey: "$NEW_KEY" });

    expect(Object.keys(patch.connections ?? {})).toEqual(["lab"]);
    expect(patch.connections?.lab).toEqual({
      endpoint: "https://new/v1/chat/completions",
      models: { fast: "m", embedder: "keep-me", balanced: "m", reasoning: "m" },
      apiKey: "$NEW_KEY",
      timeoutMs: null,
      top_p: 0.9,
    });
  });

  test("writeLlmEngine(undefined) removes the default connection and keeps the others", () => {
    const base = cfg({
      connections: {
        default: { endpoint: "https://e/v1/chat/completions", models: { fast: "m" } },
        other: { endpoint: "https://o/v1/chat/completions", models: { fast: "m" } },
      },
    });
    const patch = writeLlmEngine(base, undefined);
    expect(Object.keys(patch.connections ?? {})).toEqual(["other"]);
  });

  test("cloneLlmConnection deep-copies the connection", () => {
    const llm: SetupConnection = { provider: "lab", endpoint: "e", model: "m", apiKey: "$K" };
    const clone = cloneLlmConnection(llm);
    expect(clone).toEqual(llm);
    expect(clone).not.toBe(llm);
    expect(cloneLlmConnection(undefined)).toBeUndefined();
  });
});

describe("setup harness writer", () => {
  test("declining a harness leaves the configured harnesses as they are", () => {
    const base = cfg({ harnesses: { claude: {} } });
    expect(writeAgentEngines(base, undefined)).toEqual({ harnesses: { claude: {} } });
  });

  test("explicit none clears every harness", () => {
    const base = cfg({
      connections: { local: { endpoint: "http://localhost/v1/chat/completions", models: { fast: "m" } } },
      harnesses: { claude: {} },
    });

    expect(writeAgentEngines(base, { disabled: true })).toEqual({ harnesses: {} });
  });

  test("writeAgentEngines + readAgentEngineSelection round-trips a CLI default", () => {
    const applied = cfg(writeAgentEngines(cfg(), { default: "claude" }));
    expect(applied.harnesses).toEqual({ claude: {} });
    expect(readAgentEngineSelection(applied)?.default).toBe("claude");
  });

  test("a chosen harness joining others is named default, so agent work runs on it", () => {
    const base = cfg({ harnesses: { codex: {} } });
    const patch = writeAgentEngines(base, { default: "claude" });
    expect(patch.harnesses).toEqual({ codex: {}, default: { platform: "claude" } });
    expect(readAgentEngineSelection(cfg({ ...base, ...patch }))?.default).toBe("default");
  });

  test("selected harnesses merge over the configured ones", () => {
    const base = cfg({ harnesses: { codex: {} } });
    const patch = writeAgentEngines(base, { default: "claude", harnesses: { claude: { bin: "/opt/claude" } } });
    expect(patch.harnesses).toEqual({ codex: {}, default: { platform: "claude", bin: "/opt/claude" } });
  });

  test("readAgentEngineSelection returns undefined when no harness is configured", () => {
    expect(readAgentEngineSelection(cfg())).toBeUndefined();
  });
});

describe("PROVIDER_DEFAULTS", () => {
  test("maps the four known cloud providers to endpoint + model", () => {
    expect(PROVIDER_DEFAULTS.anthropic).toEqual({
      endpoint: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4-5",
    });
    expect(PROVIDER_DEFAULTS.openai!.endpoint).toBe("https://api.openai.com/v1");
    expect(PROVIDER_DEFAULTS.gemini!.model).toBe("gemini-1.5-flash");
    expect(PROVIDER_DEFAULTS.groq!.model).toBe("llama-3.3-70b-versatile");
  });

  test("an unknown provider has no entry (former switch default → undefined)", () => {
    expect(PROVIDER_DEFAULTS.unknown).toBeUndefined();
  });
});
