// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getLastUseMsByRef } from "../../src/commands/improve/salience";
import { getRetrievalCounts, openIndexDatabase, upsertEntry, upsertUtilityScore } from "../../src/indexer/db/db";
import type { Database as AkmDatabase } from "../../src/storage/database";

/**
 * Unit coverage for getRetrievalCounts (db.ts).
 *
 * Pins the bug-fix behaviour:
 *   1. stash-prefixed (`origin//type:name`) and bare (`type:name`) stored
 *      entry_ref spellings both match a bare input ref (and aggregate together).
 *   2. `curate` events count alongside `search` / `show`.
 *   3. NULL entry_ref rows (legacy curate summary rows) contribute nothing.
 *   4. Machine-sourced events (source = 'improve' or 'task') are EXCLUDED —
 *      this count feeds salience/ranking and pipeline probe traffic must not
 *      register as demand (meta-review 05 DRIFT-6).
 */
describe("getRetrievalCounts", () => {
  let db: AkmDatabase;

  beforeEach(() => {
    db = openIndexDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  function seed(eventType: string, entryRef: string | null, source = "user"): void {
    db.prepare("INSERT INTO usage_events (event_type, entry_ref, source) VALUES (?, ?, ?)").run(
      eventType,
      entryRef,
      source,
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

  test("excludes machine-sourced events (improve, task) from counts", () => {
    seed("search", "skill:probe", "user");
    seed("search", "skill:probe", "improve"); // improve-loop probe — excluded
    seed("curate", "skill:probe", "task"); // task-runner traffic — excluded

    const counts = getRetrievalCounts(db, ["skill:probe"]);
    expect(counts.get("skill:probe")).toBe(1);
  });

  test("a ref retrieved ONLY by the pipeline registers no demand at all", () => {
    seed("search", "lesson:machine-only", "improve");
    seed("show", "lesson:machine-only", "task");

    const counts = getRetrievalCounts(db, ["lesson:machine-only"]);
    expect(counts.has("lesson:machine-only")).toBe(false);
  });

  test("unknown future sources count as demand (exclusion list, not allowlist)", () => {
    // e.g. a later 'hook' source for agent-session traffic must keep counting.
    seed("show", "agent:reviewer", "hook");

    const counts = getRetrievalCounts(db, ["agent:reviewer"]);
    expect(counts.get("agent:reviewer")).toBe(1);
  });

  test("source-scoped counts exclude duplicate signals from other origins and legacy bare rows", () => {
    seed("show", "team//skill:duplicate");
    seed("search", "team//skill:duplicate");
    seed("show", "readonly//skill:duplicate");
    seed("show", "skill:duplicate");

    const scoped = (
      getRetrievalCounts as unknown as (
        database: AkmDatabase,
        refs: string[],
        options: { sourceName: string },
      ) => Map<string, number>
    )(db, ["skill:duplicate"], { sourceName: "team" });

    expect(scoped.get("skill:duplicate")).toBe(2);
  });

  test("last-use recency selects the duplicate from the requested source root", () => {
    db.close();
    db = openIndexDatabase(":memory:");
    const selectedRoot = "/tmp/selected-source";
    const otherRoot = "/tmp/other-source";
    const selectedId = upsertEntry(
      db,
      `${selectedRoot}:skill:duplicate`,
      `${selectedRoot}/skills`,
      `${selectedRoot}/skills/duplicate.md`,
      selectedRoot,
      { type: "skill", name: "duplicate" } as never,
      "selected",
    );
    const otherId = upsertEntry(
      db,
      `${otherRoot}:skill:duplicate`,
      `${otherRoot}/skills`,
      `${otherRoot}/skills/duplicate.md`,
      otherRoot,
      { type: "skill", name: "duplicate" } as never,
      "other",
    );
    upsertUtilityScore(db, selectedId, {
      utility: 1,
      showCount: 1,
      searchCount: 0,
      selectRate: 0,
      lastUsedAt: "2026-01-01T00:00:00.000Z",
    });
    upsertUtilityScore(db, otherId, {
      utility: 1,
      showCount: 1,
      searchCount: 0,
      selectRate: 0,
      lastUsedAt: "2026-06-01T00:00:00.000Z",
    });

    const recency = (
      getLastUseMsByRef as unknown as (database: AkmDatabase, refs: string[], stashDir: string) => Map<string, number>
    )(db, ["skill:duplicate"], selectedRoot);

    expect(recency.get("skill:duplicate")).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
  });
});
