// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The config-file selector: `--config <file>` / `AKM_CONFIG_FILE` choose the installation, and the
 * file's `paths` key names where its data, state and cache live.
 *
 *   - the path resolution (`core/paths.ts`): precedence, credentials and the lock beside the file;
 *   - the `paths` key: absolute, `~`, file-relative, cached per file and mtime, a bad value fatal;
 *   - the `--config` prescan (`applyEarlyConfigFlag`) and the flag as the CLI takes it;
 *   - what children are handed (`childProcessEnv`, dispatch to `task run`) and which installation owns
 *     the OS scheduler (`movedLocations`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyEarlyConfigFlag } from "../src/cli";
import { resetConfigCache, saveConfig } from "../src/core/config/config";
import { getConfigLockPath } from "../src/core/config/config-io";
import { ConfigError } from "../src/core/errors";
import { childProcessEnv, getCacheDir, getConfigDir, getConfigPath, getDataDir, getStateDir } from "../src/core/paths";
import { dispatchDueTasks } from "../src/tasks/dispatch";
import { movedLocations } from "../src/tasks/installation";
import { runCliCapture } from "./_helpers/cli";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage } from "./_helpers/sandbox";

let storage: IsolatedAkmStorage;
let dir: string;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  dir = fs.mkdtempSync(path.join(storage.root, "selector-"));
});

afterEach(() => {
  storage.cleanup();
});

const write = (file: string, text: string): string => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};

describe("the selected config file", () => {
  test("AKM_CONFIG_FILE is the config path, and does not move the config directory", () => {
    const file = path.join(dir, "etc", "akm.json");
    const env = { AKM_CONFIG_FILE: file, XDG_CONFIG_HOME: "/xdg", HOME: "/home/me" };
    expect(getConfigPath(env)).toBe(file);
    expect(getConfigDir(env)).toBe(path.join("/xdg", "akm"));
  });

  test("a relative AKM_CONFIG_FILE is resolved against the cwd", () => {
    expect(getConfigPath({ AKM_CONFIG_FILE: "rel/akm.json" })).toBe(path.resolve("rel/akm.json"));
  });

  test("it beats XDG_CONFIG_HOME, and with it set AKM_BUNDLE_DIR is ignored", () => {
    const file = path.join(dir, "chosen.json");
    const env = {
      AKM_CONFIG_FILE: file,
      XDG_CONFIG_HOME: "/xdg",
      AKM_BUNDLE_DIR: "/tmp/sandbox-bundle",
      HOME: "/home/me",
    };
    expect(getConfigPath(env)).toBe(file);
    expect(getConfigDir(env)).toBe(path.join("/xdg", "akm"));
  });

  test("an empty AKM_CONFIG_FILE selects nothing: the default file", () => {
    expect(getConfigPath({ AKM_CONFIG_FILE: "  ", XDG_CONFIG_HOME: "/xdg" })).toBe(
      path.join("/xdg", "akm", "config.json"),
    );
  });

  test("the config lock lives beside the selected file; credentials.json stays in the config directory", () => {
    const file = path.join(dir, "install", "akm.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return withEnv({ AKM_CONFIG_FILE: file }, () => {
      expect(getConfigLockPath()).toBe(`${file}.lck`);
      // The store the credential writer files a key in.
      saveConfig({ semanticSearchMode: "off" });
      expect(fs.existsSync(file)).toBe(true);
    });
  });
});

