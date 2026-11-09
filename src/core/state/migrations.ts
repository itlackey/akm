// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The state.db schema registry. Released databases carry a `schema_migrations`
// ledger of the 29 ids below; the schema those 29 steps produced is the
// baseline, created in one step on a fresh database. A ledger shorter than the
// baseline predates akm 0.9.32 and is refused (`src/core/state-db.ts`). New
// migrations are APPENDED after the baseline ids and an id is NEVER renumbered
// or reordered; the shared runner at src/storage/sqlite-migrations.ts applies
// them in array order.

import { assertMigrationRegistry, type Migration } from "../../storage/sqlite-migrations";

/** The released ledger: every id a database at the 0.9.32 floor has applied, in order. */
export const STATE_BASELINE_IDS: readonly string[] = [
  "001-initial-schema",
  "002-task-history-per-run",
  "003-improve-runs",
  "004-extract-sessions-seen",
  "005-proposal-fs-imports",
  "006-proposals-pending-ref-source",
  "007-consolidation-judged",
  "008-body-embeddings",
  "009-asset-salience",
  "010-asset-outcome",
  "011-asset-salience-homeostatic-demoted-at",
  "012-improve-gate-thresholds",
  "013-extract-sessions-content-hash",
  "014-recombine-hypotheses",
  "015-asset-salience-encoding-source",
  "016-collapse-churn-detector",
  "017-improve-run-strategy",
  "018-drop-dead-lane-schema",
  "019-proposal-fingerprints",
  "020-three-db-cutover",
  "021-asset-state-missing-since",
  "022-workflow-unit-attempts",
  "023-child-workflow-runs",
  "024-workflow-run-outputs",
  "025-task-history-vocabulary-backfill",
  "026-proposals-strip-legacy-fragment-refs",
  "027-extract-sessions-seen-harness-rename",
  "028-improve-ledger",
  "029-improve-ledger-content-hash",
];

