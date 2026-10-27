// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm migrate apply`'s one task-file step: every task file under a bundle's
 * task directory, whatever version it declares, is rewritten as task source
 * v4 under one backup directory per run; `status` never writes.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyTaskFilesPlan,
  inspectTaskFiles,
  planTaskFilesMigration,
  taskFileBackupPath,
} from "../../scripts/akm-migrate/migrate/task-files";
import { applyTaskFilesMigration, inspectTaskFilesMigration } from "../../scripts/akm-migrate/task-migrate";
import { resetConfigCache } from "../../src/core/config/config";
import { getDataDir } from "../../src/core/paths";
import { parseTaskSourceV4 } from "../../src/tasks/source/task-source-v4";
import { withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

const V2 = "version: 2\nschedule: '@daily'\ncommand: /bin/echo ok\n";
const V3 = "version: 3\nuses: commands/publish-report\nakm:\n  schedule: '@daily'\n";
const V4 = "version: 4\nuses: commands/publish-report\nschedule: '@daily'\n";
const V4_RETIRED_ENABLED =
  "version: 4\nuses: commands/publish-report\nschedule:\n  - cron: '@daily'\n    enabled: true\n";
const V3_NEEDS_A_DECISION = "version: 3\nuses: evilcorp/tool@v1\nakm:\n  schedule: '@daily'\n";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function bundle(files: Record<string, string>): { root: string; backup: string; file: (name: string) => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-files-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "tasks"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(root, "tasks", name);
    fs.writeFileSync(file, body);
    // The mode a test asserts is set outright: a file's creation mode is masked by the umask of whoever runs the test.
    fs.chmodSync(file, 0o640);
  }
  return { root, backup: path.join(root, "backup"), file: (name) => path.join(root, "tasks", name) };
}

function plan(root: string) {
  return planTaskFilesMigration(
    inspectTaskFiles([{ bundleId: "fixture", root, bundleRoot: root, writable: true, layout: "akm-stash" }]),
  );
}

function outcomes(root: string): Record<string, [string, string]> {
  return Object.fromEntries(plan(root).files.map((file) => [path.basename(file.filePath), [file.status, file.reason]]));
}

describe("task files: the mode a file had", () => {
  /** Run `fn` with the process umask set to `mask`, restoring it after. */
  function withUmask<T>(mask: number, fn: () => T): T {
    const previous = process.umask(mask);
    try {
      return fn();
    } finally {
      process.umask(previous);
    }
  }

  test("is kept by the rewrite, whatever the umask of the process that migrates it", () => {
    const b = bundle({ "a.yml": V2, "b.yml": V3 });
    fs.chmodSync(b.file("b.yml"), 0o664);
    const preview = plan(b.root);

    withUmask(0o077, () => applyTaskFilesPlan(preview, { backupRoot: b.backup }));

    expect(fs.statSync(b.file("a.yml")).mode & 0o777).toBe(0o640);
    expect(fs.statSync(b.file("b.yml")).mode & 0o777).toBe(0o664);
  });

  test("is the one a file had when it was created under a restrictive umask: the rewrite does not widen or change it", () => {
    const b = withUmask(0o077, () => {
      const made = bundle({});
      fs.writeFileSync(path.join(made.root, "tasks", "private.yml"), V2);
      return made;
    });
    const before = fs.statSync(b.file("private.yml")).mode & 0o777;
    expect(before).toBe(0o600);

    applyTaskFilesPlan(plan(b.root), { backupRoot: b.backup });

    expect(
      parseTaskSourceV4({ yaml: fs.readFileSync(b.file("private.yml"), "utf8"), filePath: b.file("private.yml") })
        .version,
    ).toBe(4);
    expect(fs.statSync(b.file("private.yml")).mode & 0o777).toBe(before);
  });
});

