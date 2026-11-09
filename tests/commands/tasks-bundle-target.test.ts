// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Coverage for bundle-targeted tasks (issue #711): enabling, disabling, adding and
 * running tasks that live in a bundle other than the default one, selected with
 * `--bundle` or a task ref. Enabling only edits `scheduler.enabled`; `akm task
 * dispatch` finds the task by its ref on the next minute (tests/tasks-dispatch.test.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  akmTasksAdd,
  akmTasksDisable,
  akmTasksEnable,
  akmTasksRun,
  resolveTaskReadBundle,
} from "../../src/commands/tasks/tasks";
import { loadConfig, resetConfigCache, saveConfig } from "../../src/core/config/config";
import { schedulerEnabledRefs, setSchedulerRefEnabled } from "../../src/tasks/activation-config";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
} from "../_helpers/sandbox";

let iso: IsolatedAkmStorage;
let work: SandboxedDir;
let readonlyDir: SandboxedDir;
function writeTaskFile(dir: string, id: string, yaml: string): void {
  fs.mkdirSync(path.join(dir, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tasks", `${id}.yml`), yaml, "utf8");
  const bundle = dir === work.dir ? "work" : dir === readonlyDir.dir ? "readonly" : "stash";
  setSchedulerRefEnabled(`${bundle}//tasks/${id}`, true);
}

function taskYaml(): string {
  return ["version: 4", 'run: "true"', "schedule:", '  - cron: "@daily"', ""].join("\n");
}

beforeEach(() => {
  iso = withIsolatedAkmStorage();
  work = makeSandboxDir("akm-bundle-work");
  readonlyDir = makeSandboxDir("akm-bundle-ro");
  saveConfig({
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
  test("enable and disable mutate only host-local config for a task in any configured bundle", () => {
    const source = taskYaml();
    writeTaskFile(work.dir, "foo", source);
    setSchedulerRefEnabled("work//tasks/foo", false);

    const enabled = akmTasksEnable("work//tasks/foo");
    expect(enabled).toMatchObject({ ref: "work//tasks/foo", enabled: true, changed: true });
    expect(fs.readFileSync(path.join(work.dir, "tasks", "foo.yml"), "utf8")).toBe(source);
    expect(schedulerEnabledRefs(loadConfig())).toContain("work//tasks/foo");

    const disabled = akmTasksDisable("work//tasks/foo");
    expect(disabled).toMatchObject({ ref: "work//tasks/foo", enabled: false, changed: true });
    expect(fs.readFileSync(path.join(work.dir, "tasks", "foo.yml"), "utf8")).toBe(source);
    expect(schedulerEnabledRefs(loadConfig())).not.toContain("work//tasks/foo");
  });

  test("a task from a read-only bundle can be enabled without modifying its source", () => {
    const source = taskYaml();
    writeTaskFile(readonlyDir.dir, "vendor-job", source);
    setSchedulerRefEnabled("readonly//tasks/vendor-job", false);

    const result = akmTasksEnable("readonly//tasks/vendor-job");

    expect(result).toMatchObject({ ref: "readonly//tasks/vendor-job", enabled: true, changed: true });
    expect(fs.readFileSync(path.join(readonlyDir.dir, "tasks", "vendor-job.yml"), "utf8")).toBe(source);
  });

  test("add --bundle on a NON-writable bundle fails with a writable-enforcement error", async () => {
    // add --bundle readonly is refused before writing anything.
    await expect(akmTasksAdd({ id: "bar", schedule: "@daily", command: "true", target: "readonly" })).rejects.toThrow(
      /not writable/i,
    );
  });

  test("add writes into the default bundle and enables its ref there", async () => {
    const result = await akmTasksAdd({ id: "baz", schedule: "@daily", command: "true" });
    expect(result.bundleDir).toBe(iso.stashDir);
    expect(schedulerEnabledRefs(loadConfig())).toContain("stash//tasks/baz");

    // --bundle stash (the DEFAULT bundle by name) is the same bundle.
    fs.rmSync(path.join(iso.stashDir, "tasks", "baz.yml"));
    const again = await akmTasksAdd({ id: "baz", schedule: "@daily", command: "true", target: "stash" });
    expect(again.bundleDir).toBe(iso.stashDir);
  });

  test("a scheduled run resolves an environment-only working stash by --bundle stash", async () => {
    fs.rmSync(path.join(iso.configDir, "akm", "config.json"));
    resetConfigCache();

    await akmTasksAdd({ id: "implicit-owner", schedule: "@daily", command: "true" });

    const result = await akmTasksRun("implicit-owner", { target: "stash", scheduled: true });
    expect(result.exitCode).toBe(0);
    expect(result.result.status).toBe("completed");

    await expect(akmTasksRun("implicit-owner", { target: "other" })).rejects.toMatchObject({
      code: "INVALID_FLAG_VALUE",
    });
  });

  test("a read selector resolves the working stash, another bundle and an environment-only stash through the active set", () => {
    expect(resolveTaskReadBundle("stash", undefined).source).toMatchObject({ name: "stash", path: iso.stashDir });
    expect(resolveTaskReadBundle(undefined, "work").source).toMatchObject({ name: "work", path: work.dir });
    expect(resolveTaskReadBundle("readonly", "readonly").source).toMatchObject({
      name: "readonly",
      path: readonlyDir.dir,
    });

    fs.rmSync(path.join(iso.configDir, "akm", "config.json"));
    resetConfigCache();
    expect(resolveTaskReadBundle(undefined, "stash").source).toMatchObject({
      name: "stash",
      path: path.resolve(iso.stashDir),
    });
    expect(() => resolveTaskReadBundle(undefined, "other")).toThrow(/No source named "other"/);
  });

  test("a disabled bundle selector is reported as disabled, not as unconfigured", () => {
    saveConfig({
      semanticSearchMode: "off",
      defaultBundle: "stash",
      bundles: {
        stash: { path: iso.stashDir, writable: true },
        off: { path: readonlyDir.dir, enabled: false },
      },
    });
    resetConfigCache();

    expect(() => resolveTaskReadBundle(undefined, "off")).toThrow('Bundle "off" is disabled.');
    expect(() => resolveTaskReadBundle("off", undefined)).toThrow('Bundle "off" is disabled.');
    expect(() => resolveTaskReadBundle(undefined, "other")).toThrow(/No source named "other"/);
  });
});
