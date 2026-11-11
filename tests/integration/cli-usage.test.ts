// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { main } from "../../src/cli";
import type { UsageCommand } from "../../src/cli/usage";
import { getConfigDir, getDataDir } from "../../src/core/paths";
import { openDatabase } from "../../src/storage/database";
import { withIsolatedAkmStorage } from "../_helpers/sandbox";

const CLI = path.resolve(import.meta.dir, "../../src/cli.ts");
let cleanup = () => {};
afterEach(() => cleanup());
function sandbox() {
  const storage = withIsolatedAkmStorage();
  cleanup = storage.cleanup;
  return storage;
}
function cli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync("bun", [CLI, ...args], { encoding: "utf8", env: { ...env }, timeout: 30000 });
}
function report(args: string[] = []) {
  const result = cli(["doctor", "metrics", "usage", "--export", "--format", "json", ...args]);
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

test("real entry captures help/version/invalid/config failures once and redacts secrets", () => {
  sandbox();
  expect(cli(["--version"]).status).toBe(0);
  expect(
    cli([
      "show",
      "private/path?secret=VALUE",
      "--help",
      "--format=json",
      "--format=json",
      "--no-quiet",
      "--no-quiet=true",
      "--quiet=SENSITIVE_BOOLEAN_VALUE",
      "-qq",
      "--type=PRIVATE_ENUM_VALUE",
      "--",
      "--secret=VALUE",
    ]).status,
  ).toBe(0);
  expect(cli(["show", "private/path?secret=VALUE", "--private-token=VALUE"]).status).toBe(2);
  const configDir = getConfigDir();
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), "{broken");
  expect(cli(["show", "private/path?secret=VALUE"]).status).toBe(78);
  fs.unlinkSync(path.join(configDir, "config.json"));
  const result = report();
  expect(result.details).toHaveLength(5); // report itself is pending
  const attempts = result.aggregates.reduce((sum: number, row: { attempts: number }) => sum + row.attempts, 0);
  expect(attempts).toBe(5);
  expect(JSON.stringify(result)).not.toContain("VALUE");
  expect(JSON.stringify(result)).not.toContain("private");
  const help = result.details.find((row: { childArgumentCount: number }) => row.childArgumentCount === 1);
  expect(
    help.arguments.filter((arg: { name: string; explicit: boolean }) => arg.name === "format" && arg.explicit),
  ).toHaveLength(2);
  expect(
    help.arguments.filter((arg: { name: string; spelling: string }) => arg.name === "quiet" && arg.spelling === "-q"),
  ).toHaveLength(2);
  expect(help.arguments.find((arg: { name: string }) => arg.name === "quiet")).toMatchObject({
    negated: true,
    value: false,
    explicit: true,
  });
  expect(
    help.arguments.find(
      (arg: { name: string; value: unknown }) => arg.name === "quiet" && arg.value === "[not-applied]",
    ),
  ).toBeDefined();
  expect(result.details.map((row: { category: string }) => row.category)).toContain("config");
});

test("concurrent CLI writes and overlapping export snapshots keep stable aggregate identities", async () => {
  sandbox();
  await Promise.all(
    Array.from(
      { length: 8 },
      () =>
        new Promise<void>((resolve, reject) => {
          const child = spawn("bun", [CLI, "--version"], { env: { ...process.env }, stdio: "ignore" });
          child.on("error", reject);
          child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
        }),
    ),
  );
  const first = report(["--source", "unknown"]);
  const second = report(["--source", "unknown"]);
  const version = (
    rows: Array<{
      dimensions: { command: string[]; arguments: Array<{ name: string }> };
      attempts: number;
      key: string;
    }>,
  ) => rows.filter((row) => row.dimensions.command.length === 0);
  expect(version(first.aggregates).reduce((sum, row) => sum + row.attempts, 0)).toBe(8);
  const merged = new Map([...first.aggregates, ...second.aggregates].map((row) => [row.key, row]));
  expect(version([...merged.values()]).reduce((sum, row) => sum + row.attempts, 0)).toBe(8);
  expect(new Set(second.details.map((row: { id: string }) => row.id)).size).toBe(second.details.length);
});

