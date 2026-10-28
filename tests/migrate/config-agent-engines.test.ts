// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The 0.9 -> 0.10 config migration keeps agent engines. A config shaped like the
 * one that lost its OpenCode configuration on upgrade (two LLM engines and three
 * `opencode-sdk` engines, the user's own OpenCode with its own models) is migrated
 * end to end: the file, the assets that name the engines, and what the loader then
 * resolves agent work and model work to. Each test runs in an isolated config,
 * cache and data directory.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigration } from "../../scripts/akm-migrate/run-migrate";
import { loadUserConfig, resetConfigCache } from "../../src/core/config/config";
import { getConfigDir, getConfigPath } from "../../src/core/paths";
import { resolveTarget, retiredEngineSelection } from "../../src/integrations/agent/resolution";
import { type IsolatedAkmStorage, withEnvSync, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

type Dict = Record<string, unknown>;

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  resetConfigCache();
});
afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

const ENDPOINT = "https://models.example.test/v1/chat/completions";

/** The shape of the config that lost its agent engines: names, models and defaults anonymized. */
function ownerShapedConfig(): Dict {
  return {
    defaultBundle: "primary",
    bundles: {
      primary: { path: storage.stashDir, writable: true, components: { main: { root: ".", adapter: "akm" } } },
    },
    engines: {
      default: {
        kind: "llm",
        provider: "openai",
        endpoint: ENDPOINT,
        model: "chat/big-27b",
        apiKey: "$MODELS_KEY",
        temperature: 0,
        timeoutMs: 900000,
        supportsJsonSchema: true,
        contextLength: 120000,
        enableThinking: false,
        reasoningEffort: "none",
      },
      opencode: { kind: "agent", platform: "opencode-sdk", model: "openai/gpt-x" },
      "opencode-workflow": { kind: "agent", platform: "opencode-sdk", model: "openai/gpt-x", agent: "akm-workflow" },
      "opencode-lab": { kind: "agent", platform: "opencode-sdk", model: "lab/chat/big-27b" },
      "local-fast": {
        kind: "llm",
        provider: "openai",
        endpoint: ENDPOINT,
        model: "fast/small-9b",
        apiKey: "$MODELS_KEY",
        temperature: 0.3,
        timeoutMs: 600000,
        contextLength: 32768,
      },
    },
    defaults: { engine: "opencode", llmEngine: "default" },
    workflow: { judgeEngine: "default" },
  };
}

/** The user `models.json` they had: OpenCode model names per alias, under the `opencode` and `opencode-sdk` columns. */
const OWNER_MODELS_JSON = {
  version: 1,
  aliases: {
    fast: { claude: "claude-haiku", opencode: "lab/fast/small-9b", "opencode-sdk": "lab/fast/small-9b" },
    balanced: { opencode: "lab/chat/big-27b", "opencode-sdk": "lab/chat/big-27b" },
  },
};

const read = (relative: string): string => fs.readFileSync(path.join(storage.stashDir, relative), "utf8");

