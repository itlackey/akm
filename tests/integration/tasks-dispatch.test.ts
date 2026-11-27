// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Dispatch mode: `akm doctor scheduler sync --dispatch` replaces this installation's per-task rows with one row that
 * runs `akm task dispatch` every minute, later syncs keep that mode, `--no-dispatch` switches back, and a host never
 * holds both kinds of row. `akm task dispatch` starts each due entry with the invocation and log file its row would
 * have had. The native scheduler is an in-memory double.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmTaskDispatch, minutesToEvaluate } from "../../src/commands/tasks/dispatch";
import { akmTasksEnable, akmTasksSync } from "../../src/commands/tasks/tasks";
import type { InstalledSchedulerBinding, SchedulerBackend } from "../../src/tasks/backends/types";
import { type SchedulerBinding, schedulerBindingNativeId } from "../../src/tasks/scheduler-binding";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
/** Rows by native id, each with the working stash it names. */
let rows: Map<string, { binding: SchedulerBinding; bundleDir: string }>;
let failUninstall: Set<string>;

const backend: SchedulerBackend = {
  name: "cron",
  install(binding: SchedulerBinding) {
    rows.set(schedulerBindingNativeId(binding), { binding, bundleDir: storage.stashDir });
  },
  uninstall(nativeId: string) {
    if (failUninstall.has(nativeId)) throw new Error(`injected failure removing ${nativeId}`);
    rows.delete(nativeId);
  },
  setEnabled() {},
  list(): InstalledSchedulerBinding[] {
    return [...rows.entries()].map(([nativeId, { binding, bundleDir }]) => ({
      id: binding.id,
      nativeId,
      binding: ["/test/akm"],
      environment: { AKM_BUNDLE_DIR: bundleDir },
      invocation: binding.invocation,
      signature: JSON.stringify([binding.cron, binding.invocation]),
    }));
  },
  expectedSignature: (binding: SchedulerBinding) => JSON.stringify([binding.cron, binding.invocation]),
};

const invocations = () => [...rows.values()].map(({ binding }) => binding.invocation.join(" ")).sort();

