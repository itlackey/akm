// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Every registered `"ignored"` `RETIRED_CONFIG_KEYS` path — top-level
 * (`llm`, `profiles`, ...) and nested (`experimental.workflowEngine`) — is
 * tolerated in memory by `stripRetiredConfigKeys`
 * (`src/core/config/retired-config-keys-shim.ts`, driven by the
 * `RETIRED_CONFIG_KEYS` registry in `src/core/config/retired-keys.ts`) on
 * every load. `findConfigRetiredKeys` (status, read-only) and
 * `applyConfigRetiredKeys` (apply, persists once) are the on-disk
 * counterpart, in the same one-time-migration shape as
 * `./config-extra-params.ts`. Generalized from the `experimental.*`-only
 * `config-retired-experimental-keys.test.ts`: before this, the on-disk
 * migrator only ever cleaned up `experimental.*`, so the in-memory
 * warning's "Run `akm migrate apply`" advice could never be made true for a
 * top-level retired key.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyConfigRetiredKeys, findConfigRetiredKeys } from "../../scripts/akm-migrate/migrate/config-retired-keys";

let root: string;
let configPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-config-retired-keys-"));
  configPath = path.join(root, "config.json");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeConfig(value: unknown): void {
  fs.writeFileSync(configPath, JSON.stringify(value));
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
}

describe("findConfigRetiredKeys (status, read-only)", () => {
  test("reports nothing when the config file does not exist", () => {
    expect(findConfigRetiredKeys(configPath)).toEqual({ removed: [] });
  });

  test("reports nothing for a config carrying no retired keys", () => {
    writeConfig({ configVersion: "0.9.0", experimental: { improveAutonomy: true } });
    expect(findConfigRetiredKeys(configPath)).toEqual({ removed: [] });
  });

  test("lists a top-level and a nested retired key together, without touching the file", () => {
    writeConfig({
      configVersion: "0.9.0",
      llm: { model: "gpt-4" },
      profiles: { work: {} },
      experimental: { improveAutonomy: true, workflowEngine: true },
    });
    const plan = findConfigRetiredKeys(configPath);
    expect(new Set(plan.removed)).toEqual(new Set(["llm", "profiles", "experimental.workflowEngine"]));
    const before = readConfig();
    expect(before.llm).toEqual({ model: "gpt-4" });
    expect(before.profiles).toEqual({ work: {} });
    expect((before.experimental as Record<string, unknown>).workflowEngine).toBe(true);
  });
});

describe("applyConfigRetiredKeys (apply, persists once)", () => {
  test("does nothing when the config file does not exist", () => {
    expect(applyConfigRetiredKeys(configPath)).toEqual({ applied: false, removed: [] });
    expect(fs.existsSync(configPath)).toBe(false);
  });

  test("does nothing when there is nothing retired to remove", () => {
    writeConfig({ configVersion: "0.9.0", experimental: { improveAutonomy: true } });
    const before = readConfig();
    expect(applyConfigRetiredKeys(configPath)).toEqual({ applied: false, removed: [] });
    expect(readConfig()).toEqual(before);
  });

  test("removes a top-level, a second top-level, and a nested retired key, keeps every other key byte-for-byte, backs up once, and a second apply is a no-op", () => {
    writeConfig({
      configVersion: "0.9.0",
      defaultBundle: "work",
      bundles: { work: { path: "/srv/work", kind: "filesystem" } },
      llm: { model: "gpt-4" },
      profiles: { work: {} },
      experimental: { improveAutonomy: true, workflowEngine: true },
    });

    const backupDir = path.join(process.env.XDG_CACHE_HOME ?? "", "akm", "config-backups");
    const before = new Set(fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : []);

    const result = applyConfigRetiredKeys(configPath);
    expect(new Set(result.removed)).toEqual(new Set(["llm", "profiles", "experimental.workflowEngine"]));
    expect(result.applied).toBe(true);

    const after = readConfig();
    expect(after.llm).toBeUndefined();
    expect(after.profiles).toBeUndefined();
    expect(after.experimental).toEqual({ improveAutonomy: true });
    // Every other key survives byte-for-byte in value.
    expect(after.defaultBundle).toBe("work");
    expect(after.bundles).toEqual({ work: { path: "/srv/work", kind: "filesystem" } });

    // Exclude the rolling `config.latest.json` pointer (backupExistingConfig
    // always rewrites it): the timestamped snapshot is the one new backup.
    const added = fs.readdirSync(backupDir).filter((name) => !before.has(name) && name !== "config.latest.json");
    expect(added).toHaveLength(1);
    expect(fs.readFileSync(path.join(backupDir, added[0] as string), "utf8")).toContain("workflowEngine");

    // A second apply finds nothing left to remove and writes no new backup.
    const second = applyConfigRetiredKeys(configPath);
    expect(second).toEqual({ applied: false, removed: [] });
    const afterSecond = fs.readdirSync(backupDir).filter((name) => !before.has(name) && name !== "config.latest.json");
    expect(afterSecond).toEqual(added);
  });

  test("drops experimental entirely when workflowEngine was its only key", () => {
    writeConfig({ configVersion: "0.9.0", experimental: { workflowEngine: true } });

    const result = applyConfigRetiredKeys(configPath);
    expect(result).toEqual({ applied: true, removed: ["experimental.workflowEngine"] });
    expect(readConfig().experimental).toEqual({});
  });
});
