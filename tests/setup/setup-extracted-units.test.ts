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
import type { AkmConfig, LlmConnectionConfig } from "../../src/core/config/config";
import { deepMergeConfig, isPlainObject } from "../../src/core/config/deep-merge";
import {
  cloneLlmConnection,
  readAgentEngineSelection,
  readCurrentLlmEngine,
  writeAgentEngines,
  writeLlmEngine,
} from "../../src/setup/engine-config";
import { PROVIDER_DEFAULTS } from "../../src/setup/providers";

describe("deepMergeConfig", () => {
  test("merges nested plain objects key-by-key, preserving sibling subkeys", () => {
    const base = { output: { format: "json", detail: "brief" }, stashDir: "/a" };
    const merged = deepMergeConfig(base, { output: { format: "text" } });
    expect(merged).toEqual({ output: { format: "text", detail: "brief" }, stashDir: "/a" });
  });

  test("arrays replace wholesale (no element merge)", () => {
    const base = { sources: [{ url: "a" }, { url: "b" }] };
    const merged = deepMergeConfig(base, { sources: [{ url: "c" }] });
    expect(merged).toEqual({ sources: [{ url: "c" }] });
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

describe("setup LLM engine writer", () => {
  test("readCurrentLlmEngine preserves an explicit unbounded timeout", () => {
    const config = {
      engines: { default: { kind: "llm", endpoint: "https://x/v1/chat/completions", model: "m", timeoutMs: null } },
      defaults: { llmEngine: "default" },
    } as unknown as AkmConfig;

    expect(readCurrentLlmEngine(config)?.timeoutMs).toBeNull();
  });

  test("writeLlmEngine establishes both the general and LLM defaults when neither exists", () => {
    const base = {} as AkmConfig;
    const llm: LlmConnectionConfig = { provider: "openai", endpoint: "https://x/v1", model: "gpt-4o-mini" };
    const patch = writeLlmEngine(base, llm);
    expect(patch.engines?.default).toEqual({ ...llm, kind: "llm", endpoint: "https://x/v1/chat/completions" });
    expect(patch.defaults?.llmEngine).toBe("default");
    expect(patch.defaults?.engine).toBe("default");
  });

  test("writeLlmEngine preserves a selected general agent default", () => {
    const base = {
      engines: { reviewer: { kind: "agent", platform: "claude" } },
      defaults: { engine: "reviewer" },
    } as unknown as AkmConfig;
    const patch = writeLlmEngine(base, { endpoint: "https://x/v1", model: "m" });
    expect(patch.defaults).toMatchObject({ engine: "reviewer", llmEngine: "default" });
  });

  test("writeLlmEngine(undefined) clears the default engine and defaults.llmEngine", () => {
    const base = {
      engines: { default: { kind: "llm", endpoint: "https://e/v1/chat/completions", model: "m" } },
      defaults: { llmEngine: "default" },
    } as unknown as AkmConfig;
    const patch = writeLlmEngine(base, undefined);
    expect(patch.engines?.default).toBeUndefined();
    expect(patch.defaults?.llmEngine).toBeUndefined();
  });

  test("cloneLlmConfig deep-copies capabilities + extraParams", () => {
    const llm: LlmConnectionConfig = {
      endpoint: "e",
      model: "m",
      capabilities: { structuredOutput: true },
      extraParams: { top_p: 0.9 },
    };
    const clone = cloneLlmConnection(llm);
    expect(clone).toEqual(llm);
    expect(clone?.capabilities).not.toBe(llm.capabilities);
    expect(clone?.extraParams).not.toBe(llm.extraParams);
    expect(cloneLlmConnection(undefined)).toBeUndefined();
  });
});

describe("setup agent engine writer", () => {
  test("declining an agent default preserves an LLM-valued general default", () => {
    const base = {
      engines: { local: { kind: "llm", endpoint: "http://localhost/v1/chat/completions", model: "m" } },
      defaults: { engine: "local", llmEngine: "local" },
    } as unknown as AkmConfig;
    const patch = writeAgentEngines(base, undefined);
    expect(patch.defaults).toEqual(base.defaults);
  });

  test("explicit none clears an agent default and restores the LLM general default", () => {
    const base = {
      engines: {
        local: { kind: "llm", endpoint: "http://localhost/v1/chat/completions", model: "m" },
        claude: { kind: "agent", platform: "claude" },
      },
      defaults: { engine: "claude", llmEngine: "local" },
    } as unknown as AkmConfig;

    const patch = writeAgentEngines(base, { disabled: true });

    expect(patch.defaults).toEqual({ engine: "local", llmEngine: "local" });
  });

  test("writeAgentEngines + readAgentEngineSelection round-trips a CLI default", () => {
    const base = {} as AkmConfig;
    const applied = { ...base, ...writeAgentEngines(base, { default: "claude" }) } as AkmConfig;
    expect(applied.defaults?.engine).toBe("claude");
    expect(applied.engines?.claude).toEqual({ kind: "agent", platform: "claude" });
    const block = readAgentEngineSelection(applied);
    expect(block?.default).toBe("claude");
  });

  test("writeAgentEngines persists an opencode-sdk engine directly", () => {
    const base = {} as AkmConfig;
    const patch = writeAgentEngines(base, {
      default: "default",
      engines: { default: { kind: "agent", platform: "opencode-sdk", model: "m" } },
    });
    expect(patch.engines?.default).toMatchObject({ kind: "agent", platform: "opencode-sdk", model: "m" });
  });

  test("getCurrentAgentBlock returns undefined when no agent config is present", () => {
    expect(readAgentEngineSelection({} as AkmConfig)).toBeUndefined();
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
