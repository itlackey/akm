// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The state.db schema migration registry. The MIGRATIONS array is the single
// append-only ordered source of truth: new migrations are APPENDED here and an
// existing fragment is NEVER renumbered or reordered (that would corrupt the
// schema_migrations ledger on already-deployed databases). The shared runner
// at src/storage/engines/sqlite-migrations.ts applies them in array order.

import type { Database } from "../../storage/database";
import { type Migration, runMigrations as runSqliteMigrations } from "../../storage/engines/sqlite-migrations";
import { ensureMigrationBackup } from "../migration-backup";

const MIGRATIONS: Migration[] = [
  // ── Migration 001 — initial schema ──────────────────────────────────────────
  {
    id: "001-initial-schema",
    up: `
      -- ── events ──────────────────────────────────────────────────────────────
      --
      -- Replaces events.jsonl. Indexed (query) columns:
      --   id          INTEGER PK — monotonic rowid; replaces byte-offset cursor.
      --                            Callers store this as "sinceId" for resume.
      --   event_type  TEXT        — indexed; replaces the type filter in readEvents().
      --   ts          TEXT        — ISO-8601 UTC ms; indexed for range queries.
      --   ref         TEXT        — nullable asset ref; indexed for ref-scoped queries.
      --
      -- Extensible (metadata_json) columns:
      --   metadata_json TEXT      — JSON object storing all non-indexed payload
      --                             fields (tags, any future structured fields).
      --                             Maps directly to EventEnvelope.metadata.
      --
      -- schema_version mirrors EventEnvelope.schemaVersion — always 1 for v1
      -- rows. Stored as a column (not in the JSON blob) so future schema
      -- changes can be detected and migrated row-by-row if ever needed.
      --
      -- TTL: rows where ts < NOW() - 90 days can be deleted by a maintenance job.
      -- No automatic deletion occurs here — callers call purgeOldEvents().
      --
      -- ADD COLUMN extension points (future migrations):
      --   ALTER TABLE events ADD COLUMN stash_dir TEXT DEFAULT NULL;
      --   ALTER TABLE events ADD COLUMN correlation_id TEXT DEFAULT NULL;
      --   ALTER TABLE events ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
      --
      CREATE TABLE IF NOT EXISTS events (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type     TEXT    NOT NULL,
        ts             TEXT    NOT NULL,
        ref            TEXT,
        metadata_json  TEXT    NOT NULL DEFAULT '{}'
      );

      -- Query patterns supported by these indexes:
      --   SELECT … WHERE event_type = ?                 → idx_events_type
      --   SELECT … WHERE ref = ?                        → idx_events_ref
      --   SELECT … WHERE ts >= ? AND ts <= ?            → idx_events_ts
      --   SELECT … WHERE event_type = ? AND ref = ?     → idx_events_type (prefix scan) + filter
      --   SELECT … WHERE id > ?                         → PK (rowid) — no extra index needed
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
      CREATE INDEX IF NOT EXISTS idx_events_ref  ON events(ref);
      CREATE INDEX IF NOT EXISTS idx_events_ts   ON events(ts);

      -- ── proposals ────────────────────────────────────────────────────────────
      --
      -- Replaces per-uuid JSON directories under <stashDir>/.akm/proposals/.
      --
      -- Indexed (query) columns:
      --   id          TEXT PK     — UUID (crypto.randomUUID()); stable directory name.
      --   stash_dir   TEXT        — absolute stash root; multi-stash installs need
      --                             this to partition proposal lists per stash.
      --   ref         TEXT        — target asset ref (e.g. "lesson:alpha");
      --                             indexed for ref-scoped queue views.
      --   status      TEXT        — "pending" | "accepted" | "rejected"; indexed
      --                             so pending-queue queries are fast.
      --   source      TEXT        — human-readable origin tag (e.g. "reflect").
      --   created_at  TEXT        — ISO-8601; used for ORDER BY created_at ASC.
      --   updated_at  TEXT        — ISO-8601; updated on accept/reject.
      --
      -- Large payload columns (NOT indexed):
      --   content     TEXT        — full markdown text; the proposal payload body.
      --   frontmatter_json TEXT   — JSON of parsed frontmatter (may be NULL when
      --                             the content has no frontmatter block).
      --
      -- Extensible (metadata_json) columns:
      --   metadata_json TEXT      — JSON object for future proposal fields.
      --                             Current fields stored here: sourceRun,
      --                             review, confidence, gateDecision (#577),
      --                             backupContent, eligibilitySource.
      --
      -- ADD COLUMN extension points (future migrations):
      --   ALTER TABLE proposals ADD COLUMN source_run TEXT DEFAULT NULL;
      --   ALTER TABLE proposals ADD COLUMN review_outcome TEXT DEFAULT NULL;
      --   ALTER TABLE proposals ADD COLUMN review_reason TEXT DEFAULT NULL;
      --   ALTER TABLE proposals ADD COLUMN review_decided_at TEXT DEFAULT NULL;
      --   ALTER TABLE proposals ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
      --
      CREATE TABLE IF NOT EXISTS proposals (
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

      -- Query patterns:
      --   SELECT … WHERE stash_dir = ? AND status = ?   → idx_proposals_stash_status
      --   SELECT … WHERE ref = ? AND status = ?         → idx_proposals_ref_status
      --   SELECT … WHERE id = ?                         → PK
      CREATE INDEX IF NOT EXISTS idx_proposals_stash_status
        ON proposals(stash_dir, status);
      CREATE INDEX IF NOT EXISTS idx_proposals_ref_status
        ON proposals(ref, status);

      -- ── task_history ─────────────────────────────────────────────────────────
      --
      -- Replaces per-task JSONL files under <cacheDir>/tasks/history/.
      --
      -- Indexed (query) columns:
      --   task_id     TEXT PK     — stable task identifier string.
      --   status      TEXT        — terminal status (e.g. "completed", "failed",
      --                             "cancelled"); indexed for status-scoped queries.
      --   started_at  TEXT        — ISO-8601; indexed for time-range queries.
      --   target_kind TEXT        — kind of the target entity (e.g. "issue",
      --                             "workflow", "agent"); indexed for kind-scoped queries.
      --   target_ref  TEXT        — stable ref of the target entity; indexed for
      --                             per-target history lookups.
      --
      -- Non-indexed time columns:
      --   completed_at TEXT       — ISO-8601 or NULL if still running.
      --   failed_at    TEXT       — ISO-8601 or NULL.
      --
      -- Non-indexed diagnostic columns:
      --   log_path     TEXT       — absolute path to the task log file, if any.
      --
      -- Extensible (metadata_json) columns:
      --   metadata_json TEXT      — JSON object for future task fields (exit_code,
      --                             runner, priority, parent_task_id, …).
      --
      -- ADD COLUMN extension points (future migrations):
      --   ALTER TABLE task_history ADD COLUMN exit_code INTEGER DEFAULT NULL;
      --   ALTER TABLE task_history ADD COLUMN runner TEXT DEFAULT NULL;
      --   ALTER TABLE task_history ADD COLUMN parent_task_id TEXT DEFAULT NULL;
      --   ALTER TABLE task_history ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
      --
      CREATE TABLE IF NOT EXISTS task_history (
        task_id       TEXT    PRIMARY KEY,
        status        TEXT    NOT NULL,
        started_at    TEXT    NOT NULL,
        completed_at  TEXT,
        failed_at     TEXT,
        log_path      TEXT,
        target_kind   TEXT,
        target_ref    TEXT,
        metadata_json TEXT    NOT NULL DEFAULT '{}'
      );

      -- Query patterns:
      --   SELECT … WHERE task_id = ?                    → PK
      --   SELECT … WHERE started_at >= ? AND started_at <= ? → idx_task_history_started
      --   SELECT … WHERE target_kind = ? AND target_ref = ?  → idx_task_history_target
      --   SELECT … WHERE status = ?                     → idx_task_history_status
      CREATE INDEX IF NOT EXISTS idx_task_history_started
        ON task_history(started_at);
      CREATE INDEX IF NOT EXISTS idx_task_history_target
        ON task_history(target_kind, target_ref);
      CREATE INDEX IF NOT EXISTS idx_task_history_status
        ON task_history(status);
    `,
  },

  // Migration 002 — fix task_history to be a true per-run log.
  //
  // Migration 001 used task_id as PRIMARY KEY, meaning each task had exactly
  // one row and every new run overwrote the previous one. This silently
  // discarded all historical runs — the opposite of a history table.
  //
  // This migration recreates the table with an AUTOINCREMENT id so each run
  // appends a new row. The old single-row table is renamed to _old, the new
  // table is created, data is copied, and the old table is dropped.
  {
    id: "002-task-history-per-run",
    up: `
      ALTER TABLE task_history RENAME TO task_history_v1;

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

      INSERT INTO task_history
        (task_id, status, started_at, completed_at, failed_at,
         log_path, target_kind, target_ref, metadata_json)
      SELECT task_id, status, started_at, completed_at, failed_at,
             log_path, target_kind, target_ref, metadata_json
      FROM task_history_v1;

      DROP TABLE task_history_v1;

      -- Unique constraint: same task cannot have two runs with the same start time.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_history_run
        ON task_history(task_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_task_history_task_id
        ON task_history(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_history_started
        ON task_history(started_at);
      CREATE INDEX IF NOT EXISTS idx_task_history_target
        ON task_history(target_kind, target_ref);
      CREATE INDEX IF NOT EXISTS idx_task_history_status
        ON task_history(status);
    `,
  },

  // ── Migration 003 — improve_runs ────────────────────────────────────────────
  //
  // Records every `akm improve` invocation as a durable row, replacing the
  // legacy `<stash>/.akm/runs/<runId>/improve-result.json` artifact files.
  //
  // The `dry_run` column is FIRST-CLASS and indexed so productivity audits can
  // cleanly filter dry-run probes out of real-run analyses without parsing
  // `result_json`. The dry-run/real-run artifact-trap (recorded in
  // feedback_akm_dryrun_artifact_trap) was the specific motivating bug.
  //
  // Indexed (query) columns:
  //   id            TEXT PK   — runId (`buildImproveRunId()` output).
  //   started_at    TEXT      — ISO-8601; indexed for time-range queries.
  //   stash_dir     TEXT      — absolute stash root; multi-stash scoping.
  //   dry_run       INTEGER   — 0/1; indexed for productivity audits.
  //   scope_mode    TEXT      — "all" | "type" | "ref"; indexed via composite
  //                              with stash_dir for stash-scoped scope queries.
  //
  // Non-indexed payload:
  //   completed_at  TEXT      — ISO-8601 or NULL if interrupted.
  //   profile       TEXT      — improve profile name (nullable).
  //   scope_value   TEXT      — type name or asset ref (nullable).
  //   guidance      TEXT      — user-provided guidance text, if any.
  //   ok            INTEGER   — 0/1; whether the run produced ok=true.
  //   result_json   TEXT      — full AkmImproveResult JSON.
  //   metrics_json  TEXT      — aggregate counts extracted from result, cheap
  //                              to query without parsing result_json.
  //
  // Extensible (metadata_json) columns:
  //   metadata_json TEXT      — JSON object for future improve-run fields.
  //
  // ADD COLUMN extension points (future migrations):
  //   ALTER TABLE improve_runs ADD COLUMN duration_ms INTEGER DEFAULT NULL;
  //   ALTER TABLE improve_runs ADD COLUMN host TEXT DEFAULT NULL;
  //
  // TTL: rows where started_at < NOW() - 90 days can be deleted by
  // `purgeOldImproveRuns()`. No automatic deletion occurs here.
  {
    id: "003-improve-runs",
    up: `
      CREATE TABLE IF NOT EXISTS improve_runs (
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
      );

      -- Query patterns supported:
      --   SELECT … WHERE started_at >= ? AND started_at <= ?
      --     → idx_improve_runs_started
      --   SELECT … WHERE dry_run = 0
      --     → idx_improve_runs_dry_run (productivity audits filter trap)
      --   SELECT … WHERE stash_dir = ? AND scope_mode = ?
      --     → idx_improve_runs_stash_scope
      CREATE INDEX IF NOT EXISTS idx_improve_runs_started
        ON improve_runs(started_at);
      CREATE INDEX IF NOT EXISTS idx_improve_runs_dry_run
        ON improve_runs(dry_run);
      CREATE INDEX IF NOT EXISTS idx_improve_runs_stash_scope
        ON improve_runs(stash_dir, scope_mode);
    `,
  },

  // ── Migration 004 — extract_sessions_seen ───────────────────────────────────
  //
  // Tracks which platform sessions the extractor has processed, so the discovery
  // pass in `akm extract --since <window>` skips sessions whose content hasn't
  // changed since the last successful run. Replaces the akm-plugin
  // session-checkpoint hook's implicit "write-once" memory of what's been
  // captured — but persistent and queryable.
  //
  // Indexed (query) columns:
  //   harness          TEXT     — harness name (claude-code, opencode, ...).
  //   session_id       TEXT     — platform-native session identifier.
  //   processed_at     TEXT     — ISO-8601 UTC; when extract last ran on this session.
  //   session_ended_at TEXT     — session.endedAt at processing time. When a
  //                                later listSessions reports a *newer* endedAt
  //                                for the same session_id, the extractor
  //                                re-processes the appended events.
  //   outcome          TEXT     — "candidates_queued" | "no_candidates" |
  //                                "skipped" | "failed".
  //
  // Non-indexed columns:
  //   candidate_count  INTEGER  — number of candidates the LLM produced.
  //   proposal_count   INTEGER  — number of proposals actually queued
  //                                (candidates may fail downstream validation).
  //   rationale        TEXT     — for "no_candidates", the LLM's explanation.
  //   source_run       TEXT     — sourceRun id for PROV-DM traceability.
  //   metadata_json    TEXT     — future-proofing (pre-filter stats, LLM
  //                                model+version, prompt token count, etc.).
  //
  // PK: (harness, session_id) — one row per session per harness. A re-extract
  // updates the row in place via INSERT OR REPLACE.
  //
  // TTL: no automatic deletion. Sessions stay tracked as long as the source
  // session files exist on disk. Operator can `DELETE FROM extract_sessions_seen
  // WHERE processed_at < ?` for cleanup if desired.
  {
    id: "004-extract-sessions-seen",
    up: `
      CREATE TABLE IF NOT EXISTS extract_sessions_seen (
        harness          TEXT    NOT NULL,
        session_id       TEXT    NOT NULL,
        processed_at     TEXT    NOT NULL,
        session_ended_at TEXT,
        outcome          TEXT    NOT NULL,
        candidate_count  INTEGER NOT NULL DEFAULT 0,
        proposal_count   INTEGER NOT NULL DEFAULT 0,
        rationale        TEXT,
        source_run       TEXT,
        metadata_json    TEXT    NOT NULL DEFAULT '{}',
        PRIMARY KEY (harness, session_id)
      );

      -- Query patterns:
      --   SELECT … WHERE harness = ?                       → idx_extract_sessions_harness
      --   SELECT … WHERE processed_at >= ?                 → idx_extract_sessions_processed
      --   SELECT … WHERE harness = ? AND session_id = ?    → PK
      CREATE INDEX IF NOT EXISTS idx_extract_sessions_harness
        ON extract_sessions_seen(harness);
      CREATE INDEX IF NOT EXISTS idx_extract_sessions_processed
        ON extract_sessions_seen(processed_at);
    `,
  },

  // ── Migration 005 — proposal_fs_imports ─────────────────────────────────────
  //
  // One-shot ledger for the legacy filesystem→SQLite proposal import (#578).
  //
  // Before 0.9.0 the proposal queue lived as per-uuid JSON directories under
  // `<stashDir>/.akm/proposals/` and the `proposals` table (created in 001) was
  // dead weight. 0.9.0 makes the table canonical; the first proposal operation
  // against a stash imports any legacy `proposal.json` files it finds (INSERT
  // OR IGNORE, so re-runs never duplicate) and records the stash here so later
  // invocations skip the directory walk entirely.
  //
  // Indexed (query) columns:
  //   stash_dir    TEXT PK  — absolute stash root the import ran against.
  //
  // Non-indexed columns:
  //   imported_at    TEXT     — ISO-8601 UTC; when the import completed.
  //   imported_count INTEGER  — rows actually inserted by the import.
  {
    id: "005-proposal-fs-imports",
    up: `
      CREATE TABLE IF NOT EXISTS proposal_fs_imports (
        stash_dir      TEXT    PRIMARY KEY,
        imported_at    TEXT    NOT NULL,
        imported_count INTEGER NOT NULL DEFAULT 0
      );
    `,
  },

  // ── Migration 006 — pending proposal lookup index ──────────────────────────
  //
  // Supports the transaction-scoped dedup / queue-mutation hardening added in
  // 0.9.x. The queue now acquires an IMMEDIATE write transaction before it
  // reads pending proposals, so the hot path is a stash-scoped `status='pending'
  // AND ref=?` probe followed by an update/insert. This composite index keeps
  // that lookup index-covered under contention.
  {
    id: "006-proposals-pending-ref-source",
    up: `
      CREATE INDEX IF NOT EXISTS idx_proposals_stash_status_ref_source
        ON proposals(stash_dir, status, ref, source);
    `,
  },

  // ── Migration 007 — consolidation_judged ────────────────────────────────────
  //
  // Judged-state cache for nightly consolidation (#581). Lets one consolidation
  // run cover the FULL memory corpus cheaply by SKIPPING memories already judged
  // with unchanged content, instead of narrowing to a recent time-window slice
  // (which leaves a near-duplicate backlog the corpus can never clear).
  //
  // The consolidate LLM judging loop UPSERTs a row for every memory it saw in a
  // successfully-judged chunk; the next run hashes each candidate's current
  // content and skips it when the hash equals the cached `content_hash`
  // (judged-unchanged → no re-judge). A memory whose content changed produces a
  // new hash and is re-judged. This converts coverage from O(window) to
  // O(changed/new). DEFAULT OFF — gated behind
  // `processes.consolidate.judgedCache.enabled`; when the feature is off this
  // table is never read or written and behaviour is byte-identical to today.
  //
  // Indexed (query) columns:
  //   entry_key    TEXT PK   — `memory:<name>` ref; one row per judged memory.
  //
  // Non-indexed columns:
  //   content_hash TEXT      — sha256 of the frontmatter-stripped, trimmed body.
  //   judged_at    TEXT      — ISO-8601 UTC; when the memory was last judged.
  //   outcome      TEXT      — coarse outcome of the last judge ("actioned" |
  //                            "no_action"); observability only, never gates.
  //
  // TTL: no automatic deletion. Rows for memories deleted on disk become
  // harmless dead entries (their entry_key never recurs); operators can prune
  // with `DELETE FROM consolidation_judged WHERE judged_at < ?` if desired.
  {
    id: "007-consolidation-judged",
    up: `
      CREATE TABLE IF NOT EXISTS consolidation_judged (
        entry_key    TEXT    PRIMARY KEY,
        content_hash TEXT    NOT NULL,
        judged_at    TEXT    NOT NULL,
        outcome      TEXT    NOT NULL
      );
    `,
  },

  // ── Migration 008 — body_embeddings ─────────────────────────────────────────
  //
  // cacheHash-keyed body-embedding cache (WS-3a). Stores the embedding of the
  // case-preserving stripped body so the dedup pre-pass and the consolidation
  // clustering step share one computed vector per unique body, eliminating
  // redundant embedding calls across runs.
  //
  // Design:
  //   - PK is the `cacheHash` (sha256 of the stripped, case-preserving body).
  //   - `embedding` is a raw BLOB storing a Float32 array (384 floats × 4 B =
  //     1 536 B per entry for the default bge-small-en-v1.5 model; ~20 MB at
  //     13 k memories). This matches the native wire format and avoids JSON
  //     round-trip overhead.
  //   - `model_id` is MANDATORY. On mismatch (model changed) the entire table
  //     is dropped and rebuilt — stale vectors from the wrong metric space would
  //     produce silent cosine errors.
  //   - `created_at` is an INTEGER Unix ms timestamp for lazy orphan purges.
  //
  // Writes: one bulk `WHERE content_hash IN (…)` lookup → embed only misses →
  // upsert all results in one transaction per run.
  //
  // TTL: no automatic row deletion. Orphaned rows for bodies no longer in the
  // stash stay until an operator prunes them. The table is ~1.5 KB per row
  // (~20 MB at 13 k memories — acceptable).
  {
    id: "008-body-embeddings",
    up: `
      CREATE TABLE IF NOT EXISTS body_embeddings (
        content_hash TEXT    PRIMARY KEY,
        embedding    BLOB    NOT NULL,
        model_id     TEXT    NOT NULL,
        created_at   INTEGER NOT NULL
      );
    `,
  },

  // ── Migration 009 — asset_salience (WS-1 salience vector) ───────────────────
  //
  // Per-asset salience vector persisted in state.db (canonical store).
  //
  // Three independently-stored, independently-decayable sub-scores:
  //   encoding_salience  — intrinsic importance (Gap 1; v1 = type-weight stub).
  //   outcome_salience   — differential usefulness (WS-2; 0 until that lands).
  //   retrieval_salience — frequency × recency (the decayable term).
  //
  // Plus the scalar projection for ranking:
  //   rank_score = (w_e·encoding + w_o·outcome + w_r·retrieval) × sizePenalty,
  //   normalized [0,1]. Every selector reads rank_score; individual sub-scores
  //   are available for telemetry and per-dimension thresholding.
  //
  // Plasticity column:
  //   consecutive_no_ops INTEGER — number of consecutive improve cycles where
  //     this asset produced a no-op (reflect/distill produced no change).
  //     Dampens CONSOLIDATION-SELECTION only — intentionally NOT applied to
  //     rank_score (stable assets stay retrievable but skip LLM merge passes).
  //
  // updated_at is an INTEGER Unix-ms timestamp for recency queries.
  //
  // The canonical store is state.db, not frontmatter.  An optional frontmatter
  // mirror of the stable encodingSalience is allowed for portability (#608).
  //
  // TTL: rows are overwritten on every run; orphaned rows for deleted assets
  // accumulate harmlessly until an operator prunes them.
  {
    id: "009-asset-salience",
    up: `
      CREATE TABLE IF NOT EXISTS asset_salience (
        asset_ref          TEXT    PRIMARY KEY,
        encoding_salience  REAL    NOT NULL DEFAULT 0.5,
        outcome_salience   REAL    NOT NULL DEFAULT 0.0,
        retrieval_salience REAL    NOT NULL DEFAULT 0.0,
        rank_score         REAL    NOT NULL DEFAULT 0.0,
        consecutive_no_ops INTEGER NOT NULL DEFAULT 0,
        updated_at         INTEGER NOT NULL DEFAULT 0
      );

      -- Hot path: sort / filter by rank_score for selector queries.
      CREATE INDEX IF NOT EXISTS idx_asset_salience_rank
        ON asset_salience(rank_score DESC);
    `,
  },

  // ── Migration 010 — asset_outcome (WS-2 outcome loop) ───────────────────────
  //
  // Per-asset outcome loop persisted in state.db (S2 seam, WS-2).
  //
  // Stores the differential "was this retrieval useful" signal so the salience
  // vector's `outcomeSalience` sub-score (WS-1 `W_OUTCOME` term) is non-zero.
  //
  // Columns:
  //   asset_ref TEXT PK             — `type:name` asset ref (FK to asset_salience).
  //   last_retrieved_at INTEGER     — Unix-ms of the most recent retrieval.
  //   retrieval_count INTEGER       — total retrieval count from the index DB.
  //   expected_retrieval_rate REAL  — EMA-smoothed expected count per cycle.
  //   negative_feedback_count INTEGER — cumulative negative-feedback events.
  //   accepted_change_count INTEGER — cumulative accepted proposals.
  //   review_pressure INTEGER       — #613 pressure counter: repeated low-satisfaction
  //                                   retrievals increment it; feeds outcomeSalience.
  //   outcome_score REAL            — differential outcome signal (can be negative).
  //   updated_at INTEGER            — Unix-ms timestamp of last update.
  //
  // Design:
  //   - outcome_score is differential (prediction-error shaped), NOT a raw count,
  //     so it rewards assets that are retrieved MORE than their rolling mean AND
  //     accepted for change when retrieved. See outcome-loop.ts for the formula.
  //   - review_pressure (#613): repeated negative-feedback retrievals raise it,
  //     non-negative cycles decay it. Never mutates asset content directly.
  //   - warm_start: seeded from utility EMA at row creation, clipped to [0, 0.3]
  //     so the first negative delta does not cause a spurious rank inversion.
  //   - Orphaned rows (deleted assets) accumulate harmlessly; operators can prune
  //     with `DELETE FROM asset_outcome WHERE updated_at < ?` if desired.
  {
    id: "010-asset-outcome",
    up: `
      CREATE TABLE IF NOT EXISTS asset_outcome (
        asset_ref                TEXT    PRIMARY KEY,
        last_retrieved_at        INTEGER NOT NULL DEFAULT 0,
        retrieval_count          INTEGER NOT NULL DEFAULT 0,
        expected_retrieval_rate  REAL    NOT NULL DEFAULT 0.0,
        negative_feedback_count  INTEGER NOT NULL DEFAULT 0,
        accepted_change_count    INTEGER NOT NULL DEFAULT 0,
        review_pressure          INTEGER NOT NULL DEFAULT 0,
        outcome_score            REAL    NOT NULL DEFAULT 0.0,
        updated_at               INTEGER NOT NULL DEFAULT 0
      );

      -- Hot path: sort assets by review_pressure DESC for #613 admission.
      CREATE INDEX IF NOT EXISTS idx_asset_outcome_review_pressure
        ON asset_outcome(review_pressure DESC);

      -- Secondary: sort by outcome_score DESC for outcomeSalience reads.
      CREATE INDEX IF NOT EXISTS idx_asset_outcome_score
        ON asset_outcome(outcome_score DESC);
    `,
  },
  // ── Migration 011 — asset_salience: homeostatic_demoted_at column ─────────────
  //
  // WS-3b step 0a (homeostatic demotion). Records the last time `retrievalSalience`
  // was demoted for this asset so:
  //   (a) Each run can identify assets that have been demoted but not yet
  //       re-retrieved (they stay in the demoted state until a retrieval
  //       re-promotes them via `upsertAssetSalience`).
  //   (b) The homeostatic pass can log "N assets demoted this run".
  //
  // NULL = never demoted (or was re-promoted after last demotion, since a fresh
  // `upsertAssetSalience` call clears the flag by updating retrieval_salience
  // from live data rather than the demoted value — the column is informational,
  // not the canonical source of the salience value).
  {
    id: "011-asset-salience-homeostatic-demoted-at",
    up: `
      ALTER TABLE asset_salience ADD COLUMN homeostatic_demoted_at INTEGER DEFAULT NULL;
    `,
  },
  // ── Migration 012 — improve_gate_thresholds (WS-4 per-phase threshold store) ─
  //
  // Persists the auto-tuned accept-gate threshold PER PHASE so that each phase
  // (reflect, distill, extract, consolidate) maintains its own calibrated
  // threshold rather than sharing a single global `options.autoAccept`.
  //
  // Schema:
  //   phase TEXT PK        — phase label, e.g. "reflect", "distill", "extract",
  //                          "consolidate".
  //   threshold INTEGER    — tuned threshold (0-100), matches the integer
  //                          scale used everywhere else in the gate pipeline.
  //   updated_at INTEGER   — Unix milliseconds of the last update.
  //
  // `makeGateConfig` reads the stored threshold for its phase (falling back to
  // the caller-supplied `globalThreshold` when no row exists yet). WS-4's
  // `persistPhaseThreshold` writes it after each auto-tune step.
  {
    id: "012-improve-gate-thresholds",
    up: `
      CREATE TABLE IF NOT EXISTS improve_gate_thresholds (
        phase       TEXT    NOT NULL PRIMARY KEY,
        threshold   INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
    `,
  },
  // ── Migration 013 — extract_sessions_seen: content_hash column (#602) ────────
  //
  // Replaces the brittle timestamp-based incrementality (`session_ended_at`,
  // compared against the live session metadata) with a content hash. The old
  // clock/timestamp logic caused the Jun 11-12 double-extract + over-throttle
  // incident (clock skew / out-of-order endedAt both double-processed AND
  // over-suppressed sessions). The hash makes the skip decision byte-exact and
  // clock-independent.
  //
  // Additive ADD COLUMN (migration-safe; mirrors migration 011's style). All
  // pre-existing rows read back `content_hash = NULL`, which the skip logic
  // treats as "seen before content-hash tracking existed → process once to
  // backfill", after which the row gets a real hash and becomes hash-stable.
  // Never mutate migration 004 (the original table) — this column is appended.
  {
    id: "013-extract-sessions-content-hash",
    up: `
      ALTER TABLE extract_sessions_seen ADD COLUMN content_hash TEXT DEFAULT NULL;
    `,
  },
  // ── Migration 014 — recombine_hypotheses (#625 confirmation count) ───────────
  //
  // Second-pass promotion ledger for the recombine pass. The first pass (#609)
  // only ever emits `type: hypothesis` proposals; this table tracks how many
  // CONSECUTIVE runs re-induced the SAME generalization (keyed by the
  // deterministic `deriveRecombineLessonRef` value — a hash of the sorted
  // member entryKeys). Once `consecutive_count >= confirmThreshold`, the run
  // promotes the generalization to a `type: lesson` proposal (through the same
  // proposal queue + quality gate). A hypothesis NOT re-induced in a run has its
  // consecutive streak reset (decay-to-zero), so confirmation is per exact
  // member-set and conservative.
  //
  // Indexed columns:
  //   hypothesis_ref TEXT PK — the `lesson:recombined/<slug>-<hash>` ref; one
  //                            row per re-inducible generalization. The ref is
  //                            the promotion TARGET (a lesson in both the
  //                            hypothesis and promoted states), so the ref never
  //                            encodes the proposal type.
  //   last_seen_at   TEXT (idx) — for forensic / pruning queries.
  //
  // Non-indexed columns:
  //   signature          TEXT — the cluster's shared relatedness signal (tag /
  //                             entity) at induction time; forensics only.
  //   member_key         TEXT — sorted member entryKeys joined; the membership
  //                             fingerprint behind the ref hash. Stored so a
  //                             membership change (which yields a DIFFERENT ref)
  //                             is auditable.
  //   consecutive_count  INTEGER — current confirmation streak (reset on decay
  //                                and on promotion).
  //   first_seen_at      TEXT — ISO-8601 UTC of the first induction.
  //   last_run           TEXT — sourceRun token of the last induction; the
  //                             same-run idempotency guard.
  //   promoted_at        TEXT — non-null once promoted; guards against
  //                             double-promoting on every subsequent run.
  //   metadata_json      TEXT — reserved for future forensics; defaults to '{}'.
  {
    id: "014-recombine-hypotheses",
    up: `
      CREATE TABLE IF NOT EXISTS recombine_hypotheses (
        hypothesis_ref    TEXT PRIMARY KEY,
        signature         TEXT NOT NULL,
        member_key        TEXT NOT NULL,
        consecutive_count INTEGER NOT NULL DEFAULT 0,
        first_seen_at     TEXT NOT NULL,
        last_seen_at      TEXT NOT NULL,
        last_run          TEXT,
        promoted_at       TEXT,
        metadata_json     TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_recombine_hypotheses_last_seen
        ON recombine_hypotheses(last_seen_at);
    `,
  },
  // ── Migration 015 — asset_salience: encoding_source provenance column (#644) ──
  //
  // Records HOW the stored `encoding_salience` was derived so an improve run's
  // type-weight fallback can no longer clobber a real content-derived score:
  //
  //   "content"   — written by the distill path from `scoreEncodingSalience`
  //                 (novelty·0.40 + magnitude·0.35 + predictionError·0.25).
  //   "type-stub" — written by `computeSalience`'s `DEFAULT_TYPE_ENCODING_WEIGHTS`
  //                 fallback (no content-based score available for this ref yet).
  //   NULL        — legacy row written before this migration; provenance unknown.
  //                 Treated as a stub by readers UNLESS its stored value differs
  //                 from the pure type-weight (best-effort heuristic for old data).
  //
  // Why a column rather than inference: before #644, every improve run overwrote
  // the distill-written content score with the type-weight stub, so the stored
  // value alone cannot distinguish a real score from a stub. The provenance flag
  // is the single source of truth going forward; `upsertAssetSalience` refuses to
  // lower a "content" row to a "type-stub" so the high-salience gate (#608) keys
  // on genuine novelty/magnitude/prediction-error, not the asset type.
  {
    id: "015-asset-salience-encoding-source",
    up: `
      ALTER TABLE asset_salience ADD COLUMN encoding_source TEXT DEFAULT NULL;
    `,
  },
  // ── Migration 016 — collapse/churn detector (R5) ─────────────────────────────
  //
  // Longitudinal store-health history for the improve pipeline
  // (docs/design/improve-collapse-churn-detector-design.md).
  //
  //   canary_queries — the fixed canary set, minted deterministically from the
  //     live stash on first detector run and NEVER auto-refreshed (silent
  //     re-baselining is how a slow collapse hides). `canary_set_id` groups one
  //     mint; deactivated sets keep their rows (active = 0) so historical cycle
  //     rows stay interpretable. Tens of rows; never purged.
  //
  //   improve_cycle_metrics — one row per qualifying improve cycle (a run where
  //     consolidate processed ≥1 op or recombine evaluated ≥1 cluster). Every
  //     column is a scalar or a size-capped JSON blob (< 2 KB/row by
  //     construction — the result_json lesson applied). Retention: 365 days via
  //     purgeOldCycleMetrics. Trend queries drive the collapse/churn alert
  //     evaluation and the health advisory; `canary_set_id` scoping prevents
  //     comparing across canary re-mints.
  {
    id: "016-collapse-churn-detector",
    up: `
      CREATE TABLE IF NOT EXISTS canary_queries (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        canary_set_id TEXT    NOT NULL,
        anchor_ref    TEXT    NOT NULL,
        query         TEXT    NOT NULL,
        source        TEXT    NOT NULL DEFAULT 'auto',
        active        INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_canary_queries_active
        ON canary_queries(active, canary_set_id);

      CREATE TABLE IF NOT EXISTS improve_cycle_metrics (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id                  TEXT    NOT NULL,
        ts                      TEXT    NOT NULL,
        pass                    TEXT    NOT NULL,
        canary_set_id           TEXT    NOT NULL,
        mean_recall             REAL    NOT NULL,
        mean_ndcg               REAL    NOT NULL,
        mean_mrr                REAL    NOT NULL,
        canary_ranks_json       TEXT    NOT NULL,
        store_total             INTEGER NOT NULL,
        store_by_type_json      TEXT    NOT NULL,
        distinct_content_ratio  REAL    NOT NULL,
        mean_bigram_diversity   REAL    NOT NULL,
        over_generation_count   INTEGER NOT NULL,
        accepted_actions        INTEGER NOT NULL,
        merge_floor_violations  INTEGER NOT NULL DEFAULT 0,
        alerts_json             TEXT    NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_improve_cycle_metrics_ts
        ON improve_cycle_metrics(ts);
    `,
  },
  // Keep the historical profile column untouched. New 0.9 runs identify the
  // selected improve strategy in this additive column.
  {
    id: "017-improve-run-strategy",
    up: `
      ALTER TABLE improve_runs ADD COLUMN strategy TEXT;
      CREATE INDEX IF NOT EXISTS idx_improve_runs_strategy_started ON improve_runs(strategy, started_at);
    `,
  },
];

/**
 * Apply every pending migration in a single transaction per migration.
 *
 * Delegates to the shared SQLite migration engine; state.db has no
 * pre-versioning bootstrap step, so no `bootstrap` hook is passed.
 *
 * Called automatically by `openStateDatabase()`.
 */
export function runMigrations(db: Database, options?: { ensureCutoverBackup?: boolean }): void {
  runSqliteMigrations(db, MIGRATIONS, {
    beforeMigration(migration) {
      if (options?.ensureCutoverBackup && migration.id === "017-improve-run-strategy") ensureMigrationBackup();
    },
  });
}
