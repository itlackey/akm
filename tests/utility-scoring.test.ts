/**
 * Tests for M-2: Utility-Based Re-ranking (MemRL Pattern).
 *
 * Validates utility_scores table creation, upsert/read helpers,
 * utility boost in search scoring, recency decay, cap at 1.5x,
 * recomputeUtilityScores aggregation, and whyMatched reporting.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../src/config";
import { closeDatabase, getUtilityScore, openDatabase, upsertUtilityScore } from "../src/db";
import { akmIndex, recomputeUtilityScores } from "../src/indexer";
import { getDbPath } from "../src/paths";
import { akmSearch } from "../src/source-search";
import type { SourceSearchHit } from "../src/source-types";
import { recordUsageEvent } from "./helpers/usage-events";

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
  const dir = createTmpDir("akm-utility-stash-");
  for (const sub of ["skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

async function buildTestIndex(stashDir: string, files: Record<string, string> = {}) {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(stashDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  process.env.AKM_STASH_DIR = stashDir;
  saveConfig({ semanticSearchMode: "off" });
  await akmIndex({ stashDir, full: true });
}

function expectDefined<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  if (value === undefined || value === null) {
    throw new Error("Expected value to be defined");
  }
  return value;
}

// ── Environment isolation ───────────────────────────────────────────────────

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalAkmStashDir = process.env.AKM_STASH_DIR;
let testCacheDir = "";
let testConfigDir = "";

beforeEach(() => {
  testCacheDir = createTmpDir("akm-utility-cache-");
  testConfigDir = createTmpDir("akm-utility-config-");
  process.env.XDG_CACHE_HOME = testCacheDir;
  process.env.XDG_CONFIG_HOME = testConfigDir;
});

afterEach(() => {
  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  }
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  if (originalAkmStashDir === undefined) {
    delete process.env.AKM_STASH_DIR;
  } else {
    process.env.AKM_STASH_DIR = originalAkmStashDir;
  }
  if (testCacheDir) {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
    testCacheDir = "";
  }
  if (testConfigDir) {
    fs.rmSync(testConfigDir, { recursive: true, force: true });
    testConfigDir = "";
  }
});

// ── Test 1: utility_scores table is created by ensureSchema ─────────────────

describe("utility_scores table creation", () => {
  test("ensureSchema creates utility_scores table", () => {
    const dbPath = path.join(createTmpDir("akm-util-db-"), "test.db");
    const db = openDatabase(dbPath);
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
    const db = openDatabase(dbPath);
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
    const db = openDatabase(dbPath);
    try {
      // Insert a dummy entry first (utility_scores references entries)
      db.prepare(
        "INSERT INTO entries (entry_key, dir_path, file_path, stash_dir, entry_json, search_text, entry_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("test:script:foo", "/tmp", "/tmp/foo.sh", "/tmp", '{"name":"foo","type":"script"}', "foo script", "script");
      const entryRow = db.prepare("SELECT id FROM entries WHERE entry_key = ?").get("test:script:foo") as {
        id: number;
      };
      const entryId = entryRow.id;

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
    const db = openDatabase(dbPath);
    try {
      db.prepare(
        "INSERT INTO entries (entry_key, dir_path, file_path, stash_dir, entry_json, search_text, entry_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("test:script:bar", "/tmp", "/tmp/bar.sh", "/tmp", '{"name":"bar","type":"script"}', "bar script", "script");
      const entryRow = db.prepare("SELECT id FROM entries WHERE entry_key = ?").get("test:script:bar") as {
        id: number;
      };
      const entryId = entryRow.id;

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
    const db = openDatabase(dbPath);
    try {
      const score = getUtilityScore(db, 99999);
      expect(score).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });
});

// ── Test 3: Entries with usage data get utility boost in search ───────────────

describe("Utility boost in search scoring", () => {
  test("entries with usage data get utility boost in search", async () => {
    const stashDir = tmpStash();

    // Create two entries with identical FTS content
    writeFile(path.join(stashDir, "scripts", "boosted-tool", "boosted-tool.sh"), "#!/bin/bash\necho boosted\n");
    writeFile(
      path.join(stashDir, "scripts", "boosted-tool", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "boosted-tool",
            type: "script",
            description: "A deployment automation utility for servers",
            filename: "boosted-tool.sh",
          },
        ],
      }),
    );

    writeFile(path.join(stashDir, "scripts", "plain-tool", "plain-tool.sh"), "#!/bin/bash\necho plain\n");
    writeFile(
      path.join(stashDir, "scripts", "plain-tool", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "plain-tool",
            type: "script",
            description: "A deployment automation utility for servers",
            filename: "plain-tool.sh",
          },
        ],
      }),
    );

    await buildTestIndex(stashDir, {});

    // Now inject utility score for the boosted entry
    const dbPath = getDbPath();
    const db = openDatabase(dbPath);
    try {
      const boostedEntry = db.prepare("SELECT id FROM entries WHERE entry_key LIKE '%boosted-tool%'").get() as
        | { id: number }
        | undefined;
      if (boostedEntry) {
        upsertUtilityScore(db, boostedEntry.id, {
          utility: 0.8,
          showCount: 20,
          searchCount: 25,
          selectRate: 0.8,
          lastUsedAt: new Date().toISOString(),
        });
      }
    } finally {
      closeDatabase(db);
    }

    const result = await akmSearch({ query: "deployment automation", source: "local" });
    const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    const boostedHit = localHits.find((h) => h.name === "boosted-tool");
    const plainHit = localHits.find((h) => h.name === "plain-tool");

    const resolvedBoosted = expectDefined(boostedHit);
    const resolvedPlain = expectDefined(plainHit);

    // The boosted entry should score higher due to utility boost
    expect(resolvedBoosted.score).toBeGreaterThan(expectDefined(resolvedPlain.score));
  });
});

// ── Test 4: Entries without usage data get no utility boost ──────────────────

describe("No utility boost for entries without usage data", () => {
  test("entries without usage data get no utility boost (score unchanged)", async () => {
    const stashDir = tmpStash();

    writeFile(path.join(stashDir, "scripts", "no-usage", "no-usage.sh"), "#!/bin/bash\necho no usage\n");
    writeFile(
      path.join(stashDir, "scripts", "no-usage", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "no-usage",
            type: "script",
            description: "A simple test tool with no usage history",
            filename: "no-usage.sh",
          },
        ],
      }),
    );

    await buildTestIndex(stashDir, {});

    const result = await akmSearch({ query: "simple test tool", source: "local" });
    const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    const hit = localHits.find((h) => h.name === "no-usage");

    const resolved = expectDefined(hit);
    // No utility data means no utilityBoost in whyMatched
    expect(resolved.whyMatched).toBeDefined();
    expect(resolved.whyMatched).not.toContain("usage history boost");
  });
});

// ── Test 5: Utility boost is capped at 1.5x ─────────────────────────────────

describe("Utility boost cap", () => {
  test("utility boost is capped at 1.5x", async () => {
    const stashDir = tmpStash();

    writeFile(path.join(stashDir, "scripts", "capped-a", "capped-a.sh"), "#!/bin/bash\necho capped\n");
    writeFile(
      path.join(stashDir, "scripts", "capped-a", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "capped-a",
            type: "script",
            description: "A network monitoring tool for production",
            filename: "capped-a.sh",
          },
        ],
      }),
    );

    writeFile(path.join(stashDir, "scripts", "capped-b", "capped-b.sh"), "#!/bin/bash\necho baseline\n");
    writeFile(
      path.join(stashDir, "scripts", "capped-b", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "capped-b",
            type: "script",
            description: "A network monitoring tool for production",
            filename: "capped-b.sh",
          },
        ],
      }),
    );

    await buildTestIndex(stashDir, {});

    // Inject an extremely high utility score for capped-a
    const dbPath = getDbPath();
    const db = openDatabase(dbPath);
    try {
      const cappedEntry = db.prepare("SELECT id FROM entries WHERE entry_key LIKE '%capped-a%'").get() as
        | { id: number }
        | undefined;
      if (cappedEntry) {
        upsertUtilityScore(db, cappedEntry.id, {
          utility: 10.0, // Extremely high utility
          showCount: 1000,
          searchCount: 1000,
          selectRate: 1.0,
          lastUsedAt: new Date().toISOString(),
        });
      }
    } finally {
      closeDatabase(db);
    }

    const result = await akmSearch({ query: "network monitoring", source: "local" });
    const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    const cappedHit = localHits.find((h) => h.name === "capped-a");
    const baselineHit = localHits.find((h) => h.name === "capped-b");

    const resolvedCapped = expectDefined(cappedHit);
    const resolvedBaseline = expectDefined(baselineHit);

    // The ratio between boosted and baseline should be at most 1.5x
    // (the cap). Allow a tiny tolerance for floating point + other small boosts.
    const ratio = expectDefined(resolvedCapped.score) / expectDefined(resolvedBaseline.score);
    expect(ratio).toBeLessThanOrEqual(1.55); // small tolerance for name boost differences
  });
});

// ── Test 6: Recency decay reduces boost for old usage ────────────────────────

describe("Recency decay on utility boost", () => {
  test("recent usage produces higher boost than old usage", async () => {
    const stashDir = tmpStash();

    writeFile(path.join(stashDir, "scripts", "recent-use", "recent-use.sh"), "#!/bin/bash\necho recent\n");
    writeFile(
      path.join(stashDir, "scripts", "recent-use", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "recent-use",
            type: "script",
            description: "A data processing pipeline tool for analytics",
            filename: "recent-use.sh",
          },
        ],
      }),
    );

    writeFile(path.join(stashDir, "scripts", "old-use", "old-use.sh"), "#!/bin/bash\necho old\n");
    writeFile(
      path.join(stashDir, "scripts", "old-use", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "old-use",
            type: "script",
            description: "A data processing pipeline tool for analytics",
            filename: "old-use.sh",
          },
        ],
      }),
    );

    await buildTestIndex(stashDir, {});

    const dbPath = getDbPath();
    const db = openDatabase(dbPath);
    try {
      const recentEntry = db.prepare("SELECT id FROM entries WHERE entry_key LIKE '%recent-use%'").get() as
        | { id: number }
        | undefined;
      const oldEntry = db.prepare("SELECT id FROM entries WHERE entry_key LIKE '%old-use%'").get() as
        | { id: number }
        | undefined;

      if (recentEntry) {
        upsertUtilityScore(db, recentEntry.id, {
          utility: 0.8,
          showCount: 20,
          searchCount: 25,
          selectRate: 0.8,
          lastUsedAt: new Date().toISOString(), // Just now
        });
      }
      if (oldEntry) {
        // Same utility score but last used 90 days ago
        const oldDate = new Date();
        oldDate.setDate(oldDate.getDate() - 90);
        upsertUtilityScore(db, oldEntry.id, {
          utility: 0.8,
          showCount: 20,
          searchCount: 25,
          selectRate: 0.8,
          lastUsedAt: oldDate.toISOString(),
        });
      }
    } finally {
      closeDatabase(db);
    }

    const result = await akmSearch({ query: "data processing pipeline", source: "local" });
    const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    const recentHit = localHits.find((h) => h.name === "recent-use");
    const oldHit = localHits.find((h) => h.name === "old-use");

    const resolvedRecent = expectDefined(recentHit);
    const resolvedOld = expectDefined(oldHit);

    // Recent usage should produce a higher score than old usage
    expect(resolvedRecent.score).toBeGreaterThan(expectDefined(resolvedOld.score));
  });
});

// ── Test 7: recomputeUtilityScores aggregates from usage_events ──────────────

describe("recomputeUtilityScores", () => {
  test("aggregates search and show events from usage_events", () => {
    const dbPath = path.join(createTmpDir("akm-util-db-"), "test.db");
    const db = openDatabase(dbPath);
    try {
      // Insert a test entry
      db.prepare(
        "INSERT INTO entries (entry_key, dir_path, file_path, stash_dir, entry_json, search_text, entry_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "test:script:recompute-test",
        "/tmp",
        "/tmp/recompute.sh",
        "/tmp",
        '{"name":"recompute-test","type":"script"}',
        "recompute test script",
        "script",
      );
      const entryRow = db.prepare("SELECT id FROM entries WHERE entry_key = ?").get("test:script:recompute-test") as {
        id: number;
      };
      const entryId = entryRow.id;

      // Record usage events: 5 searches that returned this entry, 3 shows
      for (let i = 0; i < 5; i++) {
        recordUsageEvent(db, {
          eventType: "search",
          entryId,
          timestamp: new Date().toISOString(),
        });
      }
      for (let i = 0; i < 3; i++) {
        recordUsageEvent(db, {
          eventType: "show",
          entryId,
          timestamp: new Date().toISOString(),
        });
      }

      // Recompute utility scores
      recomputeUtilityScores(db);

      // Check that utility scores were computed
      const score = getUtilityScore(db, entryId);
      expect(score).toBeDefined();
      expect(score?.searchCount).toBe(5);
      expect(score?.showCount).toBe(3);
      expect(score?.selectRate).toBeCloseTo(3 / 5, 2);
      expect(score?.utility).toBeGreaterThan(0);
    } finally {
      closeDatabase(db);
    }
  });

  test("entries with no usage events get zero utility", () => {
    const dbPath = path.join(createTmpDir("akm-util-db-"), "test.db");
    const db = openDatabase(dbPath);
    try {
      // Insert a test entry with no usage events
      db.prepare(
        "INSERT INTO entries (entry_key, dir_path, file_path, stash_dir, entry_json, search_text, entry_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "test:script:no-usage-test",
        "/tmp",
        "/tmp/no-usage.sh",
        "/tmp",
        '{"name":"no-usage-test","type":"script"}',
        "no usage test script",
        "script",
      );

      recomputeUtilityScores(db);

      const entryRow = db.prepare("SELECT id FROM entries WHERE entry_key = ?").get("test:script:no-usage-test") as {
        id: number;
      };
      const score = getUtilityScore(db, entryRow.id);
      // Either undefined or zero utility
      if (score) {
        expect(score.utility).toBe(0);
      }
    } finally {
      closeDatabase(db);
    }
  });
});

// ── Test 8: whyMatched includes usage history boost when applicable ──────────

describe("whyMatched includes usage history boost", () => {
  test("whyMatched includes usage history boost when utility > 0", async () => {
    const stashDir = tmpStash();

    writeFile(path.join(stashDir, "scripts", "why-util", "why-util.sh"), "#!/bin/bash\necho why utility\n");
    writeFile(
      path.join(stashDir, "scripts", "why-util", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "why-util",
            type: "script",
            description: "A logging infrastructure tool for debugging",
            filename: "why-util.sh",
          },
        ],
      }),
    );

    await buildTestIndex(stashDir, {});

    // Inject utility score
    const dbPath = getDbPath();
    const db = openDatabase(dbPath);
    try {
      const entry = db.prepare("SELECT id FROM entries WHERE entry_key LIKE '%why-util%'").get() as
        | { id: number }
        | undefined;
      if (entry) {
        upsertUtilityScore(db, entry.id, {
          utility: 0.6,
          showCount: 10,
          searchCount: 15,
          selectRate: 0.67,
          lastUsedAt: new Date().toISOString(),
        });
      }
    } finally {
      closeDatabase(db);
    }

    const result = await akmSearch({ query: "logging infrastructure", source: "local" });
    const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    const hit = localHits.find((h) => h.name === "why-util");

    const resolved = expectDefined(hit);
    expect(resolved.whyMatched).toBeDefined();
    expect(resolved.whyMatched).toContain("usage history boost");
  });
});

// ── Test 9: Production path end-to-end ───────────────────────────────────────

describe("Production path end-to-end", () => {
  test("index → search → usage_events have entry_id → recompute populates utility_scores", async () => {
    const stashDir = tmpStash();

    writeFile(path.join(stashDir, "scripts", "e2e-tool", "e2e-tool.sh"), "#!/bin/bash\necho e2e\n");
    writeFile(
      path.join(stashDir, "scripts", "e2e-tool", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "e2e-tool",
            type: "script",
            description: "An end-to-end test tool for production validation",
            filename: "e2e-tool.sh",
          },
        ],
      }),
    );

    await buildTestIndex(stashDir, {});

    // Search to trigger usage event logging
    const result = await akmSearch({ query: "end-to-end test", source: "local" });
    const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    expect(localHits.length).toBeGreaterThan(0);

    // Verify usage_events have entry_id
    const dbPath = getDbPath();
    const db = openDatabase(dbPath);
    try {
      const events = db
        .prepare("SELECT entry_id FROM usage_events WHERE event_type = 'search' AND entry_id IS NOT NULL")
        .all() as Array<{ entry_id: number }>;
      expect(events.length).toBeGreaterThan(0);

      // Recompute utility scores
      recomputeUtilityScores(db);

      // Verify utility_scores populated
      const scores = db.prepare("SELECT entry_id, utility FROM utility_scores").all() as Array<{
        entry_id: number;
        utility: number;
      }>;
      expect(scores.length).toBeGreaterThan(0);
    } finally {
      closeDatabase(db);
    }
  });
});
