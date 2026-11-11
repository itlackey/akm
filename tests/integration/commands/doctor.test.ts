// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Integration: real CLI processes verify doctor dispatch, output and startup behavior.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getConfigPath } from "../../../src/core/paths";
import { openStateDatabase } from "../../../src/core/state-db";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let emptyBin: string;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  emptyBin = path.join(storage.root, "bin");
  fs.mkdirSync(emptyBin);
  writeSandboxConfig({ semanticSearchMode: "off", improve: { enabled: false } });
  openStateDatabase().close();
});

afterEach(() => storage.cleanup());

async function cli(args: readonly string[], stdin = "") {
  const child = Bun.spawn([process.execPath, path.resolve("src/cli.ts"), ...args], {
    env: { ...process.env, PATH: emptyBin, NO_COLOR: "1", FORCE_COLOR: undefined },
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

describe("akm doctor entrypoints", () => {
  test("help exposes the bare diagnostics and every new subcommand", async () => {
    const root = await cli(["--help"]);
    expect(root.stdout).toMatch(/^ {2}doctor\s/m);
    const doctor = await cli(["doctor", "--help"]);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain("--read-only");
    expect(doctor.stdout).toContain("--no-probe");
    for (const subcommand of ["metrics", "info", "log", "judge"]) {
      expect(doctor.stdout).toContain(subcommand);
      const help = await cli(["doctor", subcommand, "--help"]);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain(`USAGE akm doctor ${subcommand}`);
    }
  });

  test.each([
    { args: ["metrics", "--since", new Date().toISOString().slice(0, 10)] },
    { args: ["info"] },
    { args: ["log", "--limit", "2", "--include-tags", "test", "--include-tags", "doctor"] },
    { args: ["judge", "--list"] },
    { args: ["judge", "reflect.quality", "--schema"] },
  ])("doctor delegates $args with the original result and exit status", async ({ args }) => {
    const original = await cli([...args, "--format", "json", "--quiet"]);
    const doctor = await cli(["doctor", ...args, "--format", "json", "--quiet"]);
    expect(original.code, original.stderr).toBe(0);
    expect(doctor.code, doctor.stderr).toBe(original.code);
    const originalData = JSON.parse(original.stdout);
    const doctorData = JSON.parse(doctor.stdout);
    // Metrics' window end is the invocation time; all other data is identical.
    if (args[0] === "metrics") {
      expect(doctorData.window.until).toEqual(expect.any(String));
      doctorData.window.until = originalData.window.until;
    }
    expect(doctorData).toEqual(originalData);
    expect(doctor.stderr).toBe(original.stderr);
  });

  test.each([
    { args: ["metrics", "--since", "invalid"] },
    { args: ["log", "--limit", "invalid"] },
    { args: ["judge"] },
    { args: ["judge", "reflect.quality"], stdin: "not json" },
  ])("doctor preserves validation failures for $args", async ({ args, stdin }) => {
    const original = await cli([...args, "--format", "json", "--quiet"], stdin);
    const doctor = await cli(["doctor", ...args, "--format", "json", "--quiet"], stdin);
    expect(original.code).toBe(2);
    expect(doctor).toEqual(original);
  });

  test.each([
    { args: ["judge", "reflect.quality", "--schema", "--read-only"] },
    { args: ["judge", "--list", "--no-probe"] },
    { args: ["metrics", "--report"] },
    { args: ["metrics", "--group-by", "run"] },
    { args: ["log", "--readOnly"] },
  ])("doctor rejects inherited health flags for $args", async ({ args }) => {
    const original = await cli(args);
    const doctor = await cli(["doctor", ...args]);
    expect(original.code).toBe(2);
    expect(doctor.code).toBe(2);
    expect(doctor.stdout).toBe("");
    expect(JSON.parse(doctor.stderr)).toMatchObject({ code: "UNKNOWN_FLAG" });
  });

  test.each([
    { args: ["--since", "invalid", "metrics"] },
    { args: ["--since=7d", "metrics"] },
    { args: ["--limit", "2", "log"] },
    { args: ["--connection", "test", "judge", "--list"] },
    { args: ["--schema", "judge", "reflect.quality"] },
    { args: ["--read-only", "metrics"] },
  ])("doctor rejects misplaced child options: $args", async ({ args }) => {
    const result = await cli(["doctor", ...args]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ code: "INVALID_FLAG_VALUE" });
    expect(result.stderr).toContain("after the subcommand");
  });

  test("global options remain usable before the child while child options take effect after it", async () => {
    const result = await cli(["doctor", "--format", "json", "--quiet", "metrics", "--since", "invalid"]);
    expect(result.code).toBe(2);
    expect(result.stderr).not.toContain("after the subcommand");
    const valid = await cli(["--format", "json", "doctor", "--quiet", "judge", "--list"]);
    expect(valid.code, valid.stderr).toBe(0);
    expect(JSON.parse(valid.stdout).judges.length).toBeGreaterThan(0);
  });

  test("info warns once per unsupported flag, including health options, without refusing", async () => {
    const result = await cli(["doctor", "info", "--read-only", "--no-probe", "--unexpected-flag", "--format", "json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).ok).toBe(true);
    for (const flag of ["--read-only", "--no-probe", "--unexpected-flag"]) {
      expect(result.stderr.split(`ignoring unknown flag "${flag}"`)).toHaveLength(2);
    }
  });

  test("info still reports a broken config and tolerates unknown flags", async () => {
    fs.writeFileSync(getConfigPath(), "{ invalid JSON\n");
    for (const args of [["info"], ["doctor", "info"], ["--format", "json", "doctor", "--quiet", "info"]]) {
      const result = await cli([...args, "--unexpected-flag", "--format", "json"]);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, configError: expect.any(String) });
    }
  });

  test("bare doctor rejects misspelled health flags before running diagnostics", async () => {
    const original = await cli(["health", "--no-probe", "--read-onyl"]);
    const doctor = await cli(["doctor", "--no-probe", "--read-onyl"]);
    expect(original.code).toBe(2);
    expect(doctor.code).toBe(2);
    expect(doctor.stdout).toBe("");
    expect(JSON.parse(doctor.stderr)).toMatchObject({ code: "UNKNOWN_FLAG" });
    expect(doctor.stderr).toContain("--read-only");
  });
});
