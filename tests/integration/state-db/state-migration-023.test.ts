// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P3a Lane C TESTS — migration `023-child-workflow-runs`.
 *
 * Spec: docs/plans/specs/p3a-plan-v5-child-freeze.md §5.1 (binding SQL and
 * registry placement), §1.4(1) (Lane C design), §1.8 A-N3 (line references).
 * Behavior-table rows covered: C-01…C-06 (§2.8).
 *
 * This lane owns ONLY this file and
 * tests/integration/storage/child-run-publication.test.ts. It does not touch
 * src/core/state/migrations.ts — that is Implement's job, mirrored here by
 * the position/safety-classification test pattern already established in
 * tests/storage/state-db-migrations.test.ts ("every ordered migration ID has
 * an explicit safety classification") and
 * tests/integration/workflows/durable-attempt-journal-v4-red.test.ts
 * ("creates the attempt table with a composite run/unit/attempt key…", the
 * migration-022 precedent this file mirrors one migration later).
 *
 * RED phase: `023-child-workflow-runs` does not exist in `STATE_MIGRATIONS`
 * or `STATE_MIGRATION_SAFETY_BY_ID` yet, and `workflow_runs` does not yet
 * carry `parent_run_id` / `parent_unit_id` / `invocation_key`. Every test
 * below references ONLY symbols that already exist today
 * (`STATE_MIGRATIONS`, `STATE_MIGRATION_SAFETY_BY_ID`,
 * `getStateMigrationSafety`, `openStateDatabase`, `openDatabase`,
 * `runMigrations`) — the RED signal is a plain assertion failure (the
 * migration id is simply absent, the columns simply do not exist), not a
 * TypeScript error, so no `@ts-expect-error` red-phase pin is needed
 * anywhere in this file. Implement turns every test here green by appending
 * the migration per §5.1 — no edit to this file is expected at that point.
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

const MIGRATION_ID = "023-child-workflow-runs";
const PRECEDING_MIGRATION_ID = "022-workflow-unit-attempts";

const roots: string[] = [];

function statePath(prefix = "akm-state-migration-023-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return path.join(root, "state.db");
}

/** Index of a migration by id, mirroring tests/storage/state-db-migrations.test.ts's helper. */
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

interface IndexListEntry {
  name: string;
  unique: number;
  partial: number;
}

function workflowRunsIndexes(db: { prepare(sql: string): { all(...params: unknown[]): unknown } }): IndexListEntry[] {
  return db.prepare("PRAGMA index_list(workflow_runs)").all() as IndexListEntry[];
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("migration 023-child-workflow-runs — registry position and safety classification (C-03)", () => {
  // Not asserted as the final entry: P3b's migration 024-workflow-run-outputs
  // (docs/plans/specs/p3b-child-executor.md §8 acceptance criteria) is
  // authorized to append after this one, so this test pins only 023's own
  // position relative to its immediate predecessor, 022.
  test("appears in STATE_MIGRATIONS directly after 022-workflow-unit-attempts", () => {
    const ids = STATE_MIGRATIONS.map((migration) => migration.id);
    const index = ids.indexOf(MIGRATION_ID);
    expect(index).toBeGreaterThan(-1);
    expect(ids[index - 1]).toBe(PRECEDING_MIGRATION_ID);
  });

  test("is classified additive in STATE_MIGRATION_SAFETY_BY_ID, directly after 022-workflow-unit-attempts", () => {
    const classifiedIds = Object.keys(STATE_MIGRATION_SAFETY_BY_ID);
    const index = classifiedIds.indexOf(MIGRATION_ID);
    expect(index).toBeGreaterThan(-1);
    expect(classifiedIds[index - 1]).toBe(PRECEDING_MIGRATION_ID);
    expect(getStateMigrationSafety(MIGRATION_ID)).toBe("additive");
  });

  test("the safety-classification registry key order matches the migration registry order exactly", () => {
    // The module itself asserts this at load time (assertStateMigrationSafetyRegistry
    // in src/core/state/migrations.ts) — a mismatch would already have thrown before
    // this test could run. This is the explicit, itemized re-assertion §5.1 asks for.
    expect(Object.keys(STATE_MIGRATION_SAFETY_BY_ID)).toEqual(STATE_MIGRATIONS.map((migration) => migration.id));
  });

  test("the migration's SQL is additive only — no DROP or RENAME", () => {
    const migration = STATE_MIGRATIONS.find((candidate) => candidate.id === MIGRATION_ID);
    expect(migration).toBeDefined();
    const executableSql = (migration?.up ?? "").replaceAll(/--.*$/gm, "");
    expect(/\bDROP\b|\bRENAME\s+TO\b/i.test(executableSql)).toBe(false);
  });

  test("the migration comment disambiguates workflow_runs.parent_unit_id from workflow_run_units.parent_unit_id and names spawnedByUnitId", () => {
    // §5.1: "The migration comment MUST disambiguate" — a human-facing note, so
    // it lives as source text near the migration entry rather than in the
    // executed SQL. Scanning the migrations.ts source itself (not the `up`
    // string) is the only way to assert on it.
    const migrationsSource = fs.readFileSync(
      path.resolve(import.meta.dir, "../../../src/core/state/migrations.ts"),
      "utf8",
    );
    const migrationSiteIndex = migrationsSource.indexOf(`id: "${MIGRATION_ID}"`);
    expect(migrationSiteIndex).toBeGreaterThan(-1);
    // The disambiguation is a comment ABOVE the migration entry, not below it —
    // look at a window immediately preceding the `id:` line.
    const precedingWindow = migrationsSource.slice(Math.max(0, migrationSiteIndex - 2000), migrationSiteIndex);
    expect(precedingWindow).toContain("workflow_run_units.parent_unit_id");
    expect(precedingWindow).toContain("spawnedByUnitId");
  });
});

describe("migration 023-child-workflow-runs — additive schema (C-01, C-02)", () => {
  test("a fresh state.db carries parent_run_id, parent_unit_id, invocation_key, and both indexes", () => {
    const db = openStateDatabase(statePath());
    try {
      const ids = (db.prepare("SELECT id FROM schema_migrations ORDER BY rowid").all() as Array<{ id: string }>).map(
        (row) => row.id,
      );
      expect(ids).toEqual(STATE_MIGRATIONS.map((migration) => migration.id));
      expect(ids).toContain(MIGRATION_ID);

      const columnNames = new Set(workflowRunsColumns(db).map((column) => column.name));
      for (const required of ["parent_run_id", "parent_unit_id", "invocation_key"]) {
        expect(columnNames.has(required)).toBe(true);
      }
      // Additive TEXT columns, nullable (no NOT NULL constraint on a bare
      // ADD COLUMN with no DEFAULT), never part of the primary key.
      for (const column of workflowRunsColumns(db)) {
        if (!["parent_run_id", "parent_unit_id", "invocation_key"].includes(column.name)) continue;
        expect(column.type.toUpperCase()).toBe("TEXT");
        expect(column.notnull).toBe(0);
        expect(column.pk).toBe(0);
      }

      const indexNames = new Set(workflowRunsIndexes(db).map((index) => index.name));
      expect(indexNames.has("idx_workflow_runs_parent")).toBe(true);
      expect(indexNames.has("idx_workflow_runs_invocation_key")).toBe(true);

      const invocationKeyIndex = workflowRunsIndexes(db).find(
        (index) => index.name === "idx_workflow_runs_invocation_key",
      );
      expect(invocationKeyIndex?.unique).toBe(1);
      // sqlite's index_list marks a partial index (one with a WHERE clause).
      expect(invocationKeyIndex?.partial).toBe(1);

      const parentIndexColumns = db
        .prepare(`PRAGMA index_info(${JSON.stringify("idx_workflow_runs_parent")})`)
        .all() as Array<{ name: string }>;
      expect(parentIndexColumns.map((column) => column.name)).toEqual(["parent_run_id"]);

      const invocationKeyIndexColumns = db
        .prepare(`PRAGMA index_info(${JSON.stringify("idx_workflow_runs_invocation_key")})`)
        .all() as Array<{ name: string }>;
      expect(invocationKeyIndexColumns.map((column) => column.name)).toEqual(["parent_run_id", "invocation_key"]);
    } finally {
      db.close();
    }
  });

  test("an existing pre-023 state.db migrates additively, preserving existing rows with the new columns NULL", () => {
    const file = statePath();
    const before023 = STATE_MIGRATIONS.slice(0, migrationIndex(MIGRATION_ID));
    const seeded = openDatabase(file);
    runMigrations(seeded, before023);
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
      if (!row) throw new Error("expected the pre-023 row to survive migration");
      expect(row.id).toBe("preexisting-run");
      expect(row.workflow_ref).toBe("workflows/preexisting");
      expect(row.scope_key).toBe("dir:v1:preexisting");
      expect(row.params_json).toBe('{"marker":"kept"}');
      expect(row.parent_run_id).toBeNull();
      expect(row.parent_unit_id).toBeNull();
      expect(row.invocation_key).toBeNull();
    } finally {
      upgraded.close();
    }
  });
});

describe("migration 023-child-workflow-runs — partial unique invocation-key index (C-04, C-05)", () => {
  function insertRun(
    db: { prepare(sql: string): { run(...params: unknown[]): unknown } },
    input: {
      id: string;
      workflowRef: string;
      scopeKey: string;
      parentRunId: string | null;
      parentUnitId: string | null;
      invocationKey: string | null;
    },
  ): void {
    const now = "2026-08-26T00:00:00.000Z";
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
          params_json, current_step_id, created_at, updated_at, checkin_armed_at,
          parent_run_id, parent_unit_id, invocation_key)
       VALUES (?, ?, ?, NULL, ?, 'active', '{}', NULL, ?, ?, NULL, ?, ?, ?)`,
    ).run(
      input.id,
      input.workflowRef,
      input.scopeKey,
      input.workflowRef,
      now,
      now,
      input.parentRunId,
      input.parentUnitId,
      input.invocationKey,
    );
  }

  test("two top-level rows (parent_run_id NULL) with invocation_key NULL both insert — the index is partial (C-05)", () => {
    const db = openStateDatabase(statePath());
    try {
      insertRun(db, {
        id: "top-1",
        workflowRef: "workflows/a",
        scopeKey: "dir:v1:a",
        parentRunId: null,
        parentUnitId: null,
        invocationKey: null,
      });
      expect(() =>
        insertRun(db, {
          id: "top-2",
          workflowRef: "workflows/b",
          scopeKey: "dir:v1:b",
          parentRunId: null,
          parentUnitId: null,
          invocationKey: null,
        }),
      ).not.toThrow();
      expect((db.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get() as { count: number }).count).toBe(2);
    } finally {
      db.close();
    }
  });

  test("two child rows under the same parent with the same invocation_key: the second insert violates the unique index (C-04)", () => {
    const db = openStateDatabase(statePath());
    try {
      insertRun(db, {
        id: "parent-1",
        workflowRef: "workflows/parent",
        scopeKey: "dir:v1:parent",
        parentRunId: null,
        parentUnitId: null,
        invocationKey: null,
      });
      insertRun(db, {
        id: "child-1",
        workflowRef: "workflows/child",
        scopeKey: "dir:v1:parent",
        parentRunId: "parent-1",
        parentUnitId: "spawn.unit",
        invocationKey: "shared-key",
      });
      expect(() =>
        insertRun(db, {
          id: "child-2",
          workflowRef: "workflows/child",
          scopeKey: "dir:v1:parent",
          parentRunId: "parent-1",
          parentUnitId: "spawn.unit",
          invocationKey: "shared-key",
        }),
      ).toThrow(/unique/i);
      expect((db.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get() as { count: number }).count).toBe(2);
    } finally {
      db.close();
    }
  });

  test("two child rows under the same parent with DIFFERENT invocation_keys both insert", () => {
    const db = openStateDatabase(statePath());
    try {
      insertRun(db, {
        id: "parent-2",
        workflowRef: "workflows/parent",
        scopeKey: "dir:v1:parent",
        parentRunId: null,
        parentUnitId: null,
        invocationKey: null,
      });
      insertRun(db, {
        id: "child-a",
        workflowRef: "workflows/child",
        scopeKey: "dir:v1:parent",
        parentRunId: "parent-2",
        parentUnitId: "spawn.unit",
        invocationKey: "key-a",
      });
      expect(() =>
        insertRun(db, {
          id: "child-b",
          workflowRef: "workflows/child",
          scopeKey: "dir:v1:parent",
          parentRunId: "parent-2",
          parentUnitId: "spawn.unit",
          invocationKey: "key-b",
        }),
      ).not.toThrow();
      expect((db.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get() as { count: number }).count).toBe(3);
    } finally {
      db.close();
    }
  });
});
