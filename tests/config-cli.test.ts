import { describe, expect, test } from "bun:test";
import {
  getConfigValue,
  listConfig,
  parseConfigValue,
  setConfigValue,
  unsetConfigValue,
} from "../src/commands/config-cli";
import type { AkmConfig } from "../src/core/config/config";

describe("config CLI helpers", () => {
  test("listConfig omits unconfigured embedding and engines", () => {
    const config = listConfig({ configVersion: "0.9.0", semanticSearchMode: "auto" });
    expect(config.embedding).toBeUndefined();
    expect(config.engines).toBeUndefined();
    expect(config.output).toEqual({ format: "json", detail: "brief" });
  });

  test("parseConfigValue supports output config keys", () => {
    expect(parseConfigValue("output.format", "yaml")).toEqual({ output: { format: "yaml" } });
    expect(parseConfigValue("output.detail", "full")).toEqual({ output: { detail: "full" } });
  });

  test("parseConfigValue supports embedding JSON with dimensions", () => {
    expect(
      parseConfigValue(
        "embedding",
        '{"endpoint":"https://api.openai.com/v1/embeddings","model":"text-embedding-3-small","dimension":384}',
      ),
    ).toEqual({
      embedding: {
        endpoint: "https://api.openai.com/v1/embeddings",
        model: "text-embedding-3-small",
        dimension: 384,
      },
    });
  });

  test("parseConfigValue supports an LLM engine JSON with sampling fields", () => {
    expect(
      parseConfigValue(
        "engines.fast",
        '{"kind":"llm","endpoint":"https://api.openai.com/v1/chat/completions","model":"gpt-4o-mini","temperature":0.6,"maxTokens":300}',
      ),
    ).toEqual({
      engines: {
        fast: {
          kind: "llm",
          endpoint: "https://api.openai.com/v1/chat/completions",
          model: "gpt-4o-mini",
          temperature: 0.6,
          maxTokens: 300,
        },
      },
    });
  });

  test("parseConfigValue rejects an LLM engine JSON with endpoint and omitted model", () => {
    expect(() =>
      parseConfigValue("engines.fast", '{"kind":"llm","endpoint":"http://localhost:11434/v1/chat/completions"}'),
    ).toThrow(/Invalid input/);
  });

  test("parseConfigValue rejects writable website sources through config CLI", () => {
    expect(() =>
      parseConfigValue("sources", '[{"type":"website","url":"https://example.com","writable":true}]'),
    ).toThrow("writable: true is only supported on filesystem and git sources");
  });

  test("parseConfigValue rejects writable npm sources through config CLI", () => {
    expect(() => parseConfigValue("sources", '[{"type":"npm","path":"left-pad","writable":true}]')).toThrow(
      "writable: true is only supported on filesystem and git sources",
    );
  });

  test("setConfigValue sets embedding via JSON", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    const updated = setConfigValue(
      base,
      "embedding",
      '{"endpoint":"http://localhost:11434/v1/embeddings","model":"nomic-embed-text"}',
    );
    expect(updated.embedding).toEqual({
      endpoint: "http://localhost:11434/v1/embeddings",
      model: "nomic-embed-text",
    });
  });

  test("setConfigValue sets an LLM engine via JSON", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    const updated = setConfigValue(
      base,
      "engines.local",
      '{"kind":"llm","endpoint":"http://localhost:11434/v1/chat/completions","model":"llama3.2","temperature":0.3}',
    );
    expect(updated.engines?.local).toMatchObject({
      kind: "llm",
      endpoint: "http://localhost:11434/v1/chat/completions",
      model: "llama3.2",
      temperature: 0.3,
    });
  });

  test("getConfigValue returns null for unconfigured embedding/engine", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    expect(getConfigValue(base, "embedding")).toBeNull();
    expect(getConfigValue(base, "engines.default")).toBeNull();
  });

  test("getConfigValue returns configured embedding/engine objects", () => {
    const llm = {
      endpoint: "http://localhost:11434/v1/chat/completions",
      model: "llama3.2",
      temperature: 0.3,
    };
    const base: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      embedding: {
        endpoint: "https://api.openai.com/v1/embeddings",
        model: "text-embedding-3-small",
      },
      engines: { default: { kind: "llm", ...llm } },
      defaults: { llmEngine: "default" },
    };
    expect(getConfigValue(base, "embedding")).toEqual(base.embedding);
    expect(getConfigValue(base, "engines.default")).toEqual({ kind: "llm", ...llm });
  });

  test("unsetConfigValue clears embedding and an engine", () => {
    const base: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      embedding: {
        endpoint: "https://api.openai.com/v1/embeddings",
        model: "text-embedding-3-small",
      },
      engines: { default: { kind: "llm", endpoint: "http://localhost:11434/v1/chat/completions", model: "llama3.2" } },
      defaults: { llmEngine: "default" },
    };
    const noEmbed = unsetConfigValue(base, "embedding");
    expect(noEmbed.embedding).toBeUndefined();

    const noLlm = unsetConfigValue(base, "engines.default");
    expect(noLlm.engines?.default).toBeUndefined();
  });

  test("setConfigValue merges output format and detail", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    const withFormat = setConfigValue(base, "output.format", "text");
    const withDetail = setConfigValue(withFormat, "output.detail", "full");

    expect(withDetail.output).toEqual({ format: "text", detail: "full" });
  });

  test("getConfigValue reads output keys", () => {
    const base: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      output: { format: "yaml", detail: "normal" },
    };
    expect(getConfigValue(base, "output.format")).toBe("yaml");
    expect(getConfigValue(base, "output.detail")).toBe("normal");
  });

  test("unsetConfigValue clears individual output keys", () => {
    const base: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      output: { format: "yaml", detail: "normal" },
    };
    expect(unsetConfigValue(base, "output.format").output).toEqual({ detail: "normal" });
    expect(unsetConfigValue(base, "output.detail").output).toEqual({ format: "yaml" });
  });

  test("setConfigValue accepts previously hand-listed sub-keys now that the schema is the source of truth (#455)", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    const withProvider = setConfigValue(base, "embedding.provider", "ollama");
    expect(withProvider.embedding?.provider).toBe("ollama");
    const withTemp = setConfigValue(base, "engines.local.temperature", "0.5");
    expect(withTemp.engines?.local?.temperature).toBe(0.5);
  });

  test("setConfigValue rejects keys not in the schema", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    expect(() => setConfigValue(base, "totally.unknown.path", "x")).toThrow("Unknown config key");
  });

  test("parseConfigValue rejects non-integer embedding dimension in JSON", () => {
    expect(() =>
      parseConfigValue(
        "embedding",
        '{"endpoint":"https://api.openai.com/v1/embeddings","model":"text-embedding-3-small","dimension":384.5}',
      ),
    ).toThrow(/Expected integer/);
  });

  test("parseConfigValue rejects invalid output values", () => {
    expect(() => parseConfigValue("output.format", "xml")).toThrow(/Expected 'json' \| 'yaml' \| 'text'/);
    expect(() => parseConfigValue("output.detail", "max")).toThrow(/Expected 'brief' \| 'normal' \| 'full'/);
  });

  test("parseConfigValue rejects retired boolean semanticSearchMode values", () => {
    expect(() => parseConfigValue("semanticSearchMode", "true")).toThrow(/Invalid value for semanticSearchMode/);
  });

  test("parseConfigValue rejects retired boolean semanticSearchMode values", () => {
    expect(() => parseConfigValue("semanticSearchMode", "false")).toThrow(/Invalid value for semanticSearchMode/);
  });

  test("parseConfigValue accepts 'auto' for semanticSearchMode", () => {
    const result = parseConfigValue("semanticSearchMode", "auto");
    expect(result).toEqual({ semanticSearchMode: "auto" });
  });

  test("parseConfigValue accepts 'off' for semanticSearchMode", () => {
    const result = parseConfigValue("semanticSearchMode", "off");
    expect(result).toEqual({ semanticSearchMode: "off" });
  });

  test("parseConfigValue rejects invalid semanticSearchMode", () => {
    expect(() => parseConfigValue("semanticSearchMode", "yes")).toThrow("Invalid value for semanticSearchMode");
  });
});

