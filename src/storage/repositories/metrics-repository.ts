// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Read-only queries behind `akm metrics` over `state.db`: `usage_events`, the
 * `events` types that only metrics reads (`select`, `index_completed`),
 * `asset_outcome`, `proposals` and the workflow tables. LLM usage, task history
 * and accept rate go through the readers `akm health` already owns.
 *
 * `usage_events.created_at` is `YYYY-MM-DD HH:MM:SS` (SQLite `datetime('now')`),
 * not ISO, so every time bound compares `datetime(created_at)` with
 * `datetime(?)`: a raw string compare against an ISO bound treats the whole
 * bound date as older, because a space sorts before `T`. `events.ts` is ISO
 * already and compares directly.
 */

import type { UsageEventRow } from "../../indexer/usage/usage-events";
import type { Database } from "../database";
import type { EventRow } from "./events-repository";
import type { AssetOutcomeRow } from "./outcome-repository";

/** The half-open window `[sinceIso, untilIso)` plus the source every usage query shares. */
export interface MetricsQueryFilter {
  sinceIso: string;
  untilIso: string;
  /** `usage_events.source`; omit for every source. */
  source?: string;
  /** Return only the newest `newest` rows (still oldest first). */
  newest?: number;
}

/** Usage rows (search / show / curate / feedback) in the window, oldest first. */
export function listUsageEventRows(db: Database, filter: MetricsQueryFilter): UsageEventRow[] {
  const sourceSql = filter.source === undefined ? "" : " AND source = ?";
  const sourceParams = filter.source === undefined ? [] : [filter.source];
  // `created_at` has whole-second resolution, so a row written during the
  // bound's own second (e.g. `--until` defaulting to now) is still inside the
  // half-open window: round a fractional bound up to the next second.
  const untilMs = Date.parse(filter.untilIso);
  const untilBound = new Date(Math.ceil(untilMs / 1000) * 1000).toISOString();
  const newest = filter.newest !== undefined;
  const rows = db
    .prepare(
      `SELECT id, event_type, query, entry_id, entry_ref, signal, metadata, source, created_at
       FROM usage_events
       WHERE datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)${sourceSql}
       ORDER BY datetime(created_at)${newest ? " DESC" : ""}, id${newest ? " DESC LIMIT ?" : ""}`,
    )
    .all(filter.sinceIso, untilBound, ...sourceParams, ...(newest ? [filter.newest as number] : [])) as UsageEventRow[];
  return newest ? rows.reverse() : rows;
}

/** One asset's feedback rows (`entry_ref` is the durable `bundle//conceptId`), newest first (the workspace's asset view). */
export function listFeedbackEventRows(db: Database, entryRef: string, limit: number): UsageEventRow[] {
  return db
    .prepare(
      `SELECT id, event_type, query, entry_id, entry_ref, signal, metadata, source, created_at
       FROM usage_events
       WHERE event_type = 'feedback' AND entry_ref = ?
       ORDER BY datetime(created_at) DESC, id DESC LIMIT ?`,
    )
    .all(entryRef, limit) as UsageEventRow[];
}

/** Feedback counts by signal for one asset, all sources (the workspace's asset view). */
export function countFeedbackBySignal(db: Database, entryRef: string): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT COALESCE(signal, 'none') AS signal, COUNT(*) AS n FROM usage_events
       WHERE event_type = 'feedback' AND entry_ref = ? GROUP BY signal`,
    )
    .all(entryRef) as Array<{ signal: string; n: number }>;
  return Object.fromEntries(rows.map((row) => [row.signal, row.n]));
}

/** A `select` event; `searchId` and `source` are absent on rows written before selects carried them. */
export interface SelectEventRow {
  ts: string;
  ref: string;
  searchId?: string;
  /** The usage source of the search the select followed. */
  source?: string;
}

/**
 * `select` events (a show within 60 s of a search that returned the ref) in the
 * window. The events stream stores the ref as the user typed it (often
 * bundle-less), so the caller resolves it to the durable ref.
 */
export function listSelectEvents(db: Database, sinceIso: string, untilIso: string): SelectEventRow[] {
  const rows = db
    .prepare(
      `SELECT ts, ref, metadata_json FROM events
       WHERE event_type = 'select' AND ref IS NOT NULL AND ts >= ? AND ts < ?
       ORDER BY id`,
    )
    .all(sinceIso, untilIso) as Array<{ ts: string; ref: string; metadata_json: string | null }>;
  return rows.map(({ ts, ref, metadata_json }) => {
    const { searchId, source } = parseSelectMetadata(metadata_json);
    return { ts, ref, ...(searchId ? { searchId } : {}), ...(source ? { source } : {}) };
  });
}

/** A select's `searchId` and `source`, each absent on rows written before selects carried it. */
function parseSelectMetadata(metadataJson: string | null): { searchId?: string; source?: string } {
  if (!metadataJson) return {};
  try {
    const meta = JSON.parse(metadataJson) as { searchId?: unknown; source?: unknown };
    const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);
    return { searchId: text(meta.searchId), source: text(meta.source) };
  } catch {
    return {};
  }
}

/** `index_completed` events (one per `akm index` run) in the window, oldest first. */
export function listIndexCompletedEvents(
  db: Database,
  sinceIso: string,
  untilIso: string,
): Array<{ ts: string; metadata_json: string }> {
  return db
    .prepare(
      `SELECT ts, metadata_json FROM events
       WHERE event_type = 'index_completed' AND ts >= ? AND ts < ?
       ORDER BY id`,
    )
    .all(sinceIso, untilIso) as Array<{ ts: string; metadata_json: string }>;
}

/** The `limit` assets with the lowest `outcome_score`, ties broken by ref. */
export function listLowestOutcomeAssets(db: Database, limit: number): AssetOutcomeRow[] {
  return db
    .prepare(
      `SELECT asset_ref, last_retrieved_at, retrieval_count, expected_retrieval_rate,
              negative_feedback_count, accepted_change_count, outcome_score, updated_at
       FROM asset_outcome
       ORDER BY outcome_score ASC, asset_ref ASC LIMIT ?`,
    )
    .all(limit) as AssetOutcomeRow[];
}

/** Proposal counts by status, for proposals last updated in the window. */
export function countProposalsByStatus(db: Database, sinceIso: string, untilIso: string): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM proposals
       WHERE updated_at >= ? AND updated_at < ?
       GROUP BY status ORDER BY status`,
    )
    .all(sinceIso, untilIso) as Array<{ status: string; n: number }>;
  return Object.fromEntries(rows.map((row) => [row.status, row.n]));
}

