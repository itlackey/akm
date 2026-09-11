import { describe, expect, test } from "bun:test";
import { getConfigValue, listConfig, setConfigValue, unsetConfigValue } from "../src/commands/config-cli";
import type { AkmConfig } from "../src/core/config/config";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";

function captureWarnings(fn: () => void): string[] {
  const warnings: string[] = [];
  _resetWarnOnceForTests();
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
  try {
    fn();
    return warnings;
  } finally {
    _setWarnSinkForTests(undefined);
  }
}

describe("config CLI helpers", () => {
  test("listConfig omits unconfigured embedding and engines", () => {
    const config = listConfig({ configVersion: "0.9.0", semanticSearchMode: "auto" });
    expect(config.embedding).toBeUndefined();
    expect(config.engines).toBeUndefined();
    expect(config.output).toEqual({ format: "json", detail: "brief" });
  });

  // R-063 #5: these used to go through `parseConfigValue`, a compatibility
  // shim (removed — dead code, zero production callers) that just called
  // `setConfigValue` against a sentinel base and diffed out the touched
  // top-level keys. `setConfigValue` is the live implementation backing
  // `akm config set`, so these now call it directly and read back the
  // touched sub-path — same coverage of the config-walker validation rules,
  // no shim in between.
  test("setConfigValue supports output config keys", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    expect(setConfigValue(base, "output.format", "yaml").output).toEqual({ format: "yaml" });
    expect(setConfigValue(base, "output.detail", "full").output).toEqual({ detail: "full" });
  });

  test("setConfigValue supports embedding JSON with dimensions", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    expect(
      setConfigValue(
        base,
        "embedding",
        '{"endpoint":"https://api.openai.com/v1/embeddings","model":"text-embedding-3-small","dimension":384}',
      ).embedding,
    ).toEqual({
      endpoint: "https://api.openai.com/v1/embeddings",
      model: "text-embedding-3-small",
      dimension: 384,
    });
  });

  test("setConfigValue supports an LLM engine JSON with sampling fields", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    expect(
      setConfigValue(
        base,
        "engines.fast",
        '{"kind":"llm","endpoint":"https://api.openai.com/v1/chat/completions","model":"gpt-4o-mini","temperature":0.6,"maxTokens":300}',
      ).engines,
    ).toEqual({
      fast: {
        kind: "llm",
        endpoint: "https://api.openai.com/v1/chat/completions",
        model: "gpt-4o-mini",
        temperature: 0.6,
        maxTokens: 300,
      },
    });
  });

  test("setConfigValue rejects an LLM engine JSON with endpoint and omitted model", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    expect(() =>
      setConfigValue(base, "engines.fast", '{"kind":"llm","endpoint":"http://localhost:11434/v1/chat/completions"}'),
    ).toThrow(/Invalid input/);
  });

  test("setConfigValue warns and stores an unrecognized retired key like sources instead of rejecting it (#37)", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    let result!: ReturnType<typeof setConfigValue>;
    const warnings = captureWarnings(() => {
      result = setConfigValue(base, "sources", '[{"type":"website","url":"https://example.com","writable":true}]');
    });
    expect((result as unknown as Record<string, unknown>).sources).toEqual([
      { type: "website", url: "https://example.com", writable: true },
    ]);
    expect(warnings.some((w) => w.includes("sources") && w.includes("not a known config key"))).toBe(true);
  });

  test("setConfigValue rejects writable non-filesystem bundles through config CLI", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    expect(() =>
      setConfigValue(base, "bundles", '{"w":{"website":{"url":"https://example.com"},"writable":true}}'),
    ).toThrow("writable: true is only supported on path and git bundle sources");
  });

  test("setConfigValue rejects empty and multi-entry component maps", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    expect(() => setConfigValue(base, "bundles", '{"empty":{"path":"/tmp/empty","components":{}}}')).toThrow(
      "a bundle components map must contain exactly one component",
    );
    expect(() =>
      setConfigValue(
        base,
        "bundles",
        '{"multi":{"path":"/tmp/multi","components":{"a":{"root":"a"},"b":{"root":"b"}}}}',
      ),
    ).toThrow("a bundle components map must contain exactly one component");
  });

  test("setConfigValue rejects component-level writable website and npm bundles", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    expect(() =>
      setConfigValue(
        base,
        "bundles",
        '{"web":{"website":{"url":"https://example.com"},"components":{"main":{"writable":true}}}}',
      ),
    ).toThrow("writable: true is only supported on path and git bundle sources");
    expect(() =>
      setConfigValue(base, "bundles", '{"pkg":{"npm":"example-package","components":{"main":{"writable":true}}}}'),
    ).toThrow("writable: true is only supported on path and git bundle sources");
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

  test("setConfigValue warns and stores a key not in the schema instead of rejecting it (#16)", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    let result!: ReturnType<typeof setConfigValue>;
    const warnings = captureWarnings(() => {
      result = setConfigValue(base, "totally.unknown.path", "x");
    });
    expect((result as unknown as { totally?: { unknown?: { path?: string } } }).totally?.unknown?.path).toBe("x");
    expect(warnings.some((w) => w.includes("totally.unknown.path"))).toBe(true);
  });

  test("setConfigValue rejects non-integer embedding dimension in JSON", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    expect(() =>
      setConfigValue(
        base,
        "embedding",
        '{"endpoint":"https://api.openai.com/v1/embeddings","model":"text-embedding-3-small","dimension":384.5}',
      ),
    ).toThrow(/Expected integer/);
  });

  test("setConfigValue rejects an embedding dimension above the vec-table cap (4096)", () => {
    // The index schema's vec-table guard rejects dims outside 1–4096; the
    // config schema must fail the same value at set-time with a clear zod
    // message instead of letting `akm index` crash on it later (§24.2).
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    expect(() =>
      setConfigValue(
        base,
        "embedding",
        '{"endpoint":"https://api.openai.com/v1/embeddings","model":"m","dimension":8192}',
      ),
    ).toThrow(/4096/);
  });

  test("setConfigValue rejects invalid output values", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    expect(() => setConfigValue(base, "output.format", "xml")).toThrow(/Expected 'json' \| 'yaml' \| 'text'/);
    expect(() => setConfigValue(base, "output.detail", "max")).toThrow(/Expected 'brief' \| 'normal' \| 'full'/);
  });

  test("setConfigValue rejects retired boolean semanticSearchMode value 'true'", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    expect(() => setConfigValue(base, "semanticSearchMode", "true")).toThrow(/Invalid value for semanticSearchMode/);
  });

  test("setConfigValue rejects retired boolean semanticSearchMode value 'false'", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    expect(() => setConfigValue(base, "semanticSearchMode", "false")).toThrow(/Invalid value for semanticSearchMode/);
  });

  test("setConfigValue accepts 'auto' for semanticSearchMode", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    const result = setConfigValue(base, "semanticSearchMode", "auto");
    expect(result.semanticSearchMode).toBe("auto");
  });

  test("setConfigValue accepts 'off' for semanticSearchMode", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    const result = setConfigValue(base, "semanticSearchMode", "off");
    expect(result.semanticSearchMode).toBe("off");
  });

  test("setConfigValue rejects invalid semanticSearchMode", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    expect(() => setConfigValue(base, "semanticSearchMode", "yes")).toThrow("Invalid value for semanticSearchMode");
  });
});