describe("task files: every version through one planner", () => {
  test("v2, v3 and v4-with-retired-enabled files all become v4 under one backup; a plain v4 file is untouched", () => {
    const b = bundle({ "two.yml": V2, "three.yml": V3, "enabled.yml": V4_RETIRED_ENABLED, "four.yml": V4 });

    const preview = plan(b.root);
    expect(outcomes(b.root)).toEqual({
      "two.yml": ["changed", "task-converted"],
      "three.yml": ["changed", "task-converted"],
      "enabled.yml": ["changed", "source-enablement-removed"],
      "four.yml": ["skipped", "already-v4"],
    });
    expect(fs.readFileSync(b.file("two.yml"), "utf8")).toBe(V2);

    const applied = applyTaskFilesPlan(preview, { backupRoot: b.backup });

    expect(applied.changed.map((file) => path.basename(file)).sort()).toEqual(["enabled.yml", "three.yml", "two.yml"]);
    for (const name of ["two.yml", "three.yml", "enabled.yml", "four.yml"]) {
      const yaml = fs.readFileSync(b.file(name), "utf8");
      expect(parseTaskSourceV4({ yaml, filePath: b.file(name) }).version).toBe(4);
      expect(yaml).not.toContain("enabled:");
      expect(fs.statSync(b.file(name)).mode & 0o777).toBe(0o640);
    }
    expect(fs.readFileSync(b.file("four.yml"), "utf8")).toBe(V4);
    expect(fs.readFileSync(taskFileBackupPath(b.backup, b.file("two.yml")), "utf8")).toBe(V2);
    expect(fs.readFileSync(taskFileBackupPath(b.backup, b.file("three.yml")), "utf8")).toBe(V3);
    expect(fs.readFileSync(taskFileBackupPath(b.backup, b.file("enabled.yml")), "utf8")).toBe(V4_RETIRED_ENABLED);
    expect(fs.existsSync(taskFileBackupPath(b.backup, b.file("four.yml")))).toBe(false);
    expect(Object.values(outcomes(b.root)).map(([status]) => status)).toEqual([
      "skipped",
      "skipped",
      "skipped",
      "skipped",
    ]);
  });

  test("a file that needs a human decision is reported blocked and left alone while the rest migrate", () => {
    const b = bundle({ "good.yml": V2, "decide.yml": V3_NEEDS_A_DECISION, "five.yml": "version: 5\nrun: echo x\n" });

    const preview = plan(b.root);
    expect(outcomes(b.root)).toEqual({
      "good.yml": ["changed", "task-converted"],
      "decide.yml": ["blocked", "github-action-target-removed"],
      "five.yml": ["blocked", "unsupported-task-version"],
    });

    const applied = applyTaskFilesPlan(preview, { backupRoot: b.backup });

    expect(applied.changed).toEqual([b.file("good.yml")]);
    expect(fs.readFileSync(b.file("good.yml"), "utf8")).toContain("version: 4");
    expect(fs.readFileSync(b.file("decide.yml"), "utf8")).toBe(V3_NEEDS_A_DECISION);
    expect(fs.readFileSync(b.file("five.yml"), "utf8")).toBe("version: 5\nrun: echo x\n");
  });

  test("every original is backed up before any file is replaced", () => {
    const b = bundle({ "two.yml": V2 });
    const preview = plan(b.root);
    // A plain file where the backup root must be a directory: backing up fails
    // before the first replace, so the task file is untouched.
    fs.writeFileSync(b.backup, "not a directory");

    expect(() => applyTaskFilesPlan(preview, { backupRoot: b.backup })).toThrow();
    expect(fs.readFileSync(b.file("two.yml"), "utf8")).toBe(V2);
  });

  test("a later file's failed replace restores the files already replaced", () => {
    // Root bypasses permission checks, so the failure is a per-segment
    // NAME_MAX overflow instead: the second file's own name fits, its backup
    // name (+17 bytes) fits, but the temporary name the atomic replace needs
    // (+46 bytes) does not, so only its replace fails, after the first
    // file's succeeded. Windows has a different path-length ceiling; skip.
    if (process.platform === "win32") return;
    const longName = `${"z".repeat(216)}.yml`;
    const b = bundle({ "a.yml": V2, [longName]: V3 });

    expect(() => applyTaskFilesPlan(plan(b.root), { backupRoot: b.backup })).toThrow();

    expect(fs.readFileSync(b.file("a.yml"), "utf8")).toBe(V2);
    expect(fs.statSync(b.file("a.yml")).mode & 0o777).toBe(0o640);
    expect(fs.readFileSync(b.file(longName), "utf8")).toBe(V3);
    expect(fs.readFileSync(taskFileBackupPath(b.backup, b.file("a.yml")), "utf8")).toBe(V2);
    expect(fs.readFileSync(taskFileBackupPath(b.backup, b.file(longName)), "utf8")).toBe(V3);
  });

  test("a file edited after it was planned is left as the user wrote it, in neither the backup nor a replacement", () => {
    const b = bundle({ "edited.yml": V2, "fine.yml": V3 });
    const preview = plan(b.root);
    const edited = "version: 2\nschedule: '@hourly'\ncommand: /bin/echo user concurrent edit\n";
    fs.writeFileSync(b.file("edited.yml"), edited);

    const applied = applyTaskFilesPlan(preview, { backupRoot: b.backup });

    expect(applied.conflicts).toEqual([b.file("edited.yml")]);
    expect(applied.changed).toEqual([b.file("fine.yml")]);
    expect(fs.readFileSync(b.file("edited.yml"), "utf8")).toBe(edited);
    expect(fs.existsSync(taskFileBackupPath(b.backup, b.file("edited.yml")))).toBe(false);
    expect(fs.readFileSync(b.file("fine.yml"), "utf8")).toContain("version: 4");
    // The backup of what was replaced is what was replaced.
    expect(fs.readFileSync(taskFileBackupPath(b.backup, b.file("fine.yml")), "utf8")).toBe(V3);
    // A run again plans the edited file afresh from what it now holds.
    expect(outcomes(b.root)["edited.yml"]?.[0]).toBe("changed");
  });

  test("a file edited between its backup and its replacement is checked again and left alone", () => {
    const b = bundle({ "late.yml": V2 });
    const preview = plan(b.root);
    const edited = "version: 2\nschedule: '@hourly'\ncommand: /bin/echo edited late\n";
    // The first read of the file is the check before its backup; the user writes right after it.
    const read = fs.readFileSync.bind(fs);
    let reads = 0;
    spyOn(fs, "readFileSync").mockImplementation(((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      const bytes = (read as (...args: unknown[]) => unknown)(target, ...rest);
      if (target === b.file("late.yml")) {
        reads += 1;
        if (reads === 1) fs.writeFileSync(b.file("late.yml"), edited);
      }
      return bytes;
    }) as typeof fs.readFileSync);

    const applied = applyTaskFilesPlan(preview, { backupRoot: b.backup });
    mock.restore();

    expect(applied).toEqual({ changed: [], conflicts: [b.file("late.yml")] });
    expect(fs.readFileSync(b.file("late.yml"), "utf8")).toBe(edited);
    expect(fs.existsSync(taskFileBackupPath(b.backup, b.file("late.yml")))).toBe(false);
  });

  test("a rollback does not overwrite a file that changed after it was replaced, and says which", () => {
    const b = bundle({ "a.yml": V2, "b.yml": V3 });
    const preview = plan(b.root);
    // The second file's replace fails; the user edited the first file's new version just before.
    const edited = "version: 4\nschedule: '@weekly'\nuses: commands/user-edit\n";
    const rename = fs.renameSync.bind(fs);
    spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) !== b.file("b.yml")) return rename(from, to);
      fs.writeFileSync(b.file("a.yml"), edited);
      throw new Error("disk full");
    }) as typeof fs.renameSync);

    let failure: unknown;
    try {
      applyTaskFilesPlan(preview, { backupRoot: b.backup });
    } catch (error) {
      failure = error;
    }
    mock.restore();

    const message = String((failure as Error).message);
    expect(message).toContain("disk full");
    expect(message).toContain(
      `not restored from the backup, because it changed after it was replaced: ${b.file("a.yml")}`,
    );
    expect(fs.readFileSync(b.file("a.yml"), "utf8")).toBe(edited);
    expect(fs.readFileSync(b.file("b.yml"), "utf8")).toBe(V3);
  });

  test("symlinked task sources are refused", () => {
    const b = bundle({ "two.yml": V2 });
    fs.symlinkSync(b.file("two.yml"), b.file("linked.yml"));
    expect(() => plan(b.root)).toThrow(/does not follow symbolic link/);
  });

  test("an akm-task layout inspects its top-level yml files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-files-flat-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "flat.yml"), V4);
    const inputs = inspectTaskFiles([{ bundleId: "flat", root, bundleRoot: root, writable: true, layout: "akm-task" }]);
    expect(inputs.map((input) => path.basename(input.filePath))).toEqual(["flat.yml"]);
  });
});

