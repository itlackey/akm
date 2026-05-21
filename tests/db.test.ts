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
  getDerivedForParent,
  getEntriesByDir,
  getEntryById,
  getEntryCount,
  getMeta,
  getPositiveFeedbackCountsByIds,
  isVecAvailable,
  openDatabase,
  openExistingDatabase,
  rebuildFts,
  searchFts,
  searchVec,
  setMeta,
  upsertEmbedding,
  upsertEntry,
} from "../src/indexer/db";
import type { StashEntry } from "../src/indexer/metadata";
import { insertUsageEvent } from "../src/indexer/usage-events";

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
  savedEnv.XDG_DATA_HOME = process.env.XDG_DATA_HOME;
  savedEnv.XDG_STATE_HOME = process.env.XDG_STATE_HOME;
  process.env.XDG_CACHE_HOME = tmpDir("cache");
  process.env.XDG_CONFIG_HOME = tmpDir("config");
  process.env.XDG_DATA_HOME = tmpDir("data");
  process.env.XDG_STATE_HOME = tmpDir("state");
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

  test("openDatabase writes a data-dir backup BEFORE the destructive version upgrade", () => {
    // Seed a data dir at an older version with a known entry, then reopen
    // with the current binary and verify a backup directory was created
    // under <dataDir>/backups/ that still contains the pre-upgrade DB.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-backup-trigger-"));
    createdTmpDirs.push(dataDir);
    const dbPath = path.join(dataDir, "index.db");

    let db = openDatabase(dbPath);
    insertTestEntry(db, "pre-upgrade-entry");
    expect(getEntryCount(db)).toBe(1);
    setMeta(db, "version", "0");
    closeDatabase(db);

    // Reopen — must trigger the upgrade path AND the backup hook.
    db = openDatabase(dbPath);
    try {
      // Post-upgrade the entry is gone (existing behavior).
      expect(getEntryCount(db)).toBe(0);
      expect(getMeta(db, "version")).toBe(String(DB_VERSION));
    } finally {
      closeDatabase(db);
    }

    // A backup directory should exist with the pre-upgrade index.db inside.
    const backupsRoot = path.join(dataDir, "backups");
    expect(fs.existsSync(backupsRoot)).toBe(true);
    const snapshots = fs
      .readdirSync(backupsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    expect(snapshots[0]).toContain(`pre-v${DB_VERSION}`);

    const snapshotDir = path.join(backupsRoot, snapshots[0] as string);
    expect(fs.existsSync(path.join(snapshotDir, "index.db"))).toBe(true);
    expect(fs.existsSync(path.join(snapshotDir, "backup.meta.json"))).toBe(true);

    // Open the snapshot DB read-only and confirm it still carries the
    // pre-upgrade row — proving the backup was taken BEFORE the drop.
    const { Database: SqliteDB } = require("bun:sqlite") as typeof import("bun:sqlite");
    const snapshotDb = new SqliteDB(path.join(snapshotDir, "index.db"), { readonly: true });
    try {
      const row = snapshotDb
        .prepare("SELECT COUNT(*) AS cnt FROM entries WHERE entry_key = 'pre-upgrade-entry'")
        .get() as { cnt: number };
      expect(row.cnt).toBe(1);
    } finally {
      snapshotDb.close();
    }
  });

  test("AKM_DB_BACKUP=0 skips the pre-upgrade snapshot", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-backup-optout-"));
    createdTmpDirs.push(dataDir);
    const dbPath = path.join(dataDir, "index.db");

    let db = openDatabase(dbPath);
    insertTestEntry(db, "pre-upgrade-entry");
    setMeta(db, "version", "0");
    closeDatabase(db);

    const previous = process.env.AKM_DB_BACKUP;
    process.env.AKM_DB_BACKUP = "0";
    try {
      db = openDatabase(dbPath);
      closeDatabase(db);
    } finally {
      if (previous === undefined) {
        delete process.env.AKM_DB_BACKUP;
      } else {
        process.env.AKM_DB_BACKUP = previous;
      }
    }

    const backupsRoot = path.join(dataDir, "backups");
    if (fs.existsSync(backupsRoot)) {
      const snapshots = fs.readdirSync(backupsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
      expect(snapshots.length).toBe(0);
    }
  });

  test("embedding-dim change backs up the data dir BEFORE wiping embeddings", () => {
    // Open with one dimension, write a known embeddings row, then reopen with
    // a different dimension and verify a backup directory tagged
    // `embedding-dim-change` was created with the OLD embeddings row still
    // inside — proof the backup ran BEFORE the destructive DELETE/DROP.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-embdim-trigger-"));
    createdTmpDirs.push(dataDir);
    const dbPath = path.join(dataDir, "index.db");

    let db = openDatabase(dbPath, { embeddingDim: 4 });
    const id = insertTestEntry(db, "embdim-entry", { searchText: "embdim test" });
    upsertEmbedding(db, id, [1, 0, 0, 0]);
    // Confirm the embedding is materialized before the dim change.
    const preCount = db.prepare("SELECT COUNT(*) AS cnt FROM embeddings").get() as { cnt: number };
    expect(preCount.cnt).toBe(1);
    closeDatabase(db);

    db = openDatabase(dbPath, { embeddingDim: 8 });
    try {
      expect(getMeta(db, "embeddingDim")).toBe("8");
      // Post-dim-change the embeddings table has been wiped.
      const postCount = db.prepare("SELECT COUNT(*) AS cnt FROM embeddings").get() as { cnt: number };
      expect(postCount.cnt).toBe(0);
    } finally {
      closeDatabase(db);
    }

    // A backup tagged `embedding-dim-change` should exist.
    const backupsRoot = path.join(dataDir, "backups");
    expect(fs.existsSync(backupsRoot)).toBe(true);
    const snapshots = fs
      .readdirSync(backupsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(snapshots.length).toBe(1);
    expect(snapshots[0]).toContain("embedding-dim-change");
    expect(snapshots[0]).not.toContain("pre-v");

    const snapshotDir = path.join(backupsRoot, snapshots[0] as string);
    expect(fs.existsSync(path.join(snapshotDir, "index.db"))).toBe(true);

    // backup.meta.json should carry the `embedding-dim-change` reason.
    const metaPath = path.join(snapshotDir, "backup.meta.json");
    expect(fs.existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    expect(meta.reason).toBe("embedding-dim-change");

    // The snapshot DB must STILL contain the pre-change embedding row.
    const { Database: SqliteDB } = require("bun:sqlite") as typeof import("bun:sqlite");
    const snapshotDb = new SqliteDB(path.join(snapshotDir, "index.db"), { readonly: true });
    try {
      const row = snapshotDb.prepare("SELECT COUNT(*) AS cnt FROM embeddings").get() as { cnt: number };
      expect(row.cnt).toBe(1);
    } finally {
      snapshotDb.close();
    }
  });

  test("AKM_DB_BACKUP=0 skips the embedding-dim-change snapshot but still wipes embeddings", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-embdim-optout-"));
    createdTmpDirs.push(dataDir);
    const dbPath = path.join(dataDir, "index.db");

    let db = openDatabase(dbPath, { embeddingDim: 4 });
    const id = insertTestEntry(db, "embdim-optout", { searchText: "optout" });
    upsertEmbedding(db, id, [1, 0, 0, 0]);
    closeDatabase(db);

    const previous = process.env.AKM_DB_BACKUP;
    process.env.AKM_DB_BACKUP = "0";
    try {
      db = openDatabase(dbPath, { embeddingDim: 8 });
      try {
        expect(getMeta(db, "embeddingDim")).toBe("8");
        // Destructive op still runs even when backup is opted out.
        const postCount = db.prepare("SELECT COUNT(*) AS cnt FROM embeddings").get() as { cnt: number };
        expect(postCount.cnt).toBe(0);
      } finally {
        closeDatabase(db);
      }
    } finally {
      if (previous === undefined) {
        delete process.env.AKM_DB_BACKUP;
      } else {
        process.env.AKM_DB_BACKUP = previous;
      }
    }

    // No snapshot directories should have been created.
    const backupsRoot = path.join(dataDir, "backups");
    if (fs.existsSync(backupsRoot)) {
      const snapshots = fs.readdirSync(backupsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
      expect(snapshots.length).toBe(0);
    }
  });

  test("no backup is taken when the embedding dim is unchanged across opens", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-embdim-noop-"));
    createdTmpDirs.push(dataDir);
    const dbPath = path.join(dataDir, "index.db");

    let db = openDatabase(dbPath, { embeddingDim: 4 });
    insertTestEntry(db, "embdim-noop");
    closeDatabase(db);

    // Reopen with the SAME dimension — no backup should be created.
    db = openDatabase(dbPath, { embeddingDim: 4 });
    closeDatabase(db);

    const backupsRoot = path.join(dataDir, "backups");
    if (fs.existsSync(backupsRoot)) {
      const snapshots = fs.readdirSync(backupsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
      expect(snapshots.length).toBe(0);
    }
  });

  test("openDatabase() without embeddingDim does NOT overwrite a previously set dim", () => {
    // Regression: registry-side and other dim-unaware callers
    // (static-index.ts:174, skills-sh.ts:125, graph.ts:550/591) call
    // `openDatabase()` with no `embeddingDim`. Before the no-clobber fix
    // this silently wrote `embeddingDim = "384"` (the EMBEDDING_DIM default)
    // into `index_meta`, racing dim-aware callers and triggering repeat
    // backup/wipe cycles. The contract is now: a caller that does not
    // request a specific dim must not touch `index_meta.embeddingDim`.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-embdim-noclobber-"));
    createdTmpDirs.push(dataDir);
    const dbPath = path.join(dataDir, "index.db");

    // Establish dim=768 via a dim-aware open.
    let db = openDatabase(dbPath, { embeddingDim: 768 });
    insertTestEntry(db, "noclobber-entry");
    if (isVecAvailable(db)) {
      expect(getMeta(db, "embeddingDim")).toBe("768");
    }
    closeDatabase(db);

    // A dim-unaware open MUST leave the stored dim alone.
    db = openDatabase(dbPath);
    try {
      expect(getMeta(db, "embeddingDim")).toBe("768");
    } finally {
      closeDatabase(db);
    }

    // And it MUST NOT have produced a backup snapshot (no dim change → no wipe).
    const backupsRoot = path.join(dataDir, "backups");
    if (fs.existsSync(backupsRoot)) {
      const snapshots = fs
        .readdirSync(backupsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      expect(snapshots.some((n) => n.includes("embedding-dim-change"))).toBe(false);
    }
  });

  test("embedding-dim-change backup directory name is distinct from version-upgrade", () => {
    // Seed two backups under the same data dir — one from a version upgrade,
    // one from an embedding-dim change — and verify their directory names
    // carry the different suffixes so operators can tell them apart.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-embdim-tag-"));
    createdTmpDirs.push(dataDir);
    const dbPath = path.join(dataDir, "index.db");

    // Version-upgrade backup.
    let db = openDatabase(dbPath, { embeddingDim: 4 });
    insertTestEntry(db, "version-row");
    setMeta(db, "version", "0");
    closeDatabase(db);
    db = openDatabase(dbPath, { embeddingDim: 4 });
    closeDatabase(db);

    // Embedding-dim-change backup.
    db = openDatabase(dbPath, { embeddingDim: 8 });
    closeDatabase(db);

    const backupsRoot = path.join(dataDir, "backups");
    const snapshots = fs
      .readdirSync(backupsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(snapshots.some((n) => n.includes(`pre-v${DB_VERSION}`))).toBe(true);
    expect(snapshots.some((n) => n.includes("embedding-dim-change"))).toBe(true);
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

  // ── T5: sanitizeFtsQuery edge cases ──────────────────────────────────────
  // sanitizeFtsQuery is private, so we test it indirectly through searchFts.

  test("query that becomes empty after sanitization returns no results", () => {
    const db = openDatabase(tmpDbPath());
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
    const db = openDatabase(tmpDbPath());
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
    const db = openDatabase(tmpDbPath());
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
    const db = openDatabase(tmpDbPath());
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
    const db = openDatabase(tmpDbPath());
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

  test("openExistingDatabase preserves existing embedding dimension and embeddings", () => {
    const dbPath = tmpDbPath();

    let db = openDatabase(dbPath, { embeddingDim: 4 });
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
    const db = openDatabase(tmpDbPath("inc-fts"));
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
    const db = openDatabase(tmpDbPath("inc-fts-empty"));
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
    const db = openDatabase(tmpDbPath("inc-fts-full"));
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
    const db = openDatabase(tmpDbPath("inc-fts-del"));
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

// ── Phase 5A / DB v17: derived_from index ──────────────────────────────────

describe("derived_from column (Phase 5A)", () => {
  test("DB_VERSION is at least 17 — derived_from column shipped at v17", () => {
    expect(DB_VERSION).toBeGreaterThanOrEqual(17);
  });

  test("entries table has a derived_from column on a freshly opened DB", () => {
    const db = openDatabase(tmpDbPath());
    try {
      const cols = (db.prepare("PRAGMA table_info(entries)").all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain("derived_from");
    } finally {
      closeDatabase(db);
    }
  });

  test("idx_entries_derived_from index is created", () => {
    const db = openDatabase(tmpDbPath());
    try {
      const idx = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_entries_derived_from'")
        .get() as { name: string } | undefined;
      expect(idx?.name).toBe("idx_entries_derived_from");
    } finally {
      closeDatabase(db);
    }
  });

  test("upsertEntry writes derived_from when entry carries derivedFrom", () => {
    const db = openDatabase(tmpDbPath());
    try {
      const child: StashEntry = {
        name: "parent.derived",
        type: "memory",
        description: "Distilled child.",
        derivedFrom: "memory:parent",
      };
      upsertEntry(db, "k:memory:parent.derived", "/d", "/d/child.md", "/stash", child, "search text");

      const row = db.prepare("SELECT derived_from FROM entries WHERE entry_key = ?").get("k:memory:parent.derived") as
        | { derived_from: string | null }
        | undefined;
      expect(row?.derived_from).toBe("memory:parent");
    } finally {
      closeDatabase(db);
    }
  });

  test("getDerivedForParent returns the derived row keyed by parent ref", () => {
    const db = openDatabase(tmpDbPath());
    try {
      const parent: StashEntry = { name: "alpha", type: "memory", description: "Parent." };
      const child: StashEntry = {
        name: "alpha.derived",
        type: "memory",
        description: "Distilled alpha.",
        derivedFrom: "memory:alpha",
      };
      upsertEntry(db, "k:memory:alpha", "/d", "/d/alpha.md", "/stash", parent, "alpha");
      upsertEntry(db, "k:memory:alpha.derived", "/d", "/d/alpha.derived.md", "/stash", child, "alpha derived");

      const found = getDerivedForParent(db, "memory:alpha");
      expect(found).not.toBeNull();
      expect(found?.entry.name).toBe("alpha.derived");
      expect(found?.entry.derivedFrom).toBe("memory:alpha");

      // No derived child for "beta": returns null.
      expect(getDerivedForParent(db, "memory:beta")).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });
});

// ── Phase 2A: positive feedback counts ─────────────────────────────────────

describe("getPositiveFeedbackCountsByIds (Phase 2A)", () => {
  test("returns counts of positive feedback events grouped by entry id", () => {
    const db = openDatabase(tmpDbPath());
    try {
      const id1 = insertTestEntry(db, "asset-1");
      const id2 = insertTestEntry(db, "asset-2");

      // 3× positive feedback for id1, 0 for id2.
      for (let i = 0; i < 3; i++) {
        insertUsageEvent(db, { event_type: "feedback", signal: "positive", entry_id: id1, entry_ref: "ref:1" });
      }
      // A negative feedback event must NOT count toward the positive total.
      insertUsageEvent(db, { event_type: "feedback", signal: "negative", entry_id: id1, entry_ref: "ref:1" });
      // A "show" event must NOT count toward feedback counts.
      insertUsageEvent(db, { event_type: "show", entry_id: id1, entry_ref: "ref:1" });

      const counts = getPositiveFeedbackCountsByIds(db, [id1, id2]);
      expect(counts.get(id1)).toBe(3);
      // id2 has no positive feedback at all → absent from the map.
      expect(counts.has(id2)).toBe(false);
    } finally {
      closeDatabase(db);
    }
  });

  test("returns empty map for empty id list (no SQL issued)", () => {
    const db = openDatabase(tmpDbPath());
    try {
      const counts = getPositiveFeedbackCountsByIds(db, []);
      expect(counts.size).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  test("chunks at 500 ids — exercises the SQLITE_CHUNK_SIZE path without crashing", () => {
    const db = openDatabase(tmpDbPath());
    try {
      const targetIds: number[] = [];
      // Seed two entries with positive feedback so we can assert non-empty
      // results across a >500-id query.
      const id1 = insertTestEntry(db, "chunked-1");
      const id2 = insertTestEntry(db, "chunked-2");
      insertUsageEvent(db, { event_type: "feedback", signal: "positive", entry_id: id1 });
      insertUsageEvent(db, { event_type: "feedback", signal: "positive", entry_id: id1 });
      insertUsageEvent(db, { event_type: "feedback", signal: "positive", entry_id: id2 });

      // Pad to 700 ids — must split into 500 + 200 chunks.
      for (let i = 0; i < 700; i++) targetIds.push(100_000 + i);
      // Include the real ids near both chunk boundaries.
      targetIds[0] = id1;
      targetIds[600] = id2;

      const counts = getPositiveFeedbackCountsByIds(db, targetIds);
      expect(counts.get(id1)).toBe(2);
      expect(counts.get(id2)).toBe(1);
    } finally {
      closeDatabase(db);
    }
  });
});
