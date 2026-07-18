import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StashEntry } from "../../src/indexer/passes/metadata";
import type { Database } from "../../src/storage/database";
import {
  closeDatabase,
  openExistingDatabase,
  openIndexDatabase,
} from "../../src/storage/repositories/index-connection";
import {
  collectTagSetFromEntries,
  deleteEntriesByDir,
  getAllEntries,
  getEmbeddableEntryCount,
  getEntriesByDir,
  getEntryById,
  getEntryCount,
  getEntryFilePathById,
  getEntryIdByFilePath,
  getEntryRefRowsForStashRoot,
  upsertEntry,
} from "../../src/storage/repositories/index-entries-repository";
import { rebuildFts, searchFts } from "../../src/storage/repositories/index-fts-repository";
import { getMeta, setMeta } from "../../src/storage/repositories/index-meta-repository";
import { DB_VERSION } from "../../src/storage/repositories/index-schema";
import { isVecAvailable, searchVec, upsertEmbedding } from "../../src/storage/repositories/index-vec-repository";
import {
  getRegistryIndexCache,
  upsertRegistryIndexCache,
} from "../../src/storage/repositories/registry-index-cache-repository";
import { type Cleanup, sandboxXdgCacheHome, sandboxXdgConfigHome } from "../_helpers/sandbox";

// ── Temp directory management ───────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function tmpDir(label = "db"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `akm-${label}-`));
  createdTmpDirs.push(dir);
  return dir;
}

function tmpDbPath(label = "db"): string {
  const dir = tmpDir(label);
  return path.join(dir, "test.db");
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Environment isolation ───────────────────────────────────────────────────

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  envCleanup = cfgResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<StashEntry> & { name: string; type: StashEntry["type"] }): StashEntry {
  return {
    description: "A test entry",
    ...overrides,
  };
}

function insertTestEntry(
  db: Database,
  key: string,
  opts?: {
    dirPath?: string;
    filePath?: string;
    stashDir?: string;
    description?: string;
    searchText?: string;
    type?: StashEntry["type"];
  },
): number {
  const type = opts?.type ?? "script";
  const entry = makeEntry({ name: key, type, description: opts?.description ?? `Description for ${key}` });
  return upsertEntry(
    db,
    key,
    opts?.dirPath ?? "/test/dir",
    opts?.filePath ?? `/test/dir/${key}.ts`,
    opts?.stashDir ?? "/test/stash",
    entry,
    opts?.searchText ?? `${key} ${entry.description}`,
  );
}

// ── Section 1.1: Schema ────────────────────────────────────────────────────

describe("Schema", () => {
  test("openIndexDatabase creates schema with correct version", () => {
    const dbPath = tmpDbPath();
    const db = openIndexDatabase(dbPath);
    try {
      expect(getMeta(db, "version")).toBe(String(DB_VERSION));
    } finally {
      closeDatabase(db);
    }
  });

  test("openIndexDatabase with a stale version marker preserves data (no nuclear drop)", () => {
    const dbPath = tmpDbPath();

    // Open, insert data, stamp an OLDER version than DB_VERSION.
    let db = openIndexDatabase(dbPath);
    insertTestEntry(db, "old-entry");
    expect(getEntryCount(db)).toBe(1);
    setMeta(db, "version", "0");
    closeDatabase(db);

    // Reopen — the stale marker must NOT drop tables (the nuclear-drop path was
    // removed); the regenerable index converges forward and the entry survives.
    db = openIndexDatabase(dbPath);
    try {
      expect(getEntryCount(db)).toBe(1);
    } finally {
      closeDatabase(db);
    }
  });

  test("openIndexDatabase creates FTS5 table", () => {
    const dbPath = tmpDbPath();
    const db = openIndexDatabase(dbPath);
    try {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE name = 'entries_fts'").get() as
        | { name: string }
        | undefined;
      expect(row).toBeDefined();
      expect(row?.name).toBe("entries_fts");
    } finally {
      closeDatabase(db);
    }
  });

  test("isVecAvailable returns true when sqlite-vec is installed", () => {
    const dbPath = tmpDbPath();
    const db = openIndexDatabase(dbPath);
    try {
      expect(isVecAvailable(db)).toBe(true);
    } finally {
      closeDatabase(db);
    }
  });

  test("embeddingDim is stored and triggers vec table recreation", () => {
    const dbPath = tmpDbPath();

    let db = openIndexDatabase(dbPath, { embeddingDim: 512 });
    try {
      if (isVecAvailable(db)) {
        expect(getMeta(db, "embeddingDim")).toBe("512");
      }
    } finally {
      closeDatabase(db);
    }

    // Reopen with a different dimension
    db = openIndexDatabase(dbPath, { embeddingDim: 768 });
    try {
      if (isVecAvailable(db)) {
        expect(getMeta(db, "embeddingDim")).toBe("768");
      }
    } finally {
      closeDatabase(db);
    }
  });
});

