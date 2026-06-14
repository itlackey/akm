// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getRetrievalCounts } from "../src/indexer/db/db";
import { ensureUsageEventsSchema } from "../src/indexer/usage/usage-events";
import type { Database as AkmDatabase } from "../src/storage/database";

/**
 * Unit coverage for getRetrievalCounts (db.ts).
 *
 * Pins the bug-fix behaviour:
 *   1. stash-prefixed (`origin//type:name`) and bare (`type:name`) stored
 *      entry_ref spellings both match a bare input ref (and aggregate together).
 *   2. `curate` events count alongside `search` / `show`.
 *   3. NULL entry_ref rows (legacy curate summary rows) contribute nothing.
 */
describe("getRetrievalCounts", () => {
  let db: AkmDatabase;

  beforeEach(() => {
    db = new Database(":memory:") as unknown as AkmDatabase;
    ensureUsageEventsSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function seed(eventType: string, entryRef: string | null): void {
    db.prepare("INSERT INTO usage_events (event_type, entry_ref, source) VALUES (?, ?, 'user')").run(
      eventType,
      entryRef,
    );
  }

  test("matches both bare and stash-prefixed stored refs for a bare input ref", () => {
    seed("search", "lesson:a"); // bare
    seed("show", "local//lesson:a"); // stash-prefixed, same asset
    seed("search", "owner/repo//lesson:a"); // registry-prefixed, same asset

    const counts = getRetrievalCounts(db, ["lesson:a"]);
    // All three rows collapse onto the single bare input ref.
    expect(counts.get("lesson:a")).toBe(3);
  });

  test("matches a stash-prefixed input ref against a bare stored ref", () => {
    seed("show", "lesson:b"); // stored bare
    const counts = getRetrievalCounts(db, ["local//lesson:b"]);
    expect(counts.get("local//lesson:b")).toBe(1);
  });

  test("counts curate events alongside search and show", () => {
    seed("search", "skill:deploy");
    seed("show", "skill:deploy");
    seed("curate", "skill:deploy");
    seed("feedback", "skill:deploy"); // must NOT be counted

    const counts = getRetrievalCounts(db, ["skill:deploy"]);
    expect(counts.get("skill:deploy")).toBe(3);
  });

  test("ignores rows with a NULL entry_ref (legacy curate summary rows)", () => {
    seed("curate", null);
    seed("curate", null);
    seed("curate", "command:release"); // the only counted curate row

    const counts = getRetrievalCounts(db, ["command:release"]);
    expect(counts.get("command:release")).toBe(1);
  });

  test("returns no entry for refs with no matching events", () => {
    seed("search", "lesson:present");
    const counts = getRetrievalCounts(db, ["lesson:absent"]);
    expect(counts.has("lesson:absent")).toBe(false);
  });

  test("empty input returns an empty map", () => {
    expect(getRetrievalCounts(db, []).size).toBe(0);
  });
});
