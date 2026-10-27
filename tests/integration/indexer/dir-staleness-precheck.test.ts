// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #900 pre-drain freshness gate — direct coverage for `getCachedDirState`
 * (see dir-precheck-skip.test.ts for the end-to-end "an unchanged directory is
 * never drained" behavior).
 *
 * Lives under tests/integration/ because it opens a real index database via
 * `openIndexDatabase`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeDirFingerprint, getCachedDirState } from "../../../src/indexer/passes/dir-staleness";
import { openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { upsertIndexDirState } from "../../../src/storage/repositories/index-meta-repository";

const VARIANT = "akm@1";
const createdTmpDirs: string[] = [];

/** A fresh index.db plus one directory holding `a.md` and `b.md`. */
function seed(): { db: ReturnType<typeof openIndexDatabase>; dir: string; files: string[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-dir-staleness-precheck-"));
  createdTmpDirs.push(root);
  const dir = path.join(root, "dir");
  fs.mkdirSync(dir);
  const a = path.join(dir, "a.md");
  const b = path.join(dir, "b.md");
  fs.writeFileSync(a, "content");
  fs.writeFileSync(b, "sibling");
  return { db: openIndexDatabase(path.join(root, "test.db")), dir, files: [a, b] };
}

function persist(db: ReturnType<typeof openIndexDatabase>, dir: string, files: string[], rowCount?: number): void {
  upsertIndexDirState(db, { dirPath: dir, ...computeDirFingerprint(dir, files, VARIANT), reason: "updated", rowCount });
}

function gate(db: ReturnType<typeof openIndexDatabase>, dir: string, files: string[], priorDirsChanged = false) {
  return getCachedDirState(
    db,
    dir,
    files,
    Date.now(),
    priorDirsChanged,
    VARIANT,
    computeDirFingerprint(dir, files, VARIANT),
  );
}

afterAll(() => {
  for (const dir of createdTmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Rewrite `file` with `body` but restore its original atime/mtime, as `touch -r` does. */
function rewritePreservingMtime(file: string, body: string): void {
  const before = fs.statSync(file);
  fs.writeFileSync(file, body);
  fs.utimesSync(file, before.atime, before.mtime);
}

describe("computeDirFingerprint", () => {
  test("is stable when nothing changes", () => {
    const { dir, files } = seed();
    expect(computeDirFingerprint(dir, files, VARIANT).fileSetHash).toBe(
      computeDirFingerprint(dir, files, VARIANT).fileSetHash,
    );
  });

  test("changes when content is rewritten to a DIFFERENT length with mtime preserved", () => {
    const { dir, files } = seed();
    const before = computeDirFingerprint(dir, files, VARIANT).fileSetHash;
    const original = fs.statSync(files[0]!).mtimeMs;
    rewritePreservingMtime(files[0]!, "content that is a good deal longer than the original");
    // utimes restores at millisecond resolution, exactly as `touch -r` does.
    expect(Math.floor(fs.statSync(files[0]!).mtimeMs)).toBe(Math.floor(original));
    expect(computeDirFingerprint(dir, files, VARIANT).fileSetHash).not.toBe(before);
  });

  test("changes when content is rewritten to the SAME length with mtime preserved", () => {
    const { dir, files } = seed();
    const before = computeDirFingerprint(dir, files, VARIANT).fileSetHash;
    const originalSize = fs.statSync(files[0]!).size;
    const originalMtime = fs.statSync(files[0]!).mtimeMs;
    rewritePreservingMtime(files[0]!, "CONTENT"); // same byte length as the seeded "content"
    expect(fs.statSync(files[0]!).size).toBe(originalSize); // size really is unchanged
    expect(Math.floor(fs.statSync(files[0]!).mtimeMs)).toBe(Math.floor(originalMtime));
    // Only ctime witnesses this edit, which is why it is in the digest.
    expect(computeDirFingerprint(dir, files, VARIANT).fileSetHash).not.toBe(before);
  });

  test("changes when a NON-newest file is edited to a timestamp still below the directory max", () => {
    const { dir, files } = seed();
    const older = files[0]!;
    const newer = files[1]!;
    fs.utimesSync(older, new Date("2020-01-01"), new Date("2020-01-01"));
    fs.utimesSync(newer, new Date("2026-01-01"), new Date("2026-01-01"));
    const before = computeDirFingerprint(dir, files, VARIANT);
    fs.writeFileSync(older, "rewritten body");
    fs.utimesSync(older, new Date("2021-06-01"), new Date("2021-06-01"));
    const after = computeDirFingerprint(dir, files, VARIANT);
    // The max is unchanged — it is still the untouched newer sibling's mtime —
    // so a max-based fingerprint could not see this edit at all.
    expect(after.fileMtimeMaxMs).toBe(before.fileMtimeMaxMs);
    expect(after.fileSetHash).not.toBe(before.fileSetHash);
  });

  test("changes when a file becomes unreadable", () => {
    const { dir, files } = seed();
    const before = computeDirFingerprint(dir, files, VARIANT).fileSetHash;
    fs.rmSync(files[0]!);
    expect(computeDirFingerprint(dir, files, VARIANT).fileSetHash).not.toBe(before);
  });
});

describe("getCachedDirState", () => {
  test("no persisted index_dir_state row -> defers (undefined)", () => {
    const { db, dir, files } = seed();
    expect(gate(db, dir, files)).toBeUndefined();
  });

  test("identical walked file set and mtime, rowCount > 0 -> unchanged-precheck", () => {
    const { db, dir, files } = seed();
    persist(db, dir, files, 3);
    expect(gate(db, dir, files)).toEqual({
      stale: false,
      reason: { kind: "unchanged-precheck" },
      persistedRowCount: 3,
    });
  });

  test("walked file set changed (new file) -> defers (undefined)", () => {
    const { db, dir, files } = seed();
    persist(db, dir, files, 3);
    const extra = path.join(dir, "b.md");
    fs.writeFileSync(extra, "more");
    expect(gate(db, dir, [...files, extra])).toBeUndefined();
  });

  test("a zero-row row (rowCount 0) -> takes the entries-aware zero-row path", () => {
    const { db, dir, files } = seed();
    persist(db, dir, files, 0);
    expect(gate(db, dir, files)?.reason.kind).toBe("cached-zero-row-state");
  });

  test("a pre-#900 row (no rowCount) with no entries -> still cached as zero-row", () => {
    const { db, dir, files } = seed();
    persist(db, dir, files);
    expect(gate(db, dir, files)?.reason.kind).toBe("cached-zero-row-state");
  });
});
