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
import { ctx, expectAkmError, fakeCrontab, useSandbox } from "./workspace-behaviour-helpers";

useSandbox();

describe("tasks", () => {
  test("lists the default bundle's tasks, enables one in the scheduler and disables it again", async () => {
    const dir = path.join(ctx.storage.root, "library");
    await setup.apply({ dir });
    expect(tasks.list()).toEqual({ tasks: [] });
    fs.writeFileSync(path.join(dir, "tasks", "nightly.yml"), 'version: 4\nrun: akm index\nschedule: "0 3 * * *"\n');
    expect(tasks.list().tasks).toEqual([
      expect.objectContaining({ id: "nightly", schedule: "0 3 * * *", enabled: false }),
    ]);

    const cron = fakeCrontab();
    try {
      expect(await tasks.enable({ task: "nightly" })).toMatchObject({ enabled: true, changed: true });
      expect(tasks.list().tasks[0]?.enabled).toBe(true);
      expect(fs.readFileSync(cron.file, "utf8")).toContain("nightly");
      expect(await tasks.disable({ task: "nightly" })).toMatchObject({ enabled: false, changed: true });
      expect(tasks.list().tasks[0]?.enabled).toBe(false);
      expect(fs.readFileSync(cron.file, "utf8")).not.toContain("nightly");
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
});
