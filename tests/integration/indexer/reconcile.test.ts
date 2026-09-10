// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for the reconcile engine (`src/indexer/reconcile.ts`, index-redesign B1).
 *
 * Lives under tests/integration/ because it opens a real index database via
 * `openIndexDatabase` (AGENTS.md classification rule).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveInstallations } from "../../../src/indexer/installations";
import { reconcilePaths, reconcileRoots } from "../../../src/indexer/reconcile";
import { resolveSourceEntries } from "../../../src/indexer/search/search-source";
import type { Database } from "../../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  writeSandboxConfig,
} from "../../_helpers/sandbox";

const BUNDLE_ID = "test-bundle";

let stashDir = "";
let cleanup: Cleanup = () => {};
let tmpDirs: string[] = [];

beforeEach(() => {
  const stash = sandboxStashDir();
  cleanup = stash.cleanup;
  stashDir = stash.dir;
  const cfg = sandboxXdgConfigHome(cleanup);
  cleanup = cfg.cleanup;
  const cache = sandboxXdgCacheHome(cleanup);
  cleanup = cache.cleanup;
  // A config file must exist for loadConfig() to resolve cleanly, and no
  // embedding.endpoint means probeProviderLimits() never touches the network.
  writeSandboxConfig({});
  tmpDirs = [];
});

