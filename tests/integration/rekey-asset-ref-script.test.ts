// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Contract for `scripts/rekey-asset-ref.ts` — the maintainer script that
 * carries an asset's earned ranking signal across a rename now that `akm mv`
 * is gone (0.9.0 release-surface review §C3).
 *
 * Exercises the script's EXPORTED function against a real index.db + state.db
 * (built by a real `akmIndex` run, then seeded with the salience / outcome /
 * usage rows a lived-in stash accumulates), mirroring how
 * `tests/integration/registry/registry-build-index.test.ts` tests its own script.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { rekeyAssetRef } from "../../scripts/rekey-asset-ref";
import { readEvents } from "../../src/core/events";
import { getDbPath } from "../../src/core/paths";
import { openStateDatabase } from "../../src/core/state-db";
import { akmIndex } from "../../src/indexer/indexer";
import { closeDatabase, openExistingDatabase } from "../../src/storage/repositories/index-connection";
import { type Cleanup, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

const OLD_NAME = "rekey-old-note";
const NEW_NAME = "rekey-new-note";
const OLD_REF = `memories/${OLD_NAME}`;
const NEW_REF = `memories/${NEW_NAME}`;
const OLD_ITEM_REF = `stash//${OLD_REF}`;
const NEW_ITEM_REF = `stash//${NEW_REF}`;

let cleanup: Cleanup = () => {};
let stashDir = "";

beforeEach(() => {
  const storage = withIsolatedAkmStorage();
  cleanup = storage.cleanup;
  stashDir = storage.stashDir;
  writeSandboxConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: stashDir, writable: true } },
    defaultBundle: "stash",
  });
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

function memoryPath(name: string): string {
  return path.join(stashDir, "memories", `${name}.md`);
}

function writeMemory(name: string): void {
  fs.writeFileSync(
    memoryPath(name),
    `---\ndescription: A note whose ranking history must survive a rename.\n---\n\nBody of ${name}.\n`,
    "utf8",
  );
}

/** Index the stash, then seed the earned-signal rows keyed to `itemRef`. */
async function seedSignalFor(itemRef: string): Promise<number> {
  await akmIndex({ stashDir, full: true });
  const db = openExistingDatabase(getDbPath());
  const row = db.prepare("SELECT id FROM entries WHERE item_ref = ?").get(itemRef) as { id: number } | null;
  closeDatabase(db);
  expect(row?.id).toBeNumber();
  const entryId = row?.id as number;

  const stateDb = openStateDatabase();
  stateDb
    .prepare(
      "INSERT INTO asset_salience (asset_ref, encoding_salience, rank_score, updated_at) VALUES (?, 0.87, 0.77, 1)",
    )
    .run(itemRef);
  stateDb
    .prepare("INSERT INTO asset_outcome (asset_ref, retrieval_count, outcome_score, updated_at) VALUES (?, 5, 0.6, 1)")
    .run(itemRef);
  stateDb
    .prepare(
      "INSERT INTO usage_events (event_type, entry_id, entry_ref, source, created_at) VALUES ('show', ?, ?, 'user', datetime('now'))",
    )
    .run(entryId, itemRef);
  stateDb.close();
  return entryId;
}

function readSignal(itemRef: string): { salience: number; outcome: number; usage: number } {
  const stateDb = openStateDatabase();
  try {
    const one = (sql: string): number => (stateDb.prepare(sql).get(itemRef) as { n: number }).n;
    return {
      salience: one("SELECT COUNT(*) AS n FROM asset_salience WHERE asset_ref = ?"),
      outcome: one("SELECT COUNT(*) AS n FROM asset_outcome WHERE asset_ref = ?"),
      usage: one("SELECT COUNT(*) AS n FROM usage_events WHERE entry_ref = ?"),
    };
  } finally {
    stateDb.close();
  }
}

function indexRowIdFor(itemRef: string): number | undefined {
  const db = openExistingDatabase(getDbPath());
  try {
    return (db.prepare("SELECT id FROM entries WHERE item_ref = ?").get(itemRef) as { id: number } | null)?.id;
  } finally {
    closeDatabase(db);
  }
}

test("re-keys index, salience, outcome, and usage rows onto the new ref (row id preserved)", async () => {
  writeMemory(OLD_NAME);
  const entryId = await seedSignalFor(OLD_ITEM_REF);

  // The rename itself: a plain filesystem move, no `akm index` yet.
  fs.renameSync(memoryPath(OLD_NAME), memoryPath(NEW_NAME));

  const result = rekeyAssetRef(OLD_REF, NEW_REF);
  expect(result.oldRef).toBe(OLD_ITEM_REF);
  expect(result.newRef).toBe(NEW_ITEM_REF);
  expect(result.changed).toEqual({
    indexEntries: 1,
    asset_salience: 1,
    asset_outcome: 1,
    usage_events: 1,
    total: 4,
  });
  // The index has not been rebuilt since the move — that is expected, and warns.
  expect(result.warnings.join(" ")).toContain("not in the index yet");

  // The entries row moved IN PLACE: same row id, so utility_scores/embeddings
  // keyed by entry_id stay attached.
  expect(indexRowIdFor(NEW_ITEM_REF)).toBe(entryId);
  expect(indexRowIdFor(OLD_ITEM_REF)).toBeUndefined();

  expect(readSignal(NEW_ITEM_REF)).toEqual({ salience: 1, outcome: 1, usage: 1 });
  expect(readSignal(OLD_ITEM_REF)).toEqual({ salience: 0, outcome: 0, usage: 0 });

  // Exactly one event records the re-key.
  const events = readEvents({ type: "rekey" }).events;
  expect(events).toHaveLength(1);
  expect(events[0]?.ref).toBe(NEW_ITEM_REF);
  expect(events[0]?.metadata?.from).toBe(OLD_ITEM_REF);
});

