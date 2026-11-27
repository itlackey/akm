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
import { akmTaskDispatch, minutesToEvaluate, scheduleMatchesMinute } from "../../src/commands/tasks/dispatch";
import { akmTasksEnable, akmTasksSync } from "../../src/commands/tasks/tasks";
import type { InstalledSchedulerBinding, SchedulerBackend } from "../../src/tasks/backends/types";
import { parseSchedule } from "../../src/tasks/schedule";
import { type SchedulerBinding, schedulerBindingNativeId } from "../../src/tasks/scheduler-binding";
import type { ScheduledRowEnvironment } from "../../src/tasks/scheduler-invocation";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
/** Rows by native id, each with the environment it sets inline. */
let rows: Map<string, { binding: SchedulerBinding; environment?: ScheduledRowEnvironment }>;
let failUninstall: Set<string>;

const backend: SchedulerBackend = {
  name: "cron",
  install(binding, options) {
    rows.set(schedulerBindingNativeId(binding), {
      binding,
      ...(options?.environment ? { environment: options.environment } : {}),
    });
  },
  uninstall(nativeId: string) {
    if (failUninstall.has(nativeId)) throw new Error(`injected failure removing ${nativeId}`);
    rows.delete(nativeId);
  },
  setEnabled() {},
  list(): InstalledSchedulerBinding[] {
    return [...rows.entries()].map(([nativeId, { binding, environment }]) => ({
      id: binding.id,
      nativeId,
      binding: ["/test/akm"],
      ...(environment ? { environment } : {}),
      invocation: binding.invocation,
      signature: JSON.stringify([binding.cron, binding.invocation]),
    }));
  },
  expectedSignature: (binding: SchedulerBinding) => JSON.stringify([binding.cron, binding.invocation]),
};

