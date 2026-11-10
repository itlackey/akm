// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm task dispatch`: which enabled tasks are due in which minutes, the
 * catch-up window, the run-in-flight skip, and that nothing is opened or written
 * when nothing is due. The process-level behaviour (a child outliving the
 * dispatch) is in tests/integration/tasks-dispatch-cli.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../src/core/config/config";
import { getStateDbPath, withStateDb } from "../src/core/state-db";
import { listActiveTaskRuns, reserveTaskHistoryAttempt } from "../src/storage/repositories/task-history-repository";
import { DISPATCH_WINDOW_MINUTES, dispatchDueTasks, minutesToEvaluate } from "../src/tasks/dispatch";
import { reserveTaskAttempt } from "../src/tasks/run/attempt-lifecycle";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

const MINUTE = 60_000;
/** Monday 2026-11-09 09:30 local. */
const NINE_THIRTY = new Date(2026, 10, 9, 9, 30, 0, 0);

let storage: IsolatedAkmStorage;
let statePath: string;
let logDir: string;
let started: Array<{ argv: readonly string[]; logPath: string }>;

const start = async (argv: readonly string[], logPath: string) => {
  started.push({ argv, logPath });
};

function configure(enabled: string[], extra: Record<string, unknown> = {}): void {
  saveConfig({
    semanticSearchMode: "off",
    defaultBundle: "stash",
    bundles: { stash: { path: storage.stashDir, writable: true }, ...extra },
    scheduler: { enabled },
  });
}

function writeTask(id: string, schedule: string | string[], extraYaml: string[] = []): void {
  const lines = ["version: 4", "run: 'true'", ...extraYaml];
  if (typeof schedule === "string") lines.push(`schedule: "${schedule}"`);
  else lines.push("schedule:", ...schedule);
  fs.mkdirSync(path.join(storage.stashDir, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(storage.stashDir, "tasks", `${id}.yml`), `${lines.join("\n")}\n`);
}

const dispatchAt = (when: Date) =>
  dispatchDueTasks({ now: () => when, launcher: ["/opt/akm"], start, statePath, logDir });

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  statePath = path.join(storage.stateDir, "akm", "scheduler", "dispatch-minute");
  logDir = path.join(storage.cacheDir, "task-logs");
  started = [];
});

afterEach(() => {
  storage.cleanup();
});

describe("minutesToEvaluate", () => {
  test("the first dispatch evaluates only the current minute", () => {
    expect(minutesToEvaluate(1000, undefined)).toEqual([1000]);
  });

  test("the next minute evaluates just that minute", () => {
    expect(minutesToEvaluate(1000, 999)).toEqual([1000]);
  });

  test("a late start evaluates every minute since the last one", () => {
    expect(minutesToEvaluate(1000, 997)).toEqual([998, 999, 1000]);
  });

  test("catch-up is capped at the window", () => {
    const minutes = minutesToEvaluate(1000, 900);
    expect(minutes).toHaveLength(DISPATCH_WINDOW_MINUTES);
    expect(minutes.at(-1)).toBe(1000);
    expect(minutes[0]).toBe(1000 - DISPATCH_WINDOW_MINUTES + 1);
  });

  test("a minute already dispatched is not dispatched again, even with the clock a little behind", () => {
    expect(minutesToEvaluate(1000, 1000)).toEqual([]);
    expect(minutesToEvaluate(1000, 1002)).toEqual([]);
  });

  test("a last minute far ahead means the clock was set back: start over at the current minute", () => {
    expect(minutesToEvaluate(1000, 1000 + DISPATCH_WINDOW_MINUTES + 1)).toEqual([1000]);
  });
});

