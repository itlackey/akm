// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #733 — orphan-GC pass for unresolvable `asset_salience` / `asset_outcome`
 * state rows (Workstream C, docs/architecture/specs/0.9.0-close-out-plan.md).
 *
 * The pass is deliberately lean: one maintenance pass (`runOrphanStateGcPass`),
 * one additive migration (`021-asset-state-missing-since`), one event type
 * (`asset_state_gc`), one config gate (`improve.stateGc.collect`, default
 * false). These tests exercise `runOrphanStateGcPass` directly — the same
 * "focused unit coverage, injected db handles, no LLM" style as
 * `tests/commands/improve/improve-maintenance-passes.test.ts` — rather than
 * driving a full `akmImprove()` run, so the correctness of the resolution
 * logic and the grace/collect gate is asserted without indexer/LLM overhead.
 *
 * `entries` rows are inserted directly (bypassing `akmIndex`) so each test
 * controls precisely which refs resolve — a real `akmIndex` run would still
 * populate the same `item_ref` column this pass reads, just with more moving
 * parts (markdown parsing, embeddings) that add nothing to what's under test
 * here.
 *
 * Per scripts/lint-tests-isolation.ts Rule 3, the grace-window test seeds an
 * OLD `missing_since` value directly instead of sleeping — no wall-clock
 * dependency.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  type IndexDbCell,
  type MaintenanceCtx,
  runOrphanStateGcPass,
  STATE_GC_GRACE_MS,
} from "../../../../src/commands/improve/loop-stages";
import type { AkmConfig } from "../../../../src/core/config/config";
import { readEvents } from "../../../../src/core/events";
import { getDbPath } from "../../../../src/core/paths";
import { getStateDbPath, openStateDatabase, withStateDb } from "../../../../src/core/state-db";
import type { Database } from "../../../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../../src/storage/repositories/index-entries-repository";
import { countAssetOutcomeMissing, upsertAssetOutcome } from "../../../../src/storage/repositories/outcome-repository";
import {
  countAssetSalienceMissing,
  listAssetSalienceMissingState,
  stampAssetSalienceMissing,
  upsertAssetSalience,
} from "../../../../src/storage/repositories/salience-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

/** Minimal salience vector for `upsertAssetSalience` fixture writes. */
const FIXTURE_VECTOR = { encoding: 0.5, outcome: 0, retrieval: 0.2, rankScore: 0.4 };

/** Minimal `asset_outcome` upsert values, keyed only by `ref`. */
function fixtureOutcomeValues(ref: string) {
  return {
    ref,
    lastRetrievedAt: Date.now(),
    retrievalCount: 3,
    expectedRetrievalRate: 1,
    negativeFeedbackCount: 0,
    acceptedChangeCount: 0,
    outcomeScore: 0.1,
    updatedAt: Date.now(),
  };
}

/** Bundle used to qualify bare fixture refs into durable `item_ref` spellings. */
const FIXTURE_BUNDLE = "fixture";

/**
 * Insert a live `entries` row. A bare `conceptId` is bundle-qualified first,
 * because `item_ref` is the DURABLE, fully-qualified identity
 * (`<bundle>//<conceptId>`, spec §11.1 D-R3) — production never stores a bare
 * non-null `item_ref`, and `findEntryIdByBundleRef` resolves a bare lookup key
 * by `//conceptId` SUFFIX match, which cannot match an unqualified stored
 * value. Storing a bare `item_ref` here would make the fixture unresolvable in
 * a way no real index row is. Callers that pass an already-qualified ref (the
 * qualified case) get it through verbatim.
 */
function insertLiveEntry(indexDb: Database, itemRef: string): void {
  const storedRef = itemRef.includes("//") ? itemRef : `${FIXTURE_BUNDLE}//${itemRef}`;
  const [bundleId, conceptId] = storedRef.split("//", 2) as [string, string];
  const name = conceptId.split("/").at(-1) ?? conceptId;
  upsertEntry(indexDb, `/fixture/dir/${name}.md`, { name, type: "memory" }, storedRef, {
    itemRef: storedRef,
    bundleId,
    componentId: bundleId,
    conceptId,
    adapterId: "akm",
  });
}

function openIndex(): Database {
  return openIndexDatabase(getDbPath());
}

function makeCtx(overrides: Partial<MaintenanceCtx> = {}): MaintenanceCtx {
  return {
    config: {} as AkmConfig,
    sources: [],
    primaryStashDir: storage.stashDir,
    memoryInferenceFn: () => {
      throw new Error("memoryInferenceFn not expected in this scenario");
    },
    graphExtractionFn: () => {
      throw new Error("graphExtractionFn not expected in this scenario");
    },
    reindexWithIndexDbReleased: () => {
      throw new Error("reindex not expected in this scenario");
    },
    ...overrides,
  };
}

