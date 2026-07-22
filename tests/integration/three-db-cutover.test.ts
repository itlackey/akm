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
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createProposal } from "../../src/commands/proposal/repository";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";
import { getMigrationApplyJournalPath } from "../../src/core/migration-backup";
import { getMigrationOperationRoot } from "../../src/core/migration-operation";
import { getConfigPath, getDataDir, getDbPath, getStateDbPathInDataDir } from "../../src/core/paths";
import { deriveEntryProvenance, deriveInstallations, slugForPath } from "../../src/indexer/installations";
import type { StashFile } from "../../src/indexer/passes/metadata";
import { type ContentMigrationReport, runContentMigration } from "../../src/migrate/legacy/content-migration";
import { getLegacyWorkflowDbPath } from "../../src/migrate/legacy/legacy-paths";
import { writeLegacyStashFile } from "../../src/migrate/legacy/legacy-stash-json";
import { importLegacyProposalsIntoState } from "../../src/migrate/legacy/proposal-fs-import";
import { migratePilotTreatmentFiles } from "../../src/migrate/legacy/three-db-cutover";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import {
  buildOrphanBearingStateDb,
  LIVE_CONTRAST_REFS,
  ORPHAN_REFS,
  USAGE_EVENT_ORPHAN_REF,
} from "../_fixtures/migration/orphan-state";
import {
  buildRcTrainFromState,
  RC_TRAIN_LIVE_REFS,
  rcTrainFromStatePaths,
} from "../_fixtures/migration/rc-train-state";
import { openStateDbAtCeiling, PRE_CUTOVER_STATE_CEILING } from "../_fixtures/migration/seed-rows";
import { runCliCapture } from "../_helpers/cli";
import {
  type Cleanup,
  sandboxHome,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "../_helpers/sandbox";

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
  // WI-8.4: the prepared 0.9 config still carries the pre-cutover source shape
  // (stashDir primary + a named source + an installed entry). The config-applied
  // phase auto-translates it to `bundles`/`defaultBundle` and removes the old
  // keys (asserted in scenario (a)).
  fs.writeFileSync(
    prepared,
    `${JSON.stringify({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      stashDir: path.join(getDataDir(), "stash"),
      sources: [{ type: "filesystem", path: path.join(getDataDir(), "team"), name: "team", writable: true }],
      installed: [{ id: "reg-kit", source: "npm", ref: "@scope/kit", stashRoot: path.join(getDataDir(), "kit") }],
    })}\n`,
  );
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
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     );`,
  );
  const insEntry = idx.prepare("INSERT INTO entries (entry_key, item_ref, entry_type, stash_dir) VALUES (?, ?, ?, ?)");
  insEntry.run(RC_TRAIN_LIVE_REFS.skill, SKILL_ITEM_REF, "skill", stashRoot);
  insEntry.run(RC_TRAIN_LIVE_REFS.memory, MEMORY_ITEM_REF, "memory", stashRoot);
  // Pre-provenance schema: these rows must migrate as unattributed, never user.
  const insUsage = idx.prepare("INSERT INTO usage_events (event_type, entry_ref) VALUES (?, ?)");
  insUsage.run("show", RC_TRAIN_LIVE_REFS.skill); // legacy → re-keyed to SKILL_ITEM_REF
  insUsage.run("show", SKILL_ITEM_REF); // already bundle grammar → carried as-is
  insUsage.run("feedback", USAGE_EVENT_ORPHAN_REF); // orphan legacy → kept + audited
  idx.close();
}

/** Seed a workflow_run + step + unit into workflow.db so the merge has real rows to carry. */
function seedWorkflowRun(): void {
  const wf = new Database(getLegacyWorkflowDbPath());
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
    const treatmentFile = path.join(getDataDir(), "stash", ".akm", "measurement", "treatment-pilot-2026-06-14.txt");
    fs.mkdirSync(path.dirname(treatmentFile), { recursive: true });
    fs.writeFileSync(treatmentFile, `# pilot\n${RC_TRAIN_LIVE_REFS.skill}\n${MEMORY_ITEM_REF}\n`);
    const prepared = writeConfigs();

    const applied = await runCliCapture(["migrate", "apply", "--config", prepared]);
    expect(applied.code, applied.stderr).toBe(0);

    // Three DBs: workflow.db gone, index.db quarantined (rename), state.db is home.
    expect(fs.existsSync(getLegacyWorkflowDbPath())).toBe(false);
    expect(fs.existsSync(getDbPath())).toBe(false);
    const quarantined = fs.readdirSync(getDataDir()).filter((f) => f.startsWith("index.db.pre-cutover-"));
    expect(quarantined.length).toBe(1);

    // WI-8.4: the config emerged in the 0.9.0 bundles shape — old source keys
    // gone, bundles keyed by the derived ids, defaultBundle = the stashDir bundle.
    const appliedConfig = JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;
    expect(appliedConfig.stashDir).toBeUndefined();
    expect(appliedConfig.sources).toBeUndefined();
    expect(appliedConfig.installed).toBeUndefined();
    const appliedBundles = appliedConfig.bundles as Record<string, Record<string, unknown>>;
    // ids: stashDir slug "stash", the named source "team", the slug-legal
    // installed id "reg-kit" (kept verbatim — it needs no slug fallback).
    expect(Object.keys(appliedBundles)).toEqual(["stash", "team", "reg-kit"]);
    expect(appliedConfig.defaultBundle).toBe("stash");
    expect(appliedBundles.stash).toMatchObject({ path: path.join(getDataDir(), "stash"), writable: true });
    expect(appliedBundles.team).toMatchObject({ path: path.join(getDataDir(), "team"), writable: true });
    // WI-8.5 desired/resolved split (spec §10.2): the installed npm entry emits its
    // DESIRED locator, NOT the resolved cache root (that moves to the lock's localRoot).
    expect(appliedBundles["reg-kit"]).toEqual({ npm: "@scope/kit" });

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
      const usageSources = db.query("SELECT DISTINCT source FROM usage_events").all() as Array<{ source: string }>;
      expect(usageSources).toEqual([{ source: "unknown" }]);
      // The orphan usage_events row is KEPT in place (append-only) and audited.
      expect(usageRefs).toContain(USAGE_EVENT_ORPHAN_REF);
      const usageOrphan = db
        .query("SELECT row_count FROM legacy_state WHERE surface = 'usage_events' AND old_ref = ?")
        .get(USAGE_EVENT_ORPHAN_REF) as { row_count: number } | undefined;
      expect(usageOrphan?.row_count).toBe(1);
      expect(fs.readFileSync(treatmentFile, "utf8")).toBe(`# pilot\n${SKILL_ITEM_REF}\n${MEMORY_ITEM_REF}\n`);
    } finally {
      db.close();
    }

    // WI-8.3: the 4→3 collapse also holds for the RUNTIME. workflow.db is gone,
    // yet a workflow write through the runtime gateway (withWorkflowRunsRepo)
    // lands in state.db's merged workflow_runs — no workflow.db is re-created.
    await withWorkflowRunsRepo((repo) =>
      repo.insertRun({
        id: "runtime-run",
        workflowRef: "workflows/ship",
        scopeKey: null,
        workflowEntryId: null,
        workflowTitle: "Runtime write",
        paramsJson: "{}",
        currentStepId: null,
        createdAt: "2026-02-01T00:00:00Z",
        updatedAt: "2026-02-01T00:00:00Z",
        agentHarness: null,
        agentSessionId: null,
        checkinArmedAt: null,
      }),
    );
    expect(fs.existsSync(getLegacyWorkflowDbPath())).toBe(false); // no workflow.db resurrected
    const after = readState();
    try {
      expect(
        (after.query("SELECT COUNT(*) AS n FROM workflow_runs WHERE id = 'runtime-run'").get() as { n: number }).n,
      ).toBe(1);
    } finally {
      after.close();
    }

    // WI-8.5a: a proposal WRITTEN post-cutover is born already-final — the writer
    // flip mints proposals.ref as the fully-qualified item_ref directly, so a
    // second re-key pass over it is a no-op (no legacy `type:name` row is ever
    // created and then migrated). Contrast with rc-train's pre-cutover rows,
    // which are seeded legacy and re-keyed above.
    const postStash = path.join(getDataDir(), "stash");
    fs.mkdirSync(path.join(postStash, "lessons"), { recursive: true });
    const bornFinal = createProposal(postStash, {
      ref: "lessons/post-cutover-born-final",
      source: "distill",
      sourceRun: "post-cutover-run",
      force: true,
      payload: { content: "---\ndescription: Born final.\n---\nPost-cutover payload.\n" },
    });
    if ("message" in bornFinal) throw new Error(`unexpected skip: ${bornFinal.message}`);
    const bundleId = deriveInstallations([{ path: postStash, writable: true }])[0]?.id ?? slugForPath(postStash);
    const expectedItemRef = deriveEntryProvenance(
      { bundleId, componentId: bundleId, adapterId: "akm" },
      "lesson",
      "post-cutover-born-final",
    ).itemRef;
    expect(bornFinal.ref).toBe(expectedItemRef); // already the item_ref
    expect(bornFinal.ref).toContain("//"); // fully-qualified, never a legacy type:name
    expect(bornFinal.ref).not.toMatch(/(?<![A-Za-z/])lesson:/); // no legacy spelling to re-key
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
    expect(fs.existsSync(getLegacyWorkflowDbPath())).toBe(false);
    expect(fs.existsSync(getDbPath())).toBe(false);
    expect(fs.readdirSync(getDataDir()).some((f) => f.startsWith("index.db.pre-cutover-"))).toBe(false);

    const db = readState();
    try {
      expect(ledgerIds(db).at(-1)).toBe("020-three-db-cutover");
      for (const table of [
        "workflow_runs",
        "workflow_run_steps",
        "workflow_run_units",
        "usage_events",
        "legacy_state",
      ]) {
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
    expect(fs.existsSync(getLegacyWorkflowDbPath())).toBe(false);

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
    db.prepare(`INSERT INTO asset_salience (asset_ref, encoding_salience, updated_at) VALUES (?, 0.5, 100)`).run(
      RC_TRAIN_LIVE_REFS.skill,
    );
    // An unparseable legacy-grammar ref (colon at position 0) — an integrity failure.
    db.prepare(`INSERT INTO asset_salience (asset_ref, encoding_salience, updated_at) VALUES (':bad', 0.5, 100)`).run();
    db.close();
    seedOldIndexDb();
    const treatmentFile = path.join(getDataDir(), "stash", ".akm", "measurement", "treatment-pilot-2026-06-14.txt");
    fs.mkdirSync(path.dirname(treatmentFile), { recursive: true });
    fs.writeFileSync(treatmentFile, `${RC_TRAIN_LIVE_REFS.skill}\n`);
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
      expect(fs.readFileSync(treatmentFile, "utf8")).toBe(`${RC_TRAIN_LIVE_REFS.skill}\n`);
    } finally {
      post.close();
    }
  }, 30_000);
});

