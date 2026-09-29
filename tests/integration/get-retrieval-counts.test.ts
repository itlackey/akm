// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getLastUseMsByRef } from "../../src/commands/improve/salience";
import { recomputeUtilityScores } from "../../src/indexer/indexer";
import { deriveEntryProvenance } from "../../src/indexer/installations";
import { ensureUsageEventsSchema } from "../../src/indexer/usage/usage-events";
import type { Database as AkmDatabase } from "../../src/storage/database";
import { openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../src/storage/repositories/index-entries-repository";
import { getRetrievalCounts, upsertUtilityScore } from "../../src/storage/repositories/index-utility-repository";

/**
 * Unit coverage for getRetrievalCounts (db.ts).
 *
 * Pins current durable-ref behaviour:
 *   1. bundle-qualified conceptId rows match current input refs; bare stored
 *      rows do not.
 *   2. `curate` events count alongside `search` / `show`.
 *   3. NULL entry_ref summary rows contribute nothing.
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

  test("matches qualified conceptId rows and ignores a bare stored ref", () => {
    seed("search", "lessons/a");
    seed("show", "stash//lessons/a");
    seed("search", "team//lessons/a");

    const counts = getRetrievalCounts(db, stateDb, ["lessons/a"]);
    expect(counts.get("lessons/a")).toBe(2);
  });

  test("does not match a qualified input ref against a bare stored ref", () => {
    seed("show", "lessons/b");
    const counts = getRetrievalCounts(db, stateDb, ["stash//lessons/b"]);
    expect(counts.has("stash//lessons/b")).toBe(false);
  });

  test("counts curate events alongside search and show", () => {
    seed("search", "stash//skills/deploy");
    seed("show", "stash//skills/deploy");
    seed("curate", "stash//skills/deploy");
    seed("feedback", "stash//skills/deploy"); // must NOT be counted

    const counts = getRetrievalCounts(db, stateDb, ["skills/deploy"]);
    expect(counts.get("skills/deploy")).toBe(3);
  });

  test("ignores rows with a NULL entry_ref", () => {
    seed("curate", null);
    seed("curate", null);
    seed("curate", "stash//commands/release"); // the only counted curate row

    const counts = getRetrievalCounts(db, stateDb, ["commands/release"]);
    expect(counts.get("commands/release")).toBe(1);
  });

  test("matches an opaque adapter conceptId (Q-07/D11 — a leading segment outside AKM's own placement dirs)", () => {
    // "tables" is not an AKM placement stash-subdir (skills/, knowledge/, …),
    // so `bareRefCandidates` must reconstruct the FULL "tables/customers"
    // conceptId — not just "customers" — to match these stored rows. Before
    // the D11 parser-seam fix this silently under-counted (or, upstream in the
    // proposals/tasks/graph/improve consumers, threw at the parser boundary).
    seed("search", "adversarial//tables/customers");
    seed("show", "adversarial//tables/customers");

    const counts = getRetrievalCounts(db, stateDb, ["tables/customers"]);
    expect(counts.get("tables/customers")).toBe(2);
  });

  test("returns no entry for refs with no matching events", () => {
    seed("search", "stash//lessons/present");
    const counts = getRetrievalCounts(db, stateDb, ["lessons/absent"]);
    expect(counts.has("lessons/absent")).toBe(false);
  });

  test("empty input returns an empty map", () => {
    expect(getRetrievalCounts(db, stateDb, []).size).toBe(0);
  });

  test("excludes audit, improve, task, and unknown events from demand counts", () => {
    seed("search", "stash//skills/probe", "user");
    seed("search", "stash//skills/probe", "improve"); // improve-loop probe — excluded
    seed("curate", "stash//skills/probe", "task"); // task-runner traffic — excluded
    seed("show", "stash//skills/probe", "audit"); // eval traffic — excluded
    seed("show", "stash//skills/probe", "unknown"); // unattributed traffic — excluded

    const counts = getRetrievalCounts(db, stateDb, ["skills/probe"]);
    expect(counts.get("skills/probe")).toBe(1);
  });

  test("a ref retrieved ONLY by the pipeline registers no demand at all", () => {
    seed("search", "stash//lessons/machine-only", "improve");
    seed("show", "stash//lessons/machine-only", "task");

    const counts = getRetrievalCounts(db, stateDb, ["lessons/machine-only"]);
    expect(counts.has("lessons/machine-only")).toBe(false);
  });

  test("only explicit user provenance counts as demand", () => {
    seed("show", "stash//agents/reviewer", "hook");

    const counts = getRetrievalCounts(db, stateDb, ["agents/reviewer"]);
    expect(counts.has("agents/reviewer")).toBe(false);
  });

  test("utility recomputation excludes audit and unattributed events", () => {
    const stashDir = "/tmp/utility-source";
    const entryId = upsertEntry(
      db,
      `${stashDir}/skills/probe.md`,
      { type: "skill", name: "probe" } as never,
      deriveEntryProvenance({ bundleId: "utility", componentId: "utility", adapterId: "akm" }, "skill", "probe"),
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
      `${stashDir}/skills/probe.md`,
      { type: "skill", name: "probe" } as never,
      deriveEntryProvenance({ bundleId: "omitted", componentId: "omitted", adapterId: "akm" }, "skill", "probe"),
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

  test("source-scoped counts exclude duplicate signals from other bundles and bare rows", () => {
    seed("show", "team//skills/duplicate");
    seed("search", "team//skills/duplicate");
    seed("show", "readonly//skills/duplicate");
    seed("show", "skills/duplicate");

    const scoped = (
      getRetrievalCounts as unknown as (
        indexDatabase: AkmDatabase,
        stateDatabase: AkmDatabase,
        refs: string[],
        options: { sourceName: string },
      ) => Map<string, number>
    )(db, stateDb, ["skills/duplicate"], { sourceName: "team" });

    expect(scoped.get("skills/duplicate")).toBe(2);
  });

  test("last-use recency does not select a nested bundle through the requested source root", () => {
    db.close();
    db = openIndexDatabase(":memory:");
    const selectedRoot = "/tmp/selected-source";
    const otherRoot = `${selectedRoot}/.read-only-bundle`;
    const selectedId = upsertEntry(
      db,
      `${selectedRoot}/skills/duplicate.md`,
      { type: "skill", name: "duplicate" } as never,
      deriveEntryProvenance({ bundleId: "selected", componentId: "selected", adapterId: "akm" }, "skill", "duplicate"),
    );
    const otherId = upsertEntry(
      db,
      `${otherRoot}/skills/duplicate.md`,
      { type: "skill", name: "duplicate" } as never,
      deriveEntryProvenance({ bundleId: "other", componentId: "other", adapterId: "akm" }, "skill", "duplicate"),
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

    const recency = getLastUseMsByRef(db, [{ ref: "skills/duplicate", itemRef: "selected//skills/duplicate" }]);

    expect(recency.get("skills/duplicate")).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
  });
});
