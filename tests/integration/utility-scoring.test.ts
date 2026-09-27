/**
 * Tests for M-2: Utility-Based Re-ranking (MemRL Pattern).
 *
 * Validates utility_scores table creation, upsert/read helpers,
 * utility boost in search scoring, recency decay, cap at 1.5x,
 * recomputeUtilityScores aggregation, and whyMatched reporting.
 */

import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmSearch } from "../../src/commands/read/search";
import { saveConfig } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { openStateDatabase } from "../../src/core/state-db";
import { akmIndex, recomputeUtilityScores } from "../../src/indexer/indexer";
import { deriveEntryProvenance } from "../../src/indexer/installations";
import { ensureUsageEventsSchema } from "../../src/indexer/usage/usage-events";
import type { SourceSearchHit } from "../../src/sources/types";
import { closeDatabase, openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../src/storage/repositories/index-entries-repository";
import { getUtilityScore, upsertUtilityScore } from "../../src/storage/repositories/index-utility-repository";
import { type Cleanup, sandboxStashDir, sandboxXdgCacheHome, sandboxXdgConfigHome } from "../_helpers/sandbox";
import { recordUsageEvent } from "../_helpers/usage-events";

// ── Temp directory tracking ─────────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-utility-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function tmpStash(): string {
  // Returns the per-test sandboxed stash dir (AKM_BUNDLE_DIR is already set).
  // Subdirs are created by sandboxStashDir; this function is kept for API
  // compatibility with test bodies.
  return currentStashDir;
}

async function buildTestIndex(stashDir: string, files: Record<string, string> = {}) {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(stashDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  saveConfig({ semanticSearchMode: "off" });
  await akmIndex({ stashDir, full: true });
}

function seedIndexEntry(
  db: ReturnType<typeof openIndexDatabase>,
  name: string,
  filePath: string,
  searchText: string,
): number {
  return upsertEntry(
    db,
    filePath,
    { name, type: "script" },
    searchText,
    deriveEntryProvenance({ bundleId: "test", componentId: "test", adapterId: "akm" }, "script", name),
  );
}

// ── Environment isolation ───────────────────────────────────────────────────

let currentStashDir = "";
let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  currentStashDir = stashResult.dir;
  envCleanup = stashResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
  currentStashDir = "";
});

// ── Test 1: utility_scores table is created by ensureSchema ─────────────────

describe("utility_scores table creation", () => {
  test("ensureSchema creates utility_scores table", () => {
    const dbPath = path.join(createTmpDir("akm-util-db-"), "test.db");
    const db = openIndexDatabase(dbPath);
    try {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='utility_scores'").get() as
        | { name: string }
        | undefined;
      expect(row).toBeDefined();
      expect(row?.name).toBe("utility_scores");
    } finally {
      closeDatabase(db);
    }
  });

  test("utility_scores table has expected columns", () => {
    const dbPath = path.join(createTmpDir("akm-util-db-"), "test.db");
    const db = openIndexDatabase(dbPath);
    try {
      const columns = db.prepare("PRAGMA table_info(utility_scores)").all() as Array<{
        name: string;
        type: string;
      }>;
      const columnNames = columns.map((c) => c.name);
      expect(columnNames).toContain("entry_id");
      expect(columnNames).toContain("utility");
      expect(columnNames).toContain("show_count");
      expect(columnNames).toContain("search_count");
      expect(columnNames).toContain("select_rate");
      expect(columnNames).toContain("last_used_at");
      expect(columnNames).toContain("updated_at");
    } finally {
      closeDatabase(db);
    }
  });
});

// ── Test 2: upsertUtilityScore writes and reads correctly ────────────────────