describe("WI-8.2 pilot treatment recovery", () => {
  test("fsyncs the parent directory after atomically replacing a treatment file", () => {
    const stash = path.join(getDataDir(), "pilot-durability");
    const treatmentFile = path.join(stash, ".akm", "measurement", "treatment-pilot-2026-06-14.txt");
    fs.mkdirSync(path.dirname(treatmentFile), { recursive: true });
    fs.writeFileSync(treatmentFile, `${RC_TRAIN_LIVE_REFS.skill}\n`);

    const originalFsync = fs.fsyncSync;
    let directorySyncObserved = false;
    spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory()) {
        directorySyncObserved = true;
        expect(fs.readFileSync(treatmentFile, "utf8")).toBe(`${SKILL_ITEM_REF}\n`);
      }
      return originalFsync(fd);
    });

    expect(
      migratePilotTreatmentFiles(
        [{ path: stash, primary: true }],
        new Map([[RC_TRAIN_LIVE_REFS.skill, SKILL_ITEM_REF]]),
      ),
    ).toBe(1);
    expect(directorySyncObserved).toBe(true);
  });

  test("keeps forward recovery pending when the treatment rewrite fails", async () => {
    openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING).close();
    seedOldIndexDb();
    const treatmentFile = path.join(getDataDir(), "stash", ".akm", "measurement", "treatment-pilot-2026-06-14.txt");
    fs.mkdirSync(treatmentFile, { recursive: true });
    const prepared = writeConfigs();

    const failed = await runCliCapture(["migrate", "apply", "--config", prepared]);
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toMatch(/pilot treatment|forward recovery|directory/i);
    expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(true);
    expect(JSON.parse(fs.readFileSync(getMigrationApplyJournalPath(), "utf8")).phase).toBe("pilot-prepared");

    fs.rmSync(treatmentFile, { recursive: true });
    fs.writeFileSync(treatmentFile, `${RC_TRAIN_LIVE_REFS.skill}\n`);
    const resumed = await runCliCapture(["migrate", "apply"]);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(fs.readFileSync(treatmentFile, "utf8")).toBe(`${SKILL_ITEM_REF}\n`);
    expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(false);
  }, 30_000);

  test("resumes after a crash between treatment rewrite and journal advancement", async () => {
    openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING).close();
    seedOldIndexDb();
    const treatmentFile = path.join(getDataDir(), "stash", ".akm", "measurement", "treatment-pilot-2026-06-14.txt");
    fs.mkdirSync(path.dirname(treatmentFile), { recursive: true });
    fs.writeFileSync(treatmentFile, `${RC_TRAIN_LIVE_REFS.skill}\n`);
    const prepared = writeConfigs();

    const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "apply", "--config", prepared], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env, AKM_TEST_MIGRATION_CRASH_GAP: "pilot" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).not.toBe(0);
    expect(fs.readFileSync(treatmentFile, "utf8")).toBe(`${SKILL_ITEM_REF}\n`);
    expect(JSON.parse(fs.readFileSync(getMigrationApplyJournalPath(), "utf8")).phase).toBe("pilot-prepared");

    const resumed = await runCliCapture(["migrate", "apply"]);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(fs.readFileSync(treatmentFile, "utf8")).toBe(`${SKILL_ITEM_REF}\n`);
    expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(false);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// (f) WI-8.5d content migration — `.stash.json` fold + D-R6 reserved-file rename
