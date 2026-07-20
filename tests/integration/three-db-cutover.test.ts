// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-8.2 — end-to-end coverage of the three-DB cutover, driven through the real
 * `migrate apply` flow (never the cutover module in isolation). Five scenarios:
 *   (a) rc-train FROM-state round-trip — workflow.db merged, usage_events
 *       rescued, live refs re-keyed to their item_refs, workflow.db gone,
 *       index.db quarantined, ledger at 020;
 *   (b) orphan-bearing state completes WITH quarantine (never aborts);
 *   (c) fresh install — no workflow.db/index.db, records complete, no ATTACH
 *       ever CREATEs a stray file;
 *   (d) idempotency — a second migrate apply is a no-op;
 *   (e) fail-closed — an injected unparseable ref restores the pre-state.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getConfigPath, getDataDir, getDbPath, getStateDbPathInDataDir, getWorkflowDbPath } from "../../src/core/paths";
import { STATE_MIGRATIONS } from "../../src/core/state/migrations";
import { runCliCapture } from "../_helpers/cli";
import {
  type Cleanup,
  sandboxHome,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "../_helpers/sandbox";
import { buildOrphanBearingStateDb, LIVE_CONTRAST_REFS, ORPHAN_REFS } from "../_fixtures/migration/orphan-state";
import {
  buildRcTrainFromState,
  RC_TRAIN_LIVE_REFS,
  rcTrainFromStatePaths,
} from "../_fixtures/migration/rc-train-state";
import { openStateDbAtCeiling, PRE_CUTOVER_STATE_CEILING } from "../_fixtures/migration/seed-rows";

let cleanup: Cleanup | undefined;

beforeEach(() => {
  const home = sandboxHome();
  const config = sandboxXdgConfigHome(home.cleanup);
  const cache = sandboxXdgCacheHome(config.cleanup);
  cleanup = sandboxXdgDataHome(cache.cleanup).cleanup;
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const PRIMARY_BUNDLE = "primary";
/** item_ref a live entry is re-keyed onto (the durable `bundle//conceptId` form). */
const SKILL_ITEM_REF = `${PRIMARY_BUNDLE}//skills/all-types-skill`;
const MEMORY_ITEM_REF = `${PRIMARY_BUNDLE}//memories/all-types-memory`;

function writeConfigs(): string {
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(getConfigPath(), `${JSON.stringify({ configVersion: "0.8.0" })}\n`, { mode: 0o600 });
  const prepared = path.join(path.dirname(getConfigPath()), "prepared-0.9.json");
  fs.writeFileSync(prepared, `${JSON.stringify({ configVersion: "0.9.0", semanticSearchMode: "off" })}\n`);
  return prepared;
}

/**
 * Seed a last-good index.db with `entries` (mapping each live legacy ref to its
 * item_ref) and durable `usage_events` (a legacy row that must re-key + a
 * bundle-grammar row carried as-is). The cutover reads it read-only via ATTACH.
 */
function seedOldIndexDb(): void {
  const stashRoot = path.join(getDataDir(), "stash");
  const idx = new Database(getDbPath());
  idx.exec(
    `CREATE TABLE entries (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       entry_key TEXT NOT NULL,
       item_ref  TEXT,
       entry_type TEXT NOT NULL,
       stash_dir TEXT NOT NULL
     );
     CREATE TABLE usage_events (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       event_type TEXT NOT NULL,
       query TEXT,
       entry_id INTEGER,
       entry_ref TEXT,
       signal TEXT,
       metadata TEXT,
       source TEXT NOT NULL DEFAULT 'user',
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     );`,
  );
  const insEntry = idx.prepare("INSERT INTO entries (entry_key, item_ref, entry_type, stash_dir) VALUES (?, ?, ?, ?)");
  insEntry.run(RC_TRAIN_LIVE_REFS.skill, SKILL_ITEM_REF, "skill", stashRoot);
  insEntry.run(RC_TRAIN_LIVE_REFS.memory, MEMORY_ITEM_REF, "memory", stashRoot);
  const insUsage = idx.prepare("INSERT INTO usage_events (event_type, entry_ref, source) VALUES (?, ?, 'user')");
  insUsage.run("show", RC_TRAIN_LIVE_REFS.skill); // legacy → re-keyed to SKILL_ITEM_REF
  insUsage.run("show", SKILL_ITEM_REF); // already bundle grammar → carried as-is
  insUsage.run("feedback", "skill:deleted-ghost"); // orphan legacy → kept + audited
  idx.close();
}

/** Seed a workflow_run + step + unit into workflow.db so the merge has real rows to carry. */
function seedWorkflowRun(): void {
  const wf = new Database(getWorkflowDbPath());
  wf.prepare(
    `INSERT INTO workflow_runs (id, workflow_ref, workflow_title, status, params_json, created_at, updated_at)
     VALUES ('run-1', 'workflows/ship', 'Ship it', 'active', '{}', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')`,
  ).run();
  wf.prepare(
    `INSERT INTO workflow_run_steps (run_id, step_id, step_title, instructions, sequence_index, status)
     VALUES ('run-1', 'step-1', 'First', 'do it', 0, 'pending')`,
  ).run();
  wf.prepare(
    `INSERT INTO workflow_run_units (run_id, unit_id, node_id, status) VALUES ('run-1', 'unit-1', 'node-a', 'pending')`,
  ).run();
  wf.close();
}

function readState(): Database {
  return new Database(getStateDbPathInDataDir(), { readonly: true });
}

function refsIn(db: Database, table: string, keyColumn: string): string[] {
  return (db.query(`SELECT ${keyColumn} AS k FROM ${table} ORDER BY ${keyColumn}`).all() as Array<{ k: string }>).map(
    (r) => r.k,
  );
}

function ledgerIds(db: Database): string[] {
  return (db.query("SELECT id FROM schema_migrations ORDER BY rowid").all() as Array<{ id: string }>).map((r) => r.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) rc-train FROM-state round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe("WI-8.2 (a) — rc-train FROM-state round-trip", () => {
  test("merges workflow.db, rescues usage_events, re-keys live refs, quarantines index.db", async () => {
    buildRcTrainFromState(getDataDir());
    const { workflowDbPath } = rcTrainFromStatePaths(getDataDir());
    expect(fs.existsSync(workflowDbPath)).toBe(true);
    seedWorkflowRun();
    seedOldIndexDb();
    const prepared = writeConfigs();

    const applied = await runCliCapture(["migrate", "apply", "--config", prepared]);
    expect(applied.code, applied.stderr).toBe(0);

    // Three DBs: workflow.db gone, index.db quarantined (rename), state.db is home.
    expect(fs.existsSync(getWorkflowDbPath())).toBe(false);
    expect(fs.existsSync(getDbPath())).toBe(false);
    const quarantined = fs
      .readdirSync(getDataDir())
      .filter((f) => f.startsWith("index.db.pre-cutover-"));
    expect(quarantined.length).toBe(1);

    const db = readState();
    try {
      // Ledger at 020.
      expect(ledgerIds(db).at(-1)).toBe("020-three-db-cutover");

      // Workflow rows carried bit-exact.
      const run = db.query("SELECT * FROM workflow_runs WHERE id = 'run-1'").get() as Record<string, unknown>;
      expect(run).toMatchObject({
        id: "run-1",
        workflow_ref: "workflows/ship",
        workflow_title: "Ship it",
        status: "active",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
      });
      expect((db.query("SELECT COUNT(*) AS n FROM workflow_run_steps").get() as { n: number }).n).toBe(1);
      expect((db.query("SELECT COUNT(*) AS n FROM workflow_run_units").get() as { n: number }).n).toBe(1);

      // Live refs re-keyed to their item_refs across every ref-keyed table.
      expect(refsIn(db, "asset_salience", "asset_ref")).toEqual([MEMORY_ITEM_REF, SKILL_ITEM_REF]);
      expect(refsIn(db, "asset_outcome", "asset_ref")).toEqual([MEMORY_ITEM_REF, SKILL_ITEM_REF]);
      expect(refsIn(db, "events", "ref")).toEqual([MEMORY_ITEM_REF, SKILL_ITEM_REF]);

      // usage_events rescued into state.db and residual legacy ref re-keyed.
      const usageRefs = refsIn(db, "usage_events", "entry_ref");
      expect(usageRefs.filter((r) => r === SKILL_ITEM_REF).length).toBe(2); // legacy re-keyed + bundle carried
      // The orphan usage_events row is KEPT in place (append-only) and audited.
      expect(usageRefs).toContain("skill:deleted-ghost");
      const usageOrphan = db
        .query("SELECT row_count FROM legacy_state WHERE surface = 'usage_events' AND old_ref = 'skill:deleted-ghost'")
        .get() as { row_count: number } | undefined;
      expect(usageOrphan?.row_count).toBe(1);
    } finally {
      db.close();
    }
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) orphan fixture completes-with-quarantine
// ─────────────────────────────────────────────────────────────────────────────

describe("WI-8.2 (b) — orphan-bearing state completes with quarantine", () => {
  test("live contrast refs re-key; the 4 orphan shapes land in legacy_state; migration COMPLETES", async () => {
    buildOrphanBearingStateDb(getStateDbPathInDataDir());
    seedOldIndexDb(); // only the live contrast refs have index entries; orphans map to nothing
    const prepared = writeConfigs();

    const applied = await runCliCapture(["migrate", "apply", "--config", prepared]);
    expect(applied.code, applied.stderr).toBe(0); // completes, never aborts

    const db = readState();
    try {
      // Live contrast refs re-keyed; the 4 orphan refs are GONE from the live tables.
      const salience = refsIn(db, "asset_salience", "asset_ref");
      expect(salience).toEqual([MEMORY_ITEM_REF, SKILL_ITEM_REF]);
      for (const orphan of Object.values(ORPHAN_REFS)) expect(salience).not.toContain(orphan);
      for (const live of Object.values(LIVE_CONTRAST_REFS)) expect(salience).not.toContain(live);

      // The 4 orphan shapes are quarantined with counts (1 salience + 1 outcome row each).
      for (const orphan of Object.values(ORPHAN_REFS)) {
        for (const surface of ["asset_salience", "asset_outcome"] as const) {
          const row = db
            .query("SELECT row_count, reason FROM legacy_state WHERE surface = ? AND old_ref = ?")
            .get(surface, orphan) as { row_count: number; reason: string } | undefined;
          expect(row?.row_count).toBe(1);
          expect(row?.reason).toBe("orphan");
        }
      }
    } finally {
      db.close();
    }
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) fresh install — no workflow.db / index.db, no ATTACH-created strays
// ─────────────────────────────────────────────────────────────────────────────

describe("WI-8.2 (c) — fresh install records complete without ATTACH", () => {
  test("no workflow.db/index.db, no legacy rows → apply succeeds, empty tables, no stray files", async () => {
    openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING).close(); // empty state.db @ 019
    const prepared = writeConfigs();

    const applied = await runCliCapture(["migrate", "apply", "--config", prepared]);
    expect(applied.code, applied.stderr).toBe(0);

    // ATTACH is never issued when the file is absent, so no stray file is CREATEd.
    expect(fs.existsSync(getWorkflowDbPath())).toBe(false);
    expect(fs.existsSync(getDbPath())).toBe(false);
    expect(fs.readdirSync(getDataDir()).some((f) => f.startsWith("index.db.pre-cutover-"))).toBe(false);

    const db = readState();
    try {
      expect(ledgerIds(db).at(-1)).toBe("020-three-db-cutover");
      for (const table of ["workflow_runs", "workflow_run_steps", "workflow_run_units", "usage_events", "legacy_state"]) {
        expect((db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
      }
    } finally {
      db.close();
    }
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) idempotency — a second migrate apply is a no-op
// ─────────────────────────────────────────────────────────────────────────────

describe("WI-8.2 (d) — the cutover runs exactly once", () => {
  test("a second migrate apply is a no-op (no re-merge, workflow.db stays gone)", async () => {
    buildRcTrainFromState(getDataDir());
    seedWorkflowRun();
    seedOldIndexDb();
    const prepared = writeConfigs();

    const first = await runCliCapture(["migrate", "apply", "--config", prepared]);
    expect(first.code, first.stderr).toBe(0);
    const afterFirst = fs.readFileSync(getStateDbPathInDataDir());

    const second = await runCliCapture(["migrate", "apply"]);
    expect(second.code, second.stderr).toBe(0);
    // Byte-identical state.db (no re-merge, no duplicated rows) and workflow.db stays gone.
    expect(fs.readFileSync(getStateDbPathInDataDir())).toEqual(afterFirst);
    expect(fs.existsSync(getWorkflowDbPath())).toBe(false);

    const db = readState();
    try {
      expect((db.query("SELECT COUNT(*) AS n FROM workflow_runs").get() as { n: number }).n).toBe(1); // not doubled
    } finally {
      db.close();
    }
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// (e) fail-closed — an unparseable ref restores the pre-state
// ─────────────────────────────────────────────────────────────────────────────

describe("WI-8.2 (e) — an integrity failure fails closed to restore", () => {
  test("an unparseable stored ref aborts the cutover and restores the pre-state", async () => {
    const db = openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING);
    db.prepare(
      `INSERT INTO asset_salience (asset_ref, encoding_salience, updated_at) VALUES (?, 0.5, 100)`,
    ).run(RC_TRAIN_LIVE_REFS.skill);
    // An unparseable legacy-grammar ref (colon at position 0) — an integrity failure.
    db.prepare(`INSERT INTO asset_salience (asset_ref, encoding_salience, updated_at) VALUES (':bad', 0.5, 100)`).run();
    db.close();
    seedOldIndexDb();
    const prepared = writeConfigs();

    // Semantic pre-state snapshot (VACUUM-INTO backups are not byte-identical to a
    // fresh fixture, so assert the pre-state rows + ledger survive intact).
    const pre = readState();
    const preSalience = refsIn(pre, "asset_salience", "asset_ref");
    const preLedger = ledgerIds(pre);
    pre.close();

    const applied = await runCliCapture(["migrate", "apply", "--config", prepared]);
    expect(applied.code).not.toBe(0);
    expect(applied.stderr).toMatch(/restored|unparseable|integrity/i);

    const post = readState();
    try {
      // Pre-state preserved: the same asset_ref set (including the injected ':bad',
      // NOT re-keyed), and the ledger rolled back to the pre-cutover ceiling.
      expect(refsIn(post, "asset_salience", "asset_ref").sort()).toEqual(preSalience.sort());
      expect(refsIn(post, "asset_salience", "asset_ref")).toContain(":bad");
      expect(refsIn(post, "asset_salience", "asset_ref")).toContain(RC_TRAIN_LIVE_REFS.skill);
      expect(ledgerIds(post)).toEqual(preLedger);
      expect(ledgerIds(post).at(-1)).toBe(PRE_CUTOVER_STATE_CEILING); // 020 rolled back
    } finally {
      post.close();
    }
  }, 30_000);
});
