// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * End-to-end coverage for bundle-targeted tasks (issue #711): scheduling tasks
 * from a non-default bundle via `--target`, threaded through the command layer
 * into the real cron backend (an in-memory crontab). Proves:
 *   1. enable / disable / run a task living in a NON-default bundle works
 *      end-to-end (file resolved from that bundle; cron line carries `--target`).
 *   2. `--target` on a NON-writable bundle fails with a writable-enforcement error.
 *   3. an id colliding with one already scheduled from another bundle → hard error.
 *   4. a plain (primary) sync never removes a `--target <other>` entry; a scoped
 *      `sync --target X` reconciles only X's entries.
 *   5. the default bundle (or no `--target`) produces a byte-identical cron line.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmTasksAdd, akmTasksRun, akmTasksSetEnabled, akmTasksSync } from "../../../src/commands/tasks/tasks";
import { saveConfig } from "../../../src/core/config/config";
import { buildCronLine, CRON_BACKEND, type CronExec, type CronExecResult } from "../../../src/tasks/backends/cron";
import type { ScheduledTaskContext } from "../../../src/tasks/scheduler-invocation";
import type { TaskDocument } from "../../../src/tasks/schema";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
} from "../../_helpers/sandbox";

const SCHEDULED_CONTEXT: ScheduledTaskContext = {
  AKM_STASH_DIR: "/srv/akm/stash",
  AKM_CONFIG_DIR: "/srv/akm/config",
  AKM_DATA_DIR: "/srv/akm/data",
  AKM_CACHE_DIR: "/srv/akm/cache",
  AKM_STATE_DIR: "/srv/akm/state",
};

function memoryExec(initial = ""): CronExec & { current: () => string } {
  let store = initial;
  return {
    read(): CronExecResult {
      return { status: 0, stdout: store, stderr: "" };
    },
    write(content: string): CronExecResult {
      store = content;
      return { status: 0, stdout: "", stderr: "" };
    },
    current: () => store,
  };
}

let iso: IsolatedAkmStorage;
let work: SandboxedDir;
let readonlyDir: SandboxedDir;
let exec: ReturnType<typeof memoryExec>;

function cron() {
  return CRON_BACKEND({
    exec,
    fs: { ensureDir() {} },
    logDir: "/var/log/akm",
    akmArgv: ["/usr/local/bin/akm"],
    envPath: false,
    scheduledContext: SCHEDULED_CONTEXT,
  });
}

