/**
 * `utility_scores` repository: batch reads, and rows surviving a reopen of
 * the index (the CREATE TABLE IF NOT EXISTS schema path). The scores feed
 * improve's salience work; search ranking does not read them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveEntryProvenance } from "../../src/indexer/installations";
import type { Database } from "../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../src/storage/repositories/index-entries-repository";
import { getUtilityScoresByIds } from "../../src/storage/repositories/index-utility-repository";

function makeTempDb(label: string): { db: Database; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `akm-utility-${label}-`));
  const dbPath = path.join(dir, "index.db");
  const db = openIndexDatabase(dbPath);
  return { db, dbPath };
}

function seedSkill(db: Database, name: string): number {
  return upsertEntry(
    db,
    `/s/${name}.md`,
    { name, type: "skill" },
    deriveEntryProvenance({ bundleId: "s", componentId: "s", adapterId: "akm" }, "skill", name),
  );
}

/** Directly seed a utility_scores row (bypasses the EMA policy — fixture only). */
function seedUtility(db: Database, entryId: number, utility: number): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO utility_scores (entry_id, utility, show_count, search_count, select_rate, last_used_at, updated_at)
     VALUES (?, ?, 0, 0, 0, ?, ?)
     ON CONFLICT(entry_id) DO UPDATE SET utility = excluded.utility, updated_at = excluded.updated_at`,
  ).run(entryId, utility, now, now);
}

describe("getUtilityScoresByIds", () => {
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    ({ db, dbPath } = makeTempDb("getutil"));
    expect(seedSkill(db, "foo")).toBe(1);
    expect(seedSkill(db, "bar")).toBe(2);
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  test("returns the rows that exist, keyed by entry id", () => {
    seedUtility(db, 1, 0.4);
    const scores = getUtilityScoresByIds(db, [1, 2]);
    expect([...scores.keys()]).toEqual([1]);
    expect(scores.get(1)?.utility).toBeCloseTo(0.4, 5);
  });

  test("returns an empty map for no ids", () => {
    expect(getUtilityScoresByIds(db, []).size).toBe(0);
  });
});

describe("schema migration safety", () => {
  test("CREATE TABLE IF NOT EXISTS is idempotent on fresh DB", () => {
    const { db: freshDb, dbPath: freshPath } = makeTempDb("fresh");
    try {
      const tables = freshDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='utility_scores'")
        .all() as Array<{ name: string }>;
      expect(tables.length).toBe(1);
    } finally {
      closeDatabase(freshDb);
      fs.rmSync(path.dirname(freshPath), { recursive: true, force: true });
    }
  });

  test("existing utility_scores rows survive openIndexDatabase (no data loss)", () => {
    const { db: existingDb, dbPath: existingPath } = makeTempDb("existing");
    try {
      expect(seedSkill(existingDb, "foo")).toBe(1);
      seedUtility(existingDb, 1, 0.5);
      const beforeUtility = getUtilityScoresByIds(existingDb, [1]).get(1)?.utility;
      expect(beforeUtility).toBeGreaterThan(0);

      // Re-open the same DB (simulates a binary restart / second ensureSchema call)
      closeDatabase(existingDb);
      const reopenedDb = openIndexDatabase(existingPath);
      const afterUtility = getUtilityScoresByIds(reopenedDb, [1]).get(1)?.utility;
      expect(afterUtility).toBeCloseTo(beforeUtility as number, 5);
      closeDatabase(reopenedDb);
    } catch (err) {
      try {
        closeDatabase(existingDb);
      } catch {
        /* already closed */
      }
      throw err;
    } finally {
      fs.rmSync(path.dirname(existingPath), { recursive: true, force: true });
    }
  });
});