describe("the `paths` key", () => {
  const dataDirFrom = (config: string, extra: NodeJS.ProcessEnv = {}) => {
    const file = write(path.join(dir, "conf", "akm.json"), config);
    return getDataDir({ AKM_CONFIG_FILE: file, HOME: "/home/me", ...extra });
  };

  test("an absolute path is the location", () => {
    expect(dataDirFrom(JSON.stringify({ paths: { data: path.join(dir, "d") } }))).toBe(path.join(dir, "d"));
  });

  test("a relative path is relative to the config file, never the cwd", () => {
    expect(dataDirFrom(JSON.stringify({ paths: { data: "../state/here" } }))).toBe(path.join(dir, "state", "here"));
  });

  test("~ and ~/... are the home folder", () => {
    expect(dataDirFrom(JSON.stringify({ paths: { data: "~/akm-data" } }))).toBe(path.join(os.homedir(), "akm-data"));
  });

  test("data, state and cache are read independently, and each unset one is the default", () => {
    const file = write(path.join(dir, "akm.json"), JSON.stringify({ paths: { state: "st" } }));
    const env = { AKM_CONFIG_FILE: file, XDG_DATA_HOME: "/xdg/data", XDG_CACHE_HOME: "/xdg/cache" };
    expect(getStateDir(env)).toBe(path.join(dir, "st"));
    expect(getDataDir(env)).toBe(path.join("/xdg/data", "akm"));
    expect(getCacheDir(env)).toBe(path.join("/xdg/cache", "akm"));
  });

  test("a config with comments is read, as the config loader reads it", () => {
    expect(dataDirFrom('{\n  // where the database lives\n  "paths": { "data": "/var/lib/akm" }\n}\n')).toBe(
      "/var/lib/akm",
    );
  });

  test("`paths` beats XDG_DATA_HOME", () => {
    expect(dataDirFrom(JSON.stringify({ paths: { data: "/from/paths" } }), { XDG_DATA_HOME: "/xdg/data" })).toBe(
      "/from/paths",
    );
  });

  test("a missing file, or none naming `paths`, is the default", () => {
    expect(getDataDir({ AKM_CONFIG_FILE: path.join(dir, "absent.json"), XDG_DATA_HOME: "/xdg/data" })).toBe(
      path.join("/xdg/data", "akm"),
    );
    expect(dataDirFrom("{}", { XDG_DATA_HOME: "/xdg/data" })).toBe(path.join("/xdg/data", "akm"));
  });

  test.each([
    ["not an object", JSON.stringify({ paths: "/x" })],
    ["a number", JSON.stringify({ paths: { data: 5 } })],
    ["empty", JSON.stringify({ paths: { data: "  " } })],
    ["another user's home", JSON.stringify({ paths: { data: "~root/akm" } })],
  ])("a bad value (%s) is fatal, because it would move writes", (_name, config) => {
    expect(() => dataDirFrom(config)).toThrow(ConfigError);
  });

  test("a change to the file is read again; an unchanged one is not parsed again", () => {
    const file = write(path.join(dir, "akm.json"), JSON.stringify({ paths: { data: "/one" } }));
    const env = { AKM_CONFIG_FILE: file };
    expect(getDataDir(env)).toBe("/one");
    expect(getDataDir(env)).toBe("/one");
    write(file, JSON.stringify({ paths: { data: "/second-longer" } }));
    expect(getDataDir(env)).toBe("/second-longer");
  });

  test("a different file is a different cache entry", () => {
    const a = write(path.join(dir, "a.json"), JSON.stringify({ paths: { data: "/a" } }));
    const b = write(path.join(dir, "b.json"), JSON.stringify({ paths: { data: "/b" } }));
    expect(getDataDir({ AKM_CONFIG_FILE: a })).toBe("/a");
    expect(getDataDir({ AKM_CONFIG_FILE: b })).toBe("/b");
    expect(getDataDir({ AKM_CONFIG_FILE: a })).toBe("/a");
  });

  test("the default config file's `paths` apply with nothing selected", () => {
    const home = path.join(dir, "home");
    write(path.join(home, ".config", "akm", "config.json"), JSON.stringify({ paths: { cache: "/fast/cache" } }));
    expect(getCacheDir({ HOME: home })).toBe("/fast/cache");
  });
});

describe("applyEarlyConfigFlag", () => {
  const argv = (...rest: string[]) => ["bun", "cli.ts", ...rest];

  test("`--config <file>` and `--config=<file>` assign AKM_CONFIG_FILE, absolute, from the cwd", () => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      applyEarlyConfigFlag(argv("search", "x", "--config", "rel/one.json"));
      expect(process.env.AKM_CONFIG_FILE).toBe(path.join(fs.realpathSync(dir), "rel", "one.json"));
    } finally {
      process.chdir(cwd);
    }
    const two = path.join(dir, "two.json");
    applyEarlyConfigFlag(argv(`--config=${two}`, "search", "x"));
    expect(process.env.AKM_CONFIG_FILE).toBe(two);
  });

  test("the flag beats AKM_CONFIG_FILE already in the environment, and the last flag wins", () => {
    process.env.AKM_CONFIG_FILE = path.join(dir, "env.json");
    const last = path.join(dir, "last.json");
    applyEarlyConfigFlag(argv("info", "--config", path.join(dir, "first.json"), "--config", last));
    expect(process.env.AKM_CONFIG_FILE).toBe(last);
  });

  test("no flag leaves the environment as it was", () => {
    const fromEnv = path.join(dir, "env.json");
    process.env.AKM_CONFIG_FILE = fromEnv;
    applyEarlyConfigFlag(argv("info"));
    expect(process.env.AKM_CONFIG_FILE).toBe(fromEnv);
  });

  test("after `--` it is the command's own argument, not ours", () => {
    delete process.env.AKM_CONFIG_FILE;
    applyEarlyConfigFlag(argv("env", "run", "--", "other-tool", "--config", path.join(dir, "theirs.json")));
    expect(process.env.AKM_CONFIG_FILE).toBeUndefined();
  });

  test.each([
    [["info", "--config"]],
    [["info", "--config", "--format", "json"]],
    [["info", "--config="]],
    [["info", "--config", " "]],
  ])("a missing value is a usage error: %j", (rest) => {
    expect(() => applyEarlyConfigFlag(argv(...rest))).toThrow(/--config needs the path of a config file/);
  });
});