function writeTaskFile(dir: string, id: string, yaml: string): void {
  fs.mkdirSync(path.join(dir, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tasks", `${id}.yml`), yaml, "utf8");
}

/** Extract the crontab body line (between BEGIN/END markers) for a task id. */
function cronBody(crontab: string, id: string): string | undefined {
  const lines = crontab.split(/\r?\n/);
  const begin = lines.indexOf(`# akm:task ${id} BEGIN`);
  if (begin === -1) return undefined;
  return lines[begin + 1];
}

beforeEach(() => {
  iso = withIsolatedAkmStorage();
  work = makeSandboxDir("akm-bundle-work");
  readonlyDir = makeSandboxDir("akm-bundle-ro");
  exec = memoryExec();
  saveConfig({
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    defaultBundle: "stash",
    bundles: {
      stash: { path: iso.stashDir, writable: true },
      work: { path: work.dir, writable: true },
      readonly: { path: readonlyDir.dir, writable: false },
    },
  });
  fs.mkdirSync(path.join(iso.stashDir, "tasks"), { recursive: true });
});

afterEach(() => {
  iso.cleanup();
  work.cleanup();
  readonlyDir.cleanup();
});

describe("bundle-targeted tasks via --target", () => {
  test("enable/disable/run a task in a NON-default bundle carries --target through cron", async () => {
    writeTaskFile(work.dir, "foo", ['schedule: "@daily"', 'command: "true"', "enabled: false", ""].join("\n"));

    // enable --target work → installs, cron line embeds `--target work`.
    const enabled = await akmTasksSetEnabled("foo", true, { backend: cron() }, "work");
    expect(enabled.enabled).toBe(true);
    expect(fs.readFileSync(path.join(work.dir, "tasks", "foo.yml"), "utf8")).toContain("enabled: true");

    const body = cronBody(exec.current(), "foo");
    expect(body).toBeDefined();
    expect(body).toContain("tasks run foo --target work --scheduled");
    // The file must NOT have been written to the primary stash.
    expect(fs.existsSync(path.join(iso.stashDir, "tasks", "foo.yml"))).toBe(false);

    // run --target work resolves the file from bundle work and executes it.
    const ran = await akmTasksRun("foo", { target: "work" });
    expect(ran.result.status).toBe("completed");

    // disable --target work comments the entry (still target-attributed).
    await akmTasksSetEnabled("foo", false, { backend: cron() }, "work");
    const disabledBody = cronBody(exec.current(), "foo");
    expect(disabledBody?.startsWith("# akm:disabled ")).toBe(true);
    expect(disabledBody).toContain("--target work");
  });

  test("--target on a NON-writable bundle fails with a writable-enforcement error", async () => {
    writeTaskFile(work.dir, "foo", ['schedule: "@daily"', 'command: "true"', "enabled: false", ""].join("\n"));
    await expect(akmTasksSetEnabled("foo", true, { backend: cron() }, "readonly")).rejects.toThrow(/not writable/i);
    // add --target readonly is likewise refused before writing anything.
    await expect(
      akmTasksAdd({ id: "bar", schedule: "@daily", command: "true", target: "readonly" }, { backend: cron() }),
    ).rejects.toThrow(/not writable/i);
  });

  test("an id already scheduled from another bundle is a hard collision error", async () => {
    writeTaskFile(work.dir, "foo", ['schedule: "@daily"', 'command: "true"', "enabled: true", ""].join("\n"));
    await akmTasksSetEnabled("foo", true, { backend: cron() }, "work");

    // Adding the same id to the primary bundle collides with work's entry.
    await expect(akmTasksAdd({ id: "foo", schedule: "@daily", command: "true" }, { backend: cron() })).rejects.toThrow(
      /already scheduled from bundle "work"/,
    );
    // The primary add must not have written a file or clobbered the cron entry.
    expect(fs.existsSync(path.join(iso.stashDir, "tasks", "foo.yml"))).toBe(false);
    expect(cronBody(exec.current(), "foo")).toContain("--target work");
  });

  test("plain sync never removes a --target entry; sync --target reconciles only that bundle", async () => {
    // A primary task and a work-bundle task, both scheduled.
    await akmTasksAdd({ id: "bar", schedule: "@daily", command: "true" }, { backend: cron() });
    writeTaskFile(work.dir, "foo", ['schedule: "@daily"', 'command: "true"', "enabled: true", ""].join("\n"));
    await akmTasksSetEnabled("foo", true, { backend: cron() }, "work");

    // Plain (primary) sync: reconciles only `bar`; `foo` (target work) is untouched.
    const primarySync = await akmTasksSync({ backend: cron() });
    expect(primarySync.removed).toEqual([]);
    expect(cronBody(exec.current(), "foo")).toContain("--target work");
    expect(cronBody(exec.current(), "bar")).toBeDefined();

    // Deleting the work file then syncing --target work removes only foo.
    fs.rmSync(path.join(work.dir, "tasks", "foo.yml"));
    const workSync = await akmTasksSync({ backend: cron() }, "work");
    expect(workSync.removed).toEqual(["foo"]);
    expect(cronBody(exec.current(), "foo")).toBeUndefined();
    // The primary task survives the scoped sync.
    expect(cronBody(exec.current(), "bar")).toBeDefined();
  });

  test("default bundle / no --target yields a byte-identical cron line (no --target token)", async () => {
    const result = await akmTasksAdd({ id: "baz", schedule: "@daily", command: "true" }, { backend: cron() });
    expect(result.stashDir).toBe(iso.stashDir);

    const body = cronBody(exec.current(), "baz");
    expect(body).toBeDefined();
    expect(body).not.toContain("--target");
    expect(body).toContain("tasks run baz --scheduled");

    // Byte-for-byte equal to the pre-0.9 no-target rendering.
    const task: TaskDocument = {
      version: 2,
      schemaVersion: 2,
      id: "baz",
      schedule: "@daily",
      enabled: true,
      target: { kind: "command", cmd: ["true"] },
      source: { path: path.join(iso.stashDir, "tasks", "baz.yml") },
    };
    const expectedLine = buildCronLine(task, ["/usr/local/bin/akm"], "/var/log/akm", undefined, SCHEDULED_CONTEXT);
    expect(body).toBe(expectedLine);

    // Adding with --target stash (the DEFAULT bundle by name) is also byte-identical.
    fs.rmSync(path.join(iso.stashDir, "tasks", "baz.yml"));
    exec = memoryExec();
    await akmTasksAdd({ id: "baz", schedule: "@daily", command: "true", target: "stash" }, { backend: cron() });
    expect(cronBody(exec.current(), "baz")).toBe(expectedLine);
  });
});