/** Run `fn` as a host that selects its stash by `defaultBundle` alone; the sandbox sets `AKM_BUNDLE_DIR`. */
async function withoutBundleDirVariable(fn: () => Promise<void>): Promise<void> {
  const saved = process.env.AKM_BUNDLE_DIR;
  delete process.env.AKM_BUNDLE_DIR;
  try {
    await fn();
  } finally {
    process.env.AKM_BUNDLE_DIR = saved;
  }
}

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
    expect(invocations()).toEqual(["run stash//tasks/hourly --scheduled", "run stash//tasks/quarter --scheduled"]);
    const result = await akmTasksSync({ backend }, undefined, { dispatch: true });
    expect(result.failures).toEqual([]);
    expect(result.removed.sort()).toEqual(["hourly", "quarter"]);
    expect(result.installed).toEqual(["dispatch"]);
    expect(invocations()).toEqual(["task dispatch"]);
    expect(rows.get("dispatch")?.binding.cron).toBe("*/1 * * * *");
  });

  test("the dispatch row names no working stash when the stash comes from defaultBundle", async () => {
    await withoutBundleDirVariable(async () => {
      await akmTasksSync({ backend });
      expect(rows.get("hourly")?.environment?.AKM_BUNDLE_DIR).toBe(path.resolve(storage.stashDir));
      await akmTasksSync({ backend }, undefined, { dispatch: true });
      expect(rows.get("dispatch")?.environment?.AKM_BUNDLE_DIR).toBeUndefined();
    });
  });

  test("the dispatch row keeps an AKM_BUNDLE_DIR the syncing process was given: the stash it still selects", async () => {
    await akmTasksSync({ backend }, undefined, { dispatch: true });
    expect(rows.get("dispatch")?.environment?.AKM_BUNDLE_DIR).toBe(path.resolve(storage.stashDir));
  });

  test("a dispatch row an older sync wrote with AKM_BUNDLE_DIR is this installation's and is rewritten without it", () =>
    withoutBundleDirVariable(async () => {
      await akmTasksSync({ backend }, undefined, { dispatch: true });
      const dispatch = rows.get("dispatch") as { binding: SchedulerBinding; environment?: ScheduledRowEnvironment };
      rows.set("dispatch", { ...dispatch, environment: { ...dispatch.environment, AKM_BUNDLE_DIR: storage.stashDir } });
      const backendWithEnv: SchedulerBackend = {
        ...backend,
        expectedSignature: (binding, options) =>
          JSON.stringify([binding.cron, binding.invocation, options?.environment]),
      };
      const listed = backend.list;
      backendWithEnv.list = () =>
        (listed() as InstalledSchedulerBinding[]).map((row) => ({
          ...row,
          signature: JSON.stringify([rows.get(row.nativeId as string)?.binding.cron, row.invocation, row.environment]),
        }));
      const result = await akmTasksSync({ backend: backendWithEnv });
      expect(result.updated).toEqual(["dispatch"]);
      expect(rows.get("dispatch")?.environment?.AKM_BUNDLE_DIR).toBeUndefined();
    }));

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
    expect(invocations()).toEqual(["run stash//tasks/hourly --scheduled", "run stash//tasks/quarter --scheduled"]);
  });

  test("a per-task row that cannot be removed keeps the dispatch row from being written", async () => {
    failUninstall.add("quarter");
    const result = await akmTasksSync({ backend }, undefined, { dispatch: true });
    expect(result.installed).toEqual([]);
    expect(result.failures.map((failure) => failure.reason)).toEqual([
      "injected failure removing quarter",
      "Not written: a removal before it failed, and with both rows installed tasks would run twice.",
    ]);
    expect(invocations()).toEqual(["run stash//tasks/quarter --scheduled"]);
  });

  test("a dispatch row that cannot be removed keeps the per-task rows from being written", async () => {
    await akmTasksSync({ backend }, undefined, { dispatch: true });
    failUninstall.add("dispatch");
    const result = await akmTasksSync({ backend }, undefined, { dispatch: false });
    expect(result.installed).toEqual([]);
    expect(invocations()).toEqual(["task dispatch"]);
  });

  test("another installation's row is left, with a warning when dispatch starts its task too", async () => {
    const other = {
      ...(rows.get("hourly") as { binding: SchedulerBinding }),
      environment: { AKM_BUNDLE_DIR: "/elsewhere/stash" },
    };
    rows.set("hourly", other);
    const result = await akmTasksSync({ backend }, undefined, { dispatch: true });
    expect(invocations()).toEqual(["run stash//tasks/hourly --scheduled", "task dispatch"]);
    expect(result.warnings?.join("\n")).toMatch(/"hourly" runs stash\/\/tasks\/hourly .*\/elsewhere\/stash/);
  });

  test("another installation's dispatch row refuses --dispatch and is left alone by a plain sync", async () => {
    await akmTasksSync({ backend }, undefined, { dispatch: true });
    const theirs = {
      ...(rows.get("dispatch") as { binding: SchedulerBinding }),
      environment: { AKM_CONFIG_DIR: "/elsewhere/config" },
    };
    rows.set("dispatch", theirs);
    await expect(akmTasksSync({ backend }, undefined, { dispatch: true })).rejects.toThrow(
      /already scheduled by the installation that reads "\/elsewhere\/config"/,
    );
    await akmTasksSync({ backend });
    expect(rows.get("dispatch")?.environment).toEqual({ AKM_CONFIG_DIR: "/elsewhere/config" });
    expect(invocations()).toContain("run stash//tasks/hourly --scheduled");
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
      { argv: ["/test/akm", "run", "stash//tasks/quarter", "--scheduled"], log: "/logs/quarter.log" },
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

describe("scheduleMatchesMinute", () => {
  const matches = (schedule: string, at: string) =>
    scheduleMatchesMinute(parseSchedule(schedule, "cron").fields, new Date(at));

  test("each field kind, read in local time", () => {
    // 2026-11-26 is a Thursday (day of week 4).
    expect(matches("*/15 * * * *", "2026-11-26T10:30:00")).toBe(true);
    expect(matches("*/15 * * * *", "2026-11-26T10:31:00")).toBe(false);
    expect(matches("7,37 * * * *", "2026-11-26T10:37:00")).toBe(true);
    expect(matches("0 9-17/4 * * *", "2026-11-26T13:00:00")).toBe(true);
    expect(matches("0 9-17/4 * * *", "2026-11-26T15:00:00")).toBe(false);
    expect(matches("0 3 * * MON-FRI", "2026-11-26T03:00:00")).toBe(true);
    expect(matches("0 3 * * SAT", "2026-11-26T03:00:00")).toBe(false);
    expect(matches("@monthly", "2026-12-01T00:00:00")).toBe(true);
    expect(matches("@monthly", "2026-11-26T00:00:00")).toBe(false);
    expect(matches("30 2 26 NOV *", "2026-11-26T02:30:00")).toBe(true);
    expect(matches("0 0 */2 * *", "2026-11-03T00:00:00")).toBe(true);
    expect(matches("0 0 */2 * *", "2026-11-02T00:00:00")).toBe(false);
  });
});
