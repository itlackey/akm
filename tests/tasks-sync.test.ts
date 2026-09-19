// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm task sync` schedule-drift detection (0.8.4 hotfix).
 *
 * Before the fix, sync classified any task already present in the scheduler as
 * "unchanged" without comparing its cron line, so a changed `schedule:` in the
 * .yml never reached the crontab. These tests drive the real `akmTasksSync`
 * with an injected cron backend (in-memory crontab) and assert that a changed
 * schedule is detected and reinstalled.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmTasksSync } from "../src/commands/tasks/tasks";
import { CRON_BACKEND, type CronExec, type CronExecResult } from "../src/tasks/backends/cron";
import {
  resolveScheduledTaskContext,
  schedulerContextDescriptor,
  writeSchedulerContextDescriptor,
} from "../src/tasks/scheduler-invocation";
import type { Cleanup } from "./_helpers/sandbox";
import { sandboxStashDir, sandboxXdgConfigHome, sandboxXdgStateHome } from "./_helpers/sandbox";

let cleanup: Cleanup = () => {};
let stashDir = "";
let tasksDir = "";

function memoryExec(initial = ""): CronExec & { current: () => string } {
  let store = initial;
  return {
    read: (): CronExecResult => ({ status: 0, stdout: store, stderr: "" }),
    write: (content: string): CronExecResult => {
      store = content;
      return { status: 0, stdout: "", stderr: "" };
    },
    current: () => store,
  };
}

function writeTask(id: string, schedule: string, enabled = true): void {
  fs.writeFileSync(
    path.join(tasksDir, `${id}.yml`),
    `version: 4\nrun: echo ${id}\nname: ${id}\nschedule:\n  - cron: "${schedule}"\n    enabled: ${enabled}\n`,
    "utf8",
  );
}

