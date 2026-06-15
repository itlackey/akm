// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * state.db — Durable SQLite database for non-regenerable akm state.
 *
 * This module owns THREE tables that replace flat-file storage:
 *
 *   events      — replaces events.jsonl (append-only event bus)
 *   proposals   — replaces per-uuid JSON directories under .akm/proposals/
 *   task_history — replaces per-task JSONL files under <cacheDir>/tasks/history/
 *
 * ## Why a separate database from index.db
 *
 * index.db uses a single DB_VERSION integer: when the version changes it drops
 * ALL tables and recreates them. That is acceptable for the search index because
 * every entry is fully regenerable from the stash on disk. Events, proposals, and
 * task history are NON-REGENERABLE — losing them is data loss. They must live in
 * a database whose schema evolves via incremental, additive migrations that never
 * drop rows.
 *
 * ## Migration-safety contract
 *
 * The `schema_migrations` table records every applied migration by a stable string
 * ID. `runMigrations(db)` is idempotent: new installs run all migrations in order;
 * upgrades run only the ones not yet applied. No migration may DROP a table that
 * holds durable data, RENAME a column, or change a column's type.
 *
 * Permitted schema evolution operations (always migration-safe in SQLite):
 *   - ALTER TABLE … ADD COLUMN <name> <type> DEFAULT <value>
 *   - CREATE INDEX IF NOT EXISTS …
 *   - CREATE TABLE IF NOT EXISTS … (additive new tables)
 *
 * ## Schema design: indexed columns vs. metadata_json
 *
 * Each table holds only the columns needed for indexed queries as first-class
 * columns. All other fields live in a `metadata_json TEXT` column (a JSON object).
 * New fields can be appended to the JSON blob at any time without touching the
 * DDL. This is the same pattern used by `usage_events.metadata` in index.db and
 * by the original events.jsonl format (the `metadata` field was always free-form
 * JSON).
 *
 * ## WAL mode
 *
 * SQLite WAL mode allows concurrent readers while a writer is active and makes
 * crashes safe (the WAL is replayed on next open). The O_APPEND multi-writer model
 * of events.jsonl is replaced by WAL-mode serialised writes — acceptable because
 * CLI commands are almost always single-writer.
 *
 * @module state-db
 */

import fs from "node:fs";
import path from "node:path";
import type { Proposal } from "../commands/proposal/validators/proposals";
import { type Database, openDatabase, type SqlValue } from "../storage/database";
import { type Migration, runMigrations as runSqliteMigrations } from "../storage/engines/sqlite-migrations";
import type { EventEnvelope } from "./events";
import type { AkmImproveResult } from "./improve-types";
import { classifyImproveAction } from "./improve-types";
import { getDataDir } from "./paths";
import { error } from "./warn";

// Re-export the boundary Database type so command modules can type their repo
// parameters against the owner module rather than reaching into the runtime
// boundary directly.
export type { Database };

// ── Path helper ──────────────────────────────────────────────────────────────

/**
 * Default path: `<dataDir>/state.db`.
 * Respects the same `AKM_DATA_DIR` / XDG_DATA_HOME env-isolation as `getDbPath()` so
 * cooperating processes sharing a data root automatically share the same
 * state database.
 */
export function getStateDbPath(): string {
  return path.join(getDataDir(), "state.db");
}

// ── Database open ────────────────────────────────────────────────────────────

/**
 * Open (and initialise / migrate) the state database.
 *
 * @param dbPath - Override the database file path. Pass a tmpdir path in tests
 *   to avoid touching the real user cache. Mirrors the `filePath` test seam
 *   on `EventsContext`.
 *
 * PRAGMA rationale:
 *
 *   journal_mode = WAL
 *     Write-Ahead Logging: readers never block writers and vice-versa. Crashes
 *     are safe — the WAL is replayed on next open. Required for concurrent CLI
 *     invocations that may read while another writes.
 *
 *   foreign_keys = ON
 *     Enforces FK constraints at runtime. SQLite disables them by default for
 *     backwards compatibility; enabling them prevents orphaned rows in tables
 *     that reference each other (not used in v1 schema but guards future ones).
 *
 *   busy_timeout = 30000
 *     When another connection holds a write lock, SQLite retries for up to
 *     30 000 ms before returning SQLITE_BUSY. Without this, the default timeout
 *     is 0 ms — any concurrent writer causes an immediate error. 30 s (#589)
 *     matches the value used in openDatabase() for index.db; 5 s proved too
 *     narrow when a post-inference reindex overlapped a parallel event write.
 */
export function openStateDatabase(dbPath?: string): Database {
  const resolvedPath = dbPath ?? getStateDbPath();
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = openDatabase(resolvedPath);

  // PRAGMAs must run before any DDL or DML.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 30000");

  runMigrations(db);

  return db;
}

// ── Migration engine ─────────────────────────────────────────────────────────
//
// The runner itself (ensureMigrationsTable + runMigrations) lives in the shared
// engine at src/storage/engines/sqlite-migrations.ts. This module owns only its
// own MIGRATIONS array and delegates application to that shared runner. The
// {@link Migration} interface is imported from there.

/**
 * All migrations in application order. New migrations are APPENDED to this
 * array — never inserted in the middle or reordered.
 *
 * @see Migration
 */
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
];

/**
 * Apply every pending migration in a single transaction per migration.
 *
 * Delegates to the shared SQLite migration engine; state.db has no
 * pre-versioning bootstrap step, so no `bootstrap` hook is passed.
 *
 * Called automatically by `openStateDatabase()`.
 */
export function runMigrations(db: Database): void {
  runSqliteMigrations(db, MIGRATIONS);
}

// ── TypeScript row types ─────────────────────────────────────────────────────

/**
 * Raw SQLite row shape for the `events` table.
 *
 * Maps to {@link EventEnvelope} as follows:
 *   EventEnvelope.id           ← EventRow.id        (monotonic rowid; replaces byte-offset)
 *   EventEnvelope.schemaVersion ← always 1 for current rows
 *   EventEnvelope.ts           ← EventRow.ts
 *   EventEnvelope.eventType    ← EventRow.event_type
 *   EventEnvelope.ref          ← EventRow.ref         (nullable)
 *   EventEnvelope.metadata     ← JSON.parse(EventRow.metadata_json)
 */