// ── #454: apiKey rejection at set time ──────────────────────────────────────

describe("apiKey rejection (#454)", () => {
  test("setConfigValue rejects llm.apiKey and points at AKM_LLM_API_KEY", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    expect(() => setConfigValue(base, "engines.fast.apiKey", "sk-test")).toThrow(/apiKey must be \$VAR/);
  });

  test("setConfigValue rejects embedding.apiKey and points at AKM_EMBED_API_KEY", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    expect(() => setConfigValue(base, "embedding.apiKey", "sk-test")).toThrow(/AKM_EMBED_API_KEY/);
  });

  test("setConfigValue accepts symbolic engine apiKey values only", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    expect(setConfigValue(base, "engines.local.apiKey", "$LOCAL_API_KEY").engines?.local?.apiKey).toBe(
      "$LOCAL_API_KEY",
    );
  });
});

// ── #455: every nested schema key is settable ───────────────────────────────

describe("nested schema keys are all settable via zod walker (#455)", () => {
  test("canonical defaults are settable", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    const withAgent = setConfigValue(base, "defaults.engine", "claude");
    expect(withAgent.defaults?.engine).toBe("claude");
    const withImprove = setConfigValue(base, "defaults.improveStrategy", "fast");
    expect(withImprove.defaults?.improveStrategy).toBe("fast");
  });

  test("search.minScore is settable", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    const withMinScore = setConfigValue(base, "search.minScore", "0.42");
    expect(withMinScore.search?.minScore).toBe(0.42);
  });

  test("feedback.requireReason / archiveRetentionDays / improve.eventRetentionDays settable", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    const a = setConfigValue(base, "feedback.requireReason", "false");
    expect(a.feedback?.requireReason).toBe(false);
    const b = setConfigValue(base, "archiveRetentionDays", "90");
    expect(b.archiveRetentionDays).toBe(90);
    const c = setConfigValue(base, "improve.eventRetentionDays", "180");
    expect(c.improve?.eventRetentionDays).toBe(180);
  });

  test("LLM engine invocation fields are settable", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    const c1 = setConfigValue(base, "engines.local.temperature", "0.7");
    expect(c1.engines?.local?.temperature).toBe(0.7);
    const c2 = setConfigValue(base, "engines.local.timeoutMs", "30000");
    expect(c2.engines?.local?.timeoutMs).toBe(30000);
  });
});

