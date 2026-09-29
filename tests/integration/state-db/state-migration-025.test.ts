// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * TESTS for state migration `025-task-history-vocabulary-backfill`.
 *
 * This migration retires the D8 legacy `task_history.target_kind` read
 * mapping (`docs/architecture/decisions/0005-task-result-vocabulary-and-
 * legacy-read-mapping.md`'s 2026-09-01 supersession of row B-51,
 * `docs/plans/specs/p4-deletions-closeout.md`) by rewriting every
 * pre-D8 row to the current vocabulary once, in place, instead of leaving
 * three separate read sites to keep re-deriving the mapping forever.
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
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { openDatabase } from "../../../src/storage/database";
import { runMigrations } from "../../../src/storage/sqlite-migrations";
import { readTaskHistory } from "../../../src/tasks/run/task-history";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const MIGRATION_ID = "025-task-history-vocabulary-backfill";
const PRECEDING_MIGRATION_ID = "024-workflow-run-outputs";

const roots: string[] = [];

function statePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-state-migration-025-"));
  roots.push(root);
  return path.join(root, "state.db");
}

function migrationIndex(id: string): number {
  const index = STATE_MIGRATIONS.findIndex((migration) => migration.id === id);
  if (index < 0) throw new Error(`Missing state migration fixture ${id}`);
  return index;
}

interface RawTaskHistoryRow {
  task_id: string;
  target_kind: string | null;
  metadata_json: string;
}

function readRows(db: { prepare(sql: string): { all(...params: unknown[]): unknown } }): RawTaskHistoryRow[] {
  return db
    .prepare("SELECT task_id, target_kind, metadata_json FROM task_history ORDER BY task_id")
    .all() as RawTaskHistoryRow[];
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("migration 025-task-history-vocabulary-backfill — registry position and safety classification", () => {
  // #898 appended 026-proposals-strip-legacy-fragment-refs directly after
  // this one, so 025 is no longer the final registry entry — pin its
  // position relative to its immediate neighbors instead (append-only
  // registry order is still exactly preserved).
  test("comes directly after 024-workflow-run-outputs", () => {
    const ids = STATE_MIGRATIONS.map((migration) => migration.id);
    const index = ids.indexOf(MIGRATION_ID);
    expect(index).toBeGreaterThan(0);
    expect(ids[index - 1]).toBe(PRECEDING_MIGRATION_ID);
  });

  test("is classified data-preserving-rebuild", () => {
    expect(getStateMigrationSafety(MIGRATION_ID)).toBe("data-preserving-rebuild");
  });

  test("the safety-classification registry key order matches the migration registry order exactly", () => {
    expect(Object.keys(STATE_MIGRATION_SAFETY_BY_ID)).toEqual(STATE_MIGRATIONS.map((migration) => migration.id));
  });
});

describe("migration 025-task-history-vocabulary-backfill — legacy row backfill", () => {
  function seedPre025Db(file: string): void {
    const before025 = STATE_MIGRATIONS.slice(0, migrationIndex(MIGRATION_ID));
    const seeded = openDatabase(file);
    runMigrations(seeded, before025);
    const insert = seeded.prepare(
      `INSERT INTO task_history
         (task_id, status, started_at, completed_at, failed_at, log_path,
          target_kind, target_ref, metadata_json)
       VALUES (?, 'completed', ?, ?, NULL, NULL, ?, ?, ?)`,
    );
    // Legacy prepared-command (agent/LLM) arm: written as "prompt", no marker.
    insert.run(
      "legacy-prompt",
      "2025-01-01T00:00:00.000Z",
      "2025-01-01T00:00:01.000Z",
      "prompt",
      null,
      JSON.stringify({ metadataVersion: 2, durationMs: 1000, detail: null, engine: "opencode" }),
    );
    // Legacy native shell/script arm: written as "command", no marker.
    insert.run(
      "legacy-command",
      "2025-01-02T00:00:00.000Z",
      "2025-01-02T00:00:01.000Z",
      "command",
      null,
      JSON.stringify({ metadataVersion: 2, durationMs: 1000, detail: null }),
    );
    // Legacy workflow arm: label unchanged across vocabularies.
    insert.run(
      "legacy-workflow",
      "2025-01-03T00:00:00.000Z",
      "2025-01-03T00:00:01.000Z",
      "workflow",
      "workflows/noop",
      JSON.stringify({ metadataVersion: 2, durationMs: 1000, detail: null }),
    );
    // Already-current row (new vocabulary, already marked): must be left alone.
    insert.run(
      "current-command",
      "2025-01-04T00:00:00.000Z",
      "2025-01-04T00:00:01.000Z",
      "command",
      null,
      JSON.stringify({ metadataVersion: 2, durationMs: 1000, detail: null, engine: "opencode", targetVocab: 2 }),
    );
    // Genuinely corrupt metadata_json must survive untouched (json_valid guard).
    insert.run("legacy-corrupt", "2025-01-05T00:00:00.000Z", "2025-01-05T00:00:01.000Z", "prompt", null, "{not json");
    seeded.close();
  }

  test("rewrites legacy 'prompt' rows to 'command' and legacy 'command' rows to 'shell', stamping targetVocab: 2", () => {
    const file = statePath();
    seedPre025Db(file);

    const upgraded = openStateDatabase(file);
    try {
      const ids = (
        upgraded.prepare("SELECT id FROM schema_migrations ORDER BY rowid").all() as Array<{ id: string }>
      ).map((row) => row.id);
      expect(ids).toContain(MIGRATION_ID);

      const rows = readRows(upgraded);
      const byId = new Map(rows.map((row) => [row.task_id, row]));

      const prompt = byId.get("legacy-prompt");
      expect(prompt?.target_kind).toBe("command");
      expect(JSON.parse(prompt?.metadata_json ?? "{}")).toMatchObject({ targetVocab: 2, engine: "opencode" });

      const command = byId.get("legacy-command");
      expect(command?.target_kind).toBe("shell");
      expect(JSON.parse(command?.metadata_json ?? "{}")).toMatchObject({ targetVocab: 2 });

      const workflow = byId.get("legacy-workflow");
      expect(workflow?.target_kind).toBe("workflow");

      const current = byId.get("current-command");
      expect(current?.target_kind).toBe("command");
      expect(JSON.parse(current?.metadata_json ?? "{}")).toMatchObject({ targetVocab: 2, engine: "opencode" });

      const corrupt = byId.get("legacy-corrupt");
      expect(corrupt?.target_kind).toBe("prompt");
      expect(corrupt?.metadata_json).toBe("{not json");
    } finally {
      upgraded.close();
    }
  });

  describe("readTaskHistory end-to-end", () => {
    let storage: IsolatedAkmStorage;

    afterEach(() => storage.cleanup());

    test("reads every backfilled row in the current vocabulary with no marker branching", () => {
      storage = withIsolatedAkmStorage();
      const file = getStateDbPath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      seedPre025Db(file);
      // Exercise the migration through the same path production code uses:
      // the next open (readTaskHistory's withStateDb -> openStateDatabase())
      // applies every pending migration, including 025.
      const rows = readTaskHistory({ limit: 50 });
      const byId = new Map(rows.map((row) => [row.id, row]));

      expect(byId.get("legacy-prompt")?.target).toEqual({ kind: "command", engine: "opencode" });
      expect(byId.get("legacy-command")?.target).toEqual({ kind: "shell" });
      expect(byId.get("legacy-workflow")?.target).toEqual({ kind: "workflow", ref: "workflows/noop" });
      expect(byId.get("current-command")?.target).toEqual({ kind: "command", engine: "opencode" });
    });
  });
});
