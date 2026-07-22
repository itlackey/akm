// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getLastUseMsByRef } from "../../src/commands/improve/salience";
import { recomputeUtilityScores } from "../../src/indexer/indexer";
import { ensureUsageEventsSchema } from "../../src/indexer/usage/usage-events";
import type { Database as AkmDatabase } from "../../src/storage/database";
import { openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../src/storage/repositories/index-entries-repository";
import { getRetrievalCounts, upsertUtilityScore } from "../../src/storage/repositories/index-utility-repository";

/**
 * Unit coverage for getRetrievalCounts (db.ts).
 *
 * Pins the bug-fix behaviour:
 *   1. stash-prefixed (`origin//type:name`) and bare (`type:name`) stored
 *      entry_ref spellings both match a bare input ref (and aggregate together).
 *   2. `curate` events count alongside `search` / `show`.
 *   3. NULL entry_ref rows (legacy curate summary rows) contribute nothing.
 *   4. Non-demand events (source = audit/improve/task/unknown) are EXCLUDED —
 *      this count feeds salience/ranking and pipeline probe traffic must not
 *      register as demand (meta-review 05 DRIFT-6).
 */
describe("getRetrievalCounts", () => {
  // Chunk-8 WI-8.3: usage_events lives in state.db; entries/utility_scores in
  // index.db. getRetrievalCounts takes both handles.
  let db: AkmDatabase;
  let stateDb: AkmDatabase;

  beforeEach(() => {
    db = openIndexDatabase(":memory:");
    stateDb = new Database(":memory:") as unknown as AkmDatabase;
    ensureUsageEventsSchema(stateDb);
  });

  afterEach(() => {
    db.close();
    stateDb.close();
  });

  function seed(eventType: string, entryRef: string | null, source = "user", entryId?: number): void {
    stateDb
      .prepare("INSERT INTO usage_events (event_type, entry_ref, source, entry_id) VALUES (?, ?, ?, ?)")
      .run(eventType, entryRef, source, entryId ?? null);
  }

  test("matches both bare and stash-prefixed stored refs for a bare input ref", () => {
    seed("search", "lesson:a"); // bare
    seed("show", "local//lesson:a"); // stash-prefixed, same asset
    seed("search", "owner/repo//lesson:a"); // registry-prefixed, same asset

    const counts = getRetrievalCounts(db, stateDb, ["lesson:a"]);
    // All three rows collapse onto the single bare input ref.
    expect(counts.get("lesson:a")).toBe(3);
  });

  test("matches a stash-prefixed input ref against a bare stored ref", () => {
    seed("show", "lesson:b"); // stored bare
    const counts = getRetrievalCounts(db, stateDb, ["local//lesson:b"]);
    expect(counts.get("local//lesson:b")).toBe(1);
  });

  test("counts curate events alongside search and show", () => {
    seed("search", "skill:deploy");
    seed("show", "skill:deploy");
    seed("curate", "skill:deploy");
    seed("feedback", "skill:deploy"); // must NOT be counted

    const counts = getRetrievalCounts(db, stateDb, ["skill:deploy"]);
    expect(counts.get("skill:deploy")).toBe(3);
  });

  test("ignores rows with a NULL entry_ref (legacy curate summary rows)", () => {
    seed("curate", null);
    seed("curate", null);
    seed("curate", "command:release"); // the only counted curate row

    const counts = getRetrievalCounts(db, stateDb, ["command:release"]);
    expect(counts.get("command:release")).toBe(1);
  });

  test("returns no entry for refs with no matching events", () => {
    seed("search", "lesson:present");
    const counts = getRetrievalCounts(db, stateDb, ["lesson:absent"]);
    expect(counts.has("lesson:absent")).toBe(false);
  });

  test("empty input returns an empty map", () => {
    expect(getRetrievalCounts(db, stateDb, []).size).toBe(0);
  });

  test("excludes audit, improve, task, and unknown events from demand counts", () => {
    seed("search", "skill:probe", "user");
    seed("search", "skill:probe", "improve"); // improve-loop probe — excluded
    seed("curate", "skill:probe", "task"); // task-runner traffic — excluded
    seed("show", "skill:probe", "audit"); // eval traffic — excluded
    seed("show", "skill:probe", "unknown"); // unattributed traffic — excluded

    const counts = getRetrievalCounts(db, stateDb, ["skill:probe"]);
    expect(counts.get("skill:probe")).toBe(1);
  });

  test("a ref retrieved ONLY by the pipeline registers no demand at all", () => {
    seed("search", "lesson:machine-only", "improve");
    seed("show", "lesson:machine-only", "task");

    const counts = getRetrievalCounts(db, stateDb, ["lesson:machine-only"]);
    expect(counts.has("lesson:machine-only")).toBe(false);
  });

  test("only explicit user provenance counts as demand", () => {
    seed("show", "agent:reviewer", "hook");

    const counts = getRetrievalCounts(db, stateDb, ["agent:reviewer"]);
    expect(counts.has("agent:reviewer")).toBe(false);
  });

  test("utility recomputation excludes audit and unattributed events", () => {
    const stashDir = "/tmp/utility-source";
    const entryId = upsertEntry(
      db,
      `${stashDir}:skill:probe`,
      `${stashDir}/skills`,
      `${stashDir}/skills/probe.md`,
      stashDir,
      { type: "skill", name: "probe" } as never,
      "probe",
    );
    seed("search", "skills/probe", "user", entryId);
    seed("show", "skills/probe", "user", entryId);
    seed("search", "skills/probe", "audit", entryId);
    seed("show", "skills/probe", "unknown", entryId);

    recomputeUtilityScores(db, stateDb);

    const row = db.prepare("SELECT search_count, show_count FROM utility_scores WHERE entry_id = ?").get(entryId) as {
      search_count: number;
      show_count: number;
    };
    expect(row).toEqual({ search_count: 1, show_count: 1 });
  });

  test("utility recomputation decays and resets entries omitted by the user-only aggregate", () => {
    const stashDir = "/tmp/utility-omitted-source";
    const entryId = upsertEntry(
      db,
      `${stashDir}:skill:probe`,
      `${stashDir}/skills`,
      `${stashDir}/skills/probe.md`,
      stashDir,
      { type: "skill", name: "probe" } as never,
      "probe",
    );
    upsertUtilityScore(db, entryId, {
      utility: 1,
      showCount: 5,
      searchCount: 5,
      selectRate: 1,
      lastUsedAt: "2026-01-01T00:00:00.000Z",
    });
    seed("search", "skills/probe", "hook", entryId);
    seed("show", "skills/probe", "hook", entryId);

    recomputeUtilityScores(db, stateDb);

    const row = db
      .prepare("SELECT utility, search_count, show_count, select_rate FROM utility_scores WHERE entry_id = ?")
      .get(entryId) as { utility: number; search_count: number; show_count: number; select_rate: number };
    expect(row.utility).toBeLessThan(1);
    expect(row).toMatchObject({ search_count: 0, show_count: 0, select_rate: 0 });
  });

  test("source-scoped counts exclude duplicate signals from other origins and legacy bare rows", () => {
    seed("show", "team//skill:duplicate");
    seed("search", "team//skill:duplicate");
    seed("show", "readonly//skill:duplicate");
    seed("show", "skill:duplicate");

    const scoped = (
      getRetrievalCounts as unknown as (
        indexDatabase: AkmDatabase,
        stateDatabase: AkmDatabase,
        refs: string[],
        options: { sourceName: string },
      ) => Map<string, number>
    )(db, stateDb, ["skill:duplicate"], { sourceName: "team" });

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
    )(db, ["skills/duplicate"], selectedRoot);

    expect(recency.get("skills/duplicate")).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
  });
});