// ── Section 1.2: Entry CRUD ────────────────────────────────────────────────

describe("Entry CRUD", () => {
  test("upsertEntry inserts a new entry and returns its id", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      const id = insertTestEntry(db, "my-tool");
      expect(id).toBeGreaterThan(0);
      expect(getEntryCount(db)).toBe(1);
    } finally {
      closeDatabase(db);
    }
  });

  test("upsertEntry updates on conflict (same entry_key)", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "my-tool", { description: "original description" });
      expect(getEntryCount(db)).toBe(1);

      // Upsert with updated description
      insertTestEntry(db, "my-tool", { description: "updated description" });
      expect(getEntryCount(db)).toBe(1);

      // Verify the entry reflects the update
      const entries = getAllEntries(db);
      expect(entries).toHaveLength(1);
      expect(entries[0].entry.description).toBe("updated description");
    } finally {
      closeDatabase(db);
    }
  });

  test("getEntryById returns the entry or undefined", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      const id = insertTestEntry(db, "fetch-tool", { description: "Fetches data" });

      const result = getEntryById(db, id);
      expect(result).toBeDefined();
      expect(result?.entry.name).toBe("fetch-tool");
      expect(result?.entry.description).toBe("Fetches data");
      expect(result?.filePath).toBe("/test/dir/fetch-tool.ts");

      // Non-existent ID
      const missing = getEntryById(db, 99999);
      expect(missing).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });

  test("getEntriesByDir returns entries for a directory", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "tool-a", { dirPath: "/project/alpha" });
      insertTestEntry(db, "tool-b", { dirPath: "/project/alpha" });
      insertTestEntry(db, "tool-c", { dirPath: "/project/beta" });

      const alphaEntries = getEntriesByDir(db, "/project/alpha");
      expect(alphaEntries).toHaveLength(2);
      const keys = alphaEntries.map((e) => e.entryKey).sort();
      expect(keys).toEqual(["tool-a", "tool-b"]);

      const betaEntries = getEntriesByDir(db, "/project/beta");
      expect(betaEntries).toHaveLength(1);
      expect(betaEntries[0].entryKey).toBe("tool-c");
    } finally {
      closeDatabase(db);
    }
  });

  test("getAllEntries returns all entries", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "entry-1");
      insertTestEntry(db, "entry-2");
      insertTestEntry(db, "entry-3");

      const all = getAllEntries(db);
      expect(all).toHaveLength(3);
    } finally {
      closeDatabase(db);
    }
  });

  test("getAllEntries with type filter", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "script-1", { type: "script" });
      insertTestEntry(db, "script-2", { type: "script" });
      insertTestEntry(db, "skill-1", { type: "skill" });

      const scripts = getAllEntries(db, "script");
      expect(scripts).toHaveLength(2);
      for (const t of scripts) {
        expect(t.entry.type).toBe("script");
      }

      const skills = getAllEntries(db, "skill");
      expect(skills).toHaveLength(1);
      expect(skills[0].entry.type).toBe("skill");
    } finally {
      closeDatabase(db);
    }
  });

  test("deleteEntriesByDir removes entries", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "del-1", { dirPath: "/to-delete" });
      insertTestEntry(db, "del-2", { dirPath: "/to-delete" });
      insertTestEntry(db, "keep-1", { dirPath: "/to-keep" });
      expect(getEntryCount(db)).toBe(3);

      deleteEntriesByDir(db, "/to-delete");
      expect(getEntryCount(db)).toBe(1);

      const remaining = getAllEntries(db);
      expect(remaining[0].entryKey).toBe("keep-1");
    } finally {
      closeDatabase(db);
    }
  });

  // Since the `vault` type was removed (0.9.0) every indexed entry is
  // embeddable, so the embeddable count always equals the full entry count.
  test("getEmbeddableEntryCount equals total entry count", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "asset-1", { type: "skill" });
      insertTestEntry(db, "asset-2", { type: "command" });
      insertTestEntry(db, "asset-3", { type: "script" });

      expect(getEmbeddableEntryCount(db)).toBe(getEntryCount(db));
      expect(getEmbeddableEntryCount(db)).toBe(3);
    } finally {
      closeDatabase(db);
    }
  });
});