export interface EventRow {
  id: number;
  event_type: string;
  ts: string;
  ref: string | null;
  metadata_json: string;
}

/**
 * Convert a raw `EventRow` from the database to the public `EventEnvelope`
 * interface used throughout the events module.
 */
export function eventRowToEnvelope(row: EventRow): EventEnvelope {
  let metadata: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(row.metadata_json) as Record<string, unknown>;
    // Only attach metadata when the JSON blob is non-empty so downstream
    // consumers that check `envelope.metadata !== undefined` keep working.
    if (Object.keys(parsed).length > 0) {
      metadata = parsed;
    }
  } catch {
    // Corrupt JSON in the DB — treat as no metadata.
  }
  return {
    schemaVersion: 1,
    id: row.id,
    ts: row.ts,
    eventType: row.event_type,
    ...(row.ref !== null ? { ref: row.ref } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

/**
 * Raw SQLite row shape for the `proposals` table.
 *
 * Maps to the public {@link Proposal} interface from src/commands/proposal/validators/proposals.ts.
 * The `sourceRun`, `review`, `confidence`, `gateDecision`, and `backupContent`
 * fields are stored in `metadata_json`; callers that need them should
 * `JSON.parse(row.metadata_json)` (or use {@link proposalRowToProposal}).
 */
export interface ProposalRow {
  id: string;
  stash_dir: string;
  ref: string;
  status: string;
  source: string;
  created_at: string;
  updated_at: string;
  content: string;
  frontmatter_json: string | null;
  metadata_json: string;
}

/**
 * Convert a raw `ProposalRow` to the public `Proposal` shape.
 */
export function proposalRowToProposal(row: ProposalRow): Proposal {
  let frontmatter: Record<string, unknown> | undefined;
  if (row.frontmatter_json) {
    try {
      frontmatter = JSON.parse(row.frontmatter_json) as Record<string, unknown>;
    } catch {
      /* ignore corrupt frontmatter JSON */
    }
  }

  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(row.metadata_json) as Record<string, unknown>;
  } catch {
    /* ignore */
  }

  return {
    id: row.id,
    ref: row.ref,
    status: row.status as Proposal["status"],
    source: row.source,
    ...(typeof meta.sourceRun === "string" ? { sourceRun: meta.sourceRun } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    payload: {
      content: row.content,
      ...(frontmatter !== undefined ? { frontmatter } : {}),
    },
    ...(meta.review !== undefined ? { review: meta.review as Proposal["review"] } : {}),
    ...(typeof meta.confidence === "number" ? { confidence: meta.confidence } : {}),
    ...(meta.gateDecision !== undefined ? { gateDecision: meta.gateDecision as Proposal["gateDecision"] } : {}),
    ...(typeof meta.backupContent === "string" ? { backupContent: meta.backupContent } : {}),
    ...(typeof meta.eligibilitySource === "string"
      ? { eligibilitySource: meta.eligibilitySource as Proposal["eligibilitySource"] }
      : {}),
  };
}

/**
 * Convert a public `Proposal` to column values ready for an INSERT/UPDATE.
 * The `stash_dir` comes from the call site (proposals.ts has it in scope).
 */
export function proposalToRowValues(proposal: Proposal, stashDir: string): Omit<ProposalRow, "id"> & { id: string } {
  // Fields that have no dedicated column live in metadata_json.
  const metaObj: Record<string, unknown> = {};
  if (proposal.sourceRun !== undefined) metaObj.sourceRun = proposal.sourceRun;
  if (proposal.review !== undefined) metaObj.review = proposal.review;
  if (proposal.confidence !== undefined) metaObj.confidence = proposal.confidence;
  if (proposal.gateDecision !== undefined) metaObj.gateDecision = proposal.gateDecision;
  if (proposal.backupContent !== undefined) metaObj.backupContent = proposal.backupContent;
  if (proposal.eligibilitySource !== undefined) metaObj.eligibilitySource = proposal.eligibilitySource;

  return {
    id: proposal.id,
    stash_dir: stashDir,
    ref: proposal.ref,
    status: proposal.status,
    source: proposal.source,
    created_at: proposal.createdAt,
    updated_at: proposal.updatedAt,
    content: proposal.payload.content,
    frontmatter_json: proposal.payload.frontmatter ? JSON.stringify(proposal.payload.frontmatter) : null,
    metadata_json: JSON.stringify(metaObj),
  };
}

/**
 * Raw SQLite row shape for the `task_history` table.
 */
export interface TaskHistoryRow {
  id?: number; // AUTOINCREMENT — absent on insert, present on read
  task_id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  failed_at: string | null;
  log_path: string | null;
  target_kind: string | null;
  target_ref: string | null;
  metadata_json: string;
}

// ── events table helpers ─────────────────────────────────────────────────────

/**
 * Insert a single event. Returns the auto-assigned monotonic rowid, which
 * callers can store as a "sinceId" cursor for future `readEventsSince` calls.
 *
 * Best-effort: mirrors the behaviour of the old `appendEvent` — errors are
 * caught and logged to stderr rather than propagated so observability never
 * breaks mutation.
 */
export function insertEvent(
  db: Database,
  input: {
    eventType: string;
    ts: string;
    ref?: string;
    metadata?: Record<string, unknown>;
  },
): number | undefined {
  try {
    const result = db
      .prepare(
        `INSERT INTO events (event_type, ts, ref, metadata_json)
         VALUES (?, ?, ?, ?)
         RETURNING id`,
      )
      .get(input.eventType, input.ts, input.ref ?? null, JSON.stringify(input.metadata ?? {})) as
      | { id: number }
      | undefined;
    return result?.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    error(`akm: state.db event insert failed (${message})`);
    return undefined;
  }
}

export interface ReadStateEventsOptions {
  /** Monotonic id lower bound: only return rows with id > sinceId. */
  sinceId?: number;
  /** ISO timestamp lower bound: only return rows with ts >= since. */
  since?: string;
  /** Filter to a single event_type. */
  type?: string;
  /** Filter to a single asset ref. */
  ref?: string;
}

/**
 * Read events from the database matching the filter. Returns events in
 * ascending id order so consumers can process them in emission order.
 *
 * The returned `nextId` is the maximum id seen (or `sinceId` when no rows
 * match), suitable as the next `sinceId` cursor value.
 */
export function readStateEvents(
  db: Database,
  options: ReadStateEventsOptions = {},
): { events: EventEnvelope[]; nextId: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.sinceId !== undefined && options.sinceId > 0) {
    conditions.push("id > ?");
    params.push(options.sinceId);
  }
  if (options.since) {
    conditions.push("ts >= ?");
    params.push(options.since);
  }
  if (options.type) {
    conditions.push("event_type = ?");
    params.push(options.type);
  }
  if (options.ref) {
    conditions.push("ref = ?");
    params.push(options.ref);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT id, event_type, ts, ref, metadata_json FROM events ${where} ORDER BY id ASC`)
    .all(...(params as SqlValue[])) as EventRow[];

  const events = rows.map(eventRowToEnvelope);
  const nextId = events.length > 0 ? events[events.length - 1].id : (options.sinceId ?? 0);
  return { events, nextId };
}

/**
 * Delete events older than `retentionDays` (default: 90). Safe to call from
 * a maintenance cron; uses a single DELETE with an index-covered ts predicate.
 *
 * Returns the number of rows actually deleted so callers can emit an
 * `events_purged` observability event. A non-positive or non-finite
 * `retentionDays` is treated as "disabled" and returns 0 without scanning.
 */
export function purgeOldEvents(db: Database, retentionDays = 90): number {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const result = db.prepare("DELETE FROM events WHERE ts < ?").run(cutoff);
  // bun:sqlite's run() returns { changes, lastInsertRowid }. `changes` may be
  // a number or bigint depending on the underlying lib; coerce to number for
  // the metadata payload.
  const changes = (result as { changes?: number | bigint }).changes ?? 0;
  return typeof changes === "bigint" ? Number(changes) : changes;
}

// ── proposals table helpers ──────────────────────────────────────────────────

/**
 * Upsert a proposal row. Called by the proposal write path when state.db is
 * the active backend.
 */
export function upsertProposal(db: Database, proposal: Proposal, stashDir: string): void {
  const v = proposalToRowValues(proposal, stashDir);
  db.prepare(`
    INSERT INTO proposals
      (id, stash_dir, ref, status, source, created_at, updated_at, content, frontmatter_json, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      stash_dir        = excluded.stash_dir,
      ref              = excluded.ref,
      status           = excluded.status,
      source           = excluded.source,
      updated_at       = excluded.updated_at,
      content          = excluded.content,
      frontmatter_json = excluded.frontmatter_json,
      metadata_json    = excluded.metadata_json
  `).run(
    v.id,
    v.stash_dir,
    v.ref,
    v.status,
    v.source,
    v.created_at,
    v.updated_at,
    v.content,
    v.frontmatter_json,
    v.metadata_json,
  );
}

/**
 * List proposals, optionally filtered by stashDir, status, and/or ref.
 *
 * Results are ordered by `created_at ASC` (matching the historical
 * `listProposals()` sort), with `rowid` as a deterministic tiebreak so two
 * proposals created in the same millisecond list in insertion order.
 */
export function listStateProposals(
  db: Database,
  options: { stashDir?: string; status?: string; ref?: string } = {},
): Proposal[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (options.stashDir) {
    conditions.push("stash_dir = ?");
    params.push(options.stashDir);
  }
  if (options.status) {
    conditions.push("status = ?");
    params.push(options.status);
  }
  if (options.ref) {
    conditions.push("ref = ?");
    params.push(options.ref);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT id, stash_dir, ref, status, source, created_at, updated_at,
              content, frontmatter_json, metadata_json
       FROM proposals ${where} ORDER BY created_at ASC, rowid ASC`,
    )
    .all(...(params as SqlValue[])) as ProposalRow[];
  return rows.map(proposalRowToProposal);
}

/**
 * Read every proposal's `gateDecision` record across all stashes (#612).
 *
 * Calibration reads the auto-accept gate's per-proposal decisions regardless of
 * the proposal's current lifecycle status — a proposal that was auto-accepted
 * is now `accepted`, an auto-rejected one stays `pending`, so filtering by
 * status would drop half the join. Rows without a `gateDecision` (created
 * before #577, or never gated) are skipped. The result is ordered by
 * `decidedAt ASC` for deterministic downstream aggregation, falling back to
 * `created_at` ordering from the SQL layer for rows with equal/missing
 * timestamps.
 */
export function listProposalGateDecisions(db: Database): NonNullable<Proposal["gateDecision"]>[] {
  const rows = db.prepare("SELECT metadata_json FROM proposals ORDER BY created_at ASC, rowid ASC").all() as Array<{
    metadata_json: string;
  }>;
  const decisions: NonNullable<Proposal["gateDecision"]>[] = [];
  for (const row of rows) {
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(row.metadata_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    const decision = meta.gateDecision as Proposal["gateDecision"] | undefined;
    if (decision && typeof decision === "object" && typeof decision.outcome === "string") {
      decisions.push(decision);
    }
  }
  decisions.sort((a, b) => new Date(a.decidedAt).getTime() - new Date(b.decidedAt).getTime());
  return decisions;
}

/**
 * Look up a single proposal by id, optionally scoped to one stash root.
 * Returns undefined when not found.
 */
export function getStateProposal(db: Database, id: string, stashDir?: string): Proposal | undefined {
  const sql = `SELECT id, stash_dir, ref, status, source, created_at, updated_at,
              content, frontmatter_json, metadata_json
       FROM proposals WHERE id = ?${stashDir ? " AND stash_dir = ?" : ""}`;
  const row = (stashDir ? db.prepare(sql).get(id, stashDir) : db.prepare(sql).get(id)) as ProposalRow | undefined;
  return row ? proposalRowToProposal(row) : undefined;
}

/**
 * Find PENDING proposal ids in one stash whose id starts with `idPrefix`.
 * Backs the UUID-prefix form of `akm proposal show/accept/... <prefix>` —
 * prefix resolution is deliberately scoped to the live (pending) queue,
 * mirroring the historical behaviour of scanning only the live directory.
 *
 * `%` / `_` / `\` in the prefix are escaped so the LIKE pattern is literal.
 */
export function listStateProposalIdsByPrefix(db: Database, stashDir: string, idPrefix: string): string[] {
  const escaped = idPrefix.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const rows = db
    .prepare(
      `SELECT id FROM proposals
       WHERE stash_dir = ? AND status = 'pending' AND id LIKE ? ESCAPE '\\'
       ORDER BY id ASC`,
    )
    .all(stashDir, `${escaped}%`) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Whether the legacy filesystem proposal import has already run for `stashDir`.
 * See migration 005 (`proposal_fs_imports`).
 */
export function hasImportedFsProposals(db: Database, stashDir: string): boolean {
  // Drivers disagree on the no-row sentinel (bun:sqlite → null,
  // better-sqlite3 → undefined) — Boolean() covers both.
  return Boolean(db.prepare("SELECT 1 FROM proposal_fs_imports WHERE stash_dir = ?").get(stashDir));
}

/**
 * Record that the legacy filesystem proposal import completed for `stashDir`
 * so subsequent invocations skip the directory walk. INSERT OR REPLACE keeps
 * the call idempotent.
 */
export function recordFsProposalsImport(db: Database, stashDir: string, importedCount: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO proposal_fs_imports (stash_dir, imported_at, imported_count) VALUES (?, ?, ?)",
  ).run(stashDir, new Date().toISOString(), importedCount);
}

/**
 * Insert a proposal row ONLY when the id is not already present (used by the
 * legacy filesystem import so re-runs never clobber rows that have since been
 * mutated through the canonical store). Returns true when a row was inserted.
 */
export function insertProposalIfAbsent(db: Database, proposal: Proposal, stashDir: string): boolean {
  const v = proposalToRowValues(proposal, stashDir);
  const result = db
    .prepare(`
      INSERT OR IGNORE INTO proposals
        (id, stash_dir, ref, status, source, created_at, updated_at, content, frontmatter_json, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      v.id,
      v.stash_dir,
      v.ref,
      v.status,
      v.source,
      v.created_at,
      v.updated_at,
      v.content,
      v.frontmatter_json,
      v.metadata_json,
    );
  const changes = (result as { changes?: number | bigint }).changes ?? 0;
  return Number(changes) > 0;
}

/**
 * Run `fn` inside a `BEGIN IMMEDIATE` transaction.
 *
 * `db.transaction()` is DEFERRED by default on both Bun and better-sqlite3,
 * which means two writers can both perform stale preflight reads and only race
 * when they finally attempt the write. Proposal creation and queue mutation
 * need the write lock BEFORE those reads so concurrent processes serialize on
 * the live queue state rather than clobbering each other.
 */
export function withImmediateTransaction<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback failures so the original error is preserved.
    }
    throw err;
  }
}

// ── task_history table helpers ───────────────────────────────────────────────

/**
 * Upsert a task history row.
 */
export function upsertTaskHistory(db: Database, row: TaskHistoryRow): void {
  // INSERT OR IGNORE: if a run with the same (task_id, started_at) was already
  // imported (e.g. by the migration script), skip it silently.
  db.prepare(`
    INSERT OR IGNORE INTO task_history
      (task_id, status, started_at, completed_at, failed_at, log_path,
       target_kind, target_ref, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.task_id,
    row.status,
    row.started_at,
    row.completed_at ?? null,
    row.failed_at ?? null,
    row.log_path ?? null,
    row.target_kind ?? null,
    row.target_ref ?? null,
    row.metadata_json,
  );
}

/**
 * Look up a task history row by task_id. Returns undefined when not found.
 */
/**
 * Return the most recent run for a given task_id, or undefined if no runs exist.
 */
export function getTaskHistory(db: Database, taskId: string): TaskHistoryRow | undefined {
  return db
    .prepare(
      `SELECT id, task_id, status, started_at, completed_at, failed_at, log_path,
              target_kind, target_ref, metadata_json
       FROM task_history WHERE task_id = ? ORDER BY started_at DESC LIMIT 1`,
    )
    .get(taskId) as TaskHistoryRow | undefined;
}

/**
 * Return all runs for a given task_id, newest first.
 */
export function getTaskHistoryRuns(db: Database, taskId: string, limit = 50): TaskHistoryRow[] {
  return db
    .prepare(
      `SELECT id, task_id, status, started_at, completed_at, failed_at, log_path,
              target_kind, target_ref, metadata_json
       FROM task_history WHERE task_id = ? ORDER BY started_at DESC LIMIT ?`,
    )
    .all(taskId, limit) as TaskHistoryRow[];
}

/**
 * Query task history rows by started_at range and/or status.
 */
export function queryTaskHistory(
  db: Database,
  options: { since?: string; until?: string; status?: string; targetKind?: string; targetRef?: string } = {},
): TaskHistoryRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (options.since) {
    conditions.push("started_at >= ?");
    params.push(options.since);
  }
  if (options.until) {
    conditions.push("started_at <= ?");
    params.push(options.until);
  }
  if (options.status) {
    conditions.push("status = ?");
    params.push(options.status);
  }
  if (options.targetKind) {
    conditions.push("target_kind = ?");
    params.push(options.targetKind);
  }
  if (options.targetRef) {
    conditions.push("target_ref = ?");
    params.push(options.targetRef);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .prepare(
      `SELECT task_id, status, started_at, completed_at, failed_at, log_path,
              target_kind, target_ref, metadata_json
       FROM task_history ${where} ORDER BY started_at DESC`,
    )
    .all(...(params as SqlValue[])) as TaskHistoryRow[];
}

/**
 * Slim projection of a `task_history` row used by health interval analysis.
 */
export interface TaskIntervalRow {
  started_at: string;
  completed_at: string;
}

/**
 * Read COMPLETED `akm-improve` task_history runs whose `started_at` falls in
 * `[since, until)` (or `started_at >= since` when `until` is omitted), ordered
 * oldest-first by `started_at`. Only rows with a non-null `completed_at` are
 * returned (in-flight runs are excluded). The `task_id = 'akm-improve'`
 * predicate is fixed because the only caller (commands/health.ts
 * `loadTaskIntervals`) builds wall-time intervals for the improve cron task.
 *
 * Owns the SQL formerly inlined in commands/health.ts. Note the bound is
 * EXCLUSIVE on the upper end (`started_at < ?`) — callers pass an already
 * widened window; this helper does not widen.
 *
 * Connection-lifetime rule (WS5): `.all()` materializes a plain array before
 * returning.
 */
export function queryCompletedTaskIntervals(db: Database, since: string, until?: string): TaskIntervalRow[] {
  const sql = until
    ? "SELECT started_at, completed_at FROM task_history WHERE task_id = 'akm-improve' AND started_at >= ? AND started_at < ? AND completed_at IS NOT NULL ORDER BY started_at"
    : "SELECT started_at, completed_at FROM task_history WHERE task_id = 'akm-improve' AND started_at >= ? AND completed_at IS NOT NULL ORDER BY started_at";
  return (until ? db.prepare(sql).all(since, until) : db.prepare(sql).all(since)) as TaskIntervalRow[];
}

// ── schema introspection ─────────────────────────────────────────────────────

/**
 * Return the subset of `names` that exist as TABLEs in this database, ordered
 * by name. Used by health's state-db-schema check to detect missing required
 * tables without leaking a `sqlite_master` query into command code.
 *
 * The `IN (...)` predicate is built from parameter placeholders so table names
 * are bound, never interpolated.
 *
 * Connection-lifetime rule (WS5): `.all()` materializes a plain array before
 * returning.
 */
export function listExistingTableNames(db: Database, names: readonly string[]): Array<{ name: string }> {
  if (names.length === 0) return [];
  const placeholders = names.map(() => "?").join(", ");
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders}) ORDER BY name`)
    .all(...(names as SqlValue[])) as Array<{ name: string }>;
}

// ── events.jsonl import ──────────────────────────────────────────────────────

/**
 * Import all events from an `events.jsonl` file into the `events` table.
 *
 * The old byte-offset `id` is NOT preserved — the database assigns new
 * monotonic integer ids. Callers that persisted a byte-offset cursor must
 * discard it after migration and use the returned `maxId` as the new cursor.
 *
 * **Idempotency**: each line is pre-checked against the `events` table using
 * `(event_type, ts, ref, metadata_json)` as the duplicate key. Lines whose
 * exact tuple is already present are skipped and reported as `skipped` in the
 * return value. This makes the migration safe to re-run (the v0.7→v0.8
 * migration guide recommends re-running the script as a recovery path; without
 * this guard, every re-run would double-import the entire event log).
 *
 * Duplicate detection is per-import-tuple, not a table-wide UNIQUE constraint:
 * the events table has no UNIQUE constraint at runtime so that
 * `appendEvent` can write multiple events with the same ts (sub-millisecond
 * bursts produce identical `(event_type, ts, ref)` triples in practice). The
 * SELECT-first check is scoped to the import path only.
 *
 * The import is wrapped in a single transaction for atomicity.
 *
 * @param db       - Open state.db connection.
 * @param jsonlPath - Absolute path to the events.jsonl file to import.
 * @returns         Number of rows inserted, the max id assigned, and the
 *                  count of rows skipped because an identical event already
 *                  existed in the table.
 */
export async function importEventsJsonl(
  db: Database,
  jsonlPath: string,
): Promise<{ imported: number; maxId: number; skipped: number }> {
  const { readFileSync, existsSync } = await import("node:fs");

  if (!existsSync(jsonlPath)) {
    return { imported: 0, maxId: 0, skipped: 0 };
  }

  const text = readFileSync(jsonlPath, "utf8");
  const lines = text.split("\n").filter((l) => l.trim().length > 0);

  let imported = 0;
  let maxId = 0;
  let skipped = 0;

  const insertStmt = db.prepare(
    `INSERT INTO events (event_type, ts, ref, metadata_json)
     VALUES (?, ?, ?, ?)
     RETURNING id`,
  );
  // Dedup pre-check: matches by the full tuple including metadata_json so an
  // import is idempotent over identical rows but does not collide with two
  // genuinely different events that happen to share (event_type, ts, ref).
  //
  // Uses IS for ref so two NULL refs compare equal (a plain `=` would treat
  // NULL = NULL as NULL and the row would be re-inserted on every run).
  const existsStmt = db.prepare(
    `SELECT 1 FROM events
     WHERE event_type = ?
       AND ts = ?
       AND ref IS ?
       AND metadata_json = ?
     LIMIT 1`,
  );

  db.transaction(() => {
    for (const line of lines) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // skip malformed lines — same behaviour as readEvents()
      }
      const eventType = typeof parsed.eventType === "string" ? parsed.eventType : "unknown";
      const ts = typeof parsed.ts === "string" ? parsed.ts : new Date().toISOString();
      const ref = typeof parsed.ref === "string" ? parsed.ref : null;
      const metadata =
        parsed.metadata !== undefined && typeof parsed.metadata === "object" ? JSON.stringify(parsed.metadata) : "{}";

      const duplicate = existsStmt.get(eventType, ts, ref, metadata) as { 1: number } | undefined;
      if (duplicate) {
        skipped++;
        continue;
      }

      const result = insertStmt.get(eventType, ts, ref, metadata) as { id: number } | undefined;
      if (result) {
        imported++;
        if (result.id > maxId) maxId = result.id;
      }
    }
  })();

  return { imported, maxId, skipped };
}

// ── improve_runs table helpers ───────────────────────────────────────────────

/**
 * Raw SQLite row shape for the `improve_runs` table.
 */
export interface ImproveRunRow {
  id: string;
  started_at: string;
  completed_at: string | null;
  stash_dir: string;
  dry_run: number;
  profile: string | null;
  scope_mode: string;
  scope_value: string | null;
  guidance: string | null;
  ok: number;
  result_json: string;
  metrics_json: string | null;
  metadata_json: string;
}

/**
 * Aggregate metrics derived from an `AkmImproveResult` envelope. These are the
 * counts that are useful for productivity audits, run-comparison dashboards,
 * and ad-hoc SQL queries without having to parse the full `result_json`.
 *
 * Only fields that actually exist on the result shape are included — the
 * helper never fabricates data.
 */
export interface ImproveRunMetrics {
  /** Number of refs that the improve loop intended to process this run. */
  plannedCount: number;
  /** Number of action results emitted (one per processed ref/op). */
  actionsCount: number;
  /** Action modes that imply a write (reflect/distill/memory-inference/graph-extraction succeeded). */
  acceptedCount: number;
  /** Action modes that were skipped (cooldown / skipped / failed). */
  rejectedCount: number;
  /** Subset of actions whose underlying result claimed `autoAccepted: true`. */
  autoAcceptedCount: number;
  /** Action modes that ended in `error`. */
  errorCount: number;
}

/**
 * Compute the cheap aggregate metrics blob from a full improve result.
 *
 * Pure function — no I/O. Used by {@link recordImproveRun} to populate
 * `metrics_json`. Exposed for tests and for any future call site that wants
 * the same aggregation logic without hitting state.db.
 */
export function computeImproveRunMetrics(result: AkmImproveResult): ImproveRunMetrics {
  const plannedCount = Array.isArray(result.plannedRefs) ? result.plannedRefs.length : 0;
  const actions = Array.isArray(result.actions) ? result.actions : [];
  const actionsCount = actions.length;

  let acceptedCount = 0;
  let rejectedCount = 0;
  let autoAcceptedCount = 0;
  let errorCount = 0;

  for (const action of actions) {
    // Bucketing delegated to the shared classifyImproveAction so this aggregate
    // and the improve_completed event in improve.ts can never disagree, and so a
    // new union variant is a compile error rather than a silent drop. Note:
    // `reflect-guard-rejected` now counts as "rejected" (previously this switch
    // omitted it entirely — a data-integrity miscount). "noop" (memory-prune) is
    // intentionally counted in none of the three numeric buckets.
    switch (classifyImproveAction(action.mode)) {
      case "accepted":
        acceptedCount++;
        break;
      case "rejected":
        rejectedCount++;
        break;
      case "error":
        errorCount++;
        break;
      case "noop":
        break;
    }
    // Legacy: pre-gate action results may carry autoAccepted: true (reflect path).
    const r = action.result as Record<string, unknown> | undefined;
    if (r && r.autoAccepted === true) autoAcceptedCount++;
  }

  // Add gate-promoted count from the unified PostPhaseAutoAcceptGate (all phases).
  autoAcceptedCount += result.gateAutoAcceptedCount ?? 0;

  return { plannedCount, actionsCount, acceptedCount, rejectedCount, autoAcceptedCount, errorCount };
}

/**
 * Insert a single improve-run row into `improve_runs`. Uses parameterised SQL.
 *
 * Idempotency: the table's PRIMARY KEY is `id`, so re-running with the same
 * runId would error. Callers mint a fresh runId per invocation via
 * {@link buildImproveRunId} so this is not a concern in practice — but the
 * default behaviour is INSERT (not REPLACE) so accidental dupes surface as
 * a SQLite constraint error rather than silently overwriting a prior record.
 *
 * The `metrics` parameter defaults to the output of
 * {@link computeImproveRunMetrics} when not supplied. Pass an explicit
 * `metrics` object to override the derivation (e.g. tests).
 */
export function recordImproveRun(
  db: Database,
  input: {
    id: string;
    startedAt: string;
    completedAt: string | null;
    stashDir: string;
    dryRun: boolean;
    profile: string | null;
    scopeMode: "all" | "type" | "ref";
    scopeValue: string | null;
    guidance: string | null;
    ok: boolean;
    result: AkmImproveResult;
    metrics?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  },
): void {
  const metricsObj = input.metrics ?? computeImproveRunMetrics(input.result);
  db.prepare(`
    INSERT INTO improve_runs
      (id, started_at, completed_at, stash_dir, dry_run, profile,
       scope_mode, scope_value, guidance, ok, result_json, metrics_json, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.startedAt,
    input.completedAt,
    input.stashDir,
    input.dryRun ? 1 : 0,
    input.profile,
    input.scopeMode,
    input.scopeValue,
    input.guidance,
    input.ok ? 1 : 0,
    JSON.stringify(input.result),
    JSON.stringify(metricsObj),
    JSON.stringify(input.metadata ?? {}),
  );
}

/**
 * Slim projection of an `improve_runs` row used by health/audit readers that
 * only need the windowed summary columns (NOT the full {@link ImproveRunRow}).
 * Matches the column list of {@link queryImproveRuns} verbatim.
 */
export interface ImproveRunSummaryRow {
  id: string;
  started_at: string;
  completed_at: string;
  ok: number;
  scope_mode: string;
  scope_value: string | null;
  result_json: string;
}

/**
 * Read real (non-dry-run) improve_runs rows whose `started_at` falls in the
 * window `[since, until)`. When `until` is omitted the window is open-ended
 * (`started_at >= since`). Rows are returned newest-first (`ORDER BY
 * started_at DESC`).
 *
 * Owns the SQL formerly inlined in commands/health.ts (`loadImproveRunRows`).
 * The `dry_run = 0` filter is first-class so dry-run probes never pollute
 * productivity audits.
 *
 * Connection-lifetime rule (WS5): `.all()` fully materializes the result set
 * into a plain array before returning — no live cursor escapes the caller's
 * `openStateDatabase` scope.
 */
export function queryImproveRuns(db: Database, since: string, until?: string): ImproveRunSummaryRow[] {
  const sql = until
    ? "SELECT id, started_at, completed_at, ok, scope_mode, scope_value, result_json FROM improve_runs WHERE started_at >= ? AND started_at < ? AND dry_run = 0 ORDER BY started_at DESC"
    : "SELECT id, started_at, completed_at, ok, scope_mode, scope_value, result_json FROM improve_runs WHERE started_at >= ? AND dry_run = 0 ORDER BY started_at DESC";
  return (until ? db.prepare(sql).all(since, until) : db.prepare(sql).all(since)) as ImproveRunSummaryRow[];
}

/**
 * Delete improve_runs rows older than `retentionDays` (default: 90). Mirrors
 * {@link purgeOldEvents} — same default, same return shape (number of rows
 * actually deleted), same disabled-when-non-finite semantics.
 *
 * Safe to call from the improve post-loop maintenance pass alongside
 * `purgeOldEvents(db, retentionDays)`.
 */
export function purgeOldImproveRuns(db: Database, retentionDays = 90): number {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const result = db.prepare("DELETE FROM improve_runs WHERE started_at < ?").run(cutoff);
  const changes = (result as { changes?: number | bigint }).changes ?? 0;
  return typeof changes === "bigint" ? Number(changes) : changes;
}

// ── extract_sessions_seen ───────────────────────────────────────────────────

/**
 * One row of the {@link extract_sessions_seen} table. Mirrors the SQL schema
 * documented in migration 004.
 */
export interface ExtractedSessionRow {
  harness: string;
  session_id: string;
  /** ISO-8601 UTC — when extract last processed this session. */
  processed_at: string;
  /** ISO-8601 — session.endedAt at processing time. Null when unknown. */
  session_ended_at: string | null;
  /** Outcome of the extract pass. */
  outcome: "candidates_queued" | "no_candidates" | "skipped" | "failed";
  candidate_count: number;
  proposal_count: number;
  /** For "no_candidates", the LLM's explanation. */
  rationale: string | null;
  /** sourceRun id for PROV-DM traceability. */
  source_run: string | null;
  metadata_json: string;
}

/**
 * Record (or update) one session's extract outcome. INSERT-OR-REPLACE so the
 * row reflects the most recent run; downstream skip-logic compares
 * `session_ended_at` against the live session metadata to decide if anything
 * new arrived since `processed_at`.
 */
export function upsertExtractedSession(
  db: Database,
  input: {
    harness: string;
    sessionId: string;
    processedAt: string;
    sessionEndedAt?: number | null;
    outcome: ExtractedSessionRow["outcome"];
    candidateCount: number;
    proposalCount: number;
    rationale?: string | null;
    sourceRun?: string | null;
    metadata?: Record<string, unknown>;
  },
): void {
  const endedAtIso =
    typeof input.sessionEndedAt === "number" && Number.isFinite(input.sessionEndedAt)
      ? new Date(input.sessionEndedAt).toISOString()
      : null;
  db.prepare(`
    INSERT OR REPLACE INTO extract_sessions_seen
      (harness, session_id, processed_at, session_ended_at, outcome,
       candidate_count, proposal_count, rationale, source_run, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.harness,
    input.sessionId,
    input.processedAt,
    endedAtIso,
    input.outcome,
    input.candidateCount,
    input.proposalCount,
    input.rationale ?? null,
    input.sourceRun ?? null,
    JSON.stringify(input.metadata ?? {}),
  );
}

/**
 * Fetch a single session's last extract record, or `undefined` when the
 * session has never been processed.
 */
export function getExtractedSession(db: Database, harness: string, sessionId: string): ExtractedSessionRow | undefined {
  // bun:sqlite returns null (not undefined) when no row matches — normalize so
  // callers can rely on `if (!row)` and `toBeUndefined()` equivalently.
  const row = db
    .prepare("SELECT * FROM extract_sessions_seen WHERE harness = ? AND session_id = ?")
    .get(harness, sessionId) as ExtractedSessionRow | null;
  return row ?? undefined;
}

/**
 * Bulk-fetch session-extract status for a list of sessionIds in one harness.
 * Returns a Map keyed by sessionId so callers can do O(1) lookups while
 * iterating the discovery list.
 */
export function getExtractedSessionsMap(
  db: Database,
  harness: string,
  sessionIds: readonly string[],
): Map<string, ExtractedSessionRow> {
  const out = new Map<string, ExtractedSessionRow>();
  if (sessionIds.length === 0) return out;
  // SQLite has a ~999 param ceiling; chunk if a caller ever exceeds that.
  const CHUNK = 500;
  for (let i = 0; i < sessionIds.length; i += CHUNK) {
    const chunk = sessionIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT * FROM extract_sessions_seen
         WHERE harness = ? AND session_id IN (${placeholders})`,
      )
      .all(harness, ...chunk) as ExtractedSessionRow[];
    for (const row of rows) out.set(row.session_id, row);
  }
  return out;
}

/**
 * Decide whether a session should be skipped because the extractor has
 * already processed it AND nothing has changed since. The "anything new since
 * last extract?" rule is: the live `sessionEndedAtMs` is strictly later than
 * the recorded `session_ended_at`. Same-or-earlier endedAt means we'd be
 * re-processing the exact same content for no gain.
 *
 * Returns:
 *   - `false` — no prior row, or session has new content since last extract.
 *     The caller should process it.
 *   - `true`  — the session was already processed and hasn't been updated.
 *     The caller should skip.
 */
export function shouldSkipAlreadyExtractedSession(
  prior: ExtractedSessionRow | undefined,
  liveSessionEndedAtMs: number | undefined,
): boolean {
  if (!prior) return false;
  // No live timestamp → can't tell if anything's new. Be conservative and
  // skip — the operator can pass --force later if we add it.
  if (typeof liveSessionEndedAtMs !== "number" || !Number.isFinite(liveSessionEndedAtMs)) {
    return true;
  }
  const priorMs = prior.session_ended_at ? Date.parse(prior.session_ended_at) : Number.NaN;
  if (!Number.isFinite(priorMs)) return false;
  // Re-process when there's new content; skip when the session is unchanged.
  return liveSessionEndedAtMs <= priorMs;
}

// ── consolidation_judged (judged-state cache, #581) ─────────────────────────

/**
 * One row of the consolidation judged-state cache. Keyed by the `memory:<name>`
 * ref; records the content hash the memory had the last time the consolidate
 * LLM judged it, so an unchanged memory can be skipped on the next run.
 */
export interface ConsolidationJudgedRow {
  /** `memory:<name>` ref. */
  entry_key: string;
  /** sha256 of the frontmatter-stripped, trimmed body at judge time. */
  content_hash: string;
  /** ISO-8601 UTC — when this memory was last judged. */
  judged_at: string;
  /** Coarse outcome of the last judge — observability only. */
  outcome: "actioned" | "no_action";
}

/**
 * Bulk-fetch the judged-state cache for a set of entry keys in one query.
 * Returns a Map keyed by entry_key so the consolidate pool-selection loop can
 * do O(1) "has this memory been judged at this content hash?" lookups.
 * Empty input → empty map (no query issued).
 */
export function getConsolidationJudgedMap(
  db: Database,
  entryKeys: readonly string[],
): Map<string, ConsolidationJudgedRow> {
  const out = new Map<string, ConsolidationJudgedRow>();
  if (entryKeys.length === 0) return out;
  // SQLite has a ~999 param ceiling; chunk if a caller ever exceeds that.
  const CHUNK = 500;
  for (let i = 0; i < entryKeys.length; i += CHUNK) {
    const chunk = entryKeys.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT * FROM consolidation_judged WHERE entry_key IN (${placeholders})`)
      .all(...chunk) as ConsolidationJudgedRow[];
    for (const row of rows) out.set(row.entry_key, row);
  }
  return out;
}

/**
 * Record (or update) the judged state for one memory. INSERT-OR-REPLACE so the
 * row always reflects the most recent judge of that entry_key. Called once per
 * memory the consolidate LLM saw in a successfully-judged chunk.
 */
export function upsertConsolidationJudged(
  db: Database,
  input: {
    entryKey: string;
    contentHash: string;
    judgedAt: string;
    outcome: ConsolidationJudgedRow["outcome"];
  },
): void {
  db.prepare(`
    INSERT OR REPLACE INTO consolidation_judged
      (entry_key, content_hash, judged_at, outcome)
    VALUES (?, ?, ?, ?)
  `).run(input.entryKey, input.contentHash, input.judgedAt, input.outcome);
}

// ── body_embeddings table helpers (WS-3a) ────────────────────────────────────

/**
 * Raw SQLite row shape for the `body_embeddings` table.
 * `embedding` is stored as a BLOB (raw Float32 bytes); callers convert to/from
 * `number[]` via `embeddingToBlob` / `blobToEmbedding`.
 */
export interface BodyEmbeddingRow {
  content_hash: string;
  embedding: Uint8Array; // raw Float32 bytes from SQLite BLOB
  model_id: string;
  created_at: number;
}

/**
 * Convert a `number[]` embedding vector to the `Float32Array` byte
 * representation stored in the `body_embeddings.embedding` BLOB column.
 */
export function embeddingToBlob(vec: number[]): Uint8Array {
  const f32 = new Float32Array(vec);
  return new Uint8Array(f32.buffer);
}

/**
 * Convert the raw `Uint8Array` bytes from the `body_embeddings.embedding`
 * BLOB column back to a `number[]` embedding vector.
 */
export function blobToEmbedding(blob: Uint8Array): number[] {
  // SQLite BLOB columns are returned as Uint8Array; re-interpret as Float32.
  const f32 = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  return Array.from(f32);
}

/**
 * Bulk-fetch cached body embeddings for a set of content hashes.
 * Returns a Map keyed by `content_hash` (embedding decoded to `number[]`).
 * Empty input → empty map (no query issued).
 *
 * If the stored `model_id` does not match `expectedModelId` the entire table
 * is cleared (drop-all on model mismatch) and an empty map is returned so
 * callers re-embed everything on this run.
 */
export function getBodyEmbeddings(
  db: Database,
  contentHashes: readonly string[],
  expectedModelId: string,
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (contentHashes.length === 0) return out;

  // Model-id mismatch: vectors are in the wrong metric space — drop all rows.
  const firstRow = db.prepare("SELECT model_id FROM body_embeddings LIMIT 1").get() as { model_id: string } | undefined;
  if (firstRow && firstRow.model_id !== expectedModelId) {
    db.exec("DELETE FROM body_embeddings");
    return out;
  }

  // SQLite has a ~999 param ceiling; chunk if needed.
  const CHUNK = 500;
  for (let i = 0; i < contentHashes.length; i += CHUNK) {
    const chunk = contentHashes.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT content_hash, embedding FROM body_embeddings WHERE content_hash IN (${placeholders})`)
      .all(...chunk) as Array<{ content_hash: string; embedding: Uint8Array }>;
    for (const row of rows) {
      out.set(row.content_hash, blobToEmbedding(row.embedding));
    }
  }
  return out;
}