/** `makeCtx` with `improve.stateGc.collect` pinned to `collect`. */
function ctxWithCollect(collect: boolean): MaintenanceCtx {
  return makeCtx({ config: { improve: { stateGc: { collect } } } as AkmConfig });
}

describe("runOrphanStateGcPass", () => {
  test("an orphaned ref is stamped, not deleted, on first sighting", () => {
    withStateDb((db) => upsertAssetSalience(db, "memories/gone", FIXTURE_VECTOR));
    const indexDb = openIndex(); // no entries row at all for memories/gone — a genuine orphan
    try {
      const out = runOrphanStateGcPass(ctxWithCollect(false), { current: indexDb });
      expect(out.pending).toBe(1);
      expect(out.collected).toBe(0);
      expect(out.warnings).toEqual([]);

      withStateDb((db) => {
        const row = listAssetSalienceMissingState(db).find((r) => r.asset_ref === "memories/gone");
        expect(row).toBeDefined();
        expect(row?.missing_since).not.toBeNull();
        expect(typeof row?.missing_since).toBe("number");
      });
    } finally {
      closeDatabase(indexDb);
    }
  });

  // r3-1: getLiveRefSnapshot's `SELECT item_ref FROM entries` used to run
  // OUTSIDE this pass's try/catch, so a schema mismatch (e.g. a DB version
  // upgrade that dropped `entries` — the case improve.ts's #339 comment
  // names) escaped as a throw instead of degrading to the same
  // "orphan state GC failed: …" warning every other failure in this pass
  // produces.
  test("a missing entries table degrades to a warning instead of throwing", () => {
    withStateDb((db) => upsertAssetSalience(db, "memories/gone", FIXTURE_VECTOR));
    const indexDb = openIndex();
    indexDb.exec("DROP TABLE entries");
    try {
      const out = runOrphanStateGcPass(ctxWithCollect(false), { current: indexDb });
      expect(out.pending).toBe(0);
      expect(out.collected).toBe(0);
      expect(out.warnings).toHaveLength(1);
      expect(out.warnings[0]).toContain("orphan state GC failed");
    } finally {
      closeDatabase(indexDb);
    }
  });

  test("a stamped orphan is deleted only after the grace window elapses AND collect is true", () => {
    const ref = "memories/gone-stale";
    withStateDb((db) => {
      upsertAssetSalience(db, ref, FIXTURE_VECTOR);
      // Seed an OLD missing_since (grace + 1 minute ago) directly — no sleep.
      stampAssetSalienceMissing(db, [ref], Date.now() - STATE_GC_GRACE_MS - 60_000);
    });
    const indexDb = openIndex(); // still unresolved this run

    try {
      const out = runOrphanStateGcPass(ctxWithCollect(true), { current: indexDb });
      expect(out.collected).toBe(1);
      expect(out.pending).toBe(0);

      withStateDb((db) => {
        expect(listAssetSalienceMissingState(db).find((r) => r.asset_ref === ref)).toBeUndefined();
      });
    } finally {
      closeDatabase(indexDb);
    }
  });

  test("a stamped orphan INSIDE the grace window is left alone even with collect: true", () => {
    const ref = "memories/gone-fresh";
    withStateDb((db) => {
      upsertAssetSalience(db, ref, FIXTURE_VECTOR);
      // Stamped one minute ago — well inside the 7-day grace window.
      stampAssetSalienceMissing(db, [ref], Date.now() - 60_000);
    });
    const indexDb = openIndex();

    try {
      const out = runOrphanStateGcPass(ctxWithCollect(true), { current: indexDb });
      expect(out.collected).toBe(0);
      expect(out.pending).toBe(1);

      withStateDb((db) => {
        expect(listAssetSalienceMissingState(db).find((r) => r.asset_ref === ref)).toBeDefined();
      });
    } finally {
      closeDatabase(indexDb);
    }
  });

  test("default config (collect absent) never deletes, even past the grace window — counts are still reported", () => {
    const ref = "memories/gone-default";
    withStateDb((db) => {
      upsertAssetSalience(db, ref, FIXTURE_VECTOR);
      stampAssetSalienceMissing(db, [ref], Date.now() - STATE_GC_GRACE_MS - 60_000);
    });
    const indexDb = openIndex();

    try {
      // config.improve.stateGc is entirely absent — the documented default.
      const out = runOrphanStateGcPass(makeCtx({ config: {} as AkmConfig }), { current: indexDb });
      expect(out.collected).toBe(0);
      expect(out.pending).toBe(1);

      withStateDb((db) => {
        expect(countAssetSalienceMissing(db)).toBe(1);
      });
    } finally {
      closeDatabase(indexDb);
    }
  });

  test("a live asset whose state row carries a legacy (bare) ref spelling is not a candidate", () => {
    const bundleQualifiedItemRef = "mystash//memories/legacy-alpha";
    const legacyBareForm = "memories/legacy-alpha";
    withStateDb((db) => upsertAssetSalience(db, legacyBareForm, FIXTURE_VECTOR));

    const indexDb = openIndex();
    try {
      // The LIVE entry is stored under the bundle-qualified item_ref; the
      // state row only carries the bare conceptId (an older/legacy write
      // spelling — AGENTS.md: "the short bundle-omitted form is input sugar").
      // A naive `asset_ref NOT IN (SELECT item_ref FROM entries)` would flag
      // this row as an orphan because the strings differ; the per-ref
      // getEntryByRef probe (which suffix-matches a bare conceptId across
      // bundles) must not.
      insertLiveEntry(indexDb, bundleQualifiedItemRef);
      expect(bundleQualifiedItemRef).not.toBe(legacyBareForm); // sanity: genuinely different spellings

      const out = runOrphanStateGcPass(ctxWithCollect(true), { current: indexDb });
      expect(out.pending).toBe(0);
      expect(out.collected).toBe(0);

      withStateDb((db) => {
        const row = listAssetSalienceMissingState(db).find((r) => r.asset_ref === legacyBareForm);
        expect(row?.missing_since).toBeNull();
      });
    } finally {
      closeDatabase(indexDb);
    }
  });

  test("a ref that resolves again after being stamped has missing_since cleared", () => {
    const ref = "memories/flip-flop";
    withStateDb((db) => {
      upsertAssetSalience(db, ref, FIXTURE_VECTOR);
      stampAssetSalienceMissing(db, [ref], Date.now() - 1_000); // stamped recently, well inside grace
    });

    const indexDb = openIndex();
    try {
      insertLiveEntry(indexDb, ref); // the asset is live again this run — auto-qualified to a durable item_ref

      const out = runOrphanStateGcPass(ctxWithCollect(true), { current: indexDb });
      expect(out.pending).toBe(0);
      expect(out.collected).toBe(0);

      withStateDb((db) => {
        const row = listAssetSalienceMissingState(db).find((r) => r.asset_ref === ref);
        expect(row).toBeDefined();
        expect(row?.missing_since).toBeNull();
      });
    } finally {
      closeDatabase(indexDb);
    }
  });

  test("a source whose scan did not complete contributes no candidates (entries row preserved)", () => {
    // Models indexer.ts's preserveExistingIndex / scanComplete gate
    // (~1195-1199): when a source's walk does not complete, its
    // last-known-good `entries` rows are left untouched rather than wiped.
    // From this pass's point of view there is no difference between
    // "genuinely still present" and "preserved because the scan was
    // incomplete" — presence in entries.item_ref is the entire
    // authoritative-deletion predicate. This test proves presence (for
    // whatever reason) keeps the ref out of the candidate set; the
    // indexer's own suite covers WHY the row survives an incomplete scan.
    const ref = "memories/preserved-by-incomplete-scan";
    withStateDb((db) => upsertAssetSalience(db, ref, FIXTURE_VECTOR));
    const indexDb = openIndex();
    try {
      insertLiveEntry(indexDb, ref);

      const out = runOrphanStateGcPass(ctxWithCollect(true), { current: indexDb });
      expect(out.pending).toBe(0);
      expect(out.collected).toBe(0);
    } finally {
      closeDatabase(indexDb);
    }
  });

  test("asset_outcome orphans are tracked independently from asset_salience", () => {
    const outcomeOnlyRef = "memories/outcome-only-orphan";
    withStateDb((db) => upsertAssetOutcome(db, fixtureOutcomeValues(outcomeOnlyRef)));
    const indexDb = openIndex();

    try {
      const out = runOrphanStateGcPass(ctxWithCollect(false), { current: indexDb });
      expect(out.pending).toBe(1);

      withStateDb((db) => {
        expect(countAssetOutcomeMissing(db)).toBe(1);
        expect(countAssetSalienceMissing(db)).toBe(0);
      });
    } finally {
      closeDatabase(indexDb);
    }
  });

  test("runs correctly through a borrowed (already-open) state.db connection (#585 discipline)", () => {
    const ref = "memories/borrowed-conn-orphan";
    const stateDbPath = getStateDbPath();
    // A long-lived handle, like akmImprove's eventsCtx.db.
    const borrowedDb = openStateDatabase(stateDbPath);
    try {
      upsertAssetSalience(borrowedDb, ref, FIXTURE_VECTOR);
      const indexDb = openIndex();
      try {
        const ctx = makeCtx({ config: {} as AkmConfig, eventsCtx: { db: borrowedDb } });
        const out = runOrphanStateGcPass(ctx, { current: indexDb });
        expect(out.warnings).toEqual([]);
        expect(out.pending).toBe(1);
      } finally {
        closeDatabase(indexDb);
      }
      // The borrowed connection must still be open afterwards — the pass
      // must not close a handle it does not own.
      expect(() => borrowedDb.prepare("SELECT 1").get()).not.toThrow();
    } finally {
      try {
        borrowedDb.close();
      } catch {
        // already closed
      }
    }
  });

  test("no index.db handle available produces a warning instead of throwing", () => {
    const out = runOrphanStateGcPass(makeCtx(), {} as IndexDbCell);
    expect(out.warnings.length).toBeGreaterThan(0);
    expect(out.pending).toBe(0);
    expect(out.collected).toBe(0);
  });

  // R78 (tier1-0917): the pass used to call `getEntryByRef` (two indexDb statements, with
  // the bare-ref fallback) once per pending row — O(N) round trips against
  // index.db for N pending rows. It now builds one live-ref snapshot up front
  // and matches every row against it in memory.
  test("a GC pass over N pending rows performs O(1) indexDb queries, not O(N)", () => {
    const orphanCount = 40;
    withStateDb((db) => {
      for (let i = 0; i < orphanCount; i++) {
        upsertAssetSalience(db, `memories/orphan-${i}`, FIXTURE_VECTOR);
      }
    });
    const indexDb = openIndex(); // empty — every pending ref is a genuine orphan
    try {
      let indexDbQueries = 0;
      const realPrepare = indexDb.prepare.bind(indexDb);
      const prepareSpy = spyOn(indexDb, "prepare").mockImplementation((sql: string) => {
        indexDbQueries++;
        return realPrepare(sql);
      });

      try {
        const out = runOrphanStateGcPass(ctxWithCollect(false), { current: indexDb });
        expect(out.pending).toBe(orphanCount);
      } finally {
        prepareSpy.mockRestore();
      }

      // One query total for the whole pass (both state tables share it) — NOT
      // one per pending row.
      expect(indexDbQueries).toBe(1);

      withStateDb((db) => {
        const rows = listAssetSalienceMissingState(db);
        expect(rows).toHaveLength(orphanCount);
        // Every absent ref still received its missing_since stamp.
        expect(rows.every((r) => r.missing_since != null)).toBe(true);
      });
    } finally {
      closeDatabase(indexDb);
    }
  });
});