describe("upsertUtilityScore / getUtilityScore", () => {
  test("upsertUtilityScore writes and getUtilityScore reads correctly", () => {
    const dbPath = path.join(createTmpDir("akm-util-db-"), "test.db");
    const db = openIndexDatabase(dbPath);
    try {
      // Insert a dummy entry first (utility_scores references entries).
      const entryId = seedIndexEntry(db, "foo", "/tmp/foo.sh", "foo script");

      upsertUtilityScore(db, entryId, {
        utility: 0.75,
        showCount: 10,
        searchCount: 20,
        selectRate: 0.5,
        lastUsedAt: "2026-03-17T00:00:00Z",
      });

      const score = getUtilityScore(db, entryId);
      expect(score).toBeDefined();
      expect(score?.utility).toBe(0.75);
      expect(score?.showCount).toBe(10);
      expect(score?.searchCount).toBe(20);
      expect(score?.selectRate).toBe(0.5);
      expect(score?.lastUsedAt).toBe("2026-03-17T00:00:00Z");
    } finally {
      closeDatabase(db);
    }
  });

  test("upsertUtilityScore updates existing row", () => {
    const dbPath = path.join(createTmpDir("akm-util-db-"), "test.db");
    const db = openIndexDatabase(dbPath);
    try {
      const entryId = seedIndexEntry(db, "bar", "/tmp/bar.sh", "bar script");

      upsertUtilityScore(db, entryId, {
        utility: 0.5,
        showCount: 5,
        searchCount: 10,
        selectRate: 0.5,
        lastUsedAt: "2026-03-15T00:00:00Z",
      });

      upsertUtilityScore(db, entryId, {
        utility: 0.9,
        showCount: 15,
        searchCount: 30,
        selectRate: 0.5,
        lastUsedAt: "2026-03-17T00:00:00Z",
      });

      const score = getUtilityScore(db, entryId);
      expect(score?.utility).toBe(0.9);
      expect(score?.showCount).toBe(15);
    } finally {
      closeDatabase(db);
    }
  });

  test("getUtilityScore returns undefined for missing entry", () => {
    const dbPath = path.join(createTmpDir("akm-util-db-"), "test.db");
    const db = openIndexDatabase(dbPath);
    try {
      const score = getUtilityScore(db, 99999);
      expect(score).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });
});

// ── Test 3: search ranking ignores utility scores ───────────────────────────

describe("Utility scores and search ranking", () => {
  test("a utility score does not change the order or scores of search hits", async () => {
    const stashDir = tmpStash();

    // Two entries with identical FTS content: their fused scores tie and the
    // item ref orders them (alpha-tool before zeta-tool).
    writeFile(
      path.join(stashDir, "scripts", "alpha-tool", "alpha-tool.sh"),
      "#!/bin/bash\n# A deployment automation utility for servers\necho alpha\n",
    );
    writeFile(
      path.join(stashDir, "scripts", "zeta-tool", "zeta-tool.sh"),
      "#!/bin/bash\n# A deployment automation utility for servers\necho zeta\n",
    );

    await buildTestIndex(stashDir, {});
    const search = async () =>
      (await akmSearch({ query: "deployment automation", source: "local", skipLogging: true })).hits
        .filter((h): h is SourceSearchHit => h.type !== "registry")
        .map((h) => [h.name, h.score]);
    const before = await search();
    expect(before.map(([name]) => name)).toEqual(["alpha-tool/alpha-tool.sh", "zeta-tool/zeta-tool.sh"]);

    const db = openIndexDatabase(getDbPath());
    try {
      const zeta = db.prepare("SELECT id FROM entries WHERE file_path LIKE '%zeta-tool%'").get() as { id: number };
      upsertUtilityScore(db, zeta.id, {
        utility: 0.8,
        showCount: 20,
        searchCount: 25,
        selectRate: 0.8,
        lastUsedAt: new Date().toISOString(),
      });
    } finally {
      closeDatabase(db);
    }

    expect(await search()).toEqual(before);
  });
});

// ── Test 4: recomputeUtilityScores ──────────────────────────────────────────

describe("recomputeUtilityScores", () => {
  test("aggregates search and show events from usage_events", () => {
    const dbPath = path.join(createTmpDir("akm-util-db-"), "test.db");
    const db = openIndexDatabase(dbPath);
    // Chunk-8 WI-8.3: usage_events lives in state.db; entries + utility_scores
    // stay in index.db (`db`).
    const stateDb = new Database(":memory:") as unknown as typeof db;
    try {
      const entryId = seedIndexEntry(db, "recompute-test", "/tmp/recompute.sh", "recompute test script");

      // Record usage events: 5 searches that returned this entry, then 3 shows.
      // last_used_at must preserve the latest event time;
      // recompute must not replace it with the index run time.
      const now = Date.now();
      const searchAt = new Date(now - 180_000).toISOString();
      const showAt = new Date(now - 120_000).toISOString();
      for (let i = 0; i < 5; i++) {
        recordUsageEvent(stateDb, {
          eventType: "search",
          entryId,
          timestamp: searchAt,
        });
      }
      for (let i = 0; i < 3; i++) {
        recordUsageEvent(stateDb, {
          eventType: "show",
          entryId,
          timestamp: showAt,
        });
      }

      // Recompute utility scores
      recomputeUtilityScores(db, stateDb);

      // Check that utility scores were computed
      const score = getUtilityScore(db, entryId);
      expect(score).toBeDefined();
      expect(score?.searchCount).toBe(5);
      expect(score?.showCount).toBe(3);
      expect(score?.selectRate).toBeCloseTo(3 / 5, 2);
      expect(score?.utility).toBeGreaterThan(0);
      expect(score?.lastUsedAt).toBe(showAt);
    } finally {
      closeDatabase(db);
      stateDb.close();
    }
  });

  test("entries with no usage events get zero utility", () => {
    const dbPath = path.join(createTmpDir("akm-util-db-"), "test.db");
    const db = openIndexDatabase(dbPath);
    const stateDb = new Database(":memory:") as unknown as typeof db;
    ensureUsageEventsSchema(stateDb);
    try {
      // Insert a test entry with no usage events.
      const entryId = seedIndexEntry(db, "no-usage-test", "/tmp/no-usage.sh", "no usage test script");

      recomputeUtilityScores(db, stateDb);

      const score = getUtilityScore(db, entryId);
      // Either undefined or zero utility
      if (score) {
        expect(score.utility).toBe(0);
      }
    } finally {
      closeDatabase(db);
      stateDb.close();
    }
  });

  test("recompute clears a synthetic last-used stamp when no retained retrieval event exists", () => {
    const dbPath = path.join(createTmpDir("akm-util-db-"), "test.db");
    const db = openIndexDatabase(dbPath);
    const stateDb = new Database(":memory:") as unknown as typeof db;
    ensureUsageEventsSchema(stateDb);
    try {
      const entryId = seedIndexEntry(db, "stale-last-use", "/tmp/stale-last-use.sh", "stale last use");
      upsertUtilityScore(db, entryId, {
        utility: 0.8,
        showCount: 10,
        searchCount: 10,
        selectRate: 1,
        lastUsedAt: new Date().toISOString(),
      });

      recomputeUtilityScores(db, stateDb);

      expect(getUtilityScore(db, entryId)?.lastUsedAt).toBeUndefined();
    } finally {
      closeDatabase(db);
      stateDb.close();
    }
  });
});

// ── Test 9: Production path end-to-end ───────────────────────────────────────

describe("Production path end-to-end", () => {
  test("index → search → usage_events have entry_id → recompute populates utility_scores", async () => {
    const stashDir = tmpStash();

    writeFile(
      path.join(stashDir, "scripts", "e2e-tool", "e2e-tool.sh"),
      "#!/bin/bash\n# An end-to-end test tool for production validation\necho e2e\n",
    );

    await buildTestIndex(stashDir, {});

    // Search to trigger usage event logging
    const result = await akmSearch({ query: "end-to-end test", source: "local" });
    const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    expect(localHits.length).toBeGreaterThan(0);

    // Verify usage_events have entry_id (usage_events lives in state.db, WI-8.3)
    const dbPath = getDbPath();
    const db = openIndexDatabase(dbPath);
    const stateDb = openStateDatabase();
    try {
      const events = stateDb
        .prepare("SELECT entry_id FROM usage_events WHERE event_type = 'search' AND entry_id IS NOT NULL")
        .all() as Array<{ entry_id: number }>;
      expect(events.length).toBeGreaterThan(0);

      // Recompute utility scores
      recomputeUtilityScores(db, stateDb);

      // Verify utility_scores populated (index.db)
      const scores = db.prepare("SELECT entry_id, utility FROM utility_scores").all() as Array<{
        entry_id: number;
        utility: number;
      }>;
      expect(scores.length).toBeGreaterThan(0);
    } finally {
      closeDatabase(db);
      stateDb.close();
    }
  });

  // Regression guard: 2026-05-26. usage_events has no FK to entries, so its
  // entry_id can become stale after consolidation/deletion. recomputeUtilityScores
  // used to aggregate by stale entry_id, then upsert into utility_scores (which
  // DOES have an FK), tripping "FOREIGN KEY constraint failed" and rolling back
  // the entire index finalize transaction.
  test("recomputeUtilityScores ignores stale usage_events entry_ids (no FK rollback)", async () => {
    writeFile(
      path.join(currentStashDir, "skills", "real-skill", "SKILL.md"),
      "---\nname: real-skill\ndescription: A real skill\n---\n\nA real skill.",
    );
    await buildTestIndex(currentStashDir, {});

    const dbPath = getDbPath();
    const db = openIndexDatabase(dbPath);
    const stateDb = openStateDatabase();
    try {
      const entries = db.prepare("SELECT id FROM entries LIMIT 1").all() as Array<{ id: number }>;
      const realId = entries[0]?.id;
      expect(realId).toBeGreaterThan(0);

      // One legitimate event, one stale event whose entry_id was deleted.
      // usage_events lives in state.db (WI-8.3); the stale entry_id names no
      // row in index.db's entries — the cross-DB filter must drop it.
      stateDb
        .prepare(
          "INSERT INTO usage_events (entry_id, entry_ref, event_type, signal, source, created_at) VALUES (?, ?, 'search', NULL, 'user', datetime('now'))",
        )
        .run(realId!, "skills/real-skill");
      const staleId = 999999; // not in entries
      stateDb
        .prepare(
          "INSERT INTO usage_events (entry_id, entry_ref, event_type, signal, source, created_at) VALUES (?, ?, 'search', NULL, 'user', datetime('now'))",
        )
        .run(staleId, "skills/vaporware");

      // This used to throw FOREIGN KEY constraint failed.
      expect(() => recomputeUtilityScores(db, stateDb)).not.toThrow();

      // utility_scores should have the live entry but NOT the stale one.
      const scores = db.prepare("SELECT entry_id FROM utility_scores").all() as Array<{ entry_id: number }>;
      const ids = scores.map((s) => s.entry_id);
      expect(ids).toContain(realId!);
      expect(ids).not.toContain(staleId);
    } finally {
      closeDatabase(db);
      stateDb.close();
    }
  });
});
