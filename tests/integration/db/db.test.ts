import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError } from "../../../src/core/errors";
import { openStateDatabase } from "../../../src/core/state-db";
import { _setWarnSinkForTests } from "../../../src/core/warn";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import type { IndexDocument } from "../../../src/indexer/passes/metadata";
import type { Database } from "../../../src/storage/database";
import {
  closeDatabase,
  openExistingDatabase,
  openIndexDatabase,
} from "../../../src/storage/repositories/index-connection";
import {
  deleteEntriesByDirAndBundle,
  deleteUsageEventsByEntryIds,
  findEntryIdByRef,
  getAllEntries,
  getEmbeddableEntryCount,
  getEntriesByDir,
  getEntryById,
  getEntryCount,
  getEntryFilePathById,
  getEntryIdByFilePath,
  upsertEntry,
} from "../../../src/storage/repositories/index-entries-repository";
import { getMeta, setMeta } from "../../../src/storage/repositories/index-meta-repository";
import { DB_VERSION, EMBEDDING_DIM } from "../../../src/storage/repositories/index-schema";
import {
  isVecAvailable,
  isVecFastPathComplete,
  isVecFastPathReady,
  searchVec,
  setVecFastPathReady,
  upsertEmbedding,
} from "../../../src/storage/repositories/index-vec-repository";
import {
  getRegistryIndexCache,
  upsertRegistryIndexCache,
} from "../../../src/storage/repositories/registry-index-cache-repository";
import {
  type Cleanup,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  withIsolatedAkmStorage,
} from "../../_helpers/sandbox";

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

