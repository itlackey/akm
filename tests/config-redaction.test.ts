import { afterAll, afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConfigValue, listConfig, redactSecretKeys } from "../src/commands/config";
import { resolveImproveExecution } from "../src/commands/improve/execution";
import type { AkmConfig } from "../src/core/config/config";
import { loadUserConfig, resetConfigCache, saveConfig, unknownConfigKeyPaths } from "../src/core/config/config";
import { configGet } from "../src/core/config/config-walker";
import { getConfigPath } from "../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { config as workspaceConfig } from "../src/workspace";
import { runCliCapture } from "./_helpers/cli";
import { asLlmRunner } from "./_helpers/llm-runner";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  withEnv,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "./_helpers/sandbox";

describe("config-cli-redaction", () => {
  const disposers: SandboxedDir[] = [];

  function makeTempDir(): string {
    const d = makeSandboxDir("akm-config-redaction-");
    disposers.push(d);
    return d.dir;
  }

  function freshEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    return {
      HOME: makeTempDir(),
      XDG_CONFIG_HOME: makeTempDir(),
      XDG_CACHE_HOME: makeTempDir(),
      XDG_DATA_HOME: makeTempDir(),
      XDG_STATE_HOME: makeTempDir(),
      ...overrides,
    };
  }

  afterAll(() => {
    for (const d of disposers) d.cleanup();
    disposers.length = 0;
  });

  describe("config command apiKey redaction", () => {
    test("config list/get show symbolic refs but never env-sourced values", async () => {
      const secretLlm = "sk-llm-secret-123";
      const secretEmbed = "sk-embed-secret-456";
      const env = freshEnv({ AKM_LLM_API_KEY: secretLlm, AKM_EMBED_API_KEY: secretEmbed });

      const outputs = await withEnv(env, async () => {
        writeSandboxConfig({
          semanticSearchMode: "off",
          embedding: {
            endpoint: "https://emb.example.test/v1/embeddings",
            model: "embed-model",
            apiKey: "$AKM_EMBED_API_KEY",
          },
          connections: {
            default: {
              endpoint: "https://llm.example.test/v1",
              models: { fast: "chat-model" },
              apiKey: "$AKM_LLM_API_KEY",
            },
          },
        });

        const list = await runCliCapture(["config", "list"]);
        const embedding = await runCliCapture(["config", "get", "embedding"]);
        const llm = await runCliCapture(["config", "get", "connections.default"]);
        const engines = await runCliCapture(["config", "get", "connections"]);
        const llmApiKey = await runCliCapture(["config", "get", "connections.default.apiKey"]);

        return { list, embedding, llm, engines, llmApiKey };
      });

      for (const result of Object.values(outputs)) {
        expect(result.code).toBe(0);
        expect(result.stdout).not.toContain(secretLlm);
        expect(result.stdout).not.toContain(secretEmbed);
      }

      const list = JSON.parse(outputs.list.stdout) as Record<string, unknown>;
      const embedding = JSON.parse(outputs.embedding.stdout) as Record<string, unknown>;
      const llm = JSON.parse(outputs.llm.stdout) as Record<string, unknown>;
      const engines = JSON.parse(outputs.engines.stdout) as Record<string, unknown>;
      const llmApiKey = JSON.parse(outputs.llmApiKey.stdout);

      expect(JSON.stringify(list)).toContain("$AKM_LLM_API_KEY");
      expect(JSON.stringify(list)).toContain("$AKM_EMBED_API_KEY");
      expect(embedding.apiKey).toBe("$AKM_EMBED_API_KEY");
      expect(llm.apiKey).toBe("$AKM_LLM_API_KEY");
      expect(JSON.stringify(engines)).toContain("$AKM_LLM_API_KEY");
      expect(llmApiKey).toBe("$AKM_LLM_API_KEY");
    });
  });

  // ── `config get --show-source` ────────────────────────────────────────

  describe("config get --show-source", () => {
    test("reports local and default sources", async () => {
      const env = freshEnv();

      const outputs = await withEnv(env, async () => {
        writeSandboxConfig({ semanticSearchMode: "auto" });

        const local = await runCliCapture(["config", "get", "semanticSearchMode", "--show-source"]);
        const fallback = await runCliCapture(["config", "get", "output.format", "--show-source"]);
        return { local, fallback };
      });

      for (const result of Object.values(outputs)) expect(result.code).toBe(0);

      expect(JSON.parse(outputs.local.stdout)).toMatchObject({ value: "auto", source: "local" });
      expect(JSON.parse(outputs.fallback.stdout)).toMatchObject({ value: "json", source: "default" });
    });

    test("omitting --show-source keeps the bare value shape", async () => {
      const env = freshEnv();
      const result = await withEnv(env, async () => {
        writeSandboxConfig({ semanticSearchMode: "auto" });
        return runCliCapture(["config", "get", "semanticSearchMode"]);
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toBe("auto");
    });
  });

  // ── `config diff` ─────────────────────────────────────────────────────

  describe("config diff", () => {
    test("lists differing leaves, with a literal apiKey on either side never read, never shown", async () => {
      const env = freshEnv();

      const outputs = await withEnv(env, async () => {
        const configDir = path.join(env.XDG_CONFIG_HOME as string, "akm");
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(
          path.join(configDir, "other.json"),
          JSON.stringify({
            connections: {
              fast: {
                endpoint: "https://api.example.test/v1",
                models: { fast: "other-model" },
                apiKey: "sk-literal-secret-other",
              },
            },
          }),
        );
        writeSandboxConfig({
          connections: {
            fast: {
              endpoint: "https://api.example.test/v1",
              models: { fast: "local-model" },
              apiKey: "sk-literal-secret-local",
            },
          },
        });

        return runCliCapture(["config", "diff", path.join(configDir, "other.json")]);
      });

      expect(outputs.code).toBe(0);
      expect(outputs.stdout).not.toContain("sk-literal-secret-local");
      expect(outputs.stdout).not.toContain("sk-literal-secret-other");

      const parsed = JSON.parse(outputs.stdout) as { rows: Array<{ path: string; local: unknown; other: unknown }> };
      const modelRow = parsed.rows.find((row) => row.path === "connections.fast.models.fast");
      expect(modelRow).toEqual({ path: "connections.fast.models.fast", local: "local-model", other: "other-model" });
      // A literal apiKey is read as absent on both sides, so it never appears as its own diff row.
      expect(parsed.rows.some((row) => row.path === "connections.fast.apiKey")).toBe(false);
      expect(parsed.rows).toEqual(parsed.rows.slice().sort((a, b) => a.path.localeCompare(b.path)));
    });

    test("a file that does not exist is an error naming it", async () => {
      const env = freshEnv();

      const result = await withEnv(env, async () => {
        writeSandboxConfig({});
        return runCliCapture(["config", "diff", path.join(env.XDG_CONFIG_HOME as string, "akm", "missing.json")]);
      });

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("missing.json");
    });

    test("identical configs produce empty rows", async () => {
      const env = freshEnv();

      const outputs = await withEnv(env, async () => {
        const configDir = path.join(env.XDG_CONFIG_HOME as string, "akm");
        fs.mkdirSync(configDir, { recursive: true });
        const shared = { semanticSearchMode: "auto" as const };
        fs.writeFileSync(path.join(configDir, "same.json"), JSON.stringify(shared));
        writeSandboxConfig(shared);

        return runCliCapture(["config", "diff", path.join(configDir, "same.json")]);
      });

      expect(outputs.code).toBe(0);
      const parsed = JSON.parse(outputs.stdout) as { rows: unknown[] };
      expect(parsed.rows).toEqual([]);
    });

    test("diff --detail normal carries rows without a results alias", async () => {
      const env = freshEnv();

      const outputs = await withEnv(env, async () => {
        const configDir = path.join(env.XDG_CONFIG_HOME as string, "akm");
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(path.join(configDir, "other.json"), JSON.stringify({ semanticSearchMode: "auto" }));
        writeSandboxConfig({ semanticSearchMode: "off" });

        return runCliCapture(["config", "diff", path.join(configDir, "other.json"), "--detail", "normal"]);
      });

      expect(outputs.code).toBe(0);
      const parsed = JSON.parse(outputs.stdout) as { rows: unknown[]; results?: unknown };
      expect(parsed.rows.length).toBeGreaterThan(0);
      expect(parsed).not.toHaveProperty("results");
    });
  });
});

describe("config-sanitize-secrets", () => {
  // Regression suite for #474 — `akm setup --from --yes` silently stripped API
  // keys. A `$VAR` / `${VAR}` reference is not a secret and is kept; so is a key
  // the user left in the file: it is warned about once, never read or sent, and
  // only `akm migrate apply` moves it.

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

  let storage: IsolatedAkmStorage;
  let stashDir = "";
  let configDir = "";

  function makeConfig(partial: Partial<AkmConfig>): AkmConfig {
    return {
      bundles: { stash: { path: stashDir, writable: true } } as AkmConfig["bundles"],
      defaultBundle: "stash",
      semanticSearchMode: "off",
      ...partial,
    } as AkmConfig;
  }

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    stashDir = storage.stashDir;
    configDir = path.join(storage.configDir, "akm");
  });

  afterEach(() => {
    storage.cleanup();
  });

  describe("config writes — secret handling (#474)", () => {
    it("keeps a literal embedding.apiKey as written, warning that it is never read", () => {
      const warnings = captureWarnings(() => {
        saveConfig(
          makeConfig({
            embedding: {
              endpoint: "https://example.com",
              model: "text-embedding-3-small",
              apiKey: "sk-LITERAL-SECRET",
            },
          }),
        );
      });
      const persisted = fs.readFileSync(path.join(configDir, "config.json"), "utf8");
      expect(persisted).toContain("sk-LITERAL-SECRET");
      expect(warnings.some((w) => w.includes("literal apiKey"))).toBe(true);
      expect(warnings.join("\n")).not.toContain("sk-LITERAL-SECRET");
    });

    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env-var reference syntax under test
    it("preserves ${VAR} embedding.apiKey reference", () => {
      saveConfig(
        makeConfig({
          embedding: {
            endpoint: "https://example.com",
            model: "text-embedding-3-small",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env-var reference under test
            apiKey: "${OPENAI_API_KEY}",
          },
        }),
      );
      const persisted = fs.readFileSync(path.join(configDir, "config.json"), "utf8");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env-var reference under test
      expect(persisted).toContain("${OPENAI_API_KEY}");
    });

    it("keeps a secrets ref as written, with a notice that names akm migrate apply", () => {
      const warnings = captureWarnings(() => {
        saveConfig(
          makeConfig({
            embedding: {
              endpoint: "https://example.com",
              model: "x",
              // biome-ignore lint/suspicious/noTemplateCurlyInString: literal secret reference under test
              apiKey: "${secrets/embed-key}",
            },
          }),
        );
      });
      const persisted = fs.readFileSync(path.join(configDir, "config.json"), "utf8");
      expect(persisted).toContain("embed-key");
      expect(warnings.some((w) => w.includes("secret-store reference") && w.includes("akm migrate apply"))).toBe(true);
    });

    it("preserves $VAR (no braces) reference", () => {
      saveConfig(
        makeConfig({
          embedding: {
            endpoint: "https://example.com",
            model: "x",
            apiKey: "$OPENAI_API_KEY",
          },
        }),
      );
      const persisted = fs.readFileSync(path.join(configDir, "config.json"), "utf8");
      expect(persisted).toContain("$OPENAI_API_KEY");
    });

    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env-var reference syntax under test
    it("treats unsupported ${VAR:-default} syntax as a literal key: kept, never read", () => {
      const warnings = captureWarnings(() => {
        saveConfig(
          makeConfig({
            embedding: {
              endpoint: "https://example.com",
              model: "x",
              // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env-var reference under test
              apiKey: "${OPENAI_API_KEY:-fallback}",
            },
          }),
        );
      });
      const persisted = fs.readFileSync(path.join(configDir, "config.json"), "utf8");
      expect(persisted).toContain("OPENAI_API_KEY:-fallback");
      expect(warnings.some((w) => w.includes("apiKey"))).toBe(true);
    });

    it("keeps a literal connection apiKey and preserves references across connections", () => {
      const warnings = captureWarnings(() => {
        saveConfig(
          makeConfig({
            connections: {
              openai: {
                endpoint: "https://api.openai.com/v1",
                models: { fast: "gpt-4" },
                apiKey: "sk-openai-literal",
              },
            },
          }),
        );
      });
      let persisted = fs.readFileSync(path.join(configDir, "config.json"), "utf8");
      expect(persisted).toContain("sk-openai-literal");
      expect(warnings.some((w) => w.includes("literal apiKey"))).toBe(true);

      saveConfig(
        makeConfig({
          connections: {
            openai: { endpoint: "https://api.openai.com/v1", models: { fast: "gpt-4" }, apiKey: "$OPENAI_API_KEY" },
            anthropic: {
              endpoint: "https://api.anthropic.com/v1",
              models: { fast: "claude-opus-4-7" },
              // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env-var reference under test
              apiKey: "${ANTHROPIC_API_KEY}",
            },
          },
        }),
      );
      persisted = fs.readFileSync(path.join(configDir, "config.json"), "utf8");
      expect(persisted).toContain("$OPENAI_API_KEY");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env-var reference under test
      expect(persisted).toContain("${ANTHROPIC_API_KEY}");
    });
  });
});

