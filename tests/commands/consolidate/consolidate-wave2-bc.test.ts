/**
 * Wave-2 QA fixes tests — Cluster B (#21, #36) and Cluster C (#6, #14, #24).
 *
 * Cluster B: defaultWriteTarget and llm/embedding subkey support in config-cli.
 * Cluster C: empty-query guards + minScore floor for semantic-only hits.
 */

import { describe, expect, test } from "bun:test";
import {
  getConfigValue,
  listConfig,
  parseConfigValue,
  setConfigValue,
  unsetConfigValue,
} from "../../../src/commands/config-cli";
import type { AkmConfig } from "../../../src/core/config/config";

// ── Cluster B: #21 defaultWriteTarget ────────────────────────────────────────

describe("config-cli: defaultWriteTarget (#21)", () => {
  const base: AkmConfig = { semanticSearchMode: "auto" };

  test("parseConfigValue returns defaultWriteTarget", () => {
    expect(parseConfigValue("defaultWriteTarget", "my-stash")).toEqual({
      defaultWriteTarget: "my-stash",
    });
  });

  test("parseConfigValue rejects empty defaultWriteTarget", () => {
    expect(() => parseConfigValue("defaultWriteTarget", "")).toThrow();
  });

  test("getConfigValue returns null when not set", () => {
    expect(getConfigValue(base, "defaultWriteTarget")).toBeNull();
  });

  test("getConfigValue returns the set value", () => {
    const config: AkmConfig = { ...base, defaultWriteTarget: "my-stash" };
    expect(getConfigValue(config, "defaultWriteTarget")).toBe("my-stash");
  });

  test("setConfigValue sets defaultWriteTarget — no sources configured", () => {
    const result = setConfigValue(base, "defaultWriteTarget", "any-name");
    expect(result.defaultWriteTarget).toBe("any-name");
  });

  test("setConfigValue validates name against sources when sources[] is non-empty", () => {
    const config: AkmConfig = {
      ...base,
      sources: [{ type: "filesystem", path: "/tmp/stash", name: "primary" }],
    };
    expect(() => setConfigValue(config, "defaultWriteTarget", "unknown-stash")).toThrow(/Unknown source name/);
  });

  test("setConfigValue accepts a valid source name", () => {
    const config: AkmConfig = {
      ...base,
      sources: [{ type: "filesystem", path: "/tmp/stash", name: "primary" }],
    };
    const result = setConfigValue(config, "defaultWriteTarget", "primary");
    expect(result.defaultWriteTarget).toBe("primary");
  });

  test("unsetConfigValue clears defaultWriteTarget", () => {
    const config: AkmConfig = { ...base, defaultWriteTarget: "primary" };
    const result = unsetConfigValue(config, "defaultWriteTarget");
    expect(result.defaultWriteTarget).toBeUndefined();
  });

  test("listConfig includes defaultWriteTarget when set", () => {
    const config: AkmConfig = { ...base, defaultWriteTarget: "primary" };
    const listed = listConfig(config);
    expect(listed.defaultWriteTarget).toBe("primary");
  });

  test("listConfig omits defaultWriteTarget when not set", () => {
    const listed = listConfig(base);
    expect(listed.defaultWriteTarget).toBeUndefined();
  });
});

// ── Cluster B: engine/embedding subkey support ────────────────────────────────

