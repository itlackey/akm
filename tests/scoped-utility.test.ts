/**
 * Scoped utility scores — per-project usage signal isolation.
 *
 * Verifies:
 *   1. Bumping entry X in scope A does not affect entry X in scope B.
 *   2. `getUtilityScoresByIds` returns both global and scoped maps correctly.
 *   3. The ranking contributor prefers scoped over global (blend 0.7/0.3).
 *   4. Migration runs cleanly on a fresh DB and on a DB that already has
 *      `utility_scores` rows (CREATE TABLE IF NOT EXISTS pattern).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bumpUtilityScoresBatch,
  closeDatabase,
  getUtilityScoresByIds,
  openDatabase,
  type ScopedUtilityRow,
  type UtilityScoreRow,
} from "../src/indexer/db/db";
import type { StashEntry } from "../src/indexer/passes/metadata";
import type { RankedEntryInput } from "../src/indexer/search/ranking";
import { applyUtilityContributors, type UtilityRankingContext } from "../src/indexer/search/ranking-contributors";
import type { Database } from "../src/storage/database";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDb(label: string): { db: Database; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `akm-scoped-util-${label}-`));
  const dbPath = path.join(dir, "index.db");
  const db = openDatabase(dbPath);
  return { db, dbPath };
}

function makeRankedItem(id: number, baseScore = 1): RankedEntryInput {
  const entry: StashEntry = { name: `entry-${id}`, type: "skill" };
  return { id, entry, filePath: `/stash/skills/entry-${id}.md`, score: baseScore, rankingMode: "fts" };
}

function makeCtx(
  globalScores: Map<number, UtilityScoreRow>,
  scopedScores?: Map<number, ScopedUtilityRow>,
): UtilityRankingContext {
  return {
    db: null as unknown as Database,
    query: "test",
    queryLower: "test",
    queryTokens: ["test"],
    graphContext: null,
    utilityScores: globalScores,
    scopedUtilityScores: scopedScores,
  };
}

function makeGlobalRow(id: number, utility: number): UtilityScoreRow {
  return {
    entryId: id,
    utility,
    showCount: 1,
    searchCount: 1,
    selectRate: 1,
    lastUsedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeScopedRow(id: number, scopeKey: string, utility: number): ScopedUtilityRow {
  return {
    entryId: id,
    scopeKey,
    utility,
    lastUsedAt: Date.now(),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("scoped utility scores — DB isolation", () => {
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    ({ db, dbPath } = makeTempDb("isolation"));
    // Insert a minimal entry so foreign key constraints are satisfied
    db.prepare(
      "INSERT INTO entries (id, entry_key, dir_path, file_path, stash_dir, entry_json, search_text, entry_type) VALUES (1, 'skill:foo', '/s', '/s/foo.md', '/s', '{}', 'foo', 'skill')",
    ).run();
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  test("bumping scope A does not affect scope B utility for the same entry", () => {
    const scopeA = "dir:v1:aaaa";
    const scopeB = "dir:v1:bbbb";

    bumpUtilityScoresBatch(db, [1], 1.0, 0.1, scopeA);
    bumpUtilityScoresBatch(db, [1], 1.0, 0.1, scopeA);

    const { scoped: scopedA } = getUtilityScoresByIds(db, [1], scopeA);
    const { scoped: scopedB } = getUtilityScoresByIds(db, [1], scopeB);

    expect(scopedA.get(1)?.utility).toBeGreaterThan(0);
    expect(scopedB.get(1)).toBeUndefined();
  });

  test("bumping scope B does not affect scope A", () => {
    const scopeA = "dir:v1:aaaa";
    const scopeB = "dir:v1:bbbb";

    bumpUtilityScoresBatch(db, [1], 1.0, 0.1, scopeA);
    bumpUtilityScoresBatch(db, [1], 1.0, 0.1, scopeB);
    bumpUtilityScoresBatch(db, [1], 1.0, 0.1, scopeB);

    const { scoped: scopedA } = getUtilityScoresByIds(db, [1], scopeA);
    const { scoped: scopedB } = getUtilityScoresByIds(db, [1], scopeB);

    // A was bumped once, B twice — they should differ
    const utilA = scopedA.get(1)?.utility ?? 0;
    const utilB = scopedB.get(1)?.utility ?? 0;
    expect(utilA).toBeGreaterThan(0);
    expect(utilB).toBeGreaterThan(utilA);
  });
});

describe("getUtilityScoresByIds — dual maps", () => {
  let db: Database;
  let dbPath: string;

  beforeEach(() => {
    ({ db, dbPath } = makeTempDb("getutil"));
    db.prepare(
      "INSERT INTO entries (id, entry_key, dir_path, file_path, stash_dir, entry_json, search_text, entry_type) VALUES (1, 'skill:foo', '/s', '/s/foo.md', '/s', '{}', 'foo', 'skill')",
    ).run();
    db.prepare(
      "INSERT INTO entries (id, entry_key, dir_path, file_path, stash_dir, entry_json, search_text, entry_type) VALUES (2, 'skill:bar', '/s', '/s/bar.md', '/s', '{}', 'bar', 'skill')",
    ).run();
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  test("returns both global and scoped maps for the same ids", () => {
    const scopeKey = "dir:v1:test";
    bumpUtilityScoresBatch(db, [1, 2], 1.0, 0.1);
    bumpUtilityScoresBatch(db, [1], 1.0, 0.1, scopeKey);

    const { global, scoped } = getUtilityScoresByIds(db, [1, 2], scopeKey);

    // Global: both entries should have a score
    expect(global.get(1)?.utility).toBeGreaterThan(0);
    expect(global.get(2)?.utility).toBeGreaterThan(0);

    // Scoped: only entry 1 was bumped with scopeKey
    expect(scoped.get(1)?.utility).toBeGreaterThan(0);
    expect(scoped.get(2)).toBeUndefined();
  });

  test("scoped map is empty when no scopeKey is passed", () => {
    bumpUtilityScoresBatch(db, [1], 1.0, 0.1, "dir:v1:test");
    const { global, scoped } = getUtilityScoresByIds(db, [1]);
    expect(global.get(1)?.utility).toBeGreaterThan(0);
    expect(scoped.size).toBe(0);
  });

  test("returns empty maps for empty ids array", () => {
    const { global, scoped } = getUtilityScoresByIds(db, []);
    expect(global.size).toBe(0);
    expect(scoped.size).toBe(0);
  });
});

describe("ranking contributor — scoped preference", () => {
  test("uses global utility when no scoped score exists", () => {
    const item = makeRankedItem(1);
    const globalScores = new Map([[1, makeGlobalRow(1, 0.5)]]);
    const ctx = makeCtx(globalScores);
    applyUtilityContributors(item, ctx);
    expect(item.score).toBeGreaterThan(1);
    expect(item.utilityBoosted).toBe(true);
  });

  test("prefers scoped over global — scoped=0.8 > global=0.2 yields higher boost", () => {
    // With only global=0.2
    const itemGlobalOnly = makeRankedItem(1);
    const ctxGlobal = makeCtx(new Map([[1, makeGlobalRow(1, 0.2)]]));
    applyUtilityContributors(itemGlobalOnly, ctxGlobal);

    // With scoped=0.8 and global=0.2 → blend = 0.8*0.7 + 0.2*0.3 = 0.56 + 0.06 = 0.62
    const itemScoped = makeRankedItem(1);
    const ctxScoped = makeCtx(
      new Map([[1, makeGlobalRow(1, 0.2)]]),
      new Map([[1, makeScopedRow(1, "dir:v1:test", 0.8)]]),
    );
    applyUtilityContributors(itemScoped, ctxScoped);

    expect(itemScoped.score).toBeGreaterThan(itemGlobalOnly.score);
  });

  test("blend ratio: effectiveUtility = scoped*0.7 + global*0.3 when scoped > 0", () => {
    // Fixed values to verify the blend formula exactly
    const scopedUtility = 0.6;
    const globalUtility = 0.4;
    // effective = 0.6 * 0.7 + 0.4 * 0.3 = 0.42 + 0.12 = 0.54
    const expected = scopedUtility * 0.7 + globalUtility * 0.3;

    // Use a fresh item and apply without recency decay (lastUsedAt = undefined)
    const scopedRow: ScopedUtilityRow = {
      entryId: 1,
      scopeKey: "dir:v1:test",
      utility: scopedUtility,
      lastUsedAt: Date.now(),
    };
    const globalRow: UtilityScoreRow = {
      entryId: 1,
      utility: globalUtility,
      showCount: 0,
      searchCount: 0,
      selectRate: 0,
      lastUsedAt: undefined, // no recency factor (= 1)
      updatedAt: new Date().toISOString(),
    };

    const item = makeRankedItem(1, 1.0);
    const ctx = makeCtx(new Map([[1, globalRow]]), new Map([[1, scopedRow]]));
    applyUtilityContributors(item, ctx);

    // rawBoost = 1 + effective * 1 * 0.5 (UTILITY_WEIGHT=0.5)
    const UTILITY_WEIGHT = 0.5;
    const UTILITY_MAX_BOOST = 1.5;
    const rawBoost = 1 + expected * UTILITY_WEIGHT;
    const expectedScore = Math.min(rawBoost, UTILITY_MAX_BOOST);
    expect(item.score).toBeCloseTo(expectedScore, 5);
  });

  test("falls back to global when scoped utility is 0", () => {
    const globalUtility = 0.5;
    // scopedScore.utility = 0 so the contributor should use globalUtility instead
    const scopedRow: ScopedUtilityRow = {
      entryId: 1,
      scopeKey: "dir:v1:test",
      utility: 0,
      lastUsedAt: Date.now(), // recent, so recency factor = 1 (if it were used)
    };
    const globalRow: UtilityScoreRow = {
      entryId: 1,
      utility: globalUtility,
      showCount: 0,
      searchCount: 0,
      selectRate: 0,
      lastUsedAt: undefined, // no recency decay applied when undefined
      updatedAt: new Date().toISOString(),
    };

    const item = makeRankedItem(1);
    const ctx = makeCtx(new Map([[1, globalRow]]), new Map([[1, scopedRow]]));
    applyUtilityContributors(item, ctx);

    // scopedUtility=0 → effectiveUtility=globalUtility=0.5
    // lastUsedRaw: globalRow.lastUsedAt=undefined, scopedRow.lastUsedAt=now → recent
    // recencyFactor ≈ exp(0) = 1
    // rawBoost = 1 + 0.5 * 1 * 0.5 = 1.25
    const UTILITY_WEIGHT = 0.5;
    const UTILITY_MAX_BOOST = 1.5;
    const expectedScore = Math.min(1 + globalUtility * UTILITY_WEIGHT, UTILITY_MAX_BOOST);
    expect(item.score).toBeCloseTo(expectedScore, 2); // tolerance 0.01 (recency ≈ 1 but may not be exact 1)
  });
});

describe("schema migration safety", () => {
  test("CREATE TABLE IF NOT EXISTS is idempotent on fresh DB", () => {
    const { db: freshDb, dbPath: freshPath } = makeTempDb("fresh");
    try {
      const tables = freshDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='utility_scores_scoped'")
        .all() as Array<{ name: string }>;
      expect(tables.length).toBe(1);
    } finally {
      closeDatabase(freshDb);
      fs.rmSync(path.dirname(freshPath), { recursive: true, force: true });
    }
  });

  test("existing utility_scores rows survive openDatabase (no data loss)", () => {
    const { db: existingDb, dbPath: existingPath } = makeTempDb("existing");
    try {
      // Add an entry and bump its global utility
      existingDb
        .prepare(
          "INSERT INTO entries (id, entry_key, dir_path, file_path, stash_dir, entry_json, search_text, entry_type) VALUES (1, 'skill:foo', '/s', '/s/foo.md', '/s', '{}', 'foo', 'skill')",
        )
        .run();
      bumpUtilityScoresBatch(existingDb, [1], 1.0, 0.1);
      const { global: before } = getUtilityScoresByIds(existingDb, [1]);
      const beforeUtility = before.get(1)?.utility;
      expect(beforeUtility).toBeGreaterThan(0);

      // Re-open the same DB (simulates a binary restart / second ensureSchema call)
      closeDatabase(existingDb);
      const reopenedDb = openDatabase(existingPath);
      const { global: after } = getUtilityScoresByIds(reopenedDb, [1]);
      const afterUtility = after.get(1)?.utility;
      expect(afterUtility).toBeGreaterThan(0);
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