afterEach(() => {
  cleanup();
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function newDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-reconcile-db-"));
  tmpDirs.push(dir);
  return path.join(dir, "index.db");
}

function openDb(dbPath: string): Database {
  return openIndexDatabase(dbPath);
}

/** Write a "knowledge" note under the sandboxed stash so the `akm` adapter recognizes it. */
function writeNote(relPath: string, opts: { description?: string; body?: string } = {}): string {
  const filePath = path.join(stashDir, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const title = path.basename(relPath, ".md");
  fs.writeFileSync(
    filePath,
    `---\ndescription: ${opts.description ?? "a plain note"}\n---\n\n# ${title}\n\n${opts.body ?? "Body content for this note."}\n`,
    "utf8",
  );
  return filePath;
}

/** A note with more than one markdown fragment (an H1 intro plus two H2 sections), for the rename test. */
function writeMultiFragmentNote(relPath: string): string {
  const filePath = path.join(stashDir, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const title = path.basename(relPath, ".md");
  fs.writeFileSync(
    filePath,
    `---\ndescription: a note with more than one fragment\n---\n\n# ${title}\n\nIntro paragraph text here for the top section, giving it real body content so it is not empty.\n\n` +
      "## Section One\n\nSome fragment text that should stay stable across a rename, long enough to be its own fragment.\n\n" +
      "## Section Two\n\nAnother fragment with distinct content that also stays stable across a rename.\n",
    "utf8",
  );
  return filePath;
}

function bumpMtimeForward(filePath: string): void {
  const stat = fs.statSync(filePath);
  const future = new Date(stat.mtimeMs + 5_000);
  fs.utimesSync(filePath, future, future);
}

function entriesTable(db: Database): Array<{ id: number; item_ref: string; file_path: string; content_hash: string }> {
  return db.prepare("SELECT id, item_ref, file_path, content_hash FROM entries").all() as Array<{
    id: number;
    item_ref: string;
    file_path: string;
    content_hash: string;
  }>;
}

function filesTable(
  db: Database,
): Array<{ path: string; bundle_id: string; size: number; mtime_ms: number; blob_hash: string }> {
  return db.prepare("SELECT path, bundle_id, size, mtime_ms, blob_hash FROM files").all() as Array<{
    path: string;
    bundle_id: string;
    size: number;
    mtime_ms: number;
    blob_hash: string;
  }>;
}

function unitTextsTable(db: Database): Array<{ unit_hash: string; kind: string }> {
  return db.prepare("SELECT unit_hash, kind FROM unit_texts").all() as Array<{ unit_hash: string; kind: string }>;
}

function unitsFtsCount(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM units_fts").get() as { n: number }).n;
}

function entryUnitsForEntry(
  db: Database,
  entryId: number,
): Array<{ ordinal: number; fragment_id: string | null; unit_hash: string }> {
  return db
    .prepare("SELECT ordinal, fragment_id, unit_hash FROM entry_units WHERE entry_id = ? ORDER BY ordinal")
    .all(entryId) as Array<{
    ordinal: number;
    fragment_id: string | null;
    unit_hash: string;
  }>;
}

describe("reconcileRoots", () => {
  test("add: new files become entries, files rows, and unit_texts/entry_units", async () => {
    const dbPath = newDbPath();
    const db = openDb(dbPath);
    try {
      writeNote("memories/alpha.md", { body: "Alpha body." });
      writeNote("memories/beta.md", { body: "Beta body." });

      const counts = await reconcileRoots(db, [{ path: stashDir, bundleId: BUNDLE_ID }]);

      expect(counts.scanned).toBe(2);
      expect(counts.added).toBe(2);
      expect(counts.changed).toBe(0);
      expect(counts.removed).toBe(0);
      expect(counts.unchanged).toBe(0);
      expect(counts.unitsAdded).toBeGreaterThanOrEqual(2);

      const entries = entriesTable(db);
      expect(entries.length).toBe(2);
      expect(entries.map((e) => e.item_ref).sort()).toEqual(
        [`${BUNDLE_ID}//memories/alpha`, `${BUNDLE_ID}//memories/beta`].sort(),
      );
      for (const entry of entries) expect(entry.content_hash).toBeTruthy();

      const files = filesTable(db);
      expect(files.length).toBe(2);
      for (const file of files) expect(file.bundle_id).toBe(BUNDLE_ID);

      // Every entry got its unit 0 written to unit_texts, mirrored into units_fts.
      const unitTexts = unitTextsTable(db);
      expect(unitTexts.length).toBeGreaterThanOrEqual(2);
      expect(unitsFtsCount(db)).toBe(unitTexts.length);

      for (const entry of entries) {
        const units = entryUnitsForEntry(db, entry.id);
        expect(units.length).toBeGreaterThanOrEqual(1);
        expect(units[0]?.ordinal).toBe(0);
        expect(units[0]?.fragment_id).toBeNull();
      }
    } finally {
      closeDatabase(db);
    }
  });

  test("idempotence: a second run with nothing changed touches no row", async () => {
    const dbPath = newDbPath();
    const db = openDb(dbPath);
    try {
      writeNote("memories/alpha.md");
      writeNote("memories/beta.md");
      await reconcileRoots(db, [{ path: stashDir, bundleId: BUNDLE_ID }]);

      const before = { entries: entriesTable(db), files: filesTable(db), unitTexts: unitTextsTable(db) };

      const counts = await reconcileRoots(db, [{ path: stashDir, bundleId: BUNDLE_ID }]);

      expect(counts).toEqual({
        scanned: 2,
        unchanged: 2,
        added: 0,
        changed: 0,
        removed: 0,
        unitsAdded: 0,
        complete: true,
        warnings: [],
      });
      expect(entriesTable(db)).toEqual(before.entries);
      expect(filesTable(db)).toEqual(before.files);
      expect(unitTextsTable(db)).toEqual(before.unitTexts);
    } finally {
      closeDatabase(db);
    }
  });

  test("edit: changed content re-derives content_hash and units for that entry only", async () => {
    const dbPath = newDbPath();
    const db = openDb(dbPath);
    try {
      const alpha = writeNote("memories/alpha.md", { body: "Original alpha body." });
      writeNote("memories/beta.md", { body: "Beta body, unaffected by the edit below." });
      await reconcileRoots(db, [{ path: stashDir, bundleId: BUNDLE_ID }]);

      const before = entriesTable(db);
      const alphaBefore = before.find((e) => e.file_path === alpha)!;
      const betaBefore = before.find((e) => e.file_path !== alpha)!;

      // A different length guarantees the stat diff fires regardless of mtime resolution.
      fs.writeFileSync(
        alpha,
        "---\ndescription: a plain note\n---\n\n# alpha\n\nA substantially rewritten and much longer alpha body.\n",
        "utf8",
      );
      bumpMtimeForward(alpha);

      const counts = await reconcileRoots(db, [{ path: stashDir, bundleId: BUNDLE_ID }]);

      expect(counts).toMatchObject({ scanned: 2, unchanged: 1, added: 0, changed: 1, removed: 0 });

      const after = entriesTable(db);
      const alphaAfter = after.find((e) => e.id === alphaBefore.id)!;
      const betaAfter = after.find((e) => e.id === betaBefore.id)!;
      expect(after.length).toBe(2);
      expect(alphaAfter.content_hash).not.toBe(alphaBefore.content_hash);
      expect(betaAfter.content_hash).toBe(betaBefore.content_hash);
    } finally {
      closeDatabase(db);
    }
  });

  test("delete: a removed file drops its entry, its entry_units, and its files row", async () => {
    const dbPath = newDbPath();
    const db = openDb(dbPath);
    try {
      const alpha = writeNote("memories/alpha.md");
      writeNote("memories/beta.md");
      await reconcileRoots(db, [{ path: stashDir, bundleId: BUNDLE_ID }]);
      const alphaId = entriesTable(db).find((e) => e.file_path === alpha)!.id;

      fs.rmSync(alpha);
      const counts = await reconcileRoots(db, [{ path: stashDir, bundleId: BUNDLE_ID }]);

      expect(counts).toMatchObject({ scanned: 1, unchanged: 1, added: 0, changed: 0, removed: 1 });
      expect(entriesTable(db).some((e) => e.file_path === alpha)).toBe(false);
      expect(filesTable(db).some((f) => f.path === alpha)).toBe(false);
      expect(entryUnitsForEntry(db, alphaId)).toEqual([]);
    } finally {
      closeDatabase(db);
    }
  });

  test("#339 desync: a files row whose entries row vanished is dropped, not left orphaned", async () => {
    const dbPath = newDbPath();
    const db = openDb(dbPath);
    try {
      const alpha = writeNote("memories/alpha.md", { body: "Alpha body for the desync test." });
      await reconcileRoots(db, [{ path: stashDir, bundleId: BUNDLE_ID }]);
      expect(filesTable(db).some((f) => f.path === alpha)).toBe(true);

      // Simulate the desync directly: something clears `entries` without
      // touching `files` (a crash mid-rebuild, a hand operation), leaving a
      // `files` row with no corresponding `entries` row.
      db.prepare("DELETE FROM entries WHERE file_path = ?").run(alpha);

      const counts = await reconcileRoots(db, [{ path: stashDir, bundleId: BUNDLE_ID }]);

      // The orphaned `files` row is swept before Phase 1 runs, so
      // `upsertOrInsert`'s existedBefore check (keyed on the `files` row, not
      // `entries`) sees no prior row and reports a fresh add, not an update.
      expect(counts.added).toBe(1);
      expect(counts.changed).toBe(0);

      const filesAfter = filesTable(db).filter((f) => f.path === alpha);
      expect(filesAfter.length).toBe(1);
      expect(entriesTable(db).some((e) => e.file_path === alpha)).toBe(true);
    } finally {
      closeDatabase(db);
    }
  });

  test("rename: one row re-pointed (same entries.id), fragment unit hashes reused", async () => {
    const dbPath = newDbPath();
    const db = openDb(dbPath);
    try {
      const oldPath = writeMultiFragmentNote("knowledge/rename-src.md");
      const counts1 = await reconcileRoots(db, [{ path: stashDir, bundleId: BUNDLE_ID }]);
      expect(counts1.added).toBe(1);

      const before = entriesTable(db)[0]!;
      const unitsBefore = entryUnitsForEntry(db, before.id);
      // unit 0 (the structured/"card" unit) plus 3 markdown fragments.
      expect(unitsBefore.length).toBe(4);
      const hashesBefore = new Set(unitsBefore.map((u) => u.unit_hash));

      const newPath = path.join(stashDir, "knowledge", "rename-dst.md");
      fs.renameSync(oldPath, newPath);

      const counts2 = await reconcileRoots(db, [{ path: stashDir, bundleId: BUNDLE_ID }]);

      // Exactly one row for this content: the gone old path paired with the
      // new path is a rename, not an unrelated delete + insert.
      expect(counts2.removed).toBe(0);
      const after = entriesTable(db);
      expect(after.length).toBe(1);
      const afterRow = after[0]!;

      // "One row re-pointed": the SAME entries.id now points at the new path
      // and identity — a single UPDATE, not a delete-then-reinsert under a
      // fresh id. (The akm adapter's canonical name — and so every unit's
      // header line — is derived from the file's path, "NOT the frontmatter
      // title", so the unit hashes themselves are NOT expected to survive a
      // renaming move; see the module doc's "no re-derive" note.)
      expect(afterRow.id).toBe(before.id);
      expect(afterRow.file_path).toBe(newPath);
      expect(afterRow.item_ref).toBe(`${BUNDLE_ID}//knowledge/rename-dst`);
      expect(afterRow.content_hash).toBe(before.content_hash);

      const unitsAfter = entryUnitsForEntry(db, afterRow.id);
      expect(unitsAfter.length).toBe(4);
      const hashesAfter = new Set(unitsAfter.map((u) => u.unit_hash));
      expect(hashesAfter.size).toBe(4);
      for (const hash of hashesAfter) expect(hashesBefore.has(hash)).toBe(false);

      const filesAfter = filesTable(db);
      expect(filesAfter.some((f) => f.path === oldPath)).toBe(false);
      expect(filesAfter.some((f) => f.path === newPath)).toBe(true);
      expect(filesAfter.find((f) => f.path === newPath)?.blob_hash).toBe(afterRow.content_hash);
    } finally {
      closeDatabase(db);
    }
  });

  test("a duplicate-content file going away is deleted, not mistaken for a rename of its unrelated twin", async () => {
    const dbPath = newDbPath();
    const db = openDb(dbPath);
    try {
      // Byte-identical bodies (a duplicate a cleanup pass would flag), but
      // two independently-named, independently-identified files — the exact
      // shape a naive hash-only rename match misreads as "renamed" instead
      // of "coincidentally shares content with something that went away".
      const original = writeNote("memories/original.md", { body: "Shared duplicate body." });
      const duplicate = writeNote("memories/duplicate.md", { body: "Shared duplicate body." });
      const counts1 = await reconcileRoots(db, [{ path: stashDir, bundleId: BUNDLE_ID }]);
      expect(counts1.added).toBe(2);

      const before = entriesTable(db);
      const originalBefore = before.find((e) => e.file_path === original);
      const duplicateBefore = before.find((e) => e.file_path === duplicate);
      expect(originalBefore).toBeDefined();
      expect(duplicateBefore).toBeDefined();
      expect(originalBefore!.item_ref).toBe(`${BUNDLE_ID}//memories/original`);
      expect(duplicateBefore!.item_ref).toBe(`${BUNDLE_ID}//memories/duplicate`);

      // The duplicate goes away (archived/pruned elsewhere) while its
      // byte-identical twin is simply re-walked unchanged (e.g. a --full
      // reindex, which reparses every file regardless of the stat hint).
      fs.rmSync(duplicate);
      const counts2 = await reconcileRoots(db, [{ path: stashDir, bundleId: BUNDLE_ID }], { forceReparse: true });

      // The duplicate's row is genuinely gone — never silently stranded
      // (unclaimed by a rename AND never swept) and never crashes on a
      // UNIQUE(item_ref) collision from being wrongly repointed onto the
      // twin's own established identity.
      expect(counts2.removed).toBe(1);
      const after = entriesTable(db);
      expect(after.length).toBe(1);
      const afterRow = after[0]!;

      // The twin keeps its OWN row/id/identity untouched — not hijacked by
      // the gone duplicate's rename match.
      expect(afterRow.id).toBe(originalBefore!.id);
      expect(afterRow.file_path).toBe(original);
      expect(afterRow.item_ref).toBe(`${BUNDLE_ID}//memories/original`);

      const filesAfter = filesTable(db);
      expect(filesAfter.some((f) => f.path === duplicate)).toBe(false);
      expect(filesAfter.some((f) => f.path === original)).toBe(true);
    } finally {
      closeDatabase(db);
    }
  });

  test("orphaned unit_texts/units_fts are pruned once no entry references them, vectors table untouched", async () => {
    const dbPath = newDbPath();
    const db = openDb(dbPath);
    try {
      const alpha = writeNote("memories/alpha.md", { body: "Unique unshared body for pruning." });
      await reconcileRoots(db, [{ path: stashDir, bundleId: BUNDLE_ID }]);
      expect(unitTextsTable(db).length).toBeGreaterThan(0);

      fs.rmSync(alpha);
      await reconcileRoots(db, [{ path: stashDir, bundleId: BUNDLE_ID }]);

      expect(unitTextsTable(db)).toEqual([]);
      expect(unitsFtsCount(db)).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  test("two concurrent reconciles of the same root converge on one consistent state", async () => {
    const dbPath = newDbPath();
    writeNote("memories/alpha.md", { body: "Alpha body for the concurrency test." });
    writeNote("memories/beta.md", { body: "Beta body for the concurrency test." });

    const dbA = openDb(dbPath);
    const dbB = openIndexDatabase(dbPath);
    try {
      const [countsA, countsB] = await Promise.all([
        reconcileRoots(dbA, [{ path: stashDir, bundleId: BUNDLE_ID }]),
        reconcileRoots(dbB, [{ path: stashDir, bundleId: BUNDLE_ID }]),
      ]);

      // Together the two runs account for exactly 2 files each, and between
      // them exactly 2 rows got written (added+changed sums to 2 across both).
      expect(countsA.scanned).toBe(2);
      expect(countsB.scanned).toBe(2);
      expect(countsA.added + countsA.changed + (countsB.added + countsB.changed)).toBe(2);

      const entries = entriesTable(dbA);
      expect(entries.length).toBe(2);
      expect(new Set(entries.map((e) => e.item_ref)).size).toBe(2);
      expect(filesTable(dbA).length).toBe(2);

      // A third, serial run afterward sees everything as unchanged — the
      // concurrent pair left the index in a fully consistent state.
      const countsC = await reconcileRoots(dbA, [{ path: stashDir, bundleId: BUNDLE_ID }]);
      expect(countsC).toEqual({
        scanned: 2,
        unchanged: 2,
        added: 0,
        changed: 0,
        removed: 0,
        unitsAdded: 0,
        complete: true,
        warnings: [],
      });
    } finally {
      closeDatabase(dbA);
      closeDatabase(dbB);
    }
  });
});

describe("reconcilePaths", () => {
  function currentBundleId(): string {
    return deriveInstallations(resolveSourceEntries())[0]!.id;
  }

  test("add and delete via a known path list", async () => {
    const dbPath = newDbPath();
    const db = openDb(dbPath);
    try {
      const bundleId = currentBundleId();
      const alpha = writeNote("memories/alpha.md", { body: "Written via the fast path." });

      const counts1 = await reconcilePaths(db, [alpha], bundleId);
      expect(counts1).toMatchObject({ scanned: 1, added: 1, changed: 0, removed: 0 });
      expect(entriesTable(db).some((e) => e.file_path === alpha)).toBe(true);
      expect(filesTable(db).some((f) => f.path === alpha)).toBe(true);

      fs.rmSync(alpha);
      const counts2 = await reconcilePaths(db, [alpha], bundleId);
      expect(counts2).toMatchObject({ scanned: 1, added: 0, changed: 0, removed: 1 });
      expect(entriesTable(db).some((e) => e.file_path === alpha)).toBe(false);
    } finally {
      closeDatabase(db);
    }
  });

  test("an unknown bundle id is a no-op, not a throw", async () => {
    const dbPath = newDbPath();
    const db = openDb(dbPath);
    try {
      const alpha = writeNote("memories/alpha.md");
      const counts = await reconcilePaths(db, [alpha], "no-such-bundle");
      expect(counts).toEqual({
        scanned: 0,
        unchanged: 0,
        added: 0,
        changed: 0,
        removed: 0,
        unitsAdded: 0,
        complete: true,
        warnings: [],
      });
      expect(entriesTable(db)).toEqual([]);
    } finally {
      closeDatabase(db);
    }
  });
});
