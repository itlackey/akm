// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The pre-0.10 `engines` / `defaults` config, read as `connections` / `harnesses`.
 * One row per row of the conversion table, then the three example configs the
 * rework is specified by, which must load unchanged.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resolveImproveExecution } from "../src/commands/improve/execution";
import { resolveQualityGateJudge } from "../src/commands/improve/stage";
import { stripJsonComments } from "../src/core/common";
import {
  type AkmConfig,
  loadUserConfig,
  normalizeConfigFile,
  resetConfigCache,
  unknownConfigKeyPaths,
} from "../src/core/config/config";
import { AkmConfigSchema } from "../src/core/config/config-schema";
import { convertEngineConfig } from "../src/core/config/convert-engines";
import { getConfigPath } from "../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";

type Dict = Record<string, unknown>;

const llm = (extra: Dict = {}): Dict => ({
  kind: "llm",
  endpoint: "http://lab:8080/v1/chat/completions",
  model: "qwen3-32b",
  ...extra,
});

function convert(raw: Dict, options: Parameters<typeof convertEngineConfig>[1] = {}) {
  return convertEngineConfig({ configVersion: "0.9.0", ...raw }, options);
}

describe("engines.<n> kind llm → connections.<n>", () => {
  test("keeps the endpoint, a $VAR key, contextLength, timeoutMs and concurrency, and names the model for the three aliases", () => {
    const { config, changed } = convert({
      engines: {
        lab: llm({ apiKey: "$LAB_KEY", contextLength: 32768, timeoutMs: 900000, concurrency: 3 }),
      },
    });
    expect(changed).toBe(true);
    expect(config.engines).toBeUndefined();
    expect(config.connections).toEqual({
      lab: {
        endpoint: "http://lab:8080/v1/chat/completions",
        apiKey: "$LAB_KEY",
        contextLength: 32768,
        timeoutMs: 900000,
        concurrency: 3,
        models: { fast: "qwen3-32b", balanced: "qwen3-32b", reasoning: "qwen3-32b" },
      },
    });
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env-var reference syntax under test
  const braced = "${LAB_KEY}";
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal secret-store reference syntax under test
  const secretRef = "${secrets/lab}";

  test("accepts the braced spelling of a key reference", () => {
    const { config } = convert({ engines: { lab: llm({ apiKey: braced }) } });
    expect((config.connections as Dict).lab).toMatchObject({ apiKey: braced });
  });

  test("turns inference keys into the endpoint's field names as the client sent them", () => {
    const { config } = convert({
      engines: {
        lab: llm({
          temperature: 0.2,
          maxTokens: 4096,
          enableThinking: false,
          reasoningEffort: "low",
          extraParams: { top_p: 0.9 },
        }),
      },
    });
    expect((config.connections as Dict).lab).toMatchObject({
      temperature: 0.2,
      max_tokens: 4096,
      top_p: 0.9,
      chat_template_kwargs: { enable_thinking: false },
      enable_thinking: false,
      reasoning_effort: "low",
    });
    const lab = (config.connections as Dict).lab as Dict;
    for (const gone of ["kind", "model", "maxTokens", "enableThinking", "reasoningEffort", "extraParams", "provider"]) {
      expect(lab).not.toHaveProperty(gone);
    }
  });

  test("drops provider and supportsJsonSchema, naming supportsJsonSchema: false", () => {
    const { config, notes } = convert({ engines: { lab: llm({ provider: "lmstudio", supportsJsonSchema: false }) } });
    expect((config.connections as Dict).lab).not.toHaveProperty("provider");
    expect((config.connections as Dict).lab).not.toHaveProperty("supportsJsonSchema");
    expect(notes.join("\n")).toContain("supportsJsonSchema");
  });

  test("a key akm no longer reads from a file, the secret store or the config is treated as absent, with a note naming akm migrate apply", () => {
    for (const keyed of [{ apiKeyFile: "/run/key" }, { apiKey: secretRef }, { apiKey: "sk-literal" }]) {
      const { config, notes } = convert({ engines: { lab: llm(keyed) } });
      expect((config.connections as Dict).lab).not.toHaveProperty("apiKey");
      expect((config.connections as Dict).lab).not.toHaveProperty("apiKeyFile");
      expect(notes.some((note) => note.includes("engines.lab") && note.includes("akm migrate apply"))).toBe(true);
    }
  });

  test("an AKM_ENGINE_<NAME>_API_KEY set at migrate time becomes the connection's $VAR key", () => {
    const env = { AKM_ENGINE_MY_LAB_API_KEY: "secret" } as NodeJS.ProcessEnv;
    const { config } = convert({ engines: { "my-lab": llm() } }, { env });
    expect((config.connections as Dict)["my-lab"]).toMatchObject({ apiKey: "$AKM_ENGINE_MY_LAB_API_KEY" });
    // Nothing set, nothing written; an explicit key outranks the convention.
    expect(
      ((convert({ engines: { "my-lab": llm() } }, { env: {} }).config.connections as Dict)["my-lab"] as Dict).apiKey,
    ).toBeUndefined();
    const explicit = convert({ engines: { "my-lab": llm({ apiKey: "$OTHER" }) } }, { env });
    expect(((explicit.config.connections as Dict)["my-lab"] as Dict).apiKey).toBe("$OTHER");
  });

  test("a key the old schema did not know is dropped, not sent to the endpoint as a request field", () => {
    const { config, notes } = convert({ engines: { lab: llm({ temprature: 0.1 }) } });
    expect((config.connections as Dict).lab).not.toHaveProperty("temprature");
    expect(notes.some((note) => note.includes("temprature"))).toBe(true);
  });
});

describe("engines.<n> kind agent → harnesses.<n>", () => {
  test("a platform other than opencode-sdk becomes a harness, its model naming every alias", () => {
    const { config } = convert({
      engines: {
        "claude-work": {
          kind: "agent",
          platform: "claude",
          bin: "/opt/claude",
          args: ["--print"],
          workspace: "/work",
          agent: "reviewer",
          timeoutMs: 60000,
          model: "claude-sonnet-4-6",
        },
      },
    });
    expect(config.harnesses).toEqual({
      "claude-work": {
        platform: "claude",
        bin: "/opt/claude",
        args: ["--print"],
        workspace: "/work",
        agent: "reviewer",
        timeoutMs: 60000,
        models: { fast: "claude-sonnet-4-6", balanced: "claude-sonnet-4-6", reasoning: "claude-sonnet-4-6" },
      },
    });
  });

  test("an engine named for its platform needs no platform key", () => {
    const { config } = convert({ engines: { claude: { kind: "agent", platform: "claude" } } });
    expect(config.harnesses).toEqual({ claude: {} });
  });

  test("an opencode-sdk engine is removed: akm's own runtime has no entry in config", () => {
    const { config, notes } = convert({
      engines: {
        sdk: { kind: "agent", platform: "opencode-sdk", llmEngine: "lab", model: "anthropic/x" },
        lab: llm(),
      },
    });
    expect(config).not.toHaveProperty("harnesses");
    expect(notes.some((note) => note.includes("engines.sdk") && note.includes("opencode-sdk"))).toBe(true);
  });
});

describe("the defaults become the entries named default", () => {
  test("defaults.llmEngine names the connection that is renamed default, and every reference follows", () => {
    const { config } = convert({
      engines: { lab: llm(), cloud: llm({ endpoint: "https://api.openai.com/v1/chat/completions" }) },
      defaults: { llmEngine: "lab" },
      index: { memory: { engine: "lab" } },
      improve: {
        strategies: {
          nightly: { processes: { reflect: { engine: "lab" }, triage: { judgment: { engine: "cloud" } } } },
        },
      },
    });
    expect(Object.keys(config.connections as Dict)).toEqual(["default", "cloud"]);
    expect((config.index as Dict).memory).toEqual({ connection: "default" });
    const processes = (config.improve as Dict).processes as Dict;
    expect(processes.reflect).toEqual({ connection: "default" });
    expect(processes.triage).toEqual({ connection: "cloud" });
    expect(config).not.toHaveProperty("defaults");
  });

  test("defaults.engine naming a connection is the default when defaults.llmEngine is not set", () => {
    const { config } = convert({ engines: { lab: llm() }, defaults: { engine: "lab" } });
    expect(Object.keys(config.connections as Dict)).toEqual(["default"]);
  });

  test("the connection a removed opencode-sdk engine named becomes default, when nothing else says", () => {
    const { config } = convert({
      engines: { sdk: { kind: "agent", platform: "opencode-sdk", llmEngine: "lab" }, lab: llm(), other: llm() },
      defaults: { engine: "sdk" },
    });
    expect(Object.keys(config.connections as Dict).sort()).toEqual(["default", "other"]);
  });

  test("an existing entry already called default moves aside for the one that takes the name", () => {
    const { config } = convert({
      engines: { default: llm({ model: "old" }), lab: llm({ model: "new" }) },
      defaults: { llmEngine: "lab" },
    });
    const connections = config.connections as Dict;
    expect((connections.default as Dict).models).toMatchObject({ fast: "new" });
    expect((connections["legacy-default"] as Dict).models).toMatchObject({ fast: "old" });
  });

  test("the harness defaults.engine named is renamed default when there are several, keeping its platform", () => {
    const { config } = convert({
      engines: { claude: { kind: "agent", platform: "claude" }, opencode: { kind: "agent", platform: "opencode" } },
      defaults: { engine: "claude" },
    });
    expect(config.harnesses).toEqual({ default: { platform: "claude" }, opencode: {} });
  });

  test("with one harness there is nothing to rename", () => {
    const { config } = convert({
      engines: { claude: { kind: "agent", platform: "claude" } },
      defaults: { engine: "claude" },
    });
    expect(config.harnesses).toEqual({ claude: {} });
  });

  test("defaults.improveStrategy becomes improve.strategy, without overwriting one already set", () => {
    expect((convert({ defaults: { improveStrategy: "consolidate" } }).config.improve as Dict).strategy).toBe(
      "consolidate",
    );
    const kept = convert({ defaults: { improveStrategy: "consolidate" }, improve: { strategy: "default" } });
    expect((kept.config.improve as Dict).strategy).toBe("default");
  });
});

describe("models.json folds into the models of what it named", () => {
  const engines = {
    lab: llm({ model: "qwen3-32b" }),
    other: llm({ model: "other-model" }),
    claude: { kind: "agent", platform: "claude" },
    sdk: { kind: "agent", platform: "opencode-sdk", llmEngine: "lab" },
  };
  const overlay = (aliases: Dict) => ({ version: 1, aliases });
  const modelsOf = (config: Dict, group: "connections" | "harnesses", name: string) =>
    ((config[group] as Dict)[name] as Dict).models as Dict;

  test("a column naming a connection sets that alias on it", () => {
    const { config } = convert({ engines }, { modelsOverlay: overlay({ fast: { lab: "qwen3-8b" } }) });
    expect(modelsOf(config, "connections", "lab")).toEqual({
      fast: "qwen3-8b",
      balanced: "qwen3-32b",
      reasoning: "qwen3-32b",
    });
    expect(modelsOf(config, "connections", "other").fast).toBe("other-model");
  });

  test("a structured profile's inference becomes request fields on the model entry", () => {
    const { config } = convert(
      { engines },
      {
        modelsOverlay: overlay({
          reasoning: { lab: { model: "glm-5", inference: { effort: "high", enableThinking: true, maxTokens: 8192 } } },
        }),
      },
    );
    expect(modelsOf(config, "connections", "lab").reasoning).toEqual({
      model: "glm-5",
      max_tokens: 8192,
      chat_template_kwargs: { enable_thinking: true },
      enable_thinking: true,
      reasoning_effort: "high",
    });
  });

  test("the opencode-sdk column folds into the connection the removed engine named, under an explicit column", () => {
    const { config } = convert(
      { engines },
      {
        modelsOverlay: overlay({
          fast: { "opencode-sdk": "sdk-model", lab: "lab-model" },
          balanced: { "opencode-sdk": "sdk-balanced" },
        }),
      },
    );
    expect(modelsOf(config, "connections", "lab")).toMatchObject({ fast: "lab-model", balanced: "sdk-balanced" });
  });

  test("a wildcard fills every connection that lacks the alias, and a new alias", () => {
    const { config } = convert(
      { engines },
      { modelsOverlay: overlay({ coder: { model: "qwen3-coder" }, fast: { model: "wild", other: "own" } }) },
    );
    expect(modelsOf(config, "connections", "lab").coder).toBe("qwen3-coder");
    expect(modelsOf(config, "connections", "other").coder).toBe("qwen3-coder");
    // `fast` already had an entry on both (the engine's model), so the wildcard fills nothing.
    expect(modelsOf(config, "connections", "lab").fast).toBe("qwen3-32b");
    expect(modelsOf(config, "connections", "other").fast).toBe("own");
  });

  test("a column naming a harness's platform sets the alias on that harness", () => {
    const { config } = convert({ engines }, { modelsOverlay: overlay({ fast: { claude: "claude-haiku-5" } }) });
    expect(modelsOf(config, "harnesses", "claude")).toEqual({ fast: "claude-haiku-5" });
  });

  test("an engine indirection, a column naming nothing, and a harness's inference are dropped with a note", () => {
    const { config, notes } = convert(
      { engines },
      {
        modelsOverlay: overlay({
          fast: { lab: { engine: "other" }, nowhere: "x" },
          reasoning: { claude: { model: "claude-opus-5", inference: { effort: "high" } } },
        }),
      },
    );
    expect(modelsOf(config, "connections", "lab").fast).toBe("qwen3-32b");
    expect(modelsOf(config, "harnesses", "claude").reasoning).toBe("claude-opus-5");
    const text = notes.join("\n");
    expect(text).toContain("engine indirection");
    expect(text).toContain("fast.nowhere");
    expect(text).toContain("inference settings are not carried over");
  });
});

describe("what a strategy no longer decides, and per-process names", () => {
  test("workflow.judgeEngine and a strategy's engine, model, llm and timeoutMs are dropped with a note each", () => {
    const { config, notes } = convert({
      engines: { lab: llm() },
      workflow: { judgeEngine: "lab", maxConcurrency: 2 },
      improve: { strategies: { nightly: { engine: "lab", model: "fast", llm: {}, timeoutMs: 5, limit: 3 } } },
    });
    expect(config.workflow).toEqual({ maxConcurrency: 2 });
    expect((config.improve as Dict).strategies).toEqual({ nightly: { limit: 3 } });
    const text = notes.join("\n");
    for (const dropped of ["workflow.judgeEngine", "strategies.nightly.engine", ".model", ".llm", ".timeoutMs"]) {
      expect(text).toContain(dropped);
    }
  });

  test("index.defaults is flattened into index, an index.<pass> engine becomes its connection", () => {
    const { config } = convert({
      engines: { lab: llm(), claude: { kind: "agent", platform: "claude" } },
      index: {
        defaults: { engine: "lab", model: "fast", timeoutMs: 1000, llm: { temperature: 0 } },
        memory: { engine: "lab" },
      },
    });
    expect(config.index).toEqual({
      memory: { connection: "lab" },
      connection: "lab",
      model: "fast",
      timeoutMs: 1000,
      llm: { temperature: 0 },
    });
    // An index pass runs on connections only; a harness there is dropped with a note.
    const withHarness = convert({
      engines: { claude: { kind: "agent", platform: "claude" } },
      index: { memory: { engine: "claude", enabled: true } },
    });
    expect((withHarness.config.index as Dict).memory).toEqual({ enabled: true });
    expect(withHarness.notes.join("\n")).toContain("index.memory.engine");
  });

  test("a strategy process's engine becomes connection or harness by the target's kind, and moves to improve.processes with its model, llm and timeoutMs", () => {
    const { config } = convert({
      engines: {
        lab: llm(),
        claude: { kind: "agent", platform: "claude" },
        sdk: { kind: "agent", platform: "opencode-sdk", llmEngine: "lab" },
      },
      improve: {
        strategies: {
          nightly: {
            processes: {
              reflect: {
                enabled: true,
                engine: "lab",
                model: "balanced",
                llm: { temperature: 0.1 },
                timeoutMs: 100,
                qualityGate: { enabled: false, engine: "claude" },
              },
              distill: { engine: "sdk" },
              triage: { judgment: { enabled: true, engine: "gone" } },
            },
          },
        },
      },
    });
    const improve = config.improve as Dict;
    expect(improve.processes).toEqual({
      reflect: { connection: "lab", model: "balanced", llm: { temperature: 0.1 }, timeoutMs: 100 },
      // The removed runtime engine is the connection it ran over; a name that is nothing is read as a connection.
      distill: { connection: "lab" },
      triage: { connection: "gone" },
    });
    expect(improve.qualityGate).toEqual({ harness: "claude" });
    // What stays in the strategy is which processes run and how.
    expect(improve.strategies).toEqual({
      nightly: {
        processes: {
          reflect: { enabled: true, qualityGate: { enabled: false } },
          distill: {},
          triage: { judgment: { enabled: true } },
        },
      },
    });
  });

  test("two strategies that say where a process runs differently keep the first and note the second", () => {
    const { config, notes } = convert({
      engines: { lab: llm(), cloud: llm({ endpoint: "https://api.openai.com/v1/chat/completions" }) },
      improve: {
        strategies: {
          nightly: { processes: { reflect: { engine: "lab", model: "fast", qualityGate: { engine: "lab" } } } },
          weekly: {
            processes: { reflect: { engine: "cloud", model: "fast", timeoutMs: 7, qualityGate: { engine: "cloud" } } },
          },
        },
      },
    });
    const improve = config.improve as Dict;
    expect(improve.processes).toEqual({ reflect: { connection: "lab", model: "fast", timeoutMs: 7 } });
    expect(improve.qualityGate).toEqual({ connection: "lab" });
    const text = notes.join("\n");
    expect(text).toContain("improve.strategies.weekly.processes.reflect.connection");
    expect(text).toContain("improve.strategies.weekly.processes.reflect.qualityGate.connection");
    expect(text).not.toContain("reflect.model");
  });

  test("a harness and a connection named by different strategies for one process are one choice, not two", () => {
    const { config } = convert({
      engines: { lab: llm(), claude: { kind: "agent", platform: "claude" } },
      improve: {
        strategies: {
          nightly: { processes: { reflect: { engine: "lab" } } },
          weekly: { processes: { reflect: { engine: "claude" } } },
        },
      },
    });
    expect((config.improve as Dict).processes).toEqual({ reflect: { connection: "lab" } });
  });
});

describe("what is already current is left alone", () => {
  test("a config in the new form is returned as it is, unchanged", () => {
    const raw = {
      configVersion: "0.9.0",
      connections: { default: { endpoint: "http://x/v1", models: { fast: "m" } } },
    };
    const result = convertEngineConfig(raw);
    expect(result.changed).toBe(false);
    expect(result.config).toBe(raw);
    expect(result.notes).toEqual([]);
  });

  test("connections already written win over a converted engine of the same name", () => {
    const { config } = convert({
      engines: { lab: llm({ model: "old" }) },
      connections: { lab: { endpoint: "http://new/v1", models: { fast: "new" } } },
    });
    expect((config.connections as Dict).lab).toEqual({ endpoint: "http://new/v1", models: { fast: "new" } });
  });

  test("the converter does not modify its input", () => {
    const raw = { configVersion: "0.9.0", engines: { lab: llm() }, defaults: { llmEngine: "lab" } };
    const snapshot = structuredClone(raw);
    convertEngineConfig(raw);
    expect(raw).toEqual(snapshot);
  });

  test("the converted config validates against the schema", () => {
    const { config } = convert({
      engines: { lab: llm({ apiKey: "$K", temperature: 0.2 }), claude: { kind: "agent", platform: "claude" } },
      defaults: { llmEngine: "lab", engine: "claude", improveStrategy: "default" },
      improve: { strategies: { nightly: { processes: { reflect: { engine: "lab" } } } } },
    });
    const parsed = AkmConfigSchema.safeParse({ semanticSearchMode: "off", ...config });
    expect(parsed.success).toBe(true);
    expect(unknownConfigKeyPaths(config)).toEqual([]);
  });
});

describe("the loader reads the retired form in memory", () => {
  function captureWarnings(run: () => void): string[] {
    const warnings: string[] = [];
    _resetWarnOnceForTests();
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    try {
      run();
    } finally {
      _setWarnSinkForTests(undefined);
    }
    return warnings;
  }

  beforeEach(() => resetConfigCache());
  afterEach(() => {
    resetConfigCache();
    fs.rmSync(path.join(path.dirname(getConfigPath()), "models.json"), { force: true });
  });

  function writeConfig(value: unknown): void {
    fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
    fs.writeFileSync(getConfigPath(), JSON.stringify(value));
  }

  test("loads an engines config as connections with one warning naming akm migrate apply, and never rewrites the file", () => {
    writeConfig({
      configVersion: "0.9.0",
      engines: { lab: llm(), claude: { kind: "agent", platform: "claude" } },
      defaults: { llmEngine: "lab" },
    });
    const before = fs.readFileSync(getConfigPath(), "utf8");
    let config!: ReturnType<typeof loadUserConfig>;
    const warnings = captureWarnings(() => {
      config = loadUserConfig();
    });
    expect(Object.keys(config.connections ?? {})).toEqual(["default"]);
    expect(Object.keys(config.harnesses ?? {})).toEqual(["claude"]);
    const retired = warnings.filter((w) => w.includes("retired engines/defaults form"));
    expect(retired).toHaveLength(1);
    expect(retired[0]).toContain("akm migrate apply");
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
  });

  test("reads the user models.json as the overlay", () => {
    writeConfig({ configVersion: "0.9.0", engines: { lab: llm() }, defaults: { llmEngine: "lab" } });
    fs.writeFileSync(
      path.join(path.dirname(getConfigPath()), "models.json"),
      JSON.stringify({ version: 1, aliases: { fast: { lab: "qwen3-8b" } } }),
    );
    expect(loadUserConfig().connections?.default?.models).toMatchObject({ fast: "qwen3-8b", balanced: "qwen3-32b" });
  });

  test("akm migrate apply writes the converted config, dropping nothing it could carry over", () => {
    writeConfig({
      configVersion: "0.9.0",
      engines: { lab: llm({ apiKey: "$LAB_KEY", temperature: 0.2 }), claude: { kind: "agent", platform: "claude" } },
      defaults: { llmEngine: "lab", improveStrategy: "default" },
    });
    expect(normalizeConfigFile(getConfigPath(), { apply: true }).applied).toBe(true);
    const written = JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as Dict;
    expect(written.engines).toBeUndefined();
    expect(written.defaults).toBeUndefined();
    expect(written.connections).toEqual({
      default: {
        endpoint: "http://lab:8080/v1/chat/completions",
        apiKey: "$LAB_KEY",
        temperature: 0.2,
        models: { fast: "qwen3-32b", balanced: "qwen3-32b", reasoning: "qwen3-32b" },
      },
    });
    expect(written.harnesses).toEqual({ claude: {} });
    expect((written.improve as Dict).strategy).toBe("default");
    expect(normalizeConfigFile(getConfigPath(), { apply: false }).changed).toBe(false);
  });
});

describe("the example configs load unchanged and validate", () => {
  const examples = path.join(import.meta.dir, "fixtures", "config-examples");

  test.each(["1-basic", "2-harness", "3-power"])("%s.jsonc", (name) => {
    const raw = JSON.parse(stripJsonComments(fs.readFileSync(path.join(examples, `${name}.jsonc`), "utf8"))) as Dict;
    // Already the current form: the converter leaves it alone.
    expect(convertEngineConfig(raw).changed).toBe(false);
    expect(AkmConfigSchema.safeParse({ configVersion: "0.9.0", semanticSearchMode: "off", ...raw }).success).toBe(true);
    // Every key is one akm reads or a request field.
    expect(unknownConfigKeyPaths({ configVersion: "0.9.0", ...raw })).toEqual([]);
  });

  test("3-power.jsonc: triage runs on the anthropic connection's reasoning model, and the quality gate judges on anthropic", () => {
    const raw = JSON.parse(stripJsonComments(fs.readFileSync(path.join(examples, "3-power.jsonc"), "utf8"))) as Dict;
    const config = AkmConfigSchema.parse({ configVersion: "0.9.0", semanticSearchMode: "off", ...raw }) as AkmConfig;
    const triage = resolveImproveExecution({
      config,
      processName: "triage-judgment",
      process: "triage",
      alias: "balanced",
    })?.runner;
    expect(triage).toMatchObject({ kind: "connection", name: "anthropic", model: "claude-opus-4-7" });
    const distill = resolveImproveExecution({ config, processName: "distill", alias: "fast" })?.runner;
    expect(distill).toMatchObject({ kind: "connection", name: "default", model: "qwen3-32b" });
    // Nothing names a model for the gate's judge, so it asks for the shipped judge alias: `balanced`.
    expect(resolveQualityGateJudge(config, undefined, "reflect")).toMatchObject({
      kind: "connection",
      name: "anthropic",
      model: "claude-sonnet-4-5",
    });
  });
});
