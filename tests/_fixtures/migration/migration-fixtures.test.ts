// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Chunk-0b WI-0b.6 gate 3 smoke test: "both [migration DB fixtures] exist and
 * LOAD."
 *
 * Builds each fixture (`buildOrphanBearingStateDb`, `buildRcTrainFromState`)
 * into a fresh isolated temp dir, opens the produced database(s) read-only,
 * and asserts the seeded rows / files are exactly what the builders wrote.
 * Not a behavior test of any production code path beyond the real migration
 * runner itself — these builders ARE the fixtures Chunk 8 will import.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { STATE_MIGRATIONS } from "../../../src/core/state/migrations";
import { type Database, openDatabase } from "../../../src/storage/database";
import { openWorkflowDatabase } from "../../../src/workflows/db";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";
import { buildOrphanBearingStateDb, LIVE_CONTRAST_REFS, ORPHAN_REFS } from "./orphan-state";
import {
  buildRcTrainFromState,
  RC_TRAIN_LIVE_REFS,
  RC_TRAIN_MIGRATION_CEILING,
  rcTrainFromStatePaths,
} from "./rc-train-state";
import { PRE_CUTOVER_STATE_CEILING } from "./seed-rows";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  // openStateDatabase() resolves its canonical path unconditionally (even
  // when an explicit dbPath override is passed), which under `bun test`
  // requires XDG_DATA_HOME/AKM_DATA_DIR to be set (src/core/paths.ts
  // test-isolation guard) — withIsolatedAkmStorage() supplies that plus a
  // scratch root neither builder needs to share with its own output dir.
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

/** Read back every row's asset_ref + updated_at from a table, sorted. */
function readRefs(
  db: Database,
  table: "asset_salience" | "asset_outcome",
): Array<{ asset_ref: string; updated_at: number }> {
  return db.prepare(`SELECT asset_ref, updated_at FROM ${table} ORDER BY asset_ref`).all() as Array<{
    asset_ref: string;
    updated_at: number;
  }>;
}

/** The migration id of the most-recently-applied row in schema_migrations. */
function currentMigrationCeiling(db: Database): string | undefined {
  const row = db.prepare("SELECT id FROM schema_migrations ORDER BY rowid DESC LIMIT 1").get() as
    | { id: string }
    | undefined;
  return row?.id;
}

/** Recursively list every path under `root`, relative to it, for a "no vault
 *  artifacts anywhere" scan. */
function listAllPaths(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      out.push(path.relative(root, abs));
      if (entry.isDirectory()) walk(abs);
    }
  };
  walk(root);
  return out;
}

