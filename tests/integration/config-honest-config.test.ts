// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// B10-41/46/48/50 and the migrate part of B10-40: config warnings say what is true and print once, background reads
// do not warn, config display redacts every credential, migrate drops a removed improve strategy with a note.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { usageReportEnabled } from "../../src/cli/usage-report";
import { akmConfigDiff, listConfig } from "../../src/commands/config-cli";
import { loadConfig, normalizeConfigFile, resetConfigCache } from "../../src/core/config/config";
import { getConfigPath } from "../../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";

beforeEach(() => resetConfigCache());
afterEach(() => resetConfigCache());

function writeConfig(value: unknown, file = getConfigPath()): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function captureWarnings(run: () => void, warnings: string[] = []): string[] {
  _resetWarnOnceForTests();
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
  try {
    run();
    return warnings;
  } finally {
    _setWarnSinkForTests(undefined);
  }
}

describe("config warnings say what is true, once (B10-48)", () => {
  test("an unknown key's warning names the file to edit and does not promise migrate apply", () => {
    const file = writeConfig({ configVersion: "0.9.0", fooBar: 1 });
    const warnings = captureWarnings(() => loadConfig());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`remove it from ${file}`);
    expect(warnings[0]).not.toContain("migrate apply");
  });

  test("an unknown key in an extends base names the base file", () => {
    const base = writeConfig({ fooBar: 1 }, path.join(path.dirname(getConfigPath()), "base.json"));
    writeConfig({ configVersion: "0.9.0", extends: base });
    const warnings = captureWarnings(() => loadConfig());
    const named = warnings.filter((w) => w.includes("fooBar"));
    expect(named).toHaveLength(1);
    expect(named[0]).toContain(`remove it from ${base}`);
  });

  test("a key the schema refuses with its own message is not also reported as unknown", () => {
    writeConfig({ configVersion: "0.9.0", stashDir: "/somewhere" });
    const warnings = captureWarnings(() => {
      expect(() => loadConfig()).toThrow("stashDir is not supported");
    });
    expect(warnings.filter((w) => w.includes("stashDir"))).toEqual([]);
  });

  test("the background usage-report read does not warn, so akm migrate prints each warning once (the child's own load)", () => {
    writeConfig({ configVersion: "0.9.0", fooBar: 1 });
    expect(captureWarnings(() => usageReportEnabled())).toEqual([]);
  });

  test("a read made with warn: false emits nothing and leaves the later load to warn", () => {
    writeConfig({ configVersion: "0.9.0", fooBar: 1 });
    const seen: string[] = [];
    let afterQuietRead: string[] = [];
    const warnings = captureWarnings(() => {
      loadConfig({ warn: false });
      afterQuietRead = [...seen];
      loadConfig();
    }, seen);
    expect(afterQuietRead).toEqual([]);
    expect(warnings.filter((w) => w.includes("fooBar"))).toHaveLength(1);
  });
});

describe("config display redacts by the credential-name rule (B10-50)", () => {
  test("list and diff never print a token field or an Authorization header value", () => {
    const secrets = {
      configVersion: "0.9.0",
      connections: {
        lab: {
          endpoint: "https://lab.test/v1",
          token: "TOKEN-ONE",
          headers: { Authorization: "Bearer TOKEN999", "x-api-key": "K123" },
        },
      },
    };
    writeConfig(secrets);
    const listed = JSON.stringify(listConfig(loadConfig()));
    expect(listed).not.toContain("TOKEN-ONE");
    expect(listed).not.toContain("TOKEN999");
    expect(listed).not.toContain("K123");
    const other = writeConfig(
      {
        configVersion: "0.9.0",
        connections: {
          lab: { endpoint: "https://other.test/v1", token: "TOKEN-TWO", headers: { Authorization: "Bearer TOKEN888" } },
        },
      },
      path.join(path.dirname(getConfigPath()), "other.json"),
    );
    const diff = JSON.stringify(akmConfigDiff(other));
    for (const value of ["TOKEN-ONE", "TOKEN-TWO", "TOKEN999", "TOKEN888", "K123"]) expect(diff).not.toContain(value);
    expect(diff).toContain("other.test");
  });

  test("an environment reference to a credential stays visible", () => {
    writeConfig({
      configVersion: "0.9.0",
      connections: { lab: { endpoint: "https://lab.test/v1", apiKey: "$LAB_KEY" } },
    });
    expect(JSON.stringify(listConfig(loadConfig()))).toContain("$LAB_KEY");
  });
});

describe("migrate drops a removed improve strategy with a note (B10-40, migrate part)", () => {
  test("improve.strategy naming a strategy 0.10 removed is dropped; the note names it", () => {
    writeConfig({ configVersion: "0.9.0", defaults: { improveStrategy: "quick" } });
    const applied = normalizeConfigFile(getConfigPath(), { apply: true });
    expect(applied.applied).toBe(true);
    expect(applied.notes?.some((note) => note.includes('"quick"') && note.includes("removed in 0.10"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).improve?.strategy).toBeUndefined();
  });

  test("improve.strategy: graph-refresh is dropped with the same note", () => {
    writeConfig({ configVersion: "0.9.0", improve: { strategy: "graph-refresh" } });
    const applied = normalizeConfigFile(getConfigPath(), { apply: true });
    expect(applied.notes?.some((note) => note.includes('"graph-refresh"'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).improve?.strategy).toBeUndefined();
  });

  test("a removed name the file defines under improve.strategies is the person's own and stays", () => {
    writeConfig({ configVersion: "0.9.0", improve: { strategy: "quick", strategies: { quick: {} } } });
    normalizeConfigFile(getConfigPath(), { apply: true });
    expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).improve?.strategy).toBe("quick");
  });
});
