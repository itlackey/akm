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
 * index.db is a derived cache built by an idempotent baseline schema; it is fully
 * regenerable from the stash on disk, so a corrupt index is recovered by deleting
 * it and re-running `akm index` (no destructive version-bump rebuild). Events,
 * proposals, and task history are NON-REGENERABLE — losing them is data loss. They
 * must live in a database whose schema evolves via incremental, additive migrations
 * that never drop rows.
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

import path from "node:path";
import type { Proposal } from "../commands/proposal/validators/proposals";
import type { Database, SqlValue } from "../storage/database";
import { openManagedDatabase, withManagedDb, withManagedDbAsync } from "../storage/managed-db";
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
  return openManagedDatabase({ path: dbPath ?? getStateDbPath(), init: runMigrations });
}

/**
 * Run `fn` against state.db, owning the handle unless one is borrowed. The loan
 * helper for state.db, mirroring `withIndexDb` / `withWorkflowRunsRepo`. Pass
 * `{ borrowed: ctx?.db }` to reuse an already-open run-scoped handle rather than
 * opening + closing a fresh one — this replaces the hand-rolled
 * `ctx?.db ?? open()` + `ownsDb` flag + `finally`/close idiom at call sites.
 */
export function withStateDb<T>(fn: (db: Database) => T, opts?: { path?: string; borrowed?: Database }): T {
  return withManagedDb(() => openStateDatabase(opts?.path), fn, opts);
}

/**
 * Async sibling of {@link withStateDb} — for `fn`s that hold the handle across
 * an `await` (the sync version would close it too early). Same borrow/own +
 * optional `path` override semantics.
 */
export function withStateDbAsync<T>(
  fn: (db: Database) => Promise<T>,
  opts?: { path?: string; borrowed?: Database },
): Promise<T> {
  return withManagedDbAsync(() => openStateDatabase(opts?.path), fn, opts);
}

// ── Migration engine ─────────────────────────────────────────────────────────
//
// The MIGRATIONS registry + runMigrations live in ./state/migrations (the single
// append-only ordered source of truth). Imported for internal use by
// openStateDatabase + re-exported so existing importers keep resolving.
import { runMigrations } from "./state/migrations";

export { runMigrations } from "./state/migrations";

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

// ── WS-4: Per-phase gate threshold store (Migration 012) ─────────────────────

/**
 * Read the persisted auto-tuned threshold for a gate phase.
 *
 * Returns `undefined` when no row exists yet (first run, or the phase has
 * never been tuned). The caller falls back to the global `options.autoAccept`
 * in that case.
 */
export function getPhaseThreshold(db: Database, phase: string): number | undefined {
  const row = db.prepare("SELECT threshold FROM improve_gate_thresholds WHERE phase = ?").get(phase) as
    | { threshold: number }
    | undefined;
  return row?.threshold;
}

/**
 * Persist the auto-tuned threshold for a gate phase.
 * Uses INSERT OR REPLACE so the call is idempotent (upsert semantics).
 */
