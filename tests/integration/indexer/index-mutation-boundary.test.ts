// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Issues #820 and the index materialization boundary.
 *
 * These contracts require one committed index generation: entry mutations
 * publish their FTS projection immediately, and --clean removes stale rows
 * before totals and semantic verification are calculated.
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

test("a full run keeps an entry's id; changed content drops only its stale vector", async () => {
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
  } finally {
    closeDatabase(oldDb);
  }

  fs.appendFileSync(asset, "\nSecond generation zeppelin content.\n", "utf8");
  await akmIndex({ stashDir: storage.stashDir, full: true });

  const currentDb = openExistingDatabase();
  try {
    const newRow = currentDb
      .prepare("SELECT id FROM entries WHERE item_ref = ?")
      .get("primary//knowledge/printmd/preview-server-usage") as { id: number } | undefined;
    expect(newRow?.id).toBe(oldId);
    expect(rowCount(currentDb, "entries_fts", "WHERE rowid = ?", [oldId])).toBe(1);
    expect(searchFts(currentDb, "zeppelin", 10).map((hit) => hit.id)).toEqual([oldId]);
    expect(rowCount(currentDb, "embeddings", "WHERE id = ?", [oldId])).toBe(0);
    const hasVec = currentDb
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'entries_vec'")
      .get() as { present: number } | undefined;
    if (hasVec) expect(rowCount(currentDb, "entries_vec", "WHERE id = ?", [oldId])).toBe(0);
  } finally {
    closeDatabase(currentDb);
  }
});

for (const scenario of [
  { label: "default bundle", bundle: "primary", root: () => storage.stashDir },
  { label: "named non-default bundle", bundle: "team", root: () => secondary.dir },
] as const) {
  test(`--clean publishes one post-clean generation for a rename in the ${scenario.label}`, async () => {
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

    const newFile = writePreviewAsset(root, "gutterpress");
    fs.unlinkSync(oldFile);
    expect(fs.existsSync(newFile)).toBe(true);

    const result = await akmIndex({ stashDir: storage.stashDir, clean: true });

    expect(result.clean).toMatchObject({ removed: 1, removedRefs: [oldRef], dryRun: false });
    expect(result.totalEntries).toBe(1);
    expect(result.verification.entryCount).toBe(1);

    const finalDb = openExistingDatabase();
    let searchRefs: string[];
    try {
      expect(rowCount(finalDb, "entries", "WHERE item_ref = ?", [oldRef])).toBe(0);
      expect(rowCount(finalDb, "entries_fts", "WHERE rowid = ?", [oldId])).toBe(0);
      expect(rowCount(finalDb, "embeddings", "WHERE id = ?", [oldId])).toBe(0);
      expect(rowCount(finalDb, "utility_scores", "WHERE entry_id = ?", [oldId])).toBe(0);
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
