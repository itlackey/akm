// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Coverage-hardening: the incremental dir-staleness engine
 * (src/indexer/passes/dir-staleness.ts) had ZERO direct tests. It decides
 * whether an incremental `akm index` may SKIP a directory — a wrong "fresh"
 * verdict silently serves stale rows after a rename/delete/edit.
 *
 * The briefing calls out this exact class: every DirStaleReason branch must be
 * proven, and a rename/delete must be DETECTED (not skipped). These tests
 * drive real files with controlled mtimes + a real (temp-file) index DB, and
 * assert the concrete `reason.kind` for each branch — happy AND structural.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDatabase, openIndexDatabase, upsertEntry, upsertIndexDirState } from "../../src/indexer/db/db";
import {
  canUseIncrementalSkip,
  computeDirFingerprint,
  getCachedZeroRowDirState,
  getDirIndexState,
  inferZeroRowReason,
} from "../../src/indexer/passes/dir-staleness";
import type { StashEntry, StashFile } from "../../src/indexer/passes/metadata";
import type { Database } from "../../src/storage/database";
import { type Cleanup, sandboxXdgCacheHome, sandboxXdgConfigHome } from "../_helpers/sandbox";

// ── Generic (non-AKM) temp dir management ───────────────────────────────────

const createdTmpDirs: string[] = [];
function tmpDir(label = "dir-staleness"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `akm-${label}-`));
  createdTmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of createdTmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ── Env isolation (mirrors db-scoring.test.ts) ──────────────────────────────

