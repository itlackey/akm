// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Version 5 tasks on the scheduler: `akm task dispatch` reads each `schedule:` entry's inputs, `--env`, `--secret`
 * and `--timeout` into the `task run` it starts; `task doctor` checks each entry of an enabled task as a start would
 * and names one that fails, with its position, while the other tasks are still dispatched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmTasksDoctor } from "../../src/commands/tasks/tasks";
import { loadConfig, saveConfig } from "../../src/core/config/config";
import type { SchedulerBackend } from "../../src/tasks/backends/types";
import { dispatchDueTasks, unrunnableTasks, unrunnableV5ScheduleEntries } from "../../src/tasks/dispatch";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

/** Monday 2026-11-09 03:00 local. */
const THREE = new Date(2026, 10, 9, 3, 0, 0, 0);

let storage: IsolatedAkmStorage;
let started: Array<{ argv: readonly string[]; logPath: string }>;

function write(relative: string, content: string): void {
  const file = path.join(storage.stashDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function enable(...ids: string[]): void {
  saveConfig({
    semanticSearchMode: "off",
    defaultBundle: "stash",
    bundles: { stash: { path: storage.stashDir, writable: true } },
    scheduler: { enabled: ids.map((id) => `stash//tasks/${id}`) },
  });
}

const dispatch = () =>
  dispatchDueTasks({
    now: () => THREE,
    launcher: ["/opt/akm"],
    start: async (argv, logPath) => {
      started.push({ argv, logPath });
    },
    statePath: path.join(storage.stateDir, "akm", "scheduler", "dispatch-minute"),
    logDir: path.join(storage.cacheDir, "task-logs"),
  });

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  started = [];
  write("env/lab.env", "REGION=eu\n");
  write("secrets/deploy", "token");
  write("scripts/look.sh", "#!/bin/sh\necho hi\n");
});
afterEach(() => storage.cleanup());

const TASK = (schedule: string[]) =>
  [
    "version: 5-beta.1",
    "inputs:",
    "  scope: { type: string, required: true }",
    "steps:",
    "  - name: look",
    "    run: scripts/look.sh",
    "schedule:",
    ...schedule,
    "",
  ].join("\n");

describe("dispatch starts a version 5 task with its schedule entry's flags", () => {
  test("inputs, then --env, --secret and --timeout, in that order; an entry with none has the plain tail", async () => {
    write(
      "tasks/nightly.yml",
      TASK([
        "  - cron: '0 3 * * *'",
        "    inputs: { scope: a }",
        "    env: [env/lab]",
        "    secret: ['secrets/deploy:DEPLOY']",
        "    timeout: 5m",
      ]),
    );
    write("tasks/plain.yml", TASK(["  - cron: '0 3 * * *'", "    inputs: { scope: b }"]));
    enable("nightly", "plain");

    const result = await dispatch();

    expect(result.failures).toEqual([]);
    expect(started.map((entry) => entry.argv)).toEqual([
      [
        "/opt/akm",
        "task",
        "run",
        "nightly",
        "--bundle",
        "stash",
        "--scheduled",
        "--scope",
        "a",
        "--env",
        "env/lab",
        "--secret",
        "secrets/deploy:DEPLOY",
        "--timeout",
        "5m",
      ],
      ["/opt/akm", "task", "run", "plain", "--bundle", "stash", "--scheduled", "--scope", "b"],
    ]);
  });
});

describe("a version 5 entry is checked as a start checks it", () => {
  const reason = async (schedule: string[]) => {
    write("tasks/nightly.yml", TASK(schedule));
    enable("nightly");
    const failures = await unrunnableV5ScheduleEntries(loadConfig());
    expect(failures).toHaveLength(1);
    expect(failures[0]?.ref).toBe("stash//tasks/nightly");
    return failures[0]?.reason as string;
  };

  test("an env asset the entry names that does not exist", async () => {
    expect(await reason(["  - cron: '@daily'", "    inputs: { scope: a }", "    env: [env/missing]"])).toMatch(
      /schedule\[0\].*env\/missing/s,
    );
  });

  test("a required input the entry does not give is refused when the file is read, naming the entry", () => {
    write("tasks/nightly.yml", TASK(["  - cron: '@daily'", "    inputs: { scope: a }", "  - cron: '@weekly'"]));
    enable("nightly");
    const failures = unrunnableTasks(loadConfig());
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toMatch(/schedule\[1\].*scope/s);
  });

  test("a secret that does not exist", async () => {
    expect(await reason(["  - cron: '@daily'", "    inputs: { scope: a }", "    secret: ['secrets/none:X']"])).toMatch(
      /schedule\[0\].*secrets\/none/s,
    );
  });

  test("an entry that passes is not reported", async () => {
    write("tasks/nightly.yml", TASK(["  - cron: '@daily'", "    inputs: { scope: a }", "    env: [env/lab]"]));
    enable("nightly");
    expect(await unrunnableV5ScheduleEntries(loadConfig())).toEqual([]);
  });

  test("task doctor names the failing task, and dispatch still starts the others", async () => {
    write("tasks/nightly.yml", TASK(["  - cron: '0 3 * * *'", "    inputs: { scope: a }", "    env: [env/missing]"]));
    write("tasks/other.yml", ["version: 4", "run: echo hi", "schedule: '0 3 * * *'", ""].join("\n"));
    enable("nightly", "other");

    const backend = { name: "cron", inspect: async () => ({ entry: null, legacy: [] }) } as unknown as SchedulerBackend;
    const doctor = await akmTasksDoctor({ backend });
    expect(
      doctor.warnings.some((warning) => /Enabled task stash\/\/tasks\/nightly cannot run: schedule\[0\]/.test(warning)),
    ).toBe(true);

    await dispatch();
    expect(started.map((entry) => entry.argv[3])).toContain("other");
  });
});
