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
import type { AssetOutcomeRow } from "./outcome-repository";

/** The half-open window `[sinceIso, untilIso)` plus the source every usage query shares. */
export interface MetricsQueryFilter {
  sinceIso: string;
  untilIso: string;
  /** `usage_events.source`; omit for every source. */
  source?: string;
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
  return db
    .prepare(
      `SELECT id, event_type, query, entry_id, entry_ref, signal, metadata, source, created_at
       FROM usage_events
       WHERE datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)${sourceSql}
       ORDER BY datetime(created_at), id`,
    )
    .all(filter.sinceIso, untilBound, ...sourceParams) as UsageEventRow[];
}

/**
 * `select` events (a show within 60 s of a search that returned the ref) in the
 * window. The events stream stores the ref as the user typed it (often
 * bundle-less), so the caller resolves it to the durable ref.
 */
export function listSelectEvents(db: Database, sinceIso: string, untilIso: string): Array<{ ts: string; ref: string }> {
  return db
    .prepare(
      `SELECT ts, ref FROM events
       WHERE event_type = 'select' AND ref IS NOT NULL AND ts >= ? AND ts < ?
       ORDER BY id`,
    )
    .all(sinceIso, untilIso) as Array<{ ts: string; ref: string }>;
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
