// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The CLI reads only the current config shape. A host that has not run `akm migrate apply` is told, and is never
 * silently moved to another connection: the retired `engines` form is named once and converts to nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadUserConfig, mutateConfig, resetConfigCache } from "../src/core/config/config";
import { getConfigPath } from "../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { resolveTarget } from "../src/integrations/agent/resolution";

beforeEach(() => resetConfigCache());
afterEach(() => resetConfigCache());

function writeConfig(value: unknown): void {
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify(value));
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

const ENGINES = {
  configVersion: "0.9.0",
  engines: { lab: { kind: "llm", endpoint: "http://lab:8080/v1/chat/completions", model: "m" } },
  defaults: { llmEngine: "lab" },
};

describe("a config still in the retired engines form", () => {
  test("is not converted: it yields no connection or harness, and model work stops instead of moving elsewhere", () => {
    writeConfig(ENGINES);
    const config = loadUserConfig();
    expect(config.connections ?? {}).toEqual({});
    expect(config.harnesses ?? {}).toEqual({});
    expect(() => resolveTarget({ config, modelWork: true, layers: [] })).toThrow(/nothing to run model work on/);
  });

  test("is named once per key, with the command that converts it", () => {
    writeConfig(ENGINES);
    const warnings = loadWarnings();
    for (const key of ["engines", "defaults"]) {
      const named = warnings.filter((w) => w.includes(`"${key}"`));
      expect(named).toHaveLength(1);
      expect(named[0]).toContain("akm migrate apply");
    }
  });

  test("is left as written by an ordinary write", () => {
    writeConfig({ ...ENGINES, semanticSearchMode: "off" });
    expect(mutateConfig((current) => ({ ...current, output: { format: "text" } })).written).toBe(true);
    const after = JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;
    expect(after.engines).toEqual(ENGINES.engines);
    expect(after.defaults).toEqual(ENGINES.defaults);
    expect(after).not.toHaveProperty("connections");
  });
});

describe("a models.json beside the config", () => {
  test("is not read: the runtime folds nothing from it", () => {
    writeConfig({
      configVersion: "0.9.0",
      connections: { lab: { endpoint: "http://lab:8080/v1", models: { fast: "mine" } } },
    });
    fs.writeFileSync(
      path.join(path.dirname(getConfigPath()), "models.json"),
      JSON.stringify({ version: 1, aliases: { balanced: { "*": "wild" } } }),
    );
    try {
      expect(loadUserConfig().connections?.lab?.models).toEqual({ fast: "mine" });
    } finally {
      fs.rmSync(path.join(path.dirname(getConfigPath()), "models.json"), { force: true });
    }
  });
});
