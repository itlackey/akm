// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm migrate apply` and the `paths` key: a host that located its data, state or cache with
 * `AKM_DATA_DIR`, `AKM_STATE_DIR` or `AKM_CACHE_DIR` keeps them by the file naming them. The migrator is the one
 * reader of the retired variables: it carries them over first (`carryOverRetiredLocations`), because akm itself
 * refuses to start with one set.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { normalizeConfigFile } from "../../scripts/akm-migrate/config/normalize";
import { carryOverRetiredLocations } from "../../scripts/akm-migrate/retired-locations";
import { resetConfigCache } from "../../src/core/config/config";
import { getCacheDir, getConfigPath, getDataDir, getStateDir } from "../../src/core/paths";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage } from "../_helpers/sandbox";

type Dict = Record<string, unknown>;

let storage: IsolatedAkmStorage;
let dirs: { data: string; state: string; cache: string };

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  resetConfigCache();
  dirs = {
    data: path.join(storage.root, "env-data"),
    state: path.join(storage.root, "env-state"),
    cache: path.join(storage.root, "env-cache"),
  };
});
afterEach(() => {
  carryOverRetiredLocations({});
  resetConfigCache();
  fs.chmodSync(path.dirname(getConfigPath()), 0o755);
  storage.cleanup();
});

const environment = () => ({
  AKM_DATA_DIR: dirs.data,
  AKM_STATE_DIR: dirs.state,
  AKM_CACHE_DIR: dirs.cache,
});

function writeConfig(value: Dict): void {
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(getConfigPath(), `${JSON.stringify(value, null, 2)}\n`);
}
const readConfig = (): Dict => JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as Dict;
/** `migrate`, in an environment that sets the retired variables, as the migrator's own start carries them over. */
const migrate = (apply: boolean) => {
  carryOverRetiredLocations();
  return normalizeConfigFile(getConfigPath(), { apply });
};

describe("a host that set the location variables", () => {
  test("`status` reports the paths as pending and writes nothing", async () => {
    writeConfig({ semanticSearchMode: "off" });
    const before = fs.readFileSync(getConfigPath(), "utf8");

    const result = await withEnv(environment(), () => migrate(false));

    expect(result).toMatchObject({ changed: true, applied: false, paths: dirs });
    expect(result.keys).toContain("paths");
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
  });

  test("`apply` writes them as absolute paths, and the config then locates them", async () => {
    writeConfig({ semanticSearchMode: "off" });

    const result = await withEnv(environment(), () => migrate(true));

    expect(result).toMatchObject({ changed: true, applied: true, paths: dirs });
    expect(readConfig().paths).toEqual(dirs);
  });

  test("a second apply changes nothing: idempotent", async () => {
    writeConfig({ semanticSearchMode: "off" });
    await withEnv(environment(), () => migrate(true));
    const after = fs.readFileSync(getConfigPath(), "utf8");

    const again = await withEnv(environment(), () => migrate(true));

    expect(again.changed).toBe(false);
    expect(again.paths).toBeUndefined();
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(after);
  });

  test("a location the file already names stays as the file has it; only the others are added", async () => {
    writeConfig({ semanticSearchMode: "off", paths: { data: "kept-relative" } });

    const result = await withEnv(environment(), () => migrate(true));

    expect(result.paths).toEqual({ state: dirs.state, cache: dirs.cache });
    expect(readConfig().paths).toEqual({ data: "kept-relative", state: dirs.state, cache: dirs.cache });
  });

  test("a host that set none gets no `paths`", async () => {
    writeConfig({ semanticSearchMode: "off" });

    const result = await migrate(true);

    expect(result.changed).toBe(false);
    expect(readConfig()).not.toHaveProperty("paths");
  });

  test("with no config file yet, apply makes one that names them", async () => {
    const result = await withEnv(environment(), () => migrate(true));

    expect(result.applied).toBe(true);
    expect(readConfig().paths).toEqual(dirs);
  });
});

// Risk 6: an image bakes the file (or mounts it read-only), so the migrator cannot add `paths`.
describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "a config file that cannot be written",
  () => {
    test("is reported with the entries for the image template, not a crash, and is left as it was", async () => {
      writeConfig({ semanticSearchMode: "off" });
      const before = fs.readFileSync(getConfigPath(), "utf8");
      fs.chmodSync(getConfigPath(), 0o444);
      fs.chmodSync(path.dirname(getConfigPath()), 0o555);

      const result = await withEnv(environment(), () => migrate(true));

      expect(result).toMatchObject({ changed: false, applied: false, paths: dirs });
      expect(result.notes?.join("\n")).toContain("cannot be written");
      expect(result.notes?.join("\n")).toContain(JSON.stringify({ paths: dirs }));
      expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    });
  },
);

