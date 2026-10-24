// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { openStateDatabase } from "../../src/core/state-db";
import { akmIndex } from "../../src/indexer/indexer";
import { resolveSourceEntries } from "../../src/indexer/search/search-source";
import { closeDatabase, openExistingDatabase } from "../../src/storage/repositories/index-connection";
import { getRetrievalCounts } from "../../src/storage/repositories/index-utility-repository";
import { type Cleanup, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let cleanup: Cleanup = () => {};
let stashDir = "";
let teamDir = "";

beforeEach(() => {
  const storage = withIsolatedAkmStorage();
  cleanup = storage.cleanup;
  stashDir = storage.stashDir;
  teamDir = path.join(storage.root, "team");
  fs.mkdirSync(path.join(teamDir, "memories"), { recursive: true });
  writeSandboxConfig({
    semanticSearchMode: "off",
    defaultWriteTarget: "stash",
    bundles: {
      stash: { path: stashDir, writable: true },
      team: { path: teamDir },
    },
    defaultBundle: "stash",
  });
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

function writeDuplicate(root: string, description: string): void {
  fs.writeFileSync(
    path.join(root, "memories", "duplicate.md"),
    `---\ndescription: ${description}\n---\n\n${description} body.\n`,
    "utf8",
  );
}

test("full reindex relinks duplicate usage only to its qualified source and scopes retrieval counts", async () => {
  writeDuplicate(stashDir, "Historical stash duplicate");
  writeDuplicate(teamDir, "Team duplicate");
  expect(resolveSourceEntries(stashDir, loadConfig()).map((source) => source.path)).toEqual([stashDir, teamDir]);
  await akmIndex({ stashDir, full: true });

  const dbPath = getDbPath();
  let db = openExistingDatabase(dbPath);
  const rows = db
    .prepare("SELECT id, bundle_id FROM entries WHERE type = 'memory' AND concept_id = 'memories/duplicate'")
    .all() as Array<{ id: number; bundle_id: string }>;
  // Both bundle-qualified concepts remain indexed and independently linkable.
  expect(rows.map((row) => row.bundle_id).sort()).toEqual(["stash", "team"]);
  const stashId = rows.find((row) => row.bundle_id === "stash")?.id;
  expect(stashId).toBeNumber();
  closeDatabase(db);

  // Chunk-8 WI-8.3: usage_events lives in state.db now — seed it there.
  const stateDb = openStateDatabase();
  const insert = stateDb.prepare(
    "INSERT INTO usage_events (event_type, entry_id, entry_ref, source, created_at) VALUES ('show', ?, ?, 'user', datetime('now'))",
  );
  // Post-Chunk-8 the durable `usage_events.entry_ref` is the new-grammar
  // conceptId (`[bundle//]memories/duplicate`), not the legacy `memory:duplicate`.
  insert.run(null, "team//memories/duplicate");
  insert.run(stashId as number, "stash//memories/duplicate");
  insert.run(null, "memories/duplicate");
  stateDb.close();

  await akmIndex({ stashDir, full: true });

  db = openExistingDatabase(dbPath);
  const stateDb2 = openStateDatabase();
  // usage_events rows come from state.db; canonical bundle ownership is looked
  // up from index.db by entry_id (cross-DB).
  const bundleById = db.prepare("SELECT bundle_id FROM entries WHERE id = ?");
  const linked = (
    stateDb2
      .prepare("SELECT entry_ref, entry_id FROM usage_events WHERE event_type = 'show' ORDER BY entry_ref")
      .all() as Array<{ entry_ref: string; entry_id: number | null }>
  ).map((r) => ({
    entry_ref: r.entry_ref,
    bundle_id:
      r.entry_id === null
        ? null
        : ((bundleById.get(r.entry_id) as { bundle_id: string } | undefined)?.bundle_id ?? null),
  }));
  // Relinking remains bundle-faithful; the bare row stays detached.
  const stashLinked = linked.filter((r) => r.bundle_id === "stash");
  expect(stashLinked).toEqual([{ entry_ref: "stash//memories/duplicate", bundle_id: "stash" }]);
  expect(linked.find((row) => row.entry_ref === "memories/duplicate")?.bundle_id).toBeNull();
  const teamRow = linked.filter((r) => r.entry_ref === "team//memories/duplicate");
  expect(teamRow).toEqual([{ entry_ref: "team//memories/duplicate", bundle_id: "team" }]);
  const quarantined = stateDb2
    .prepare("SELECT old_ref, row_count, reason FROM legacy_state WHERE surface = 'usage_events'")
    .all() as Array<{ old_ref: string; row_count: number; reason: string }>;
  expect(quarantined).toEqual([]);
  expect(
    getRetrievalCounts(db, stateDb2, ["memories/duplicate"], {
      sourceName: "team",
    }).get("memories/duplicate"),
  ).toBe(1);
  expect(
    getRetrievalCounts(db, stateDb2, ["memories/duplicate"], {
      sourceName: "stash",
    }).get("memories/duplicate"),
  ).toBe(1);
  closeDatabase(db);
  stateDb2.close();
});
