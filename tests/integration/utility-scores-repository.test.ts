/**
 * `utility_scores` repository: batch reads, and rows surviving a reopen of
 * the index (the CREATE TABLE IF NOT EXISTS schema path). The scores feed
 * improve's salience work, and search reads the ones that carry only feedback
 * (`feedbackUtilities`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveEntryProvenance } from "../../src/indexer/installations";
import type { Database } from "../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../src/storage/repositories/index-entries-repository";
import {
  applyFeedbackToUtilityScore,
  getUtilityScoresByIds,
} from "../../src/storage/repositories/index-utility-repository";

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

  test("a row with no feedback reads as feedbackCount 0 and no feedback score", () => {
    seedUtility(db, 1, 0.4);
    expect(getUtilityScoresByIds(db, [1]).get(1)).toMatchObject({ feedbackCount: 0, feedbackScore: undefined });
  });

  test("a table that predates the feedback columns reads without them", () => {
    seedUtility(db, 1, 0.4);
    db.exec("ALTER TABLE utility_scores DROP COLUMN feedback_score");
    db.exec("ALTER TABLE utility_scores DROP COLUMN feedback_count");
    const row = getUtilityScoresByIds(db, [1]).get(1);
    expect(row).toMatchObject({ utility: 0.4, feedbackCount: 0 });
    expect(row?.feedbackScore).toBeUndefined();
  });
});

describe("applyFeedbackToUtilityScore", () => {
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    ({ db, dbPath } = makeTempDb("applyfb"));
    expect(seedSkill(db, "foo")).toBe(1);
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  test("moves utility and the feedback score together, the feedback score from the midpoint", () => {
    seedUtility(db, 1, 0.9);
    applyFeedbackToUtilityScore(db, 1, 0, 1);
    const row = getUtilityScoresByIds(db, [1]).get(1);
    // utility steps from its stored 0.9; the feedback score steps from 0.5.
    expect(row?.utility).toBeCloseTo(0.81, 12);
    expect(row?.feedbackScore).toBeCloseTo(0.45, 12);
    expect(row?.feedbackCount).toBe(1);

    applyFeedbackToUtilityScore(db, 1, 1, 1);
    const after = getUtilityScoresByIds(db, [1]).get(1);
    expect(after?.feedbackScore).toBeCloseTo(0.45 + 0.1 * (0.5 - 0.45), 12);
    expect(after?.feedbackCount).toBe(2);
  });

  test("adds the feedback columns to a table that predates them", () => {
    db.exec("ALTER TABLE utility_scores DROP COLUMN feedback_score");
    db.exec("ALTER TABLE utility_scores DROP COLUMN feedback_count");
    applyFeedbackToUtilityScore(db, 1, 1, 0);
    expect(getUtilityScoresByIds(db, [1]).get(1)).toMatchObject({ feedbackCount: 1 });
    expect(getUtilityScoresByIds(db, [1]).get(1)?.feedbackScore).toBeCloseTo(0.55, 12);
  });

  test("with no feedback counts nothing is written", () => {
    applyFeedbackToUtilityScore(db, 1, 0, 0);
    expect(getUtilityScoresByIds(db, [1]).size).toBe(0);
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