describe("the migrator's start (`carryOverRetiredLocations`)", () => {
  test("AKM_CONFIG_DIR becomes AKM_CONFIG_FILE, the other three become the run's locations, and none stays set", () => {
    const env: NodeJS.ProcessEnv = {
      AKM_CONFIG_DIR: path.join(storage.root, "old-config"),
      AKM_DATA_DIR: dirs.data,
      AKM_STATE_DIR: dirs.state,
      AKM_CACHE_DIR: dirs.cache,
    };

    carryOverRetiredLocations(env);

    expect(env).toEqual({ AKM_CONFIG_FILE: path.join(storage.root, "old-config", "config.json") });
    expect(getDataDir({ HOME: "/home/user" })).toBe(dirs.data);
    expect(getStateDir({ HOME: "/home/user" })).toBe(dirs.state);
    expect(getCacheDir({ HOME: "/home/user" })).toBe(dirs.cache);
  });

  test("a file the config names wins over a carried location", () => {
    carryOverRetiredLocations({ AKM_DATA_DIR: dirs.data });
    writeConfig({ semanticSearchMode: "off", paths: { data: "named" } });

    expect(getDataDir()).toBe(path.join(path.dirname(getConfigPath()), "named"));
  });

  test("an AKM_CONFIG_FILE already set stays; the retired variables are still removed", () => {
    const env: NodeJS.ProcessEnv = {
      AKM_CONFIG_FILE: "/etc/akm.json",
      AKM_CONFIG_DIR: "/old",
      AKM_DATA_DIR: dirs.data,
    };

    carryOverRetiredLocations(env);

    expect(env).toEqual({ AKM_CONFIG_FILE: "/etc/akm.json" });
  });
});

// The executable `akm migrate` and `akm upgrade` run: a host that has upgraded but not migrated still has the variables.
describe("`akm-migrate apply` as a process, in an environment akm itself refuses", () => {
  const entry = path.join(import.meta.dir, "..", "..", "scripts", "akm-migrate.ts");
  const run = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, [entry, ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: path.join(storage.root, "home"), ...env },
    });

  test("finds the config through AKM_CONFIG_DIR, writes `paths` into it, and says what to change in the environment", () => {
    const configDir = path.join(storage.root, "old-config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), `${JSON.stringify({ semanticSearchMode: "off" })}\n`);
    const home = path.join(storage.root, "home");
    fs.mkdirSync(home, { recursive: true });

    const result = run(["apply"], {
      AKM_CONFIG_DIR: configDir,
      AKM_DATA_DIR: dirs.data,
      AKM_STATE_DIR: dirs.state,
      AKM_CACHE_DIR: dirs.cache,
      // The scheduler step would write a crontab for a default installation; this one is moved by its file.
      XDG_CONFIG_HOME: path.join(storage.root, "xdg"),
    });

    expect(result.status, result.stderr).toBe(0);
    const plan = JSON.parse(result.stdout) as Dict;
    expect(plan.environment).toEqual({
      unset: ["AKM_CONFIG_DIR", "AKM_DATA_DIR", "AKM_STATE_DIR", "AKM_CACHE_DIR"],
      set: { AKM_CONFIG_FILE: path.join(configDir, "config.json") },
    });
    expect(JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8")).paths).toEqual(dirs);
  });

  test("status reads the same plan and writes nothing", () => {
    const configDir = path.join(storage.root, "old-config");
    fs.mkdirSync(configDir, { recursive: true });
    const file = path.join(configDir, "config.json");
    fs.writeFileSync(file, `${JSON.stringify({ semanticSearchMode: "off" })}\n`);
    const before = fs.readFileSync(file, "utf8");

    const result = run(["status"], {
      AKM_CONFIG_DIR: configDir,
      AKM_DATA_DIR: dirs.data,
      XDG_CONFIG_HOME: path.join(storage.root, "xdg"),
    });

    const plan = JSON.parse(result.stdout) as { environment?: Dict; configFile?: Dict };
    expect(plan.environment).toMatchObject({ set: { AKM_CONFIG_FILE: file } });
    expect(plan.configFile).toMatchObject({ applied: false, paths: { data: dirs.data } });
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  test("no retired variable, no `environment` in the plan", () => {
    const result = run(["status"], { XDG_CONFIG_HOME: path.join(storage.root, "xdg") });
    expect(JSON.parse(result.stdout)).not.toHaveProperty("environment");
  });
});
