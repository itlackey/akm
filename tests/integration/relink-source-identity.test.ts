// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
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
    sources: [
      { type: "filesystem", name: "stash", path: stashDir, primary: true, writable: true },
      { type: "filesystem", name: "team", path: teamDir, enabled: true, writable: false },
    ],
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
  const insert = db.prepare(
    "INSERT INTO usage_events (event_type, entry_id, entry_ref, created_at) VALUES ('show', ?, ?, datetime('now'))",
  );
  insert.run(null, "team//memory:duplicate");
  insert.run(stashId as number, "stash//memory:duplicate");
  insert.run(stashId as number, "memory:duplicate");
  closeDatabase(db);

  await akmIndex({ stashDir, full: true });

  db = openExistingDatabase(dbPath);
  const linked = db
    .prepare(
      `SELECT u.entry_ref, e.stash_dir
         FROM usage_events u
         LEFT JOIN entries e ON e.id = u.entry_id
        WHERE u.event_type = 'show'
        ORDER BY u.entry_ref`,
    )
    .all() as Array<{ entry_ref: string; stash_dir: string | null }>;
  // F4c §11.4 re-key (origin-faithful): the bare `memory:duplicate` and the
  // `stash//memory:duplicate` events both resolve to the WINNING stash row, so
  // both re-key onto its fully-qualified item_ref (`stash//memories/duplicate`)
  // — the origin is preserved, never collapsed. `team//memory:duplicate` names
  // the team source, whose copy was deduped OUT of `entries`: an EXPECTED §11.4
  // orphan — kept in place (legacy-spelled, detached), NOT deleted, and archived
  // in the `legacy_state` quarantine.
  const stashLinked = linked.filter((r) => r.stash_dir === stashDir);
  expect(stashLinked.length).toBe(2);
  expect(stashLinked.every((r) => r.entry_ref.endsWith("//memories/duplicate"))).toBe(true);
  const teamRow = linked.filter((r) => r.entry_ref === "team//memory:duplicate");
  expect(teamRow).toEqual([{ entry_ref: "team//memory:duplicate", stash_dir: null }]);
  const quarantined = db
    .prepare("SELECT old_ref, row_count, reason FROM legacy_state WHERE surface = 'usage_events'")
    .all() as Array<{ old_ref: string; row_count: number; reason: string }>;
  expect(quarantined).toEqual([{ old_ref: "team//memory:duplicate", row_count: 1, reason: "orphan" }]);
  expect(
    getRetrievalCounts(db, ["memory:duplicate"], {
      stashDir: teamDir,
      sourceName: "team",
      includeLegacyBare: false,
    }).get("memory:duplicate"),
  ).toBe(1);
  expect(
    getRetrievalCounts(db, ["memory:duplicate"], {
      stashDir,
      sourceName: "stash",
      includeLegacyBare: true,
    }).get("memory:duplicate"),
  ).toBe(2);
  closeDatabase(db);
});
