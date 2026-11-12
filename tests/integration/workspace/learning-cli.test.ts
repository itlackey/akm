// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The learning switch: `akm setup --learning`, `akm info`, and what `akm improve` and `akm proposal extract` do while it is off. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveImprovePlan } from "../../../src/commands/improve/improve-strategies";
import { loadConfig, resetConfigCache } from "../../../src/core/config/config";
import { IMPROVE_ENGINE_PROCESSES } from "../../../src/core/config/engine-semantics";
import { getConfigPath } from "../../../src/core/paths";
import { resolveAkmInvocation } from "../../../src/tasks/resolve-akm-bin";
import { setup } from "../../../src/workspace";
import { runCli } from "../../../src/workspace/cli-child";
import { change } from "../../../src/workspace/config";
import { ctx, type Json, useSandbox } from "./workspace-behaviour-helpers";

useSandbox();
let realHome: string | undefined;
let realPath: string | undefined;
beforeEach(() => {
  realHome = process.env.HOME;
  realPath = process.env.PATH;
  process.env.HOME = path.join(ctx.storage.root, "home");
  fs.mkdirSync(process.env.HOME);
});
afterEach(() => {
  process.env.HOME = realHome;
  process.env.PATH = realPath;
});

const library = () => path.join(ctx.storage.root, "library");
const savedConfig = () => JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
const connect = () =>
  change({
    set: {
      "connections.lab.endpoint": "http://localhost:1/v1",
      "connections.lab.models.fast": "m",
      "connections.lab.models.balanced": "m",
      "connections.lab.models.reasoning": "m",
    },
    unset: [],
  });
/** A `crontab` on PATH that only records that it was called. */
function spyCrontab() {
  const bin = path.join(ctx.storage.root, "cronbin");
  const calls = path.join(ctx.storage.root, "crontab-calls");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "crontab"), `#!/bin/sh\necho "$@" >> "${calls}"\nexit 1\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${realPath}`;
  return { called: () => fs.existsSync(calls) };
}
/** Every inspected file remains unchanged; only separate diagnostic CLI usage is exempt. */
function snapshot(): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (full !== path.join(ctx.storage.dataDir, "akm", "metrics.db") && !/-(shm|wal)$/.test(entry.name)) {
        files[full] = fs.readFileSync(full, "utf8");
      }
    }
  };
  walk(ctx.storage.root);
  return files;
}
/** What the active strategy would run, by process. */
const plan = () =>
  Object.fromEntries(
    IMPROVE_ENGINE_PROCESSES.map((name) => [name, resolveImprovePlan(undefined, loadConfig()).processes[name].enabled]),
  );
const learning = async (state: "on" | "off") =>
  (await runCli(["setup", "--learning", state], "setup")).learning as Json;