// ── #460: unknown-key hint references current schema (no legacy `agent`) ────

describe("unknown-key hint stays in sync with schema (#460)", () => {
  test("unknown top-level key error lists schema-derived keys and does not mention retired profiles", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    try {
      setConfigValue(base, "totally.unknown.path", "x");
      throw new Error("should have thrown");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The schema-driven hint must include `defaults` and `engines`, but not
      // the retired top-level profile vocabulary.
      // Hint may be on .hint() if it's a UsageError; concatenate everything.
      const combined = `${message} ${(err as { hint?: () => string }).hint?.() ?? ""}`;
      expect(combined).toContain("defaults");
      expect(combined).toContain("engines");
      expect(combined).not.toContain("profiles");
    }
  });
});

// ── #462 (relaxed): unknown fields on sources/registries are tolerated ───────
// The config-wide unknown-key policy is now lenient (passthrough) so cross-
// version config skew never becomes INVALID_CONFIG_FILE. That also relaxes the
// #462 strict typo-catching on source/registry entries: unknown fields are now
// preserved rather than rejected. Known fields are still type-validated.
describe("registries/sources tolerate unknown fields at set time (lenient policy)", () => {
  test("set sources tolerates and preserves an unknown field on a source entry", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    const updated = setConfigValue(
      base,
      "sources",
      '[{"type":"git","name":"x","url":"https://example.com/r.git","secret":"oops"}]',
    );
    const src = (updated.sources?.[0] ?? {}) as Record<string, unknown>;
    expect(src.name).toBe("x");
    expect(src.secret).toBe("oops"); // preserved, not rejected
  });

  test("set registries tolerates and preserves an unknown field on a registry entry", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    const updated = setConfigValue(
      base,
      "registries",
      '[{"name":"x","url":"https://example.com/r.json","secret":"oops"}]',
    );
    const reg = (updated.registries?.[0] ?? {}) as Record<string, unknown>;
    expect(reg.name).toBe("x");
    expect(reg.secret).toBe("oops");
  });
});

// ── #464.b: semanticSearchMode can be unset ─────────────────────────────────

describe("semanticSearchMode is unsettable (#464.b)", () => {
  test("unsetConfigValue removes semanticSearchMode entirely (falls back to DEFAULT_CONFIG at load)", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "off" };
    const cleared = unsetConfigValue(base, "semanticSearchMode");
    expect(cleared.semanticSearchMode).toBeUndefined();
  });
});
