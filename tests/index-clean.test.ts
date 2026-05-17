/**
 * Tests for the `--clean` post-pass of `akm index`.
 *
 * Covers three scenarios:
 *   1. `clean: true` with no missing files → removed: 0, checked matches entry count
 *   2. `clean: true` with one missing file → entry deleted, removedRefs populated
 *   3. `clean: true, dryRun: true` with missing file → removed: 0, ref listed, entry NOT deleted
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../src/core/config";
import { getDbPath } from "../src/core/paths";
import { closeDatabase, getAllEntries, openDatabase } from "../src/indexer/db";
import { akmIndex } from "../src/indexer/indexer";

let testConfigDir = "";
let testCacheDir = "";
let testDataDir = "";
let testStateDir = "";

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgStateHome = process.env.XDG_STATE_HOME;
const originalAkmStashDir = process.env.AKM_STASH_DIR;

beforeEach(() => {
  testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-clean-config-"));
  testCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-clean-cache-"));
  testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-clean-data-"));
  testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-clean-state-"));

  process.env.XDG_CONFIG_HOME = testConfigDir;
  process.env.XDG_CACHE_HOME = testCacheDir;
  process.env.XDG_DATA_HOME = testDataDir;
  process.env.XDG_STATE_HOME = testStateDir;

  if (originalAkmStashDir === undefined) {
    delete process.env.AKM_STASH_DIR;
  } else {
    process.env.AKM_STASH_DIR = originalAkmStashDir;
  }

  // Wipe any leftover database from previous test
  const dbPath = getDbPath();
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
});

afterEach(() => {
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  }
  if (originalXdgDataHome === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = originalXdgDataHome;
  }
  if (originalXdgStateHome === undefined) {
    delete process.env.XDG_STATE_HOME;
  } else {
    process.env.XDG_STATE_HOME = originalXdgStateHome;
  }
  if (originalAkmStashDir === undefined) {
    delete process.env.AKM_STASH_DIR;
  } else {
    process.env.AKM_STASH_DIR = originalAkmStashDir;
  }

  for (const dir of [testConfigDir, testCacheDir, testDataDir, testStateDir]) {
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
  testConfigDir = "";
  testCacheDir = "";
  testDataDir = "";
  testStateDir = "";
});

/** Create a temporary stash directory with the standard subdirectory layout. */
function tmpStash(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-clean-stash-"));
  for (const sub of ["skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

/** Write a file, creating parent directories as needed. */
function writeFile(filePath: string, content = ""): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test("akmIndex --clean with no missing files: removed is 0, checked matches entry count", async () => {
  const stashDir = tmpStash();
  writeFile(path.join(stashDir, "scripts", "deploy", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");
  writeFile(path.join(stashDir, "scripts", "lint", "lint.ts"), "console.log('lint')\n");

  process.env.AKM_STASH_DIR = stashDir;
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
  const stashDir = tmpStash();
  const deployFile = path.join(stashDir, "scripts", "deploy", "deploy.sh");
  const lintFile = path.join(stashDir, "scripts", "lint", "lint.ts");
  writeFile(deployFile, "#!/usr/bin/env bash\necho deploy\n");
  writeFile(lintFile, "console.log('lint')\n");

  process.env.AKM_STASH_DIR = stashDir;
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
  // The ref must refer to the deploy entry (entry_key contains stashDir prefix)
  expect(result.clean?.removedRefs[0]).toContain("deploy");

  // Verify the entry is actually gone from the database.
  // totalEntries is computed before the clean pass runs, so the DB now has
  // (totalEntries - removed) rows.
  const db = openDatabase();
  try {
    const remaining = getAllEntries(db);
    expect(remaining).toHaveLength(result.totalEntries - result.clean?.removed);
    expect(remaining.every((e) => !e.filePath.includes("deploy"))).toBe(true);
  } finally {
    closeDatabase(db);
  }
});

test("akmIndex --clean --dry-run with missing file: removed is 0, ref listed, entry NOT deleted", async () => {
  const stashDir = tmpStash();
  const deployFile = path.join(stashDir, "scripts", "deploy", "deploy.sh");
  const lintFile = path.join(stashDir, "scripts", "lint", "lint.ts");
  writeFile(deployFile, "#!/usr/bin/env bash\necho deploy\n");
  writeFile(lintFile, "console.log('lint')\n");

  process.env.AKM_STASH_DIR = stashDir;
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
  const db = openDatabase();
  try {
    const all = getAllEntries(db);
    const deployEntry = all.find((e) => e.filePath.includes("deploy"));
    expect(deployEntry).toBeDefined();
  } finally {
    closeDatabase(db);
  }
});
