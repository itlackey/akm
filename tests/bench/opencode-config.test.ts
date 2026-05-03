/**
 * Tests for the bench opencode-config module.
 *
 * Covers all cases described in the design spec:
 *   - loads canonical fixture without error
 *   - rejects literal apiKey (not env-ref)
 *   - accepts {env:VAR} apiKey form
 *   - rejects sk-XXXX credential heuristic anywhere in tree
 *   - rejects top-level plugin / mcp / permission keys
 *   - rejects unknown schemaVersion
 *   - isUsageError: true when file missing
 *   - selectProviderForModel picks correct provider
 *   - selectProviderForModel throws on unknown provider prefix
 *   - materializeOpencodeConfig writes exactly $schema + provider keys, mode 0o600
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import {
  BenchConfigError,
  loadOpencodeProviders,
  materializeOpencodeConfig,
  selectProviderForModel,
} from "./opencode-config";
import { benchMkdtemp } from "./tmp";

/** Absolute path to the committed fixture. */
const FIXTURE_PATH = path.resolve(__dirname, "..", "fixtures", "bench", "opencode-providers.json");

/** Write a temp JSON file and return its path. */
function writeTmp(dir: string, name: string, content: unknown): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(content));
  return p;
}

describe("loadOpencodeProviders", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = benchMkdtemp("bench-opencode-config-test-");
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ── Canonical fixture ─────────────────────────────────────────────────────

  test("loads the canonical committed fixture without error", () => {
    expect(() => loadOpencodeProviders(FIXTURE_PATH)).not.toThrow();
    const loaded = loadOpencodeProviders(FIXTURE_PATH);
    expect(loaded.source).toBe(FIXTURE_PATH);
    expect(loaded.providers).toBeDefined();
    expect(typeof loaded.providers).toBe("object");
    expect(loaded.defaultModel).toBe("shredder/qwen/qwen3.5-9b");
    expect("shredder" in loaded.providers).toBe(true);
  });

  // ── File not found ────────────────────────────────────────────────────────

  test("throws BenchConfigError with isUsageError: true when file does not exist", () => {
    const missing = path.join(tmp, "does-not-exist.json");
    let err: unknown;
    try {
      loadOpencodeProviders(missing);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BenchConfigError);
    const bce = err as BenchConfigError;
    expect(bce.code).toBe("BENCH_CONFIG");
    expect(bce.isUsageError).toBe(true);
    expect(bce.message).toContain("not found");
  });

  // ── JSON parse failure ────────────────────────────────────────────────────

  test("throws BenchConfigError with isUsageError: false on malformed JSON", () => {
    const p = path.join(tmp, "bad.json");
    fs.writeFileSync(p, "{ this is not json }");
    let err: unknown;
    try {
      loadOpencodeProviders(p);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BenchConfigError);
    expect((err as BenchConfigError).isUsageError).toBe(false);
    expect((err as BenchConfigError).message).toContain("JSON parse error");
  });

  // ── schemaVersion ─────────────────────────────────────────────────────────

  test("rejects unknown schemaVersion", () => {
    const p = writeTmp(tmp, "bad-version.json", {
      schemaVersion: 2,
      providers: {},
    });
    expect(() => loadOpencodeProviders(p)).toThrow(BenchConfigError);
    let err: BenchConfigError | undefined;
    try {
      loadOpencodeProviders(p);
    } catch (e) {
      if (e instanceof BenchConfigError) err = e;
    }
    expect(err?.isUsageError).toBe(false);
    expect(err?.message).toContain("schemaVersion");
  });

  test("rejects schemaVersion: 0", () => {
    const p = writeTmp(tmp, "version-0.json", { schemaVersion: 0, providers: {} });
    expect(() => loadOpencodeProviders(p)).toThrow(BenchConfigError);
  });

  // ── Forbidden top-level keys ──────────────────────────────────────────────

  test("rejects top-level 'plugin' key", () => {
    const p = writeTmp(tmp, "has-plugin.json", {
      schemaVersion: 1,
      providers: {},
      plugin: [],
    });
    let err: BenchConfigError | undefined;
    try {
      loadOpencodeProviders(p);
    } catch (e) {
      if (e instanceof BenchConfigError) err = e;
    }
    expect(err).toBeDefined();
    expect(err?.isUsageError).toBe(false);
    expect(err?.message).toContain("plugin");
  });

  test("rejects top-level 'mcp' key", () => {
    const p = writeTmp(tmp, "has-mcp.json", {
      schemaVersion: 1,
      providers: {},
      mcp: {},
    });
    expect(() => loadOpencodeProviders(p)).toThrow(BenchConfigError);
  });

  test("rejects top-level 'permission' key", () => {
    const p = writeTmp(tmp, "has-permission.json", {
      schemaVersion: 1,
      providers: {},
      permission: {},
    });
    expect(() => loadOpencodeProviders(p)).toThrow(BenchConfigError);
  });

  test("rejects top-level 'disabled_providers' key", () => {
    const p = writeTmp(tmp, "has-disabled.json", {
      schemaVersion: 1,
      providers: {},
      disabled_providers: [],
    });
    expect(() => loadOpencodeProviders(p)).toThrow(BenchConfigError);
  });

  test("rejects top-level 'small_model' key", () => {
    const p = writeTmp(tmp, "has-small-model.json", {
      schemaVersion: 1,
      providers: {},
      small_model: "anthropic/claude-haiku-4-5",
    });
    expect(() => loadOpencodeProviders(p)).toThrow(BenchConfigError);
  });

  test("rejects top-level 'snapshot' key", () => {
    const p = writeTmp(tmp, "has-snapshot.json", {
      schemaVersion: 1,
      providers: {},
      snapshot: true,
    });
    expect(() => loadOpencodeProviders(p)).toThrow(BenchConfigError);
  });

  // ── apiKey validation ─────────────────────────────────────────────────────

  test("rejects literal apiKey string (not an env-ref)", () => {
    const p = writeTmp(tmp, "literal-apikey.json", {
      schemaVersion: 1,
      providers: {
        myProvider: {
          apiKey: "not-an-env-ref",
        },
      },
    });
    let err: BenchConfigError | undefined;
    try {
      loadOpencodeProviders(p);
    } catch (e) {
      if (e instanceof BenchConfigError) err = e;
    }
    expect(err).toBeDefined();
    expect(err?.isUsageError).toBe(false);
    expect(err?.message).toContain("apiKey");
    expect(err?.message).toContain("env-ref");
  });

  test("accepts {env:VAR} form for apiKey", () => {
    const p = writeTmp(tmp, "env-ref-apikey.json", {
      schemaVersion: 1,
      providers: {
        myProvider: {
          npm: "@ai-sdk/openai-compatible",
          apiKey: "{env:MY_API_KEY}",
          options: { baseURL: "http://localhost:1234/v1" },
        },
      },
    });
    expect(() => loadOpencodeProviders(p)).not.toThrow();
    const loaded = loadOpencodeProviders(p);
    expect("myProvider" in loaded.providers).toBe(true);
  });

  test("accepts {env:UNDERSCORE_KEY_123} env-ref form", () => {
    const p = writeTmp(tmp, "env-ref-underscore.json", {
      schemaVersion: 1,
      providers: {
        p: { apiKey: "{env:MY_KEY_123}" },
      },
    });
    expect(() => loadOpencodeProviders(p)).not.toThrow();
  });

  test("rejects apiKey starting with lowercase (not a valid env-ref)", () => {
    const p = writeTmp(tmp, "bad-env-ref.json", {
      schemaVersion: 1,
      providers: {
        p: { apiKey: "{env:my_lowercase_key}" },
      },
    });
    expect(() => loadOpencodeProviders(p)).toThrow(BenchConfigError);
  });

  // ── Credential heuristic ──────────────────────────────────────────────────

  test("rejects sk-XXXX credential anywhere in the providers tree", () => {
    const p = writeTmp(tmp, "has-sk-key.json", {
      schemaVersion: 1,
      providers: {
        openai: {
          npm: "@ai-sdk/openai",
          secret: "sk-abcdefghijklmnopqrstuvwxyz0123456789",
        },
      },
    });
    let err: BenchConfigError | undefined;
    try {
      loadOpencodeProviders(p);
    } catch (e) {
      if (e instanceof BenchConfigError) err = e;
    }
    expect(err).toBeDefined();
    expect(err?.isUsageError).toBe(false);
    expect(err?.message).toContain("credential heuristic");
  });

  test("rejects sk-XXXX credential in a nested object", () => {
    const p = writeTmp(tmp, "nested-sk-key.json", {
      schemaVersion: 1,
      providers: {
        p: {
          options: {
            headers: {
              Authorization: "sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
          },
        },
      },
    });
    expect(() => loadOpencodeProviders(p)).toThrow(BenchConfigError);
  });

  // ── Valid minimal file ────────────────────────────────────────────────────

  test("accepts a valid minimal file with no defaultModel", () => {
    const p = writeTmp(tmp, "minimal.json", {
      schemaVersion: 1,
      providers: {
        local: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://localhost:1234/v1" },
        },
      },
    });
    const loaded = loadOpencodeProviders(p);
    expect(loaded.defaultModel).toBeUndefined();
    expect("local" in loaded.providers).toBe(true);
  });
});