export function persistPhaseThreshold(db: Database, phase: string, threshold: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO improve_gate_thresholds (phase, threshold, updated_at)
     VALUES (?, ?, ?)`,
  ).run(phase, Math.round(threshold), Date.now());
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
/**
 * Errors `BEGIN IMMEDIATE` can throw under concurrent-writer contention that are
 * transient (the statement did NOT start a usable transaction) and safe to
 * retry after clearing any phantom transaction state:
 *   - "database is locked" / SQLITE_BUSY — another writer holds the lock.
 *   - "cannot start a transaction within a transaction" — bun:sqlite can leave
 *     the connection reporting an open transaction after a contended busy-wait
 *     on BEGIN IMMEDIATE (observed only under heavy parallel load, e.g. the
 *     proposal-queue worker race). A ROLLBACK clears that phantom state.
 * These are start-of-transaction failures only; an error thrown by `fn` is a
 * real failure and is NEVER retried.
 */
function isRetryableBeginError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("within a transaction") ||
    msg.includes("database is locked") ||
    msg.includes("database table is locked")
  );
}

const WITH_IMMEDIATE_TX_MAX_ATTEMPTS = 5;

/** Portable synchronous sleep (works under both Bun and Node). */
function sleepSyncMs(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withImmediateTransaction<T>(db: Database, fn: () => T): T {
  let lastBeginErr: unknown;
  for (let attempt = 1; attempt <= WITH_IMMEDIATE_TX_MAX_ATTEMPTS; attempt++) {
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (err) {
      lastBeginErr = err;
      if (isRetryableBeginError(err) && attempt < WITH_IMMEDIATE_TX_MAX_ATTEMPTS) {
        // Clear any phantom/stale transaction left by the contended BEGIN, then
        // retry with a small backoff so concurrent writers serialize cleanly.
        try {
          db.exec("ROLLBACK");
        } catch {
          // No active transaction to roll back — fine.
        }
        sleepSyncMs(2 ** (attempt - 1));
        continue;
      }
      throw err;
    }
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
      throw err; // a real error inside the transaction body — never retried.
    }
  }
  // Exhausted retries on transient begin failures.
  throw lastBeginErr;
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
  /**
   * sha256 (hex) of the normalized session content at processing time. NULL for
   * rows written before #602 (migration 013) or when content was unavailable —
   * treated as a forced one-time reprocess to backfill the hash, after which the
   * row becomes hash-stable. This — not `session_ended_at` — is the skip
   * authority (#602).
   */
  content_hash: string | null;
}

/**
 * Record (or update) one session's extract outcome. INSERT-OR-REPLACE so the
 * row reflects the most recent run. The `content_hash` persisted here is what
 * the NEXT run compares against (#602): a byte-identical session is skipped, a
 * changed session is re-processed, and a NULL-backfill row becomes hash-stable
 * after its one reprocess. `session_ended_at` is still written for
 * telemetry/forensics but is no longer the skip authority.
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
    /** sha256 (hex) of the normalized session content, or null when unavailable. */
    contentHash: string | null;
  },
): void {
  const endedAtIso =
    typeof input.sessionEndedAt === "number" && Number.isFinite(input.sessionEndedAt)
      ? new Date(input.sessionEndedAt).toISOString()
      : null;
  db.prepare(`
    INSERT OR REPLACE INTO extract_sessions_seen
      (harness, session_id, processed_at, session_ended_at, outcome,
       candidate_count, proposal_count, rationale, source_run, metadata_json,
       content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    input.contentHash,
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
 * The most recent extract-run time for a harness — `MAX(processed_at)` across
 * its ledger rows, as ms epoch — or `null` when the harness has never been
 * extracted. Used to default the discovery window to "since the last run" so an
 * intermittently-online host that was off for days still rediscovers sessions
 * that ended during the gap (the content-hash ledger keeps the widened window
 * free of redundant LLM cost).
 */
export function getLastExtractRunAt(db: Database, harness: string): number | null {
  const row = db
    .prepare("SELECT MAX(processed_at) AS last FROM extract_sessions_seen WHERE harness = ?")
    .get(harness) as { last: string | null } | null;
  if (!row?.last) return null;
  const ms = Date.parse(row.last);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Decide whether a session should be skipped because the extractor has already
 * processed BYTE-IDENTICAL content (#602). The skip authority is the content
 * hash, NOT `session_ended_at` — this is clock-independent, so it is immune to
 * the clock-skew / out-of-order-endedAt problems that caused the Jun 11-12
 * double-extract + over-throttle incident.
 *
 * Rules:
 *   - no prior row              → `false` (never seen → process; AC3).
 *   - prior.content_hash == null → `false` (legacy / hash-less row → process
 *     exactly once to backfill the hash, then it becomes hash-stable; AC4).
 *   - hashes equal              → `true`  (unchanged content → skip; AC1).
 *   - hashes differ             → `false` (changed content → re-process; AC2).
 */
export function shouldSkipAlreadyExtractedSession(
  prior: ExtractedSessionRow | undefined,
  currentContentHash: string,
): boolean {
  if (!prior) return false;
  if (prior.content_hash == null) return false;
  return prior.content_hash === currentContentHash;
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

// ── recombine_hypotheses (#625 confirmation count) ──────────────────────────

/**
 * One row of the recombine confirmation ledger (migration 014). Keyed by the
 * deterministic `deriveRecombineLessonRef` value so re-induction of the SAME
 * member-set maps back to the SAME row across runs.
 */
export interface RecombineHypothesisRow {
  /** `lesson:recombined/<slug>-<hash>` ref — the promotion target asset. */
  hypothesis_ref: string;
  /** The cluster's shared relatedness signal (tag / entity) at induction time. */
  signature: string;
  /** Sorted member entryKeys joined — the membership fingerprint. */
  member_key: string;
  /** Current confirmation streak (reset on decay and on promotion). */
  consecutive_count: number;
  /** ISO-8601 UTC of the first induction. */
  first_seen_at: string;
  /** ISO-8601 UTC of the most recent induction. */
  last_seen_at: string;
  /** sourceRun token of the last induction; same-run idempotency guard. */
  last_run: string | null;
  /** Non-null once promoted; guards against double-promotion. */
  promoted_at: string | null;
  /** Reserved forensic metadata; defaults to '{}'. */
  metadata_json: string;
}

/**
 * Record an induction of a recombine hypothesis and return the new consecutive
 * count. INSERT … ON CONFLICT increments the streak, but the `last_run` guard
 * makes a repeated call within the SAME run idempotent (no double-increment if
 * the same ref appears twice in one run). On insert the streak starts at 1.
 */
export function recordRecombineInduction(
  db: Database,
  input: { hypothesisRef: string; signature: string; memberKey: string; seenAt: string; run: string },
): number {
  const row = db
    .prepare(`
      INSERT INTO recombine_hypotheses
        (hypothesis_ref, signature, member_key, consecutive_count, first_seen_at, last_seen_at, last_run)
      VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(hypothesis_ref) DO UPDATE SET
        consecutive_count = consecutive_count + (CASE WHEN last_run IS excluded.last_run THEN 0 ELSE 1 END),
        last_seen_at = excluded.last_seen_at,
        last_run = excluded.last_run,
        signature = excluded.signature,
        member_key = excluded.member_key
      RETURNING consecutive_count
    `)
    .get(input.hypothesisRef, input.signature, input.memberKey, input.seenAt, input.seenAt, input.run) as {
    consecutive_count: number;
  } | null;
  return row?.consecutive_count ?? 0;
}

/**
 * #633 — find an existing pending (non-promoted) hypothesis row whose cluster
 * is the SAME generalization as a newly-induced one, matched by SIGNATURE plus
 * a Jaccard membership-overlap test, rather than an exact member-set hash.
 *
 * In a growing stash any added/removed memory changes the exact member set, so
 * the ref hash (and member_key) shift every run → a fresh row at count=1 → the
 * streak never reaches `confirmThreshold` and nothing ever promotes. Matching
 * on overlap lets a drifting-but-stable cluster keep accumulating under one row.
 *
 * Returns the matched row with the HIGHEST overlap (ties broken by most-recent
 * `last_seen_at`), or `undefined` when none clears `minOverlap`. Already-promoted
 * rows are ignored so a confirmed lesson is not reopened by a later induction.
 *
 * @param memberKey  the candidate cluster's membership fingerprint
 *                   (sorted member entryKeys joined by `|`).
 * @param minOverlap Jaccard threshold in [0,1]; a candidate matches when
 *                   |A∩B| / |A∪B| >= minOverlap.
 */
export function findMatchingRecombineHypothesis(
  db: Database,
  input: { signature: string; memberKey: string; minOverlap: number },
): RecombineHypothesisRow | undefined {
  const candidateMembers = new Set(input.memberKey.split("|").filter((m) => m.length > 0));
  if (candidateMembers.size === 0) return undefined;
  const rows = db
    .prepare(
      "SELECT * FROM recombine_hypotheses WHERE signature = ? AND promoted_at IS NULL ORDER BY last_seen_at DESC",
    )
    .all(input.signature) as RecombineHypothesisRow[];
  let best: RecombineHypothesisRow | undefined;
  let bestOverlap = -1;
  for (const row of rows) {
    const rowMembers = row.member_key.split("|").filter((m) => m.length > 0);
    if (rowMembers.length === 0) continue;
    let intersection = 0;
    for (const m of rowMembers) {
      if (candidateMembers.has(m)) intersection += 1;
    }
    const union = candidateMembers.size + rowMembers.length - intersection;
    const overlap = union === 0 ? 0 : intersection / union;
    // rows are ordered last_seen_at DESC, so a strict `>` keeps the most-recent
    // row on ties.
    if (overlap >= input.minOverlap && overlap > bestOverlap) {
      best = row;
      bestOverlap = overlap;
    }
  }
  return best;
}

/**
 * Fetch a single recombine hypothesis row, or `undefined` when the ref has
 * never been induced. Normalizes bun:sqlite null → undefined like
 * {@link getExtractedSession}.
 */
export function getRecombineHypothesis(db: Database, hypothesisRef: string): RecombineHypothesisRow | undefined {
  const row = db
    .prepare("SELECT * FROM recombine_hypotheses WHERE hypothesis_ref = ?")
    .get(hypothesisRef) as RecombineHypothesisRow | null;
  return row ?? undefined;
}

/**
 * Mark a hypothesis promoted: stamp `promoted_at` and reset the consecutive
 * count to 0, so it must re-accumulate a full confirmation streak before it can
 * promote again. The `promoted_at` non-null state is the double-promotion guard.
 */
export function markRecombineHypothesisPromoted(db: Database, hypothesisRef: string, promotedAt: string): void {
  db.prepare("UPDATE recombine_hypotheses SET promoted_at = ?, consecutive_count = 0 WHERE hypothesis_ref = ?").run(
    promotedAt,
    hypothesisRef,
  );
}

/**
 * A cluster that formed in the current run, identified the same way a hypothesis
 * row is: by its relatedness `signature` plus its membership fingerprint
 * (`memberKey` — sorted member entryKeys joined by `|`). Used by
 * {@link decayUnseenRecombineHypotheses} to spare cap-displaced hypotheses.
 */
export interface PresentCluster {
  signature: string;
  memberKey: string;
}

/**
 * #658 — does any current-run cluster match this hypothesis row under the SAME
 * signature + Jaccard-overlap rule used for re-induction? A match means the
 * cluster genuinely re-formed this run (it was merely cap-displaced out of the
 * processed top-`maxClustersPerRun` slice), so its streak must NOT be reset.
 */
function hypothesisMatchesAnyPresentCluster(
  row: { signature: string; member_key: string },
  presentClusters: readonly PresentCluster[],
  minOverlap: number,
): boolean {
  const rowMembers = row.member_key.split("|").filter((m) => m.length > 0);
  if (rowMembers.length === 0) return false;
  const rowSet = new Set(rowMembers);
  for (const cluster of presentClusters) {
    if (cluster.signature !== row.signature) continue;
    const clusterMembers = cluster.memberKey.split("|").filter((m) => m.length > 0);
    if (clusterMembers.length === 0) continue;
    let intersection = 0;
    for (const m of clusterMembers) {
      if (rowSet.has(m)) intersection += 1;
    }
    const union = rowSet.size + clusterMembers.length - intersection;
    const overlap = union === 0 ? 0 : intersection / union;
    if (overlap >= minOverlap) return true;
  }
  return false;
}

/**
 * Decay-to-zero every NON-promoted hypothesis NOT re-induced in the current run.
 *
 * A generalization that stops being supported by the corpus has lost its
 * confirmation streak, so we hard-reset `consecutive_count` to 0 (the
 * alternative — `count - 1` floored at 0 — tolerates a single noisy run but
 * blurs the "consecutive" semantics; hard-reset is the conservative choice).
 *
 * Only rows whose `hypothesis_ref` is NOT in `seenRefs` AND whose `last_run` is
 * NOT the current run are decayed. Already-promoted rows are left alone.
 *
 * #658 — CAP-AWARE decay. The recombine pass only re-inducts (and thus marks
 * `seen`) the top-`maxClustersPerRun` clusters, but a cluster genuinely
 * re-forms every run even when it is displaced below that cap. Resetting such a
 * row treats a SCHEDULING miss as a SUBSTANCE miss and traps the hypothesis
 * below `confirmThreshold` forever. When `opts.presentClusters` is supplied, a
 * row is SPARED from decay if it Jaccard-matches any present cluster (same
 * signature, overlap >= `opts.minOverlap`) — i.e. its cluster re-formed this run
 * but was cap-displaced. This does NOT advance the streak (only re-induction in
 * the processed slice does that, via {@link recordRecombineInduction}), so the
 * recurrence bar for promotion is unchanged; it only stops the cap from
 * manufacturing artificial misses. Omitting `presentClusters` preserves the
 * pre-#658 hard-reset-after-one-miss behaviour exactly.
 *
 * Returns the number of rows reset.
 */
export function decayUnseenRecombineHypotheses(
  db: Database,
  currentRun: string,
  seenRefs: readonly string[],
  opts?: { presentClusters: readonly PresentCluster[]; minOverlap: number },
): number {
  // #658 — when cap-aware sparing is requested, fold the cap-displaced rows into
  // the "seen" exclusion set: the underlying reset SQL already protects every
  // ref it is given, so sparing == treating a spared row exactly like a seen
  // row for this sweep (its count is left untouched, never advanced).
  let effectiveSeen: readonly string[] = seenRefs;
  if (opts && opts.presentClusters.length > 0) {
    const candidates = db
      .prepare(
        "SELECT hypothesis_ref, signature, member_key FROM recombine_hypotheses WHERE promoted_at IS NULL AND (last_run IS NULL OR last_run != ?) AND consecutive_count != 0",
      )
      .all(currentRun) as Array<{ hypothesis_ref: string; signature: string; member_key: string }>;
    const seenSet = new Set(seenRefs);
    for (const row of candidates) {
      if (seenSet.has(row.hypothesis_ref)) continue;
      if (hypothesisMatchesAnyPresentCluster(row, opts.presentClusters, opts.minOverlap)) {
        seenSet.add(row.hypothesis_ref);
      }
    }
    effectiveSeen = [...seenSet];
  }
  return decayUnseenRecombineHypothesesInner(db, currentRun, effectiveSeen);
}

/**
 * The raw reset sweep shared by the cap-aware wrapper above. Resets every
 * non-promoted row from a prior run whose ref is NOT in `seenRefs`. Kept private
 * so the param-ceiling chunking logic lives in one place.
 */
function decayUnseenRecombineHypothesesInner(db: Database, currentRun: string, seenRefs: readonly string[]): number {
  // Reset every eligible row, then exclude the seen refs in chunks to respect
  // the ~999 SQLite param ceiling. With no seen refs we reset all non-promoted
  // rows from prior runs in a single statement.
  if (seenRefs.length === 0) {
    const res = db
      .prepare(
        "UPDATE recombine_hypotheses SET consecutive_count = 0 WHERE promoted_at IS NULL AND (last_run IS NULL OR last_run != ?) AND consecutive_count != 0",
      )
      .run(currentRun);
    return Number(res.changes);
  }
  // A single NOT IN keeps the exclusion atomic (a chunked NOT IN would let a ref
  // excluded by one chunk still be reset by another chunk's statement). The
  // recombine pass caps RE-INDUCED clusters at `maxClustersPerRun` (a handful) —
  // but with #658 cap-aware sparing the caller folds every cap-displaced
  // (present-but-unprocessed) hypothesis into `effectiveSeen` too, so on a large
  // stash `seenRefs` here can carry MANY spared refs, not just the handful that
  // were processed. We cap defensively at ~900 (under SQLite's ~999 param
  // ceiling): if `effectiveSeen` somehow exceeds it we fall back to resetting all
  // eligible rows — which re-introduces the cap-displacement trap for THAT run
  // (spared rows get decayed because the NOT IN protection is dropped). That is a
  // rare, bounded degradation; a stash with >900 simultaneously-spared
  // hypotheses is far beyond current scale.
  if (seenRefs.length > 900) {
    const res = db
      .prepare(
        "UPDATE recombine_hypotheses SET consecutive_count = 0 WHERE promoted_at IS NULL AND (last_run IS NULL OR last_run != ?) AND consecutive_count != 0",
      )
      .run(currentRun);
    return Number(res.changes);
  }
  const placeholders = seenRefs.map(() => "?").join(",");
  const res = db
    .prepare(
      `UPDATE recombine_hypotheses SET consecutive_count = 0
       WHERE promoted_at IS NULL
         AND (last_run IS NULL OR last_run != ?)
         AND consecutive_count != 0
         AND hypothesis_ref NOT IN (${placeholders})`,
    )
    .run(currentRun, ...seenRefs);
  return Number(res.changes);
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