describe("config-retired-keys-and-redaction", () => {
  /**
   * Settings that said one thing and did another: `improve.model/timeoutMs` named, the inert `index` section and the
   * keys with no reader gone, a retired `engine` named honestly, and the redaction of secret-shaped connection fields.
   */

  beforeEach(() => resetConfigCache());
  afterEach(() => resetConfigCache());

  function writeConfig(value: unknown): void {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(value));
  }

  function loadWarnings(): string[] {
    const warnings: string[] = [];
    _resetWarnOnceForTests();
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    try {
      loadUserConfig();
    } finally {
      _setWarnSinkForTests(undefined);
    }
    return warnings;
  }

  const CONNECTIONS = {
    default: { endpoint: "http://lab:1/v1", models: { fast: "m-fast", big: "m-big" } },
    cloud: { endpoint: "http://cloud:1/v1", models: { fast: "c-fast" } },
  };

  describe("improve.model and improve.timeoutMs are named keys", () => {
    test("they load with no unknown-key warning and read back through config get", () => {
      writeConfig({
        connections: CONNECTIONS,
        improve: { model: "big", timeoutMs: 90_000 },
      });
      expect(loadWarnings().filter((w) => w.includes("Unknown config key"))).toEqual([]);
      const config = loadUserConfig();
      expect(configGet(config as never, "improve.model")).toBe("big");
      expect(configGet(config as never, "improve.timeoutMs")).toBe(90_000);
    });

    test("improve.* is the base every model-work call starts from, and a process entry is nearer", () => {
      writeConfig({
        connections: CONNECTIONS,
        improve: {
          connection: "cloud",
          model: "c-fast",
          timeoutMs: 90_000,
          processes: { reflect: { timeoutMs: 5_000 } },
        },
      });
      const config = loadUserConfig();
      const enrich = asLlmRunner(
        resolveImproveExecution({ config, processName: "remember-enrich", alias: "fast" })?.runner,
      );
      expect(enrich).toMatchObject({ model: "c-fast", timeoutMs: 90_000 });
      const reflect = asLlmRunner(resolveImproveExecution({ config, processName: "reflect", alias: "fast" })?.runner);
      expect(reflect.timeoutMs).toBe(5_000);
    });
  });

  describe("a bad improve.model or improve.timeoutMs is warned about once and ignored", () => {
    const BAD: Array<[string, Record<string, unknown>]> = [
      ["model", { model: "" }],
      ["model", { model: 5 }],
      ["timeoutMs", { timeoutMs: 0 }],
      ["timeoutMs", { timeoutMs: -5 }],
      ["timeoutMs", { timeoutMs: 1.5 }],
      ["timeoutMs", { timeoutMs: "abc" }],
      ["timeoutMs", { timeoutMs: 999_999_999_999 }],
    ];

    test.each(BAD)("improve.%s %j loads, warns once, and is not in the effective config", (key, improve) => {
      writeConfig({ connections: CONNECTIONS, improve });
      const warnings = loadWarnings().filter((w) => w.includes(`improve.${key} is invalid`));
      expect(warnings).toHaveLength(1);
      expect(configGet(loadUserConfig() as never, `improve.${key}`)).toBeNull();
    });

    test("migrate apply is not blocked by them, and drops them", async () => {
      writeConfig({
        connections: CONNECTIONS,
        improve: { model: "", timeoutMs: -5, connection: "cloud" },
      });
      const result = await runCliCapture(["migrate", "apply"]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).not.toContain('"status":"blocked"');
      const stored = JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as { improve: Record<string, unknown> };
      expect(stored.improve).toEqual({ connection: "cloud" });
    });

    test("a valid value in the same block is kept", () => {
      writeConfig({
        connections: CONNECTIONS,
        improve: { model: "big", timeoutMs: -5 },
      });
      loadWarnings();
      const config = loadUserConfig();
      expect(configGet(config as never, "improve.model")).toBe("big");
      expect(configGet(config as never, "improve.timeoutMs")).toBeNull();
    });
  });

  describe("a retired `engine` in a model-work block", () => {
    test("is named once per key, as not read, with the command that rewrites the file", () => {
      writeConfig({
        connections: CONNECTIONS,
        improve: { engine: "cloud", qualityGate: { engine: "cloud" }, processes: { reflect: { engine: "default" } } },
      });
      const warnings = loadWarnings();
      for (const key of ["improve.engine", "improve.qualityGate.engine", "improve.processes.reflect.engine"]) {
        const named = warnings.filter((w) => w.includes(`"${key}"`));
        expect(named).toHaveLength(1);
        expect(named[0]).toContain("does not read");
        expect(named[0]).toContain("akm migrate apply");
        expect(named[0]).not.toContain("has no defined akm behavior");
      }
    });

    test("selects nothing: the work runs on the default connection, whatever the key names", () => {
      writeConfig({
        connections: CONNECTIONS,
        improve: { processes: { reflect: { engine: "cloud" } } },
      });
      const config = loadUserConfig();
      expect(
        asLlmRunner(resolveImproveExecution({ config, processName: "reflect", alias: "fast" })?.runner).model,
      ).toBe("m-fast");
    });
  });

  describe("the retired index section", () => {
    test("is an unknown key: one warning for the section, none for what is inside it", () => {
      writeConfig({
        connections: CONNECTIONS,
        index: { connection: "cloud", memory: { enabled: false, model: "x" } },
      });
      const warnings = loadWarnings().filter((w) => w.includes("Unknown config key"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('"index"');
    });

    test("changes nothing: memory inference still resolves from improve", () => {
      writeConfig({
        connections: CONNECTIONS,
        index: { connection: "cloud", memory: { enabled: false } },
      });
      const config = loadUserConfig();
      const runner = asLlmRunner(
        resolveImproveExecution({ config, processName: "memoryInference", alias: "fast" })?.runner,
      );
      expect(runner.model).toBe("m-fast");
    });
  });

  describe("keys with no reader are unknown keys", () => {
    test.each([
      ["setup", { setup: {} }],
      ["improve.salience", { improve: { salience: {} } }],
      ["improve.stateGc", { improve: { stateGc: { collect: true } } }],
      [
        "bundles.docs.website.refresh",
        { bundles: { docs: { website: { url: "https://example.com/", refresh: "1d" } } } },
      ],
      ["registries.0.options", { registries: [{ url: "https://example.com/i.json", options: { a: 1 } }] }],
      ["improve.strategies.mine.description", { improve: { strategies: { mine: { description: "x" } } } }],
      ["improve.strategies.mine.limit", { improve: { strategies: { mine: { limit: 5 } } } }],
      ["improve.llm", { improve: { llm: { temperature: 0.2 } } }],
      ["improve.processes.reflect.llm", { improve: { processes: { reflect: { llm: { temperature: 0.2 } } } } }],
      ["improve.qualityGate.llm", { improve: { qualityGate: { llm: { temperature: 0.2 } } } }],
      [
        "improve.strategies.mine.processes.extract.maxSessionsPerRun",
        { improve: { strategies: { mine: { processes: { extract: { maxSessionsPerRun: 5 } } } } } },
      ],
      [
        "improve.strategies.mine.processes.extract.defaultSince",
        { improve: { strategies: { mine: { processes: { extract: { defaultSince: "7d" } } } } } },
      ],
      [
        "improve.strategies.mine.processes.memoryInference.minPendingCount",
        { improve: { strategies: { mine: { processes: { memoryInference: { minPendingCount: 5 } } } } } },
      ],
      [
        "improve.strategies.mine.processes.distill.cls.adjacentCount",
        { improve: { strategies: { mine: { processes: { distill: { cls: { adjacentCount: 5 } } } } } } },
      ],
      [
        "embedding.ollamaOptions",
        { embedding: { endpoint: "http://lab:1/v1", model: "m", ollamaOptions: { num_ctx: 1 } } },
      ],
    ])("%s is named once by the unknown-key warning and the config still loads", (dotted, fragment) => {
      writeConfig({ ...fragment });
      const found = unknownConfigKeyPaths({ ...fragment } as Record<string, unknown>).map((p) => p.join("."));
      expect(found).toEqual([dotted]);
      expect(() => loadUserConfig()).not.toThrow();
    });
  });

  describe("a config still holding improve.stateGc.collect", () => {
    test("loads with one unknown-key warning", () => {
      writeConfig({ connections: CONNECTIONS, improve: { stateGc: { collect: true } } });
      const warnings = loadWarnings().filter((w) => w.includes("Unknown config key"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('"improve.stateGc"');
    });

    test("migrate apply drops it and keeps the rest of improve", async () => {
      writeConfig({ connections: CONNECTIONS, improve: { eventRetentionDays: 30, stateGc: { collect: true } } });
      const result = await runCliCapture(["migrate", "apply"]);
      expect(result.code, result.stderr).toBe(0);
      const stored = JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as { improve: Record<string, unknown> };
      expect(stored.improve).toEqual({ eventRetentionDays: 30 });
    });
  });

  describe("secret-shaped keys under connections are redacted in config get, list and diff", () => {
    const config = {
      connections: {
        lab: {
          endpoint: "http://lab:1/v1",
          models: { fast: "m", "token-small": "m-small" },
          api_key: "sk-FAKE-1",
          access_token: "tok-FAKE-2",
          client_secret: "sec-FAKE-3",
          password: "pw-FAKE-4",
          api_keys: ["FAKE-8", "FAKE-9"],
          secrets: { primary: "FAKE-10" },
          credentials: { authorization: { value: "FAKE-11" } },
          headers: { Authorization: "Bearer FAKE-5", "X-Api-Key": "FAKE-6", "X-Trace": "keep-me" },
          nested: { deep: { refresh_token: "FAKE-7" } },
          fromEnv: { api_key: "$LAB_KEY", token: "$LAB_TOKEN" },
          maxTokens: 512,
          max_tokens: 256,
          tokenizer: "cl100k",
          "monkey-small": "keep-monkey",
          prompt_cache_key: "tenant-a",
          timeoutMs: 1000,
        },
      },
      // A secret-shaped key outside connections: redaction is scoped to connections, so this one stays.
      workflow: { maxConcurrency: 2, token: "outside-keep" },
    } as never;
    const SECRETS = ["FAKE-1", "FAKE-2", "FAKE-3", "FAKE-4", "FAKE-5", "FAKE-6", "FAKE-7", "FAKE-8", "FAKE-9"];

    function expectRedacted(text: string): void {
      for (const secret of [...SECRETS, "FAKE-10", "FAKE-11", "sk-FAKE", "tok-FAKE"])
        expect(text).not.toContain(secret);
      // What is not a secret stays: by the words of the key, never by substring.
      for (const kept of [
        "keep-me",
        "http://lab:1/v1",
        "keep-monkey",
        "tenant-a",
        "cl100k",
        "m-small",
        "outside-keep",
      ]) {
        expect(text).toContain(kept);
      }
      expect(text).toContain('"maxTokens":512');
      expect(text).toContain('"max_tokens":256');
      // An env reference is a name, not a secret: it stays, as an apiKey's does.
      expect(text).toContain("$LAB_KEY");
      expect(text).toContain("$LAB_TOKEN");
    }

    test("config list drops every literal secret of any type, nested included, and keeps what is not one", () => {
      expectRedacted(JSON.stringify(redactSecretKeys(listConfig(config))));
    });

    test("config get redacts the same way, at the block, a nested block, and the key itself", () => {
      expect(JSON.stringify(getConfigValue(config, "connections"))).not.toContain("FAKE");
      expect(JSON.stringify(getConfigValue(config, "connections.lab.headers"))).not.toContain("FAKE-5");
      expect(getConfigValue(config, "connections.lab.headers")).toMatchObject({ "X-Trace": "keep-me" });
      expect(getConfigValue(config, "connections.lab.api_key")).toBeUndefined();
      expect(getConfigValue(config, "connections.lab.api_keys")).toBeUndefined();
      expect(getConfigValue(config, "connections.lab.maxTokens")).toBe(512);
      expect(getConfigValue(config, "connections.lab.models")).toMatchObject({ "token-small": "m-small" });
      expect(getConfigValue(config, "workflow")).toMatchObject({ token: "outside-keep" });
    });

    test("config get of a redacted leaf prints null, never nothing", async () => {
      writeConfig({
        connections: { lab: { endpoint: "http://lab:1/v1", api_key: "sk-FAKE-1" } },
      });
      const result = await runCliCapture(["config", "get", "connections.lab.api_key", "--format", "json"]);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toBeNull();
    });

    test("config list and config diff print none of it", async () => {
      writeConfig(config);
      const list = await runCliCapture(["config", "list"]);
      expect(list.code, list.stderr).toBe(0);
      expectRedacted(JSON.stringify(JSON.parse(list.stdout)));

      const other = path.join(path.dirname(getConfigPath()), "other.json");
      fs.writeFileSync(
        other,
        JSON.stringify({
          connections: {
            lab: {
              endpoint: "http://other:1/v1",
              api_key: "sk-OTHER-FAKE",
              api_keys: ["OTHER-FAKE-2"],
              tokenizer: "other",
            },
          },
        }),
      );
      const diff = await runCliCapture(["config", "diff", other]);
      expect(diff.code, diff.stderr).toBe(0);
      expect(diff.stdout).not.toContain("FAKE");
      const rows = (JSON.parse(diff.stdout) as { rows: Array<{ path: string; other: unknown }> }).rows;
      expect(rows.find((row) => row.path === "connections.lab.tokenizer")?.other).toBe("other");
      expect(rows.find((row) => row.path === "connections.lab.endpoint")?.other).toBe("http://other:1/v1");
    });

    test("a Desktop save from what Desktop reads never loses a setting", () => {
      writeConfig({
        connections: {
          default: {
            endpoint: "http://lab:1/v1",
            models: { fast: "m", "monkey-small": "modelname" },
            prompt_cache_key: "tenant-a",
            maxTokens: 512,
            api_keys: ["keep-on-disk"],
          },
        },
      });
      resetConfigCache();
      const entry = workspaceConfig.get().config.connections as Record<string, Record<string, unknown>>;
      workspaceConfig.saveConnection({ name: "default", entry: { ...entry.default, contextLength: 4096 } });
      const saved = (JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as { connections: Record<string, unknown> })
        .connections.default as Record<string, unknown>;
      expect(saved.models).toEqual({ fast: "m", "monkey-small": "modelname" });
      expect(saved).toMatchObject({
        prompt_cache_key: "tenant-a",
        maxTokens: 512,
        contextLength: 4096,
      });
      // The secret-shaped key is not dropped by akm's own listing; Desktop's UI mask handles it, as before.
      expect(saved).toHaveProperty("api_keys");
    });
  });

  describe("registries[].options is retired like the other deleted keys", () => {
    const registries = [{ url: "https://example.com/i.json", name: "keep", options: { a: 1 } }];

    test("the unknown-key warning names it once", () => {
      writeConfig({ registries });
      const warnings = loadWarnings().filter((w) => w.includes("Unknown config key"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('"registries.0.options"');
    });

    test("migrate apply drops it and keeps the rest of the entry", async () => {
      writeConfig({ registries });
      const result = await runCliCapture(["migrate", "apply"]);
      expect(result.code, result.stderr).toBe(0);
      const stored = JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as {
        registries: Array<Record<string, unknown>>;
      };
      expect(stored.registries).toEqual([{ url: "https://example.com/i.json", name: "keep" }]);
    });
  });

  describe("a strategy `limit` is gone from the plan", () => {
    test("plan.limits.configured has no `profile`, and the strategy limit does not cap the run", async () => {
      writeConfig({
        semanticSearchMode: "off",
        connections: CONNECTIONS,
        improve: { strategy: "mine", strategies: { mine: { limit: 5 } } },
      });
      const bundle = fs.mkdtempSync(path.join(os.tmpdir(), "akm-limits-bundle-"));
      try {
        expect((await runCliCapture(["bundle", "create", "--dir", bundle])).code).toBe(0);
        const result = await runCliCapture(["improve", "--dry-run", "--format", "json"]);
        expect(result.code, result.stderr).toBe(0);
        const limits = (JSON.parse(result.stdout) as { plan: { limits: { configured: object; effective?: number } } })
          .plan.limits;
        expect(limits.configured).not.toHaveProperty("profile");
        // The shipped reflect limit (25) is what applies; the strategy's own `limit` never did anything.
        expect(limits.effective).toBe(25);
      } finally {
        fs.rmSync(bundle, { recursive: true, force: true });
      }
    });
  });

  describe("akm bundle create --dir on a temporary path", () => {
    test("says nothing about a test runner: production does not know it is under one", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-init-tmp-"));
      try {
        const result = await runCliCapture(["bundle", "create", "--dir", dir]);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stderr).not.toContain("Persisting --dir");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
