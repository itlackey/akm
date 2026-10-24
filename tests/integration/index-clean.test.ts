/**
 * Tests for the `--clean` post-pass of `akm index`.
 *
 * Covers four scenarios:
 *   1. `clean: true` with no missing files → removed: 0, checked matches entry count
 *   2. `clean: true` with one missing file → entry deleted, removedRefs populated
 *   3. `clean: true, dryRun: true` with missing file → removed: 0, ref listed, entry NOT deleted
 *   4. (R-022) `dryRun: true` WITHOUT `clean` rejects instead of silently running a
 *      real index — `dryRun` only ever gated the `--clean` pass above, so a bare
 *      `akm index --dry-run` used to perform a full real index and write index.db.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { akmIndex } from "../../src/indexer/indexer";
import { closeDatabase, openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { getAllEntries } from "../../src/storage/repositories/index-entries-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

/** Write a file, creating parent directories as needed. */
function writeFile(filePath: string, content = ""): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test("akmIndex --clean with no missing files: removed is 0, checked matches entry count", async () => {
  const stashDir = storage.stashDir;
  writeFile(path.join(stashDir, "scripts", "deploy", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");
  writeFile(path.join(stashDir, "scripts", "lint", "lint.ts"), "console.log('lint')\n");

  saveConfig({ semanticSearchMode: "off" });

  // First index: build the normal index
  await akmIndex({ stashDir, full: true });

  // Second run with --clean: all files still exist
  const result = await akmIndex({ stashDir, clean: true });

  expect(result.clean).toBeDefined();
  expect(result.clean?.dryRun).toBe(false);
  expect(result.clean?.removed).toBe(0);
  expect(result.clean?.removedRefs).toEqual([]);
  // checked should equal the number of entries in the DB (both files still exist)
  expect(result.clean?.checked).toBe(result.totalEntries);
});

test("akmIndex --clean with a missing file: entry deleted from DB, removedRefs populated", async () => {
  const stashDir = storage.stashDir;
  const deployFile = path.join(stashDir, "scripts", "deploy", "deploy.sh");
  const lintFile = path.join(stashDir, "scripts", "lint", "lint.ts");
  writeFile(deployFile, "#!/usr/bin/env bash\necho deploy\n");
  writeFile(lintFile, "console.log('lint')\n");

  saveConfig({ semanticSearchMode: "off" });

  // Build initial index with both files present
  const firstResult = await akmIndex({ stashDir, full: true });
  expect(firstResult.totalEntries).toBe(2);

  // Delete one file from disk (simulating a removed asset)
  fs.unlinkSync(deployFile);

  // Run --clean; the deleted file's entry should be purged
  const result = await akmIndex({ stashDir, clean: true });

  expect(result.clean).toBeDefined();
  expect(result.clean?.dryRun).toBe(false);
  expect(result.clean?.removed).toBe(1);
  expect(result.clean?.removedRefs).toHaveLength(1);
  // The removed canonical ref must identify the deploy entry.
  expect(result.clean?.removedRefs[0]).toContain("deploy");

  // Verify the entry is actually gone and the returned total describes the
  // same post-clean generation as the database.
  const db = openIndexDatabase();
  try {
    const remaining = getAllEntries(db);
    expect(remaining).toHaveLength(result.totalEntries);
    expect(remaining.every((e) => !e.filePath.includes("deploy"))).toBe(true);
  } finally {
    closeDatabase(db);
  }
});

test("akmIndex --clean --dry-run with missing file: removed is 0, ref listed, entry NOT deleted", async () => {
  const stashDir = storage.stashDir;
  const deployFile = path.join(stashDir, "scripts", "deploy", "deploy.sh");
  const lintFile = path.join(stashDir, "scripts", "lint", "lint.ts");
  writeFile(deployFile, "#!/usr/bin/env bash\necho deploy\n");
  writeFile(lintFile, "console.log('lint')\n");

  saveConfig({ semanticSearchMode: "off" });

  // Build initial index
  const firstResult = await akmIndex({ stashDir, full: true });
  expect(firstResult.totalEntries).toBe(2);

  // Remove one file
  fs.unlinkSync(deployFile);

  // Dry-run: report but do not delete
  const result = await akmIndex({ stashDir, clean: true, dryRun: true });

  expect(result.clean).toBeDefined();
  expect(result.clean?.dryRun).toBe(true);
  // removed must be 0 in dry-run
  expect(result.clean?.removed).toBe(0);
  // But the ref IS reported
  expect(result.clean?.removedRefs).toHaveLength(1);
  expect(result.clean?.removedRefs[0]).toContain("deploy");

  // Crucially: the entry must still exist in the database
  const db = openIndexDatabase();
  try {
    const all = getAllEntries(db);
    const deployEntry = all.find((e) => e.filePath.includes("deploy"));
    expect(deployEntry).toBeDefined();
  } finally {
    closeDatabase(db);
  }
});

test("akmIndex --dry-run without --clean rejects instead of silently running a real index (R-022)", async () => {
  const stashDir = storage.stashDir;
  writeFile(path.join(stashDir, "scripts", "deploy", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

  saveConfig({ semanticSearchMode: "off" });

  // Before the fix, `dryRun` was only consulted inside the `--clean` pass, so
  // a bare `--dry-run` (no `--clean`) silently performed a full real index and
  // wrote index.db. It must now reject instead.
  await expect(akmIndex({ stashDir, dryRun: true })).rejects.toThrow(/--dry-run.*--clean/);

  // The rejection must fire before any writer-lease acquisition or database
  // open — no index.db should exist afterward.
  const dbPath = getDbPath();
  expect(fs.existsSync(dbPath)).toBe(false);
});