describe("WI-0b.6a — orphan-bearing state.db builder", () => {
  test("builds and loads: 4 orphan ref shapes + live contrast rows, in both tables", () => {
    const dbPath = path.join(storage.root, "orphan-fixture", "state.db");
    buildOrphanBearingStateDb(dbPath);

    expect(fs.existsSync(dbPath)).toBe(true);

    // Opened READ-ONLY so the as-built pre-cutover shape is observed verbatim —
    // `openStateDatabase` would apply the pending cutover migration (020) on
    // open, minting `legacy_state` and shifting the ceiling off the FROM-state.
    const db = openDatabase(dbPath, { readonly: true });
    try {
      // Gate 3 "loads": the DB is a valid pre-cutover FROM-state, pinned one
      // migration behind the live tip (the tip is now the cutover, 020).
      expect(currentMigrationCeiling(db)).toBe(STATE_MIGRATIONS.at(-2)?.id);
      expect(currentMigrationCeiling(db)).toBe(PRE_CUTOVER_STATE_CEILING);

      const salienceRefs = readRefs(db, "asset_salience").map((r) => r.asset_ref);
      const outcomeRefs = readRefs(db, "asset_outcome").map((r) => r.asset_ref);

      const expectedOrphanRefs = Object.values(ORPHAN_REFS);
      const expectedLiveRefs = Object.values(LIVE_CONTRAST_REFS);

      for (const ref of expectedOrphanRefs) {
        expect(salienceRefs).toContain(ref);
        expect(outcomeRefs).toContain(ref);
      }
      for (const ref of expectedLiveRefs) {
        expect(salienceRefs).toContain(ref);
        expect(outcomeRefs).toContain(ref);
      }

      // Exactly the 4 orphan shapes + 2 live-contrast refs, no more, no fewer.
      expect(salienceRefs.sort()).toEqual([...expectedOrphanRefs, ...expectedLiveRefs].sort());
      expect(outcomeRefs.sort()).toEqual([...expectedOrphanRefs, ...expectedLiveRefs].sort());

      // The 4 concrete key shapes are spelled exactly per anchors.md E.2.
      expect(ORPHAN_REFS.bare).toBe("task:ghost-task-orphan");
      expect(ORPHAN_REFS.originQualified).toBe("stash//task:ghost-task-orphan");
      expect(ORPHAN_REFS.bareDerived).toBe("memory:ghost-memory-orphan.derived");
      expect(ORPHAN_REFS.originQualifiedDerived).toBe("stash//memory:ghost-memory-orphan.derived");

      // review_pressure was dropped by migration 018 — must not exist as a
      // live column (an INSERT naming it would have already thrown above,
      // but assert the schema directly too as a standing guard).
      const outcomeColumns = (db.prepare("PRAGMA table_info(asset_outcome)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      expect(outcomeColumns).not.toContain("review_pressure");

      // recombine_hypotheses was dropped by migration 018 — must not exist.
      const recombineTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'recombine_hypotheses'")
        .get();
      expect(recombineTable).toBeFalsy();

      // legacy_state is Chunk 8's to build — 0b must not create it.
      const legacyStateTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'legacy_state'")
        .get();
      expect(legacyStateTable).toBeFalsy();

      // One concrete orphan row's full value set, spot-checked against the
      // builder's fixed literals.
      const bareOrphanSalience = db
        .prepare("SELECT * FROM asset_salience WHERE asset_ref = ?")
        .get(ORPHAN_REFS.bare) as Record<string, unknown>;
      expect(bareOrphanSalience).toMatchObject({
        asset_ref: "task:ghost-task-orphan",
        encoding_salience: 0.5,
        consecutive_no_ops: 0,
        updated_at: 1_700_000_000_000,
        encoding_source: "type-stub",
      });
    } finally {
      db.close();
    }
  });
});

describe("WI-0b.6b — rc-train FROM-state builder", () => {
  test("builds and loads: state.db at the migration ceiling + workflow.db present + no vault", () => {
    const dir = path.join(storage.root, "rc-train-fixture");
    buildRcTrainFromState(dir);

    const { stateDbPath, workflowDbPath } = rcTrainFromStatePaths(dir);
    expect(fs.existsSync(stateDbPath)).toBe(true);
    expect(fs.existsSync(workflowDbPath)).toBe(true);

    // Migration ceiling: the FROM-state is pinned one migration behind the live
    // tip — the tip is now the WI-8.2 cutover (020), so the pre-cutover ceiling
    // is at(-2). The literal is kept and cross-checked both ways.
    expect(RC_TRAIN_MIGRATION_CEILING).toBe(STATE_MIGRATIONS.at(-2)?.id as string);
    expect(RC_TRAIN_MIGRATION_CEILING).toBe("019-proposal-fingerprints");
    expect(PRE_CUTOVER_STATE_CEILING).toBe("019-proposal-fingerprints");

    // Opened READ-ONLY so the as-built pre-cutover ledger is observed verbatim
    // (an `openStateDatabase` open would apply the pending cutover migration).
    const stateDb = openDatabase(stateDbPath, { readonly: true });
    try {
      expect(currentMigrationCeiling(stateDb)).toBe(RC_TRAIN_MIGRATION_CEILING);

      const salienceRefs = readRefs(stateDb, "asset_salience").map((r) => r.asset_ref);
      const outcomeRefs = readRefs(stateDb, "asset_outcome").map((r) => r.asset_ref);
      const expectedLiveRefs = Object.values(RC_TRAIN_LIVE_REFS);
      expect(salienceRefs.sort()).toEqual([...expectedLiveRefs].sort());
      expect(outcomeRefs.sort()).toEqual([...expectedLiveRefs].sort());

      const eventRows = stateDb.prepare("SELECT event_type, ref FROM events ORDER BY ref").all() as Array<{
        event_type: string;
        ref: string;
      }>;
      expect(eventRows).toEqual([
        { event_type: "show", ref: "memory:all-types-memory" },
        { event_type: "show", ref: "skill:all-types-skill" },
      ]);
    } finally {
      stateDb.close();
    }

    // workflow.db: loads via the real openWorkflowDatabase runner (proves the
    // migration ledger is current) and is untouched/unseeded (schema only).
    const workflowDb = openWorkflowDatabase(workflowDbPath);
    try {
      const runsCount = workflowDb.prepare("SELECT COUNT(*) AS n FROM workflow_runs").get() as { n: number };
      expect(runsCount.n).toBe(0);
    } finally {
      workflowDb.close();
    }

    // No vault artifacts anywhere under the produced tree (anchors.md E.4).
    // Tolerant of SQLite's WAL-mode sidecar files (-wal/-shm/-journal), whose
    // presence at close time is driver-dependent — only the base names and
    // the "no vault anywhere" property are asserted.
    const allPaths = listAllPaths(dir);
    expect(allPaths.some((p) => /vault/i.test(p))).toBe(false);
    const baseNames = new Set(allPaths.map((p) => p.replace(/-(wal|shm|journal)$/, "")));
    expect([...baseNames].sort()).toEqual(["state.db", "workflow.db"]);
  });
});