beforeEach(() => {
  let chain: Cleanup = () => {};
  chain = sandboxXdgConfigHome(chain).cleanup;
  chain = sandboxXdgStateHome(chain).cleanup;
  const stash = sandboxStashDir(chain);
  stashDir = stash.dir;
  cleanup = stash.cleanup;
  tasksDir = path.join(stashDir, "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  stashDir = "";
  tasksDir = "";
});

describe("akmTasksSync — schedule drift", () => {
  const backendFor = (exec: CronExec) => {
    // #846: belongsToBundle now confirms a primary-bundle entry's owning
    // path from its own scheduler-context descriptor. This backend never
    // routes through the real launcher-eligibility path (no
    // `schedulerRuntime` deps injected), so install operations fall back to
    // CRON_BACKEND's own default context — write that descriptor for real,
    // matching it exactly, so it resolves on the next sync.
    writeSchedulerContextDescriptor(schedulerContextDescriptor(resolveScheduledTaskContext(), ""));
    return CRON_BACKEND({
      exec,
      fs: { ensureDir() {} },
      logDir: "/var/log/akm",
      akmArgv: ["/usr/local/bin/akm"],
      envPath: false,
    });
  };

  const backendForPath = (exec: CronExec, envPath: string) => {
    writeSchedulerContextDescriptor(schedulerContextDescriptor(resolveScheduledTaskContext(), envPath));
    return CRON_BACKEND({
      exec,
      fs: { ensureDir() {} },
      logDir: "/var/log/akm",
      akmArgv: ["/usr/local/bin/akm"],
      envPath,
    });
  };

  test("installs missing, then reports unchanged on a no-op re-sync", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");
    writeTask("beta", "0 2 * * *");

    const first = await akmTasksSync({ backend });
    expect(first.installed.sort()).toEqual(["alpha", "beta"]);
    expect(first.updated).toEqual([]);

    const second = await akmTasksSync({ backend });
    expect(second.installed).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.unchanged.sort()).toEqual(["alpha", "beta"]);
    const bundleName = path.basename(stashDir).toLowerCase();
    expect(exec.current()).toContain(`task run alpha --bundle ${bundleName} --scheduled`);
    expect(exec.current()).toContain(`task run beta --bundle ${bundleName} --scheduled`);
  });

  test("adding one task preserves existing bindings captured under a different ambient PATH", async () => {
    const exec = memoryExec();
    writeTask("alpha", "*/15 * * * *");
    await akmTasksSync({ backend: backendForPath(exec, "/captured/bin:/usr/bin") });
    const alphaBefore = exec.current().match(/# akm:task alpha BEGIN[\s\S]*?# akm:task alpha END/)?.[0];

    writeTask("beta", "0 2 * * *");
    const result = await akmTasksSync({ backend: backendForPath(exec, "/ambient/bin:/usr/bin") });

    expect(result.installed).toEqual(["beta"]);
    expect(result.updated).toEqual([]);
    expect(result.unchanged).toEqual(["alpha"]);
    expect(exec.current().match(/# akm:task alpha BEGIN[\s\S]*?# akm:task alpha END/)?.[0]).toBe(alphaBefore);
  });

  test("an unrelated sync preserves a task manually disabled in crontab", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *", true);
    await akmTasksSync({ backend });
    exec.write(exec.current().replace(/^([^#\n].*task run alpha.*)$/m, "# akm:disabled $1"));

    writeTask("beta", "0 2 * * *");
    const result = await akmTasksSync({ backend });

    expect(result.installed).toEqual(["beta"]);
    expect(result.updated).toEqual([]);
    expect(result.unchanged).toEqual(["alpha"]);
    expect(exec.current()).toContain("# akm:disabled */15 * * * *");
  });

  test("detects a changed schedule and reinstalls it (the bug fix)", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");
    writeTask("beta", "0 2 * * *");
    await akmTasksSync({ backend });

    // Edit beta's schedule on disk, as `akm task` never rewrites it.
    writeTask("beta", "45 */6 * * *");

    const result = await akmTasksSync({ backend });
    expect(result.updated).toEqual(["beta"]);
    expect(result.unchanged).toEqual(["alpha"]);
    expect(result.installed).toEqual([]);
    // The crontab now carries the new schedule, not the stale one.
    expect(exec.current()).toContain("45 */6 * * * /usr/local/bin/akm --scheduler-context");
    expect(exec.current()).toContain("task run beta --bundle");
    expect(exec.current()).not.toContain("0 2 * * * /usr/local/bin/akm");
  });

  test("detects an enabled→disabled flip and reinstalls commented", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *", true);
    await akmTasksSync({ backend });
    expect(exec.current()).not.toContain("# akm:disabled");

    writeTask("alpha", "*/15 * * * *", false);
    const result = await akmTasksSync({ backend });
    expect(result.updated).toEqual(["alpha"]);
    expect(exec.current()).toContain("# akm:disabled */15 * * * * /usr/local/bin/akm --scheduler-context");
    expect(exec.current()).toContain("task run alpha --bundle");
  });

  test("removes orphaned scheduler entries with no backing file", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");
    writeTask("gamma", "0 5 * * *");
    await akmTasksSync({ backend });

    fs.rmSync(path.join(tasksDir, "gamma.yml"));
    const result = await akmTasksSync({ backend });
    expect(result.removed).toEqual(["gamma"]);
    expect(exec.current()).not.toContain("task run gamma");
    expect(exec.current()).toContain("task run alpha");
  });

  // #867: degrades — the unversioned task is reported and excluded rather
  // than installed, and never poisons a sync where it's the only source.
  test("reports an unversioned task instead of installing it", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    fs.writeFileSync(
      path.join(tasksDir, "legacy.yml"),
      'schedule: "@hourly"\ncommand: akm improve --profile quick --auto-accept safe\nenabled: true\n',
      "utf8",
    );

    const result = await akmTasksSync({ backend });
    expect(result.installed).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.reason).toMatch(/version is required and must be 4/);
    expect(exec.current()).toBe("");
  });

  // A malformed native artifact does not prove its logical owner. Even when
  // its marker resembles the desired task, sync must not overwrite it.
  test("preserves and rejects a scheduler invocation without a context descriptor", async () => {
    const exec = memoryExec(
      [
        "# akm:task alpha BEGIN",
        "# akm:disabled */15 * * * * /usr/local/bin/akm tasks run alpha >> /var/log/akm/alpha.log 2>&1",
        "# akm:task alpha END",
        "",
      ].join("\n"),
    );
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *", false);
    const prior = exec.current();

    await expect(akmTasksSync({ backend })).rejects.toThrow(/native scheduler artifact|unproven owner/i);
    expect(exec.current()).toBe(prior);
  });

  test("preserves and rejects a pre-rename `tasks run` artifact with unproven ownership", async () => {
    const exec = memoryExec(
      [
        "# akm:task alpha BEGIN",
        `*/15 * * * * /usr/local/bin/akm --scheduler-context /var/lib/akm/context/one.json tasks run alpha --scheduled >> /var/log/akm/alpha.log 2>&1`,
        "# akm:task alpha END",
        "",
      ].join("\n"),
    );
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *", true);
    const prior = exec.current();

    await expect(akmTasksSync({ backend })).rejects.toThrow(/native scheduler artifact|unproven owner/i);
    expect(exec.current()).toBe(prior);
  });

  // A pre-#867 crontab entry (written by an older akm, before `--bundle` was
  // added to the installed invocation) is still akm's own proven owner: it
  // sits inside the `# akm:task alpha BEGIN/END` markers and carries a valid
  // `--scheduler-context` descriptor for task "alpha". Sync must reconcile
  // it to the current invocation shape, not refuse the whole run.
  test("reconciles a pre-`--bundle` native entry instead of refusing it as an unproven owner", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");
    await akmTasksSync({ backend });
    const before = exec.current();
    const stripped = before.replace(/--bundle\s+\S+\s+/, "");
    expect(stripped).not.toBe(before);
    exec.write(stripped);

    const result = await akmTasksSync({ backend });

    expect(result.updated).toEqual(["alpha"]);
    expect(exec.current()).toContain("task run alpha --bundle");
  });

  test("a failed replacement leaves the prior native definition active", async () => {
    let store = "";
    let failNextWrite = false;
    const exec: CronExec & { current: () => string } = {
      read: () => ({ status: 0, stdout: store, stderr: "" }),
      write(content) {
        store = content;
        if (failNextWrite) {
          failNextWrite = false;
          return { status: 1, stdout: "", stderr: "injected replacement failure" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      current: () => store,
    };
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");
    await akmTasksSync({ backend });
    const prior = exec.current();
    writeTask("alpha", "45 */6 * * *");
    failNextWrite = true;

    await expect(akmTasksSync({ backend })).rejects.toThrow("injected replacement failure");

    expect(exec.current()).toBe(prior);
    expect(exec.current()).toContain("*/15 * * * *");
    expect(exec.current()).not.toContain("45 */6 * * *");
  });
});