function write(relative: string, content: string): void {
  const file = path.join(storage.stashDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

const task = (schedule: string) => ["version: 4", "run: echo hi", `schedule: '${schedule}'`, ""].join("\n");

beforeEach(async () => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({ bundles: { stash: { path: storage.stashDir, writable: true } }, defaultBundle: "stash" });
  rows = new Map();
  failUninstall = new Set();
  write("tasks/hourly.yml", task("0 * * * *"));
  write("tasks/quarter.yml", task("*/15 * * * *"));
  await akmTasksEnable("hourly", {}, { backend });
  await akmTasksEnable("quarter", {}, { backend });
});
afterEach(() => storage.cleanup());

describe("sync --dispatch", () => {
  test("a sync that writes per-task rows says they are deprecated; one that writes none does not", async () => {
    expect((await akmTasksSync({ backend })).warnings).toBeUndefined();
    rows.delete("quarter");
    const result = await akmTasksSync({ backend });
    expect(result.installed).toEqual(["quarter"]);
    expect(result.warnings?.join("\n")).toMatch(/Per-task scheduler rows are deprecated.*--dispatch/);
  });

  test("replaces this installation's per-task rows with the one dispatch row", async () => {
    expect(invocations()).toEqual([
      "task run stash//tasks/hourly --scheduled",
      "task run stash//tasks/quarter --scheduled",
    ]);
    const result = await akmTasksSync({ backend }, undefined, { dispatch: true });
    expect(result.failures).toEqual([]);
    expect(result.removed.sort()).toEqual(["hourly", "quarter"]);
    expect(result.installed).toEqual(["dispatch"]);
    expect(invocations()).toEqual(["task dispatch"]);
    expect(rows.get("dispatch")?.binding.cron).toBe("*/1 * * * *");
  });

  test("later syncs, and enabling another task, keep dispatch mode", async () => {
    await akmTasksSync({ backend }, undefined, { dispatch: true });
    write("tasks/daily.yml", task("@daily"));
    await akmTasksEnable("daily", {}, { backend });
    const again = await akmTasksSync({ backend });
    expect(again.unchanged).toEqual(["dispatch"]);
    expect(again.warnings).toBeUndefined();
    expect(invocations()).toEqual(["task dispatch"]);
  });

  test("--no-dispatch removes the dispatch row and writes the per-task rows back", async () => {
    await akmTasksSync({ backend }, undefined, { dispatch: true });
    const result = await akmTasksSync({ backend }, undefined, { dispatch: false });
    expect(result.failures).toEqual([]);
    expect(result.removed).toEqual(["dispatch"]);
    expect(invocations()).toEqual([
      "task run stash//tasks/hourly --scheduled",
      "task run stash//tasks/quarter --scheduled",
    ]);
  });

  test("a per-task row that cannot be removed keeps the dispatch row from being written", async () => {
    failUninstall.add("quarter");
    const result = await akmTasksSync({ backend }, undefined, { dispatch: true });
    expect(result.installed).toEqual([]);
    expect(result.failures.map((failure) => failure.reason)).toEqual([
      "injected failure removing quarter",
      "Not written: a removal before it failed, and with both rows installed tasks would run twice.",
    ]);
    expect(invocations()).toEqual(["task run stash//tasks/quarter --scheduled"]);
  });

  test("a dispatch row that cannot be removed keeps the per-task rows from being written", async () => {
    await akmTasksSync({ backend }, undefined, { dispatch: true });
    failUninstall.add("dispatch");
    const result = await akmTasksSync({ backend }, undefined, { dispatch: false });
    expect(result.installed).toEqual([]);
    expect(invocations()).toEqual(["task dispatch"]);
  });

  test("another installation's row is left, with a warning when dispatch starts its task too", async () => {
    const other = { ...(rows.get("hourly") as { binding: SchedulerBinding }), bundleDir: "/elsewhere/stash" };
    rows.set("hourly", other);
    const result = await akmTasksSync({ backend }, undefined, { dispatch: true });
    expect(invocations()).toEqual(["task dispatch", "task run stash//tasks/hourly --scheduled"]);
    expect(result.warnings?.join("\n")).toMatch(/"hourly" runs stash\/\/tasks\/hourly .*\/elsewhere\/stash/);
  });

  test("another installation's dispatch row refuses --dispatch and is left alone by a plain sync", async () => {
    await akmTasksSync({ backend }, undefined, { dispatch: true });
    const theirs = { ...(rows.get("dispatch") as { binding: SchedulerBinding }), bundleDir: "/elsewhere/stash" };
    rows.set("dispatch", theirs);
    await expect(akmTasksSync({ backend }, undefined, { dispatch: true })).rejects.toThrow(
      /already scheduled from .*\/elsewhere\/stash/,
    );
    await akmTasksSync({ backend });
    expect(rows.get("dispatch")?.bundleDir).toBe("/elsewhere/stash");
    expect(invocations()).toContain("task run stash//tasks/hourly --scheduled");
  });

  test("an @reboot entry is reported: dispatch has no minute for it", async () => {
    write("tasks/boot.yml", task("@reboot"));
    await akmTasksEnable("boot", {}, { backend });
    const result = await akmTasksSync({ backend }, undefined, { dispatch: true });
    expect(result.failures.map((failure) => failure.ref)).toEqual(["stash//tasks/boot"]);
    expect(result.failures[0]?.reason).toMatch(/@reboot/);
  });
});

describe("akm task dispatch", () => {
  const started: { argv: readonly string[]; log: string }[] = [];
  const dispatchAt = (at: string, statePath: string) =>
    akmTaskDispatch({
      now: () => new Date(at),
      launcher: ["/test/akm"],
      statePath,
      logDir: "/logs",
      start: async (argv, log) => {
        started.push({ argv, log });
      },
    });
  let state: string;
  beforeEach(() => {
    started.length = 0;
    state = path.join(storage.stashDir, "..", "dispatch-minute");
  });

  test("starts each due entry with its row's invocation and log file, and nothing else", async () => {
    const result = await dispatchAt("2026-11-26T10:15:00", state);
    expect(result).toMatchObject({ minute: "2026-11-26T10:15", window: 1, started: ["stash//tasks/quarter"] });
    expect(result.failures).toEqual([]);
    expect(started).toEqual([
      { argv: ["/test/akm", "task", "run", "stash//tasks/quarter", "--scheduled"], log: "/logs/quarter.log" },
    ]);
  });

  test("a minute already dispatched starts nothing", async () => {
    await dispatchAt("2026-11-26T10:00:00", state);
    expect(started).toHaveLength(2);
    const again = await dispatchAt("2026-11-26T10:00:30", state);
    expect(again).toMatchObject({ window: 0, started: [] });
    expect(started).toHaveLength(2);
  });

  test("a late start catches up the minutes it missed, starting each entry once", async () => {
    await dispatchAt("2026-11-26T09:58:00", state);
    const late = await dispatchAt("2026-11-26T10:01:00", state);
    expect(late.window).toBe(3);
    expect(late.started.sort()).toEqual(["stash//tasks/hourly", "stash//tasks/quarter"]);
  });

  test("an edit to a task file applies on the next minute, with no sync", async () => {
    write("tasks/hourly.yml", task("16 * * * *"));
    const result = await dispatchAt("2026-11-26T10:16:00", state);
    expect(result.started).toEqual(["stash//tasks/hourly"]);
  });

  test("an enabled task whose file does not parse is a failure; the others still start", async () => {
    write("tasks/hourly.yml", "version: 4\nrun: [\n");
    const result = await dispatchAt("2026-11-26T10:00:00", state);
    expect(result.started).toEqual(["stash//tasks/quarter"]);
    expect(result.failures.map((failure) => failure.ref)).toEqual(["stash//tasks/hourly"]);
  });
});

describe("minutesToEvaluate", () => {
  test("the current minute when there is no last one, the gap up to five, nothing for a minute already done", () => {
    expect(minutesToEvaluate(100, undefined)).toEqual([100]);
    expect(minutesToEvaluate(100, 99)).toEqual([100]);
    expect(minutesToEvaluate(100, 97)).toEqual([98, 99, 100]);
    expect(minutesToEvaluate(100, 10)).toEqual([96, 97, 98, 99, 100]);
    expect(minutesToEvaluate(100, 100)).toEqual([]);
    expect(minutesToEvaluate(100, 102)).toEqual([]);
    // A last minute far ahead means the clock was set back: start over at this one.
    expect(minutesToEvaluate(100, 200)).toEqual([100]);
  });
});
