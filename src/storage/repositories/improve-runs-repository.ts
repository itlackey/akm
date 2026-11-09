// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Repository for the state.db `improve_runs` table (per-run audit ledger).
 * Extracted verbatim from core/state-db.ts — queries and the pure
 * `computeImproveRunMetrics` aggregation unchanged, only relocated behind the
 * repository boundary. Re-exported by core/state-db.ts so existing importers
 * resolve.
 *
 * The `improve_gate_thresholds` per-phase auto-tune store (migration 012)
 * lost its readers with the 0.9.0 confidence-gate deletion; migration 028
 * drops the table.
 *
 * @module improve-runs-repository
 */

import type { ImproveResultEnvelope } from "../../core/improve-result";
import { classifyImproveAction } from "../../core/improve-types";
import type { Database } from "../database";
import { withMetricsHistory } from "./metrics-rollup-repository";

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
  strategy: string | null;
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
  /** Action modes that imply a write (reflect/distill/memory-inference succeeded). */
  acceptedCount: number;
  /** Genuine value-rejections: a change was produced then rejected by a content guard. */
  rejectedCount: number;
  /** Gated skips (cooldown / signal-delta skip / distill pool-delta skip) — NOT rejections. */
  skippedCount: number;
  /** Proposals the triage pre-pass promoted (auto-accepted) this run. */
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
export function computeImproveRunMetrics(result: ImproveResultEnvelope): ImproveRunMetrics {
  const plannedCount = Array.isArray(result.plannedRefs) ? result.plannedRefs.length : 0;
  const actions = Array.isArray(result.actions) ? result.actions : [];
  const actionsCount = actions.length;

  let acceptedCount = 0;
  let rejectedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const action of actions) {
    // Bucketing delegated to the shared classifyImproveAction so this aggregate
    // and the improve_completed event in improve.ts can never disagree, and so a
    // new union variant is a compile error rather than a silent drop. Gated skips
    // (cooldown / signal-delta / distill pool-delta) bucket to "skipped", NOT
    // "rejected" — only a guard-rejected produced change is a true rejection.
    // "noop" (memory-prune) is intentionally counted in none of the buckets.
    switch (classifyImproveAction(action.mode)) {
      case "accepted":
        acceptedCount++;
        break;
      case "rejected":
        rejectedCount++;
        break;
      case "skipped":
        skippedCount++;
        break;
      case "error":
        errorCount++;
        break;
      case "noop":
        break;
    }
  }

  const autoAcceptedCount = result.triage?.promoted ?? 0;

  // C1 (13-bus-factor): distill-skipped rows are folded into the bounded
  // `distillSkipped` aggregate and no longer live in `actions`. Add the
  // aggregate total to the skipped + total-actions counters so metrics_json
  // keeps aggregate metrics aligned with the logical action count.
  const distillSkippedTotal = result.distillSkipped?.total ?? 0;
  skippedCount += distillSkippedTotal;

  return {
    plannedCount,
    actionsCount: actionsCount + distillSkippedTotal,
    acceptedCount,
    rejectedCount,
    skippedCount,
    autoAcceptedCount,
    errorCount,
  };
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
    strategy: string;
    scopeMode: "all" | "type" | "ref";
    scopeValue: string | null;
    guidance: string | null;
    ok: boolean;
    result: ImproveResultEnvelope;
    metrics?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  },
): void {
  const metricsObj = input.metrics ?? computeImproveRunMetrics(input.result);
  db.prepare(`
    INSERT INTO improve_runs
       (id, started_at, completed_at, stash_dir, dry_run, strategy,
       scope_mode, scope_value, guidance, ok, result_json, metrics_json, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.startedAt,
    input.completedAt,
    input.stashDir,
    input.dryRun ? 1 : 0,
    input.strategy,
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
  strategy: string | null;
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
  const rows = queryRunsIn(db, since, until);
  if (stateHoldsWindow(db, since)) return rows;
  // The window starts before state.db's oldest run: the rest is in metrics.db (a run is in both only until its
  // day passes the retention, so a run seen in state.db is not read twice).
  const known = new Set(rows.map((row) => row.id));
  const older = (withMetricsHistory(db, undefined, (metrics) => queryRunsIn(metrics, since, until)) ?? []).filter(
    (row) => !known.has(row.id),
  );
  return older.length === 0 ? rows : [...rows, ...older].sort((a, b) => b.started_at.localeCompare(a.started_at));
}

function queryRunsIn(db: Database, since: string, until?: string): ImproveRunSummaryRow[] {
  const sql = until
    ? "SELECT id, started_at, completed_at, ok, scope_mode, scope_value, strategy, result_json FROM improve_runs WHERE started_at >= ? AND started_at < ? AND dry_run = 0 ORDER BY started_at DESC"
    : "SELECT id, started_at, completed_at, ok, scope_mode, scope_value, strategy, result_json FROM improve_runs WHERE started_at >= ? AND dry_run = 0 ORDER BY started_at DESC";
  return (until ? db.prepare(sql).all(since, until) : db.prepare(sql).all(since)) as ImproveRunSummaryRow[];
}

/** True when `since` is not earlier than state.db's oldest run, so no run of the window can be missing from it. */
function stateHoldsWindow(db: Database, since: string): boolean {
  const row = db.prepare("SELECT MIN(started_at) AS oldest FROM improve_runs").get() as
    | { oldest: string | null }
    | undefined;
  return row?.oldest != null && since >= row.oldest;
}

const IMPROVE_RUN_ROW_COLUMNS =
  "id, started_at, completed_at, stash_dir, dry_run, strategy, scope_mode, scope_value, guidance, ok, result_json, metrics_json, metadata_json";

/**
 * Look up a single `improve_runs` row by its id (#944 — `akm improve report --run <id>`).
 * `id` is the PRIMARY KEY, so at most one row matches. Returns `undefined`
 * for an unknown id rather than throwing — the caller decides how to report
 * "no such run".
 */
export function getImproveRunById(db: Database, id: string): ImproveRunRow | undefined {
  const find = (handle: Database) =>
    handle.prepare(`SELECT ${IMPROVE_RUN_ROW_COLUMNS} FROM improve_runs WHERE id = ?`).get(id) as
      | ImproveRunRow
      | undefined;
  return find(db) ?? withMetricsHistory(db, undefined, find);
}

/**
 * Look up the most recent real (non-dry-run) `improve_runs` row (#944 —
 * `akm improve report`'s default target, and `--last`). Same `dry_run = 0`
 * filter as {@link queryImproveRuns} so a dry-run preview never becomes the
 * implicit "last run" a report reads.
 */
export function getLatestImproveRun(db: Database): ImproveRunRow | undefined {
  const latest = (handle: Database) =>
    handle
      .prepare(`SELECT ${IMPROVE_RUN_ROW_COLUMNS} FROM improve_runs WHERE dry_run = 0 ORDER BY started_at DESC LIMIT 1`)
      .get() as ImproveRunRow | undefined;
  return latest(db) ?? withMetricsHistory(db, undefined, latest);
}

/** The `limit` most recent real (non-dry-run) improve runs, newest first (the workspace's run list). */
export function listRecentImproveRuns(db: Database, limit: number): ImproveRunSummaryRow[] {
  const recent = (handle: Database, count: number) =>
    handle
      .prepare(
        "SELECT id, started_at, completed_at, ok, scope_mode, scope_value, strategy, result_json FROM improve_runs WHERE dry_run = 0 ORDER BY started_at DESC LIMIT ?",
      )
      .all(count) as ImproveRunSummaryRow[];
  const rows = recent(db, limit);
  if (rows.length >= limit) return rows;
  // Fewer runs than asked in state.db: the older ones are in metrics.db.
  const known = new Set(rows.map((row) => row.id));
  const older = (withMetricsHistory(db, undefined, (metrics) => recent(metrics, limit)) ?? []).filter(
    (row) => !known.has(row.id),
  );
  return [...rows, ...older].slice(0, limit);
}
