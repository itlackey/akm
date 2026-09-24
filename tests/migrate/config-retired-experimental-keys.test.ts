// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `experimental.workflowEngine` (retired in `e0655d13c`, before
 * `ExperimentalConfigSchema` went `.strict()` in `cc6152e02`) is tolerated
 * in memory by `stripRetiredExperimentalKeys`
 * (`src/core/config/retired-experimental-keys-shim.ts`) on every load.
 * `findConfigRetiredExperimentalKeys` (status, read-only) and
 * `applyConfigRetiredExperimentalKeys` (apply, persists once) are the
 * on-disk counterpart, in the same one-time-migration shape as
 * `./config-extra-params.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyConfigRetiredExperimentalKeys,
  findConfigRetiredExperimentalKeys,
} from "../../scripts/akm-migrate/migrate/config-retired-experimental-keys";

let root: string;
let configPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-config-retired-experimental-"));
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

describe("findConfigRetiredExperimentalKeys (status, read-only)", () => {
  test("reports nothing when the config file does not exist", () => {
    expect(findConfigRetiredExperimentalKeys(configPath)).toEqual({ removed: [] });
  });

  test("reports nothing for a config with no experimental section", () => {
    writeConfig({ configVersion: "0.9.0" });
    expect(findConfigRetiredExperimentalKeys(configPath)).toEqual({ removed: [] });
  });

  test("reports nothing for a config whose experimental keys are all live", () => {
    writeConfig({ configVersion: "0.9.0", experimental: { improveAutonomy: true } });
    expect(findConfigRetiredExperimentalKeys(configPath)).toEqual({ removed: [] });
  });

  test("reports the retired key, without touching the file", () => {
    writeConfig({ configVersion: "0.9.0", experimental: { improveAutonomy: true, workflowEngine: true } });
    expect(findConfigRetiredExperimentalKeys(configPath)).toEqual({ removed: ["experimental.workflowEngine"] });
    expect((readConfig().experimental as Record<string, unknown>).workflowEngine).toBe(true);
  });
});

describe("applyConfigRetiredExperimentalKeys (apply, persists once)", () => {
  test("does nothing when the config file does not exist", () => {
    expect(applyConfigRetiredExperimentalKeys(configPath)).toEqual({ applied: false, removed: [] });
    expect(fs.existsSync(configPath)).toBe(false);
  });

  test("does nothing when there is nothing retired to remove", () => {
    writeConfig({ configVersion: "0.9.0", experimental: { improveAutonomy: true } });
    const before = readConfig();
    expect(applyConfigRetiredExperimentalKeys(configPath)).toEqual({ applied: false, removed: [] });
    expect(readConfig()).toEqual(before);
  });

  test("removes the retired key from config.json, backing up the original first, and keeps live keys", () => {
    writeConfig({ configVersion: "0.9.0", experimental: { improveAutonomy: true, workflowEngine: true } });

    const result = applyConfigRetiredExperimentalKeys(configPath);
    expect(result).toEqual({ applied: true, removed: ["experimental.workflowEngine"] });

    const after = readConfig();
    expect(after.experimental).toEqual({ improveAutonomy: true });

    const backupDir = path.join(process.env.XDG_CACHE_HOME ?? "", "akm", "config-backups");
    expect(fs.existsSync(backupDir)).toBe(true);
    expect(fs.readdirSync(backupDir).some((name) => name.startsWith("config-"))).toBe(true);
  });

  test("drops experimental entirely when workflowEngine was its only key", () => {
    writeConfig({ configVersion: "0.9.0", experimental: { workflowEngine: true } });

    const result = applyConfigRetiredExperimentalKeys(configPath);
    expect(result).toEqual({ applied: true, removed: ["experimental.workflowEngine"] });
    expect(readConfig().experimental).toEqual({});
  });
});
