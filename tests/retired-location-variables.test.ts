// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The retired location variables (`AKM_CONFIG_DIR`, `AKM_DATA_DIR`, `AKM_STATE_DIR`, `AKM_CACHE_DIR`) are a fatal error
 * when `AKM_CONFIG_FILE` is not set, never ignored (ignoring one opens empty databases at the default locations), and
 * the recovery surfaces stay reachable: `--version`, `--help`, `akm migrate`, `akm upgrade` and `akm info`. A library
 * caller gets the same error from the resolvers.
 *
 * `AKM_BUNDLE_DIR` is retired the same way, with one difference: naming the bundle akm resolves without it (every
 * scheduler row 0.9.32 and 0.10 wrote inlines it) is ignored without a message, because nothing is lost. Naming any
 * other directory is fatal, since ignoring it would work in a different bundle than the host meant.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { curate } from "../src/api";
import { readsConfigBestEffort, shouldBypassConfigStartup } from "../src/cli";
import { list as listBundles } from "../src/workspace/bundles";
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

describe("AKM_BUNDLE_DIR", () => {
  const elsewhere = () => path.join(storage.root, "elsewhere");

  test("naming the bundle the config resolves without it is ignored: no error, no warning", () => {
    const result = akm(["bundle", "list"], { AKM_BUNDLE_DIR: storage.stashDir });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("the same directory under another spelling (trailing slash, a symlink) is the same bundle", () => {
    const alias = path.join(storage.root, "stash-alias");
    fs.symlinkSync(storage.stashDir, alias, "dir");

    for (const spelling of [`${storage.stashDir}${path.sep}`, alias, path.join(storage.stashDir, "..", "stash")]) {
      const result = akm(["bundle", "list"], { AKM_BUNDLE_DIR: spelling });
      expect(result.status, `${spelling}: ${result.stderr}`).toBe(0);
    }
  });

  test("naming another directory exits 78 naming the variable and `akm migrate apply`, and uses neither bundle", () => {
    fs.mkdirSync(elsewhere(), { recursive: true });

    const result = akm(["bundle", "list"], { AKM_BUNDLE_DIR: elsewhere() });

    expect(result.status).toBe(78);
    const error = JSON.parse(result.stderr || result.stdout) as { ok: boolean; error: string; code: string };
    expect(error.code).toBe("RETIRED_LOCATION_VARIABLE");
    expect(error.error).toContain("AKM_BUNDLE_DIR");
    expect(error.error).toContain("akm migrate apply");
    expect(error.error).toContain(elsewhere());
  });

  test("a host with no default bundle at all and the variable set is fatal too", () => {
    fs.rmSync(path.join(storage.configDir, "akm", "config.json"));

    const result = akm(["bundle", "list"], { AKM_BUNDLE_DIR: storage.stashDir });

    expect(result.status).toBe(78);
    expect(result.stderr + result.stdout).toContain("RETIRED_LOCATION_VARIABLE");
  });

  test("AKM_CONFIG_FILE set: the variable is ignored whatever it names", () => {
    const file = path.join(storage.configDir, "akm", "config.json");
    fs.mkdirSync(elsewhere(), { recursive: true });

    const result = akm(["bundle", "list"], { AKM_BUNDLE_DIR: elsewhere(), AKM_CONFIG_FILE: file });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("the config's component root counts: naming it is naming the bundle", () => {
    const root = path.join(storage.stashDir, "content");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(storage.configDir, "akm", "config.json"),
      JSON.stringify({
        defaultBundle: "main",
        bundles: { main: { path: storage.stashDir, writable: true, components: { main: { root: "content" } } } },
      }),
    );

    expect(akm(["bundle", "list"], { AKM_BUNDLE_DIR: root }).status).toBe(0);
    expect(akm(["bundle", "list"], { AKM_BUNDLE_DIR: path.join(storage.stashDir, "skills") }).status).toBe(78);
  });

  describe("what stays reachable so the host can recover, with a variable naming another bundle", () => {
    const other = () => ({ AKM_BUNDLE_DIR: elsewhere() });

    test("--version and --help", () => {
      expect(akm(["--version"], other()).status).toBe(0);
      const help = akm(["--help"], other());
      expect(help.status).toBe(0);
      expect(help.stdout).toContain("USAGE");
    });

    test("`akm migrate status` runs and lists the variable to unset", () => {
      const result = akm(["migrate", "status"], other());

      expect(result.status, result.stderr).toBe(0);
      const plan = JSON.parse(result.stdout) as { environment?: { unset: string[] } };
      expect(plan.environment?.unset).toEqual(["AKM_BUNDLE_DIR"]);
    });

    test("`akm info` reports the problem at exit 0 instead of failing", () => {
      const result = akm(["info", "--format", "json"], other());

      expect(result.status, result.stderr).toBe(0);
      const info = JSON.parse(result.stdout) as { ok: boolean; configError?: string };
      expect(info.ok).toBe(true);
      expect(info.configError).toContain("AKM_BUNDLE_DIR");
      expect(info.configError).toContain("akm migrate apply");
    });

    test("`akm upgrade` starts: it reaches its own argument checks, not the retired-variable error", () => {
      const result = akm(["upgrade", "--channel", "bogus"], other());

      expect(result.status).toBe(2);
      expect(result.stderr + result.stdout).toContain("--channel must be latest or next");
      expect(result.stderr + result.stdout).not.toContain("RETIRED_LOCATION_VARIABLE");
    });
  });

  describe("a library caller", () => {
    test("`akm-cli/api` and `akm-cli/workspace` get the same error from the resolver", async () => {
      await withEnv({ AKM_BUNDLE_DIR: elsewhere() }, async () => {
        await expect(curate("anything")).rejects.toMatchObject({ code: "RETIRED_LOCATION_VARIABLE" });
        await expect(listBundles()).rejects.toMatchObject({ code: "RETIRED_LOCATION_VARIABLE" });
      });
    });

    test("naming the resolved bundle is accepted", async () => {
      await withEnv({ AKM_BUNDLE_DIR: storage.stashDir }, async () => {
        await expect(listBundles()).resolves.toBeDefined();
      });
    });
  });
});
