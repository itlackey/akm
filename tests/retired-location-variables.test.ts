// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The retired location variables (`AKM_CONFIG_DIR`, `AKM_DATA_DIR`, `AKM_STATE_DIR`, `AKM_CACHE_DIR`) are a fatal error
 * when `AKM_CONFIG_FILE` is not set, never ignored (ignoring one opens empty databases at the default locations), and
 * the recovery surfaces stay reachable: `--version`, `--help`, `akm migrate`, `akm upgrade` and `akm info`. A library
 * caller gets the same error from the resolvers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { curate } from "../src/api";
import { readsConfigBestEffort, shouldBypassConfigStartup } from "../src/cli";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage } from "./_helpers/sandbox";

const cli = path.join(import.meta.dir, "..", "src", "cli.ts");
let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});
afterEach(() => storage.cleanup());

/** A real `akm` in a clean environment: HOME and XDG in the sandbox, plus `extra`. */
function akm(args: string[], extra: Record<string, string>) {
  return spawnSync(process.execPath, [cli, ...args], {
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
}

describe("a retired location variable, with AKM_CONFIG_FILE unset", () => {
  for (const name of ["AKM_CONFIG_DIR", "AKM_DATA_DIR", "AKM_STATE_DIR", "AKM_CACHE_DIR"]) {
    test(`${name}: a command that needs a location exits 78 naming the variable, \`akm migrate apply\` and AKM_CONFIG_FILE`, () => {
      const result = akm(["list"], { [name]: path.join(storage.root, "old") });

      expect(result.status).toBe(78);
      const error = JSON.parse(result.stderr || result.stdout) as { ok: boolean; error: string; code: string };
      expect(error.code).toBe("RETIRED_LOCATION_VARIABLE");
      expect(error.error).toContain(name);
      expect(error.error).toContain("akm migrate apply");
      expect(error.error).toContain("AKM_CONFIG_FILE");
    });
  }

  test("AKM_CONFIG_FILE set: the variable is ignored and the command runs", () => {
    const result = akm(["config", "path"], {
      AKM_DATA_DIR: path.join(storage.root, "old"),
      AKM_CONFIG_FILE: path.join(storage.root, "chosen.json"),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(path.join(storage.root, "chosen.json"));
  });
});

describe("what stays reachable so the host can recover", () => {
  const old = () => ({
    AKM_DATA_DIR: path.join(storage.root, "old"),
    AKM_CONFIG_DIR: path.join(storage.root, "old-config"),
  });

  test("--version and --help", () => {
    expect(akm(["--version"], old()).status).toBe(0);
    const help = akm(["--help"], old());
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("USAGE");
  });

  test("`akm migrate status` runs (the migrator carries the variables over), and says what to change", () => {
    const result = akm(["migrate", "status"], old());

    expect(result.status, result.stderr).toBe(0);
    const plan = JSON.parse(result.stdout) as { environment?: { unset: string[]; set?: Record<string, string> } };
    expect(plan.environment?.unset).toEqual(["AKM_CONFIG_DIR", "AKM_DATA_DIR"]);
    expect(plan.environment?.set).toEqual({
      AKM_CONFIG_FILE: path.join(storage.root, "old-config", "config.json"),
    });
  });

  test("`akm info` reports the problem at exit 0 instead of failing", () => {
    const result = akm(["info", "--format", "json"], old());

    expect(result.status, result.stderr).toBe(0);
    const info = JSON.parse(result.stdout) as { ok: boolean; configError?: string };
    expect(info.ok).toBe(true);
    expect(info.configError).toContain("akm migrate apply");
  });

  test("`akm upgrade` starts: it is past the startup config read and reaches its own argument checks", () => {
    // `--channel` is validated before any network call: a usage error (2), not the retired-variable error (78).
    const result = akm(["upgrade", "--channel", "bogus"], old());

    expect(result.status).toBe(2);
    expect(result.stderr + result.stdout).toContain("--channel must be latest or next");
    expect(result.stderr + result.stdout).not.toContain("RETIRED_LOCATION_VARIABLE");
  });

  test("the startup rules: upgrade and info read config best-effort, migrate/help/version bypass it", () => {
    const argv = (...rest: string[]) => ["bun", "cli.ts", ...rest];
    expect(readsConfigBestEffort(argv("upgrade"))).toBe(true);
    expect(readsConfigBestEffort(argv("info"))).toBe(true);
    expect(readsConfigBestEffort(argv("list"))).toBe(false);
    expect(shouldBypassConfigStartup(argv("migrate", "apply"))).toBe(true);
    expect(shouldBypassConfigStartup(argv("--version"))).toBe(true);
    expect(shouldBypassConfigStartup(argv("--help"))).toBe(true);
  });
});

describe("a library caller", () => {
  test("`akm-cli/api` gets the same error, from the resolver, not a silent empty database", async () => {
    await withEnv({ AKM_DATA_DIR: path.join(storage.root, "old"), AKM_CONFIG_FILE: undefined }, async () => {
      await expect(curate("anything")).rejects.toMatchObject({ code: "RETIRED_LOCATION_VARIABLE" });
    });
  });
});
