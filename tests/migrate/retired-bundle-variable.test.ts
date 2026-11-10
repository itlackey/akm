// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm migrate apply` and `AKM_BUNDLE_DIR`: akm no longer reads the variable, so the migrator is its one reader. A host
 * that named its working bundle with it keeps that bundle: `apply` registers the directory as `defaultBundle` (as
 * `akm bundle create` does) unless the file already names it as the default, `status` reports that as pending, and the
 * plan lists the variable to unset.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { normalizeConfigFile } from "../../scripts/akm-migrate/config/normalize";
import { carryOverRetiredLocations, retiredEnvironment } from "../../scripts/akm-migrate/retired-locations";
import { runMigration } from "../../scripts/akm-migrate/run-migrate";
import { resolveStashDir } from "../../src/core/common";
import { resetConfigCache } from "../../src/core/config/config";
import { getConfigPath } from "../../src/core/paths";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

type Dict = Record<string, unknown>;

let storage: IsolatedAkmStorage;
let named: string;

beforeEach(() => {
  // No working bundle in the config: the host's bundle is the one the variable names.
  storage = withIsolatedAkmStorage({}, { bundle: false });
  resetConfigCache();
  named = path.join(storage.root, "env-bundle");
  fs.mkdirSync(named, { recursive: true });
});
afterEach(() => {
  carryOverRetiredLocations({});
  resetConfigCache();
  fs.chmodSync(path.dirname(getConfigPath()), 0o755);
  storage.cleanup();
});

function writeConfig(value: Dict): void {
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(getConfigPath(), `${JSON.stringify(value, null, 2)}\n`);
}
const readConfig = (): Dict => JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as Dict;
/** `migrate`, in an environment that sets `AKM_BUNDLE_DIR`, as the migrator's own start carries it over. */
const migrate = (apply: boolean, env: NodeJS.ProcessEnv = { AKM_BUNDLE_DIR: named }) => {
  carryOverRetiredLocations(env);
  return normalizeConfigFile(getConfigPath(), { apply });
};
const bundles = (): Record<string, { path: string; writable?: boolean }> =>
  readConfig().bundles as Record<string, { path: string; writable?: boolean }>;

describe("a host that named its working bundle with AKM_BUNDLE_DIR", () => {
  test("`status` reports the registration as pending and writes nothing", () => {
    writeConfig({ semanticSearchMode: "off" });
    const before = fs.readFileSync(getConfigPath(), "utf8");

    const result = migrate(false);

    expect(result).toMatchObject({ changed: true, applied: false });
    expect(result.keys).toEqual(expect.arrayContaining(["bundles", "defaultBundle"]));
    expect(result.bundle?.defaultBundle).toBe("env-bundle");
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
  });

  test("`apply` registers it as the default bundle, and the config then resolves it", () => {
    writeConfig({ semanticSearchMode: "off" });

    const result = migrate(true);

    expect(result).toMatchObject({ changed: true, applied: true });
    expect(readConfig().defaultBundle).toBe("env-bundle");
    expect(bundles()["env-bundle"]).toMatchObject({ path: named, writable: true });
    resetConfigCache();
    expect(resolveStashDir()).toBe(named);
  });

  test("a second apply changes nothing: idempotent", () => {
    writeConfig({ semanticSearchMode: "off" });
    migrate(true);
    const after = fs.readFileSync(getConfigPath(), "utf8");

    const again = migrate(true);

    expect(again.changed).toBe(false);
    expect(again.bundle).toBeUndefined();
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(after);
  });

  test("a file that already names it as its default is left as it is", () => {
    writeConfig({ semanticSearchMode: "off", defaultBundle: "work", bundles: { work: { path: named } } });
    const before = fs.readFileSync(getConfigPath(), "utf8");

    const result = migrate(true);

    expect(result.changed).toBe(false);
    expect(result.bundle).toBeUndefined();
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
  });

  test("a bundle already configured at that directory, but not the default, becomes the default (no second entry)", () => {
    writeConfig({ semanticSearchMode: "off", bundles: { team: { path: named } } });

    migrate(true);

    expect(readConfig().defaultBundle).toBe("team");
    expect(Object.keys(bundles())).toEqual(["team"]);
  });

  test("a different default stays configured as a bundle; the variable's directory becomes the default", () => {
    const other = path.join(storage.root, "other");
    fs.mkdirSync(other);
    writeConfig({ semanticSearchMode: "off", defaultBundle: "other", bundles: { other: { path: other } } });

    migrate(true);

    expect(readConfig().defaultBundle).toBe("env-bundle");
    expect(Object.keys(bundles()).sort()).toEqual(["env-bundle", "other"]);
    expect(bundles().other?.path).toBe(other);
  });

  test("with no config file yet, apply makes one that names it", () => {
    const result = migrate(true);

    expect(result.applied).toBe(true);
    expect(readConfig().defaultBundle).toBe("env-bundle");
  });

  test("a directory that does not exist is not registered, and the notes say so", () => {
    writeConfig({ semanticSearchMode: "off" });

    const result = migrate(true, { AKM_BUNDLE_DIR: path.join(storage.root, "missing") });

    expect(result.changed).toBe(false);
    expect(readConfig()).not.toHaveProperty("defaultBundle");
    expect(result.notes?.join("\n")).toContain("is not a directory");
  });

  test("with AKM_CONFIG_FILE set too, the variable is still carried over", () => {
    writeConfig({ semanticSearchMode: "off" });

    migrate(true, { AKM_BUNDLE_DIR: named, AKM_CONFIG_FILE: getConfigPath() });

    expect(readConfig().defaultBundle).toBe("env-bundle");
  });
});

