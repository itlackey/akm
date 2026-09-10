// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "bun:test";
/**
 * #951 — task log rotation: per-run flat log files (`<logDir>/<taskId>/<ts>.log`)
 * accumulate forever with no cleanup. Locks for `purgeOldTaskLogFiles`:
 *   - deletes only files older than the retention window
 *   - `retentionDays <= 0` (or non-finite) disables the purge entirely
 *   - never touches anything outside the given log directory
 *   - a missing log directory is a no-op, not a thrown error
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { purgeOldTaskLogFiles } from "../../src/tasks/run/task-log";

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeLogDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-log-purge-"));
  cleanupDirs.push(dir);
  return dir;
}

function writeLogFile(logDir: string, taskId: string, fileName: string, ageMs: number): string {
  const taskDir = path.join(logDir, taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const filePath = path.join(taskDir, fileName);
  fs.writeFileSync(filePath, "log content");
  const mtime = new Date(Date.now() - ageMs);
  fs.utimesSync(filePath, mtime, mtime);
  return filePath;
}

const ONE_DAY_MS = 86_400_000;

describe("purgeOldTaskLogFiles", () => {
  test("deletes only files older than retentionDays", () => {
    const logDir = makeLogDir();
    const oldFile = writeLogFile(logDir, "daily-improve", "2026-01-01T00-00-00-000Z.log", 200 * ONE_DAY_MS);
    const newFile = writeLogFile(logDir, "daily-improve", "2026-09-01T00-00-00-000Z.log", 1 * ONE_DAY_MS);

    const deleted = purgeOldTaskLogFiles(logDir, 90);

    expect(deleted).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(newFile)).toBe(true);
  });

  test("retentionDays <= 0 disables the purge entirely", () => {
    const logDir = makeLogDir();
    const oldFile = writeLogFile(logDir, "daily-improve", "old.log", 400 * ONE_DAY_MS);

    expect(purgeOldTaskLogFiles(logDir, 0)).toBe(0);
    expect(purgeOldTaskLogFiles(logDir, -5)).toBe(0);
    expect(purgeOldTaskLogFiles(logDir, Number.NaN)).toBe(0);
    expect(fs.existsSync(oldFile)).toBe(true);
  });

  test("only deletes inside the given log directory, across multiple task subdirectories", () => {
    const logDir = makeLogDir();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-log-purge-outside-"));
    cleanupDirs.push(outsideDir);
    const outsideFile = path.join(outsideDir, "unrelated.log");
    fs.writeFileSync(outsideFile, "not akm's");
    const oldMtime = new Date(Date.now() - 400 * ONE_DAY_MS);
    fs.utimesSync(outsideFile, oldMtime, oldMtime);

    const oldA = writeLogFile(logDir, "task-a", "old.log", 200 * ONE_DAY_MS);
    const oldB = writeLogFile(logDir, "task-b", "old.log", 200 * ONE_DAY_MS);

    const deleted = purgeOldTaskLogFiles(logDir, 90);

    expect(deleted).toBe(2);
    expect(fs.existsSync(oldA)).toBe(false);
    expect(fs.existsSync(oldB)).toBe(false);
    // Outside the passed logDir entirely — never touched.
    expect(fs.existsSync(outsideFile)).toBe(true);
  });

  test("a missing log directory is a no-op, not a thrown error", () => {
    const missingDir = path.join(os.tmpdir(), `akm-task-log-purge-missing-${Date.now()}`);
    expect(() => purgeOldTaskLogFiles(missingDir, 90)).not.toThrow();
    expect(purgeOldTaskLogFiles(missingDir, 90)).toBe(0);
  });
});
