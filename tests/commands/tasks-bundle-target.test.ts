// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * End-to-end coverage for bundle-targeted tasks (issue #711): scheduling tasks
 * from a non-default bundle via `--bundle`, threaded through the command layer
 * into the real cron backend (an in-memory crontab). Proves:
 *   1. enable / disable / run a task living in a NON-default bundle works
 *      end-to-end (file resolved from that bundle; cron line carries `--bundle`).
 *   2. `--bundle` on a NON-writable bundle fails with a writable-enforcement error.
 *   3. an id colliding with one already scheduled from another bundle → hard error.
 *   4. a plain (primary) sync never removes a `--bundle <other>` entry; a scoped
 *      `sync --bundle X` reconciles only X's entries.
 *   5. the default bundle (or no `--bundle`) produces a byte-identical cron line.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  akmTasksAdd,
  akmTasksDisable,
  akmTasksEnable,
  akmTasksRun,
  akmTasksSync,
} from "../../src/commands/tasks/tasks";
import { loadConfig, resetConfigCache, saveConfig } from "../../src/core/config/config";
import { schedulerActivations, setSchedulerRefEnabled } from "../../src/tasks/activation-config";
import { buildCronLine, CRON_BACKEND, type CronExec, type CronExecResult } from "../../src/tasks/backends/cron";
import type { SchedulerBinding } from "../../src/tasks/scheduler-binding";
import {
  resolveScheduledTaskContext,
  type ScheduledTaskContext,
  schedulerContextDescriptor,
  schedulerContextPath,
  writeSchedulerContextDescriptor,
} from "../../src/tasks/scheduler-invocation";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
} from "../_helpers/sandbox";