/**
 * Workflow runs created in the window by status, and the tokens their unit
 * attempts spent by model. Attempts, not the unit projection, so a retried
 * unit keeps the tokens of every attempt.
 */
export function summarizeWorkflowRuns(
  db: Database,
  sinceIso: string,
  untilIso: string,
): { runs: number; byStatus: Record<string, number>; tokens: number; byModel: Record<string, number> } {
  const statusRows = db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM workflow_runs
       WHERE created_at >= ? AND created_at < ? GROUP BY status ORDER BY status`,
    )
    .all(sinceIso, untilIso) as Array<{ status: string; n: number }>;
  const modelRows = db
    .prepare(
      `SELECT COALESCE(model, 'unattributed') AS model, SUM(tokens) AS tokens
       FROM workflow_run_unit_attempts
       WHERE tokens IS NOT NULL AND started_at >= ? AND started_at < ?
       GROUP BY COALESCE(model, 'unattributed') ORDER BY model`,
    )
    .all(sinceIso, untilIso) as Array<{ model: string; tokens: number }>;
  return {
    runs: statusRows.reduce((sum, row) => sum + row.n, 0),
    byStatus: Object.fromEntries(statusRows.map((row) => [row.status, row.n])),
    tokens: modelRows.reduce((sum, row) => sum + row.tokens, 0),
    byModel: Object.fromEntries(modelRows.map((row) => [row.model, row.tokens])),
  };
}

// ── Fold reads (state.db, one closed UTC day at a time) ─────────────────────

/** The state.db tables the fold counts, with the column that dates a row. */
export const FOLD_SOURCES = {
  events: { table: "events", column: "ts" },
  usage: { table: "usage_events", column: "created_at" },
  runs: { table: "improve_runs", column: "started_at" },
} as const;
export type FoldSourceKey = keyof typeof FOLD_SOURCES;

export function hasTable(db: Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/** Row counts per UTC day for the rows of `key`'s table before `beforeDay`; empty when the table is missing. */
export function countRowsByDay(db: Database, key: FoldSourceKey, beforeDay: string): Map<string, number> {
  const { table, column } = FOLD_SOURCES[key];
  if (!hasTable(db, table)) return new Map();
  const rows = db
    .prepare(`SELECT substr(${column}, 1, 10) AS day, COUNT(*) AS n FROM ${table} WHERE ${column} < ? GROUP BY day`)
    .all(beforeDay) as Array<{ day: string; n: number }>;
  return new Map(rows.map((r) => [r.day, r.n]));
}

/** Rows of `key`'s table dated in `[day, nextDay)`; 0 when the table is missing. */
export function countRowsInDay(db: Database, key: FoldSourceKey, day: string, nextDay: string): number {
  const { table, column } = FOLD_SOURCES[key];
  if (!hasTable(db, table)) return 0;
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} >= ? AND ${column} < ?`)
    .get(day, nextDay) as { n: number };
  return row.n;
}

export function countEventsByType(db: Database, day: string, nextDay: string): Array<{ eventType: string; n: number }> {
  const rows = db
    .prepare("SELECT event_type, COUNT(*) AS n FROM events WHERE ts >= ? AND ts < ? GROUP BY event_type")
    .all(day, nextDay) as Array<{ event_type: string; n: number }>;
  return rows.map((r) => ({ eventType: r.event_type, n: r.n }));
}

/** The raw events of one type in `[day, nextDay)`, oldest first. */
export function listEventsOfType(db: Database, eventType: string, day: string, nextDay: string): EventRow[] {
  return db
    .prepare(
      "SELECT id, event_type, ts, ref, metadata_json FROM events WHERE event_type = ? AND ts >= ? AND ts < ? ORDER BY id",
    )
    .all(eventType, day, nextDay) as EventRow[];
}

export interface ImproveRunSourceRow {
  id: string;
  started_at: string;
  completed_at: string | null;
  stash_dir: string;
  dry_run: number;
  strategy: string | null;
  scope_mode: string;
  scope_value: string | null;
  guidance: string | null;
  ok: number;
  result_json: string;
  metrics_json: string | null;
  metadata_json: string;
}

export function listImproveRunsStartedIn(db: Database, day: string, nextDay: string): ImproveRunSourceRow[] {
  return db
    .prepare(
      `SELECT id, started_at, completed_at, stash_dir, dry_run, strategy, scope_mode, scope_value, guidance, ok,
              result_json, metrics_json, metadata_json
       FROM improve_runs WHERE started_at >= ? AND started_at < ?`,
    )
    .all(day, nextDay) as ImproveRunSourceRow[];
}
