// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm tasks sync` schedule-drift detection (0.8.4 hotfix).
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
import { akmTasksSync } from "../../src/commands/tasks/tasks";
import { CRON_BACKEND, type CronExec, type CronExecResult } from "../../src/tasks/backends/cron";
import type { Cleanup } from "../_helpers/sandbox";
import { sandboxStashDir, sandboxXdgConfigHome, sandboxXdgStateHome } from "../_helpers/sandbox";

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
    `version: 2\nschedule: "${schedule}"\ncommand: echo ${id}\nenabled: ${enabled}\nname: ${id}\n`,
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
  const backendFor = (exec: CronExec) =>
    CRON_BACKEND({
      exec,
      fs: { ensureDir() {} },
      logDir: "/var/log/akm",
      akmArgv: ["/usr/local/bin/akm"],
      envPath: false,
    });

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
  });

  test("detects a changed schedule and reinstalls it (the bug fix)", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");
    writeTask("beta", "0 2 * * *");
    await akmTasksSync({ backend });

    // Edit beta's schedule on disk, as `akm tasks` never rewrites it.
    writeTask("beta", "45 */6 * * *");

    const result = await akmTasksSync({ backend });
    expect(result.updated).toEqual(["beta"]);
    expect(result.unchanged).toEqual(["alpha"]);
    expect(result.installed).toEqual([]);
    // The crontab now carries the new schedule, not the stale one.
    expect(exec.current()).toContain("45 */6 * * * /usr/local/bin/akm --scheduler-context");
    expect(exec.current()).toContain("tasks run beta --scheduled");
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
    expect(exec.current()).toContain("tasks run alpha --scheduled");
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
    expect(exec.current()).not.toContain("tasks run gamma");
    expect(exec.current()).toContain("tasks run alpha");
  });

  test("installs an unchanged 0.8 task definition after upgrade", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    fs.writeFileSync(
      path.join(tasksDir, "legacy.yml"),
      'schedule: "@hourly"\ncommand: akm improve --profile quick --auto-accept safe\nenabled: true\n',
      "utf8",
    );

    const result = await akmTasksSync({ backend });
    expect(result.skipped).toEqual([]);
    expect(result.installed).toEqual(["legacy"]);
    expect(exec.current()).toContain("/usr/local/bin/akm --scheduler-context");
    expect(exec.current()).toContain("tasks run legacy");
  });

  test("preserves a persisted legacy invocation until explicit rebind", async () => {
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

    const result = await akmTasksSync({ backend });

    expect(result.updated).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("tasks sync --rebind");
    expect(exec.current()).toContain("/usr/local/bin/akm tasks run alpha");
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
