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
import { setConfigValue, unsetConfigValue } from "../src/commands/config-cli";
import { resolveImprovePlan } from "../src/commands/improve/improve-strategies";
import { resolveQualityGateJudge } from "../src/commands/improve/stage";
import { stripJsonComments } from "../src/core/common";
import {
  type AkmConfig,
  type ConnectionConfig,
  loadConfig,
  loadUserConfig,
  mutateConfig,
  normalizeConfigFile,
  resetConfigCache,
  unknownConfigKeyPaths,
} from "../src/core/config/config";
import { AkmConfigSchema } from "../src/core/config/config-schema";
import { convertEngineConfig } from "../src/core/config/convert-engines";
import { UsageError } from "../src/core/errors";
import { getConfigPath } from "../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { withEnvSync } from "./_helpers/sandbox";

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

  test("an extraParams key that shadows a first-class setting is dropped with a note naming the key; the setting wins", () => {
    const { config, notes } = convert({
      engines: {
        lab: llm({
          apiKey: "$LAB_KEY",
          temperature: 0.2,
          maxTokens: 4096,
          extraParams: { temperature: 0.9, maxTokens: 1, top_p: 0.5 },
        }),
        other: llm({ apiKey: "$OTHER_KEY", extraParams: { temperature: 0.9 } }),
      },
    });
    expect((config.connections as Dict).lab).toMatchObject({ temperature: 0.2, max_tokens: 4096, top_p: 0.5 });
    expect((config.connections as Dict).lab).not.toHaveProperty("maxTokens");
    const text = notes.join("\n");
    expect(text).toContain("engines.lab: extraParams.temperature is dropped");
    expect(text).toContain("engines.lab: extraParams.maxTokens is dropped");
    expect(text).not.toContain("0.9");
    // With no first-class setting to shadow, the key is an ordinary request field.
    expect((config.connections as Dict).other).toMatchObject({ temperature: 0.9 });
    expect(text).not.toContain("engines.other");
  });

  test("drops provider and supportsJsonSchema, each with a note", () => {
    const { config, notes } = convert({ engines: { lab: llm({ provider: "lmstudio", supportsJsonSchema: false }) } });
    expect((config.connections as Dict).lab).not.toHaveProperty("provider");
    expect((config.connections as Dict).lab).not.toHaveProperty("supportsJsonSchema");
    expect(notes.join("\n")).toContain("engines.lab: provider is not a setting any more");
    expect(notes.join("\n")).toContain("supportsJsonSchema");
  });

  test("a key akm no longer reads from a file, the secret store or the config is not carried, and is named as the connection's to move", () => {
    for (const [keyed, field] of [
      [{ apiKeyFile: "/run/key" }, "apiKeyFile"],
      [{ apiKey: secretRef }, "apiKey"],
      [{ apiKey: "sk-literal" }, "apiKey"],
    ] as const) {
      const { config, keys } = convert({ engines: { lab: llm(keyed) } });
      expect((config.connections as Dict).lab).not.toHaveProperty("apiKey");
      expect((config.connections as Dict).lab).not.toHaveProperty("apiKeyFile");
      expect(keys).toEqual([{ engine: "lab", connection: "lab", field }]);
    }
  });

  test("a key held by the default engine belongs to the connection it is renamed to", () => {
    const { keys } = convert({
      engines: { lab: llm({ apiKeyFile: "/run/key" }), other: llm({ apiKey: "sk-other" }) },
      defaults: { llmEngine: "lab" },
    });
    expect(keys).toEqual([
      { engine: "lab", connection: "default", field: "apiKeyFile" },
      { engine: "other", connection: "other", field: "apiKey" },
    ]);
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

  test("AKM_LLM_API_KEY, the key of the engine defaults.llmEngine named, becomes that connection's $VAR key", () => {
    const engines = { lab: llm(), other: llm() };
    const defaults = { llmEngine: "lab" };
    const env = { AKM_LLM_API_KEY: "secret" } as NodeJS.ProcessEnv;
    const { config } = convert({ engines, defaults }, { env });
    expect((config.connections as Dict).default).toMatchObject({ apiKey: "$AKM_LLM_API_KEY" });
    // Only the default LLM engine read it; a more specific variable and an explicit key come first.
    expect(((config.connections as Dict).other as Dict).apiKey).toBeUndefined();
    const specific = convert(
      { engines, defaults },
      { env: { ...env, AKM_ENGINE_LAB_API_KEY: "specific" } as NodeJS.ProcessEnv },
    );
    expect((specific.config.connections as Dict).default).toMatchObject({ apiKey: "$AKM_ENGINE_LAB_API_KEY" });
    const explicit = convert({ engines: { lab: llm({ apiKey: "$OTHER" }) }, defaults }, { env });
    expect(((explicit.config.connections as Dict).default as Dict).apiKey).toBe("$OTHER");
    expect(((convert({ engines, defaults }, { env: {} }).config.connections as Dict).default as Dict).apiKey).toBe(
      undefined,
    );
  });

  test("an engine with no key, whose implicit variables are not set when it converts, gets one note naming them", () => {
    const engines = { lab: llm(), other: llm(), keyed: llm({ apiKeyFile: "/run/key" }) };
    const defaults = { llmEngine: "lab" };
    const keyNotes = (env: NodeJS.ProcessEnv) =>
      convert({ engines, defaults }, { env }).notes.filter((note) => note.includes("it names no key"));

    const unset = keyNotes({});
    expect(unset).toHaveLength(2);
    expect(unset[0]).toContain("engines.lab: it names no key, and AKM_ENGINE_LAB_API_KEY or AKM_LLM_API_KEY");
    expect(unset[0]).toContain("akm setup --api-key-env <VARIABLE>");
    expect(unset[1]).toContain("engines.other: it names no key, and AKM_ENGINE_OTHER_API_KEY,");
    // Set at migrate time, the variable is carried instead; a file key has its own note.
    expect(keyNotes({ AKM_LLM_API_KEY: "secret", AKM_ENGINE_OTHER_API_KEY: "secret" } as NodeJS.ProcessEnv)).toEqual(
      [],
    );
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

  test("an opencode-sdk engine with no llmEngine ran the user's own OpenCode: it becomes an opencode harness, keeping its model and every field a harness takes", () => {
    const { config, notes, targets } = convert({
      engines: {
        sdk: {
          kind: "agent",
          platform: "opencode-sdk",
          bin: "/opt/opencode/bin/opencode",
          workspace: "/work",
          agent: "akm-workflow",
          timeoutMs: 120000,
          model: "openai/gpt-5.6-terra",
        },
      },
    });
    expect(config.harnesses).toEqual({
      sdk: {
        platform: "opencode",
        bin: "/opt/opencode/bin/opencode",
        workspace: "/work",
        agent: "akm-workflow",
        timeoutMs: 120000,
        models: { fast: "openai/gpt-5.6-terra", balanced: "openai/gpt-5.6-terra", reasoning: "openai/gpt-5.6-terra" },
      },
    });
    expect(targets).toEqual({ sdk: { harness: "sdk" } });
    expect(notes.filter((note) => note.includes("engines.sdk"))).toEqual([]);
  });

  test("an opencode-sdk engine named opencode needs no platform key once it is an opencode harness", () => {
    const { config } = convert({ engines: { opencode: { kind: "agent", platform: "opencode-sdk" } } });
    expect(config.harnesses).toEqual({ opencode: {} });
  });

  test("a platform: opencode engine stays an opencode harness, keeping bin, args, agent and its model", () => {
    const { config } = convert({
      engines: {
        oc: {
          kind: "agent",
          platform: "opencode",
          bin: "opencode2",
          args: ["--standalone"],
          agent: "build",
          model: "x/y",
        },
      },
    });
    expect(config.harnesses).toEqual({
      oc: {
        platform: "opencode",
        bin: "opencode2",
        args: ["--standalone"],
        agent: "build",
        models: { fast: "x/y", balanced: "x/y", reasoning: "x/y" },
      },
    });
  });

  test("an opencode-sdk engine's args are dropped with a note: 0.9 did not pass them, and the harness would pass them in place of run", () => {
    const { config, notes } = convert({
      engines: { sdk: { kind: "agent", platform: "opencode-sdk", args: ["--print-logs"], model: "x/y" } },
    });
    expect((config.harnesses as Dict).sdk).not.toHaveProperty("args");
    expect(notes.filter((note) => note.startsWith("engines.sdk:"))).toEqual([
      "engines.sdk: args is dropped. 0.9 did not pass it to OpenCode, and the opencode harness would pass it in place of `run`.",
    ]);
  });

  test("an opencode-sdk engine over an llmEngine is akm's own runtime over that connection: it has no entry in config", () => {
    const { config, notes } = convert({
      engines: {
        sdk: { kind: "agent", platform: "opencode-sdk", llmEngine: "lab", model: "anthropic/x" },
        lab: llm(),
      },
    });
    expect(config).not.toHaveProperty("harnesses");
    expect(notes.some((note) => note.includes("engines.sdk") && note.includes("opencode-sdk"))).toBe(true);
  });

  test("the note for that runtime names what it drops, and only what the engine set", () => {
    const { notes } = convert({
      engines: {
        full: {
          kind: "agent",
          platform: "opencode-sdk",
          llmEngine: "lab",
          model: "m",
          bin: "/b",
          agent: "a",
          workspace: "/w",
          timeoutMs: 5,
        },
        bare: { kind: "agent", platform: "opencode-sdk", llmEngine: "lab" },
        lab: llm(),
      },
    });
    expect(notes.find((note) => note.startsWith("engines.full:"))).toContain(
      "its model, timeoutMs, workspace, bin, agent are dropped",
    );
    expect(notes.find((note) => note.startsWith("engines.bare:"))).not.toContain("dropped");
  });
});

describe("agent work that moves", () => {
  const runtimeEngines = {
    sdk: { kind: "agent", platform: "opencode-sdk", llmEngine: "lab" },
    lab: llm(),
    claude: { kind: "agent", platform: "claude" },
  };

  test("a note says so when defaults.engine named akm's runtime and one harness is configured", () => {
    const named = convert({ engines: runtimeEngines, defaults: { engine: "sdk", llmEngine: "lab" } });
    expect(named.notes.some((note) => note.includes("engines.sdk") && note.includes('harness "claude"'))).toBe(true);
  });

  test("with no defaults.engine, agent work ran on the user's OpenCode: the note says it now runs on the harness", () => {
    const unset = convert({ engines: runtimeEngines, defaults: { llmEngine: "lab" } });
    expect(
      unset.notes.some(
        (note) =>
          note.includes("Without defaults.engine") && note.includes("OpenCode") && note.includes('harness "claude"'),
      ),
    ).toBe(true);
  });

  test("with no defaults.engine and no harness, the note says it now runs on akm's runtime and how to keep OpenCode", () => {
    const { config, notes } = convert({ engines: { lab: llm() }, defaults: { llmEngine: "lab" } });
    expect(config).not.toHaveProperty("harnesses");
    const note = notes.find((text) => text.includes("Without defaults.engine"));
    expect(note).toContain("akm's own runtime");
    expect(note).toContain("akm setup --harness opencode");
  });

  test("no note when the harness was already the default agent, or the config holds no engine", () => {
    const harnessDefault = convert({
      engines: { lab: llm(), claude: { kind: "agent", platform: "claude" } },
      defaults: { engine: "claude", llmEngine: "lab" },
    });
    expect(harnessDefault.notes.filter((note) => note.includes("agent work"))).toEqual([]);
    const noEngines = convert({ defaults: { improveStrategy: "consolidate" } });
    expect(noEngines.notes).toEqual([]);
  });

  test("no note when the default agent engine is an opencode-sdk engine that is now the harness", () => {
    const { notes } = convert({
      engines: { lab: llm(), oc: { kind: "agent", platform: "opencode-sdk", model: "openai/gpt-5" } },
      defaults: { engine: "oc", llmEngine: "lab" },
    });
    expect(notes.filter((note) => note.includes("agent work"))).toEqual([]);
  });
});

describe("model work that ran on an agent engine", () => {
  const agents = { a: { kind: "agent", platform: "claude" }, b: { kind: "agent", platform: "codex" } };

  test("defaults.llmEngine naming an agent engine other than the default harness is noted: model work no longer runs there", () => {
    const { notes } = convert({ engines: agents, defaults: { engine: "a", llmEngine: "b" } });
    const note = notes.find((text) => text.startsWith('defaults.llmEngine "b"')) ?? "";
    expect(note).toContain("improve.harness");
    expect(note).toContain('harness "b"');
  });

  test("no note when that engine is the default harness and no connection takes model work first", () => {
    const same = convert({ engines: agents, defaults: { engine: "b", llmEngine: "b" } });
    expect(same.notes.filter((text) => text.startsWith("defaults.llmEngine"))).toEqual([]);
    const withConnection = convert({
      engines: { ...agents, lab: llm() },
      defaults: { engine: "b", llmEngine: "b" },
    });
    expect(withConnection.notes.some((text) => text.startsWith('defaults.llmEngine "b"'))).toBe(true);
  });

  test("defaults.llmEngine naming an opencode-sdk engine over a connection makes that connection the default", () => {
    const { config } = convert({
      engines: { rt: { kind: "agent", platform: "opencode-sdk", llmEngine: "lab" }, lab: llm(), other: llm() },
      defaults: { llmEngine: "rt" },
    });
    expect(Object.keys(config.connections as Dict).sort()).toEqual(["default", "other"]);
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

  test("an old default that moves aside is named in a note, for the scripts the migrator cannot reach", () => {
    const moved = convert({
      engines: { default: llm({ model: "old" }), lab: llm({ model: "new" }) },
      defaults: { llmEngine: "lab" },
    });
    expect(moved.notes.join("\n")).toContain(
      'engines.default is now connections.legacy-default, and "default" names another engine',
    );
    expect(moved.notes.join("\n")).toContain("--engine default");
    // Nothing moved aside, nothing to say.
    const kept = convert({ engines: { lab: llm() }, defaults: { llmEngine: "lab" } });
    expect(kept.notes.join("\n")).not.toContain("names another engine");
  });

  test("a legacy-default that already exists is not overwritten: the old default moves to the next free name, one name to one name", () => {
    const { config, targets, keys } = convert({
      engines: {
        default: llm({ model: "was-default", apiKey: "sk-default" }),
        "legacy-default": llm({ model: "was-legacy" }),
        lab: llm({ model: "was-lab" }),
      },
      defaults: { llmEngine: "lab" },
    });
    const connections = config.connections as Dict;
    expect(Object.keys(connections).sort()).toEqual(["default", "legacy-default", "legacy-default-2"]);
    const fast = (name: string) => ((connections[name] as Dict).models as Dict).fast;
    expect([fast("default"), fast("legacy-default"), fast("legacy-default-2")]).toEqual([
      "was-lab",
      "was-legacy",
      "was-default",
    ]);
    // Every reference to an old name follows the same map: the engines' targets, and the key an engine held.
    expect(targets).toEqual({
      default: { connection: "legacy-default-2" },
      "legacy-default": { connection: "legacy-default" },
      lab: { connection: "default" },
    });
    expect(keys).toEqual([{ engine: "default", connection: "legacy-default-2", field: "apiKey" }]);
  });

  test("the harness side moves a harness already called default aside the same way", () => {
    const { config, targets } = convert({
      engines: {
        default: { kind: "agent", platform: "gemini" },
        "legacy-default": { kind: "agent", platform: "pi" },
        claude: { kind: "agent", platform: "claude" },
      },
      defaults: { engine: "claude" },
    });
    expect(config.harnesses).toEqual({
      default: { platform: "claude" },
      "legacy-default-2": { platform: "gemini" },
      "legacy-default": { platform: "pi" },
    });
    expect(targets).toEqual({
      default: { harness: "legacy-default-2" },
      "legacy-default": { harness: "legacy-default" },
      claude: { harness: "default" },
    });
  });

  test("a name the file itself writes under connections is not taken by the entry that moves aside", () => {
    const { config } = convert({
      engines: { default: llm({ model: "was-default" }), lab: llm({ model: "was-lab" }) },
      connections: { "legacy-default": { endpoint: "http://own:1/v1", models: { fast: "own" } } },
      defaults: { llmEngine: "lab" },
    });
    const connections = config.connections as Dict;
    expect(Object.keys(connections).sort()).toEqual(["default", "legacy-default", "legacy-default-2"]);
    expect(((connections["legacy-default"] as Dict).models as Dict).fast).toBe("own");
    expect(((connections["legacy-default-2"] as Dict).models as Dict).fast).toBe("was-default");
  });

  test("the harness defaults.engine named is renamed default when there are several, keeping its platform", () => {
    const { config } = convert({
      engines: { claude: { kind: "agent", platform: "claude" }, opencode: { kind: "agent", platform: "opencode" } },
      defaults: { engine: "claude" },
    });
    expect(config.harnesses).toEqual({ default: { platform: "claude" }, opencode: {} });
  });

  test("defaults.engine naming one of several opencode-sdk engines makes that harness default, every reference to it follows", () => {
    const { config, targets } = convert({
      engines: {
        opencode: { kind: "agent", platform: "opencode-sdk", model: "openai/gpt-5.6-terra" },
        "opencode-workflow": {
          kind: "agent",
          platform: "opencode-sdk",
          model: "openai/gpt-5.6-terra",
          agent: "akm-workflow",
        },
        "opencode-lab": { kind: "agent", platform: "opencode-sdk", model: "lab/chat/qwen" },
        lab: llm(),
      },
      defaults: { engine: "opencode", llmEngine: "lab" },
      improve: {
        strategies: {
          nightly: { processes: { reflect: { engine: "opencode" }, distill: { engine: "opencode-lab" } } },
        },
      },
    });
    expect(Object.keys(config.harnesses as Dict)).toEqual(["default", "opencode-workflow", "opencode-lab"]);
    expect((config.harnesses as Dict).default).toMatchObject({ platform: "opencode" });
    expect(targets.opencode).toEqual({ harness: "default" });
    expect(targets["opencode-lab"]).toEqual({ harness: "opencode-lab" });
    expect((config.improve as Dict).processes).toEqual({
      reflect: { harness: "default" },
      distill: { harness: "opencode-lab" },
    });
    expect(Object.keys(config.connections as Dict)).toEqual(["default"]);
  });

  test("an engine called opencode-sdk is the default agent engine when defaults.engine names none, as the 0.9 fallback made it", () => {
    const { config } = convert({
      engines: {
        "opencode-sdk": { kind: "agent", platform: "opencode-sdk", model: "openai/gpt-5" },
        claude: { kind: "agent", platform: "claude" },
      },
    });
    expect(Object.keys(config.harnesses as Dict).sort()).toEqual(["claude", "default"]);
    expect((config.harnesses as Dict).default).toMatchObject({ platform: "opencode" });
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

  describe("on the harnesses the OpenCode engines became", () => {
    const columns = overlay({
      fast: { "opencode-sdk": "krang/fast", opencode: "cli/fast" },
      balanced: { "opencode-sdk": "krang/balanced", opencode: "cli/balanced" },
    });

    test("the opencode-sdk column reaches an opencode-sdk engine's harness and the opencode column does not", () => {
      const { config } = convert(
        { engines: { sdk: { kind: "agent", platform: "opencode-sdk" } } },
        { modelsOverlay: columns },
      );
      expect(modelsOf(config, "harnesses", "sdk")).toEqual({ fast: "krang/fast", balanced: "krang/balanced" });
    });

    test("the opencode column reaches a platform: opencode engine's harness and the opencode-sdk column does not", () => {
      const { config } = convert(
        { engines: { cli: { kind: "agent", platform: "opencode" } } },
        { modelsOverlay: columns },
      );
      expect(modelsOf(config, "harnesses", "cli")).toEqual({ fast: "cli/fast", balanced: "cli/balanced" });
    });

    test("an engine's own model stands over a column: the harness still runs it when a request names none", () => {
      const { config, notes } = convert(
        { engines: { sdk: { kind: "agent", platform: "opencode-sdk", model: "openai/gpt-5.6-terra" } } },
        { modelsOverlay: columns },
      );
      expect(modelsOf(config, "harnesses", "sdk")).toEqual({
        fast: "openai/gpt-5.6-terra",
        balanced: "openai/gpt-5.6-terra",
        reasoning: "openai/gpt-5.6-terra",
      });
      // One note for the column, not one per alias.
      expect(notes.filter((note) => note.includes('harness "sdk" has a model of its own'))).toHaveLength(1);
    });
  });

  test("a wildcard fills every connection with no column of its own for the alias, ahead of the engine's own model", () => {
    const { config } = convert(
      { engines },
      { modelsOverlay: overlay({ coder: { "*": "qwen3-coder" }, fast: { "*": "wild", other: "own" } }) },
    );
    expect(modelsOf(config, "connections", "lab").coder).toBe("qwen3-coder");
    expect(modelsOf(config, "connections", "other").coder).toBe("qwen3-coder");
    // A wildcard that differs from the engine's own model lands; an explicit column still beats it.
    expect(modelsOf(config, "connections", "lab").fast).toBe("wild");
    expect(modelsOf(config, "connections", "other").fast).toBe("own");
    // Only what nothing names is the engine's own model.
    expect(modelsOf(config, "connections", "lab").balanced).toBe("qwen3-32b");
    expect(modelsOf(config, "connections", "other").balanced).toBe("other-model");
  });

  test("the flat shorthand is the wildcard, and its inference becomes request fields", () => {
    const { config, notes } = convert(
      { engines },
      { modelsOverlay: overlay({ reasoning: { model: "qwen3-235b", inference: { effort: "high" } } }) },
    );
    for (const name of ["lab", "other"]) {
      expect(modelsOf(config, "connections", name).reasoning).toEqual({
        model: "qwen3-235b",
        reasoning_effort: "high",
      });
      expect(modelsOf(config, "connections", name).fast).toBe(name === "lab" ? "qwen3-32b" : "other-model");
    }
    expect(notes.join("\n")).not.toContain("names no configured connection");
  });

  test("the note that the config already names a model is made only for the config's own choice, not an explicit column that came first", () => {
    const current = { connections: { lab: { endpoint: "http://lab:8080/v1" } } };
    const { config, notes } = convert(current, {
      modelsOverlay: overlay({ balanced: { lab: "column", "*": "wild" } }),
    });

    expect(modelsOf(config, "connections", "lab")).toEqual({ balanced: "column" });
    expect(notes.join("\n")).not.toContain("already names a model");
  });

  test("a config already in the connections form gets its aliases filled, and keeps the ones it names", () => {
    const current = {
      connections: {
        lab: { endpoint: "http://lab:8080/v1", models: { fast: "mine" } },
        solo: { endpoint: "http://solo:8080/v1" },
      },
      harnesses: { claude: {} },
    };
    const { config, changed, notes } = convert(current, {
      modelsOverlay: overlay({
        fast: { lab: "ignored", solo: "solo-fast", claude: "haiku" },
        balanced: { "*": "wild", nowhere: "x" },
      }),
    });

    expect(changed).toBe(true);
    expect(modelsOf(config, "connections", "lab")).toEqual({ fast: "mine", balanced: "wild" });
    expect(modelsOf(config, "connections", "solo")).toEqual({ fast: "solo-fast", balanced: "wild" });
    expect(modelsOf(config, "harnesses", "claude")).toEqual({ fast: "haiku" });
    const text = notes.join("\n");
    expect(text).toContain("models.json fast.lab: the config already names a model for it");
    expect(text).toContain("models.json balanced.nowhere: names no configured connection or harness");
    // The input is not modified, and an overlay that places nothing changes nothing.
    expect(current.connections.solo).toEqual({ endpoint: "http://solo:8080/v1" });
    expect(convert(current, { modelsOverlay: overlay({ fast: { lab: "ignored" } }) }).changed).toBe(false);
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

describe("workflow.judgeEngine", () => {
  const engines = { lab: llm(), cloud: llm({ endpoint: "https://api.openai.com/v1/chat/completions" }) };

  test("naming the default connection is dropped with a note that the judge runs there still", () => {
    const { config, notes } = convert({ engines, defaults: { llmEngine: "lab" }, workflow: { judgeEngine: "lab" } });
    expect(config.workflow).toEqual({});
    expect(notes.join("\n")).toContain('workflow.judgeEngine: "lab" is the default connection');
  });

  test("naming any other engine is dropped with a note that the judge has moved", () => {
    const { notes } = convert({ engines, defaults: { llmEngine: "lab" }, workflow: { judgeEngine: "cloud" } });
    const note = notes.find((text) => text.includes("workflow.judgeEngine")) ?? "";
    expect(note).toContain('"cloud"');
    expect(note).toContain("has moved");
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

  test("triage's judgment, the nearer setting in 0.9, wins over the triage process's own, and the other is noted", () => {
    const { config, notes } = convert({
      engines: { lab: llm(), cloud: llm({ endpoint: "https://api.openai.com/v1/chat/completions" }) },
      improve: {
        strategies: {
          nightly: {
            processes: { triage: { enabled: true, engine: "lab", model: "fast", judgment: { engine: "cloud" } } },
          },
        },
      },
    });
    expect((config.improve as Dict).processes).toEqual({ triage: { connection: "cloud", model: "fast" } });
    expect(notes.join("\n")).toContain("improve.strategies.nightly.processes.triage.connection");
  });

  test("a per-process engine that was an opencode-sdk engine with no llmEngine becomes the harness it is now", () => {
    const { config, notes } = convert({
      engines: { lab: llm(), sdk: { kind: "agent", platform: "opencode-sdk" } },
      improve: { strategies: { nightly: { processes: { reflect: { engine: "sdk", model: "fast" } } } } },
    });
    expect((config.improve as Dict).processes).toEqual({ reflect: { harness: "sdk", model: "fast" } });
    expect(notes.filter((note) => note.includes("reflect.engine"))).toEqual([]);
  });

  test("a per-process engine that was a runtime over a connection that is gone is dropped with a note", () => {
    const { config, notes } = convert({
      engines: { sdk: { kind: "agent", platform: "opencode-sdk", llmEngine: "gone" } },
      improve: { strategies: { nightly: { processes: { reflect: { engine: "sdk", model: "fast" } } } } },
    });
    expect((config.improve as Dict).processes).toEqual({ reflect: { model: "fast" } });
    expect(notes.some((note) => note.includes("reflect.engine") && note.includes('"sdk"'))).toBe(true);
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

  test("whatever order the file lists them in, written connections and harnesses are read with the converted ones", () => {
    const engines = { lab: llm(), claude: { kind: "agent", platform: "claude" } };
    const written = {
      connections: { other: { endpoint: "http://other/v1", models: { fast: "o" } } },
      harnesses: { codex: {} },
    };
    for (const document of [
      { engines, ...written },
      { ...written, engines },
      { connections: written.connections, engines, harnesses: written.harnesses },
    ]) {
      const { config } = convert(document);
      expect(Object.keys(config.connections as Dict).sort()).toEqual(["lab", "other"]);
      expect(Object.keys(config.harnesses as Dict).sort()).toEqual(["claude", "codex"]);
    }
  });

  test("a written entry wins field by field, so a partial write beside engines edits the converted entry", () => {
    const { config } = convert({
      connections: { lab: { models: { fast: "edited" } } },
      engines: { lab: llm({ apiKey: "$LAB_KEY" }) },
    });
    expect((config.connections as Dict).lab).toEqual({
      endpoint: "http://lab:8080/v1/chat/completions",
      apiKey: "$LAB_KEY",
      models: { fast: "edited", balanced: "qwen3-32b", reasoning: "qwen3-32b" },
    });
  });

  test("connections already written win over a converted engine of the same name", () => {
    const { config } = convert({
      engines: { lab: llm({ model: "old" }) },
      connections: { lab: { endpoint: "http://new/v1", models: { fast: "new" } } },
    });
    expect((config.connections as Dict).lab).toMatchObject({ endpoint: "http://new/v1", models: { fast: "new" } });
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

  test("a models.json beside a config already in the connections form is folded in, with one warning that says so", () => {
    writeConfig({
      configVersion: "0.9.0",
      connections: { lab: { endpoint: "http://lab:8080/v1", models: { fast: "mine" } } },
    });
    fs.writeFileSync(
      path.join(path.dirname(getConfigPath()), "models.json"),
      JSON.stringify({ version: 1, aliases: { fast: { lab: "ignored" }, balanced: { "*": "wild" } } }),
    );
    let config!: ReturnType<typeof loadUserConfig>;
    const warnings = captureWarnings(() => {
      config = loadUserConfig();
    });
    expect(config.connections?.lab?.models).toEqual({ fast: "mine", balanced: "wild" });
    const folded = warnings.filter((w) => w.includes("models.json"));
    expect(folded).toHaveLength(1);
    expect(folded[0]).toContain("akm migrate apply");
    expect(folded[0]).not.toContain("retired engines/defaults form");
  });

  test("the one warning names each key the file holds that akm no longer reads, never its value", () => {
    writeConfig({
      configVersion: "0.9.0",
      engines: { lab: llm({ apiKeyFile: "/run/lab-key" }), other: llm({ apiKey: "sk-secret-literal" }) },
      defaults: { llmEngine: "lab" },
    });
    const warnings = captureWarnings(() => {
      loadUserConfig();
    });
    const text = warnings.join("\n");
    expect(text).toContain("engines.lab: its apiKeyFile is not read from config any more");
    expect(text).toContain("engines.other: its apiKey is not read from config any more");
    expect(text).toContain("credentials.json");
    expect(text).not.toContain("sk-secret-literal");
  });

  test("an engine's implicit key variables, set in the environment, keep working through the loader", () => {
    writeConfig({
      configVersion: "0.9.0",
      engines: { lab: llm(), other: llm() },
      defaults: { llmEngine: "lab" },
    });
    const loaded = withEnvSync({ AKM_LLM_API_KEY: "a", AKM_ENGINE_OTHER_API_KEY: "b" }, () => {
      resetConfigCache();
      return loadUserConfig();
    });
    expect(loaded.connections?.default?.apiKey).toBe("$AKM_LLM_API_KEY");
    expect(loaded.connections?.other?.apiKey).toBe("$AKM_ENGINE_OTHER_API_KEY");
    resetConfigCache();
    expect(loadUserConfig().connections?.default?.apiKey).toBeUndefined();
  });

  test("a connection written beside engines is read with the converted ones", () => {
    writeConfig({
      configVersion: "0.9.0",
      engines: { lab: llm() },
      defaults: { llmEngine: "lab" },
    });
    mutateConfig((current) => ({
      ...current,
      connections: {
        ...current.connections,
        extra: { endpoint: "http://extra/v1", models: { fast: "x" } },
        // A leaf of a converted entry: only that leaf is written.
        default: { ...(current.connections?.default as ConnectionConfig), timeoutMs: 5000 },
      },
    }));
    const after = JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as Dict;
    expect(after.engines).toBeDefined();
    expect(after.connections).toEqual({
      extra: { endpoint: "http://extra/v1", models: { fast: "x" } },
      default: { timeoutMs: 5000 },
    });
    resetConfigCache();
    const loaded = loadUserConfig();
    expect(Object.keys(loaded.connections ?? {}).sort()).toEqual(["default", "extra"]);
    expect(loaded.connections?.default).toMatchObject({
      endpoint: "http://lab:8080/v1/chat/completions",
      timeoutMs: 5000,
    });
  });

  test("reads the user models.json as the overlay", () => {
    writeConfig({ configVersion: "0.9.0", engines: { lab: llm() }, defaults: { llmEngine: "lab" } });
    fs.writeFileSync(
      path.join(path.dirname(getConfigPath()), "models.json"),
      JSON.stringify({ version: 1, aliases: { fast: { lab: "qwen3-8b" } } }),
    );
    expect(loadUserConfig().connections?.default?.models).toMatchObject({ fast: "qwen3-8b", balanced: "qwen3-32b" });
  });

  test("an ordinary write leaves the retired form in the file: engines, defaults, apiKeyFile and judgeEngine stay", () => {
    const document = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { lab: llm({ apiKeyFile: "/run/lab-key" }), claude: { kind: "agent", platform: "claude" } },
      defaults: { llmEngine: "lab", improveStrategy: "nightly" },
      workflow: { judgeEngine: "lab", maxConcurrency: 2 },
      improve: { strategies: { nightly: { processes: { reflect: { engine: "lab", model: "fast" } } } } },
    };
    writeConfig(document);

    const written = mutateConfig((current) => ({ ...current, output: { format: "text" } })).written;

    expect(written).toBe(true);
    const after = JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as Dict;
    // Everything the reader converts in memory is exactly as the file had it…
    expect(after.engines).toEqual(document.engines);
    expect(after.defaults).toEqual(document.defaults);
    expect(after.workflow).toEqual(document.workflow);
    expect(after.improve).toEqual(document.improve);
    expect(after).not.toHaveProperty("connections");
    expect(after).not.toHaveProperty("harnesses");
    // …and the edit is the only thing added.
    expect(after.output).toEqual({ format: "text" });
    // The retired form still reads as it did.
    resetConfigCache();
    expect(Object.keys(loadUserConfig().connections ?? {})).toEqual(["default"]);
  });

  describe("removing what the engines form supplies", () => {
    const engines = {
      configVersion: "0.9.0",
      engines: { lab: llm(), other: llm({ endpoint: "http://other/v1/chat/completions" }), claude: { kind: "agent" } },
      defaults: { llmEngine: "lab", improveStrategy: "default" },
    };

    /** The one refusal an edit that removes converted keys gets, and the file it leaves alone. */
    function refused(edit: (current: AkmConfig) => AkmConfig): string {
      writeConfig(engines);
      const before = fs.readFileSync(getConfigPath(), "utf8");
      let message = "";
      try {
        mutateConfig(edit);
      } catch (error) {
        expect(error).toBeInstanceOf(UsageError);
        message = (error as Error).message;
      }
      expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
      return message;
    }

    test.each([
      ["config unset connections.other", (current: AkmConfig) => unsetConfigValue(current, "connections.other")],
      ["config unset improve.strategy", (current: AkmConfig) => unsetConfigValue(current, "improve.strategy")],
      ["setup disabling agentic features", (current: AkmConfig) => ({ ...current, harnesses: {} })],
    ])("%s is refused, naming akm migrate apply, and changes nothing", (_name, edit) => {
      expect(refused(edit)).toContain("akm migrate");
    });

    test("one message names every converted key the edit removes", () => {
      const message = refused((current) => ({ ...current, connections: {}, harnesses: {} }));
      expect(message).toContain("connections.default");
      expect(message).toContain("connections.other");
      expect(message).toContain("harnesses.claude");
    });

    test("adding or changing a converted key still writes, and removal works once the file is converted", () => {
      writeConfig(engines);
      mutateConfig((current) => setConfigValue(current, "connections.other.timeoutMs", "5000"));
      expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).connections.other).toEqual({ timeoutMs: 5000 });

      expect(normalizeConfigFile(getConfigPath(), { apply: true }).applied).toBe(true);
      resetConfigCache();
      mutateConfig((current) => unsetConfigValue(current, "connections.other"));
      expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).connections.other).toBeUndefined();
    });
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

  test.each([
    ["1-basic", "off"],
    ["2-harness", "auto"],
    ["3-power", "auto"],
  ] as const)("%s.jsonc, loaded as written, reads semantic search as %s", (name, mode) => {
    // The examples carry no semanticSearchMode: an `embedding` block alone says semantic search is wanted.
    fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
    fs.copyFileSync(path.join(examples, `${name}.jsonc`), getConfigPath());
    resetConfigCache();
    expect(loadConfig().semanticSearchMode).toBe(mode);
    resetConfigCache();
  });

  test("3-power.jsonc, loaded from a file: triage judges on the anthropic connection's reasoning model, the quality gate on anthropic's balanced one", () => {
    const raw = JSON.parse(stripJsonComments(fs.readFileSync(path.join(examples, "3-power.jsonc"), "utf8"))) as Dict;
    const improve = raw.improve as Dict;
    fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
    fs.writeFileSync(
      getConfigPath(),
      JSON.stringify({
        ...raw,
        improve: {
          ...improve,
          strategy: "nightly",
          strategies: {
            nightly: { processes: { triage: { enabled: true, judgment: true }, distill: { enabled: true } } },
          },
        },
      }),
    );
    resetConfigCache();
    const config = loadConfig();
    const plan = resolveImprovePlan("nightly", config);
    expect(plan.triageJudgment).toMatchObject({ kind: "connection", name: "anthropic", model: "claude-opus-4-7" });
    expect(plan.processes.distill.runner).toMatchObject({ kind: "connection", name: "default", model: "qwen3-32b" });
    // Nothing names a model for the gate's judge, so it asks for the shipped judge alias: `balanced`.
    expect(resolveQualityGateJudge(config, undefined, "reflect")).toMatchObject({
      kind: "connection",
      name: "anthropic",
      model: "claude-sonnet-4-5",
    });
    resetConfigCache();
  });
});
