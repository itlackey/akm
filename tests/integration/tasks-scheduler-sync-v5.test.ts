// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Version 5 tasks on the scheduler: each `schedule:` entry compiles to a binding whose tail carries its inputs,
 * `--env`, `--secret` and `--timeout`; sync checks each entry as a start would and reports one that fails, with its
 * reason, leaving the task's installed rows as they are; `task enable` installs the rows. The native scheduler is
 * an in-memory double.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmTasksEnable, akmTasksSync } from "../../src/commands/tasks/tasks";
import { loadConfig } from "../../src/core/config/config";
import { isSchedulerRefEnabled } from "../../src/tasks/activation-config";
import type { SchedulerBackend } from "../../src/tasks/backends/types";
import type { SchedulerBinding } from "../../src/tasks/scheduler-binding";
import { compileSchedulerSources } from "../../src/tasks/scheduler-sync";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let installed: Map<string, SchedulerBinding>;

const backend: SchedulerBackend = {
  name: "cron",
  install(binding: SchedulerBinding) {
    installed.set(binding.id, binding);
  },
  uninstall(id: string) {
    installed.delete(id);
  },
  setEnabled() {},
  list() {
    return [...installed.values()].map((binding) => ({
      id: binding.id,
      binding: ["/test/akm"],
      environment: { AKM_BUNDLE_DIR: storage.stashDir },
      target: "stash",
      invocation: binding.invocation,
      signature: JSON.stringify([binding.cron, binding.invocation]),
    }));
  },
  expectedSignature: (binding: SchedulerBinding) => JSON.stringify([binding.cron, binding.invocation]),
};

function write(relative: string, content: string): void {
  const file = path.join(storage.stashDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

const compile = () =>
  compileSchedulerSources({ sourceRoot: storage.stashDir, adapterId: "akm", bundleName: "stash", backend: "cron" });

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({ bundles: { stash: { path: storage.stashDir, writable: true } }, defaultBundle: "stash" });
  installed = new Map();
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

describe("a version 5 task's schedule entries compile to bindings", () => {
  test("each entry's inputs, --env, --secret and --timeout are in its tail, and an entry with none has the plain tail", async () => {
    write(
      "tasks/nightly.yml",
      TASK([
        "  - cron: '0 3 * * *'",
        "    inputs: { scope: a }",
        "    env: [env/lab]",
        "    secret: ['secrets/deploy:DEPLOY']",
        "    timeout: 5m",
        "  - cron: '0 4 * * *'",
        "    inputs: { scope: b }",
      ]),
    );
    const { desired, failures } = await compile();
    expect(failures).toEqual([]);
    expect(desired.map((binding) => binding.invocation)).toEqual([
      [
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
      ["task", "run", "nightly", "--bundle", "stash", "--scheduled", "--scope", "b"],
    ]);
  });
});

describe("sync checks each version 5 entry as a start does", () => {
  const reason = async (schedule: string[]) => {
    write("tasks/nightly.yml", TASK(schedule));
    const { desired, failures } = await compile();
    expect(desired).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.ref).toBe("stash//tasks/nightly");
    return failures[0]?.reason as string;
  };

  test("an env asset the entry names that does not exist", async () => {
    expect(await reason(["  - cron: '@daily'", "    inputs: { scope: a }", "    env: [env/missing]"])).toMatch(
      /schedule\[0\].*env\/missing/s,
    );
  });

  test("a required input the entry does not give", async () => {
    expect(await reason(["  - cron: '@daily'", "    inputs: { scope: a }", "  - cron: '@weekly'"])).toMatch(
      /schedule\[1\].*scope/s,
    );
  });

  test("a secret that does not exist", async () => {
    expect(await reason(["  - cron: '@daily'", "    inputs: { scope: a }", "    secret: ['secrets/none:X']"])).toMatch(
      /schedule\[0\].*secrets\/none/s,
    );
  });

  test("a NAME: value env entry, which a scheduled start cannot be given", async () => {
    expect(await reason(["  - cron: '@daily'", "    inputs: { scope: a }", "    env: [{ REGION: eu }]"])).toMatch(
      /schedule\[0\]\.env.*env asset/s,
    );
  });

  test("a failing task leaves its installed rows alone and the other tasks sync", async () => {
    write("tasks/nightly.yml", TASK(["  - cron: '@daily'", "    inputs: { scope: a }"]));
    write("tasks/other.yml", ["version: 4", "run: echo hi", "schedule: '@daily'", ""].join("\n"));
    await akmTasksEnable("nightly", {}, { backend });
    await akmTasksEnable("other", {}, { backend });
    const before = installed.get("nightly");
    expect(before).toBeDefined();
    write("tasks/nightly.yml", TASK(["  - cron: '@daily'", "    inputs: { scope: a }", "    env: [env/missing]"]));
    const result = await akmTasksSync({ backend });
    expect(result.failures.map((failure) => failure.ref)).toEqual(["stash//tasks/nightly"]);
    expect(installed.get("nightly")).toBe(before);
    expect(installed.has("other")).toBe(true);
  });
});

describe("task enable for a version 5 task", () => {
  test("enables the ref and installs a row for each entry", async () => {
    write("tasks/nightly.yml", TASK(["  - cron: '0 3 * * *'", "    inputs: { scope: a }", "    timeout: 5m"]));
    const result = await akmTasksEnable("nightly", {}, { backend });
    expect(result).toMatchObject({ ref: "stash//tasks/nightly", enabled: true });
    expect(isSchedulerRefEnabled(loadConfig(), "stash//tasks/nightly")).toBe(true);
    expect(installed.get("nightly")?.invocation).toEqual([
      "task",
      "run",
      "nightly",
      "--bundle",
      "stash",
      "--scheduled",
      "--scope",
      "a",
      "--timeout",
      "5m",
    ]);
  });

  test("a task whose entry fails the check is reported, not enabled silently", async () => {
    write("tasks/nightly.yml", TASK(["  - cron: '@daily'", "    inputs: { scope: a }", "    env: [env/missing]"]));
    const result = await akmTasksEnable("nightly", {}, { backend });
    expect(result.sync.failures.map((failure) => failure.ref)).toEqual(["stash//tasks/nightly"]);
    expect(result.sync.failures[0]?.reason).toMatch(/env\/missing/);
    expect(installed.size).toBe(0);
  });
});