describe("the migrator's start (`carryOverRetiredLocations`)", () => {
  test("AKM_BUNDLE_DIR is removed from the environment and listed to unset", () => {
    const env: NodeJS.ProcessEnv = { AKM_BUNDLE_DIR: named, AKM_CONFIG_FILE: "/etc/akm.json" };

    carryOverRetiredLocations(env);

    expect(env).toEqual({ AKM_CONFIG_FILE: "/etc/akm.json" });
    expect(retiredEnvironment()).toEqual({ unset: ["AKM_BUNDLE_DIR"] });
  });

  test("a host that set none has nothing to unset", () => {
    carryOverRetiredLocations({});

    expect(retiredEnvironment()).toBeUndefined();
  });
});

// An image bakes the file (or mounts it read-only), so the migrator cannot register the bundle.
describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "a config file that cannot be written",
  () => {
    test("is reported with the entries for the image template, not a crash, and is left as it was", () => {
      writeConfig({ semanticSearchMode: "off" });
      const before = fs.readFileSync(getConfigPath(), "utf8");
      fs.chmodSync(getConfigPath(), 0o444);
      fs.chmodSync(path.dirname(getConfigPath()), 0o555);

      const result = migrate(true);

      expect(result).toMatchObject({ changed: false, applied: false, bundle: { defaultBundle: "env-bundle" } });
      expect(result.notes?.join("\n")).toContain("cannot be written");
      expect(result.notes?.join("\n")).toContain(JSON.stringify(result.bundle));
      expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    });

    test("blocks apply and leaves the scheduler alone, as an unwritable `paths` does", async () => {
      writeConfig({ semanticSearchMode: "off" });
      fs.chmodSync(getConfigPath(), 0o444);
      fs.chmodSync(path.dirname(getConfigPath()), 0o555);
      carryOverRetiredLocations({ AKM_BUNDLE_DIR: named });

      const plan = await runMigration({ apply: true });

      expect(plan.status).toBe("blocked");
      expect(plan.scheduler).toBeUndefined();
      expect(plan.blockers.join("\n")).toContain("cannot be written");
      expect(plan.blockers.join("\n")).toContain("env-bundle");
      expect(plan.environment).toEqual({ unset: ["AKM_BUNDLE_DIR"] });
    });
  },
);

// The executable `akm migrate` and `akm upgrade` run: a host that has upgraded but not migrated still has the variable.
describe("`akm-migrate apply` as a process, in an environment akm itself refuses", () => {
  const entry = path.join(import.meta.dir, "..", "..", "scripts", "akm-migrate.ts");
  const run = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, [entry, ...args], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: path.join(storage.root, "home"),
        // The scheduler step would write a crontab for a default installation; this one is moved by its config home.
        XDG_CONFIG_HOME: storage.configDir,
        ...env,
      },
    });

  test("registers the bundle the variable names in the config it finds, and says what to unset", () => {
    writeConfig({ semanticSearchMode: "off" });

    const result = run(["apply"], { AKM_BUNDLE_DIR: named });

    expect(result.status, result.stderr).toBe(0);
    const plan = JSON.parse(result.stdout) as Dict;
    expect(plan.environment).toEqual({ unset: ["AKM_BUNDLE_DIR"] });
    const file = JSON.parse(fs.readFileSync(path.join(storage.configDir, "akm", "config.json"), "utf8")) as Dict;
    expect(file.defaultBundle).toBe("env-bundle");
    expect((file.bundles as Dict)["env-bundle"]).toMatchObject({ path: named });
  });

  test("status reads the same plan and writes nothing", () => {
    writeConfig({ semanticSearchMode: "off" });
    const before = fs.readFileSync(getConfigPath(), "utf8");

    const result = run(["status"], { AKM_BUNDLE_DIR: named });

    const plan = JSON.parse(result.stdout) as { environment?: Dict; configFile?: Dict };
    expect(plan.environment).toEqual({ unset: ["AKM_BUNDLE_DIR"] });
    expect(plan.configFile).toMatchObject({ applied: false, changed: true, bundle: { defaultBundle: "env-bundle" } });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
  });

  test("after apply, akm itself runs with the variable gone (and refuses it when it names another bundle)", () => {
    writeConfig({ semanticSearchMode: "off" });
    run(["apply"], { AKM_BUNDLE_DIR: named });
    const cli = path.join(import.meta.dir, "..", "..", "src", "cli.ts");
    const akm = (extra: Record<string, string>) =>
      spawnSync(process.execPath, [cli, "bundle", "list"], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: path.join(storage.root, "home"),
          XDG_CONFIG_HOME: storage.configDir,
          XDG_DATA_HOME: storage.dataDir,
          XDG_CACHE_HOME: storage.cacheDir,
          XDG_STATE_HOME: storage.stateDir,
          ...extra,
        },
      });

    expect(akm({}).status).toBe(0);
    expect(akm({ AKM_BUNDLE_DIR: named }).status).toBe(0);
    expect(akm({ AKM_BUNDLE_DIR: path.join(storage.root, "elsewhere") }).status).toBe(78);
  });
});
