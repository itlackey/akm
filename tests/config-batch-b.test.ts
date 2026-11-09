// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Settings that said one thing and did another: `improve.model/timeoutMs` named, the inert `index` section and the
 * keys with no reader gone, a retired `engine` named honestly, and the redaction of secret-shaped connection fields.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConfigValue, listConfig, redactSecretKeys } from "../src/commands/config-cli";
import { resolveImproveExecution } from "../src/commands/improve/execution";
import { loadUserConfig, resetConfigCache, unknownConfigKeyPaths } from "../src/core/config/config";
import { configGet } from "../src/core/config/config-walker";
import { getConfigPath } from "../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { config as workspaceConfig } from "../src/workspace";
import { runCliCapture } from "./_helpers/cli";
import { asLlmRunner } from "./_helpers/llm-runner";

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
      configVersion: "0.9.0",
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
      configVersion: "0.9.0",
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
    writeConfig({ configVersion: "0.9.0", connections: CONNECTIONS, improve });
    const warnings = loadWarnings().filter((w) => w.includes(`improve.${key} is invalid`));
    expect(warnings).toHaveLength(1);
    expect(configGet(loadUserConfig() as never, `improve.${key}`)).toBeNull();
  });

  test("migrate apply is not blocked by them, and drops them", async () => {
    writeConfig({
      configVersion: "0.9.0",
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
      configVersion: "0.9.0",
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
      configVersion: "0.9.0",
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
      configVersion: "0.9.0",
      connections: CONNECTIONS,
      improve: { processes: { reflect: { engine: "cloud" } } },
    });
    const config = loadUserConfig();
    expect(asLlmRunner(resolveImproveExecution({ config, processName: "reflect", alias: "fast" })?.runner).model).toBe(
      "m-fast",
    );
  });
});

describe("the retired index section", () => {
  test("is an unknown key: one warning for the section, none for what is inside it", () => {
    writeConfig({
      configVersion: "0.9.0",
      connections: CONNECTIONS,
      index: { connection: "cloud", memory: { enabled: false, model: "x" } },
    });
    const warnings = loadWarnings().filter((w) => w.includes("Unknown config key"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"index"');
  });

  test("changes nothing: memory inference still resolves from improve", () => {
    writeConfig({
      configVersion: "0.9.0",
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
    writeConfig({ configVersion: "0.9.0", ...fragment });
    const found = unknownConfigKeyPaths({ configVersion: "0.9.0", ...fragment } as Record<string, unknown>).map((p) =>
      p.join("."),
    );
    expect(found).toEqual([dotted]);
    expect(() => loadUserConfig()).not.toThrow();
  });
});

describe("secret-shaped keys under connections are redacted in config get, list and diff", () => {
  const config = {
    configVersion: "0.9.0",
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
    for (const secret of [...SECRETS, "FAKE-10", "FAKE-11", "sk-FAKE", "tok-FAKE"]) expect(text).not.toContain(secret);
    // What is not a secret stays: by the words of the key, never by substring.
    for (const kept of ["keep-me", "http://lab:1/v1", "keep-monkey", "tenant-a", "cl100k", "m-small", "outside-keep"]) {
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
      configVersion: "0.9.0",
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
        configVersion: "0.9.0",
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
      configVersion: "0.9.0",
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
    writeConfig({ configVersion: "0.9.0", registries });
    const warnings = loadWarnings().filter((w) => w.includes("Unknown config key"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"registries.0.options"');
  });

  test("migrate apply drops it and keeps the rest of the entry", async () => {
    writeConfig({ configVersion: "0.9.0", registries });
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
      configVersion: "0.9.0",
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
