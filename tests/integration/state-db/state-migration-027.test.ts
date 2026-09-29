// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * TESTS for state migration `027-extract-sessions-seen-harness-rename` (#915).
 *
 * The 0.9.2 harness id rename (`ClaudeCodeProvider.name` "claude-code" ->
 * "claude") deleted the `HARNESS_BY_ANY_ID` compatibility bridge in the same
 * change that made new writes use "claude", with no data migration —
 * stranding every row a pre-0.9.2 akm wrote under the old key in
 * `extract_sessions_seen` (PK `(harness, session_id)`) and
 * `workflow_runs.agent_harness`. This migration renames the key in place,
 * conflict-tolerant against a session already recorded under "claude".
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

const MIGRATION_ID = "027-extract-sessions-seen-harness-rename";
const PRECEDING_MIGRATION_ID = "026-proposals-strip-legacy-fragment-refs";

const roots: string[] = [];

function statePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-state-migration-027-"));
  roots.push(root);
  return path.join(root, "state.db");
}

function migrationIndex(id: string): number {
  const index = STATE_MIGRATIONS.findIndex((migration) => migration.id === id);
  if (index < 0) throw new Error(`Missing state migration fixture ${id}`);
  return index;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("migration 027-extract-sessions-seen-harness-rename — registry position and safety classification", () => {
  test("is registered directly after 026-proposals-strip-legacy-fragment-refs", () => {
    const ids = STATE_MIGRATIONS.map((migration) => migration.id);
    const index = ids.indexOf(MIGRATION_ID);
    expect(index).toBeGreaterThan(-1);
    expect(ids[index - 1]).toBe(PRECEDING_MIGRATION_ID);
  });

  test("is classified data-preserving-rebuild", () => {
    expect(Object.keys(STATE_MIGRATION_SAFETY_BY_ID)).toContain(MIGRATION_ID);
    expect(getStateMigrationSafety(MIGRATION_ID)).toBe("data-preserving-rebuild");
  });
});

interface ExtractSessionsRow {
  harness: string;
  session_id: string;
  outcome: string;
  candidate_count: number;
  source_run: string | null;
}

interface WorkflowRunRow {
  id: string;
  agent_harness: string | null;
}

/**
 * Seeds a state.db at the ledger position immediately before migration 027,
 * with `extract_sessions_seen` and `workflow_runs` rows shaped like the field
 * report in #915:
 *   - a "claude-code" row with no "claude" counterpart (the common case:
 *     5,802 of the 5,803 stranded rows on the reporting machine) — must move.
 *   - a "claude-code" row that COLLIDES on session_id with an existing
 *     "claude" row (the PK conflict case, 1 row on the reporting machine) —
 *     the "claude" row must survive unchanged, the "claude-code" duplicate
 *     must vanish, not overwrite it.
 *   - an "opencode" row, untouched by either UPDATE (control).
 *   - workflow_runs rows under "claude-code" and "opencode".
 */
function seedPre027Db(file: string): void {
  const before027 = STATE_MIGRATIONS.slice(0, migrationIndex(MIGRATION_ID));
  const seeded = openDatabase(file);
  runMigrations(seeded, before027);

  const insertSession = seeded.prepare(`
    INSERT INTO extract_sessions_seen
      (harness, session_id, processed_at, session_ended_at, outcome,
       candidate_count, proposal_count, rationale, source_run, metadata_json, content_hash)
    VALUES (?, ?, ?, NULL, ?, ?, 0, NULL, ?, '{}', NULL)
  `);
  // Non-colliding: only ever recorded under the retired name.
  insertSession.run(
    "claude-code",
    "session-non-colliding",
    "2026-05-01T00:00:00.000Z",
    "no_candidates",
    4374,
    "run-old-1",
  );
  // Colliding: the same session_id recorded under BOTH names. The "claude"
  // row is the newer, real run and must win.
  insertSession.run("claude-code", "session-colliding", "2026-05-01T00:00:00.000Z", "skipped", 0, "run-old-2");
  insertSession.run("claude", "session-colliding", "2026-09-01T00:00:00.000Z", "candidates_queued", 2, "run-new-1");
  // Control: a different harness entirely, must be untouched.
  insertSession.run("opencode", "session-opencode", "2026-05-01T00:00:00.000Z", "no_candidates", 1019, "run-old-3");

  const insertRun = seeded.prepare(`
    INSERT INTO workflow_runs
      (id, workflow_ref, workflow_title, status, created_at, updated_at, agent_harness)
    VALUES (?, 'workflows/example', 'Example', 'completed', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', ?)
  `);
  insertRun.run("run-claude-code", "claude-code");
  insertRun.run("run-opencode", "opencode");

  seeded.close();
}

describe("migration 027-extract-sessions-seen-harness-rename — behavior", () => {
  test("moves non-colliding rows, keeps the colliding claude row unchanged, drops every claude-code row", () => {
    const file = statePath();
    seedPre027Db(file);

    const upgraded = openStateDatabase(file);
    try {
      const ids = (
        upgraded.prepare("SELECT id FROM schema_migrations ORDER BY rowid").all() as Array<{ id: string }>
      ).map((row) => row.id);
      expect(ids).toContain(MIGRATION_ID);

      const rows = upgraded
        .prepare(
          "SELECT harness, session_id, outcome, candidate_count, source_run FROM extract_sessions_seen ORDER BY harness, session_id",
        )
        .all() as ExtractSessionsRow[];

      // No "claude-code" key space survives.
      expect(rows.some((r) => r.harness === "claude-code")).toBe(false);

      const bySessionAndHarness = new Map(rows.map((r) => [`${r.harness}/${r.session_id}`, r]));

      // Non-colliding row moved to "claude", outcome preserved verbatim.
      const moved = bySessionAndHarness.get("claude/session-non-colliding");
      expect(moved).toBeDefined();
      expect(moved?.outcome).toBe("no_candidates");
      expect(moved?.candidate_count).toBe(4374);
      expect(moved?.source_run).toBe("run-old-1");

      // Colliding row: the pre-existing "claude" row survives byte-for-byte —
      // NOT overwritten by the "claude-code" duplicate's stale outcome.
      const collided = bySessionAndHarness.get("claude/session-colliding");
      expect(collided).toBeDefined();
      expect(collided?.outcome).toBe("candidates_queued");
      expect(collided?.candidate_count).toBe(2);
      expect(collided?.source_run).toBe("run-new-1");

      // Exactly one row for the colliding session_id — the "claude-code"
      // duplicate did not survive as a second row.
      expect(rows.filter((r) => r.session_id === "session-colliding")).toHaveLength(1);

      // Untouched control row.
      const control = bySessionAndHarness.get("opencode/session-opencode");
      expect(control).toBeDefined();
      expect(control?.outcome).toBe("no_candidates");
      expect(control?.candidate_count).toBe(1019);

      // Total row count: 3 non-colliding-shape rows (moved, collided-survivor,
      // control) — the colliding "claude-code" duplicate is gone, not merely
      // ignored-and-left-behind.
      expect(rows).toHaveLength(3);
    } finally {
      upgraded.close();
    }
  });

  test("rewrites workflow_runs.agent_harness from claude-code to claude, leaves other harnesses alone", () => {
    const file = statePath();
    seedPre027Db(file);

    const upgraded = openStateDatabase(file);
    try {
      const runs = upgraded
        .prepare("SELECT id, agent_harness FROM workflow_runs ORDER BY id")
        .all() as WorkflowRunRow[];
      const byId = new Map(runs.map((r) => [r.id, r]));

      expect(byId.get("run-claude-code")?.agent_harness).toBe("claude");
      expect(byId.get("run-opencode")?.agent_harness).toBe("opencode");
      expect(runs.some((r) => r.agent_harness === "claude-code")).toBe(false);
    } finally {
      upgraded.close();
    }
  });
});
