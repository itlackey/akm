// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #627 — query-layer type exclusion (RED — feature not yet implemented).
 *
 * The default (untyped) `akm search` / `akm curate` path should be able to
 * exclude noisy asset types (notably `session`) from results WITHOUT changing
 * the index schema, re-indexing, or regenerating embeddings. The exclusion is
 * a pure query-layer policy threaded through the read functions in
 * `src/indexer/db/db.ts`:
 *
 *   - `searchFts(db, query, limit, entryType?, excludeTypes?)` — appends an
 *     `entry_type NOT IN (...)` clause to BOTH the exact and prefix-fallback
 *     FTS queries.
 *   - `getAllEntries(db, entryType?, excludeTypes?)` — appends the same clause
 *     to the enumerate-all path.
 *
 * The `excludeTypes` parameter does not exist yet, so the assertions that the
 * excluded type is filtered out are expected to FAIL until the feature lands.
 * (The calls themselves are typed against the planned signature; if the param
 * is silently ignored today the filtering assertions fail — the RIGHT reason.)
 *
 * All tests use a sandboxed temp DB and never touch real host state.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  closeDatabase,
  getAllEntries,
  openDatabase,
  rebuildFts,
  searchFts,
  upsertEntry,
} from "../../src/indexer/db/db";
import type { StashEntry } from "../../src/indexer/passes/metadata";
import type { Database } from "../../src/storage/database";
import { type Cleanup, sandboxXdgCacheHome, sandboxXdgConfigHome } from "../_helpers/sandbox";

const createdTmpDirs: string[] = [];

function tmpDbPath(label = "exclude"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `akm-${label}-`));
  createdTmpDirs.push(dir);
  return path.join(dir, "test.db");
}

afterAll(() => {
  for (const dir of createdTmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

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

/** Insert an entry of a given type with searchable text containing `token`. */
function insertTyped(db: Database, key: string, type: StashEntry["type"], token: string): number {
  const entry: StashEntry = { name: key, type, description: `${token} ${key} description` };
  return upsertEntry(
    db,
    key,
    `/test/${type}`,
    `/test/${type}/${key}.md`,
    "/test/stash",
    entry,
    `${token} ${key} ${entry.description}`,
  );
}

/** Seed a fixed index with one skill, one memory, and one session. */
function seedMixedIndex(db: Database): void {
  insertTyped(db, "skill-one", "skill", "shared");
  insertTyped(db, "memory-one", "memory", "shared");
  insertTyped(db, "session-one", "session", "shared");
  rebuildFts(db);
}

// ── AC1a: searchFts honors excludeTypes ─────────────────────────────────────

describe("#627 searchFts excludeTypes", () => {
  test("searchFts(db, q, limit, undefined, ['session']) returns skill+memory but NOT session", () => {
    const db = openDatabase(tmpDbPath());
    try {
      seedMixedIndex(db);

      // Sanity: without exclusion the session hit is present (current behavior).
      const baseline = searchFts(db, "shared", 50, undefined);
      const baseTypes = baseline.map((h) => h.entry.type);
      expect(baseTypes).toContain("session");

      // With exclusion the session hit must be gone, others kept.
      const filtered = searchFts(db, "shared", 50, undefined, ["session"]);
      const filteredTypes = filtered.map((h) => h.entry.type);
      expect(filteredTypes).toContain("skill");
      expect(filteredTypes).toContain("memory");
      expect(filteredTypes).not.toContain("session");
    } finally {
      closeDatabase(db);
    }
  });

  test("excludeTypes applies on the prefix-fallback path too", () => {
    const db = openDatabase(tmpDbPath());
    try {
      // Token only matches via prefix fallback (no exact term match).
      insertTyped(db, "skill-pre", "skill", "sessionization");
      insertTyped(db, "session-pre", "session", "sessionization");
      rebuildFts(db);

      // "session" has no exact match (the stored token is "sessionization"),
      // so this only resolves via the >=3-char prefix fallback.
      const filtered = searchFts(db, "session", 50, undefined, ["session"]);
      const types = filtered.map((h) => h.entry.type);
      expect(types).toContain("skill");
      expect(types).not.toContain("session");
    } finally {
      closeDatabase(db);
    }
  });

  test("empty excludeTypes [] is a no-op (does not produce a SQL error / always-false clause)", () => {
    const db = openDatabase(tmpDbPath());
    try {
      seedMixedIndex(db);
      const hits = searchFts(db, "shared", 50, undefined, []);
      const types = hits.map((h) => h.entry.type);
      expect(types).toContain("session");
      expect(types).toContain("skill");
      expect(types).toContain("memory");
    } finally {
      closeDatabase(db);
    }
  });

  test("explicit entryType include filter is independent of excludeTypes (include wins narrow)", () => {
    const db = openDatabase(tmpDbPath());
    try {
      seedMixedIndex(db);
      // Asking explicitly for sessions returns the session even if it were on an
      // exclude list — the include filter narrows to exactly that type.
      const hits = searchFts(db, "shared", 50, "session", ["session"]);
      const types = hits.map((h) => h.entry.type);
      expect(types).toEqual(["session"]);
    } finally {
      closeDatabase(db);
    }
  });
});

// ── AC1a: getAllEntries honors excludeTypes ─────────────────────────────────

describe("#627 getAllEntries excludeTypes", () => {
  test("getAllEntries(db, undefined, ['session']) excludes sessions, keeps others", () => {
    const db = openDatabase(tmpDbPath());
    try {
      seedMixedIndex(db);

      const all = getAllEntries(db);
      expect(all.map((e) => e.entry.type)).toContain("session");

      const filtered = getAllEntries(db, undefined, ["session"]);
      const types = filtered.map((e) => e.entry.type);
      expect(types).toContain("skill");
      expect(types).toContain("memory");
      expect(types).not.toContain("session");
    } finally {
      closeDatabase(db);
    }
  });

  // AC4b: the exclude list is generic, not a session hardcode.
  test("getAllEntries with ['session','wiki'] excludes BOTH types generically", () => {
    const db = openDatabase(tmpDbPath());
    try {
      insertTyped(db, "skill-one", "skill", "shared");
      insertTyped(db, "memory-one", "memory", "shared");
      insertTyped(db, "session-one", "session", "shared");
      insertTyped(db, "wiki-one", "wiki", "shared");
      rebuildFts(db);

      const filtered = getAllEntries(db, undefined, ["session", "wiki"]);
      const types = filtered.map((e) => e.entry.type);
      expect(types).toContain("skill");
      expect(types).toContain("memory");
      expect(types).not.toContain("session");
      expect(types).not.toContain("wiki");
    } finally {
      closeDatabase(db);
    }
  });
});

// ── AC6: pure query-layer — no schema/index mutation ────────────────────────

describe("#627 exclusion is pure query-layer (AC6 guard)", () => {
  test("getAllEntries(db) with no excludeTypes still returns the full set including sessions", () => {
    const db = openDatabase(tmpDbPath());
    try {
      seedMixedIndex(db);

      const before = getAllEntries(db).length;
      // A filtered read must not delete rows or mutate the FTS index.
      getAllEntries(db, undefined, ["session"]);
      searchFts(db, "shared", 50, undefined, ["session"]);
      const after = getAllEntries(db).length;

      expect(after).toBe(before);
      // The full, unfiltered enumeration still includes the session row.
      expect(getAllEntries(db).map((e) => e.entry.type)).toContain("session");
    } finally {
      closeDatabase(db);
    }
  });
});