describe("selectProviderForModel", () => {
  const loaded = {
    source: "/fake/path.json",
    providers: {
      don: { npm: "@ai-sdk/openai-compatible", name: "Don LM Studio" },
      ollama: { npm: "@ai-sdk/openai-compatible", name: "Ollama" },
    },
    defaultModel: "don/mlx-community/qwen3.6-35b-a3b",
  };

  test("splits on first slash and returns the correct provider entry", () => {
    const result = selectProviderForModel(loaded, "don/mlx-community/qwen3.6-35b-a3b");
    expect(result.providerKey).toBe("don");
    expect(result.entry).toBe(loaded.providers.don);
  });

  test("handles a model with no slash (entire string is the provider key)", () => {
    const result = selectProviderForModel(loaded, "ollama");
    expect(result.providerKey).toBe("ollama");
    expect(result.entry).toBe(loaded.providers.ollama);
  });

  test("throws BenchConfigError when provider key is not in loaded.providers", () => {
    let err: BenchConfigError | undefined;
    try {
      selectProviderForModel(loaded, "unknown/some-model");
    } catch (e) {
      if (e instanceof BenchConfigError) err = e;
    }
    expect(err).toBeDefined();
    expect(err?.code).toBe("BENCH_CONFIG");
    expect(err?.isUsageError).toBe(false);
    expect(err?.message).toContain("unknown");
    expect(err?.message).toContain("provider key");
  });

  test("error message lists available provider keys", () => {
    let err: BenchConfigError | undefined;
    try {
      selectProviderForModel(loaded, "missing/model");
    } catch (e) {
      if (e instanceof BenchConfigError) err = e;
    }
    expect(err?.message).toContain("don");
    expect(err?.message).toContain("ollama");
  });
});

