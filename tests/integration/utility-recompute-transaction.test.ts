/**
 * `recomputeUtilityScores` writes every row in one index.db transaction: same values as the per-row path, no
 * partial write when one upsert fails, and the scoped call touches one row.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recomputeUtilityScores } from "../../src/indexer/indexer";
import { deriveEntryProvenance } from "../../src/indexer/installations";
import { ensureUsageEventsSchema } from "../../src/indexer/usage/usage-events";
import { closeDatabase, openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { getItemRefById, upsertEntry } from "../../src/storage/repositories/index-entries-repository";
import { recordUsageEvent } from "../_helpers/usage-events";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const N = 300;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-util-tx-"));
  tmpDirs.push(dir);
  const db = openIndexDatabase(path.join(dir, "index.db"));
  const stateDb = new Database(":memory:") as unknown as typeof db;
  ensureUsageEventsSchema(stateDb);
  const ids: number[] = [];
  const expected = new Map<number, { search: number; show: number; rate: number }>();
  for (let i = 0; i < N; i++) {
    const name = `entry-${String(i).padStart(4, "0")}`;
    const id = upsertEntry(
      db,
      `/tmp/${name}.sh`,
      { name, type: "script" },
      deriveEntryProvenance({ bundleId: "test", componentId: "test", adapterId: "akm" }, "script", name),
    );
    ids.push(id);
    const ref = getItemRefById(db, id) as string;
    // Two thirds of the entries have usage: (i % 5) + 1 searches and (i % 4) shows.
    const search = i % 3 === 0 ? 0 : (i % 5) + 1;
    const show = i % 3 === 0 ? 0 : i % 4;
    for (let k = 0; k < search; k++) recordUsageEvent(stateDb, { eventType: "search", entryId: id, entryRef: ref });
    for (let k = 0; k < show; k++) recordUsageEvent(stateDb, { eventType: "show", entryId: id, entryRef: ref });
    expected.set(id, { search, show, rate: search > 0 ? Math.min(1, show / search) : 0 });
  }
  return { db, stateDb, ids, expected };
}

function rows(db: ReturnType<typeof openIndexDatabase>) {
  return db
    .prepare("SELECT entry_id, utility, show_count, search_count, select_rate FROM utility_scores ORDER BY entry_id")
    .all() as Array<{
    entry_id: number;
    utility: number;
    show_count: number;
    search_count: number;
    select_rate: number;
  }>;
}

describe("recomputeUtilityScores transaction", () => {
  test("first run writes the documented values for every entry", () => {
    const { db, stateDb, ids, expected } = fixture();
    try {
      recomputeUtilityScores(db, stateDb);
      const got = rows(db);
      // Entries with no usage and no prior row are not written; the rest are.
      const withUsage = ids.filter((id) => (expected.get(id)?.search ?? 0) > 0 || (expected.get(id)?.show ?? 0) > 0);
      expect(got.map((r) => r.entry_id)).toEqual(withUsage);
      for (const r of got) {
        const e = expected.get(r.entry_id);
        expect(r.search_count).toBe(e?.search ?? -1);
        expect(r.show_count).toBe(e?.show ?? -1);
        expect(r.select_rate).toBeCloseTo(e?.rate ?? -1, 12);
        // First run: a new row starts at its rate.
        expect(r.utility).toBeCloseTo(e?.rate ?? 0, 12);
      }
      // A second run right after decays by the tiny elapsed time only.
      recomputeUtilityScores(db, stateDb);
      for (const r of rows(db)) {
        expect(r.utility).toBeCloseTo(expected.get(r.entry_id)?.rate ?? 0, 3);
      }
    } finally {
      closeDatabase(db);
      stateDb.close();
    }
  });

  test("a failing upsert midway leaves no row from the run", () => {
    const { db, stateDb } = fixture();
    try {
      db.exec(`CREATE TRIGGER fail_midway BEFORE INSERT ON utility_scores
        WHEN (SELECT COUNT(*) FROM utility_scores) >= 50
        BEGIN SELECT RAISE(ABORT, 'injected'); END`);
      expect(() => recomputeUtilityScores(db, stateDb)).toThrow("injected");
      expect(rows(db)).toEqual([]);
    } finally {
      closeDatabase(db);
      stateDb.close();
    }
  });

  test("the scoped call updates only its entry", () => {
    const { db, stateDb, ids, expected } = fixture();
    try {
      const target = ids.find((id) => (expected.get(id)?.search ?? 0) > 0) as number;
      recomputeUtilityScores(db, stateDb, target);
      const got = rows(db);
      expect(got.map((r) => r.entry_id)).toEqual([target]);
    } finally {
      closeDatabase(db);
      stateDb.close();
    }
  });

  test("many builds within a day apply about one day of decay in total", () => {
    const { db, stateDb, ids, expected } = fixture();
    try {
      const target = ids.find((id) => (expected.get(id)?.rate ?? 0) > 0) as number;
      const rate = expected.get(target)?.rate ?? 0;
      recomputeUtilityScores(db, stateDb);
      // Pretend the row was written a day ago and its usage has since vanished.
      db.prepare("UPDATE utility_scores SET updated_at = datetime('now', '-1 day') WHERE entry_id = ?").run(target);
      stateDb.exec("DELETE FROM usage_events");
      recomputeUtilityScores(db, stateDb);
      const oneDay = (rows(db).find((r) => r.entry_id === target) as { utility: number }).utility;
      expect(oneDay).toBeCloseTo(rate * 0.7, 3);
      for (let i = 0; i < 5; i++) recomputeUtilityScores(db, stateDb);
      const after = (rows(db).find((r) => r.entry_id === target) as { utility: number }).utility;
      expect(after).toBeCloseTo(oneDay, 3);
    } finally {
      closeDatabase(db);
      stateDb.close();
    }
  });
});
