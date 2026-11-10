// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `replaceFilesWithBackups`, the one file-rewriting primitive of the migrator's
 * asset steps: originals are backed up first, a file edited since it was
 * planned is a conflict and is left alone, and a failed replace restores what
 * was already replaced.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type FileReplacement,
  replaceFilesWithBackups,
  taskFileBackupPath,
} from "../../scripts/akm-migrate/migrate/task-files";

const roots: string[] = [];

afterEach(() => {
  mock.restore();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function files(contents: Record<string, string>): { dir: string; backup: string; changes: FileReplacement[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-replace-files-"));
  roots.push(dir);
  const changes = Object.entries(contents).map(([name, before]) => {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, before);
    fs.chmodSync(filePath, 0o640);
    return { filePath, before: Buffer.from(before), after: Buffer.from(`${before}+new`), mode: 0o640 };
  });
  return { dir, backup: path.join(dir, "backup"), changes };
}

describe("replaceFilesWithBackups", () => {
  test("backs every original up, replaces it, and keeps its mode", () => {
    const f = files({ "a.yml": "a", "b.yml": "b" });
    const result = replaceFilesWithBackups(f.changes, f.backup);
    expect(result.conflicts).toEqual([]);
    expect(result.replaced).toEqual(f.changes.map((c) => c.filePath));
    for (const change of f.changes) {
      expect(fs.readFileSync(change.filePath, "utf8")).toBe(change.after.toString());
      expect(fs.statSync(change.filePath).mode & 0o777).toBe(0o640);
      expect(fs.readFileSync(taskFileBackupPath(f.backup, change.filePath), "utf8")).toBe(change.before.toString());
    }
  });

  test("a backup that cannot be written leaves every file untouched", () => {
    const f = files({ "a.yml": "a" });
    fs.writeFileSync(f.backup, "not a directory");
    expect(() => replaceFilesWithBackups(f.changes, f.backup)).toThrow();
    expect(fs.readFileSync(f.changes[0]!.filePath, "utf8")).toBe("a");
  });

  test("a file edited after it was planned is a conflict: neither backed up nor replaced", () => {
    const f = files({ "edited.yml": "one", "fine.yml": "two" });
    const [edited, fine] = f.changes as [FileReplacement, FileReplacement];
    fs.writeFileSync(edited.filePath, "user edit");
    const result = replaceFilesWithBackups(f.changes, f.backup);
    expect(result.conflicts).toEqual([edited.filePath]);
    expect(result.replaced).toEqual([fine.filePath]);
    expect(fs.readFileSync(edited.filePath, "utf8")).toBe("user edit");
    expect(fs.existsSync(taskFileBackupPath(f.backup, edited.filePath))).toBe(false);
  });

  test("a failed replace restores the files already replaced, and names one that changed since", () => {
    const f = files({ "a.yml": "a", "b.yml": "b" });
    const [a, b] = f.changes as [FileReplacement, FileReplacement];
    const rename = fs.renameSync.bind(fs);
    spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) !== b.filePath) return rename(from, to);
      throw new Error("disk full");
    }) as typeof fs.renameSync);
    expect(() => replaceFilesWithBackups(f.changes, f.backup)).toThrow("disk full");
    mock.restore();
    expect(fs.readFileSync(a.filePath, "utf8")).toBe("a");
    expect(fs.readFileSync(b.filePath, "utf8")).toBe("b");

    const g = files({ "a.yml": "a", "b.yml": "b" });
    const [ga, gb] = g.changes as [FileReplacement, FileReplacement];
    spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) !== gb.filePath) return rename(from, to);
      fs.writeFileSync(ga.filePath, "user edit");
      throw new Error("disk full");
    }) as typeof fs.renameSync);
    expect(() => replaceFilesWithBackups(g.changes, g.backup)).toThrow(
      `not restored from the backup, because it changed after it was replaced: ${ga.filePath}`,
    );
    expect(fs.readFileSync(ga.filePath, "utf8")).toBe("user edit");
  });
});