describe("--config on the CLI", () => {
  test("every command takes it, and `config path` reports the file it chose", async () => {
    const file = path.join(dir, "chosen", "akm.json");
    const result = await runCliCapture(["config", "path", "--config", file]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(file);
  });

  test("a config read goes to that file, not the default one", async () => {
    const file = write(path.join(dir, "akm.json"), JSON.stringify({ semanticSearchMode: "off" }));
    const result = await runCliCapture(["config", "get", "semanticSearchMode", "--config", file]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("off");
  });

  test("a file that does not exist reads as the default file's absence does: the defaults, no error", async () => {
    const result = await runCliCapture([
      "config",
      "get",
      "semanticSearchMode",
      "--config",
      path.join(dir, "absent.json"),
    ]);
    const plain = await runCliCapture(["config", "get", "semanticSearchMode"]);
    expect(result.code).toBe(plain.code);
    expect(result.stdout).toBe(plain.stdout);
  });

  test("the flag beats AKM_CONFIG_FILE", async () => {
    const flagged = path.join(dir, "flag.json");
    const result = await withEnv({ AKM_CONFIG_FILE: path.join(dir, "env.json") }, () =>
      runCliCapture(["config", "path", "--config", flagged]),
    );
    expect(result.stdout.trim()).toBe(flagged);
  });

  test("a real process: AKM_CONFIG_FILE alone selects the file, and the flag beats it", () => {
    const home = path.join(dir, "home");
    fs.mkdirSync(home, { recursive: true });
    const run = (args: string[], env: Record<string, string>) =>
      spawnSync(process.execPath, [path.join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: path.join(home, "c"), ...env },
      });
    const fromEnv = path.join(dir, "env.json");
    const fromFlag = path.join(dir, "flag.json");
    expect(run(["config", "path"], { AKM_CONFIG_FILE: fromEnv }).stdout.trim()).toBe(fromEnv);
    expect(run(["config", "path", "--config", fromFlag], { AKM_CONFIG_FILE: fromEnv }).stdout.trim()).toBe(fromFlag);
    expect(run(["config", "path"], {}).stdout.trim()).toBe(path.join(home, "c", "akm", "config.json"));
  });

  test("`akm info` reports the resolved locations, including those a `paths` key moved", async () => {
    const file = write(path.join(dir, "akm.json"), JSON.stringify({ paths: { data: "pd", state: "ps", cache: "pc" } }));
    const result = await runCliCapture(["info", "--config", file, "--detail", "full"]);
    expect(result.code).toBe(0);
    const info = JSON.parse(result.stdout) as Record<string, string>;
    expect(info).toMatchObject({
      configFile: file,
      dataDir: path.join(dir, "pd"),
      stateDir: path.join(dir, "ps"),
      cacheDir: path.join(dir, "pc"),
    });
  });
});

describe("what a child is handed", () => {
  test("childProcessEnv names the config file, absolute, whichever way it was found", () => {
    const file = path.join(dir, "akm.json");
    process.env.AKM_CONFIG_FILE = file;
    expect(childProcessEnv().AKM_CONFIG_FILE).toBe(file);
    delete process.env.AKM_CONFIG_FILE;
    expect(childProcessEnv().AKM_CONFIG_FILE).toBe(getConfigPath());
    expect(path.isAbsolute(childProcessEnv().AKM_CONFIG_FILE as string)).toBe(true);
  });

  test("childProcessEnv carries it, and a remapped XDG cannot move it", () => {
    const file = path.join(dir, "akm.json");
    process.env.AKM_CONFIG_FILE = file;
    expect(childProcessEnv().AKM_CONFIG_FILE).toBe(file);
  });

  // Risk 4 of the design: a command run with `--config` starts children through `spawn`, and under Bun 1.3.14
  // `process.env` is passed on only when `env` is. The dispatch's child is `akm task run`; here a stand-in that
  // reports the file it sees.
  test("`task dispatch` run with --config starts a `task run` that sees the same file", async () => {
    const file = path.join(dir, "install", "akm.json");
    applyEarlyConfigFlag(["bun", "cli.ts", "task", "dispatch", "--config", path.relative(process.cwd(), file)]);
    resetConfigCache();
    fs.mkdirSync(path.join(storage.stashDir, "tasks"), { recursive: true });
    fs.writeFileSync(
      path.join(storage.stashDir, "tasks", "due.yml"),
      'version: 4\nrun: "true"\nschedule: "* * * * *"\n',
    );
    saveConfig({
      semanticSearchMode: "off",
      defaultBundle: "stash",
      bundles: { stash: { path: storage.stashDir, writable: true } },
      scheduler: { enabled: ["stash//tasks/due"] },
    });
    expect(fs.existsSync(file)).toBe(true);

    const report = path.join(dir, "child-saw.txt");
    const stand = write(
      path.join(dir, "akm-standin.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(report)}, process.env.AKM_CONFIG_FILE ?? "unset");`,
    );
    const result = await dispatchDueTasks({
      launcher: [process.execPath, stand],
      statePath: path.join(storage.stateDir, "dispatch-minute"),
      logDir: path.join(dir, "logs"),
    });

    expect(result.failures).toEqual([]);
    expect(result.started).toEqual(["stash//tasks/due"]);
    for (let i = 0; i < 100 && !fs.existsSync(report); i++) await new Promise((r) => setTimeout(r, 50));
    expect(fs.readFileSync(report, "utf8")).toBe(file);
  });
});

describe("which installation owns the OS scheduler", () => {
  const home = () => path.join(dir, "home");

  test("the default file, however it is named, is the default installation", () => {
    expect(movedLocations({ HOME: home() })).toEqual([]);
    const byName = path.join(home(), ".config", "akm", "config.json");
    expect(movedLocations({ HOME: home(), AKM_CONFIG_FILE: byName })).toEqual([]);
  });

  test("another config file is a moved installation, even in the default folder", () => {
    const other = path.join(home(), ".config", "akm", "other.json");
    expect(movedLocations({ HOME: home(), AKM_CONFIG_FILE: other })).toContain("config");
    expect(movedLocations({ HOME: home(), AKM_CONFIG_FILE: path.join(dir, "elsewhere.json") })).toContain("config");
  });

  test("`paths` in the default file does not move it: dispatch reads that file", () => {
    write(path.join(home(), ".config", "akm", "config.json"), JSON.stringify({ paths: { data: "/fast/data" } }));
    expect(movedLocations({ HOME: home() })).toEqual([]);
  });

  test("an XDG variable that moves a location still does", () => {
    expect(movedLocations({ HOME: home(), XDG_CONFIG_HOME: path.join(dir, "x") })).toContain("config");
  });
});

describe("`akm config` and `paths`", () => {
  test("set, get, list and unset take paths.data, and the file holds the entry", async () => {
    const file = path.join(dir, "akm.json");
    const base = ["--config", file];
    expect((await runCliCapture(["config", "set", "paths.data", "/var/lib/akm", ...base])).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).paths).toEqual({ data: "/var/lib/akm" });
    const got = await runCliCapture(["config", "get", "paths.data", ...base]);
    expect(got.stdout).toContain("/var/lib/akm");
    expect((await runCliCapture(["config", "unset", "paths.data", ...base])).code).toBe(0);
    expect(fs.readFileSync(file, "utf8")).not.toContain("/var/lib/akm");
  });

  test("a value the config rejects as a path is refused by the loader too (a number)", async () => {
    const file = write(path.join(dir, "bad.json"), JSON.stringify({ paths: { data: 5 } }));
    const result = await runCliCapture(["config", "get", "semanticSearchMode", "--config", file]);
    expect(result.code).not.toBe(0);
  });
});