// ─────────────────────────────────────────────────────────────────────────────

const CONTENT_STASH = (): string => path.join(getDataDir(), "stash");

/**
 * Seed the primary stash with (1) a markdown asset + a `.stash.json` sidecar that
 * OVERRIDES its curated metadata, (2) a `knowledge/index.md` that actually holds
 * asset frontmatter (a concept mis-named as a reserved file — D-R6), and (3) a
 * structural bundle-root `index.md` with no asset frontmatter (must stay put).
 */
function seedContentStash(): void {
  const stash = CONTENT_STASH();
  const memDir = path.join(stash, "memories");
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(
    path.join(memDir, "note.md"),
    "---\ndescription: Original generated description\n---\n\nNote body.\n",
  );
  const sidecar: StashFile = {
    entries: [
      {
        name: "note",
        type: "memory",
        filename: "note.md",
        description: "Curated override for note",
        tags: ["curated-fold"],
        whenToUse: "Use for the WI-8.5d fold assertion",
      },
    ],
  };
  writeLegacyStashFile(memDir, sidecar);

  const knowledgeDir = path.join(stash, "knowledge");
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.writeFileSync(
    path.join(knowledgeDir, "index.md"),
    "---\ndescription: A knowledge concept accidentally named index\nwhen_to_use: retrieval test\n---\n\n# Real concept\n\nbody\n",
  );

  fs.writeFileSync(path.join(stash, "index.md"), "# Bundle listing\n\n- memories/note\n");

  // Group-C item 2: a derived memory carrying the LAST deliberately-legacy ref
  // channel — a `source: memory:<parent>` backref (the interpolated name keeps
  // this legacy seed out of the ref-literal ratchet's counted scope). The
  // content migration rewrites it forward to `source: memories/<parent>`.
  const derivedParent = "note";
  fs.writeFileSync(
    path.join(memDir, `${derivedParent}.derived.md`),
    `---\ninferred: true\nsource: memory:${derivedParent}\nderivedFrom: ${derivedParent}\n---\n\nDerived note body.\n`,
  );
}

