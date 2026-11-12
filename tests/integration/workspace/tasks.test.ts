// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** `tasks.list`, `tasks.enable` and `tasks.disable` of `src/workspace/tasks.ts` against a sandbox and a stand-in `crontab`. */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getConfigPath } from "../../../src/core/paths";
import { setup } from "../../../src/workspace";
import * as tasks from "../../../src/workspace/tasks";
import { ctx, expectAkmError, fakeCrontab, stubHostCli, useSandbox } from "./workspace-behaviour-helpers";

useSandbox();

describe("tasks", () => {
  test("lists the default bundle's tasks, enables one, runs the sync that installs the entry, and disables it again", async () => {
    const dir = path.join(ctx.storage.root, "library");
    await setup.apply({ dir });
    expect(tasks.list()).toEqual({ tasks: [] });
    fs.writeFileSync(path.join(dir, "tasks", "nightly.yml"), 'version: 4\nrun: akm index\nschedule: "0 3 * * *"\n');
    expect(tasks.list().tasks).toEqual([
      expect.objectContaining({ id: "nightly", schedule: "0 3 * * *", enabled: false }),
    ]);

    const cron = fakeCrontab();
    try {
      // The sandbox moves akm's directories, so it is not the default installation: the sync reports that and never
      // writes the OS scheduler (the stand-in crontab stays as it was).
      const before = fs.existsSync(cron.file) ? fs.readFileSync(cron.file, "utf8") : undefined;
      expect(await tasks.enable({ task: "nightly" })).toMatchObject({
        enabled: true,
        changed: true,
        sync: { entry: "unmanaged" },
      });
      expect(tasks.list().tasks[0]?.enabled).toBe(true);
      expect(await tasks.disable({ task: "nightly" })).toMatchObject({
        enabled: false,
        changed: true,
        sync: { entry: "unmanaged" },
      });
      expect(tasks.list().tasks[0]?.enabled).toBe(false);
      expect(fs.existsSync(cron.file) ? fs.readFileSync(cron.file, "utf8") : undefined).toBe(before);
    } finally {
      cron.restore();
    }
  });

  test("an unknown task is not found, and nothing is listed before there is a default bundle", async () => {
    expect(tasks.list()).toEqual({ tasks: [] });
    expect(fs.existsSync(getConfigPath())).toBe(false);
    await expect(tasks.enable({ task: "nightly" })).rejects.toThrow(/default bundle/);
    await setup.apply({ dir: path.join(ctx.storage.root, "library") });
    const cron = fakeCrontab();
    try {
      await expectAkmError(tasks.enable({ task: "nonesuch" }), { kind: "not-found" });
      await expect(tasks.enable({ task: " " })).rejects.toThrow(/name a task/);
    } finally {
      cron.restore();
    }
  });

  test("without a host CLI the change is saved and the unmanaged warning is in the result", async () => {
    const dir = path.join(ctx.storage.root, "library");
    await setup.apply({ dir });
    fs.writeFileSync(path.join(dir, "tasks", "nightly.yml"), 'version: 4\nrun: akm index\nschedule: "0 3 * * *"\n');
    const cron = fakeCrontab();
    try {
      const result = (await tasks.enable({ task: "nightly" })) as { sync: { entry: string; warnings: string[] } };
      expect(result.sync.entry).toBe("unmanaged");
      expect(result.sync.warnings.join(" ")).toContain("akm task dispatch");
    } finally {
      cron.restore();
    }
  });

  test("a runnable host CLI runs the action, in the host environment, and its sync result is returned", async () => {
    const dir = path.join(ctx.storage.root, "library");
    await setup.apply({ dir });
    fs.writeFileSync(path.join(dir, "tasks", "nightly.yml"), 'version: 4\nrun: akm index\nschedule: "0 3 * * *"\n');
    const host = stubHostCli("task-enable", {
      ref: "x//tasks/nightly",
      enabled: true,
      changed: true,
      sync: { entry: "installed" },
    });
    const result = await tasks.enable({ task: "nightly" }, host.cli);
    expect(result).toMatchObject({ enabled: true, sync: { entry: "installed" } });
    expect(host.calls()).toEqual([
      { args: expect.arrayContaining(["task", "enable", "nightly", "--format=json"]), marker: "host-env" },
    ]);
    // The stand-in did the work, so this process wrote nothing.
    expect(tasks.list().tasks[0]?.enabled).toBe(false);
  });

  test("a host CLI that fails or answers in another shape leaves the change saved here, with a warning", async () => {
    const dir = path.join(ctx.storage.root, "library");
    await setup.apply({ dir });
    fs.writeFileSync(path.join(dir, "tasks", "nightly.yml"), 'version: 4\nrun: akm index\nschedule: "0 3 * * *"\n');
    const host = stubHostCli("not-a-task-enable", {});
    const cron = fakeCrontab();
    try {
      const result = (await tasks.enable({ task: "nightly" }, host.cli)) as {
        warnings: string[];
        sync: { entry: string };
      };
      expect(tasks.list().tasks[0]?.enabled).toBe(true);
      expect(result.sync.entry).toBe("unmanaged");
      expect(result.warnings.join(" ")).toContain("akm doctor scheduler sync");
    } finally {
      cron.restore();
    }
  });
});
