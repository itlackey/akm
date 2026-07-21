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
    .prepare("SELECT id, stash_dir FROM entries WHERE entry_type = 'memory' AND entry_key LIKE '%:memory:duplicate'")
    .all() as Array<{ id: number; stash_dir: string }>;
  // The index's existing winner-dedup keeps only the primary duplicate. The
  // team-qualified event must remain detached rather than adopting that row.
  expect(rows.map((row) => row.stash_dir)).toEqual([stashDir]);
  const stashId = rows.find((row) => row.stash_dir === stashDir)?.id;
  expect(stashId).toBeNumber();
  closeDatabase(db);

  // Chunk-8 WI-8.3: usage_events lives in state.db now — seed it there.
  const stateDb = openStateDatabase();
  const insert = stateDb.prepare(
    "INSERT INTO usage_events (event_type, entry_id, entry_ref, created_at) VALUES ('show', ?, ?, datetime('now'))",
  );
  // Post-Chunk-8 the durable `usage_events.entry_ref` is the new-grammar
  // conceptId (`[bundle//]memories/duplicate`), not the legacy `memory:duplicate`.
  insert.run(null, "team//memories/duplicate");
  insert.run(stashId as number, "stash//memories/duplicate");
  insert.run(stashId as number, "memories/duplicate");
  stateDb.close();

  await akmIndex({ stashDir, full: true });

  db = openExistingDatabase(dbPath);
  const stateDb2 = openStateDatabase();
  // usage_events rows come from state.db; the per-row stash_dir (formerly an
  // in-SQL LEFT JOIN) is looked up from index.db by entry_id (cross-DB).
  const stashDirById = db.prepare("SELECT stash_dir FROM entries WHERE id = ?");
  const linked = (
    stateDb2
      .prepare("SELECT entry_ref, entry_id FROM usage_events WHERE event_type = 'show' ORDER BY entry_ref")
      .all() as Array<{ entry_ref: string; entry_id: number | null }>
  ).map((r) => ({
    entry_ref: r.entry_ref,
    stash_dir:
      r.entry_id === null
        ? null
        : ((stashDirById.get(r.entry_id) as { stash_dir: string } | undefined)?.stash_dir ?? null),
  }));
  // Chunk-8 relink (origin-faithful): the bare `memories/duplicate` and the
  // `stash//memories/duplicate` events both RE-RESOLVE their `entry_id` onto the
  // WINNING stash row inside its source boundary. `relinkUsageEvents` only
  // re-attaches `entry_id`; it never rewrites the durable `entry_ref` column, so
  // each event keeps its original spelling. `team//memories/duplicate` names the
  // team source, whose copy was deduped OUT of `entries`: it finds no matching
  // entry and stays detached (entry_id NULL) — kept in place, NOT deleted. On a
  // plain full re-index (no v18→v19 cutover) no `legacy_state` quarantine is
  // written; that archival now lives only in the three-db migration cutover.
  const stashLinked = linked.filter((r) => r.stash_dir === stashDir);
  expect(stashLinked.length).toBe(2);
  expect(stashLinked.map((r) => r.entry_ref).sort()).toEqual(["memories/duplicate", "stash//memories/duplicate"]);
  const teamRow = linked.filter((r) => r.entry_ref === "team//memories/duplicate");
  expect(teamRow).toEqual([{ entry_ref: "team//memories/duplicate", stash_dir: null }]);
  const quarantined = stateDb2
    .prepare("SELECT old_ref, row_count, reason FROM legacy_state WHERE surface = 'usage_events'")
    .all() as Array<{ old_ref: string; row_count: number; reason: string }>;
  expect(quarantined).toEqual([]);
  expect(
    getRetrievalCounts(db, stateDb2, ["memories/duplicate"], {
      stashDir: teamDir,
      sourceName: "team",
      includeLegacyBare: false,
    }).get("memories/duplicate"),
  ).toBe(1);
  expect(
    getRetrievalCounts(db, stateDb2, ["memories/duplicate"], {
      stashDir,
      sourceName: "stash",
      includeLegacyBare: true,
    }).get("memories/duplicate"),
  ).toBe(2);
  closeDatabase(db);
  stateDb2.close();
});