function makeEntry(overrides: Partial<IndexDocument> & { name: string; type: IndexDocument["type"] }): IndexDocument {
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
    description?: string;
    searchText?: string;
    type?: IndexDocument["type"];
  },
): number {
  const type = opts?.type ?? "script";
  const entry = makeEntry({ name: key, type, description: opts?.description ?? `Description for ${key}` });
  const provenance = deriveEntryProvenance(
    { bundleId: "test-bundle", componentId: "test-bundle", adapterId: "akm" },
    type,
    key,
  );
  const dirPath = opts?.dirPath ?? "/test/dir";
  return upsertEntry(
    db,
    opts?.filePath ?? path.join(dirPath, `${key}.ts`),
    entry,
    opts?.searchText ?? `${key} ${entry.description}`,
    provenance,
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

  test("openIndexDatabase removes the obsolete workflow document cache", () => {
    const dbPath = tmpDbPath();
    let db = openIndexDatabase(dbPath);
    db.exec("CREATE TABLE workflow_documents (entry_id INTEGER PRIMARY KEY, document_json TEXT NOT NULL)");
    closeDatabase(db);

    db = openIndexDatabase(dbPath);
    try {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_documents'")
        .get();
      expect(row).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });

  test("openIndexDatabase with a stale version marker rebuilds the derived index generation", () => {
    const dbPath = tmpDbPath();

    // Open, insert data, stamp an OLDER version than DB_VERSION.
    let db = openIndexDatabase(dbPath);
    insertTestEntry(db, "old-entry");
    expect(getEntryCount(db)).toBe(1);
    setMeta(db, "version", "0");
    closeDatabase(db);

    // Reopen — index.db is regenerable, so an incompatible generation is
    // discarded instead of carrying live compatibility SQL.
    db = openIndexDatabase(dbPath);
    try {
      expect(getEntryCount(db)).toBe(0);
      expect(getMeta(db, "version")).toBe(String(DB_VERSION));
    } finally {
      closeDatabase(db);
    }
  });

  test("openIndexDatabase creates the units_fts FTS5 table", () => {
    const dbPath = tmpDbPath();
    const db = openIndexDatabase(dbPath);
    try {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE name = 'units_fts'").get() as
        | { name: string }
        | undefined;
      expect(row).toBeDefined();
      expect(row?.name).toBe("units_fts");
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

  test("upsertEntry updates on conflict (same item_ref)", () => {
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
      expect(entries[0]!.entry.description).toBe("updated description");
    } finally {
      closeDatabase(db);
    }
  });

  test("upsertEntry dedupes on the UNIQUE item_ref (the clean conflict key)", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      const type = "script";
      const name = "my-tool";
      const prov = deriveEntryProvenance({ bundleId: "team-kb", componentId: "team-kb", adapterId: "akm" }, type, name);
      const entry = makeEntry({ name, type, description: "original" });
      upsertEntry(db, "/s/dir/my-tool.ts", entry, "my-tool original", prov);
      // Re-upsert the SAME item_ref (same identity) with an updated payload.
      const entry2 = makeEntry({ name, type, description: "updated" });
      upsertEntry(db, "/s/dir/my-tool.ts", entry2, "my-tool updated", prov);
      expect(getEntryCount(db)).toBe(1);
      const rows = db.prepare("SELECT item_ref, document_json FROM entries").all() as Array<{
        item_ref: string;
        document_json: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.item_ref).toBe("team-kb//scripts/my-tool");
      expect(JSON.parse(rows[0]?.document_json ?? "{}").description).toBe("updated");
    } finally {
      closeDatabase(db);
    }
  });

  test("a short ref matching one conceptId across two bundles resolves deterministically (primary/lowest-id wins)", () => {
    // Two sources carry the SAME conceptId (`scripts/my-tool`) under different
    // bundle slugs → two `//scripts/my-tool`-suffixed item_refs. The short-ref
    // suffix match must pick a STABLE winner, not whichever row SQLite visits
    // first. The primary/highest-precedence source is indexed first (lowest id),
    // so `ORDER BY id ASC` deterministically returns it.
    const db = openIndexDatabase(tmpDbPath());
    try {
      const type = "script";
      const name = "my-tool";
      // Insert the primary bundle FIRST (it gets the lower id, mirroring a
      // precedence-ordered index walk).
      const primaryProv = deriveEntryProvenance(
        { bundleId: "primary-kb", componentId: "primary-kb", adapterId: "akm" },
        type,
        name,
      );
      const primaryId = upsertEntry(
        db,
        "/p/dir/my-tool.ts",
        makeEntry({ name, type, description: "primary" }),
        "my-tool primary",
        primaryProv,
      );
      const secondaryProv = deriveEntryProvenance(
        { bundleId: "zzz-source", componentId: "zzz-source", adapterId: "akm" },
        type,
        name,
      );
      const secondaryId = upsertEntry(
        db,
        "/z/dir/my-tool.ts",
        makeEntry({ name, type, description: "secondary" }),
        "my-tool secondary",
        secondaryProv,
      );
      expect(getEntryCount(db)).toBe(2);
      expect(primaryId).toBeLessThan(secondaryId);

      // Short ref → lowest-id (primary) row, and the same answer every call.
      expect(findEntryIdByRef(db, "scripts/my-tool")).toBe(primaryId);
      expect(findEntryIdByRef(db, "scripts/my-tool")).toBe(primaryId);
      // Bundle-qualified refs still address each row exactly.
      expect(findEntryIdByRef(db, "primary-kb//scripts/my-tool")).toBe(primaryId);
      expect(findEntryIdByRef(db, "zzz-source//scripts/my-tool")).toBe(secondaryId);
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
      const keys = alphaEntries.map((e) => e.entry.name).sort();
      expect(keys).toEqual(["tool-a", "tool-b"]);

      const betaEntries = getEntriesByDir(db, "/project/beta");
      expect(betaEntries).toHaveLength(1);
      expect(betaEntries[0]!.entry.name).toBe("tool-c");
    } finally {
      closeDatabase(db);
    }
  });

  // #900: `getEntriesByDir` is backed by an indexed byte-range scan over
  // `file_path` (idx_entries_file_path) rather than a full-table scan, so it
  // MUST still land on the exact directory and nothing from a sibling whose
  // name merely shares the same prefix, or from a nested subdirectory that
  // sorts inside the same byte range.
  test("getEntriesByDir excludes sibling dirs sharing a prefix and nested subdirectories", () => {
    const db = openIndexDatabase(tmpDbPath());
    try {
      insertTestEntry(db, "x", { filePath: "/a/b/x.md" });
      insertTestEntry(db, "y", { filePath: "/a/bc/y.md" });
      insertTestEntry(db, "z", { filePath: "/a/b/c/z.md" });

      const entries = getEntriesByDir(db, "/a/b");
      expect(entries).toHaveLength(1);
      expect(entries[0]!.filePath).toBe("/a/b/x.md");
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
      expect(skills[0]!.entry.type).toBe("skill");
    } finally {
      closeDatabase(db);
    }
  });

  test("deferred usage cleanup does not escape a rolled-back index transaction", () => {
    const storage = withIsolatedAkmStorage();
    const db = openIndexDatabase(tmpDbPath());
    try {
      const entryId = insertTestEntry(db, "rollback-delete", {
        dirPath: "/handoff",
      });
      const stateDb = openStateDatabase();
      stateDb
        .prepare("INSERT INTO usage_events (event_type, entry_id, entry_ref) VALUES ('show', ?, ?)")
        .run(entryId, "parent//memories/rollback-delete");
      stateDb.close();

      expect(() =>
        db.transaction(() => {
          deleteEntriesByDirAndBundle(db, "/handoff", "test-bundle", { cleanupUsageEvents: false });
          throw new Error("forced persistence failure");
        })(),
      ).toThrow("forced persistence failure");
      expect(getEntryCount(db)).toBe(1);

      const afterRollback = openStateDatabase();
      expect(
        afterRollback.prepare("SELECT COUNT(*) AS count FROM usage_events WHERE entry_id = ?").get(entryId),
      ).toEqual({
        count: 1,
      });
      afterRollback.close();

      const deletedIds = deleteEntriesByDirAndBundle(db, "/handoff", "test-bundle", {
        cleanupUsageEvents: false,
      });
      deleteUsageEventsByEntryIds(deletedIds);
      const afterCommit = openStateDatabase();
      expect(afterCommit.prepare("SELECT COUNT(*) AS count FROM usage_events WHERE entry_id = ?").get(entryId)).toEqual(
        {
          count: 0,
        },
      );
      afterCommit.close();
    } finally {
      closeDatabase(db);
      storage.cleanup();
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
      expect(results[0]!.id).toBe(id1);
      expect(results[0]!.distance).toBeLessThan(results[1]!.distance);
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
      expect(results[0]!.distance).toBeCloseTo(0, 2);

      // Overwrite with a completely different direction
      upsertEmbedding(db, id, [0, 0, 0, 1]);
      results = searchVec(db, [0, 0, 0, 1], 10);
      expect(results.length).toBe(1);
      expect(results[0]!.distance).toBeCloseTo(0, 2);

      // Original direction should now be far
      results = searchVec(db, [1, 0, 0, 0], 10);
      expect(results[0]!.distance).toBeGreaterThan(1);
    } finally {
      closeDatabase(db);
    }
  });

  test("upsertEntry invalidates vectors only when the embedding input changes", () => {
    const db = openIndexDatabase(tmpDbPath(), { embeddingDim: 4 });
    try {
      const id = insertTestEntry(db, "vec-input", { searchText: "same projection" });
      upsertEmbedding(db, id, [1, 0, 0, 0]);

      expect(insertTestEntry(db, "vec-input", { searchText: "same projection" })).toBe(id);
      expect(db.prepare("SELECT COUNT(*) AS count FROM embeddings WHERE id = ?").get(id)).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM entries_vec WHERE id = ?").get(id)).toEqual({ count: 1 });

      expect(insertTestEntry(db, "vec-input", { searchText: "changed projection" })).toBe(id);
      expect(db.prepare("SELECT COUNT(*) AS count FROM embeddings WHERE id = ?").get(id)).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM entries_vec WHERE id = ?").get(id)).toEqual({ count: 0 });
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

  test("upsertEmbedding surfaces a vec fast-path insert failure instead of swallowing it", () => {
    const dbPath = tmpDbPath();
    // entries_vec is created at dim 4; a dim-3 vector makes the vec0 INSERT
    // throw while the BLOB row (which has no dimension constraint) still writes.
    const db = openIndexDatabase(dbPath, { embeddingDim: 4 });
    try {
      expect(isVecAvailable(db)).toBe(true);
      const id = insertTestEntry(db, "vec-mismatch", { searchText: "mismatch" });

      const res = upsertEmbedding(db, id, [1, 0, 0]);

      // The BLOB is written (semantic search can still fall back)...
      expect(res.stored).toBe(true);
      // ...but the vec fast-path failure is REPORTED, not silently swallowed.
      expect(res.vec).toBe("failed");
    } finally {
      closeDatabase(db);
    }
  });

  test("a degraded vec fast path routes searchVec to the JS-cosine BLOB fallback", () => {
    const dbPath = tmpDbPath();
    const db = openIndexDatabase(dbPath, { embeddingDim: 4 });
    try {
      const id = insertTestEntry(db, "vec-degraded", { searchText: "degraded" });
      // BLOB + vec rows both written by a healthy upsert.
      expect(upsertEmbedding(db, id, [1, 0, 0, 0]).vec).toBe("ok");

      // Simulate the state after failed/partial vec inserts: the BLOB table is
      // complete but the vec table is empty.
      db.prepare("DELETE FROM entries_vec").run();

      // Trusting the (now-empty) fast path returns nothing — the dishonest case.
      setVecFastPathReady(db, true);
      expect(isVecFastPathReady(db)).toBe(true);
      expect(searchVec(db, [1, 0, 0, 0], 10).length).toBe(0);

      // Marking the fast path degraded routes search to the complete BLOB table
      // via JS-cosine — honest degradation, not a hard failure.
      setVecFastPathReady(db, false);
      expect(isVecFastPathReady(db)).toBe(false);
      const fallback = searchVec(db, [1, 0, 0, 0], 10);
      expect(fallback.length).toBe(1);
      expect(fallback[0]!.id).toBe(id);
    } finally {
      closeDatabase(db);
    }
  });

  test("vec fast-path completeness accepts identical BLOB and vec ID sets", () => {
    const db = openIndexDatabase(tmpDbPath("vec-complete-exact"), { embeddingDim: 4 });
    try {
      const firstId = insertTestEntry(db, "vec-complete-first");
      const secondId = insertTestEntry(db, "vec-complete-second");
      expect(upsertEmbedding(db, firstId, [1, 0, 0, 0]).vec).toBe("ok");
      expect(upsertEmbedding(db, secondId, [0, 1, 0, 0]).vec).toBe("ok");

      expect(isVecFastPathComplete(db)).toBe(true);
    } finally {
      closeDatabase(db);
    }
  });

  test("vec fast-path completeness rejects a missing vec ID", () => {
    const db = openIndexDatabase(tmpDbPath("vec-complete-partial"), { embeddingDim: 4 });
    try {
      const firstId = insertTestEntry(db, "vec-partial-first");
      const secondId = insertTestEntry(db, "vec-partial-second");
      expect(upsertEmbedding(db, firstId, [1, 0, 0, 0]).vec).toBe("ok");
      expect(upsertEmbedding(db, secondId, [0, 1, 0, 0]).vec).toBe("ok");
      db.prepare("DELETE FROM entries_vec WHERE id = ?").run(secondId);

      expect(isVecFastPathComplete(db)).toBe(false);
    } finally {
      closeDatabase(db);
    }
  });

  test("vec fast-path completeness rejects equal counts with mismatched IDs", () => {
    const db = openIndexDatabase(tmpDbPath("vec-complete-mismatched"), { embeddingDim: 4 });
    try {
      const firstId = insertTestEntry(db, "vec-mismatch-first");
      const missingId = insertTestEntry(db, "vec-mismatch-second");
      expect(upsertEmbedding(db, firstId, [1, 0, 0, 0]).vec).toBe("ok");
      expect(upsertEmbedding(db, missingId, [0, 1, 0, 0]).vec).toBe("ok");
      db.prepare("DELETE FROM entries_vec WHERE id = ?").run(missingId);
      const orphanId = missingId + 100_000;
      const orphanVector = Buffer.from(new Float32Array([0, 0, 1, 0]).buffer);
      db.prepare("INSERT INTO entries_vec (id, embedding) VALUES (?, ?)").run(orphanId, orphanVector);

      expect(db.prepare("SELECT COUNT(*) AS count FROM embeddings").get()).toEqual({ count: 2 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM entries_vec").get()).toEqual({ count: 2 });
      expect(isVecFastPathComplete(db)).toBe(false);
    } finally {
      closeDatabase(db);
    }
  });

  test("a non-integer or non-positive embeddingDim warns and falls back to the default instead of aborting", () => {
    // index-schema.ts used to throw a bare Error for any dim outside 1–4096,
    // aborting the whole index open at exit 70 mid-run — including for
    // legitimately large real embedding widths above 4096, which the config
    // schema does not itself reject. A dimension that cannot back a vec0
    // column at all (non-integer, zero, negative) still cannot be used, but
    // degrades to a warning and the static default (matching how
    // index-connection.ts's resolveConfiguredEmbeddingDim already handles the
    // same bad-value case) rather than aborting.
    for (const dim of [0, -1, 384.5]) {
      const messages: string[] = [];
      _setWarnSinkForTests((level, args) => {
        if (level === "warn") messages.push(args.map(String).join(" "));
      });
      let db: Database | undefined;
      try {
        db = openIndexDatabase(tmpDbPath(), { embeddingDim: dim });
        expect(getMeta(db, "embeddingDim")).toBe(String(EMBEDDING_DIM));
        expect(messages.some((message) => message.includes("Invalid embedding dimension"))).toBe(true);
      } finally {
        if (db) closeDatabase(db);
        _setWarnSinkForTests(undefined);
      }
    }
  });

  test("an embeddingDim above the old 4096 ceiling is honored, not rejected", () => {
    const dbPath = tmpDbPath();
    const db = openIndexDatabase(dbPath, { embeddingDim: 8192 });
    try {
      expect(getMeta(db, "embeddingDim")).toBe("8192");
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
      expect(results[0]!.id).toBe(id);
    } finally {
      closeDatabase(db);
    }
  });

  test("openExistingDatabase rejects a non-canonical generation before returning a handle", () => {
    const dbPath = tmpDbPath();
    const seed = openIndexDatabase(dbPath);
    setMeta(seed, "version", "0");
    closeDatabase(seed);

    expect(() => openExistingDatabase(dbPath)).toThrow(ConfigError);
    try {
      openExistingDatabase(dbPath);
    } catch (error) {
      expect((error as ConfigError).code).toBe("INDEX_SCHEMA_INCOMPATIBLE");
      expect((error as Error).message).not.toMatch(/no such table|SQLITE/i);
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
describe("entries-by-path reads (getEntryIdByFilePath / getEntryFilePathById)", () => {
  function seedAt(db: Database, key: string, filePath: string, stashDir: string, type: IndexDocument["type"]): number {
    const entry = { description: `Description for ${key}`, type, name: key } as unknown as IndexDocument;
    const bundleId = path.basename(stashDir) || "root";
    const provenance = deriveEntryProvenance({ bundleId, componentId: bundleId, adapterId: "akm" }, type, key);
    return upsertEntry(db, filePath, entry, key, provenance);
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

  test("getEntryFilePathById still returns the path when document_json is corrupt (no JSON parse)", () => {
    const dbPath = tmpDbPath();
    const db = openIndexDatabase(dbPath);
    try {
      const id = seedAt(db, "broken", "/s/broken.md", "/s", "skill");
      db.prepare("UPDATE entries SET document_json = ? WHERE id = ?").run("{not json", id);
      expect(getEntryFilePathById(db, id)).toBe("/s/broken.md");
      // getEntryById, by contrast, drops the corrupt row — proving the new
      // helper deliberately avoids JSON parsing to preserve feedback-cli's
      // pre-extraction behaviour.
      expect(getEntryById(db, id)).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
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