describe("dispatchDueTasks", () => {
  test("starts an enabled task whose schedule matches this minute, detached, with the unattended marker", async () => {
    writeTask("due", "30 9 * * *");
    configure(["stash//tasks/due"]);

    const result = await dispatchAt(NINE_THIRTY);

    expect(result.started).toEqual(["stash//tasks/due"]);
    expect(result.skipped).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(started).toEqual([
      {
        argv: ["/opt/akm", "task", "run", "due", "--bundle", "stash", "--scheduled"],
        logPath: path.join(logDir, "stash__due.log"),
      },
    ]);
  });

  test("does not start a task that is not due, not enabled, or has no schedule", async () => {
    writeTask("later", "45 9 * * *");
    writeTask("unlisted", "30 9 * * *");
    fs.writeFileSync(path.join(storage.stashDir, "tasks", "manual.yml"), "version: 4\nrun: 'true'\n");
    configure(["stash//tasks/later", "stash//tasks/manual"]);

    const result = await dispatchAt(NINE_THIRTY);

    expect(result.started).toEqual([]);
    expect(started).toEqual([]);
  });

  test("a config without scheduler.enabled schedules nothing", async () => {
    writeTask("due", "30 9 * * *");
    saveConfig({
      semanticSearchMode: "off",
      defaultBundle: "stash",
      bundles: { stash: { path: storage.stashDir, writable: true } },
    });

    const result = await dispatchAt(NINE_THIRTY);

    expect(result.started).toEqual([]);
    expect(result.window).toBe(0);
  });

  test("opens no database and writes no state when nothing is due, and records the minute", async () => {
    writeTask("later", "45 9 * * *");
    configure(["stash//tasks/later"]);
    expect(fs.existsSync(getStateDbPath())).toBe(false);

    await dispatchAt(NINE_THIRTY);

    expect(fs.existsSync(getStateDbPath())).toBe(false);
    expect(fs.readFileSync(statePath, "utf8").trim()).toBe(String(Math.floor(NINE_THIRTY.getTime() / MINUTE)));
  });

  test("a minute is dispatched once: a second dispatch in the same minute starts nothing", async () => {
    writeTask("due", "30 9 * * *");
    configure(["stash//tasks/due"]);

    await dispatchAt(NINE_THIRTY);
    const again = await dispatchAt(new Date(NINE_THIRTY.getTime() + 20_000));

    expect(again.window).toBe(0);
    expect(started).toHaveLength(1);
  });

  test("a late start catches up the minutes it missed, and a task due in several of them runs once", async () => {
    writeTask("tick", "* * * * *");
    writeTask("missed", "28 9 * * *");
    configure(["stash//tasks/tick", "stash//tasks/missed"]);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${Math.floor(NINE_THIRTY.getTime() / MINUTE) - 3}\n`);

    const result = await dispatchAt(NINE_THIRTY);

    expect(result.window).toBe(3);
    expect([...result.started].sort()).toEqual(["stash//tasks/missed", "stash//tasks/tick"]);
    expect(started).toHaveLength(2);
  });

  test("passes schedule inputs as sorted flags, with = for a value that starts with -, from the first matching entry", async () => {
    writeTask(
      "withinputs",
      [
        "  - cron: '30 9 * * *'",
        "    inputs: { b: '-x', a: 'one two' }",
        "  - cron: '* * * * *'",
        "    inputs: { a: 'ignored' }",
      ],
      ["inputs:", "  a: { type: string }", "  b: { type: string }"],
    );
    configure(["stash//tasks/withinputs"]);

    await dispatchAt(NINE_THIRTY);

    expect(started).toHaveLength(1);
    expect(started[0]?.argv.slice(-4)).toEqual(["--scheduled", "--a", "one two", "--b=-x"]);
  });

  test("a task that cannot be read is reported and the others still start", async () => {
    writeTask("good", "30 9 * * *");
    fs.writeFileSync(path.join(storage.stashDir, "tasks", "broken.yml"), "version: 4\nrun: [unterminated\n");
    configure(["stash//tasks/broken", "stash//tasks/good", "ghost//tasks/x", "stash//tasks/missing"]);

    const result = await dispatchAt(NINE_THIRTY);

    expect(result.started).toEqual(["stash//tasks/good"]);
    expect(result.failures.map((failure) => failure.ref).sort()).toEqual([
      "ghost//tasks/x",
      "stash//tasks/broken",
      "stash//tasks/missing",
    ]);
  });

  test("a task that cannot be started is a failure, not a throw", async () => {
    writeTask("good", "30 9 * * *");
    configure(["stash//tasks/good"]);

    const result = await dispatchDueTasks({
      now: () => NINE_THIRTY,
      launcher: ["/opt/akm"],
      statePath,
      logDir,
      start: async () => {
        throw new Error("spawn ENOENT");
      },
    });

    expect(result.started).toEqual([]);
    expect(result.failures).toEqual([{ ref: "stash//tasks/good", reason: "spawn ENOENT" }]);
  });
});

describe("the log of a started task", () => {
  test("is named with the bundle, so the same task id in two bundles does not share one", async () => {
    writeTask("dup", "30 9 * * *");
    fs.mkdirSync(path.join(storage.root, "b2", "tasks"), { recursive: true });
    fs.writeFileSync(
      path.join(storage.root, "b2", "tasks", "dup.yml"),
      "version: 4\nrun: 'true'\nschedule: \"30 9 * * *\"\n",
    );
    configure(["stash//tasks/dup", "b2//tasks/dup"], { b2: { path: path.join(storage.root, "b2"), writable: true } });

    await dispatchAt(NINE_THIRTY);

    expect(started.map((run) => path.basename(run.logPath)).sort()).toEqual(["b2__dup.log", "stash__dup.log"]);
  });
});

describe("a run still in flight", () => {
  const reserve = (taskId: string, startedAt: Date, metadata: Record<string, unknown>) =>
    withStateDb((db) =>
      reserveTaskHistoryAttempt(db, {
        task_id: taskId,
        status: "active",
        started_at: startedAt.toISOString(),
        completed_at: null,
        failed_at: null,
        log_path: null,
        target_kind: null,
        target_ref: null,
        metadata_json: JSON.stringify({ metadataVersion: 2, durationMs: 0, detail: null, ...metadata }),
      }),
    );

  /** A pid that is certainly gone: a child that has exited. */
  function deadPid(): number {
    const child = spawnSync(process.execPath, ["-e", "0"]);
    expect(child.status).toBe(0);
    return child.pid as number;
  }

  beforeEach(() => {
    writeTask("busy", "30 9 * * *");
    configure(["stash//tasks/busy"]);
  });

  test("is skipped while the process that reserved it is alive", async () => {
    reserve("busy", new Date(NINE_THIRTY.getTime() - 60 * MINUTE), { pid: process.pid });

    const result = await dispatchAt(NINE_THIRTY);

    expect(result.started).toEqual([]);
    expect(result.skipped).toEqual([{ ref: "stash//tasks/busy", reason: "a run of this task is still in flight" }]);
  });

  test("does not block the task when its process is gone (a crash or reboot left the row)", async () => {
    reserve("busy", new Date(NINE_THIRTY.getTime() - 60 * MINUTE), { pid: deadPid() });

    const result = await dispatchAt(NINE_THIRTY);

    expect(result.started).toEqual(["stash//tasks/busy"]);
  });

  test("a pid that is alive does not block the task forever: past the default timeout the row is stale (a reused pid)", async () => {
    reserve("busy", new Date(NINE_THIRTY.getTime() - 7 * 60 * MINUTE), { pid: process.pid });

    expect((await dispatchAt(NINE_THIRTY)).started).toEqual(["stash//tasks/busy"]);
  });

  test("a row written without a pid counts for the default six-hour timeout, then no longer", async () => {
    reserve("busy", new Date(NINE_THIRTY.getTime() - 60 * MINUTE), {});
    expect((await dispatchAt(NINE_THIRTY)).skipped).toHaveLength(1);

    const later = new Date(NINE_THIRTY.getTime() + 24 * 60 * MINUTE);
    reserve("busy", new Date(later.getTime() - 7 * 60 * MINUTE), {});
    expect((await dispatchAt(later)).started).toEqual(["stash//tasks/busy"]);
  });

  test("another task's run does not block this one", async () => {
    reserve("someone-else", new Date(NINE_THIRTY.getTime() - 60 * MINUTE), { pid: process.pid });

    expect((await dispatchAt(NINE_THIRTY)).started).toEqual(["stash//tasks/busy"]);
  });

  test("a run records the process that reserved its history row, which is what dispatch looks for", () => {
    reserveTaskAttempt("busy", new Date());

    const [run] = withStateDb((db) => listActiveTaskRuns(db, ["busy"]));

    expect(run).toMatchObject({ task_id: "busy", pid: process.pid });
  });
});
