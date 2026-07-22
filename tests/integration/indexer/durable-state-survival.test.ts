// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * akm 0.9.0 Chunk-5 flip, F4c M2 — durable-state SURVIVAL across a full rebuild
 * under the new item_ref keys (spec §11.4 — usage/feedback rows must never be
 * lost across a reindex).
 *
 * Post-Chunk-8 WI-8.5c: the one-time legacy→item_ref re-key is owned by the
 * migration cutover (020-three-db-cutover), so index finalize only RELINKS —
 * every stored `entry_ref` is already the fully-qualified `bundle//conceptId`
 * item_ref spelling. This pins that a rebuild (which nulls entry ids) re-resolves
 * them from the durable `entry_ref` and preserves the retrieval/feedback counts.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getDbPath } from "../../../src/core/paths";
import { openStateDatabase } from "../../../src/core/state-db";
import { akmIndex } from "../../../src/indexer/indexer";
import { countFeedbackSignals, insertUsageEvent } from "../../../src/indexer/usage/usage-events";
import { closeDatabase, openExistingDatabase } from "../../../src/storage/repositories/index-connection";
import { findEntryIdByRef, getItemRefById } from "../../../src/storage/repositories/index-entries-repository";
import { getRetrievalCounts } from "../../../src/storage/repositories/index-utility-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let stashDir = "";

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  stashDir = storage.stashDir;
});

afterEach(() => {
  storage.cleanup();
  stashDir = "";
});

function writeMemory(name: string, body: string): void {
  const file = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\ndescription: ${name}\n---\n${body}\n`, "utf8");
}

test("usage + feedback survive a full rebuild via the item_ref relink", async () => {
  writeMemory("alpha", "Alpha body about caching.");
  writeMemory("beta", "Beta body about routing.");
  await akmIndex({ stashDir, full: true });

  const dbPath = getDbPath();
  let db = openExistingDatabase(dbPath);
  // Chunk-8 WI-8.3: usage_events lives in state.db; entries in index.db.
  let stateDb = openStateDatabase();
  // Entries are keyed by the new-grammar `item_ref`; look them up by conceptId.
  const alphaId = findEntryIdByRef(db, "memories/alpha");
  const betaId = findEntryIdByRef(db, "memories/beta");
  expect(alphaId).toBeNumber();
  expect(betaId).toBeNumber();
  const alphaItemRef = getItemRefById(db, alphaId as number) as string;
  const betaItemRef = getItemRefById(db, betaId as number) as string;
  expect(alphaItemRef).toContain("//memories/alpha");

  // Record durable state under the item_ref spelling (post-cutover, every
  // `entry_ref` is already the fully-qualified `bundle//conceptId`):
  //   - two search + one show retrieval for alpha, one search for beta;
  //   - positive/negative feedback for alpha.
  for (const ev of ["search", "search", "show"] as const) {
    insertUsageEvent(stateDb, { event_type: ev, entry_ref: alphaItemRef, entry_id: alphaId, source: "user" });
  }
  insertUsageEvent(stateDb, { event_type: "search", entry_ref: betaItemRef, entry_id: betaId, source: "user" });
  insertUsageEvent(stateDb, {
    event_type: "feedback",
    signal: "positive",
    entry_ref: alphaItemRef,
    entry_id: alphaId,
    source: "user",
  });
  insertUsageEvent(stateDb, {
    event_type: "feedback",
    signal: "negative",
    entry_ref: alphaItemRef,
    entry_id: alphaId,
    source: "user",
  });

  // Retrieval + feedback counts BEFORE the rebuild (conceptId caller refs).
  const beforeCounts = getRetrievalCounts(db, stateDb, ["memories/alpha", "memories/beta"]);
  expect(beforeCounts.get("memories/alpha")).toBe(3);
  expect(beforeCounts.get("memories/beta")).toBe(1);
  expect(countFeedbackSignals(stateDb, alphaId as number)).toEqual({ pos: 1, neg: 1 });
  closeDatabase(db);
  stateDb.close();

  // FULL REBUILD — entry ids change; relink re-resolves entry_id from entry_ref.
  await akmIndex({ stashDir, full: true });

  db = openExistingDatabase(dbPath);
  stateDb = openStateDatabase();
  // Entry ids may have changed; resolve afresh (new-grammar conceptId lookup).
  const alphaId2 = findEntryIdByRef(db, "memories/alpha") as number;
  const betaId2 = findEntryIdByRef(db, "memories/beta") as number;

  // Retrieval counts SURVIVE and are still keyed by the caller's conceptId.
  const afterCounts = getRetrievalCounts(db, stateDb, ["memories/alpha", "memories/beta"]);
  expect(afterCounts.get("memories/alpha")).toBe(3);
  expect(afterCounts.get("memories/beta")).toBe(1);

  // Feedback SURVIVES via the id relink (entry_id restored on rebuild).
  expect(countFeedbackSignals(stateDb, alphaId2)).toEqual({ pos: 1, neg: 1 });
  void betaId2;

  // The stored spelling stays the fully-qualified item_ref — the durable key.
  const storedRefs = stateDb.prepare("SELECT DISTINCT entry_ref FROM usage_events ORDER BY entry_ref").all() as Array<{
    entry_ref: string;
  }>;
  expect(storedRefs.every((r) => r.entry_ref.includes("//memories/"))).toBe(true);
  expect(storedRefs.some((r) => r.entry_ref.endsWith("//memories/alpha"))).toBe(true);

  // No durable rows were lost — 6 usage rows in, 6 out.
  const total = stateDb.prepare("SELECT COUNT(*) AS n FROM usage_events").get() as { n: number };
  expect(total.n).toBe(6);
  closeDatabase(db);
  stateDb.close();
});