let envCleanup: Cleanup = () => {};
beforeEach(() => {
  const cache = sandboxXdgCacheHome();
  const cfg = sandboxXdgConfigHome(cache.cleanup);
  envCleanup = cfg.cleanup;
});
afterEach(() => {
  envCleanup();
  envCleanup = () => {};
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Write a file and force its mtime to a fixed epoch-ms value. */
function writeFileAtMtime(filePath: string, contents: string, mtimeMs: number): void {
  fs.writeFileSync(filePath, contents);
  const seconds = mtimeMs / 1000;
  fs.utimesSync(filePath, seconds, seconds);
}

function seedEntry(db: Database, dirPath: string, filePath: string): void {
  const name = path.basename(filePath).replace(/\.md$/, "");
  const entry: StashEntry = { name, type: "knowledge", description: `desc ${name}` };
  upsertEntry(db, `knowledge:${name}`, dirPath, filePath, dirPath, entry, name);
}

function openDb(): Database {
  return openIndexDatabase(path.join(tmpDir("stale-db"), "index.db"));
}

// ═══════════════════════════════════════════════════════════════════════════
// computeDirFingerprint — dedup + sort + max-mtime + missing-file → Infinity
// ═══════════════════════════════════════════════════════════════════════════

describe("computeDirFingerprint", () => {
  test("dedups by basename and sorts, joining with NUL", () => {
    const dir = tmpDir();
    const a = path.join(dir, "a.md");
    const b = path.join(dir, "b.md");
    writeFileAtMtime(a, "a", 1000);
    writeFileAtMtime(b, "b", 2000);
    // Duplicate basename (different absolute path) must collapse to one entry.
    const fp = computeDirFingerprint(dir, [b, a, a]);
    expect(fp.fileSetHash).toBe(["a.md", "b.md"].join("\0"));
  });

  test("fileMtimeMaxMs is the max mtime across the files", () => {
    const dir = tmpDir();
    const a = path.join(dir, "a.md");
    const b = path.join(dir, "b.md");
    writeFileAtMtime(a, "a", 5000);
    writeFileAtMtime(b, "b", 9000);
    const fp = computeDirFingerprint(dir, [a, b]);
    expect(fp.fileMtimeMaxMs).toBe(9000);
  });

  test("a missing file poisons the mtime to +Infinity (forces rescan)", () => {
    const dir = tmpDir();
    const present = path.join(dir, "present.md");
    writeFileAtMtime(present, "x", 3000);
    const fp = computeDirFingerprint(dir, [present, path.join(dir, "gone.md")]);
    expect(fp.fileMtimeMaxMs).toBe(Number.POSITIVE_INFINITY);
  });

  test("empty file list yields empty hash and zero mtime", () => {
    const fp = computeDirFingerprint(tmpDir(), []);
    expect(fp.fileSetHash).toBe("");
    expect(fp.fileMtimeMaxMs).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getDirIndexState — every DirStaleReason branch, prev-rows path
// ═══════════════════════════════════════════════════════════════════════════

describe("getDirIndexState — with previously-indexed rows", () => {
  test("unchanged file set + mtimes <= builtAt → NOT stale (kind unchanged)", () => {
    const db = openDb();
    try {
      const dir = tmpDir();
      const f1 = path.join(dir, "one.md");
      const f2 = path.join(dir, "two.md");
      writeFileAtMtime(f1, "1", 1000);
      writeFileAtMtime(f2, "2", 1000);
      seedEntry(db, dir, f1);
      seedEntry(db, dir, f2);
      const state = getDirIndexState(db, dir, [f1, f2], 5000 /* builtAt after mtimes */);
      expect(state.stale).toBe(false);
      expect(state.reason.kind).toBe("unchanged");
      expect(state.persistedRowCount).toBe(2);
    } finally {
      closeDatabase(db);
    }
  });

  test("an edited file (mtime > builtAt) → stale, kind mtime-changed", () => {
    const db = openDb();
    try {
      const dir = tmpDir();
      const f1 = path.join(dir, "one.md");
      writeFileAtMtime(f1, "1", 9000); // newer than builtAt
      seedEntry(db, dir, f1);
      const state = getDirIndexState(db, dir, [f1], 5000);
      expect(state.stale).toBe(true);
      expect(state.reason.kind).toBe("mtime-changed");
      expect(state.reason.detail).toBe("one.md");
    } finally {
      closeDatabase(db);
    }
  });

  test("a DELETED file (fewer files than indexed) → stale, kind file-set-changed", () => {
    const db = openDb();
    try {
      const dir = tmpDir();
      const f1 = path.join(dir, "one.md");
      const f2 = path.join(dir, "two.md");
      writeFileAtMtime(f1, "1", 1000);
      writeFileAtMtime(f2, "2", 1000);
      seedEntry(db, dir, f1);
      seedEntry(db, dir, f2);
      // two.md deleted on disk → current file list has only one.md
      const state = getDirIndexState(db, dir, [f1], 5000);
      expect(state.stale).toBe(true);
      expect(state.reason.kind).toBe("file-set-changed");
    } finally {
      closeDatabase(db);
    }
  });

  test("a RENAME (same count, different name) → stale, kind file-set-changed", () => {
    // Regression guard: a rename keeps the file COUNT the same, so a naive
    // size-only check would wrongly report 'unchanged'. The engine must detect
    // the new basename that was never indexed.
    const db = openDb();
    try {
      const dir = tmpDir();
      const original = path.join(dir, "old-name.md");
      writeFileAtMtime(original, "x", 1000);
      seedEntry(db, dir, original);
      const renamed = path.join(dir, "new-name.md");
      writeFileAtMtime(renamed, "x", 1000);
      const state = getDirIndexState(db, dir, [renamed], 5000);
      expect(state.stale).toBe(true);
      expect(state.reason.kind).toBe("file-set-changed");
      expect(state.reason.detail).toBe("new-name.md");
    } finally {
      closeDatabase(db);
    }
  });

  test("a file listed but missing on disk → stale, kind missing-file", () => {
    const db = openDb();
    try {
      const dir = tmpDir();
      const f1 = path.join(dir, "one.md");
      writeFileAtMtime(f1, "1", 1000);
      seedEntry(db, dir, f1);
      // Same basename indexed, but the path passed in does not exist on disk.
      const ghost = path.join(dir, "one.md");
      fs.rmSync(f1);
      const state = getDirIndexState(db, dir, [ghost], 5000);
      expect(state.stale).toBe(true);
      expect(state.reason.kind).toBe("missing-file");
    } finally {
      closeDatabase(db);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getDirIndexState — zero-prev-rows path (cached vs no-previous-rows)
// ═══════════════════════════════════════════════════════════════════════════

describe("getDirIndexState — with NO previously-indexed rows", () => {
  test("cached zero-row fingerprint that still matches → NOT stale, cached-zero-row-state", () => {
    const db = openDb();
    try {
      const dir = tmpDir();
      const f1 = path.join(dir, "note.md");
      writeFileAtMtime(f1, "n", 4000);
      const fp = computeDirFingerprint(dir, [f1]);
      upsertIndexDirState(db, {
        dirPath: dir,
        fileSetHash: fp.fileSetHash,
        fileMtimeMaxMs: fp.fileMtimeMaxMs,
        reason: "empty-generated-set",
      });
      const state = getDirIndexState(db, dir, [f1], 5000);
      expect(state.stale).toBe(false);
      expect(state.reason.kind).toBe("cached-zero-row-state");
      expect(state.reason.detail).toBe("empty-generated-set");
      expect(state.persistedRowCount).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  test("cached fingerprint that no longer matches (mtime moved) → stale, no-previous-rows", () => {
    const db = openDb();
    try {
      const dir = tmpDir();
      const f1 = path.join(dir, "note.md");
      writeFileAtMtime(f1, "n", 4000);
      const fp = computeDirFingerprint(dir, [f1]);
      upsertIndexDirState(db, {
        dirPath: dir,
        fileSetHash: fp.fileSetHash,
        fileMtimeMaxMs: fp.fileMtimeMaxMs,
        reason: "empty-generated-set",
      });
      // File edited since the cache was written → fingerprint mismatch.
      writeFileAtMtime(f1, "n2", 8000);
      const state = getDirIndexState(db, dir, [f1], 9000);
      expect(state.stale).toBe(true);
      expect(state.reason.kind).toBe("no-previous-rows");
      expect(state.reason.detail).toBe("cached=empty-generated-set");
    } finally {
      closeDatabase(db);
    }
  });

  test("no rows and no cache → stale, no-previous-rows with no cached detail", () => {
    const db = openDb();
    try {
      const dir = tmpDir();
      const f1 = path.join(dir, "note.md");
      writeFileAtMtime(f1, "n", 4000);
      const state = getDirIndexState(db, dir, [f1], 5000);
      expect(state.stale).toBe(true);
      expect(state.reason.kind).toBe("no-previous-rows");
      expect(state.reason.detail).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// canUseIncrementalSkip + getCachedZeroRowDirState
// ═══════════════════════════════════════════════════════════════════════════

describe("canUseIncrementalSkip", () => {
  const cachedState = (detail: string) =>
    ({
      stale: false,
      reason: { kind: "cached-zero-row-state" as const, detail },
      persistedRowCount: 0,
    }) as const;

  test("deduped-zero-row + priorDirsChanged CANNOT skip (dedup may have moved a row)", () => {
    expect(canUseIncrementalSkip(cachedState("deduped-zero-row"), true)).toBe(false);
  });

  test("deduped-zero-row but priorDirsChanged=false CAN skip", () => {
    expect(canUseIncrementalSkip(cachedState("deduped-zero-row"), false)).toBe(true);
  });

  test("a non-dedup zero-row reason CAN skip even when prior dirs changed", () => {
    expect(canUseIncrementalSkip(cachedState("empty-generated-set"), true)).toBe(true);
  });

  test("a non-cached reason kind is unaffected by the dedup guard", () => {
    const s = { stale: false, reason: { kind: "unchanged" as const }, persistedRowCount: 2 };
    expect(canUseIncrementalSkip(s, true)).toBe(true);
  });
});

describe("getCachedZeroRowDirState", () => {
  function setupCached(detail: string): { db: Database; dir: string; file: string } {
    const db = openDb();
    const dir = tmpDir();
    const file = path.join(dir, "note.md");
    writeFileAtMtime(file, "n", 4000);
    const fp = computeDirFingerprint(dir, [file]);
    upsertIndexDirState(db, {
      dirPath: dir,
      fileSetHash: fp.fileSetHash,
      fileMtimeMaxMs: fp.fileMtimeMaxMs,
      reason: detail,
    });
    return { db, dir, file };
  }

  test("returns the fresh cached state when skip is allowed", () => {
    const { db, dir, file } = setupCached("empty-generated-set");
    try {
      const state = getCachedZeroRowDirState(db, dir, [file], 5000, true);
      expect(state).toBeDefined();
      expect(state?.reason.kind).toBe("cached-zero-row-state");
    } finally {
      closeDatabase(db);
    }
  });

  test("returns undefined when the dedup guard forbids the skip", () => {
    const { db, dir, file } = setupCached("deduped-zero-row");
    try {
      // priorDirsChanged=true + deduped-zero-row → skip forbidden.
      expect(getCachedZeroRowDirState(db, dir, [file], 5000, true)).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });

  test("returns undefined when the dir is stale (fingerprint moved)", () => {
    const { db, dir, file } = setupCached("empty-generated-set");
    try {
      writeFileAtMtime(file, "changed", 9000); // fingerprint no longer matches
      expect(getCachedZeroRowDirState(db, dir, [file], 9500, false)).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// inferZeroRowReason — priority ordering of the four reason buckets
// ═══════════════════════════════════════════════════════════════════════════

describe("inferZeroRowReason", () => {
  const emptyStash: StashFile = { entries: [] } as unknown as StashFile;
  const nonEmptyStash: StashFile = { entries: [{ name: "x", type: "knowledge" }] } as unknown as StashFile;

  test("dedupedRows > 0 wins over everything else", () => {
    expect(inferZeroRowReason(nonEmptyStash, { kind: "mtime-changed" }, [], "/d", 3)).toBe("deduped-zero-row");
  });

  test("workflow-noise when a warning skipped a workflow in this dir", () => {
    const warnings = ["Skipped workflow foo in /d/sub"];
    expect(inferZeroRowReason(nonEmptyStash, undefined, warnings, "/d", 0)).toBe("workflow-noise");
  });

  test("empty-generated-set when the stash produced no entries", () => {
    expect(inferZeroRowReason(emptyStash, undefined, [], "/d", 0)).toBe("empty-generated-set");
    expect(inferZeroRowReason(null, undefined, [], "/d", 0)).toBe("empty-generated-set");
  });

  test("falls back to zero-row:<priorReason.kind> when a stash exists but 0 rows survived", () => {
    expect(inferZeroRowReason(nonEmptyStash, { kind: "file-set-changed" }, [], "/d", 0)).toBe(
      "zero-row:file-set-changed",
    );
  });

  test("falls back to zero-row:unknown when there is no prior reason", () => {
    expect(inferZeroRowReason(nonEmptyStash, undefined, [], "/d", 0)).toBe("zero-row:unknown");
  });

  test("a workflow warning for a DIFFERENT dir does not trigger workflow-noise", () => {
    const warnings = ["Skipped workflow foo in /other"];
    expect(inferZeroRowReason(nonEmptyStash, undefined, warnings, "/d", 0)).toBe("zero-row:unknown");
  });
});