/**
 * Upsert body-embedding rows in a single transaction.
 * Each entry maps a `cacheHash` → `number[]` vector. `model_id` is stored
 * so a future model change can trigger a drop-all purge.
 */
export function upsertBodyEmbeddings(
  db: Database,
  entries: Array<{ contentHash: string; embedding: number[]; modelId: string }>,
): void {
  if (entries.length === 0) return;
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO body_embeddings (content_hash, embedding, model_id, created_at)
    VALUES (?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (const { contentHash, embedding, modelId } of entries) {
      stmt.run(contentHash, embeddingToBlob(embedding), modelId, now);
    }
  })();
}

// ── registry_index_cache (goes in index.db, not state.db) ───────────────────

/**
 * DDL for the `registry_index_cache` table that lives in the EXISTING index.db
 * (managed by src/indexer/db/db.ts).
 *
 * Design: uses the same migration-safe ADD COLUMN approach. The table is
 * created with CREATE TABLE IF NOT EXISTS so it is safe to call inside
 * ensureSchema() or as a standalone migration.
 *
 * Purpose: caches the result of resolving and fetching remote registry stash
 * indexes so `akm search` does not hit the network on every invocation.
 *
 * Indexed (query) columns:
 *   registry_url  TEXT PK   — canonical URL of the registry; cache key.
 *   fetched_at    TEXT      — ISO-8601; used to detect stale entries (TTL).
 *   etag          TEXT      — HTTP ETag for conditional GET (If-None-Match).
 *   last_modified TEXT      — HTTP Last-Modified for conditional GET.
 *
 * Non-indexed payload:
 *   index_json    TEXT      — JSON blob of the fetched registry index document.
 *
 * ADD COLUMN extension points (future migrations in db.ts):
 *   ALTER TABLE registry_index_cache ADD COLUMN schema_version INTEGER DEFAULT 1;
 *   ALTER TABLE registry_index_cache ADD COLUMN kit_count INTEGER DEFAULT NULL;
 *   ALTER TABLE registry_index_cache ADD COLUMN error_message TEXT DEFAULT NULL;
 *
 * To add this table to index.db, call ensureRegistryIndexCacheSchema(db) from
 * within ensureSchema() in src/indexer/db/db.ts, or add it as a new CREATE TABLE
 * IF NOT EXISTS block inside the existing ensureSchema() call.
 */
export const REGISTRY_INDEX_CACHE_DDL = `
  CREATE TABLE IF NOT EXISTS registry_index_cache (
    registry_url  TEXT    PRIMARY KEY,
    fetched_at    TEXT    NOT NULL,
    etag          TEXT,
    last_modified TEXT,
    index_json    TEXT    NOT NULL DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS idx_registry_cache_fetched
    ON registry_index_cache(fetched_at);
`;
