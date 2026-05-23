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

import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { EventEnvelope } from "./events";
import { getDataDir } from "./paths";
import type { Proposal } from "./proposals";
import { error } from "./warn";

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
 *   busy_timeout = 5000
 *     When another connection holds a write lock, SQLite retries for up to
 *     5 000 ms before returning SQLITE_BUSY. Without this, the default timeout
 *     is 0 ms — any concurrent writer causes an immediate error. 5 s matches
 *     the same value used in openDatabase() for index.db.
 */
export function openStateDatabase(dbPath?: string): Database {
  const resolvedPath = dbPath ?? getStateDbPath();
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);

  // PRAGMAs must run before any DDL or DML.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  runMigrations(db);

  return db;
}

// ── Migration engine ─────────────────────────────────────────────────────────

/**
 * A single migration: a stable string `id` and idempotent SQL `up` script.
 *
 * Rules:
 *   - `id` is permanent and must never be reused.
 *   - `up` must be idempotent (use IF NOT EXISTS, INSERT OR IGNORE, etc.).
 *   - `up` must not DROP any table that holds durable (non-regenerable) data.
 *   - `up` must not RENAME or change the type of an existing column.
 *   - To add a column: use `ALTER TABLE … ADD COLUMN … DEFAULT …`.
 */
interface Migration {
  id: string;
  up: string;
}

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
      --                             Current fields stored here: sourceRun, review.
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
];

/**
 * Create the migrations table if it does not exist. This must be called
 * unconditionally on every open so a fresh database bootstraps correctly.
 */
function ensureMigrationsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT    PRIMARY KEY,
      applied_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/**
 * Apply every pending migration in a single transaction per migration.
 *
 * Each migration is applied in its own transaction so a failure in migration N
 * does not roll back already-applied migrations 1..N-1. The migration row is
 * inserted AFTER the DDL succeeds, so a crash mid-migration leaves no row and
 * the migration will be retried on next open (all DDL in `up` uses IF NOT
 * EXISTS so the retry is safe).
 *
 * Called automatically by `openStateDatabase()`.
 */
export function runMigrations(db: Database): void {
  ensureMigrationsTable(db);

  const appliedRows = db.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: string }>;
  const applied = new Set(appliedRows.map((r) => r.id));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;

    db.transaction(() => {
      db.exec(migration.up);
      db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(migration.id);
    })();
  }
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
 * Maps to the public {@link Proposal} interface from src/core/proposals.ts.
 * The `sourceRun` and `review` fields are stored in `metadata_json`; callers
 * that need them should `JSON.parse(row.metadata_json)`.
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
    .all(...(params as import("bun:sqlite").SQLQueryBindings[])) as EventRow[];

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
 * Results are sorted by created_at ASC to match the existing listProposals() behaviour.
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
       FROM proposals ${where} ORDER BY created_at ASC`,
    )
    .all(...(params as import("bun:sqlite").SQLQueryBindings[])) as ProposalRow[];
  return rows.map(proposalRowToProposal);
}

/**
 * Look up a single proposal by id. Returns undefined when not found.
 */
export function getStateProposal(db: Database, id: string): Proposal | undefined {
  const row = db
    .prepare(
      `SELECT id, stash_dir, ref, status, source, created_at, updated_at,
              content, frontmatter_json, metadata_json
       FROM proposals WHERE id = ?`,
    )
    .get(id) as ProposalRow | undefined;
  return row ? proposalRowToProposal(row) : undefined;
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
    .all(...(params as import("bun:sqlite").SQLQueryBindings[])) as TaskHistoryRow[];
}

// ── events.jsonl import ──────────────────────────────────────────────────────

/**
 * Import all events from an `events.jsonl` file into the `events` table.
 *
 * The old byte-offset `id` is NOT preserved — the database assigns new
 * monotonic integer ids. Callers that persisted a byte-offset cursor must
 * discard it after migration and use the returned `maxId` as the new cursor.
 *
 * The import is wrapped in a single transaction for atomicity. If the file
 * has already been imported (the events table is non-empty and the file
 * has not changed since last import), callers should skip calling this
 * function — de-duplication is NOT performed here to keep the hot path fast.
 *
 * @param db       - Open state.db connection.
 * @param jsonlPath - Absolute path to the events.jsonl file to import.
 * @returns         Number of rows inserted and the max id assigned.
 */
export async function importEventsJsonl(db: Database, jsonlPath: string): Promise<{ imported: number; maxId: number }> {
  const { readFileSync, existsSync } = await import("node:fs");

  if (!existsSync(jsonlPath)) {
    return { imported: 0, maxId: 0 };
  }

  const text = readFileSync(jsonlPath, "utf8");
  const lines = text.split("\n").filter((l) => l.trim().length > 0);

  let imported = 0;
  let maxId = 0;

  const stmt = db.prepare(
    `INSERT INTO events (event_type, ts, ref, metadata_json)
     VALUES (?, ?, ?, ?)
     RETURNING id`,
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

      const result = stmt.get(eventType, ts, ref, metadata) as { id: number } | undefined;
      if (result) {
        imported++;
        if (result.id > maxId) maxId = result.id;
      }
    }
  })();

  return { imported, maxId };
}

// ── registry_index_cache (goes in index.db, not state.db) ───────────────────

/**
 * DDL for the `registry_index_cache` table that lives in the EXISTING index.db
 * (managed by src/indexer/db.ts).
 *
 * Design: uses the same migration-safe ADD COLUMN approach. The table is
 * created with CREATE TABLE IF NOT EXISTS so it is safe to call inside
 * ensureSchema() or as a standalone migration.
 *
 * Purpose: caches the result of resolving and fetching remote registry kit
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
 * within ensureSchema() in src/indexer/db.ts, or add it as a new CREATE TABLE
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