test("is idempotent: a second run changes zero rows and appends no second event", async () => {
  writeMemory(OLD_NAME);
  await seedSignalFor(OLD_ITEM_REF);
  fs.renameSync(memoryPath(OLD_NAME), memoryPath(NEW_NAME));

  expect(rekeyAssetRef(OLD_REF, NEW_REF).changed.total).toBe(4);

  const second = rekeyAssetRef(OLD_REF, NEW_REF);
  expect(second.changed).toEqual({
    indexEntries: 0,
    asset_salience: 0,
    asset_outcome: 0,
    usage_events: 0,
    total: 0,
  });
  expect(readSignal(NEW_ITEM_REF)).toEqual({ salience: 1, outcome: 1, usage: 1 });
  expect(readEvents({ type: "rekey" }).events).toHaveLength(1);
});

test("--dry-run reports the would-change counts and writes nothing", async () => {
  writeMemory(OLD_NAME);
  await seedSignalFor(OLD_ITEM_REF);
  fs.renameSync(memoryPath(OLD_NAME), memoryPath(NEW_NAME));

  const result = rekeyAssetRef(OLD_REF, NEW_REF, { dryRun: true });
  expect(result.dryRun).toBe(true);
  expect(result.changed).toEqual({
    indexEntries: 1,
    asset_salience: 1,
    asset_outcome: 1,
    usage_events: 1,
    total: 4,
  });
  // Nothing moved.
  expect(readSignal(OLD_ITEM_REF)).toEqual({ salience: 1, outcome: 1, usage: 1 });
  expect(indexRowIdFor(OLD_ITEM_REF)).toBeNumber();
  expect(readEvents({ type: "rekey" }).events).toHaveLength(0);
});

test("refuses when BOTH files exist — that is a copy, not a rename", async () => {
  writeMemory(OLD_NAME);
  await seedSignalFor(OLD_ITEM_REF);
  writeMemory(NEW_NAME); // copied rather than moved

  expect(() => rekeyAssetRef(OLD_REF, NEW_REF)).toThrow(/COPY, not a rename/);
  // The refusal is total: the original's signal is untouched.
  expect(readSignal(OLD_ITEM_REF)).toEqual({ salience: 1, outcome: 1, usage: 1 });
  expect(readEvents({ type: "rekey" }).events).toHaveLength(0);
});

test("refuses when the old file is still there (the move has not happened yet)", async () => {
  writeMemory(OLD_NAME);
  await seedSignalFor(OLD_ITEM_REF);

  expect(() => rekeyAssetRef(OLD_REF, NEW_REF)).toThrow(/still exists — move the file first/);
});

test("refuses when the new ref resolves nowhere", async () => {
  writeMemory(OLD_NAME);
  await seedSignalFor(OLD_ITEM_REF);
  fs.rmSync(memoryPath(OLD_NAME));

  expect(() => rekeyAssetRef(OLD_REF, NEW_REF)).toThrow(/resolves neither on disk/);
});

test("refuses cross-type and cross-bundle re-keys, and a no-op self re-key", async () => {
  writeMemory(OLD_NAME);
  await seedSignalFor(OLD_ITEM_REF);

  expect(() => rekeyAssetRef(OLD_REF, `knowledge/${NEW_NAME}`)).toThrow(/Cross-type re-key refused/);
  expect(() => rekeyAssetRef(`stash//${OLD_REF}`, `team//${NEW_REF}`)).toThrow(/Cross-bundle re-key refused/);
  expect(() => rekeyAssetRef(OLD_REF, OLD_REF)).toThrow(/same — nothing to re-key/);
});

test("carries state.db signal even when `akm index` already re-minted the entry", async () => {
  writeMemory(OLD_NAME);
  await seedSignalFor(OLD_ITEM_REF);
  fs.renameSync(memoryPath(OLD_NAME), memoryPath(NEW_NAME));
  // The user indexed BEFORE re-keying: the old entries row is gone and a fresh
  // one minted, so only the state.db signal is left to carry.
  await akmIndex({ stashDir, full: true });
  expect(indexRowIdFor(OLD_ITEM_REF)).toBeUndefined();
  expect(indexRowIdFor(NEW_ITEM_REF)).toBeNumber();

  const result = rekeyAssetRef(OLD_REF, NEW_REF);
  expect(result.changed.indexEntries).toBe(0);
  expect(result.changed.asset_salience).toBe(1);
  expect(result.changed.asset_outcome).toBe(1);
  expect(result.warnings).toEqual([]);
  expect(readSignal(NEW_ITEM_REF).salience).toBe(1);
  expect(readSignal(OLD_ITEM_REF)).toEqual({ salience: 0, outcome: 0, usage: 0 });
});