test("retention expires detail without losing durable counts and unavailable capture preserves exits", () => {
  sandbox();
  expect(cli(["--version"]).status).toBe(0);
  const db = openDatabase(path.join(getDataDir(), "usage.sqlite"));
  db.prepare("UPDATE invocations SET ts='2000-01-01T00:00:00.000Z'").run();
  db.close();
  expect(cli(["--version"]).status).toBe(0);
  const result = report();
  expect(result.details).toHaveLength(2);
  expect(
    result.aggregates
      .filter((row: { dimensions: { command: string[] } }) => row.dimensions.command.length === 0)
      .reduce((sum: number, row: { attempts: number }) => sum + row.attempts, 0),
  ).toBe(2);
  const blocker = path.join(getDataDir(), "blocker");
  fs.writeFileSync(blocker, "file");
  const outcome = cli(["--version"], { ...process.env, AKM_DATA_DIR: blocker });
  expect(outcome.status).toBe(0);
  expect(outcome.stderr).toBe("");
});

test("existing doctor metrics output remains a single report", () => {
  sandbox();
  const result = cli(["doctor", "metrics", "--since", "7d", "--format", "json"]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).shape).toBe("metrics");
  expect(cli(["doctor", "metrics", "--since", "7d", "usage"]).status).toBe(2);
  expect(cli(["doctor", "metrics", "--format", "json", "usage"]).status).toBe(0);
  expect(cli(["doctor", "metrics", "usage", "--source", "typo"]).status).toBe(2);
  expect(cli(["doctor", "metrics", "usage", "--since", "7d", "--until", "30d"]).status).toBe(2);
});

test("catchable cancellation finalizes once and abrupt kill remains unfinished", async () => {
  const storage = sandbox();
  const envDir = path.join(storage.stashDir, "env");
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, "cancel.env"), "EXAMPLE=value\n");
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const child = spawn(
      "bun",
      [CLI, "env", "run", "env/cancel", "--", "bun", "-e", "console.log('READY');setTimeout(()=>{},2000)"],
      { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("child did not start")), 10000);
        child.stdout.on("data", (data) => {
          if (String(data).includes("READY")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("error", reject);
      });
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill(signal);
      await exited;
    } finally {
      // env run may have been hard-killed before forwarding the signal.
      child.kill("SIGKILL");
    }
  }
  const result = report();
  const envRuns = result.details.filter((row: { command: string[] }) => row.command.join(" ") === "env run");
  expect(envRuns).toHaveLength(2);
  expect(envRuns.map((row: { category: string }) => row.category).sort()).toEqual(["cancelled", "unfinished"]);
  expect(envRuns.find((row: { category: string }) => row.category === "cancelled").exitCode).toBe(143);
});

test("every declared command-tree help route records exactly one redacted attempt", async () => {
  sandbox();
  const paths: string[][] = [];
  function walk(command: UsageCommand, commandPath: string[]) {
    paths.push(commandPath);
    for (const [name, child] of Object.entries(command.subCommands ?? {})) walk(child, [...commandPath, name]);
  }
  walk(main as UsageCommand, []);
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < paths.length) {
        const commandPath = paths[next++]!;
        await new Promise<void>((resolve, reject) => {
          const child = spawn("bun", [CLI, ...commandPath, "--help"], { env: { ...process.env }, stdio: "ignore" });
          child.once("error", reject);
          child.once("exit", (code) =>
            code === 0 ? resolve() : reject(new Error(`${commandPath.join(" ")}: ${code}`)),
          );
        });
      }
    }),
  );
  const result = report();
  expect(result.details).toHaveLength(paths.length + 1);
  expect(result.details.filter((row: { category: string }) => row.category === "success")).toHaveLength(paths.length);
  expect(result.aggregates.reduce((sum: number, row: { attempts: number }) => sum + row.attempts, 0)).toBe(
    paths.length + 1,
  );
}, 120000);

test("writer contention has a bounded fail-open budget", () => {
  sandbox();
  const baselineStart = Date.now();
  expect(cli(["--version"]).status).toBe(0);
  const baselineMs = Date.now() - baselineStart;
  const db = openDatabase(path.join(getDataDir(), "usage.sqlite"));
  try {
    db.exec("BEGIN IMMEDIATE");
    const lockedStart = Date.now();
    const result = cli(["--version"]);
    const lockedMs = Date.now() - lockedStart;
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    // The SQLite busy budget is 250 ms; allow process-start and scheduler
    // variation while still rejecting an unbounded lock retry loop.
    expect(lockedMs - baselineMs).toBeLessThan(2000);
  } finally {
    db.exec("ROLLBACK");
    db.close();
  }
});