describe("materializeOpencodeConfig", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = benchMkdtemp("bench-materialize-test-");
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("writes opencode.json with required bench isolation invariants and provider", () => {
    const configDir = path.join(tmp, "run-config");
    fs.mkdirSync(configDir, { recursive: true });

    const entry = { npm: "@ai-sdk/openai-compatible", name: "Test Provider" };
    materializeOpencodeConfig(configDir, { providerKey: "test", entry }, "test/my-model");

    const outPath = path.join(configDir, "opencode.json");
    expect(fs.existsSync(outPath)).toBe(true);

    const contents = JSON.parse(fs.readFileSync(outPath, "utf8")) as Record<string, unknown>;
    expect(contents.model).toBe("test/my-model");
    expect(contents.$schema).toBe("https://opencode.ai/config.json");
    // Bench isolation invariants: plugin:[] prevents operator plugin interference;
    // permission block ensures opencode run (non-interactive) allows bash/file tools.
    expect(contents.plugin).toEqual([]);
    expect((contents.permission as Record<string, unknown>)?.bash).toBe("allow");
    // Provider block is written correctly.
    const provider = contents.provider as Record<string, unknown>;
    expect(Object.keys(provider)).toEqual(["test"]);
    expect(provider.test).toEqual(entry);
  });

  test("does not write mcp into the config", () => {
    const configDir = path.join(tmp, "run-config-2");
    fs.mkdirSync(configDir, { recursive: true });

    materializeOpencodeConfig(configDir, { providerKey: "p", entry: {} }, "p/model");

    const contents = JSON.parse(fs.readFileSync(path.join(configDir, "opencode.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(contents.mcp).toBeUndefined();
  });

  test("writes the file with mode 0o600 (not world-readable)", () => {
    const configDir = path.join(tmp, "run-config-3");
    fs.mkdirSync(configDir, { recursive: true });

    materializeOpencodeConfig(configDir, { providerKey: "p", entry: {} }, "p/model");

    const stat = fs.statSync(path.join(configDir, "opencode.json"));
    // Mode 0o600 means only owner can read/write (no group or other bits).
    // On Linux/macOS the lower 9 bits are 0o600 = 0o110000000 in binary.
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("can be called twice (overwrites an existing opencode.json)", () => {
    const configDir = path.join(tmp, "run-config-4");
    fs.mkdirSync(configDir, { recursive: true });

    materializeOpencodeConfig(configDir, { providerKey: "a", entry: { name: "first" } }, "a/m1");
    materializeOpencodeConfig(configDir, { providerKey: "b", entry: { name: "second" } }, "b/m2");

    const contents = JSON.parse(fs.readFileSync(path.join(configDir, "opencode.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const provider = contents.provider as Record<string, unknown>;
    expect("b" in provider).toBe(true);
    expect("a" in provider).toBe(false);
  });
});
