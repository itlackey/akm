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
CREATE TABLE asset_salience (
        asset_ref          TEXT    PRIMARY KEY,
        encoding_salience  REAL    NOT NULL DEFAULT 0.5,
        outcome_salience   REAL    NOT NULL DEFAULT 0.0,
        retrieval_salience REAL    NOT NULL DEFAULT 0.0,
        rank_score         REAL    NOT NULL DEFAULT 0.0,
        consecutive_no_ops INTEGER NOT NULL DEFAULT 0,
        updated_at         INTEGER NOT NULL DEFAULT 0
      , homeostatic_demoted_at INTEGER DEFAULT NULL, encoding_source TEXT DEFAULT NULL, missing_since INTEGER DEFAULT NULL);
CREATE TABLE body_embeddings (
        content_hash TEXT    PRIMARY KEY,
        embedding    BLOB    NOT NULL,
        model_id     TEXT    NOT NULL,
        created_at   INTEGER NOT NULL
      );
CREATE TABLE events (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type     TEXT    NOT NULL,
        ts             TEXT    NOT NULL,
        ref            TEXT,
        metadata_json  TEXT    NOT NULL DEFAULT '{}'
      );
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
CREATE TABLE legacy_state (
        surface        TEXT NOT NULL,
        old_ref        TEXT NOT NULL,
        row_count      INTEGER NOT NULL DEFAULT 0,
        reason         TEXT NOT NULL,
        quarantined_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (surface, old_ref)
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
CREATE TABLE schema_migrations (
      id         TEXT    PRIMARY KEY,
      applied_at TEXT    NOT NULL DEFAULT (datetime('now'))
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
CREATE INDEX idx_asset_outcome_score
        ON asset_outcome(outcome_score DESC);
CREATE INDEX idx_asset_salience_rank
        ON asset_salience(rank_score DESC);
CREATE INDEX idx_events_ref  ON events(ref);
CREATE INDEX idx_events_ts   ON events(ts);
CREATE INDEX idx_events_type ON events(event_type);
CREATE INDEX idx_extract_sessions_harness
        ON extract_sessions_seen(harness);
CREATE INDEX idx_extract_sessions_processed
        ON extract_sessions_seen(processed_at);
CREATE INDEX idx_improve_runs_dry_run
        ON improve_runs(dry_run);
CREATE INDEX idx_improve_runs_started
        ON improve_runs(started_at);
CREATE INDEX idx_improve_runs_stash_scope
        ON improve_runs(stash_dir, scope_mode);
CREATE INDEX idx_improve_runs_strategy_started ON improve_runs(strategy, started_at);
CREATE INDEX idx_proposals_ref_status
        ON proposals(ref, status);
CREATE INDEX idx_proposals_stash_status
        ON proposals(stash_dir, status);
CREATE INDEX idx_proposals_stash_status_ref_source
        ON proposals(stash_dir, status, ref, source);
CREATE UNIQUE INDEX idx_task_history_run
        ON task_history(task_id, started_at);
CREATE INDEX idx_task_history_started
        ON task_history(started_at);
CREATE INDEX idx_task_history_status
        ON task_history(status);
CREATE INDEX idx_task_history_target
        ON task_history(target_kind, target_ref);
CREATE INDEX idx_task_history_task_id
        ON task_history(task_id);
CREATE INDEX idx_usage_events_created_at ON usage_events(datetime(created_at));
CREATE INDEX idx_usage_events_entry ON usage_events(entry_id);
CREATE INDEX idx_usage_events_ref ON usage_events(entry_ref);
CREATE INDEX idx_usage_events_source ON usage_events(source);
CREATE INDEX idx_usage_events_type ON usage_events(event_type);
CREATE INDEX idx_workflow_run_steps_run_sequence
        ON workflow_run_steps(run_id, sequence_index);
CREATE UNIQUE INDEX idx_workflow_run_unit_attempts_dispatch
        ON workflow_run_unit_attempts(dispatch_id);
CREATE INDEX idx_workflow_run_unit_attempts_run_step
        ON workflow_run_unit_attempts(run_id, step_id, unit_id, attempt);
CREATE INDEX idx_workflow_run_unit_attempts_running_claim
        ON workflow_run_unit_attempts(run_id, status, claim_expires_at);
CREATE INDEX idx_workflow_run_units_run_step
        ON workflow_run_units(run_id, step_id);
CREATE INDEX idx_workflow_runs_agent_session
        ON workflow_runs(agent_harness, agent_session_id);
CREATE UNIQUE INDEX idx_workflow_runs_invocation_key
        ON workflow_runs(parent_run_id, invocation_key)
        WHERE parent_run_id IS NOT NULL;
CREATE INDEX idx_workflow_runs_parent ON workflow_runs(parent_run_id);
CREATE INDEX idx_workflow_runs_ref ON workflow_runs(workflow_ref);
CREATE INDEX idx_workflow_runs_scope_ref_status
        ON workflow_runs(scope_key, workflow_ref, status);
CREATE INDEX idx_workflow_runs_status ON workflow_runs(status);
INSERT INTO "asset_outcome" VALUES ('main//knowledge/guide',1769767200000,7,0.1,0,1,0.5,1769767200000,NULL);
INSERT INTO "asset_outcome" VALUES ('team//knowledge/shared',1769767200000,3,0.1,0,1,0.5,1769767200000,NULL);
INSERT INTO "asset_outcome" VALUES ('main//knowledge/reports/quarterly',1769767200000,2,0.1,0,1,0.5,1769767200000,NULL);
INSERT INTO "asset_salience" VALUES ('main//knowledge/guide',0.5,0.25,0.5,0.5,0,1769767200000,NULL,NULL,NULL);
INSERT INTO "asset_salience" VALUES ('team//knowledge/shared',0.5,0.25,0.5,0.5,0,1769767200000,NULL,NULL,NULL);
INSERT INTO "asset_salience" VALUES ('main//knowledge/reports/quarterly',0.5,0.25,0.5,0.5,0,1769767200000,NULL,NULL,NULL);
INSERT INTO "improve_ledger" VALUES ('@FIXTURE@/main','main//knowledge/guide','reflect','2026-01-30T10:00:00.000Z','rejected','2099-01-01T00:00:00.000Z','00000000-0000-4000-8000-000000000001','rejected once','sha256:0000000000000000000000000000000000000000000000000000000000000010');
INSERT INTO "improve_ledger" VALUES ('@FIXTURE@/main','main//knowledge/new-note','reflect','2026-01-30T10:00:00.000Z','pending',NULL,'00000000-0000-4000-8000-000000000002',NULL,NULL);
INSERT INTO "improve_ledger" VALUES ('@FIXTURE@/team','team//knowledge/dup','reflect','2026-01-30T10:00:00.000Z','rejected','2099-01-01T00:00:00.000Z','00000000-0000-4000-8000-000000000006','not an improvement',NULL);
INSERT INTO "improve_runs" VALUES ('run-0001','2026-01-30T10:00:00.000Z','2026-01-30T10:00:00.000Z','@FIXTURE@/main',0,NULL,'all',NULL,NULL,1,'{"ok":true,"proposals":2}',NULL,'{}','default');
INSERT INTO "improve_runs" VALUES ('run-0002','2026-01-30T10:00:00.000Z','2026-01-30T10:00:00.000Z','@FIXTURE@/team',1,NULL,'ref','team//knowledge/shared',NULL,1,'{"ok":true,"proposals":0}',NULL,'{}','default');
INSERT INTO "proposals" VALUES ('00000000-0000-4000-8000-000000000001','@FIXTURE@/main','main//knowledge/guide','accepted','reflect','2026-01-30T10:00:00.000Z','2026-01-30T10:00:00.000Z','# Guide
',NULL,'{}');
INSERT INTO "proposals" VALUES ('00000000-0000-4000-8000-000000000002','@FIXTURE@/main','main//knowledge/new-note','pending','reflect','2026-01-30T10:00:00.000Z','2026-01-30T10:00:00.000Z','---
description: A new note
---

Brand new.
','{"description":"A new note"}','{"changes":[{"path":"knowledge/new-note.md","op":"create"}],"proposedTarget":{"source":"main","root":"@FIXTURE@/main"},"confidence":0.8}');
INSERT INTO "proposals" VALUES ('00000000-0000-4000-8000-000000000003','@FIXTURE@/team','team//knowledge/shared','pending','feedback','2026-01-30T10:00:00.000Z','2026-01-30T10:00:00.000Z','---
description: Notes shared by the team bundle
tags: [shared]
---

# Shared

Updated.
',NULL,'{"changes":[{"path":"knowledge/shared.md","op":"update"}],"proposedTarget":{"source":"team","root":"@FIXTURE@/team"},"beforeHash":"sha256:0000000000000000000000000000000000000000000000000000000000000001"}');
INSERT INTO "proposals" VALUES ('00000000-0000-4000-8000-000000000004','@FIXTURE@/main','main//knowledge/old-guide','accepted','reflect','2026-01-30T10:00:00.000Z','2026-01-30T10:00:00.000Z','---
description: The previous guide, superseded
tags: [guide]
updated: 2025-06-01
supersededBy: main//knowledge/guide
---

# Old guide

Replaced by main//knowledge/guide.
',NULL,'{"changes":[{"path":"knowledge/old-guide.md","op":"update"}],"proposedTarget":{"source":"main","root":"@FIXTURE@/main"},"acceptedAt":"2026-01-28T09:00:00.000Z","review":{"outcome":"accepted","decidedAt":"2026-01-28T09:00:00.000Z"},"backupContent":"---\ndescription: The previous guide\ntags: [guide]\n---\n\n# Old guide\n\nBefore the rewrite.\n","acceptedTarget":{"source":"main","root":"@FIXTURE@/main","path":"@FIXTURE@/main/knowledge/old-guide.md","contentHash":"2404a73cb2e05c60cd25e3b74b451e03a4c1cba06d974cdde0e56edf437516a5"}}');
INSERT INTO "proposals" VALUES ('00000000-0000-4000-8000-000000000005','@FIXTURE@/main','main//memories/pruned-note','accepted','consolidate','2026-01-30T10:00:00.000Z','2026-01-30T10:00:00.000Z','',NULL,'{"changes":[{"path":"memories/pruned-note.md","op":"delete"}],"proposedTarget":{"source":"main","root":"@FIXTURE@/main"},"retirement":{"retiredRef":"main//memories/pruned-note","successorRef":"main//memories/successor","cosine":0.97,"judgeLabel":"duplicate","judgeReason":"Same content.","retiredContentHash":"sha256:0000000000000000000000000000000000000000000000000000000000000004","successorContentHash":"sha256:0000000000000000000000000000000000000000000000000000000000000005","reason":"duplicate"},"acceptedAt":"2026-01-29T09:00:00.000Z","review":{"outcome":"accepted","decidedAt":"2026-01-29T09:00:00.000Z"},"backupContent":"---\ndescription: A memory that was pruned\n---\n\nOld content.\n","acceptedTarget":{"source":"main","root":"@FIXTURE@/main","path":"@FIXTURE@/main/memories/pruned-note.md","contentHash":"sha256:0000000000000000000000000000000000000000000000000000000000000003"},"retiredArchive":{"dirs":[".akm/memory-cleanup/archive/2026-01-05T00-00-00-000Z-main-memories-pruned-note"]}}');
INSERT INTO "proposals" VALUES ('00000000-0000-4000-8000-000000000006','@FIXTURE@/team','team//knowledge/dup','rejected','reflect','2026-01-30T10:00:00.000Z','2026-01-30T10:00:00.000Z','# Dup
',NULL,'{"changes":[{"path":"knowledge/dup.md","op":"update"}],"proposedTarget":{"source":"team","root":"@FIXTURE@/team"},"review":{"outcome":"rejected","reason":"Not an improvement.","decidedAt":"2026-01-27T09:00:00.000Z"}}');
INSERT INTO "proposals" VALUES ('00000000-0000-4000-8000-000000000007','@FIXTURE@/main','main//knowledge:legacy-note','rejected','reflect','2026-01-30T10:00:00.000Z','2026-01-30T10:00:00.000Z','# Legacy
',NULL,'{"review":{"outcome":"rejected","decidedAt":"2026-01-26T09:00:00.000Z"}}');
INSERT INTO "schema_migrations" VALUES ('001-initial-schema','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('002-task-history-per-run','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('003-improve-runs','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('004-extract-sessions-seen','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('005-proposal-fs-imports','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('006-proposals-pending-ref-source','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('007-consolidation-judged','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('008-body-embeddings','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('009-asset-salience','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('010-asset-outcome','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('011-asset-salience-homeostatic-demoted-at','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('012-improve-gate-thresholds','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('013-extract-sessions-content-hash','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('014-recombine-hypotheses','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('015-asset-salience-encoding-source','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('016-collapse-churn-detector','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('017-improve-run-strategy','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('018-drop-dead-lane-schema','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('019-proposal-fingerprints','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('020-three-db-cutover','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('021-asset-state-missing-since','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('022-workflow-unit-attempts','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('023-child-workflow-runs','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('024-workflow-run-outputs','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('025-task-history-vocabulary-backfill','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('026-proposals-strip-legacy-fragment-refs','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('027-extract-sessions-seen-harness-rename','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('028-improve-ledger','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('029-improve-ledger-content-hash','2026-01-01 00:00:00');
INSERT INTO "schema_migrations" VALUES ('030-usage-events-created-at-index','2026-01-01 00:00:00');
INSERT INTO "task_history" VALUES (1,'nightly','completed','2026-01-30T10:00:00.000Z','2026-01-30T10:00:00.000Z',NULL,NULL,'workflow','main//workflows/ship','{"durationMs":1200}');
INSERT INTO "usage_events" VALUES (1,'show',NULL,NULL,'main//knowledge/guide',NULL,NULL,'user','2026-01-29 10:00:00');
INSERT INTO "usage_events" VALUES (2,'feedback',NULL,NULL,'main//knowledge/reports/quarterly','negative',NULL,'user','2026-01-29 10:01:00');
INSERT INTO "usage_events" VALUES (3,'show',NULL,NULL,'team//knowledge/shared',NULL,NULL,'user','2026-01-29 10:02:00');