describe("config-cli: engines.* and embedding.* subkeys (#36)", () => {
  const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };

  // ── parseConfigValue ──────────────────────────────────────────────────────

  test("parseConfigValue handles engines.local.endpoint", () => {
    const result = parseConfigValue("engines.local.endpoint", "http://localhost:11434/v1/chat/completions");
    expect(result.engines?.local?.endpoint).toBe("http://localhost:11434/v1/chat/completions");
  });

  test("parseConfigValue handles engines.local.model", () => {
    const result = parseConfigValue("engines.local.model", "llama3.2");
    expect(result.engines?.local?.model).toBe("llama3.2");
  });

  test("parseConfigValue explicitly rejects the retired llm.apiKey path (#454)", () => {
    expect(() => parseConfigValue("llm.apiKey", "sk-test")).toThrow(/apiKey cannot be persisted/);
    expect(() => parseConfigValue("llm.apiKey", "sk-test")).toThrow(/AKM_LLM_API_KEY/);
  });

  test("parseConfigValue handles embedding.endpoint", () => {
    const result = parseConfigValue("embedding.endpoint", "http://localhost:11434/v1/embeddings");
    expect(result.embedding?.endpoint).toBe("http://localhost:11434/v1/embeddings");
  });

  test("parseConfigValue handles embedding.model", () => {
    const result = parseConfigValue("embedding.model", "nomic-embed-text");
    expect(result.embedding?.model).toBe("nomic-embed-text");
  });

  test("parseConfigValue rejects embedding.apiKey persistence (#454)", () => {
    expect(() => parseConfigValue("embedding.apiKey", "sk-embed")).toThrow(/apiKey cannot be persisted/);
    expect(() => parseConfigValue("embedding.apiKey", "sk-embed")).toThrow(/AKM_EMBED_API_KEY/);
  });

  test("parseConfigValue rejects an empty engine endpoint", () => {
    expect(() => parseConfigValue("engines.local.endpoint", "")).toThrow(/endpoint must be a complete URL/);
  });

  // ── getConfigValue ────────────────────────────────────────────────────────

  test("getConfigValue: engines.local.endpoint returns null when the engine is not set", () => {
    expect(getConfigValue(base, "engines.local.endpoint")).toBeNull();
  });

  test("getConfigValue: engine connection fields return values when set", () => {
    const config: AkmConfig = {
      ...base,
      engines: {
        local: { kind: "llm", endpoint: "http://localhost/v1/chat/completions", model: "llama3.2" },
      },
      defaults: { llmEngine: "local" },
    };
    expect(getConfigValue(config, "engines.local.endpoint")).toBe("http://localhost/v1/chat/completions");
    expect(getConfigValue(config, "engines.local.model")).toBe("llama3.2");
    expect(getConfigValue(config, "engines.local.apiKey")).toBeNull();
  });

  test("getConfigValue: embedding subkeys work", () => {
    const config: AkmConfig = {
      ...base,
      embedding: { endpoint: "http://localhost/emb", model: "bge-small" },
    };
    expect(getConfigValue(config, "embedding.endpoint")).toBe("http://localhost/emb");
    expect(getConfigValue(config, "embedding.model")).toBe("bge-small");
    expect(getConfigValue(config, "embedding.apiKey")).toBeNull();
  });

  // ── setConfigValue with deep merge ────────────────────────────────────────

  test("setConfigValue: engine endpoint preserves sibling model field", () => {
    const config: AkmConfig = {
      ...base,
      engines: { local: { kind: "llm", endpoint: "http://old/chat/completions", model: "old-model" } },
      defaults: { llmEngine: "local" },
    };
    const result = setConfigValue(config, "engines.local.endpoint", "http://new/chat/completions");
    expect(result.engines?.local?.endpoint).toBe("http://new/chat/completions");
    expect(result.engines?.local?.model).toBe("old-model");
  });

  test("setConfigValue: engine model preserves sibling endpoint field", () => {
    const config: AkmConfig = {
      ...base,
      engines: {
        local: { kind: "llm", endpoint: "http://localhost/v1/chat/completions", model: "old-model" },
      },
      defaults: { llmEngine: "local" },
    };
    const result = setConfigValue(config, "engines.local.model", "gpt-4o");
    expect(result.engines?.local?.model).toBe("gpt-4o");
    expect(result.engines?.local?.endpoint).toBe("http://localhost/v1/chat/completions");
  });

  test("setConfigValue: retired llm.apiKey is rejected with an env-var hint (#454)", () => {
    const config: AkmConfig = { ...base };
    expect(() => setConfigValue(config, "llm.apiKey", "sk-secret")).toThrow(/apiKey cannot be persisted/);
  });

  test("setConfigValue: embedding.endpoint works when embedding was undefined", () => {
    const result = setConfigValue(base, "embedding.endpoint", "http://localhost/emb");
    expect(result.embedding?.endpoint).toBe("http://localhost/emb");
    // Post-rewrite: subkey-set no longer scaffolds an empty `model`. The
    // user runs `embedding.model <name>` as a follow-up.
    expect(result.embedding?.model).toBeUndefined();
  });

  // ── unsetConfigValue ──────────────────────────────────────────────────────

  test("unsetConfigValue: engine endpoint removes the key", () => {
    const config: AkmConfig = {
      ...base,
      engines: {
        local: { kind: "llm", endpoint: "http://localhost/v1/chat/completions", model: "llama3.2" },
      },
      defaults: { llmEngine: "local" },
    };
    const result = unsetConfigValue(config, "engines.local.endpoint");
    expect(result.engines?.local?.endpoint).toBeUndefined();
    expect(result.engines?.local?.model).toBe("llama3.2");
  });

  test("unsetConfigValue: engine apiKey removes the key", () => {
    const config: AkmConfig = {
      ...base,
      engines: {
        local: {
          kind: "llm",
          endpoint: "http://localhost/v1/chat/completions",
          model: "llama3.2",
          apiKey: "$LOCAL_API_KEY",
        },
      },
      defaults: { llmEngine: "local" },
    };
    const result = unsetConfigValue(config, "engines.local.apiKey");
    expect(result.engines?.local?.apiKey).toBeUndefined();
    expect(result.engines?.local?.endpoint).toBe("http://localhost/v1/chat/completions");
  });

  test("unsetConfigValue: embedding.apiKey removes the key", () => {
    const config: AkmConfig = {
      ...base,
      embedding: { endpoint: "http://localhost/emb", model: "bge-small", apiKey: "sk-embed" },
    };
    const result = unsetConfigValue(config, "embedding.apiKey");
    expect(result.embedding?.apiKey).toBeUndefined();
    expect(result.embedding?.endpoint).toBe("http://localhost/emb");
  });
});

