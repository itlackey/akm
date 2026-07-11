// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Repository for the state.db `improve_runs` table (per-run audit ledger) and
 * the `improve_gate_thresholds` per-phase auto-tune store (migration 012).
 * Extracted verbatim from core/state-db.ts — queries and the pure
 * `computeImproveRunMetrics` aggregation unchanged, only relocated behind the
 * repository boundary. Re-exported by core/state-db.ts so existing importers
 * resolve.
 *
 * @module improve-runs-repository
 */

import type { AkmImproveResult } from "../../core/improve-types";
import { classifyImproveAction } from "../../core/improve-types";
import type { Database } from "../database";

// ── Per-phase gate threshold store (Migration 012) ───────────────────────────

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
  /** Action modes that imply a write (reflect/distill/memory-inference/graph-extraction succeeded). */
  acceptedCount: number;
  /** Genuine value-rejections: a change was produced then rejected by a content guard. */
  rejectedCount: number;
  /** Gated skips (cooldown / signal-delta skip / distill pool-delta skip) — NOT rejections. */
  skippedCount: number;
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
  let skippedCount = 0;
  let autoAcceptedCount = 0;
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
    // Legacy: pre-gate action results may carry autoAccepted: true (reflect path).
    const r = action.result as Record<string, unknown> | undefined;
    if (r && r.autoAccepted === true) autoAcceptedCount++;
  }

  // Add gate-promoted count from the unified PostPhaseAutoAcceptGate (all phases).
  autoAcceptedCount += result.gateAutoAcceptedCount ?? 0;

  // C1 (13-bus-factor): distill-skipped rows are folded into the bounded
  // `distillSkipped` aggregate and no longer live in `actions`. Add the
  // aggregate total to the skipped + total-actions counters so metrics_json
  // reports the same numbers as before the fold. (Legacy rows that still carry
  // per-ref distill-skipped in `actions` have no aggregate, so they are counted
  // by the classify loop above — never double-counted.)
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
    /** Historical selector. New 0.9 writers must use strategy instead. */
    profile?: string | null;
    strategy?: string | null;
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
       (id, started_at, completed_at, stash_dir, dry_run, profile, strategy,
       scope_mode, scope_value, guidance, ok, result_json, metrics_json, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.startedAt,
    input.completedAt,
    input.stashDir,
    input.dryRun ? 1 : 0,
    input.strategy === undefined ? (input.profile ?? null) : null,
    input.strategy ?? null,
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