describe("akm setup --learning", () => {
  test("off writes only improve.enabled: no library, no task, no crontab call", async () => {
    const cron = spyCrontab();
    const result = await learning("off");
    expect(result).toEqual({ on: false, harness: null, scheduled: false });
    const config = savedConfig();
    expect(config.improve).toEqual({ enabled: false });
    for (const key of ["bundles", "defaultBundle", "harnesses", "connections", "scheduler"])
      expect(config[key]).toBeUndefined();
    expect(fs.existsSync(library())).toBe(false);
    expect(fs.existsSync(path.join(library(), "tasks"))).toBe(false);
    expect(cron.called()).toBe(false);
  });

  test("on after off restores the config, keeping a person's own process switch and adding no connection", async () => {
    await setup.apply({ dir: library() });
    connect();
    change({
      set: { "improve.strategies.default.processes.extract.enabled": "false", "output.format": "yaml" },
      unset: [],
    });
    const before = savedConfig();
    await learning("off");
    expect((await runCli(["info"], "info")).learning).toMatchObject({ on: false });
    const cron = spyCrontab();
    expect(await learning("on")).toMatchObject({ on: true });
    expect(savedConfig()).toEqual(before);
    expect(savedConfig().improve.connection).toBeUndefined();
    expect(cron.called()).toBe(false);
  });

  test("a legacy off (all seven processes false) reads off, and on clears it to a clean plan", async () => {
    await setup.apply({ dir: library() });
    connect();
    const clean = plan();
    const set = Object.fromEntries(
      IMPROVE_ENGINE_PROCESSES.map((name) => [`improve.strategies.default.processes.${name}.enabled`, "false"]),
    );
    change({ set, unset: [] });
    expect((await runCli(["info"], "info")).learning).toMatchObject({ on: false });
    expect(await learning("on")).toMatchObject({ on: true });
    resetConfigCache();
    expect(plan()).toEqual(clean);
  });

  test("a partial set of false processes is the person's own and is untouched", async () => {
    await setup.apply({ dir: library() });
    connect();
    const set = Object.fromEntries(
      IMPROVE_ENGINE_PROCESSES.slice(1).map((name) => [
        `improve.strategies.default.processes.${name}.enabled`,
        "false",
      ]),
    );
    change({ set, unset: [] });
    const before = savedConfig();
    expect((await runCli(["info"], "info")).learning).toMatchObject({ on: true });
    await learning("on");
    expect(savedConfig()).toEqual(before);
  });

  test("a value other than on or off, or a flag beside it, is a usage error; --yes is ignored", async () => {
    await expect(runCli(["setup", "--learning", "maybe"], "setup")).rejects.toThrow(/on. or .off/);
    await expect(runCli(["setup", "--learning", "on", "--harness", "claude"], "setup")).rejects.toThrow(/on its own/);
    await expect(runCli(["setup", "--learning", "on", "--dir", library()], "setup")).rejects.toThrow(/on its own/);
    await expect(runCli(["setup", "--learning", "on", "--from", "x.yml"], "setup")).rejects.toThrow(/on its own/);
    expect(await runCli(["setup", "--learning", "off", "--yes", "--no-probe"], "setup")).toMatchObject({
      learning: { on: false },
    });
  });
});

describe("akm info", () => {
  test("reports on, harness and scheduled without changing inspected state", async () => {
    await setup.apply({ dir: library() });
    connect();
    const before = snapshot();
    expect((await runCli(["info"], "info")).learning).toEqual({ on: true, harness: null, scheduled: false });
    expect(fs.statSync(path.join(ctx.storage.dataDir, "akm", "metrics.db")).isFile()).toBe(true);
    expect(snapshot()).toEqual(before);
  });
});

describe("while learning is off", () => {
  test("akm improve does nothing, dry run or not, and exits 0 with skipped learning-off", async () => {
    await setup.apply({ dir: library() });
    connect();
    await learning("off");
    const before = snapshot();
    for (const args of [["improve"], ["improve", "--dry-run"]]) {
      const result = await runCli(args, "improve");
      expect(result.skipped).toEqual({ reason: "learning-off" });
      expect(result.dryRun).toBe(args.includes("--dry-run"));
      expect(result.actions).toEqual([]);
    }
    expect(fs.statSync(path.join(ctx.storage.dataDir, "akm", "metrics.db")).isFile()).toBe(true);
    expect(snapshot()).toEqual(before);
  });

  test("akm proposal extract is a no-op", async () => {
    await setup.apply({ dir: library() });
    connect();
    await learning("off");
    const before = snapshot();
    const [bin, ...prefix] = resolveAkmInvocation().argv;
    const result = JSON.parse(
      execFileSync(bin!, [...prefix, "proposal", "extract", "--type", "claude", "--format=json"], {
        encoding: "utf8",
        env: process.env,
      }),
    );
    expect(result).toMatchObject({ ok: true, sessionsProcessed: 0 });
    expect(fs.statSync(path.join(ctx.storage.dataDir, "akm", "metrics.db")).isFile()).toBe(true);
    expect(snapshot()).toEqual(before);
  });
});
