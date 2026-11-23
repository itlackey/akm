// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** `akm backups prune` removes old entries under `<dataDir>/backups/`, never the newest of a folder. */

import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pruneBackups } from "../../../src/commands/backups-cli";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-16T12:00:00Z");

/** A backups tree: `layout` maps `folder/entry` to its age in days and its file size. */
function dataDirWith(layout: Record<string, [days: number, bytes: number]>): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-backups-"));
  dirs.push(dataDir);
  for (const [entry, [days, bytes]] of Object.entries(layout)) {
    const dir = path.join(dataDir, "backups", entry);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "file"), Buffer.alloc(bytes));
    const when = new Date(NOW - days * DAY);
    fs.utimesSync(dir, when, when);
  }
  return dataDir;
}

test("removes entries older than the cutoff and keeps the newest of each folder", () => {
  const dataDir = dataDirWith({
    "tasks/a": [90, 100],
    "tasks/b": [60, 200],
    "tasks/c": [2, 400],
    "asset-engine-keys/only": [300, 50],
    "asset-content-refs/x": [45, 10],
    "asset-content-refs/y": [10, 20],
  });
  const result = pruneBackups({ dataDir, now: NOW });
  expect(result).toMatchObject({ dryRun: false, olderThan: "30d", count: 3, bytes: 310 });
  expect(result.folders).toEqual([
    { folder: "asset-content-refs", count: 1, bytes: 10, kept: 1 },
    { folder: "tasks", count: 2, bytes: 300, kept: 1 },
  ]);
  expect(fs.readdirSync(path.join(dataDir, "backups", "tasks"))).toEqual(["c"]);
  expect(fs.readdirSync(path.join(dataDir, "backups", "asset-engine-keys"))).toEqual(["only"]);
  expect(fs.readdirSync(path.join(dataDir, "backups", "asset-content-refs"))).toEqual(["y"]);
});

test("a dry run reports the same result and removes nothing", () => {
  const dataDir = dataDirWith({ "tasks/a": [90, 100], "tasks/b": [1, 5] });
  const result = pruneBackups({ dataDir, olderThan: "7d", dryRun: true, now: NOW });
  expect(result).toMatchObject({ dryRun: true, olderThan: "7d", count: 1, bytes: 100 });
  expect(fs.readdirSync(path.join(dataDir, "backups", "tasks")).sort()).toEqual(["a", "b"]);
});

test("a missing backups directory is nothing to prune, and a bad duration is refused", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-backups-"));
  dirs.push(dataDir);
  expect(pruneBackups({ dataDir, now: NOW })).toMatchObject({ count: 0, bytes: 0, folders: [] });
  expect(() => pruneBackups({ dataDir, olderThan: "soon" })).toThrow(/Invalid --older-than/);
});
