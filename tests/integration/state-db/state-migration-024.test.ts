// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P3b Lane B TESTS — migration `024-workflow-run-outputs`.
 *
 * Spec: docs/plans/specs/p3b-child-executor.md §4.3 (binding SQL and registry
 * placement), §7 (the migration-registry preservation gate: "024-workflow-
 * run-outputs is the last entry of STATE_MIGRATIONS and the last key of
 * STATE_MIGRATION_SAFETY_BY_ID, classified additive"), §9 acceptance
 * criteria (same claim).
 *
 * Added by code-review finding 5 (Review log R5): the migration landed
 * (`c1dee6c4`) with no direct test of its own — `state-migration-023.test.ts`
 * was NARROWED (Review log R4 / §6 F-B6) to stop pinning finality the moment
 * 024 was authorized to land after it, and nothing replaced that finality
 * pin for the migration that actually owns "final" now. This file is that
 * replacement, mirroring `state-migration-023.test.ts`'s structure one
 * migration later — the same helpers, the same describe shape, adapted to
 * 024's own (smaller) schema surface: one additive column, no new index.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getStateMigrationSafety,
  STATE_MIGRATION_SAFETY_BY_ID,
  STATE_MIGRATIONS,
} from "../../../src/core/state/migrations";
import { openStateDatabase } from "../../../src/core/state-db";
import { openDatabase } from "../../../src/storage/database";
import { runMigrations } from "../../../src/storage/sqlite-migrations";

const MIGRATION_ID = "024-workflow-run-outputs";
const PRECEDING_MIGRATION_ID = "023-child-workflow-runs";

const roots: string[] = [];

function statePath(prefix = "akm-state-migration-024-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return path.join(root, "state.db");
}

/** Index of a migration by id, mirroring state-migration-023.test.ts's helper. */
function migrationIndex(id: string): number {
  const index = STATE_MIGRATIONS.findIndex((migration) => migration.id === id);
  if (index < 0) throw new Error(`Missing state migration fixture ${id}`);
  return index;
}

interface WorkflowRunsColumnInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

function workflowRunsColumns(db: {
  prepare(sql: string): { all(...params: unknown[]): unknown };
}): WorkflowRunsColumnInfo[] {
  return db.prepare("PRAGMA table_info(workflow_runs)").all() as WorkflowRunsColumnInfo[];
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("migration 024-workflow-run-outputs — registry position and safety classification", () => {
  // Not asserted as the final entry: migration 025-task-history-vocabulary-
  // backfill is authorized to append after this one (see
  // state-migration-025.test.ts), so this test pins only 024's own position
  // relative to its immediate predecessor, 023 — mirroring how
  // state-migration-023.test.ts was narrowed when 024 landed.
  test("appears in STATE_MIGRATIONS directly after 023-child-workflow-runs", () => {
    const ids = STATE_MIGRATIONS.map((migration) => migration.id);
    const index = ids.indexOf(MIGRATION_ID);
    expect(index).toBeGreaterThan(-1);
    expect(ids[index - 1]).toBe(PRECEDING_MIGRATION_ID);
  });

  test("is classified additive in STATE_MIGRATION_SAFETY_BY_ID, directly after 023-child-workflow-runs", () => {
    const classifiedIds = Object.keys(STATE_MIGRATION_SAFETY_BY_ID);
    const index = classifiedIds.indexOf(MIGRATION_ID);
    expect(index).toBeGreaterThan(-1);
    expect(classifiedIds[index - 1]).toBe(PRECEDING_MIGRATION_ID);
    expect(getStateMigrationSafety(MIGRATION_ID)).toBe("additive");
  });

  test("the safety-classification registry key order matches the migration registry order exactly", () => {
    // The module itself asserts this at load time (assertStateMigrationSafetyRegistry
    // in src/core/state/migrations.ts) — a mismatch would already have thrown before
    // this test could run. This is the explicit, itemized re-assertion.
    expect(Object.keys(STATE_MIGRATION_SAFETY_BY_ID)).toEqual(STATE_MIGRATIONS.map((migration) => migration.id));
  });

  test("the migration's SQL is additive only — no DROP or RENAME", () => {
    const migration = STATE_MIGRATIONS.find((candidate) => candidate.id === MIGRATION_ID);
    expect(migration).toBeDefined();
    const executableSql = (migration?.up ?? "").replaceAll(/--.*$/gm, "");
    expect(/\bDROP\b|\bRENAME\s+TO\b/i.test(executableSql)).toBe(false);
  });
});

describe("migration 024-workflow-run-outputs — additive schema", () => {
  test("a fresh state.db carries workflow_runs.outputs_json as a nullable TEXT column outside the primary key", () => {
    const db = openStateDatabase(statePath());
    try {
      const ids = (db.prepare("SELECT id FROM schema_migrations ORDER BY rowid").all() as Array<{ id: string }>).map(
        (row) => row.id,
      );
      expect(ids).toEqual(STATE_MIGRATIONS.map((migration) => migration.id));
      expect(ids).toContain(MIGRATION_ID);

      const column = workflowRunsColumns(db).find((candidate) => candidate.name === "outputs_json");
      expect(column).toBeDefined();
      // Additive TEXT column, nullable (no NOT NULL constraint on a bare ADD
      // COLUMN with no DEFAULT), never part of the primary key.
      expect(column?.type.toUpperCase()).toBe("TEXT");
      expect(column?.notnull).toBe(0);
      expect(column?.pk).toBe(0);
    } finally {
      db.close();
    }
  });

  test("an existing pre-024 state.db migrates additively, preserving existing rows with outputs_json NULL", () => {
    const file = statePath();
    const before024 = STATE_MIGRATIONS.slice(0, migrationIndex(MIGRATION_ID));
    const seeded = openDatabase(file);
    runMigrations(seeded, before024);
    const now = "2026-08-26T00:00:00.000Z";
    seeded
      .prepare(
        `INSERT INTO workflow_runs
           (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
            params_json, current_step_id, created_at, updated_at, checkin_armed_at)
         VALUES (?, ?, ?, NULL, ?, 'active', ?, ?, ?, ?, NULL)`,
      )
      .run(
        "preexisting-run",
        "workflows/preexisting",
        "dir:v1:preexisting",
        "Preexisting",
        '{"marker":"kept"}',
        "work",
        now,
        now,
      );
    seeded.close();

    const upgraded = openStateDatabase(file);
    try {
      const ids = (
        upgraded.prepare("SELECT id FROM schema_migrations ORDER BY rowid").all() as Array<{ id: string }>
      ).map((row) => row.id);
      expect(ids).toContain(MIGRATION_ID);

      const rows = upgraded.prepare("SELECT * FROM workflow_runs").all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (!row) throw new Error("expected the pre-024 row to survive migration");
      expect(row.id).toBe("preexisting-run");
      expect(row.workflow_ref).toBe("workflows/preexisting");
      expect(row.params_json).toBe('{"marker":"kept"}');
      expect(row.outputs_json).toBeNull();
    } finally {
      upgraded.close();
    }
  });
});