function write(relative: string, text: string): void {
  const file = path.join(storage.stashDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function writeOwnerShaped(): void {
  writeSandboxConfig(ownerShapedConfig());
  fs.writeFileSync(path.join(getConfigDir(), "models.json"), JSON.stringify(OWNER_MODELS_JSON));
}

const writtenConfig = (): Dict => JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as Dict;

describe("a config that ran agent work on the user's own OpenCode", () => {
  test("migrate apply keeps the OpenCode engines as harnesses, with their models, and the connections as they were", async () => {
    writeOwnerShaped();

    const plan = await runMigration({ apply: true });

    expect(plan.failedSteps).toBeUndefined();
    const config = writtenConfig();
    expect(config.engines).toBeUndefined();
    expect(config.defaults).toBeUndefined();
    // `defaults.engine` named `opencode` among three harnesses: that one is the default, called `default`.
    expect(config.harnesses).toEqual({
      default: {
        platform: "opencode",
        models: { fast: "openai/gpt-x", balanced: "openai/gpt-x", reasoning: "openai/gpt-x" },
      },
      "opencode-workflow": {
        platform: "opencode",
        agent: "akm-workflow",
        models: { fast: "openai/gpt-x", balanced: "openai/gpt-x", reasoning: "openai/gpt-x" },
      },
      "opencode-lab": {
        platform: "opencode",
        models: { fast: "lab/chat/big-27b", balanced: "lab/chat/big-27b", reasoning: "lab/chat/big-27b" },
      },
    });
    const connections = config.connections as Record<string, Dict>;
    expect(Object.keys(connections)).toEqual(["default", "local-fast"]);
    expect(connections.default).toMatchObject({
      endpoint: ENDPOINT,
      apiKey: "$MODELS_KEY",
      contextLength: 120000,
      timeoutMs: 900000,
      temperature: 0,
      models: { fast: "chat/big-27b", balanced: "chat/big-27b", reasoning: "chat/big-27b" },
    });
    expect(connections["local-fast"]?.models).toEqual({
      fast: "fast/small-9b",
      balanced: "fast/small-9b",
      reasoning: "fast/small-9b",
    });
    // judgeEngine named the default connection, so the judge runs where it did.
    expect(config.workflow).toEqual({});
    const notes = (plan.configFile?.notes ?? []).join("\n");
    expect(notes).toContain('workflow.judgeEngine: "default" is the default connection');
    // The models.json column that named the engines is not what their own model is.
    expect(notes).toContain('harness "default" has a model of its own');
    expect(notes).not.toContain("opencode-sdk is akm's own runtime");
  });

  test("the file read in memory and the file migrated are the same configuration", async () => {
    writeOwnerShaped();
    const inMemory = JSON.parse(JSON.stringify(loadUserConfig())) as Dict;
    resetConfigCache();

    await runMigration({ apply: true });
    resetConfigCache();
    const migrated = JSON.parse(JSON.stringify(loadUserConfig())) as Dict;

    expect(migrated).toEqual(inMemory);
    expect(Object.keys(inMemory.harnesses as Dict)).toEqual(["default", "opencode-workflow", "opencode-lab"]);
  });

  test("agent work runs on the default harness with its model, not on akm's runtime; model work stays on the connection", async () => {
    writeOwnerShaped();
    await runMigration({ apply: true });
    resetConfigCache();
    const config = loadUserConfig();

    expect(resolveTarget({ config, layers: [] })).toMatchObject({
      kind: "harness",
      name: "default",
      platform: "opencode",
      model: "openai/gpt-x",
    });
    expect(resolveTarget({ config, layers: [{ harness: "opencode-lab" }] })).toMatchObject({
      kind: "harness",
      name: "opencode-lab",
      model: "lab/chat/big-27b",
    });
    expect(resolveTarget({ config, layers: [{ harness: "opencode-workflow" }] })).toMatchObject({
      kind: "harness",
      name: "opencode-workflow",
      agent: "akm-workflow",
    });
    // A shared asset that says `harness: opencode` reaches the default among the harnesses that run OpenCode.
    expect(resolveTarget({ config, layers: [{ harness: "opencode" }] })).toMatchObject({ name: "default" });
    expect(resolveTarget({ config, modelWork: true, layers: [] })).toMatchObject({
      kind: "connection",
      name: "default",
      model: "chat/big-27b",
    });
  });

  test("an engine: selector keeps its meaning before the file is migrated, and afterwards names the same harness", async () => {
    writeOwnerShaped();
    resetConfigCache();
    const before = loadUserConfig();
    expect(retiredEngineSelection(before, "opencode")).toEqual({ kind: "harness", name: "default" });
    expect(retiredEngineSelection(before, "opencode-lab")).toEqual({ kind: "harness", name: "opencode-lab" });
    expect(retiredEngineSelection(before, "default")).toEqual({ kind: "connection", name: "default" });
  });

  test("assets and workflow units that name the engines are written as the harnesses they are now", async () => {
    writeOwnerShaped();
    write("commands/summarize.md", "---\nname: summarize\nengine: opencode-workflow\n---\nSummarize.\n");
    write("agents/reviewer.md", "---\nname: reviewer\nengine: opencode-lab\n---\nReview.\n");
    write(
      "workflows/select.md",
      "---\ntype: workflow\ndefaults:\n  engine: opencode-workflow\nsteps:\n  - id: pick\n    unit: { engine: opencode-lab }\n  - id: judge\n    unit: { engine: opencode }\n---\n",
    );
    write("tasks/daily.yml", "version: 4\nrun: echo hi\nengine: opencode-lab\n");

    const plan = await runMigration({ apply: true });

    expect(plan.failedSteps).toBeUndefined();
    expect(plan.assetEngineKeys).toMatchObject({ changed: 4, skipped: 0 });
    expect(read("commands/summarize.md")).toContain("harness: opencode-workflow");
    expect(read("agents/reviewer.md")).toContain("harness: opencode-lab");
    expect(read("tasks/daily.yml")).toContain("harness: opencode-lab");
    // `opencode` is the harness now called `default`.
    expect(read("workflows/select.md")).toBe(
      "---\ntype: workflow\ndefaults:\n  harness: opencode-workflow\nsteps:\n  - id: pick\n    unit: { harness: opencode-lab }\n  - id: judge\n    unit: { harness: default }\n---\n",
    );
    expect(plan.assetEngineKeys?.notes?.join("\n")).toContain("--engine opencode is now --harness default");
  });

  test("a copy of the config from before the migration is converted the same way by reading it", async () => {
    writeOwnerShaped();
    const plan = await runMigration({ apply: true });
    const backup = plan.configFile?.backupPath;
    expect(backup).toBeDefined();

    // What a beta user does: put the pre-migration copy in a scratch config directory and read what it converts to.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "akm-premigration-"));
    try {
      fs.mkdirSync(path.join(scratch, "akm"), { recursive: true });
      fs.copyFileSync(backup as string, path.join(scratch, "akm", "config.json"));
      resetConfigCache();
      const harnesses = withEnvSync({ XDG_CONFIG_HOME: scratch }, () => loadUserConfig().harnesses);
      expect(Object.keys(harnesses ?? {})).toEqual(["default", "opencode-workflow", "opencode-lab"]);
      expect(harnesses?.default?.models?.fast).toBe("openai/gpt-x");
    } finally {
      resetConfigCache();
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("an opencode-sdk engine that ran over an llmEngine", () => {
  test("is akm's own runtime over that connection: no harness, and the connection is the default", async () => {
    writeSandboxConfig({
      engines: {
        lab: { kind: "llm", endpoint: ENDPOINT, model: "chat/big-27b", apiKey: "$MODELS_KEY" },
        agent: { kind: "agent", platform: "opencode-sdk", llmEngine: "lab", model: "chat/big-27b" },
      },
      defaults: { engine: "agent", llmEngine: "lab" },
    });

    await runMigration({ apply: true });
    resetConfigCache();
    const config = loadUserConfig();

    expect(config.harnesses ?? {}).toEqual({});
    expect(Object.keys(config.connections ?? {})).toEqual(["default"]);
    expect(resolveTarget({ config, layers: [] })).toMatchObject({ kind: "connection", name: "default" });
  });
});

describe("a config with only LLM engines", () => {
  test("converts to connections as before, with no harness, and says where agent work ran", async () => {
    writeSandboxConfig({
      engines: {
        lab: { kind: "llm", endpoint: ENDPOINT, model: "chat/big-27b", apiKey: "$MODELS_KEY" },
        cloud: { kind: "llm", endpoint: ENDPOINT, model: "gpt-x", apiKey: "$MODELS_KEY" },
      },
      defaults: { llmEngine: "lab" },
    });

    const plan = await runMigration({ apply: true });
    const config = writtenConfig();

    expect(config.harnesses).toBeUndefined();
    expect(Object.keys(config.connections as Dict)).toEqual(["default", "cloud"]);
    resetConfigCache();
    expect(resolveTarget({ config: loadUserConfig(), layers: [] })).toMatchObject({ kind: "connection" });
    const note = (plan.configFile?.notes ?? []).find((text) => text.includes("Without defaults.engine"));
    expect(note).toContain("OpenCode");
    expect(note).toContain("akm setup --harness opencode");
  });
});