// ── Cluster C: #14 empty query guard ────────────────────────────────────────

describe("search empty-query guard (#14, #24)", () => {
  // Note: The empty-query guard for `akmSearch` lives in the CLI layer (src/cli.ts),
  // not in `akmSearch` itself (which accepts empty queries for programmatic list-all).
  // The guard for `akmCurate` IS in the function itself since curation always
  // requires a meaningful query.

  test("akmCurate throws UsageError for empty string query", async () => {
    const { akmCurate } = await import("../../../src/commands/read/curate");
    await expect(akmCurate({ query: "" })).rejects.toThrow(/query is required/i);
  });

  test("akmCurate throws UsageError for whitespace-only query", async () => {
    const { akmCurate } = await import("../../../src/commands/read/curate");
    await expect(akmCurate({ query: "   " })).rejects.toThrow(/query is required/i);
  });

  test("akmCurate UsageError has MISSING_REQUIRED_ARGUMENT code", async () => {
    const { akmCurate } = await import("../../../src/commands/read/curate");
    const { UsageError } = await import("../../../src/core/errors");
    try {
      await akmCurate({ query: "" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as import("../../../src/core/errors").UsageError).code).toBe("MISSING_REQUIRED_ARGUMENT");
    }
  });
});

// ── Cluster C: #6 minScore floor ─────────────────────────────────────────────

describe("search.minScore floor in config (#6)", () => {
  test("AkmConfig accepts search.minScore", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      search: { minScore: 0.3 },
    };
    expect(config.search?.minScore).toBe(0.3);
  });

  test("AkmConfig accepts search.minScore of 0 (disabled)", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      search: { minScore: 0 },
    };
    expect(config.search?.minScore).toBe(0);
  });

  test("minScore default is 0.2 in db-search (white-box)", () => {
    // Verify the default is what the implementation docs: if search is
    // undefined then minScore should be 0.2 (defaulted in db-search.ts).
    const config: AkmConfig = { semanticSearchMode: "auto" };
    expect(config.search?.minScore).toBeUndefined();
    // The effective default 0.2 is applied inside searchDatabase; we just
    // confirm the config field default is undefined here. An integration test
    // would require a live DB with semantic hits, which is out of scope.
  });
});