const STATE_BASELINE_SCHEMA = `
CREATE TABLE events (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type     TEXT    NOT NULL,
        ts             TEXT    NOT NULL,
        ref            TEXT,
        metadata_json  TEXT    NOT NULL DEFAULT '{}'
      );

CREATE TABLE proposals (
        id               TEXT    PRIMARY KEY,
        stash_dir        TEXT    NOT NULL,
        ref              TEXT    NOT NULL,
        status           TEXT    NOT NULL DEFAULT 'pending',
        source           TEXT    NOT NULL,
        created_at       TEXT    NOT NULL,
        updated_at       TEXT    NOT NULL,
        content          TEXT    NOT NULL DEFAULT '',
        frontmatter_json TEXT,
        metadata_json    TEXT    NOT NULL DEFAULT '{}'
      );

CREATE TABLE task_history (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id       TEXT    NOT NULL,
        status        TEXT    NOT NULL,
        started_at    TEXT    NOT NULL,
        completed_at  TEXT,
        failed_at     TEXT,
        log_path      TEXT,
        target_kind   TEXT,
        target_ref    TEXT,
        metadata_json TEXT    NOT NULL DEFAULT '{}'
      );

CREATE TABLE improve_runs (
        id            TEXT    PRIMARY KEY,
        started_at    TEXT    NOT NULL,
        completed_at  TEXT,
        stash_dir     TEXT    NOT NULL,
        dry_run       INTEGER NOT NULL DEFAULT 0,
        profile       TEXT,
        scope_mode    TEXT    NOT NULL,
        scope_value   TEXT,
        guidance      TEXT,
        ok            INTEGER NOT NULL,
        result_json   TEXT    NOT NULL,
        metrics_json  TEXT,
        metadata_json TEXT    NOT NULL DEFAULT '{}'
      , strategy TEXT);

CREATE TABLE extract_sessions_seen (
        harness          TEXT    NOT NULL,
        session_id       TEXT    NOT NULL,
        processed_at     TEXT    NOT NULL,
        session_ended_at TEXT,
        outcome          TEXT    NOT NULL,
        candidate_count  INTEGER NOT NULL DEFAULT 0,
        proposal_count   INTEGER NOT NULL DEFAULT 0,
        rationale        TEXT,
        source_run       TEXT,
        metadata_json    TEXT    NOT NULL DEFAULT '{}', content_hash TEXT DEFAULT NULL,
        PRIMARY KEY (harness, session_id)
      );

CREATE TABLE body_embeddings (
        content_hash TEXT    PRIMARY KEY,
        embedding    BLOB    NOT NULL,
        model_id     TEXT    NOT NULL,
        created_at   INTEGER NOT NULL
      );

CREATE TABLE asset_salience (
        asset_ref          TEXT    PRIMARY KEY,
        encoding_salience  REAL    NOT NULL DEFAULT 0.5,
        outcome_salience   REAL    NOT NULL DEFAULT 0.0,
        retrieval_salience REAL    NOT NULL DEFAULT 0.0,
        rank_score         REAL    NOT NULL DEFAULT 0.0,
        consecutive_no_ops INTEGER NOT NULL DEFAULT 0,
        updated_at         INTEGER NOT NULL DEFAULT 0
      , homeostatic_demoted_at INTEGER DEFAULT NULL, encoding_source TEXT DEFAULT NULL, missing_since INTEGER DEFAULT NULL);

CREATE TABLE asset_outcome (
        asset_ref                TEXT    PRIMARY KEY,
        last_retrieved_at        INTEGER NOT NULL DEFAULT 0,
        retrieval_count          INTEGER NOT NULL DEFAULT 0,
        expected_retrieval_rate  REAL    NOT NULL DEFAULT 0.0,
        negative_feedback_count  INTEGER NOT NULL DEFAULT 0,
        accepted_change_count    INTEGER NOT NULL DEFAULT 0,
        outcome_score            REAL    NOT NULL DEFAULT 0.0,
        updated_at               INTEGER NOT NULL DEFAULT 0
      , missing_since INTEGER DEFAULT NULL);

CREATE TABLE workflow_runs (
        id                  TEXT PRIMARY KEY,
        workflow_ref        TEXT NOT NULL,
        workflow_entry_id   INTEGER,
        workflow_title      TEXT NOT NULL,
        status              TEXT NOT NULL CHECK (status IN ('active', 'completed', 'blocked', 'failed')),
        params_json         TEXT NOT NULL DEFAULT '{}',
        current_step_id     TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        completed_at        TEXT,
        scope_key           TEXT,
        agent_harness       TEXT,
        agent_session_id    TEXT,
        checkin_armed_at    TEXT,
        plan_json           TEXT,
        plan_hash           TEXT,
        engine_lease_until  TEXT,
        engine_lease_holder TEXT,
        plan_ir_version     INTEGER
      , parent_run_id  TEXT, parent_unit_id TEXT, invocation_key TEXT, outputs_json TEXT);

CREATE TABLE workflow_run_steps (
        run_id          TEXT NOT NULL,
        step_id         TEXT NOT NULL,
        step_title      TEXT NOT NULL,
        instructions    TEXT NOT NULL,
        completion_json TEXT,
        sequence_index  INTEGER NOT NULL,
        status          TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'blocked', 'failed', 'skipped')),
        notes           TEXT,
        evidence_json   TEXT,
        completed_at    TEXT,
        summary         TEXT,
        PRIMARY KEY (run_id, step_id),
        FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
      );

CREATE TABLE workflow_run_units (
        run_id           TEXT NOT NULL,
        unit_id          TEXT NOT NULL,
        step_id          TEXT,
        node_id          TEXT NOT NULL,
        parent_unit_id   TEXT,
        phase            TEXT,
        runner           TEXT,
        model            TEXT,
        status           TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
        input_hash       TEXT,
        result_json      TEXT,
        tokens           INTEGER,
        failure_reason   TEXT,
        worktree_path    TEXT,
        started_at       TEXT,
        finished_at      TEXT,
        session_id       TEXT,
        last_checkin_at  TEXT,
        attempts         INTEGER NOT NULL DEFAULT 1,
        claim_holder     TEXT,
        claim_expires_at TEXT,
        engine           TEXT,
        PRIMARY KEY (run_id, unit_id),
        FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
      );

CREATE TABLE usage_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        query      TEXT,
        entry_id   INTEGER,
        entry_ref  TEXT,
        signal     TEXT,
        metadata   TEXT,
        source     TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

CREATE TABLE legacy_state (
        surface        TEXT NOT NULL,
        old_ref        TEXT NOT NULL,
        row_count      INTEGER NOT NULL DEFAULT 0,
        reason         TEXT NOT NULL,
        quarantined_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (surface, old_ref)
      );

CREATE TABLE workflow_run_unit_attempts (
        run_id           TEXT NOT NULL,
        unit_id          TEXT NOT NULL,
        attempt          INTEGER NOT NULL CHECK (attempt >= 1),
        dispatch_id      TEXT NOT NULL,
        step_id          TEXT NOT NULL,
        node_id          TEXT NOT NULL,
        phase            TEXT NOT NULL CHECK (phase IN ('unit', 'gate')),
        runner           TEXT,
        engine           TEXT,
        model            TEXT,
        input_hash       TEXT NOT NULL,
        status           TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
        result_json      TEXT,
        tokens           INTEGER,
        failure_reason   TEXT,
        session_id       TEXT,
        worktree_path    TEXT,
        started_at       TEXT NOT NULL,
        finished_at      TEXT,
        claim_holder     TEXT NOT NULL,
        claim_expires_at TEXT NOT NULL,
        PRIMARY KEY (run_id, unit_id, attempt),
        FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
      );

CREATE TABLE improve_ledger (
        stash_dir TEXT NOT NULL,
        ref TEXT NOT NULL,
        source TEXT NOT NULL,
        last_attempt_at TEXT NOT NULL,
        outcome TEXT NOT NULL,
        next_eligible_at TEXT,
        proposal_id TEXT,
        detail TEXT, content_hash TEXT DEFAULT NULL,
        PRIMARY KEY (stash_dir, ref, source)
      );

CREATE INDEX idx_events_type ON events(event_type);

CREATE INDEX idx_events_ref  ON events(ref);

CREATE INDEX idx_events_ts   ON events(ts);

CREATE INDEX idx_proposals_stash_status
        ON proposals(stash_dir, status);

CREATE INDEX idx_proposals_ref_status
        ON proposals(ref, status);

CREATE UNIQUE INDEX idx_task_history_run
        ON task_history(task_id, started_at);

CREATE INDEX idx_task_history_task_id
        ON task_history(task_id);

CREATE INDEX idx_task_history_started
        ON task_history(started_at);

CREATE INDEX idx_task_history_target
        ON task_history(target_kind, target_ref);

CREATE INDEX idx_task_history_status
        ON task_history(status);

CREATE INDEX idx_improve_runs_started
        ON improve_runs(started_at);

CREATE INDEX idx_improve_runs_dry_run
        ON improve_runs(dry_run);

CREATE INDEX idx_improve_runs_stash_scope
        ON improve_runs(stash_dir, scope_mode);

CREATE INDEX idx_extract_sessions_harness
        ON extract_sessions_seen(harness);

CREATE INDEX idx_extract_sessions_processed
        ON extract_sessions_seen(processed_at);

CREATE INDEX idx_proposals_stash_status_ref_source
        ON proposals(stash_dir, status, ref, source);

CREATE INDEX idx_asset_salience_rank
        ON asset_salience(rank_score DESC);

CREATE INDEX idx_asset_outcome_score
        ON asset_outcome(outcome_score DESC);

CREATE INDEX idx_improve_runs_strategy_started ON improve_runs(strategy, started_at);

CREATE INDEX idx_workflow_runs_ref ON workflow_runs(workflow_ref);

CREATE INDEX idx_workflow_runs_status ON workflow_runs(status);

CREATE INDEX idx_workflow_runs_scope_ref_status
        ON workflow_runs(scope_key, workflow_ref, status);

CREATE INDEX idx_workflow_runs_agent_session
        ON workflow_runs(agent_harness, agent_session_id);

CREATE INDEX idx_workflow_run_steps_run_sequence
        ON workflow_run_steps(run_id, sequence_index);

CREATE INDEX idx_workflow_run_units_run_step
        ON workflow_run_units(run_id, step_id);

CREATE INDEX idx_usage_events_entry ON usage_events(entry_id);

CREATE INDEX idx_usage_events_type ON usage_events(event_type);

CREATE INDEX idx_usage_events_ref ON usage_events(entry_ref);

CREATE INDEX idx_usage_events_source ON usage_events(source);

CREATE UNIQUE INDEX idx_workflow_run_unit_attempts_dispatch
        ON workflow_run_unit_attempts(dispatch_id);

CREATE INDEX idx_workflow_run_unit_attempts_run_step
        ON workflow_run_unit_attempts(run_id, step_id, unit_id, attempt);

CREATE INDEX idx_workflow_run_unit_attempts_running_claim
        ON workflow_run_unit_attempts(run_id, status, claim_expires_at);

CREATE INDEX idx_workflow_runs_parent ON workflow_runs(parent_run_id);

CREATE UNIQUE INDEX idx_workflow_runs_invocation_key
        ON workflow_runs(parent_run_id, invocation_key)
        WHERE parent_run_id IS NOT NULL;
`;

export const STATE_MIGRATIONS: readonly Migration[] = [
  // The first baseline id carries the whole baseline schema; the rest only complete the ledger.
  ...STATE_BASELINE_IDS.map((id, index): Migration => ({ id, up: index === 0 ? STATE_BASELINE_SCHEMA : "" })),
];

assertMigrationRegistry(STATE_MIGRATIONS);
