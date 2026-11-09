/**
 * The test side of the isolation that `NODE_ENV=test` / `BUN_TEST` used to provide from inside `src/`. See
 * tests/_helpers/isolation-guard.ts and tests/_preload.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDataDir } from "../src/core/paths";
import { takeViolations, unsandboxedDirs } from "./_helpers/isolation-guard";

const CLI = path.resolve(import.meta.dir, "..", "src", "cli.ts");
const posixOnly = process.platform === "win32" ? test.skip : test;

afterEach(() => {
  // These tests provoke refusals on purpose; the preload would otherwise fail them for the recorded violation.
  takeViolations();
});

describe("NODE_ENV=test is not a sentinel in production code", () => {
  test("the data directory resolves from HOME whatever NODE_ENV and BUN_TEST say", () => {
    const home = { HOME: "/home/someone" };
    const plain = getDataDir(home, "linux");
    expect(getDataDir({ ...home, NODE_ENV: "test" }, "linux")).toBe(plain);
    expect(getDataDir({ ...home, BUN_TEST: "1" }, "linux")).toBe(plain);
    expect(plain).toBe(path.join("/home/someone", ".local", "share", "akm"));
  });
});

describe("the harness sandbox", () => {
  test("this test process resolves all four akm directories under the temp root", () => {
    expect(unsandboxedDirs(process.env)).toEqual([]);
  });

  test("an environment pointing at a real-looking home is named, directory by directory", () => {
    const outside = unsandboxedDirs({ HOME: "/home/someone" });
    expect(outside.map((d) => d.split("=")[0]).sort()).toEqual(["cache", "config", "data", "state"]);
  });

  test("one directory outside the temp root is enough, and only it is named", () => {
    const env = { ...process.env, XDG_DATA_HOME: "/home/someone/.local/share" };
    expect(unsandboxedDirs(env).map((d) => d.split("=")[0])).toEqual(["data"]);
  });

  test("an environment with no HOME resolves to the temp directory and is safe", () => {
    expect(unsandboxedDirs({})).toEqual([]);
  });
});

describe("the child-process guard", () => {
  // node:child_process' spawnSync reports a refused spawn as `result.error` rather than throwing, so the recorded
  // violation (which fails the test in the preload's afterEach) is what no test can swallow.
  const refusal = (result: ReturnType<typeof spawnSync>): string => String(result.error?.message ?? "");

  posixOnly("refuses an akm child whose environment reaches the real directories, and records it", () => {
    const result = spawnSync(process.execPath, [CLI, "info"], {
      env: { PATH: process.env.PATH, HOME: "/home/someone" },
    });
    expect(refusal(result)).toMatch(/harness-safety.*outside the temp root/);
    expect(takeViolations()).toHaveLength(1);
  });

  posixOnly("refuses it the same way for Bun.spawn, as a thrown error", () => {
    expect(() => Bun.spawnSync([process.execPath, CLI, "info"], { env: { HOME: "/home/someone" } })).toThrow(
      /harness-safety.*outside the temp root/,
    );
    expect(takeViolations()).toHaveLength(1);
  });

  posixOnly("allows an akm child that inherits the sandbox", () => {
    const result = spawnSync(process.execPath, [CLI, "--version"], { env: process.env, encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(takeViolations()).toEqual([]);
  });

  posixOnly("does not look at children that are not akm", () => {
    const result = spawnSync("true", { env: { HOME: "/home/someone" } });
    expect(result.status).toBe(0);
    expect(takeViolations()).toEqual([]);
  });

  posixOnly("puts a stub crontab first on PATH, so no test finds the developer's", () => {
    const found = (process.env.PATH ?? "")
      .split(path.delimiter)
      .find((dir) => dir && fs.existsSync(path.join(dir, "crontab")));
    expect(found).toBeDefined();
    expect(found?.startsWith(fs.realpathSync(os.tmpdir())) || found?.startsWith(os.tmpdir())).toBe(true);
    const listed = spawnSync("crontab", ["-l"], { env: process.env, encoding: "utf8" });
    expect(listed.status).toBe(1);
    expect(listed.stderr).toContain("no crontab");
    expect(takeViolations()).toEqual([]);
  });

  posixOnly("refuses the real scheduler binary and an akm child whose PATH reaches it", () => {
    const real = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].find((dir) => fs.existsSync(path.join(dir, "crontab")));
    if (!real) return; // no crontab on this machine: nothing to reach
    expect(refusal(spawnSync("crontab", ["-l"], { env: { PATH: real } }))).toMatch(/real scheduler binary/);
    const reaching = { ...process.env, PATH: `${real}${path.delimiter}${process.env.PATH}` };
    expect(refusal(spawnSync(process.execPath, [CLI, "--version"], { env: reaching }))).toMatch(
      /real scheduler binary/,
    );
    expect(takeViolations()).toHaveLength(2);
  });
});