// ── #454: apiKey rejection at set time ──────────────────────────────────────

describe("apiKey rejection (#454)", () => {
  test("setConfigValue rejects llm.apiKey and points at AKM_LLM_API_KEY", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    expect(() => setConfigValue(base, "engines.fast.apiKey", "sk-test")).toThrow(/apiKey must be \$VAR/);
  });

  test("setConfigValue accepts symbolic embedding apiKey and rejects literals", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    expect(setConfigValue(base, "embedding.apiKey", "$AKM_EMBED_API_KEY").embedding?.apiKey).toBe("$AKM_EMBED_API_KEY");
    expect(() => setConfigValue(base, "embedding.apiKey", "sk-test")).toThrow(/apiKey must be \$VAR/);
  });

  test("setConfigValue accepts symbolic engine apiKey values only", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    expect(setConfigValue(base, "engines.local.apiKey", "$LOCAL_API_KEY").engines?.local?.apiKey).toBe(
      "$LOCAL_API_KEY",
    );
  });

  test("setConfigValue accepts a secret:// store reference for engine and embedding apiKey", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    expect(setConfigValue(base, "engines.lab.apiKey", "secret://lab-api-key").engines?.lab?.apiKey).toBe(
      "secret://lab-api-key",
    );
    expect(setConfigValue(base, "embedding.apiKey", "secret://embed-key").embedding?.apiKey).toBe("secret://embed-key");
  });

  test("setConfigValue whole-engine-object set accepts a secret:// apiKey and still rejects a literal", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    const withSecretRef = setConfigValue(
      base,
      "engines.lab",
      JSON.stringify({
        kind: "llm",
        endpoint: "https://lab.example/v1/chat/completions",
        model: "x",
        apiKey: "secret://lab-api-key",
      }),
    );
    expect(withSecretRef.engines?.lab?.apiKey).toBe("secret://lab-api-key");
    expect(() =>
      setConfigValue(
        base,
        "engines.lab",
        JSON.stringify({
          kind: "llm",
          endpoint: "https://lab.example/v1/chat/completions",
          model: "x",
          apiKey: "sk-literal",
        }),
      ),
    ).toThrow(/apiKey cannot be persisted/);
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

  test("search.defaultExcludeTypes is settable", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    const withExcludeTypes = setConfigValue(base, "search.defaultExcludeTypes", '["session"]');
    expect(withExcludeTypes.search?.defaultExcludeTypes).toEqual(["session"]);
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
      getConfigValue(base, "totally.unknown.path");
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

// ── Mitigation item 3: actionable "use X instead" hints for retired keys ────

describe("unknown-key hint names a replacement for retired pre-0.9 keys", () => {
  test("config get stashDir points at `akm config path --all` / `akm info`", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    try {
      getConfigValue(base, "stashDir");
      throw new Error("should have thrown");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const combined = `${message} ${(err as { hint?: () => string }).hint?.() ?? ""}`;
      expect(combined).toContain("akm config path --all");
      expect(combined).toContain("akm info");
    }
  });

  test("config get wikiName points at the wiki subsystem's removal and `akm import`", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    try {
      getConfigValue(base, "wikiName");
      throw new Error("should have thrown");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const combined = `${message} ${(err as { hint?: () => string }).hint?.() ?? ""}`;
      expect(combined).toContain("wiki subsystem was removed in 0.9");
      expect(combined).toContain("akm import");
    }
  });
});

// ── #462 (relaxed): unknown fields on sources/registries are tolerated ───────
// The config-wide unknown-key policy is now lenient (passthrough) so cross-
// version config skew never becomes INVALID_CONFIG_FILE. That also relaxes the
// #462 strict typo-catching on source/registry entries: unknown fields are now
// preserved rather than rejected. Known fields are still type-validated.
describe("registries/sources tolerate unknown fields at set time (lenient policy)", () => {
  test("set sources warns and stores instead of rejecting — the key retired with the 0.9.0 bundles cutover (#37/#16)", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    let result!: ReturnType<typeof setConfigValue>;
    const warnings = captureWarnings(() => {
      result = setConfigValue(base, "sources", '[{"type":"git","name":"x","url":"https://example.com/r.git"}]');
    });
    expect((result as unknown as Record<string, unknown>).sources).toEqual([
      { type: "git", name: "x", url: "https://example.com/r.git" },
    ]);
    expect(warnings.some((w) => w.includes("sources"))).toBe(true);
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
