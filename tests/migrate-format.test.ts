// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache, saveConfig } from "../src/core/config/config";
import { isFormatExemptCommand } from "../src/output/format-exempt";
import { parseTaskSourceV4 } from "../src/tasks/source/task-source-v4";
import { runCliCapture } from "./_helpers/cli";
import { withIsolatedAkmStorage } from "./_helpers/sandbox";

function configureTaskBundle(stashDir: string): void {
  saveConfig({
    semanticSearchMode: "off",
    defaultBundle: "local",
    bundles: {
      local: {
        path: stashDir,
        writable: true,
        components: { main: { root: ".", adapter: "akm", writable: true } },
      },
    },
  });
  resetConfigCache();
}

function writeV2Task(stashDir: string): string {
  const taskPath = path.join(stashDir, "tasks", "legacy.yml");
  fs.mkdirSync(path.dirname(taskPath), { recursive: true });
  fs.writeFileSync(taskPath, 'version: 2\nschedule: "@daily"\nprompt: Say hello\n', "utf8");
  return taskPath;
}

test("migrate status/apply use the normal format pipeline", () => {
  expect(isFormatExemptCommand(["migrate", "status"])).toBe(false);
  expect(isFormatExemptCommand(["migrate", "apply"])).toBe(false);
});

test("status and apply --dry-run report the same combined plan without mutation", async () => {
  const storage = withIsolatedAkmStorage();
  try {
    configureTaskBundle(storage.stashDir);
    const taskPath = writeV2Task(storage.stashDir);
    const before = fs.readFileSync(taskPath);

    const status = await runCliCapture(["migrate", "status"]);
    const dryRun = await runCliCapture(["migrate", "apply", "--dry-run"]);
    expect(status.code, status.stderr).toBe(0);
    expect(dryRun.code, dryRun.stderr).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toEqual(JSON.parse(status.stdout));
    expect(JSON.parse(status.stdout)).toMatchObject({
      schemaVersion: 1,
      status: "ready",
      blockers: [],
      // One step, one planner: the v2 file goes straight to "ready to
      // convert" — there is no intermediate v3 generation to be pending on.
      taskFiles: { changed: 1, skipped: 0, blocked: 0 },
    });
    expect(fs.readFileSync(taskPath)).toEqual(before);
  } finally {
    storage.cleanup();
  }
});

test("apply rewrites the v2 file straight to task source v4 under one backup", async () => {
  const storage = withIsolatedAkmStorage();
  try {
    configureTaskBundle(storage.stashDir);
    const taskPath = writeV2Task(storage.stashDir);

    const applied = await runCliCapture(["migrate", "apply"]);
    expect(applied.code, applied.stderr).toBe(0);
    const result = JSON.parse(applied.stdout) as {
      status: string;
      applied: number;
      backupPath: string;
      taskFiles: { changed: number; skipped: number; blocked: number };
    };
    expect(result).toMatchObject({
      status: "current",
      applied: 1,
      taskFiles: { changed: 0, skipped: 1, blocked: 0 },
    });
    expect(fs.existsSync(result.backupPath)).toBe(true);
    // The file lands on task source v4 in one pass — the planner chains
    // v2->v3->v4 internally before anything touches disk.
    expect(parseTaskSourceV4({ yaml: fs.readFileSync(taskPath, "utf8"), filePath: taskPath }).version).toBe(4);
  } finally {
    storage.cleanup();
  }
});

test("text output summarizes the task-file migration step", async () => {
  const storage = withIsolatedAkmStorage();
  try {
    configureTaskBundle(storage.stashDir);
    writeV2Task(storage.stashDir);
    const result = await runCliCapture(["migrate", "status", "--format", "text"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("ready");
    expect(result.stdout).toContain("task files: 1 change, 0 current, 0 blocked");
    expect(result.stdout).not.toContain("config.json");
    expect(result.stdout).not.toContain("state.db");
  } finally {
    storage.cleanup();
  }
});