describe("asset_state_gc event", () => {
  test("a clean run (nothing pending, nothing collected) emits no event", () => {
    const indexDb = openIndex(); // empty state.db, empty index.db
    try {
      const out = runOrphanStateGcPass(ctxWithCollect(false), { current: indexDb });
      expect(out.pending).toBe(0);
      expect(out.collected).toBe(0);

      const { events } = readEvents({ type: "asset_state_gc" }, { dbPath: getStateDbPath() });
      expect(events).toHaveLength(0);
    } finally {
      closeDatabase(indexDb);
    }
  });

  test("a run with a pending orphan emits asset_state_gc with the expected metadata", () => {
    const ref = "memories/reported";
    withStateDb((db) => upsertAssetSalience(db, ref, FIXTURE_VECTOR));
    const indexDb = openIndex();

    try {
      const out = runOrphanStateGcPass(ctxWithCollect(false), { current: indexDb });
      expect(out.pending).toBe(1);

      const { events } = readEvents({ type: "asset_state_gc" }, { dbPath: getStateDbPath() });
      expect(events).toHaveLength(1);
      const evt = events.at(0);
      expect(evt?.ref).toBe("asset_state/_gc");
      expect(evt?.metadata?.pending).toBe(1);
      expect(evt?.metadata?.collected).toBe(0);
      expect(evt?.metadata?.byTable).toBeDefined();
      const byTable = evt?.metadata?.byTable as Record<string, { pending: number; collected: number }>;
      expect(byTable.salience?.pending).toBe(1);
      expect(byTable.outcome?.pending).toBe(0);
    } finally {
      closeDatabase(indexDb);
    }
  });

  test("collection counts are reported on the event once the grace window elapses", () => {
    const ref = "memories/reported-collected";
    withStateDb((db) => {
      upsertAssetSalience(db, ref, FIXTURE_VECTOR);
      stampAssetSalienceMissing(db, [ref], Date.now() - STATE_GC_GRACE_MS - 60_000);
    });
    const indexDb = openIndex();

    try {
      const out = runOrphanStateGcPass(ctxWithCollect(true), { current: indexDb });
      expect(out.collected).toBe(1);

      const { events } = readEvents({ type: "asset_state_gc" }, { dbPath: getStateDbPath() });
      expect(events).toHaveLength(1);
      expect(events[0]?.metadata?.collected).toBe(1);
      expect(events[0]?.metadata?.pending).toBe(0);
    } finally {
      closeDatabase(indexDb);
    }
  });
});