// ── Section 1.3: FTS search ────────────────────────────────────────────────

describe("FTS search", () => {
  test("searchFts returns results ranked by BM25", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "deploy-tool", {
        description: "Deploy applications to production servers",
        searchText: "deploy deploy deploy applications production servers deployment",
      });
      insertTestEntry(db, "infra-tool", {
        description: "Cloud infrastructure for deploy pipelines",
        searchText: "cloud infrastructure management scaling networking deploy pipelines automation",
      });
      rebuildFts(db);

      const results = searchFts(db, "deploy", 10);
      expect(results.length).toBe(2);
      expect(results[0].entry.name).toBe("deploy-tool");
      expect(results[1].entry.name).toBe("infra-tool");
    } finally {
      closeDatabase(db);
    }
  });

  test("searchFts with type filter", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "build-script", {
        type: "script",
        description: "Build the project",
        searchText: "build project compilation",
      });
      insertTestEntry(db, "build-skill", {
        type: "skill",
        description: "Build pipeline skill",
        searchText: "build pipeline skill compilation",
      });
      rebuildFts(db);

      const scriptResults = searchFts(db, "build", 10, "script");
      expect(scriptResults).toHaveLength(1);
      expect(scriptResults[0].entry.type).toBe("script");

      const allResults = searchFts(db, "build", 10);
      expect(allResults).toHaveLength(2);
    } finally {
      closeDatabase(db);
    }
  });

  test("searchFts sanitizes query tokens", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "hello-tool", {
        description: "hello world 123 greeting",
        searchText: "hello world 123 greeting",
      });
      rebuildFts(db);

      // Should not throw a SQL error despite special characters
      const results = searchFts(db, "hello! world@123", 10);
      expect(results[0].entry.name).toBe("hello-tool");
      // "hello" and "world" and "123" are valid tokens after sanitization
      expect(results.length).toBeGreaterThanOrEqual(1);
    } finally {
      closeDatabase(db);
    }
  });

  test("searchFts returns empty for garbage query", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "some-tool", { searchText: "some useful tool" });
      rebuildFts(db);

      const results = searchFts(db, "!@#$%", 10);
      expect(results).toEqual([]);
    } finally {
      closeDatabase(db);
    }
  });

  // ── T5: sanitizeFtsQuery edge cases ──────────────────────────────────────
  // sanitizeFtsQuery is private, so we test it indirectly through searchFts.

  test("query that becomes empty after sanitization returns no results", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "target", { searchText: "some useful content" });
      rebuildFts(db);

      // "! @" contains only non-alphanumeric chars; after sanitization all
      // tokens are stripped, leaving an empty FTS query.
      const results = searchFts(db, "! @", 10);
      expect(results).toEqual([]);
    } finally {
      closeDatabase(db);
    }
  });

  test("query with only 1-character tokens returns no results when content has no matching single-char terms", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "abc-tool", { searchText: "alpha bravo charlie" });
      rebuildFts(db);

      // "a b c" — single-char tokens are passed to FTS5 but don't match
      // "alpha", "bravo", "charlie" because FTS5 doesn't do prefix matching.
      const results = searchFts(db, "a b c", 10);
      expect(results).toEqual([]);
    } finally {
      closeDatabase(db);
    }
  });

  test("FTS5 syntax injection is neutralized", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "foo-tool", { description: "foo bar baz", searchText: "foo bar baz" });
      insertTestEntry(db, "bar-tool", { description: "bar qux quux", searchText: "bar qux quux" });
      rebuildFts(db);

      // "NEAR(foo, bar)" is raw FTS5 syntax that should be sanitized.
      // After sanitization, syntax chars and NEAR are stripped, leaving
      // tokens "foo" "bar" (implicit AND) — should not throw and should
      // return matches containing both foo and bar.
      const results = searchFts(db, "NEAR(foo, bar)", 10);
      expect(results.length).toBeGreaterThanOrEqual(1);

      // foo-tool has both "foo" and "bar" in its search text
      const names = results.map((r) => r.entry.name);
      expect(names).toContain("foo-tool");
    } finally {
      closeDatabase(db);
    }
  });

  test("normal multi-word query returns correct results", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "deploy-prod", {
        description: "deploy application production servers",
        searchText: "deploy application production servers",
      });
      insertTestEntry(db, "test-runner", {
        description: "test runner unit integration",
        searchText: "test runner unit integration",
      });
      rebuildFts(db);

      const results = searchFts(db, "deploy production", 10);
      expect(results).toHaveLength(1);
      expect(results[0].entry.name).toBe("deploy-prod");
    } finally {
      closeDatabase(db);
    }
  });

  test("rebuildFts synchronizes FTS with entries table", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "alpha", { description: "alpha functionality", searchText: "alpha functionality" });
      insertTestEntry(db, "beta", { description: "beta functionality", searchText: "beta functionality" });
      insertTestEntry(db, "gamma", { description: "gamma functionality", searchText: "gamma functionality" });

      rebuildFts(db);

      const alphaResults = searchFts(db, "alpha", 10);
      expect(alphaResults).toHaveLength(1);
      expect(alphaResults[0].entry.name).toBe("alpha");

      const allResults = searchFts(db, "functionality", 10);
      expect(allResults).toHaveLength(3);
    } finally {
      closeDatabase(db);
    }
  });
});