const SCHEDULED_CONTEXT: ScheduledTaskContext = {
  AKM_BUNDLE_DIR: "/srv/akm/stash",
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

/**
 * #846: `SCHEDULED_CONTEXT` above is an intentionally unwritable fake path
 * (exercising special-character handling in the default cron line), so
 * belongsToBundle's owning-path check could never resolve it. Tests that
 * need a primary-bundle entry to actually be recognized as this stash's
 * own across more than one sync use this real, writable context instead.
 */
function cronRealContext() {
  return CRON_BACKEND({
    exec,
    fs: { ensureDir() {} },
    logDir: "/var/log/akm",
    akmArgv: ["/usr/local/bin/akm"],
    envPath: false,
    scheduledContext: resolveScheduledTaskContext(),
  });
}

function writeTaskFile(dir: string, id: string, yaml: string): void {
  fs.mkdirSync(path.join(dir, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tasks", `${id}.yml`), yaml, "utf8");
  const bundle = dir === work.dir ? "work" : dir === readonlyDir.dir ? "readonly" : "stash";
  setSchedulerRefEnabled("task", `${bundle}//tasks/${id}`, true);
}

function taskYaml(): string {
  return ["version: 4", 'run: "true"', "schedule:", '  - cron: "@daily"', ""].join("\n");
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

describe("bundle-targeted tasks via --bundle", () => {
  test("sync of a task in a NON-default bundle carries --bundle through cron, and local disable removes it", async () => {
    writeTaskFile(work.dir, "foo", taskYaml());

    // sync --bundle work → installs, cron line embeds `--bundle work`.
    const synced = await akmTasksSync({ backend: cron() }, "work");
    expect(synced.installed).toEqual(["foo"]);

    const body = cronBody(exec.current(), "foo");
    expect(body).toBeDefined();
    expect(body).toContain("task run foo --bundle work --scheduled");
    // The file must NOT have been written to the primary stash.
    expect(fs.existsSync(path.join(iso.stashDir, "tasks", "foo.yml"))).toBe(false);

    setSchedulerRefEnabled("task", "work//tasks/foo", false);
    const resynced = await akmTasksSync({ backend: cron() }, "work");
    expect(resynced.removed).toEqual(["foo"]);
    expect(cronBody(exec.current(), "foo")).toBeUndefined();
  });

  test("enable and disable mutate only host-local config for a task in any configured bundle", async () => {
    const source = taskYaml();
    writeTaskFile(work.dir, "foo", source);
    setSchedulerRefEnabled("task", "work//tasks/foo", false);

    const enabled = await akmTasksEnable("work//tasks/foo", {}, { backend: cron() });
    expect(enabled).toMatchObject({ ref: "work//tasks/foo", enabled: true, changed: true });
    expect(cronBody(exec.current(), "foo")).toContain("--bundle work");
    expect(fs.readFileSync(path.join(work.dir, "tasks", "foo.yml"), "utf8")).toBe(source);
    expect(schedulerActivations(loadConfig())).toContainEqual(
      expect.objectContaining({ kind: "task", ref: "work//tasks/foo", sourceId: expect.stringMatching(/^sha256:/) }),
    );

    const disabled = await akmTasksDisable("work//tasks/foo", {}, { backend: cron() });
    expect(disabled).toMatchObject({ ref: "work//tasks/foo", enabled: false, changed: true });
    expect(cronBody(exec.current(), "foo")).toBeUndefined();
    expect(fs.readFileSync(path.join(work.dir, "tasks", "foo.yml"), "utf8")).toBe(source);
    expect(schedulerActivations(loadConfig())).not.toContainEqual({ kind: "task", ref: "work//tasks/foo" });
  });

  test("a task from a read-only bundle can be enabled without modifying its source", async () => {
    const source = taskYaml();
    writeTaskFile(readonlyDir.dir, "vendor-job", source);
    setSchedulerRefEnabled("task", "readonly//tasks/vendor-job", false);

    const result = await akmTasksEnable("readonly//tasks/vendor-job", {}, { backend: cron() });

    expect(result).toMatchObject({ ref: "readonly//tasks/vendor-job", enabled: true, changed: true });
    expect(cronBody(exec.current(), "vendor-job")).toContain("--bundle readonly");
    expect(fs.readFileSync(path.join(readonlyDir.dir, "tasks", "vendor-job.yml"), "utf8")).toBe(source);
  });

  test("plain sync reconciles enabled tasks from every configured bundle", async () => {
    writeTaskFile(iso.stashDir, "primary", taskYaml());
    writeTaskFile(work.dir, "secondary", taskYaml());

    const result = await akmTasksSync({ backend: cron() });

    expect(result.installed).toEqual(["primary", "secondary"]);
    expect(cronBody(exec.current(), "primary")).toContain("--bundle stash");
    expect(cronBody(exec.current(), "secondary")).toContain("--bundle work");
  });

  test("plain sync removes installed bindings when every configured bundle is disabled", async () => {
    writeTaskFile(work.dir, "secondary", taskYaml());
    await akmTasksSync({ backend: cron() });
    expect(cronBody(exec.current(), "secondary")).toContain("--bundle work");

    const current = loadConfig();
    saveConfig({
      ...current,
      defaultBundle: undefined,
      defaultWriteTarget: undefined,
      bundles: Object.fromEntries(
        Object.entries(current.bundles ?? {}).map(([id, bundle]) => [id, { ...bundle, enabled: false }]),
      ),
    });

    const result = await akmTasksSync({ backend: cron() });

    expect(result.removed).toEqual(["secondary"]);
    expect(cronBody(exec.current(), "secondary")).toBeUndefined();
  });

  test("plain sync removes a disabled bundle while reconciling bundles that remain active", async () => {
    writeSchedulerContextDescriptor(schedulerContextDescriptor(resolveScheduledTaskContext(), ""));
    writeTaskFile(iso.stashDir, "primary", taskYaml());
    writeTaskFile(work.dir, "secondary", taskYaml());
    await akmTasksSync({ backend: cronRealContext() });

    const current = loadConfig();
    saveConfig({
      ...current,
      bundles: {
        ...current.bundles,
        work: { ...current.bundles?.work, path: work.dir, enabled: false },
      },
    });

    const result = await akmTasksSync({ backend: cronRealContext() });

    expect(result.removed).toEqual(["secondary"]);
    expect(result.unchanged).toEqual(["primary"]);
    expect(cronBody(exec.current(), "primary")).toBeDefined();
    expect(cronBody(exec.current(), "secondary")).toBeUndefined();
  });

  test("plain sync rejects cross-bundle native-id collisions before mutation", async () => {
    writeTaskFile(iso.stashDir, "same", taskYaml());
    writeTaskFile(work.dir, "same", taskYaml());

    await expect(akmTasksSync({ backend: cron() })).rejects.toThrow(/claimed by both|rename one task/i);
    expect(exec.current()).toBe("");
  });

  test("activation kind is part of the grant and cannot enable a task through a workflow entry", async () => {
    writeTaskFile(work.dir, "foo", taskYaml());
    setSchedulerRefEnabled("task", "work//tasks/foo", false);
    setSchedulerRefEnabled("workflow", "work//tasks/foo", true);

    const result = await akmTasksSync({ backend: cron() });

    expect(result.installed).toEqual([]);
    expect(result.failures).toContainEqual({
      path: "work//tasks/foo",
      ref: "work//tasks/foo",
      reason: 'Enabled workflow "work//tasks/foo" was not found or has no schedule.',
    });
    expect(exec.current()).toBe("");
  });

  test("add --bundle on a NON-writable bundle fails with a writable-enforcement error", async () => {
    // add --bundle readonly is refused before writing anything.
    await expect(
      akmTasksAdd({ id: "bar", schedule: "@daily", command: "true", target: "readonly" }, { backend: cron() }),
    ).rejects.toThrow(/not writable/i);
  });

  test("an id already scheduled from another bundle is a hard collision error", async () => {
    writeTaskFile(work.dir, "foo", taskYaml());
    await akmTasksSync({ backend: cron() }, "work");

    // Adding the same id to the primary bundle collides with work's entry.
    await expect(akmTasksAdd({ id: "foo", schedule: "@daily", command: "true" }, { backend: cron() })).rejects.toThrow(
      /already scheduled from bundle "work"/,
    );
    // The primary add must not have written a file or clobbered the cron entry.
    expect(fs.existsSync(path.join(iso.stashDir, "tasks", "foo.yml"))).toBe(false);
    expect(cronBody(exec.current(), "foo")).toContain("--bundle work");
  });

  test("plain sync reconciles all bundles; sync --bundle limits reconciliation to that bundle", async () => {
    // #846: the primary ("bar") entry needs to be recognized as this
    // stash's own across the two primary syncs below — use the real,
    // writable context for it (see cronRealContext).
    writeSchedulerContextDescriptor(schedulerContextDescriptor(resolveScheduledTaskContext(), ""));

    // A primary task and a work-bundle task, both scheduled.
    await akmTasksAdd({ id: "bar", schedule: "@daily", command: "true" }, { backend: cronRealContext() });
    writeTaskFile(work.dir, "foo", taskYaml());
    await akmTasksSync({ backend: cron() }, "work");

    // Plain sync reconciles both configured bundles and leaves both current entries unchanged.
    const primarySync = await akmTasksSync({ backend: cronRealContext() });
    expect(primarySync.removed).toEqual([]);
    expect(cronBody(exec.current(), "foo")).toContain("--bundle work");
    expect(cronBody(exec.current(), "bar")).toBeDefined();

    // Deleting the work file then syncing --bundle work removes only foo.
    fs.rmSync(path.join(work.dir, "tasks", "foo.yml"));
    const workSync = await akmTasksSync({ backend: cron() }, "work");
    expect(workSync.removed).toEqual(["foo"]);
    expect(cronBody(exec.current(), "foo")).toBeUndefined();
    // The primary task survives the scoped sync.
    expect(cronBody(exec.current(), "bar")).toBeDefined();
  });

  test("default bundle always carries its canonical owner in the public cron invocation", async () => {
    const result = await akmTasksAdd({ id: "baz", schedule: "@daily", command: "true" }, { backend: cron() });
    expect(result.bundleDir).toBe(iso.stashDir);

    const body = cronBody(exec.current(), "baz");
    expect(body).toBeDefined();
    expect(body).toContain("task run baz --bundle stash --scheduled");

    // New artifacts always persist the resolved primary owner explicitly.
    const task: SchedulerBinding = {
      id: "baz",
      logicalSource: { kind: "task", ref: "stash//tasks/baz" },
      cron: "@daily",
      source: "akm.schedule",
      ordinal: 0,
      enabled: true,
      invocation: ["task", "run", "baz", "--bundle", "stash", "--scheduled"],
    };
    const expectedLine = buildCronLine(
      task,
      ["/usr/local/bin/akm"],
      "/var/log/akm",
      schedulerContextPath(schedulerContextDescriptor(SCHEDULED_CONTEXT, "")),
    );
    expect(body).toBe(expectedLine);

    // Adding with --bundle stash (the DEFAULT bundle by name) is byte-identical.
    fs.rmSync(path.join(iso.stashDir, "tasks", "baz.yml"));
    exec = memoryExec();
    await akmTasksAdd({ id: "baz", schedule: "@daily", command: "true", target: "stash" }, { backend: cron() });
    expect(cronBody(exec.current(), "baz")).toBe(expectedLine);
  });

  test("a scheduled canonical owner resolves an environment-only working stash", async () => {
    fs.rmSync(path.join(iso.configDir, "akm", "config.json"));
    resetConfigCache();

    await akmTasksAdd({ id: "implicit-owner", schedule: "@daily", command: "true" }, { backend: cron() });

    const result = await akmTasksRun("implicit-owner", { target: "stash", scheduled: true });
    expect(result.exitCode).toBe(0);
    expect(result.result.status).toBe("completed");

    await expect(akmTasksRun("implicit-owner", { target: "other" })).rejects.toMatchObject({
      code: "INVALID_FLAG_VALUE",
    });
  });
});
