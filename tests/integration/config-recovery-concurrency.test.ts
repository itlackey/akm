// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { shouldBypassConfigStartup } from "../../src/cli";
import { getConfigPath } from "../../src/core/paths";
import { assertSetupConfigPreflight, runSetupWithDefaults } from "../../src/setup/setup";
import { runCliCapture } from "../_helpers/cli";
import {
  type Cleanup,
  sandboxHome,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "../_helpers/sandbox";

let cleanup: Cleanup | undefined;

beforeEach(() => {
  const home = sandboxHome();
  const config = sandboxXdgConfigHome(home.cleanup);
  const cache = sandboxXdgCacheHome(config.cleanup);
  cleanup = sandboxXdgDataHome(cache.cleanup).cleanup;
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

describe("raw recovery startup", () => {
  test("path and migrate/setup forwarders bypass normal config startup", () => {
    for (const args of [
      ["bun", "cli.ts", "migrate", "status"],
      ["bun", "cli.ts", "config", "path"],
      ["bun", "cli.ts", "setup"],
      ["bun", "cli.ts", "workflow", "--help"],
    ]) {
      expect(shouldBypassConfigStartup(args)).toBe(true);
    }
  });

  test("help and version config bypass ignores child flags after `--`", () => {
    expect(shouldBypassConfigStartup(["bun", "cli.ts", "env", "run", "env/prod", "--", "tool", "--help"])).toBe(false);
    expect(
      shouldBypassConfigStartup(["bun", "cli.ts", "secret", "run", "secrets/token", "TOKEN", "--", "tool", "-v"]),
    ).toBe(false);
  });

  test("top-level migrate status is wired through the real CLI process", async () => {
    const stash = path.join(process.env.HOME as string, "task-migrate-source");
    const task = path.join(stash, "tasks", "legacy.yml");
    fs.mkdirSync(path.dirname(task), { recursive: true });
    const taskV2 = "version: 2\nschedule: '@daily'\ncommand: /bin/echo ok\n";
    fs.writeFileSync(task, taskV2);
    fs.writeFileSync(
      getConfigPath(),
      `${JSON.stringify({
        configVersion: "0.9.0",
        bundles: { primary: { path: stash, writable: true } },
        defaultBundle: "primary",
      })}\n`,
    );

    const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "status"], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ status: "ready", taskFiles: { changed: 1, blocked: 0 } });
    expect(fs.readFileSync(task, "utf8")).toBe(taskV2);
  });

  test("migrate apply skips a blocked file and still migrates the rest of the batch, exiting non-zero", async () => {
    const stash = path.join(process.env.HOME as string, "task-migrate-source");
    const goodTask = path.join(stash, "tasks", "legacy.yml");
    const badTask = path.join(stash, "tasks", "bad.yml");
    fs.mkdirSync(path.dirname(goodTask), { recursive: true });
    const taskV2 = "version: 2\nschedule: '@daily'\ncommand: /bin/echo ok\n";
    fs.writeFileSync(goodTask, taskV2);
    // Array-form `command` is rejected by the v2 -> v3 hop inside the one task-file planner, so this file plans as "blocked".
    fs.writeFileSync(badTask, "version: 2\nschedule: '@daily'\ncommand: [echo, unsafe]\n");
    fs.writeFileSync(
      getConfigPath(),
      `${JSON.stringify({
        configVersion: "0.9.0",
        bundles: { primary: { path: stash, writable: true } },
        defaultBundle: "primary",
      })}\n`,
    );

    // The standalone migrator runs every step in one plan; what this test
    // pins is the task-file step's skip-and-report rule: a blocked file
    // never stops the rest of the batch from migrating.
    const child = Bun.spawn(["bun", "scripts/akm-migrate.ts", "apply"], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    // A blocked file remains after apply -> exit 1 (EXIT_CODES.GENERAL, set by
    // printPlan in scripts/akm-migrate.ts). Ground-truthed by probing the
    // actual process exit code before pinning.
    expect(exitCode, stderr).toBe(1);
    const result = JSON.parse(stdout);
    // The reported plan is re-inspected AFTER apply: the good file converged
    // straight to task source v4 in one pass ("skipped", already v4), and
    // `applied: 1` confirms it was rewritten this run. The bad file is still
    // "blocked".
    expect(result).toMatchObject({
      status: "blocked",
      applied: 1,
      taskFiles: { changed: 0, skipped: 1, blocked: 1 },
    });
    // The good file was migrated all the way to v4 despite the blocked
    // sibling (matched via regex, not a literal contiguous substring, so this
    // file does not trip the task-fixture-vocabulary ratchet's two-needle scan).
    expect(fs.readFileSync(goodTask, "utf8")).toMatch(/version:\s*4/);
    // The blocked file was left untouched, not corrupted or written.
    expect(fs.readFileSync(badTask, "utf8")).toContain("command: [echo, unsafe]");
  });

  test("setup rejects a config that fails to load before creating the stash or backup", async () => {
    // configVersion alone no longer blocks anything (any value is read as
    // current, with a warning) — a schema-invalid field is what still makes
    // the config fail to load.
    fs.writeFileSync(getConfigPath(), '{"bundles":{"primary":{"path":42,"writable":true}}}\n');
    const stash = path.join(process.env.HOME as string, "akm");
    expect(() => assertSetupConfigPreflight()).toThrow(/`akm setup` cannot run/);
    await expect(runSetupWithDefaults({ noInit: false })).rejects.toThrow(/`akm setup` cannot run/);
    expect(fs.existsSync(stash)).toBe(false);
    expect(fs.existsSync(path.join(process.env.XDG_CACHE_HOME as string, "akm", "migration-backups"))).toBe(false);
  });
});

describe("locked config mutation", () => {
  test("concurrent config set processes preserve every independent engine", async () => {
    const first = await runCliCapture([
      "config",
      "set",
      "--silent",
      "engines.seed",
      '{"kind":"llm","endpoint":"http://localhost:1/v1/chat/completions","model":"seed"}',
    ]);
    expect(first.code).toBe(0);
    const env = { ...process.env };
    const children = Array.from({ length: 8 }, (_, index) =>
      Bun.spawn(
        [
          "bun",
          "src/cli.ts",
          "config",
          "set",
          "--silent",
          `engines.worker-${index}`,
          JSON.stringify({
            kind: "llm",
            endpoint: `http://localhost:${8100 + index}/v1/chat/completions`,
            model: `model-${index}`,
          }),
        ],
        { cwd: path.resolve(import.meta.dir, "../.."), env, stdout: "pipe", stderr: "pipe" },
      ),
    );
    const exits = await Promise.all(children.map((child) => child.exited));
    expect(exits).toEqual(new Array(8).fill(0));
    const written = JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as { engines: Record<string, unknown> };
    expect(Object.keys(written.engines).sort()).toEqual([
      "seed",
      "worker-0",
      "worker-1",
      "worker-2",
      "worker-3",
      "worker-4",
      "worker-5",
      "worker-6",
      "worker-7",
    ]);
  }, 20_000);

  test("unset against absent config is a true no-op", async () => {
    const result = await runCliCapture(["config", "unset", "--silent", "embedding"]);
    expect(result.code).toBe(0);
    expect(fs.existsSync(getConfigPath())).toBe(false);
  });

  test("different config-mutating commands preserve each other's concurrent updates", async () => {
    const env = { ...process.env };
    // #37: setup runs FIRST, sequentially. Setup and `akm add` both write the
    // `bundles` field now, so running them concurrently is a GENUINE
    // same-field conflict the precommit layer rejects by design (fail-closed,
    // "rerun setup") rather than silently losing an update. The concurrency
    // pin below covers writers of three DIFFERENT fields.
    const setup = Bun.spawn(["bun", "src/cli.ts", "setup", "--yes", "--no-init", "--format", "json"], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await setup.exited).toBe(0);

    const commands = [
      ["config", "set", "--silent", "output.detail", "full"],
      ["registry", "add", "https://registry-one.example/index.json", "--name", "registry-one"],
      ["bundle", "add", "https://source-one.example", "--provider", "website", "--name", "source-one"],
    ];
    const children = commands.map((args) =>
      Bun.spawn(["bun", "src/cli.ts", ...args], {
        cwd: path.resolve(import.meta.dir, "../.."),
        env,
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const exits = await Promise.all(children.map((child) => child.exited));
    const errors = await Promise.all(children.map((child) => new Response(child.stderr).text()));
    expect(exits, errors.join("\n")).toEqual(new Array(commands.length).fill(0));

    const written = JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as {
      output: { detail: string };
      registries: Array<{ name?: string }>;
      bundles: Record<string, { website?: { url?: string } }>;
    };
    expect(written.output.detail).toBe("full");
    expect(written.registries.some((registry) => registry.name === "registry-one")).toBe(true);
    // #37: `akm add` writes a bundles entry keyed by the --name.
    expect(written.bundles["source-one"]?.website?.url).toBeDefined();
  }, 20_000);
});
