// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * akm 0.9.0 Chunk-5 flip, F4c M2 — durable-state SURVIVAL across a full rebuild
 * under the new item_ref keys (spec §11.4 — the re-key must never lose
 * usage/feedback rows; orphans are quarantined, never deleted).
 *
 * Flow: index a fixture → record legacy-spelled usage + feedback rows → FULL
 * REBUILD (which nulls entry ids, then §11.4-re-keys entry_ref onto item_ref and
 * relinks) → assert the retrieval counts and feedback counts SURVIVE, now keyed
 * under the fully-qualified `bundle//conceptId` item_ref spelling.
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

test("usage + feedback survive a full rebuild, re-keyed onto item_ref (§11.4)", async () => {
  writeMemory("alpha", "Alpha body about caching.");
  writeMemory("beta", "Beta body about routing.");
  await akmIndex({ stashDir, full: true });

  // Record LEGACY-spelled durable state (as a pre-flip installation would carry):
  //   - two search + one show retrieval for alpha, one search for beta;
  //   - positive/negative feedback for alpha.
  const dbPath = getDbPath();
  let db = openExistingDatabase(dbPath);
  // Chunk-8 WI-8.3: usage_events lives in state.db; entries in index.db.
  let stateDb = openStateDatabase();
  // Entries are keyed by the new-grammar `item_ref` post-flip; look them up by
  // the conceptId. The DURABLE state seeded below stays legacy-spelled (the
  // migration input the §11.4 re-key must survive).
  const alphaId = findEntryIdByRef(db, "memories/alpha");
  const betaId = findEntryIdByRef(db, "memories/beta");
  expect(alphaId).toBeNumber();
  expect(betaId).toBeNumber();
  const alphaItemRef = getItemRefById(db, alphaId as number);
  expect(alphaItemRef).toContain("//memories/alpha");

  for (const ev of ["search", "search", "show"] as const) {
    insertUsageEvent(stateDb, { event_type: ev, entry_ref: "memory:alpha", entry_id: alphaId });
  }
  insertUsageEvent(stateDb, { event_type: "search", entry_ref: "memory:beta", entry_id: betaId });
  insertUsageEvent(stateDb, {
    event_type: "feedback",
    signal: "positive",
    entry_ref: "memory:alpha",
    entry_id: alphaId,
  });
  insertUsageEvent(stateDb, {
    event_type: "feedback",
    signal: "negative",
    entry_ref: "memory:alpha",
    entry_id: alphaId,
  });

  // Retrieval + feedback counts BEFORE the rebuild (legacy-keyed).
  const beforeCounts = getRetrievalCounts(db, stateDb, ["memory:alpha", "memory:beta"]);
  expect(beforeCounts.get("memory:alpha")).toBe(3);
  expect(beforeCounts.get("memory:beta")).toBe(1);
  expect(countFeedbackSignals(stateDb, alphaId as number)).toEqual({ pos: 1, neg: 1 });
  closeDatabase(db);
  stateDb.close();

  // FULL REBUILD — entry ids change, entry_ref re-keys onto item_ref, relink.
  await akmIndex({ stashDir, full: true });

  db = openExistingDatabase(dbPath);
  stateDb = openStateDatabase();
  // Entry ids may have changed; resolve afresh (new-grammar conceptId lookup).
  const alphaId2 = findEntryIdByRef(db, "memories/alpha") as number;
  const betaId2 = findEntryIdByRef(db, "memories/beta") as number;

  // Retrieval counts SURVIVE and are still keyed by the caller's ref (the count
  // reader is spelling-agnostic across the re-key).
  const afterCounts = getRetrievalCounts(db, stateDb, ["memory:alpha", "memory:beta"]);
  expect(afterCounts.get("memory:alpha")).toBe(3);
  expect(afterCounts.get("memory:beta")).toBe(1);

  // Feedback SURVIVES via the id relink (entry_id restored on rebuild).
  expect(countFeedbackSignals(stateDb, alphaId2)).toEqual({ pos: 1, neg: 1 });
  void betaId2;

  // The stored spelling is now the fully-qualified item_ref — the durable key.
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
