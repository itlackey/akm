/**
 * Wave-2 QA fixes tests — Cluster B (#21, #36) and Cluster C (#6, #14, #24).
 *
 * Cluster B: defaultWriteTarget and llm/embedding subkey support in config-cli.
 * Cluster C: empty-query guards.
 */

import { describe, expect, test } from "bun:test";
import { getConfigValue, listConfig, setConfigValue, unsetConfigValue } from "../../../../src/commands/config-cli";
import type { AkmConfig } from "../../../../src/core/config/config";

// ── Cluster B: #21 defaultWriteTarget ────────────────────────────────────────

describe("config-cli: defaultWriteTarget (#21)", () => {
  const base: AkmConfig = { semanticSearchMode: "auto" };

  // R-063 #5: "setConfigValue cannot set defaultWriteTarget without a
  // configured bundle" used to be a `parseConfigValue`-shim test (removed —
  // dead code); it duplicated the "rejects defaultWriteTarget when no
  // bundles are configured" case below, so it is not re-added here.
  test("setConfigValue rejects empty defaultWriteTarget", () => {
    expect(() => setConfigValue(base, "defaultWriteTarget", "")).toThrow();
  });

  test("getConfigValue returns null when not set", () => {
    expect(getConfigValue(base, "defaultWriteTarget")).toBeNull();
  });

  test("getConfigValue returns the set value", () => {
    const config: AkmConfig = { ...base, defaultWriteTarget: "my-stash" };
    expect(getConfigValue(config, "defaultWriteTarget")).toBe("my-stash");
  });

  test("setConfigValue rejects defaultWriteTarget when no bundles are configured", () => {
    expect(() => setConfigValue(base, "defaultWriteTarget", "any-name")).toThrow(/Unknown bundle/);
  });

  test("setConfigValue validates the name against configured bundles", () => {
    const config: AkmConfig = {
      ...base,
      bundles: { primary: { path: "/tmp/stash" } },
    };
    expect(() => setConfigValue(config, "defaultWriteTarget", "unknown-stash")).toThrow(/Unknown bundle/);
  });

  test("setConfigValue accepts a valid source name", () => {
    const config: AkmConfig = {
      ...base,
      bundles: { primary: { path: "/tmp/stash" } },
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

// ── Cluster B: connection/embedding subkey support ────────────────────────────────

describe("config-cli: connections.* and embedding.* subkeys (#36)", () => {
  const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };

  // ── setConfigValue ────────────────────────────────────────────────────────
  // R-063 #5: previously exercised via `parseConfigValue`, a compatibility
  // shim removed as dead code (zero production callers) — see the note in
  // tests/config-cli.test.ts. `setConfigValue` is the live implementation.

  test("setConfigValue handles connections.local.endpoint", () => {
    const result = setConfigValue(base, "connections.local.endpoint", "http://localhost:11434/v1/chat/completions");
    expect(result.connections?.local?.endpoint).toBe("http://localhost:11434/v1/chat/completions");
  });

  test("setConfigValue handles connections.local.models.fast", () => {
    const result = setConfigValue(base, "connections.local.models.fast", "llama3.2");
    expect(result.connections?.local?.models).toEqual({ fast: "llama3.2" });
  });

  test("setConfigValue handles embedding.endpoint", () => {
    const result = setConfigValue(base, "embedding.endpoint", "http://localhost:11434/v1/embeddings");
    expect(result.embedding?.endpoint).toBe("http://localhost:11434/v1/embeddings");
  });

  test("setConfigValue handles embedding.model", () => {
    const result = setConfigValue(base, "embedding.model", "nomic-embed-text");
    expect(result.embedding?.model).toBe("nomic-embed-text");
  });

  test("setConfigValue accepts symbolic embedding credentials and rejects literals", () => {
    expect(setConfigValue(base, "embedding.apiKey", "$AKM_EMBED_API_KEY").embedding?.apiKey).toBe("$AKM_EMBED_API_KEY");
    expect(() => setConfigValue(base, "embedding.apiKey", "sk-embed")).toThrow(
      /apiKey cannot be a literal in config; use a \$VAR reference/,
    );
  });

  test("setConfigValue rejects an empty connection endpoint", () => {
    expect(() => setConfigValue(base, "connections.local.endpoint", "")).toThrow(/endpoint must be a complete URL/);
  });

  // ── getConfigValue ────────────────────────────────────────────────────────

  test("getConfigValue: connections.local.endpoint returns null when the connection is not set", () => {
    expect(getConfigValue(base, "connections.local.endpoint")).toBeNull();
  });

  test("getConfigValue: connection fields return values when set", () => {
    const config: AkmConfig = {
      ...base,
      connections: { local: { endpoint: "http://localhost/v1/chat/completions", models: { fast: "llama3.2" } } },
    };
    expect(getConfigValue(config, "connections.local.endpoint")).toBe("http://localhost/v1/chat/completions");
    expect(getConfigValue(config, "connections.local.models.fast")).toBe("llama3.2");
    expect(getConfigValue(config, "connections.local.apiKey")).toBeNull();
  });

  test("getConfigValue: embedding subkeys work", () => {
    const config: AkmConfig = {
      ...base,
      embedding: { endpoint: "http://localhost/emb", model: "bge-small" },
    };
    expect(getConfigValue(config, "embedding.endpoint")).toBe("http://localhost/emb");
    expect(getConfigValue(config, "embedding.model")).toBe("bge-small");
    expect(
      getConfigValue({ ...config, embedding: { ...config.embedding, apiKey: "$EMBED_KEY" } }, "embedding.apiKey"),
    ).toBe("$EMBED_KEY");
  });

  // ── setConfigValue with deep merge ────────────────────────────────────────

  test("setConfigValue: connection endpoint preserves sibling models", () => {
    const config: AkmConfig = {
      ...base,
      connections: { local: { endpoint: "http://old/chat/completions", models: { fast: "old-model" } } },
    };
    const result = setConfigValue(config, "connections.local.endpoint", "http://new/chat/completions");
    expect(result.connections?.local?.endpoint).toBe("http://new/chat/completions");
    expect(result.connections?.local?.models).toEqual({ fast: "old-model" });
  });

  test("setConfigValue: a connection's model alias preserves its endpoint", () => {
    const config: AkmConfig = {
      ...base,
      connections: { local: { endpoint: "http://localhost/v1/chat/completions", models: { fast: "old-model" } } },
    };
    const result = setConfigValue(config, "connections.local.models.fast", "gpt-4o");
    expect(result.connections?.local?.models).toEqual({ fast: "gpt-4o" });
    expect(result.connections?.local?.endpoint).toBe("http://localhost/v1/chat/completions");
  });

  test("setConfigValue: a literal connection apiKey is rejected with a $VAR hint (#454)", () => {
    const config: AkmConfig = { ...base };
    expect(() => setConfigValue(config, "connections.local.apiKey", "sk-secret")).toThrow(
      /apiKey cannot be a literal in config; use a \$VAR reference/,
    );
    expect(setConfigValue(config, "connections.local.apiKey", "$LOCAL_API_KEY").connections?.local?.apiKey).toBe(
      "$LOCAL_API_KEY",
    );
  });

  test("setConfigValue: embedding.endpoint works when embedding was undefined", () => {
    const result = setConfigValue(base, "embedding.endpoint", "http://localhost/emb");
    expect(result.embedding?.endpoint).toBe("http://localhost/emb");
    // Post-rewrite: subkey-set no longer scaffolds an empty `model`. The
    // user runs `embedding.model <name>` as a follow-up.
    expect(result.embedding?.model).toBeUndefined();
  });

  // ── unsetConfigValue ──────────────────────────────────────────────────────

  test("unsetConfigValue: connection endpoint removes the key", () => {
    const config: AkmConfig = {
      ...base,
      connections: { local: { endpoint: "http://localhost/v1/chat/completions", models: { fast: "llama3.2" } } },
    };
    const result = unsetConfigValue(config, "connections.local.endpoint");
    expect(result.connections?.local?.endpoint).toBeUndefined();
    expect(result.connections?.local?.models).toEqual({ fast: "llama3.2" });
  });

  test("unsetConfigValue: connection apiKey removes the key", () => {
    const config: AkmConfig = {
      ...base,
      connections: {
        local: {
          endpoint: "http://localhost/v1/chat/completions",
          models: { fast: "llama3.2" },
          apiKey: "$LOCAL_API_KEY",
        },
      },
    };
    const result = unsetConfigValue(config, "connections.local.apiKey");
    expect(result.connections?.local?.apiKey).toBeUndefined();
    expect(result.connections?.local?.endpoint).toBe("http://localhost/v1/chat/completions");
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
    const { akmCurate } = await import("../../../../src/commands/read/curate");
    await expect(akmCurate({ query: "" })).rejects.toThrow(/query is required/i);
  });

  test("akmCurate throws UsageError for whitespace-only query", async () => {
    const { akmCurate } = await import("../../../../src/commands/read/curate");
    await expect(akmCurate({ query: "   " })).rejects.toThrow(/query is required/i);
  });

  test("akmCurate UsageError has MISSING_REQUIRED_ARGUMENT code", async () => {
    const { akmCurate } = await import("../../../../src/commands/read/curate");
    const { UsageError } = await import("../../../../src/core/errors");
    try {
      await akmCurate({ query: "" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as import("../../../../src/core/errors").UsageError).code).toBe("MISSING_REQUIRED_ARGUMENT");
    }
  });
});