// ── Section 1.4: Meta helpers ──────────────────────────────────────────────

describe("Meta helpers", () => {
  test("getMeta returns undefined for missing key", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      const val = getMeta(db, "nonexistent-key");
      expect(val).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });

  test("setMeta and getMeta round-trip", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      setMeta(db, "test-key", "test-value");
      expect(getMeta(db, "test-key")).toBe("test-value");
    } finally {
      closeDatabase(db);
    }
  });

  test("setMeta overwrites existing key", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      setMeta(db, "overwrite-key", "first");
      expect(getMeta(db, "overwrite-key")).toBe("first");

      setMeta(db, "overwrite-key", "second");
      expect(getMeta(db, "overwrite-key")).toBe("second");
    } finally {
      closeDatabase(db);
    }
  });
});

// ── Section 1.5: Vector / Embedding integration ────────────────────────────

describe("Vector / Embedding integration", () => {
  test("openIndexDatabase creates vec table when extension available", () => {
    const dbPath = tmpDbPath();
    const db = openIndexDatabase(dbPath);
    try {
      expect(isVecAvailable(db)).toBe(true);
      const row = db.prepare("SELECT name FROM sqlite_master WHERE name = 'entries_vec'").get() as
        | { name: string }
        | undefined;
      expect(row).toBeDefined();
      expect(row?.name).toBe("entries_vec");
    } finally {
      closeDatabase(db);
    }
  });

  test("upsertEmbedding stores and searchVec retrieves by similarity", () => {
    const dbPath = tmpDbPath();
    const db = openIndexDatabase(dbPath, { embeddingDim: 4 });
    try {
      expect(isVecAvailable(db)).toBe(true);

      // Insert two entries with distinct embeddings
      const id1 = insertTestEntry(db, "vec-tool-1", { searchText: "deployment" });
      const id2 = insertTestEntry(db, "vec-tool-2", { searchText: "testing" });

      // Embedding vectors: tool-1 points "north", tool-2 points "east"
      upsertEmbedding(db, id1, [1, 0, 0, 0]);
      upsertEmbedding(db, id2, [0, 1, 0, 0]);

      // Query close to tool-1's embedding
      const results = searchVec(db, [0.9, 0.1, 0, 0], 10);
      expect(results.length).toBe(2);
      // tool-1 should be the closest (smallest distance)
      expect(results[0].id).toBe(id1);
      expect(results[0].distance).toBeLessThan(results[1].distance);
    } finally {
      closeDatabase(db);
    }
  });

  test("upsertEmbedding overwrites existing embedding for same entry", () => {
    const dbPath = tmpDbPath();
    const db = openIndexDatabase(dbPath, { embeddingDim: 4 });
    try {
      const id = insertTestEntry(db, "vec-update", { searchText: "update test" });

      upsertEmbedding(db, id, [1, 0, 0, 0]);
      let results = searchVec(db, [1, 0, 0, 0], 10);
      expect(results.length).toBe(1);
      expect(results[0].distance).toBeCloseTo(0, 2);

      // Overwrite with a completely different direction
      upsertEmbedding(db, id, [0, 0, 0, 1]);
      results = searchVec(db, [0, 0, 0, 1], 10);
      expect(results.length).toBe(1);
      expect(results[0].distance).toBeCloseTo(0, 2);

      // Original direction should now be far
      results = searchVec(db, [1, 0, 0, 0], 10);
      expect(results[0].distance).toBeGreaterThan(1);
    } finally {
      closeDatabase(db);
    }
  });

  test("searchVec respects k limit", () => {
    const dbPath = tmpDbPath();
    const db = openIndexDatabase(dbPath, { embeddingDim: 4 });
    try {
      // Insert 5 entries with embeddings
      for (let i = 0; i < 5; i++) {
        const id = insertTestEntry(db, `vec-k-${i}`, { searchText: `entry ${i}` });
        const vec = [0, 0, 0, 0];
        vec[i % 4] = 1;
        upsertEmbedding(db, id, vec);
      }

      const results = searchVec(db, [1, 0, 0, 0], 2);
      expect(results.length).toBe(2);
    } finally {
      closeDatabase(db);
    }
  });

  test("deleteEntriesByDir also removes vec rows", () => {
    const dbPath = tmpDbPath();
    const db = openIndexDatabase(dbPath, { embeddingDim: 4 });
    try {
      const id1 = insertTestEntry(db, "vec-del-1", { dirPath: "/del-dir", searchText: "delete me" });
      const id2 = insertTestEntry(db, "vec-del-2", { dirPath: "/keep-dir", searchText: "keep me" });
      upsertEmbedding(db, id1, [1, 0, 0, 0]);
      upsertEmbedding(db, id2, [0, 1, 0, 0]);

      // Before delete, both should be searchable
      let results = searchVec(db, [0.5, 0.5, 0, 0], 10);
      expect(results.length).toBe(2);

      deleteEntriesByDir(db, "/del-dir");

      // After delete, only the kept entry should remain
      results = searchVec(db, [0.5, 0.5, 0, 0], 10);
      expect(results.length).toBe(1);
      expect(results[0].id).toBe(id2);
    } finally {
      closeDatabase(db);
    }
  });

  test("embeddingDim change recreates vec table and clears old embeddings", () => {
    const dbPath = tmpDbPath();

    // Open with dim=4 and insert an embedding
    let db = openIndexDatabase(dbPath, { embeddingDim: 4 });
    const id = insertTestEntry(db, "dim-change", { searchText: "dimension test" });
    upsertEmbedding(db, id, [1, 0, 0, 0]);
    let results = searchVec(db, [1, 0, 0, 0], 10);
    expect(results.length).toBe(1);
    closeDatabase(db);

    // Reopen with dim=8 — vec table should be recreated, old embeddings gone
    db = openIndexDatabase(dbPath, { embeddingDim: 8 });
    try {
      expect(getMeta(db, "embeddingDim")).toBe("8");
      // Old embedding was dim=4 and table was recreated for dim=8, so no results
      results = searchVec(db, [1, 0, 0, 0, 0, 0, 0, 0], 10);
      expect(results.length).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  test("openExistingDatabase preserves existing embedding dimension and embeddings", () => {
    const dbPath = tmpDbPath();

    let db = openIndexDatabase(dbPath, { embeddingDim: 4 });
    const id = insertTestEntry(db, "dim-stable", { searchText: "dimension stable" });
    upsertEmbedding(db, id, [1, 0, 0, 0]);
    setMeta(db, "hasEmbeddings", "1");
    closeDatabase(db);

    db = openExistingDatabase(dbPath);
    try {
      expect(getMeta(db, "embeddingDim")).toBe("4");
      expect(getMeta(db, "hasEmbeddings")).toBe("1");
      const results = searchVec(db, [1, 0, 0, 0], 10);
      expect(results.length).toBe(1);
      expect(results[0].id).toBe(id);
    } finally {
      closeDatabase(db);
    }
  });
});

// ── Incremental rebuildFts (#177 perf finding) ──────────────────────────────

describe("rebuildFts incremental", () => {
  function makeEntry(name: string, description = ""): StashEntry {
    return {
      name,
      type: "skill",
      description,
      filename: `${name}.md`,
    };
  }

  function ftsCount(db: Database): number {
    const row = db.prepare("SELECT COUNT(*) AS cnt FROM entries_fts").get() as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  function dirtyCount(db: Database): number {
    try {
      const row = db.prepare("SELECT COUNT(*) AS cnt FROM entries_fts_dirty").get() as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    } catch {
      return 0;
    }
  }

  test("upsertEntry marks rows dirty; incremental rebuild only re-indexes them", () => {
    const db = openIndexDatabase(tmpDbPath("inc-fts"));
    try {
      upsertEntry(db, "k1", "/d", "/d/k1.md", "/stash", makeEntry("alpha", "first"), "alpha first");
      upsertEntry(db, "k2", "/d", "/d/k2.md", "/stash", makeEntry("bravo", "second"), "bravo second");
      upsertEntry(db, "k3", "/d", "/d/k3.md", "/stash", makeEntry("charlie", "third"), "charlie third");
      rebuildFts(db, { incremental: false });
      expect(ftsCount(db)).toBe(3);
      expect(dirtyCount(db)).toBe(0);

      // Touch only one entry — its row should be the only dirty one.
      upsertEntry(db, "k2", "/d", "/d/k2.md", "/stash", makeEntry("bravo", "second-updated"), "bravo second-updated");
      expect(dirtyCount(db)).toBe(1);

      rebuildFts(db, { incremental: true });
      expect(ftsCount(db)).toBe(3);
      expect(dirtyCount(db)).toBe(0);

      const hits = db
        .prepare("SELECT entry_id FROM entries_fts WHERE entries_fts MATCH ?")
        .all(`"second-updated"`) as Array<{ entry_id: number }>;
      expect(hits.length).toBe(1);
    } finally {
      closeDatabase(db);
    }
  });

  test("incremental rebuild with empty dirty queue is a no-op", () => {
    const db = openIndexDatabase(tmpDbPath("inc-fts-empty"));
    try {
      upsertEntry(db, "k1", "/d", "/d/k1.md", "/stash", makeEntry("alpha"), "alpha");
      rebuildFts(db, { incremental: false });
      expect(ftsCount(db)).toBe(1);
      expect(dirtyCount(db)).toBe(0);
      rebuildFts(db, { incremental: true });
      expect(ftsCount(db)).toBe(1);
    } finally {
      closeDatabase(db);
    }
  });

  test("full rebuild also drains the dirty queue", () => {
    const db = openIndexDatabase(tmpDbPath("inc-fts-full"));
    try {
      upsertEntry(db, "k1", "/d", "/d/k1.md", "/stash", makeEntry("alpha"), "alpha");
      expect(dirtyCount(db)).toBe(1);
      rebuildFts(db, { incremental: false });
      expect(ftsCount(db)).toBe(1);
      expect(dirtyCount(db)).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  test("deleteEntriesByDir purges FTS rows + dirty markers immediately", () => {
    const db = openIndexDatabase(tmpDbPath("inc-fts-del"));
    try {
      upsertEntry(db, "k1", "/d", "/d/k1.md", "/stash", makeEntry("alpha"), "alpha");
      upsertEntry(db, "k2", "/d", "/d/k2.md", "/stash", makeEntry("bravo"), "bravo");
      rebuildFts(db, { incremental: false });
      expect(ftsCount(db)).toBe(2);

      upsertEntry(db, "k1", "/d", "/d/k1.md", "/stash", makeEntry("alpha", "updated"), "alpha updated");
      expect(dirtyCount(db)).toBe(1);

      deleteEntriesByDir(db, "/d");
      expect(ftsCount(db)).toBe(0);
      expect(dirtyCount(db)).toBe(0);

      rebuildFts(db, { incremental: true });
      expect(ftsCount(db)).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });
});

// ── collectTagSetFromEntries (WS5: lessons-coverage SQL moved out of cli.ts) ──
//
// Characterization test pinning the exact query results of the tag-collection
// read that powers `akm lessons coverage`. The SQL + JSON-parse + tag
// normalisation logic was lifted verbatim from cli.ts into indexer/db.ts so
// the `entries` table SQL lives with all its siblings and cli.ts holds zero
// raw SQL. These assertions capture the pre-move behaviour exactly.
describe("collectTagSetFromEntries", () => {
  function seedTagged(db: Database, key: string, type: StashEntry["type"], tags: unknown): number {
    const entry = { description: `Description for ${key}`, type, tags } as unknown as StashEntry;
    return upsertEntry(db, key, "/test/dir", `/test/dir/${key}.md`, "/test/stash", entry, key);
  }

  test("collects the union of all tags across all entries, normalised + deduped", () => {
    const dbPath = tmpDbPath();
    const db = openIndexDatabase(dbPath);
    try {
      seedTagged(db, "skill-a", "skill", ["Deploy", "networking"]);
      seedTagged(db, "memory-b", "memory", ["AUTH", " deploy "]); // dup of deploy after trim/lower
      seedTagged(db, "lesson-c", "lesson", ["deploy"]);

      const all = collectTagSetFromEntries(db, undefined);
      expect([...all].sort()).toEqual(["auth", "deploy", "networking"]);
    } finally {
      closeDatabase(db);
    }
  });

  test("filters by entry_type when a type is provided", () => {
    const dbPath = tmpDbPath();
    const db = openIndexDatabase(dbPath);
    try {
      seedTagged(db, "skill-a", "skill", ["deploy", "networking"]);
      seedTagged(db, "lesson-c", "lesson", ["deploy"]);

      const lessonTags = collectTagSetFromEntries(db, "lesson");
      expect([...lessonTags].sort()).toEqual(["deploy"]);
    } finally {
      closeDatabase(db);
    }
  });

  test("skips entries with missing, non-array, or blank tags and malformed JSON", () => {
    const dbPath = tmpDbPath();
    const db = openIndexDatabase(dbPath);
    try {
      seedTagged(db, "no-tags", "skill", undefined);
      seedTagged(db, "non-array", "skill", "deploy");
      seedTagged(db, "blank", "skill", ["", "   "]);
      seedTagged(db, "good", "skill", ["valid"]);
      // Force malformed entry_json directly so the try/catch path is exercised.
      db.prepare("UPDATE entries SET entry_json = ? WHERE entry_key = ?").run("{not json", "blank");

      const tags = collectTagSetFromEntries(db, undefined);
      expect([...tags].sort()).toEqual(["valid"]);
    } finally {
      closeDatabase(db);
    }
  });

  test("returns an empty set when there are no entries", () => {
    const dbPath = tmpDbPath();
    const db = openIndexDatabase(dbPath);
    try {
      expect(collectTagSetFromEntries(db, undefined).size).toBe(0);
      expect(collectTagSetFromEntries(db, "lesson").size).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });
});

// ── entries-by-path reads (WS5: command-code `entries` SQL moved into db.ts) ──
//
// Characterization tests pinning the exact query results of the three raw
// `entries` reads lifted verbatim out of command code (commands/search.ts,
// commands/feedback-cli.ts, commands/graph.ts) into indexer/db.ts so all SQL
// touching the `entries` table lives in one module. These assertions capture
// the pre-move behaviour exactly.
describe("entries-by-path reads (getEntryIdByFilePath / getEntryFilePathById / getEntryRefRowsForStashRoot)", () => {
  function seedAt(db: Database, key: string, filePath: string, stashDir: string, type: StashEntry["type"]): number {
    const entry = { description: `Description for ${key}`, type, name: key } as unknown as StashEntry;
    return upsertEntry(db, key, path.dirname(filePath), filePath, stashDir, entry, key);
  }

  test("getEntryIdByFilePath resolves the row id by exact file_path, undefined when no match", () => {
    const dbPath = tmpDbPath();
    const db = openIndexDatabase(dbPath);
    try {
      const id = seedAt(db, "skill-a", "/s/skill-a.md", "/s", "skill");
      expect(getEntryIdByFilePath(db, "/s/skill-a.md")).toBe(id);
      // Exact match only — a prefix or suffix must NOT resolve.
      expect(getEntryIdByFilePath(db, "/s/skill-a")).toBeUndefined();
      expect(getEntryIdByFilePath(db, "/s/skill-a.md.bak")).toBeUndefined();
      expect(getEntryIdByFilePath(db, "/nope.md")).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });

  test("getEntryFilePathById returns the file_path by id, undefined when no match", () => {
    const dbPath = tmpDbPath();
    const db = openIndexDatabase(dbPath);
    try {
      const id = seedAt(db, "lesson-x", "/s/lesson-x.md", "/s", "lesson");
      expect(getEntryFilePathById(db, id)).toBe("/s/lesson-x.md");
      expect(getEntryFilePathById(db, id + 9999)).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });

  test("getEntryFilePathById still returns the path when entry_json is corrupt (no JSON parse)", () => {
    const dbPath = tmpDbPath();
    const db = openIndexDatabase(dbPath);
    try {
      const id = seedAt(db, "broken", "/s/broken.md", "/s", "skill");
      db.prepare("UPDATE entries SET entry_json = ? WHERE id = ?").run("{not json", id);
      expect(getEntryFilePathById(db, id)).toBe("/s/broken.md");
      // getEntryById, by contrast, drops the corrupt row — proving the new
      // helper deliberately avoids JSON parsing to preserve feedback-cli's
      // pre-extraction behaviour.
      expect(getEntryById(db, id)).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });

  test("getEntryRefRowsForStashRoot matches by stash_dir OR file_path prefix; dedupe stays with caller", () => {
    const dbPath = tmpDbPath();
    const db = openIndexDatabase(dbPath);
    try {
      // Matches by exact stash_dir.
      seedAt(db, "in-stash", "/elsewhere/in-stash.md", "/root", "skill");
      // Matches by file_path prefix even though stash_dir differs.
      seedAt(db, "by-prefix", "/root/sub/by-prefix.md", "/other", "memory");
      // Should NOT match: different stash_dir and a non-prefix path.
      seedAt(db, "outside", "/somewhere/outside.md", "/other", "lesson");

      const rows = getEntryRefRowsForStashRoot(db, "/root");
      const paths = rows.map((r) => r.file_path).sort();
      expect(paths).toEqual(["/elsewhere/in-stash.md", "/root/sub/by-prefix.md"]);
      // entry_json is returned raw (unparsed) for the caller to decode.
      for (const r of rows) {
        expect(typeof r.entry_json).toBe("string");
        expect(() => JSON.parse(r.entry_json)).not.toThrow();
      }
    } finally {
      closeDatabase(db);
    }
  });

  test("ref rows survive db.close() — result set fully materialised (WS5 lifetime rule)", () => {
    const dbPath = tmpDbPath();
    const db = openIndexDatabase(dbPath);
    seedAt(db, "a", "/root/a.md", "/root", "skill");
    seedAt(db, "b", "/root/b.md", "/root", "memory");
    const rows = getEntryRefRowsForStashRoot(db, "/root");
    closeDatabase(db);
    // Iterating after close must not throw / truncate — proves no live cursor.
    expect(rows.map((r) => r.file_path).sort()).toEqual(["/root/a.md", "/root/b.md"]);
  });
});

// ── registry_index_cache helpers ────────────────────────────────────────────
// Characterization tests pinning the raw upsert/get behaviour that moved from
// db.ts into storage/repositories/registry-index-cache-repository.ts. Exercised
// here via the db.ts re-export surface (the public compatibility seam).

describe("registry_index_cache helpers", () => {
  const URL = "https://registry.example.com/index";

  test("getRegistryIndexCache returns undefined for a missing row", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      expect(getRegistryIndexCache(db, URL)).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });

  test("upsert then get round-trips index_json and validators", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      upsertRegistryIndexCache(db, URL, '{"ok":true}', { etag: 'W/"abc"', lastModified: "Mon, 01 Jan 2024" });
      const row = getRegistryIndexCache(db, URL);
      expect(row).toEqual({ indexJson: '{"ok":true}', etag: 'W/"abc"', lastModified: "Mon, 01 Jan 2024" });
    } finally {
      closeDatabase(db);
    }
  });

  test("upsert with no opts stores null validators", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      upsertRegistryIndexCache(db, URL, "[]");
      const row = getRegistryIndexCache(db, URL);
      expect(row).toEqual({ indexJson: "[]", etag: null, lastModified: null });
    } finally {
      closeDatabase(db);
    }
  });

  test("upsert on conflict overwrites the existing row (single row per registry_url)", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      upsertRegistryIndexCache(db, URL, '{"v":1}', { etag: "one" });
      upsertRegistryIndexCache(db, URL, '{"v":2}', { etag: "two" });
      const row = getRegistryIndexCache(db, URL);
      expect(row?.indexJson).toBe('{"v":2}');
      expect(row?.etag).toBe("two");
      const count = (db.prepare("SELECT COUNT(*) AS n FROM registry_index_cache").get() as { n: number }).n;
      expect(count).toBe(1);
    } finally {
      closeDatabase(db);
    }
  });

  test("getRegistryIndexCache treats an entry older than maxAgeMs as a miss (TTL)", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      upsertRegistryIndexCache(db, URL, '{"ok":true}');
      // Backdate fetched_at well beyond any positive TTL.
      db.prepare("UPDATE registry_index_cache SET fetched_at = ? WHERE registry_url = ?").run(
        new Date(Date.now() - 10_000).toISOString(),
        URL,
      );
      expect(getRegistryIndexCache(db, URL, 1_000)).toBeUndefined();
      // A generous TTL still returns the row.
      expect(getRegistryIndexCache(db, URL, 60_000)).toBeDefined();
    } finally {
      closeDatabase(db);
    }
  });

  test("getRegistryIndexCache treats an unparseable fetched_at as a miss", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      upsertRegistryIndexCache(db, URL, '{"ok":true}');
      db.prepare("UPDATE registry_index_cache SET fetched_at = ? WHERE registry_url = ?").run("not-a-date", URL);
      expect(getRegistryIndexCache(db, URL)).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });
});
