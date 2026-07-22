// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * @removeIn 0.10.0
 *
 * FROZEN copy of the `WORKFLOW_MIGRATIONS` migration BODIES — the verbatim
 * `{ id, up }` DDL of the 10 pre-cutover workflow.db migrations plus the
 * `ensureBaseSchema` baseline DDL (`src/workflows/db.ts`, 001-add-scope-key …
 * 010-ir-v3-engine). akm 0.9.0 chunk-8, WI-8.3 (plan §3.3/§8.2;
 * chunk-8 brief + cutover design §4).
 *
 * ## Why this frozen copy exists
 *
 * WI-8.3 DELETES `src/workflows/db.ts` outright, taking the live
 * `WORKFLOW_MIGRATIONS` array (and its `ensureBaseSchema`) with it. But the
 * three-DB cutover (`src/cli/config-migrate.ts` `runFrozenWorkflowRoll`) must
 * still be able to ROLL an existing pre-cutover workflow.db forward to its
 * final ledger (010) before merging it into state.db, so every column the
 * migrations add (defaults, back-fills) is materialised faithfully. It rolls
 * these frozen bodies through the shared engine (`runSqliteMigrations`).
 *
 * ## The sibling ids+checksums copy
 *
 * `./workflow-migrations-frozen.ts` (WI-8.1) holds the pre-computed
 * `{ id, checksum }` snapshot used for BACKUP verification. These bodies and
 * that snapshot are cross-pinned:
 * `tests/migrate/legacy/workflow-migrations-bodies.test.ts` asserts each frozen
 * body's computed `migrationChecksum` equals the corresponding
 * `WORKFLOW_MIGRATIONS_CHECKSUMS` entry — which transitively proves these
 * bodies are byte-faithful to the pre-deletion live array (the checksum
 * snapshot was itself pinned to that array in WI-8.1).
 *
 * The only `src/` import here is the shared-engine `Migration` TYPE (not
 * `src/workflows/`), part of the migration engine preserved through the
 * cutover (plan §8.3) — so this module survives that directory's deletion.
 *
 * NOTE: the `up` strings are stored JSON-escaped (explicit `\n`) rather than as
 * template literals so they are unambiguously byte-identical to the deleted
 * live bodies — the pin test fails on any drift.
 */

import type { Migration } from "../../storage/engines/sqlite-migrations";

/**
 * Frozen `ensureBaseSchema` baseline DDL — the `workflow_runs` /
 * `workflow_run_steps` tables as `openWorkflowDatabase` created them before
 * evaluating the migration list. Idempotent (`CREATE TABLE IF NOT EXISTS`), so
 * running it against an existing workflow.db is a no-op.
 */
export const FROZEN_WORKFLOW_BASE_SCHEMA_DDL =
  "\n    CREATE TABLE IF NOT EXISTS workflow_runs (\n      id                TEXT PRIMARY KEY,\n      workflow_ref      TEXT NOT NULL,\n      workflow_entry_id INTEGER,\n      workflow_title    TEXT NOT NULL,\n      status            TEXT NOT NULL CHECK (status IN ('active', 'completed', 'blocked', 'failed')),\n      params_json       TEXT NOT NULL DEFAULT '{}',\n      current_step_id   TEXT,\n      created_at        TEXT NOT NULL,\n      updated_at        TEXT NOT NULL,\n      completed_at      TEXT\n    );\n\n    CREATE INDEX IF NOT EXISTS idx_workflow_runs_ref ON workflow_runs(workflow_ref);\n    CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);\n\n    CREATE TABLE IF NOT EXISTS workflow_run_steps (\n      run_id          TEXT NOT NULL,\n      step_id         TEXT NOT NULL,\n      step_title      TEXT NOT NULL,\n      instructions    TEXT NOT NULL,\n      completion_json TEXT,\n      sequence_index  INTEGER NOT NULL,\n      status          TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'blocked', 'failed', 'skipped')),\n      notes           TEXT,\n      evidence_json   TEXT,\n      completed_at    TEXT,\n      PRIMARY KEY (run_id, step_id),\n      FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE\n    );\n\n    CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_run_sequence\n      ON workflow_run_steps(run_id, sequence_index);\n  ";

