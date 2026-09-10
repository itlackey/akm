// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Issues #820 and the index materialization boundary.
 *
 * These contracts require one committed index generation: entry mutations
 * publish their FTS projection atomically, and a rename or content edit
 * re-points/refreshes the same item_ref-keyed row rather than leaving a
 * stale generation behind (index-redesign B5a: `--full` reconciles in place;
 * `--clean` is gone — content-addressed units are never at risk from a
 * reindex, so there is nothing left to sweep).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../../src/core/config/config";
import { akmIndex, lookupBundleRef } from "../../../src/indexer/indexer";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import type { IndexDocument } from "../../../src/indexer/passes/metadata";
import type { Database } from "../../../src/storage/database";
import {
  closeDatabase,
  openExistingDatabase,
  openIndexDatabase,
} from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { searchFts } from "../../../src/storage/repositories/index-fts-repository";
import { upsertEmbedding } from "../../../src/storage/repositories/index-vec-repository";
import {
  type IsolatedAkmStorage,
  makeStashDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let secondary: SandboxedDir;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  secondary = makeStashDir();
});

afterEach(() => {
  secondary.cleanup();
  storage.cleanup();
});

function rowCount(db: Database, table: string, predicate = "", values: Array<string | number> = []): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${predicate}`).get(...values) as
    | { count: number }
    | undefined;
  return row?.count ?? 0;
}

function writePreviewAsset(root: string, family: "printmd" | "gutterpress"): string {
  const file = path.join(root, "knowledge", family, "preview-server-usage.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    "---\ndescription: Preview server usage guide\n---\n\n# Preview server usage\n\nRun the preview server safely.\n",
    "utf8",
  );
  return file;
}

describe("canonical entry mutation", () => {
  test("upsert publishes the canonical row and its FTS projection atomically", () => {
    const db = openIndexDatabase(path.join(storage.dataDir, "mutation.db"));
    try {
      const entry: IndexDocument = {
        type: "knowledge",
        name: "atomic-publish",
        description: "uniquefoundationmarker",
        filename: "atomic-publish.md",
      };
      const provenance = deriveEntryProvenance(
        { bundleId: "primary", componentId: "primary", adapterId: "akm" },
        entry.type,
        entry.name,
      );

      upsertEntry(db, "/primary/knowledge/atomic-publish.md", entry, "uniquefoundationmarker", provenance);

      expect(searchFts(db, "uniquefoundationmarker", 10).map((hit) => hit.itemRef)).toEqual([
        "primary//knowledge/atomic-publish",
      ]);
      expect(rowCount(db, "entries_fts")).toBe(1);
    } finally {
      closeDatabase(db);
    }
  });

  test("rolls back the canonical row when its FTS projection cannot publish", () => {
    const db = openIndexDatabase(path.join(storage.dataDir, "mutation-rollback.db"));
    try {
      const entry: IndexDocument = {
        type: "knowledge",
        name: "atomic-rollback",
        description: "rollbackfoundationmarker",
        filename: "atomic-rollback.md",
      };
      const provenance = deriveEntryProvenance(
        { bundleId: "primary", componentId: "primary", adapterId: "akm" },
        entry.type,
        entry.name,
      );
      db.exec("DROP TABLE entries_fts");

      expect(() =>
        upsertEntry(db, "/primary/knowledge/atomic-rollback.md", entry, "rollbackfoundationmarker", provenance),
      ).toThrow();
      expect(rowCount(db, "entries")).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  test("cannot catch an FTS failure and commit a partial mutation through an outer transaction", () => {
    const db = openIndexDatabase(path.join(storage.dataDir, "nested-mutation-rollback.db"));
    try {
      const entry: IndexDocument = {
        type: "knowledge",
        name: "nested-atomic-rollback",
        description: "nestedrollbackmarker",
        filename: "nested-atomic-rollback.md",
      };
      const provenance = deriveEntryProvenance(
        { bundleId: "primary", componentId: "primary", adapterId: "akm" },
        entry.type,
        entry.name,
      );
      db.exec("DROP TABLE entries_fts");

      db.transaction(() => {
        try {
          upsertEntry(db, "/primary/knowledge/nested-atomic-rollback.md", entry, "nestedrollbackmarker", provenance);
        } catch {
          // The caller deliberately continues its outer transaction. The
          // canonical mutation must still have rolled back to its savepoint.
        }
        db.prepare("INSERT INTO index_meta (key, value) VALUES (?, ?)").run("outer-transaction-committed", "yes");
      })();

      expect(rowCount(db, "entries")).toBe(0);
      expect(db.prepare("SELECT value FROM index_meta WHERE key = ?").get("outer-transaction-committed")).toEqual({
        value: "yes",
      });
    } finally {
      closeDatabase(db);
    }
  });
});

// index-redesign (B5a): `akm index --full` no longer wipes `entries`/`files`
// and rebuilds a fresh generation from nothing — it reconciles with
// `forceReparse: true` (every walked file is re-derived, but the existing
// item_ref-keyed row is UPDATED in place, not replaced; see indexer.ts's
// `IndexOptions.full` doc). A second full run over a file whose CONTENT
// changed but whose item_ref (concept identity) did not therefore re-points
// the SAME `entries` row rather than minting a new id and orphaning the old
// one — this test used to assert the opposite (the pre-redesign wipe-based
// generation boundary); it now asserts what actually happens: the row (and
// its FK-linked `utility_scores`) survive with the same id, only the legacy
// entry-keyed vector cache (`embeddings`/`entries_vec` — content-addressed by
// search text, dead tables under the new units pipeline but still cleared
// here defensively on a content change) and the FTS projection are refreshed
// to the new content.
test("a second full generation re-points the same row for unchanged identity, refreshing its content", async () => {
  writeSandboxConfig({
    semanticSearchMode: "off",
    bundles: { primary: { path: storage.stashDir, writable: true } },
    defaultBundle: "primary",
  });
  resetConfigCache();

  const asset = writePreviewAsset(storage.stashDir, "printmd");
  await akmIndex({ stashDir: storage.stashDir, full: true });

  const oldDb = openExistingDatabase();
  let oldId: number;
  try {
    const row = oldDb
      .prepare("SELECT id FROM entries WHERE item_ref = ?")
      .get("primary//knowledge/printmd/preview-server-usage") as { id: number } | undefined;
    if (!row) throw new Error("missing first-generation row");
    oldId = row.id;
    upsertEmbedding(
      oldDb,
      oldId,
      Array.from({ length: 384 }, () => 0.25),
    );
    oldDb.prepare("INSERT INTO utility_scores (entry_id, utility) VALUES (?, ?)").run(oldId, 1);
    oldDb
      .prepare("INSERT INTO utility_scores_scoped (entry_id, scope_key, utility, last_used_at) VALUES (?, ?, ?, ?)")
      .run(oldId, "test-scope", 1, Date.now());
  } finally {
    closeDatabase(oldDb);
  }

  fs.appendFileSync(asset, "\nSecond generation content.\n", "utf8");
  await akmIndex({ stashDir: storage.stashDir, full: true });

  const currentDb = openExistingDatabase();
  try {
    const newRow = currentDb
      .prepare("SELECT id FROM entries WHERE item_ref = ?")
      .get("primary//knowledge/printmd/preview-server-usage") as { id: number } | undefined;
    if (!newRow) throw new Error("missing second-generation row");
    // Same concept identity (item_ref), same row — never a new id.
    expect(newRow.id).toBe(oldId);
    // Exactly one FTS projection for this id, carrying the NEW content.
    expect(rowCount(currentDb, "entries_fts", "WHERE entry_id = ?", [oldId])).toBe(1);
    expect(searchFts(currentDb, "second generation content", 10).map((hit) => hit.itemRef)).toEqual([
      "primary//knowledge/printmd/preview-server-usage",
    ]);
    // The legacy entry-keyed vector cache is cleared on a content change
    // (upsertEntry's deleteEntryVectors) — dead tables under the units
    // pipeline, but still correctly invalidated rather than left stale.
    expect(rowCount(currentDb, "embeddings", "WHERE id = ?", [oldId])).toBe(0);
    const hasVec = currentDb
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'entries_vec'")
      .get() as { present: number } | undefined;
    if (hasVec) expect(rowCount(currentDb, "entries_vec", "WHERE id = ?", [oldId])).toBe(0);
    // Utility learning is keyed off the row's id and untouched by a content
    // refresh — it survives, unlike the pre-redesign wipe that discarded it.
    expect(rowCount(currentDb, "utility_scores", "WHERE entry_id = ?", [oldId])).toBe(1);
    expect(rowCount(currentDb, "utility_scores_scoped", "WHERE entry_id = ?", [oldId])).toBe(1);
  } finally {
    closeDatabase(currentDb);
  }
});

for (const scenario of [
  { label: "default bundle", bundle: "primary", root: () => storage.stashDir },
  { label: "named non-default bundle", bundle: "team", root: () => secondary.dir },
] as const) {
  test(`a rename in the ${scenario.label} re-points the same row and publishes one generation`, async () => {
    writeSandboxConfig({
      semanticSearchMode: "off",
      bundles: {
        primary: { path: storage.stashDir, writable: true },
        team: { path: secondary.dir },
      },
      defaultBundle: "primary",
    });
    resetConfigCache();

    const root = scenario.root();
    const oldFile = writePreviewAsset(root, "printmd");
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const oldRef = `${scenario.bundle}//knowledge/printmd/preview-server-usage`;
    const newRef = `${scenario.bundle}//knowledge/gutterpress/preview-server-usage`;
    const db = openExistingDatabase();
    let oldId: number;
    try {
      const row = db.prepare("SELECT id FROM entries WHERE item_ref = ?").get(oldRef) as { id: number } | undefined;
      if (!row) throw new Error(`missing seeded row ${oldRef}`);
      oldId = row.id;
      db.prepare("INSERT INTO embeddings (id, embedding) VALUES (?, ?)").run(oldId, Buffer.alloc(8));
      db.prepare("INSERT INTO utility_scores (entry_id, utility) VALUES (?, ?)").run(oldId, 1);
    } finally {
      closeDatabase(db);
    }

    // `writePreviewAsset` writes byte-identical content under both family
    // names — only the directory (and so the akm adapter's path-derived
    // name) differs. Reconcile's rename recognition (reconcile.ts,
    // index-redesign B1) matches this pair by blob hash and re-points the
    // SAME `entries` row (`repointEntry`) rather than deleting and
    // re-inserting: a rename with unchanged content keeps its id, and
    // everything keyed off that id — the embeddings/utility_scores rows
    // seeded above included — survives with it.
    const newFile = writePreviewAsset(root, "gutterpress");
    fs.unlinkSync(oldFile);
    expect(fs.existsSync(newFile)).toBe(true);

    const result = await akmIndex({ stashDir: storage.stashDir });

    expect(result.totalEntries).toBe(1);
    expect(result.verification.entryCount).toBe(1);

    const finalDb = openExistingDatabase();
    let searchRefs: string[];
    try {
      expect(rowCount(finalDb, "entries", "WHERE item_ref = ?", [oldRef])).toBe(0);
      const repointed = finalDb.prepare("SELECT id FROM entries WHERE item_ref = ?").get(newRef) as
        | { id: number }
        | undefined;
      expect(repointed?.id).toBe(oldId);
      expect(rowCount(finalDb, "entries_fts", "WHERE entry_id = ?", [oldId])).toBe(1);
      expect(rowCount(finalDb, "embeddings", "WHERE id = ?", [oldId])).toBe(1);
      expect(rowCount(finalDb, "utility_scores", "WHERE entry_id = ?", [oldId])).toBe(1);
      expect(rowCount(finalDb, "entries")).toBe(result.totalEntries);
      expect(rowCount(finalDb, "entries_fts")).toBe(result.totalEntries);
      searchRefs = searchFts(finalDb, "preview server usage", 10).map((hit) => hit.itemRef);
    } finally {
      closeDatabase(finalDb);
    }

    expect(searchRefs).toContain(newRef);
    expect(searchRefs).not.toContain(oldRef);
    for (const ref of searchRefs) {
      const [bundle, conceptId] = ref.split("//", 2);
      if (!bundle || !conceptId) throw new Error(`invalid canonical ref ${ref}`);
      expect(await lookupBundleRef({ bundle, conceptId })).not.toBeNull();
    }
  });
}
