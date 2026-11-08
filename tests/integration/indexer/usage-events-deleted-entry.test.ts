// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #1509: search/curate/nested-show events are written with `entry_ref` only
 * (`entry_id` null until the next index). Deleting the entry must delete those
 * events too, while a re-indexed entry keeps them.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getDbPath } from "../../../src/core/paths";
import { openStateDatabase } from "../../../src/core/state-db";
import { akmIndex } from "../../../src/indexer/indexer";
import { insertUsageEvent } from "../../../src/indexer/usage/usage-events";
import { closeDatabase, openExistingDatabase } from "../../../src/storage/repositories/index-connection";
import {
  deleteEntriesByIds,
  findEntryIdByRef,
  getItemRefById,
} from "../../../src/storage/repositories/index-entries-repository";
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

function writeMemory(name: string, body: string): string {
  const file = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\ndescription: ${name}\n---\n${body}\n`, "utf8");
  return file;
}

function eventCount(ref: string): number {
  const stateDb = openStateDatabase();
  try {
    return (stateDb.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE entry_ref = ?").get(ref) as { n: number }).n;
  } finally {
    stateDb.close();
  }
}

/** Index, then record one search event with entry_id left null (as search does). */
async function indexAndRecordDetachedEvent(name: string): Promise<string> {
  await akmIndex({ stashDir, full: true });
  const db = openExistingDatabase(getDbPath());
  const id = findEntryIdByRef(db, `memories/${name}`) as number;
  const itemRef = getItemRefById(db, id) as string;
  closeDatabase(db);
  const stateDb = openStateDatabase();
  insertUsageEvent(stateDb, { event_type: "search", entry_ref: itemRef, source: "user" });
  stateDb.close();
  expect(eventCount(itemRef)).toBe(1);
  return itemRef;
}

test("deleting an asset deletes its not-yet-linked events; a new asset at the same ref starts clean", async () => {
  const file = writeMemory("alpha", "Alpha body about caching.");
  const ref = await indexAndRecordDetachedEvent("alpha");

  fs.rmSync(file);
  await akmIndex({ stashDir });
  expect(eventCount(ref)).toBe(0);

  writeMemory("alpha", "A different alpha.");
  await akmIndex({ stashDir });
  expect(eventCount(ref)).toBe(0);
});

test("re-indexing an edited or unchanged asset keeps its not-yet-linked events", async () => {
  writeMemory("alpha", "Alpha body about caching.");
  const ref = await indexAndRecordDetachedEvent("alpha");

  await akmIndex({ stashDir });
  expect(eventCount(ref)).toBe(1);

  writeMemory("alpha", "Alpha body, edited.");
  await akmIndex({ stashDir });
  expect(eventCount(ref)).toBe(1);
});

test("deleting a sibling does not touch another asset's events", async () => {
  writeMemory("alpha", "Alpha body.");
  const beta = writeMemory("beta", "Beta body.");
  const alphaRef = await indexAndRecordDetachedEvent("alpha");

  fs.rmSync(beta);
  await akmIndex({ stashDir });
  expect(eventCount(alphaRef)).toBe(1);
});

test("deleteEntriesByIds (index --clean path) also deletes not-yet-linked events", async () => {
  writeMemory("alpha", "Alpha body.");
  const ref = await indexAndRecordDetachedEvent("alpha");
  const db = openExistingDatabase(getDbPath());
  deleteEntriesByIds(db, [findEntryIdByRef(db, "memories/alpha") as number]);
  closeDatabase(db);
  expect(eventCount(ref)).toBe(0);
});

test("a ref re-inserted by another file in the same run keeps its not-yet-linked events", async () => {
  // `notes/demo.md` and `notes/demo/SKILL.md` claim one ref; the first holds it.
  const note = path.join(stashDir, "notes", "demo.md");
  const skill = path.join(stashDir, "notes", "demo", "SKILL.md");
  for (const [file, body] of [
    [note, "from note"],
    [skill, "from skill"],
  ] as const) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\ndescription: ${body}\n---\n\n# ${body}\n`, "utf8");
  }
  await akmIndex({ stashDir, full: true });
  const db = openExistingDatabase(getDbPath());
  const itemRef = getItemRefById(db, findEntryIdByRef(db, "notes/demo") as number) as string;
  closeDatabase(db);
  const stateDb = openStateDatabase();
  insertUsageEvent(stateDb, { event_type: "search", entry_ref: itemRef, source: "user" });
  stateDb.close();

  fs.rmSync(note);
  await akmIndex({ stashDir });
  expect(eventCount(itemRef)).toBe(1);
});