/**
 * Frozen `{ id, up }` snapshot of the 10 `WORKFLOW_MIGRATIONS` bodies at the akm
 * 0.9.0 pre-cutover HEAD. Order is significant — it is the exact append-only
 * migration order `runSqliteMigrations` applies against a pre-cutover
 * workflow.db.
 */
export const FROZEN_WORKFLOW_MIGRATIONS: readonly Migration[] = [
  {
    id: "001-add-scope-key",
    up: "\n      ALTER TABLE workflow_runs ADD COLUMN scope_key TEXT;\n\n      CREATE INDEX IF NOT EXISTS idx_workflow_runs_scope_ref_status\n        ON workflow_runs(scope_key, workflow_ref, status);\n    ",
  },
  {
    id: "002-add-agent-identity",
    up: "\n      ALTER TABLE workflow_runs ADD COLUMN agent_harness TEXT;\n      ALTER TABLE workflow_runs ADD COLUMN agent_session_id TEXT;\n\n      CREATE INDEX IF NOT EXISTS idx_workflow_runs_agent_session\n        ON workflow_runs(agent_harness, agent_session_id);\n    ",
  },
  {
    id: "003-checkin-and-step-summary",
    up: "\n      ALTER TABLE workflow_runs ADD COLUMN checkin_armed_at TEXT;\n      ALTER TABLE workflow_run_steps ADD COLUMN summary TEXT;\n    ",
  },
  {
    id: "004-workflow-run-units",
    up: "\n      CREATE TABLE IF NOT EXISTS workflow_run_units (\n        run_id         TEXT NOT NULL,\n        unit_id        TEXT NOT NULL,\n        step_id        TEXT,\n        node_id        TEXT NOT NULL,\n        parent_unit_id TEXT,\n        phase          TEXT,\n        runner         TEXT,\n        model          TEXT,\n        status         TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),\n        input_hash     TEXT,\n        result_json    TEXT,\n        tokens         INTEGER,\n        failure_reason TEXT,\n        worktree_path  TEXT,\n        started_at     TEXT,\n        finished_at    TEXT,\n        PRIMARY KEY (run_id, unit_id),\n        FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE\n      );\n\n      CREATE INDEX IF NOT EXISTS idx_workflow_run_units_run_step\n        ON workflow_run_units(run_id, step_id);\n    ",
  },
  { id: "005-unit-session-id", up: "\n      ALTER TABLE workflow_run_units ADD COLUMN session_id TEXT;\n    " },
  {
    id: "006-frozen-plan-and-lease",
    up: "\n      ALTER TABLE workflow_runs ADD COLUMN plan_json TEXT;\n      ALTER TABLE workflow_runs ADD COLUMN plan_hash TEXT;\n      ALTER TABLE workflow_runs ADD COLUMN engine_lease_until TEXT;\n      ALTER TABLE workflow_runs ADD COLUMN engine_lease_holder TEXT;\n    ",
  },
  { id: "007-unit-last-checkin", up: "\n      ALTER TABLE workflow_run_units ADD COLUMN last_checkin_at TEXT;\n    " },
  {
    id: "008-unit-attempts",
    up: "\n      ALTER TABLE workflow_run_units ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;\n    ",
  },
  {
    id: "009-unit-claim",
    up: "\n      ALTER TABLE workflow_run_units ADD COLUMN claim_holder TEXT;\n      ALTER TABLE workflow_run_units ADD COLUMN claim_expires_at TEXT;\n    ",
  },
  {
    id: "010-ir-v3-engine",
    up: "\n      ALTER TABLE workflow_runs ADD COLUMN plan_ir_version INTEGER;\n      ALTER TABLE workflow_run_units ADD COLUMN engine TEXT;\n    ",
  },
];