function readContentReport(): ContentMigrationReport {
  const raw = fs.readFileSync(path.join(getMigrationOperationRoot(), "content-migration-report.json"), "utf8");
  return JSON.parse(raw) as ContentMigrationReport;
}

describe("WI-8.5d (f) — content migration folds .stash.json + D-R6 renames mis-named reserved files", () => {
  test("overrides fold into frontmatter, sidecar deleted, index.md renamed + reported, second apply idempotent", async () => {
    openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING).close();
    seedContentStash();
    const prepared = writeConfigs();

    const applied = await runCliCapture(["migrate", "apply", "--config", prepared]);
    expect(applied.code, applied.stderr).toBe(0);

    const stash = CONTENT_STASH();
    const notePath = path.join(stash, "memories", "note.md");
    const sidecarPath = path.join(stash, "memories", ".stash.json");
    const misnamedIndex = path.join(stash, "knowledge", "index.md");
    const renamedIndex = path.join(stash, "knowledge", "index-content.md");
    const structuralIndex = path.join(stash, "index.md");

    // (1) `.stash.json` overrides folded into the target's frontmatter; sidecar gone.
    expect(fs.existsSync(sidecarPath)).toBe(false);
    const noteFm = parseFrontmatter(fs.readFileSync(notePath, "utf8")).data;
    expect(noteFm.description).toBe("Curated override for note"); // sidecar wins over the generated value
    expect(noteFm.tags).toEqual(["curated-fold"]);
    expect(noteFm.when_to_use).toBe("Use for the WI-8.5d fold assertion"); // whenToUse → when_to_use

    // (2) D-R6: the mis-named concept renamed collision-safe; structural index.md left in place.
    expect(fs.existsSync(misnamedIndex)).toBe(false);
    expect(fs.existsSync(renamedIndex)).toBe(true);
    expect(parseFrontmatter(fs.readFileSync(renamedIndex, "utf8")).data.description).toBe(
      "A knowledge concept accidentally named index",
    );
    expect(fs.existsSync(structuralIndex)).toBe(true);
    expect(fs.readFileSync(structuralIndex, "utf8")).toContain("# Bundle listing");

    // (3) The rename is RECORDED in the persisted step report.
    const report = readContentReport();
    expect(report.sidecarsFolded).toBe(1);
    expect(report.entriesFolded).toBe(1);
    expect(report.reservedRenames).toHaveLength(1);
    expect(report.reservedRenames[0]).toEqual({ from: misnamedIndex, to: renamedIndex });

    // (3b) Group-C item 2: the derived memory's legacy `source: memory:<parent>`
    // backref is rewritten forward to the 0.9.0 conceptId and counted.
    expect(report.sourceBackrefsRewritten).toBe(1);
    const derivedNotePath = path.join(stash, "memories", "note.derived.md");
    expect(parseFrontmatter(fs.readFileSync(derivedNotePath, "utf8")).data.source).toBe("memories/note");

    // (4) A second migrate apply is a no-op — the folded/renamed state is unchanged.
    const noteAfterFirst = fs.readFileSync(notePath, "utf8");
    const second = await runCliCapture(["migrate", "apply"]);
    expect(second.code, second.stderr).toBe(0);
    expect(fs.readFileSync(notePath, "utf8")).toBe(noteAfterFirst);
    expect(fs.existsSync(sidecarPath)).toBe(false);
    expect(fs.existsSync(renamedIndex)).toBe(true);

    // (5) Re-running the step itself directly is idempotent: nothing left to do
    // (the source backref is already `memories/note`, so no re-rewrite).
    const rerun = runContentMigration([stash]);
    expect(rerun).toEqual({
      sidecarsFolded: 0,
      entriesFolded: 0,
      entriesSkipped: 0,
      reservedRenames: [],
      sourceBackrefsRewritten: 0,
      // runContentMigration itself never imports proposals — that sibling step
      // lives in config-migrate.ts and needs the migrated state.db handle.
      legacyProposalsImported: 0,
    });
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// (g) Pre-0.9 filesystem-proposal import — folded out of the live per-op path
//     (was `withProposalsDb` → `importLegacyProposalFiles`) INTO this one-time
//     migrator step (`src/migrate/legacy/proposal-fs-import.ts`).
// ─────────────────────────────────────────────────────────────────────────────

/** Write one pre-0.9.0 `<stash>/.akm/proposals[/archive]/<id>/proposal.json`. */
function writeLegacyProposal(
  stashDir: string,
  proposal: Record<string, unknown>,
  options: { archive?: boolean; backupBody?: string } = {},
): void {
  const root = options.archive
    ? path.join(stashDir, ".akm", "proposals", "archive")
    : path.join(stashDir, ".akm", "proposals");
  const dir = path.join(root, String(proposal.id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "proposal.json"), `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
  if (options.backupBody !== undefined) fs.writeFileSync(path.join(dir, "backup.md"), options.backupBody, "utf8");
}

function legacyProposalRecord(id: string, ref: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    ref,
    status,
    source: "reflect",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    payload: { content: "Prefer rg over grep for code search.\n" },
    ...extra,
  };
}

/** Rows for one stash from the migrated state.db (readonly). */
function readProposalRows(stashDir: string): Array<{ id: string; status: string; metadata_json: string }> {
  const db = new Database(getStateDbPathInDataDir(), { readonly: true });
  try {
    return db
      .prepare("SELECT id, status, metadata_json FROM proposals WHERE stash_dir = ? ORDER BY id")
      .all(stashDir) as Array<{ id: string; status: string; metadata_json: string }>;
  } finally {
    db.close();
  }
}

describe("(g) migrate apply imports pre-0.9 filesystem proposals into state.db", () => {
  test("pending + archived proposals land (backup inlined), corrupt skipped, second apply idempotent", async () => {
    openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING).close();

    const stash = CONTENT_STASH();
    fs.mkdirSync(path.join(stash, "lessons"), { recursive: true });
    const pendingId = "11111111-1111-4111-8111-111111111111";
    const acceptedId = "22222222-2222-4222-8222-222222222222";
    const corruptId = "33333333-3333-4333-8333-333333333333";
    writeLegacyProposal(stash, legacyProposalRecord(pendingId, "lessons/legacy-pending", "pending"));
    writeLegacyProposal(
      stash,
      legacyProposalRecord(acceptedId, "lessons/legacy-accepted", "accepted", {
        backup: "backup.md",
        review: { outcome: "accepted", decidedAt: "2026-01-02T00:00:00.000Z" },
      }),
      { archive: true, backupBody: "LEGACY BACKUP BODY\n" },
    );
    // A corrupt legacy entry must be skipped without blocking the rest.
    const corruptDir = path.join(stash, ".akm", "proposals", corruptId);
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDir, "proposal.json"), "{ not json", "utf8");

    const prepared = writeConfigs();
    const applied = await runCliCapture(["migrate", "apply", "--config", prepared]);
    expect(applied.code, applied.stderr).toBe(0);

    // (1) Both well-formed proposals imported; the corrupt one skipped.
    const rows = readProposalRows(stash);
    expect(rows.map((r) => r.id)).toEqual([pendingId, acceptedId]);
    const acceptedRow = rows.find((r) => r.id === acceptedId);
    expect(acceptedRow?.status).toBe("accepted");
    // (2) The legacy `backup.md` was inlined as `backupContent`.
    const acceptedMeta = JSON.parse(acceptedRow?.metadata_json ?? "{}") as { backupContent?: string };
    expect(acceptedMeta.backupContent).toBe("LEGACY BACKUP BODY\n");

    // (3) The import count rides the content-migration report.
    expect(readContentReport().legacyProposalsImported).toBe(2);

    // (4) The legacy files are left in place on disk (inert, operator-removable).
    expect(fs.existsSync(path.join(stash, ".akm", "proposals", pendingId, "proposal.json"))).toBe(true);

    // (5) A second migrate apply is a no-op on an already-current install (it
    // short-circuits before the content step), so the rows stay exactly as
    // imported — no duplication.
    const second = await runCliCapture(["migrate", "apply"]);
    expect(second.code, second.stderr).toBe(0);
    expect(readProposalRows(stash).map((r) => r.id)).toEqual([pendingId, acceptedId]);

    // (6) Re-running the import step itself over the still-on-disk legacy files
    // re-imports nothing (INSERT OR IGNORE on the UUID) — idempotent.
    expect(importLegacyProposalsIntoState(getStateDbPathInDataDir(), [stash])).toBe(0);
    expect(readProposalRows(stash).map((r) => r.id)).toEqual([pendingId, acceptedId]);
  }, 30_000);
});