describe("the migrator step over configured bundles", () => {
  test("status is read-only; apply rewrites every bundle's files under one backup dir and is then a no-op", () => {
    const storage = withIsolatedAkmStorage();
    resetConfigCache();
    try {
      const tasksDir = path.join(storage.stashDir, "tasks");
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(path.join(tasksDir, "two.yml"), V2, { mode: 0o640 });
      fs.writeFileSync(path.join(tasksDir, "three.yml"), V3, { mode: 0o640 });
      writeSandboxConfig({
        defaultBundle: "primary",
        bundles: {
          primary: { path: storage.stashDir, writable: true, components: { main: { root: ".", adapter: "akm" } } },
        },
      });

      const status = inspectTaskFilesMigration();
      expect(status).toMatchObject({
        status: "ready",
        blockers: [],
        taskFiles: { changed: 2, skipped: 0, blocked: 0 },
      });
      expect(status.backupPath).toBeUndefined();
      expect(fs.readFileSync(path.join(tasksDir, "two.yml"), "utf8")).toBe(V2);

      const applied = applyTaskFilesMigration();
      expect(applied).toMatchObject({
        status: "current",
        applied: 2,
        taskFiles: { changed: 0, skipped: 2, blocked: 0 },
      });
      const backupsRoot = path.join(getDataDir(), "backups", "tasks");
      expect(path.dirname(applied.backupPath as string)).toBe(backupsRoot);
      expect(fs.readdirSync(backupsRoot)).toHaveLength(1);
      for (const name of ["two.yml", "three.yml"]) {
        const file = path.join(tasksDir, name);
        expect(parseTaskSourceV4({ yaml: fs.readFileSync(file, "utf8"), filePath: file }).version).toBe(4);
        expect(fs.existsSync(taskFileBackupPath(applied.backupPath as string, file))).toBe(true);
      }

      const again = applyTaskFilesMigration();
      expect(again).toMatchObject({ status: "current", taskFiles: { changed: 0, skipped: 2 } });
      expect(again.backupPath).toBeUndefined();
      expect(again.applied).toBeUndefined();
      expect(fs.readdirSync(backupsRoot)).toHaveLength(1);
    } finally {
      resetConfigCache();
      storage.cleanup();
    }
  });

  // The runtime reads only v4 (#987) and tells the user to run the migrator,
  // so the migrator must reach every stash the runtime reads tasks from.
  test("the env-selected working stash (AKM_BUNDLE_DIR, named by no config) is migrated too", () => {
    const storage = withIsolatedAkmStorage();
    resetConfigCache();
    try {
      const tasksDir = path.join(storage.stashDir, "tasks");
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(path.join(tasksDir, "three.yml"), V3, { mode: 0o640 });
      writeSandboxConfig({});

      expect(inspectTaskFilesMigration()).toMatchObject({ status: "ready", taskFiles: { changed: 1, blocked: 0 } });
      expect(applyTaskFilesMigration()).toMatchObject({ status: "current", applied: 1 });
      const file = path.join(tasksDir, "three.yml");
      expect(parseTaskSourceV4({ yaml: fs.readFileSync(file, "utf8"), filePath: file }).version).toBe(4);
    } finally {
      resetConfigCache();
      storage.cleanup();
    }
  });

  test("a configured flat bundle with no recorded adapter whose top-level task files are all v2/v3 is migrated", () => {
    const storage = withIsolatedAkmStorage();
    resetConfigCache();
    const flat = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-files-flat-bundle-"));
    roots.push(flat);
    try {
      fs.writeFileSync(path.join(flat, "weekly.yml"), V3, { mode: 0o640 });
      writeSandboxConfig({ bundles: { flat: { path: flat, writable: true } } });

      expect(inspectTaskFilesMigration()).toMatchObject({ status: "ready", taskFiles: { changed: 1, blocked: 0 } });
    } finally {
      resetConfigCache();
      storage.cleanup();
    }
  });
});
