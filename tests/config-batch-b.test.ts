// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Settings that said one thing and did another: `improve.model/llm/timeoutMs` named, the inert `index` section and the
 * keys with no reader gone, a retired `engine` spelled honestly, and the redaction of secret-shaped connection fields.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getConfigValue, listConfig } from "../src/commands/config-cli";
import { resolveImproveExecution } from "../src/commands/improve/execution";
import { loadUserConfig, resetConfigCache, unknownConfigKeyPaths } from "../src/core/config/config";
import { configGet } from "../src/core/config/config-walker";
import { getConfigPath } from "../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { asLlmRunner } from "./_helpers/llm-runner";
import { runRegistryAdd } from "./_helpers/registry-add";

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

describe("improve.model, improve.llm and improve.timeoutMs are named keys", () => {
  test("they load with no unknown-key warning and read back through config get", () => {
    writeConfig({
      configVersion: "0.9.0",
      connections: CONNECTIONS,
      improve: { model: "big", llm: { temperature: 0.2 }, timeoutMs: 90_000 },
    });
    expect(loadWarnings().filter((w) => w.includes("Unknown config key"))).toEqual([]);
    const config = loadUserConfig();
    expect(configGet(config as never, "improve.model")).toBe("big");
    expect(configGet(config as never, "improve.timeoutMs")).toBe(90_000);
    expect(configGet(config as never, "improve.llm")).toEqual({ temperature: 0.2 });
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

describe("a retired `engine` in a model-work block", () => {
  test("is no longer called unknown: the warning says what it is, and it still selects where the work runs", () => {
    writeConfig({
      configVersion: "0.9.0",
      connections: CONNECTIONS,
      improve: { engine: "cloud", processes: { reflect: { engine: "default" } } },
    });
    const warnings = loadWarnings();
    for (const key of ["improve.engine", "improve.processes.reflect.engine"]) {
      const named = warnings.filter((w) => w.includes(`"${key}"`));
      expect(named).toHaveLength(1);
      expect(named[0]).toContain("retired spelling");
      expect(named[0]).not.toContain("has no defined akm behavior");
    }
    const config = loadUserConfig();
    expect(asLlmRunner(resolveImproveExecution({ config, processName: "extract", alias: "fast" })?.runner).model).toBe(
      "c-fast",
    );
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
  ])("%s is named once by the unknown-key warning and the config still loads", (dotted, fragment) => {
    writeConfig({ configVersion: "0.9.0", ...fragment });
    const found = unknownConfigKeyPaths({ configVersion: "0.9.0", ...fragment } as Record<string, unknown>).map((p) =>
      p.join("."),
    );
    // A registries array is not descended into, so its entry's key is not path-checked; the schema simply drops it.
    if (dotted.startsWith("registries.")) expect(found).toEqual([]);
    else expect(found).toEqual([dotted]);
    expect(() => loadUserConfig()).not.toThrow();
  });
});

describe("secret-shaped keys under connections are redacted in config get, list and diff", () => {
  const config = {
    configVersion: "0.9.0",
    connections: {
      lab: {
        endpoint: "http://lab:1/v1",
        models: { fast: "m" },
        api_key: "sk-FAKE-1",
        access_token: "tok-FAKE-2",
        client_secret: "sec-FAKE-3",
        password: "pw-FAKE-4",
        headers: { Authorization: "Bearer FAKE-5", "X-Api-Key": "FAKE-6", "X-Trace": "keep-me" },
        nested: { deep: { refresh_token: "FAKE-7" } },
        fromEnv: { api_key: "$LAB_KEY", token: "$LAB_TOKEN" },
        maxTokens: 512,
        timeoutMs: 1000,
      },
    },
  } as never;

  test("config list drops every literal secret, nested included, and keeps what is not one", () => {
    const text = JSON.stringify(listConfig(config));
    for (const secret of [
      "FAKE-1",
      "FAKE-2",
      "FAKE-3",
      "FAKE-4",
      "FAKE-5",
      "FAKE-6",
      "FAKE-7",
      "sk-FAKE",
      "tok-FAKE",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("keep-me");
    expect(text).toContain("http://lab:1/v1");
    expect(text).toContain('"maxTokens":512');
    // An env reference is a name, not a secret: it stays, as an apiKey's does.
    expect(text).toContain("$LAB_KEY");
    expect(text).toContain("$LAB_TOKEN");
  });

  test("config get redacts the same way, at the block, a nested block, and the key itself", () => {
    expect(JSON.stringify(getConfigValue(config, "connections"))).not.toContain("FAKE");
    expect(JSON.stringify(getConfigValue(config, "connections.lab.headers"))).not.toContain("FAKE-5");
    expect(getConfigValue(config, "connections.lab.headers")).toMatchObject({ "X-Trace": "keep-me" });
    expect(getConfigValue(config, "connections.lab.api_key")).toBeUndefined();
  });

  test("a secret-shaped key outside connections is untouched", () => {
    const other = { configVersion: "0.9.0", workflow: { maxConcurrency: 2 }, output: { format: "json" } } as never;
    expect(getConfigValue(other, "workflow")).toEqual({ maxConcurrency: 2 });
  });
});

describe("akm registry add --options", () => {
  test("is accepted, says it does nothing, and is not stored", async () => {
    const { result, warnings } = await runRegistryAdd(["--options", '{"a":1}']);
    expect(result.code, result.stderr).toBe(0);
    expect(warnings.join("\n")).toContain("does nothing");
    const stored = JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as {
      registries?: Array<Record<string, unknown>>;
    };
    const entry = stored.registries?.find((r) => r.url === "https://example.com/batch-b.json");
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty("options");
  });
});
