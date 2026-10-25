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
  test("listConfig omits unconfigured embedding, connections and harnesses", () => {
    const config = listConfig({ configVersion: "0.9.0", semanticSearchMode: "auto" });
    expect(config.embedding).toBeUndefined();
    expect(config.connections).toBeUndefined();
    expect(config.harnesses).toBeUndefined();
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

  test("setConfigValue supports a connection JSON with request fields and per-model settings", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    const connection = {
      endpoint: "https://api.openai.com/v1",
      models: { fast: "gpt-4o-mini", reasoning: { model: "gpt-5", reasoning_effort: "high" } },
      temperature: 0.6,
      max_tokens: 300,
    };
    expect(setConfigValue(base, "connections.fast", JSON.stringify(connection)).connections).toEqual({
      fast: connection,
    });
  });

  test("setConfigValue rejects a connection JSON with no endpoint", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    expect(() => setConfigValue(base, "connections.fast", '{"models":{"fast":"m"}}')).toThrow(/endpoint/);
  });

  test("setConfigValue takes a model alias as a name or as a JSON entry", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    const named = setConfigValue(base, "connections.lab.models.fast", "qwen3-8b");
    expect(named.connections?.lab?.models).toEqual({ fast: "qwen3-8b" });
    const entry = setConfigValue(base, "connections.lab.models.reasoning", '{"model":"glm-5","top_p":0.9}');
    expect(entry.connections?.lab?.models).toEqual({ reasoning: { model: "glm-5", top_p: 0.9 } });
  });

  test("setConfigValue stores a request field on a connection as written", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    const updated = setConfigValue(base, "connections.lab.chat_template_kwargs", '{"enable_thinking":false}');
    expect(updated.connections?.lab?.chat_template_kwargs).toEqual({ enable_thinking: false });
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

  test("setConfigValue sets a harness via JSON", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    const updated = setConfigValue(base, "harnesses.claude-work", '{"platform":"claude","bin":"/opt/claude"}');
    expect(updated.harnesses?.["claude-work"]).toEqual({ platform: "claude", bin: "/opt/claude" });
  });

  test("getConfigValue returns null for unconfigured embedding/connection", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    expect(getConfigValue(base, "embedding")).toBeNull();
    expect(getConfigValue(base, "connections.default")).toBeNull();
  });

  test("getConfigValue returns configured embedding/connection objects", () => {
    const llm = {
      endpoint: "http://localhost:11434/v1",
      models: { fast: "llama3.2" },
      temperature: 0.3,
    };
    const base: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      embedding: {
        endpoint: "https://api.openai.com/v1/embeddings",
        model: "text-embedding-3-small",
      },
      connections: { default: llm },
    };
    expect(getConfigValue(base, "embedding")).toEqual(base.embedding);
    expect(getConfigValue(base, "connections.default")).toEqual(llm);
  });

  test("unsetConfigValue clears embedding and a connection", () => {
    const base: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      embedding: {
        endpoint: "https://api.openai.com/v1/embeddings",
        model: "text-embedding-3-small",
      },
      connections: { default: { endpoint: "http://localhost:11434/v1", models: { fast: "llama3.2" } } },
    };
    const noEmbed = unsetConfigValue(base, "embedding");
    expect(noEmbed.embedding).toBeUndefined();

    const noLlm = unsetConfigValue(base, "connections.default");
    expect(noLlm.connections?.default).toBeUndefined();
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
    const withTimeout = setConfigValue(base, "connections.local.timeoutMs", "5000");
    expect(withTimeout.connections?.local?.timeoutMs).toBe(5000);
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

  test("setConfigValue accepts an embedding dimension above 4096 (the vec-table cap is gone)", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    const updated = setConfigValue(
      base,
      "embedding",
      '{"endpoint":"https://api.openai.com/v1/embeddings","model":"m","dimension":8192}',
    );
    expect(updated.embedding?.dimension).toBe(8192);
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
  const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };

  test("a literal apiKey is refused on every block that has one, pointing at $VAR and credentials.json", () => {
    for (const key of ["connections.fast.apiKey", "embedding.apiKey", "search.curateRerank.apiKey"]) {
      expect(() => setConfigValue(base, key, "sk-test")).toThrow(/use a \$VAR reference.*credentials\.json/);
    }
  });

  test("a $VAR or ${VAR} reference is accepted", () => {
    expect(setConfigValue(base, "connections.local.apiKey", "$LOCAL_API_KEY").connections?.local?.apiKey).toBe(
      "$LOCAL_API_KEY",
    );
    expect(setConfigValue(base, "embedding.apiKey", "${EMBED_KEY}").embedding?.apiKey).toBe("${EMBED_KEY}");
    expect(setConfigValue(base, "search.curateRerank.apiKey", "$RERANK_KEY").search?.curateRerank?.apiKey).toBe(
      "$RERANK_KEY",
    );
  });

  test("a secrets ref is not a key akm reads, so it is refused too", () => {
    expect(() => setConfigValue(base, "connections.lab.apiKey", "${secrets/lab-api-key}")).toThrow(/apiKey cannot be/);
  });

  test("a whole-object set accepts a $VAR apiKey and still refuses a literal", () => {
    const withReference = setConfigValue(
      base,
      "connections.lab",
      JSON.stringify({ endpoint: "https://lab.example/v1", models: { fast: "x" }, apiKey: "$LAB_KEY" }),
    );
    expect(withReference.connections?.lab?.apiKey).toBe("$LAB_KEY");
    for (const [key, value] of [
      ["connections.lab", { endpoint: "https://lab.example/v1", models: { fast: "x" }, apiKey: "sk-literal" }],
      ["connections", { lab: { endpoint: "https://lab.example/v1", apiKey: "sk-literal" } }],
      ["embedding", { endpoint: "https://e.example/v1", apiKey: "sk-literal" }],
    ] as const) {
      expect(() => setConfigValue(base, key, JSON.stringify(value))).toThrow(/apiKey cannot be a literal/);
    }
  });
});

// ── #455: every nested schema key is settable ───────────────────────────────

describe("nested schema keys are all settable via zod walker (#455)", () => {
  test("improve's strategy, connection and harness are settable", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    expect(setConfigValue(base, "improve.strategy", "fast").improve?.strategy).toBe("fast");
    expect(setConfigValue(base, "improve.connection", "lab").improve?.connection).toBe("lab");
    expect(setConfigValue(base, "improve.harness", "claude").improve?.harness).toBe("claude");
  });

  test("search.curateRerank.topN is settable", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    const withTopN = setConfigValue(base, "search.curateRerank.topN", "30");
    expect(withTopN.search?.curateRerank?.topN).toBe(30);
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

  test("a request field and the owned timeout are settable on a connection", () => {
    const base: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "auto" };
    const c1 = setConfigValue(base, "connections.local.temperature", "0.7");
    expect(c1.connections?.local?.temperature).toBe(0.7);
    const c2 = setConfigValue(base, "connections.local.timeoutMs", "30000");
    expect(c2.connections?.local?.timeoutMs).toBe(30000);
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
      // The schema-driven hint must include `connections` and `harnesses`, but not
      // the retired top-level profile vocabulary.
      // Hint may be on .hint() if it's a UsageError; concatenate everything.
      const combined = `${message} ${(err as { hint?: () => string }).hint?.() ?? ""}`;
      expect(combined).toContain("connections");
      expect(combined).toContain("harnesses");
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
