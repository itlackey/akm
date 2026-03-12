import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  closeDatabase,
  DB_VERSION,
  deleteEntriesByDir,
  getAllEntries,
  getEntriesByDir,
  getEntryById,
  getEntryCount,
  getMeta,
  isVecAvailable,
  openDatabase,
  rebuildFts,
  searchFts,
  searchVec,
  setMeta,
  upsertEmbedding,
  upsertEntry,
} from "../src/db";
import type { StashEntry } from "../src/metadata";

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

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv.XDG_CACHE_HOME = process.env.XDG_CACHE_HOME;
  savedEnv.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CACHE_HOME = tmpDir("cache");
  process.env.XDG_CONFIG_HOME = tmpDir("config");
});

afterEach(() => {
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
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
  test("openDatabase creates schema with correct version", () => {
    const dbPath = tmpDbPath();
    const db = openDatabase(dbPath);
    try {
      expect(getMeta(db, "version")).toBe(String(DB_VERSION));
    } finally {
      closeDatabase(db);
    }
  });

  test("openDatabase with mismatched version drops and recreates tables", () => {
    const dbPath = tmpDbPath();

    // Open and insert some data, then tamper with the version
    let db = openDatabase(dbPath);
    insertTestEntry(db, "old-entry");
    expect(getEntryCount(db)).toBe(1);
    setMeta(db, "version", "0");
    closeDatabase(db);

    // Reopen — should detect mismatch, drop tables, recreate
    db = openDatabase(dbPath);
    try {
      expect(getMeta(db, "version")).toBe(String(DB_VERSION));
      expect(getEntryCount(db)).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  test("openDatabase creates FTS5 table", () => {
    const dbPath = tmpDbPath();
    const db = openDatabase(dbPath);
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
    const db = openDatabase(dbPath);
    try {
      expect(isVecAvailable(db)).toBe(true);
    } finally {
      closeDatabase(db);
    }
  });

  test("embeddingDim is stored and triggers vec table recreation", () => {
    const dbPath = tmpDbPath();

    let db = openDatabase(dbPath, { embeddingDim: 512 });
    try {
      if (isVecAvailable(db)) {
        expect(getMeta(db, "embeddingDim")).toBe("512");
      }
    } finally {
      closeDatabase(db);
    }

    // Reopen with a different dimension
    db = openDatabase(dbPath, { embeddingDim: 768 });
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
    const db = openDatabase(tmpDbPath());
    try {
      const id = insertTestEntry(db, "my-tool");
      expect(id).toBeGreaterThan(0);
      expect(getEntryCount(db)).toBe(1);
    } finally {
      closeDatabase(db);
    }
  });

  test("upsertEntry updates on conflict (same entry_key)", () => {
    const db = openDatabase(tmpDbPath());
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
    const db = openDatabase(tmpDbPath());
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
    const db = openDatabase(tmpDbPath());
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
    const db = openDatabase(tmpDbPath());
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
    const db = openDatabase(tmpDbPath());
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
    const db = openDatabase(tmpDbPath());
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
});

// ── Section 1.3: FTS search ────────────────────────────────────────────────

describe("FTS search", () => {
  test("searchFts returns results ranked by BM25", () => {
    const db = openDatabase(tmpDbPath());
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
    const db = openDatabase(tmpDbPath());
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
    const db = openDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "hello-tool", {
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
    const db = openDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "some-tool", { searchText: "some useful tool" });
      rebuildFts(db);

      const results = searchFts(db, "!@#$%", 10);
      expect(results).toEqual([]);
    } finally {
      closeDatabase(db);
    }
  });

  test("rebuildFts synchronizes FTS with entries table", () => {
    const db = openDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "alpha", { searchText: "alpha functionality" });
      insertTestEntry(db, "beta", { searchText: "beta functionality" });
      insertTestEntry(db, "gamma", { searchText: "gamma functionality" });

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
    const db = openDatabase(tmpDbPath());
    try {
      const val = getMeta(db, "nonexistent-key");
      expect(val).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });

  test("setMeta and getMeta round-trip", () => {
    const db = openDatabase(tmpDbPath());
    try {
      setMeta(db, "test-key", "test-value");
      expect(getMeta(db, "test-key")).toBe("test-value");
    } finally {
      closeDatabase(db);
    }
  });

  test("setMeta overwrites existing key", () => {
    const db = openDatabase(tmpDbPath());
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
  test("openDatabase creates vec table when extension available", () => {
    const dbPath = tmpDbPath();
    const db = openDatabase(dbPath);
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
    const db = openDatabase(dbPath, { embeddingDim: 4 });
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
    const db = openDatabase(dbPath, { embeddingDim: 4 });
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
    const db = openDatabase(dbPath, { embeddingDim: 4 });
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
    const db = openDatabase(dbPath, { embeddingDim: 4 });
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
    let db = openDatabase(dbPath, { embeddingDim: 4 });
    const id = insertTestEntry(db, "dim-change", { searchText: "dimension test" });
    upsertEmbedding(db, id, [1, 0, 0, 0]);
    let results = searchVec(db, [1, 0, 0, 0], 10);
    expect(results.length).toBe(1);
    closeDatabase(db);

    // Reopen with dim=8 — vec table should be recreated, old embeddings gone
    db = openDatabase(dbPath, { embeddingDim: 8 });
    try {
      expect(getMeta(db, "embeddingDim")).toBe("8");
      // Old embedding was dim=4 and table was recreated for dim=8, so no results
      results = searchVec(db, [1, 0, 0, 0, 0, 0, 0, 0], 10);
      expect(results.length).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });
});
