// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Direct unit tests for the pure functions extracted out of the setup
 * monolith during the setup.ts decomposition:
 *   - `deepMergeConfig` / `isPlainObject`  (src/core/deep-merge.ts)
 *   - the setup engine adapters              (src/setup/legacy-config.ts)
 *   - the cloud provider defaults table      (src/setup/providers.ts)
 *
 * These functions are now independently importable; the point of the move was
 * to make them testable without driving the whole wizard.
 */

import { describe, expect, test } from "bun:test";
import type { AkmConfig, LlmConnectionConfig } from "../../src/core/config/config";
import { deepMergeConfig, isPlainObject } from "../../src/core/deep-merge";
import { applyLegacyAgent, applyLegacyLlm, cloneLlmConfig, getCurrentAgentBlock } from "../../src/setup/legacy-config";
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

  test("a non-object incoming replaces the base entirely", () => {
    expect(deepMergeConfig<unknown>({ a: 1 }, 5)).toBe(5);
  });

  test("isPlainObject rejects null and arrays", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject("x")).toBe(false);
  });
});

describe("setup LLM adapters", () => {
  test("applyLegacyLlm writes the default engine + defaults.llmEngine", () => {
    const base = {} as AkmConfig;
    const llm: LlmConnectionConfig = { provider: "openai", endpoint: "https://x/v1", model: "gpt-4o-mini" };
    const patch = applyLegacyLlm(base, llm);
    expect(patch.engines?.default).toEqual({ ...llm, kind: "llm", endpoint: "https://x/v1/chat/completions" });
    expect(patch.defaults?.llmEngine).toBe("default");
  });

  test("applyLegacyLlm(undefined) clears the default engine and defaults.llmEngine", () => {
    const base = {
      engines: { default: { kind: "llm", endpoint: "https://e/v1/chat/completions", model: "m" } },
      defaults: { llmEngine: "default" },
    } as unknown as AkmConfig;
    const patch = applyLegacyLlm(base, undefined);
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
    const clone = cloneLlmConfig(llm);
    expect(clone).toEqual(llm);
    expect(clone?.capabilities).not.toBe(llm.capabilities);
    expect(clone?.extraParams).not.toBe(llm.extraParams);
    expect(cloneLlmConfig(undefined)).toBeUndefined();
  });
});

describe("setup agent adapters", () => {
  test("applyLegacyAgent + getCurrentAgentBlock round-trips a CLI default", () => {
    const base = {} as AkmConfig;
    const applied = { ...base, ...applyLegacyAgent(base, { default: "claude" }) } as AkmConfig;
    expect(applied.defaults?.engine).toBe("claude");
    expect(applied.engines?.claude).toEqual({ kind: "agent", platform: "claude" });
    const block = getCurrentAgentBlock(applied);
    expect(block?.default).toBe("claude");
  });

  test("applyLegacyAgent maps an sdkMode profile to the opencode-sdk platform", () => {
    const base = {} as AkmConfig;
    const patch = applyLegacyAgent(base, {
      default: "default",
      profiles: { default: { sdkMode: true, model: "m", endpoint: "e" } },
    });
    expect(patch.engines?.default).toMatchObject({ kind: "agent", platform: "opencode-sdk", model: "m" });
  });

  test("getCurrentAgentBlock returns undefined when no agent config is present", () => {
    expect(getCurrentAgentBlock({} as AkmConfig)).toBeUndefined();
  });
});

describe("PROVIDER_DEFAULTS", () => {
  test("maps the four known cloud providers to endpoint + model", () => {
    expect(PROVIDER_DEFAULTS.anthropic).toEqual({
      endpoint: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4-5",
    });
    expect(PROVIDER_DEFAULTS.openai.endpoint).toBe("https://api.openai.com/v1");
    expect(PROVIDER_DEFAULTS.gemini.model).toBe("gemini-1.5-flash");
    expect(PROVIDER_DEFAULTS.groq.model).toBe("llama-3.3-70b-versatile");
  });

  test("an unknown provider has no entry (former switch default → undefined)", () => {
    expect(PROVIDER_DEFAULTS.unknown).toBeUndefined();
  });
});
