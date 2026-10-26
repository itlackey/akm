// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { EXTRACT_INFRASTRUCTURE_SKIP_REASONS } from "../../core/improve-types";
import { listPendingStateMigrations, type StateDatabaseMigrationReport } from "../../core/state-db";
import type { ExtractOutcomeCount } from "../../storage/repositories/extract-sessions-repository";
import {
  STATE_DB_FREELIST_WARN_RATIO,
  type StateDbFreelistInfo,
  type StateDbIntegrityResult,
} from "../../storage/state-db-integrity";
import { type SemanticSearchState, semanticSearchCheck } from "./semantic-search-check";
import { ACTIVE_RUN_WARN_MS, type HealthCheckResult, type ImproveHealthMetrics, TASK_FAIL_RATE_WARN } from "./types";

/**
 * Pre-computed inputs shared by the health-check registry. `akmHealth` runs the
 * (verbatim) probes/queries once, populates this context, then dispatches each
 * registered {@link HealthCheck} in declaration order. Keeping all probe state
 * here lets every check be a pure projection — no check re-runs IO — so the
 * emitted hardChecks/advisories arrays are byte-identical to the previous
 * inline implementation.
 */
export interface HealthCheckContext {
  stateDbPath: string;
  since: string;
  /** Sorted names of the state.db tables that exist among the required set. */
  tableNames: string[];
  /** Required tables absent from {@link tableNames}. */
  missingTables: string[];
  /** Result of the append/read round-trip probe. */
  probe: { ok: boolean; durationMs: number | null; error?: string; skipped?: boolean };
  /** R0: `PRAGMA integrity_check` result, read-only, computed once for `state-db-integrity`. */
  stateDbIntegrity: StateDbIntegrityResult;
  /** R0: freelist/page-count reading, computed once for `state-db-integrity`'s reclaimable-space report. */
  stateDbFreelist: StateDbFreelistInfo;
  /** What this run's own state.db open applied (every open applies pending migrations). */
  stateDbMigrations: StateDatabaseMigrationReport;
  /** Total task_history rows read in the window. */
  taskRowCount: number;
  /** Fraction of task_history rows in the window whose status is `failed` (0..1, raw). */
  taskFailRate: number;
  /** Active runs older than the stale threshold. */
  stuckActiveRuns: number;
  /** One entry per {@link stuckActiveRuns} row: which task and how stale. */
  stuckActiveTasks: { taskId: string; ageMs: number }[];
  /**
   * The task_id with the highest per-task fail rate among tasks with at least
   * `MIN_ROWS_FOR_WORST_TASK_FAIL_RATE` rows in the window. `null` when no
   * task_id meets the row-count floor.
   */
  worstTaskFailRate: { taskId: string; rate: number; rows: number } | null;
  /**
   * #943: `detail.reason` breakdown across the window's command-task
   * failures (see `HealthMetrics.agentFailureReasonCounts`'s doc comment).
   * Always present in `task-fail-rate`'s evidence; drives the
   * "<reason>-dominant" message suffix when the check is warn/fail.
   */
  agentFailureReasonCounts: Record<string, number>;
  /**
   * #914: `extract_sessions_seen` outcome counts for the rolling 7-day
   * ledger window (independent of the top-level `--since`) — what lets
   * `session-extraction` tell "off on purpose" apart from "broken" on a
   * hook-driven (`akm proposal extract --session-id`) machine, which never
   * writes an `improve_runs` row at all.
   */
  sessionExtractionLedger: { since: string; rows: ExtractOutcomeCount[] };
  autoAccept: ImproveHealthMetrics["autoAccept"];
  /** The connections, harnesses and work table, collected once (`connections-and-harnesses-check.ts`). */
  connectionsAndHarnesses: HealthCheckResult;
  /** The last index run's semantic-search record and the index's counts, read once (`semantic-search-check.ts`). */
  semanticSearch: SemanticSearchState;
  /**
   * #950: the `cli-version` advisory, computed once in `health.ts` alongside
   * the endpoint-reachability probe (same `--probe`/`--no-probe` gate, same
   * best-effort network discipline) so the check registry stays a pure
   * projection — no check performs its own network IO; the probes precompute
   * into {@link connectionsAndHarnesses} and the advisories the same way.
   */
  versionDrift: HealthCheckResult;
  /**
   * #953: the `scheduler-binary` advisory, computed once in `health.ts`
   * (same `--probe`/`--no-probe` gate as `versionDrift`, same best-effort
   * discipline) so `scheduler-binary` stays a pure projection like every
   * other check.
   */
  schedulerBinaryDrift: HealthCheckResult;
}

/** Which array a check's result is collected into. */
export type HealthCheckChannel = "hard" | "advisory";

/**
 * A single health check: a named probe that projects pre-computed context into
 * one {@link HealthCheckResult}. The `channel` decides whether the result lands
 * in `hardChecks` (can gate overall status) or `advisories`.
 */
export interface HealthCheck {
  name: string;
  channel: HealthCheckChannel;
  run(ctx: HealthCheckContext): HealthCheckResult;
}

/** Rolling window the `session-extraction` check reads from the extract ledger (#914). */
export const SESSION_EXTRACTION_LEDGER_WINDOW_DAYS = 7;

export interface PendingStateMigrationsCheckDependencies {
  listPendingStateMigrations?: (dbPath?: string) => string[];
}

/**
 * `state-db-migrations` when the open itself failed: the migrations still
 * pending after a failed apply, from a read-only listing that never applies
 * anything. A `fail` row, not a crash, is what a bundler watches for instead
 * of grepping akm's error text.
 */
export function runPendingStateMigrationsCheck(
  stateDbPath: string,
  deps: PendingStateMigrationsCheckDependencies = {},
): HealthCheckResult {
  const pending = (deps.listPendingStateMigrations ?? listPendingStateMigrations)(stateDbPath);
  if (pending.length === 0) {
    return {
      name: "state-db-migrations",
      kind: "deterministic",
      status: "pass",
      confidence: "high",
      message: "state.db has no pending migrations.",
      evidence: { path: stateDbPath, pending: [] },
    };
  }
  const range = pending.length > 1 ? `${pending[0]} … ${pending[pending.length - 1]}` : pending[0];
  return {
    name: "state-db-migrations",
    kind: "deterministic",
    status: "fail",
    confidence: "high",
    message: `${pending.length} pending state.db migration(s) (${range}); run \`akm migrate apply\`.`,
    evidence: { path: stateDbPath, pending },
  };
}

/**
 * Hard check: state.db's ledger is current. Every open applies the pending
 * migrations (copying the file aside first when one drops schema), so after
 * health's own open nothing is pending; this names what that open applied, so
 * an upgrade that migrated state.db is visible in the report.
 */
export function appliedStateMigrationsCheck(
  stateDbPath: string,
  report: StateDatabaseMigrationReport,
): HealthCheckResult {
  const { applied, backupPath } = report;
  const range = applied.length > 1 ? `${applied[0]} … ${applied[applied.length - 1]}` : applied[0];
  return {
    name: "state-db-migrations",
    kind: "deterministic",
    status: "pass",
    confidence: "high",
    message:
      applied.length === 0
        ? "state.db has no pending migrations."
        : `Applied ${applied.length} pending state.db migration(s) on open (${range})` +
          (backupPath ? `; the pre-migration copy is ${backupPath}.` : "."),
    evidence: { path: stateDbPath, pending: [], applied, ...(backupPath ? { backupPath } : {}) },
  };
}

/**
 * #943: name the dominant `detail.reason` behind `task-fail-rate`'s warning
 * when one reason accounts for at least half of the window's command-task
 * failures — e.g. "(timeout-dominant: 9/12 command-task failures)" — so an
 * operator sees the shape of the failure from data instead of grepping task
 * logs. Ties break on reason name for determinism. `undefined` when there are
 * no counted failures or no single reason reaches the 50% floor.
 */
export function dominantAgentFailureReason(
  counts: Record<string, number>,
): { reason: string; count: number; total: number } | undefined {
  const entries = Object.entries(counts);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) return undefined;
  const [reason, count] = entries.reduce((best, entry) =>
    entry[1] > best[1] || (entry[1] === best[1] && entry[0] < best[0]) ? entry : best,
  );
  return count / total >= 0.5 ? { reason, count, total } : undefined;
}

/**
 * The ordered health-check registry. ORDER IS LOAD-BEARING: `akmHealth`
 * iterates this array and appends to hardChecks/advisories in sequence, so the
 * declaration order below is exactly the emission order (hard checks first in
 * their array, advisories in theirs). Each `run` is a verbatim copy of the
 * corresponding former inline block.
 */
export const HEALTH_CHECKS: readonly HealthCheck[] = [
  {
    name: "state-db-schema",
    channel: "hard",
    run: (ctx) => ({
      name: "state-db-schema",
      kind: "deterministic",
      status: ctx.missingTables.length === 0 ? "pass" : "fail",
      confidence: "high",
      message:
        ctx.missingTables.length === 0
          ? "state.db opened and required tables are present."
          : `state.db is missing required tables: ${ctx.missingTables.join(", ")}`,
      evidence: { path: ctx.stateDbPath, tables: ctx.tableNames },
    }),
  },
  {
    name: "state-db-round-trip",
    channel: "hard",
    run: (ctx) => ({
      name: "state-db-round-trip",
      kind: "deterministic",
      status: ctx.probe.ok ? "pass" : "fail",
      confidence: "high",
      message: ctx.probe.skipped
        ? "state.db append/read round-trip skipped: this run is read-only."
        : ctx.probe.ok
          ? "state.db append/read round-trip succeeded."
          : `state.db round-trip failed: ${ctx.probe.error}`,
      evidence: { path: ctx.stateDbPath, durationMs: ctx.probe.durationMs },
    }),
  },
  {
    // R0: nothing looked at state.db's own SQLite-level integrity before
    // this — the round-trip probe above only proves one row can be appended
    // and read back, which stays true on a database that fails
    // `PRAGMA integrity_check` elsewhere (corrupt indexes, out-of-order rowids).
    // Also reports the freelist ratio (fraction of pages VACUUM could
    // reclaim) so a bloated-but-uncorrupted file is visible as a warning
    // rather than silence.
    name: "state-db-integrity",
    channel: "hard",
    run: (ctx) => {
      const { ok, lines, error } = ctx.stateDbIntegrity;
      const { ratio: freelistRatio, error: freelistError } = ctx.stateDbFreelist;
      if (!ok) {
        const detail = error ?? lines.join("; ");
        return {
          name: "state-db-integrity",
          kind: "deterministic",
          status: "fail",
          confidence: "high",
          message:
            `state.db failed PRAGMA integrity_check: ${detail}. Repair: back up state.db, then run ` +
            `sqlite3 -readonly state.db ".recover" | sqlite3 state.new.db, verify state.new.db passes integrity_check, stop ` +
            "every akm process, then delete state.db-wal and state.db-shm before swapping state.new.db in as " +
            "state.db — a leftover WAL from the OLD database is replayed onto the new one and corrupts it.",
          evidence: { path: ctx.stateDbPath, lines, freelistRatio },
        };
      }
      if (freelistError) {
        return {
          name: "state-db-integrity",
          kind: "deterministic",
          status: "fail",
          confidence: "high",
          message: `state.db passed PRAGMA integrity_check, but reading its freelist/page-count failed: ${freelistError}.`,
          evidence: { path: ctx.stateDbPath, lines, freelistError },
        };
      }
      const freelistWarn = freelistRatio > STATE_DB_FREELIST_WARN_RATIO;
      return {
        name: "state-db-integrity",
        kind: "deterministic",
        status: freelistWarn ? "warn" : "pass",
        confidence: "high",
        message: freelistWarn
          ? `state.db passed PRAGMA integrity_check, but ${(freelistRatio * 100).toFixed(1)}% of its pages are free (reclaimable by VACUUM).`
          : "state.db passed PRAGMA integrity_check.",
        evidence: {
          path: ctx.stateDbPath,
          freelistCount: ctx.stateDbFreelist.freelistCount,
          pageCount: ctx.stateDbFreelist.pageCount,
          freelistRatio,
        },
      };
    },
  },
  {
    name: "state-db-migrations",
    channel: "hard",
    run: (ctx) => appliedStateMigrationsCheck(ctx.stateDbPath, ctx.stateDbMigrations),
  },
  {
    name: "task-history-read",
    channel: "hard",
    run: (ctx) => ({
      name: "task-history-read",
      kind: "deterministic",
      status: "pass",
      confidence: "high",
      message: `Read ${ctx.taskRowCount} task-history row(s) since ${ctx.since}.`,
      evidence: { rows: ctx.taskRowCount, since: ctx.since },
    }),
  },
  {
    name: "active-runs",
    channel: "hard",
    run: (ctx) => {
      // Name the stuck task_ids (deduped, oldest first) so an operator knows
      // WHICH tasks to investigate, not just how many rows are stale. No
      // pid/liveness detection — that's out of scope here.
      const named = [...ctx.stuckActiveTasks].sort((a, b) => b.ageMs - a.ageMs);
      const detail = named.map((t) => `${t.taskId} (${Math.round(t.ageMs / 60000)}m)`).join(", ");
      return {
        name: "active-runs",
        kind: "deterministic",
        status: ctx.stuckActiveRuns === 0 ? "pass" : "warn",
        confidence: "high",
        message:
          ctx.stuckActiveRuns === 0
            ? "No active task runs exceeded the stale threshold."
            : `${ctx.stuckActiveRuns} active task run(s) are older than ${Math.round(ACTIVE_RUN_WARN_MS / 60000)} minutes: ${detail}.`,
        evidence: { stuckActiveRuns: ctx.stuckActiveRuns, stuckActiveTasks: ctx.stuckActiveTasks },
      };
    },
  },
  {
    name: "connections-and-harnesses",
    channel: "hard",
    run: (ctx) => ctx.connectionsAndHarnesses,
  },
  {
    name: "semantic-search",
    channel: "hard",
    run: (ctx) => semanticSearchCheck(ctx.semanticSearch),
  },
  {
    // C2 (13-bus-factor): the cron task-failure rate was computed and rendered
    // in the HTML report but never surfaced as an advisory, so a sustained
    // 15–16% fail rate stayed invisible on `akm health`. Warn at/above the SAME
    // 5% threshold the html-report badge uses (see TASK_FAIL_RATE_WARN).
    //
    // Item 6: the aggregate can hide a single consistently-failing task inside
    // a large, mostly-healthy population (e.g. 1 flaky task at 100 rows total
    // reads as <5% aggregate). Also warn when the single worst task_id (with
    // enough rows to be a real signal — see MIN_ROWS_FOR_WORST_TASK_FAIL_RATE)
    // crosses the same threshold, naming it explicitly.
    name: "task-fail-rate",
    channel: "advisory",
    run: (ctx) => {
      const pctStr = `${(ctx.taskFailRate * 100).toFixed(1)}%`;
      const thresholdPct = `${(TASK_FAIL_RATE_WARN * 100).toFixed(0)}%`;
      const aggregateWarn = ctx.taskFailRate >= TASK_FAIL_RATE_WARN;
      const worst = ctx.worstTaskFailRate;
      const worstWarn = worst !== null && worst.rate >= TASK_FAIL_RATE_WARN;
      const warn = aggregateWarn || worstWarn;

      // #943: name the dominant command-task failure reason (timeout,
      // non_zero_exit, spawn_failed, …) when the check is already warning, so
      // "timeout-dominant" is visible without grepping task logs.
      const agentFailureReasonCounts = ctx.agentFailureReasonCounts ?? {};
      const dominant = warn ? dominantAgentFailureReason(agentFailureReasonCounts) : undefined;
      const dominantSuffix = dominant
        ? ` (${dominant.reason}-dominant: ${dominant.count}/${dominant.total} command-task failures)`
        : "";

      let message: string;
      if (ctx.taskRowCount === 0) {
        message = `No cron tasks ran since ${ctx.since} — no task-fail-rate signal.`;
      } else if (warn) {
        const parts: string[] = [];
        if (aggregateWarn) {
          parts.push(`aggregate ${pctStr} across ${ctx.taskRowCount} task(s) since ${ctx.since} ≥ ${thresholdPct}`);
        }
        if (worstWarn && worst) {
          const worstPctStr = `${(worst.rate * 100).toFixed(1)}%`;
          parts.push(`task "${worst.taskId}" fails ${worstPctStr} of its ${worst.rows} run(s) ≥ ${thresholdPct}`);
        }
        message = `Cron task fail rate warning: ${parts.join("; ")}${dominantSuffix} — inspect failed runs (ok=false) for early-exit/harness errors.`;
      } else {
        message = `Cron task fail rate ${pctStr} across ${ctx.taskRowCount} task(s) since ${ctx.since} (below ${thresholdPct} threshold).`;
      }

      return {
        name: "task-fail-rate",
        kind: "deterministic",
        status: warn ? "warn" : "pass",
        confidence: "high",
        message,
        evidence: {
          taskFailRate: ctx.taskFailRate,
          taskRowCount: ctx.taskRowCount,
          threshold: TASK_FAIL_RATE_WARN,
          worstTaskFailRate: worst,
          // #943: always present (even pass/empty) so scripts reading evidence
          // never need to branch on check status to find the breakdown.
          agentFailureReasonCounts,
        },
      };
    },
  },
  {
    // #914: derived from the `extract_sessions_seen` LEDGER, not
    // `improve_runs.result_json` — the hook-driven `akm proposal extract
    // --session-id ...` (the standard Claude Code plugin setup) never writes
    // an `improve_runs` row, so the old improve_runs-only source reported
    // "not active" as `pass` unconditionally on a plugin-driven machine, no
    // matter how healthy or broken extraction actually was.
    name: "session-extraction",
    channel: "advisory",
    run: (ctx) => {
      const { since: ledgerSince, rows } = ctx.sessionExtractionLedger;
      const days = SESSION_EXTRACTION_LEDGER_WINDOW_DAYS;
      const base: Pick<HealthCheckResult, "name" | "kind" | "confidence" | "evidence"> = {
        name: "session-extraction",
        kind: "heuristic",
        confidence: "medium",
        evidence: { ledgerSince, ledgerRows: rows },
      };
      const totalRows = rows.reduce((sum, row) => sum + row.count, 0);
      if (totalRows === 0) {
        return { ...base, status: "unknown", message: `No extraction recorded in the last ${days} days.` };
      }

      // `read_failed` / `exception` land in the ledger as `failed`, not `skipped`.
      const nothingHarvested = rows.every((row) =>
        ["skipped", "failed", "proposal_write_failed"].includes(row.outcome),
      );
      const reasonFor = (row: (typeof rows)[number]) =>
        row.outcome === "proposal_write_failed" ? row.outcome : row.skipReason;
      const knownSkipReasons = [...new Set(rows.map(reasonFor).filter((reason) => reason !== null))].sort();
      const allKnownReasonsAreInfra = knownSkipReasons.every(
        (reason) =>
          reason === "proposal_write_failed" ||
          (EXTRACT_INFRASTRUCTURE_SKIP_REASONS as readonly string[]).includes(reason),
      );
      if (nothingHarvested && allKnownReasonsAreInfra) {
        const reasonClauses = knownSkipReasons.map((reason) => {
          const engines = [
            ...new Set(rows.flatMap((row) => (reasonFor(row) === reason && row.engine ? [row.engine] : []))),
          ].sort();
          return engines.length > 0 ? `${reason} (engine ${engines.map((e) => `"${e}"`).join(", ")})` : reason;
        });
        if (rows.some((row) => reasonFor(row) === null)) reasonClauses.push("unknown reason");
        const verb = rows.some((row) => row.outcome === "failed" || row.outcome === "proposal_write_failed")
          ? "skipped or failed"
          : "skipped";
        return {
          ...base,
          status: "warn",
          message: `${totalRows} of ${totalRows} sessions in the last ${days} days ${verb}: ${reasonClauses.join(", ")}.`,
        };
      }

      const outcomeCounts = new Map<string, number>();
      for (const row of rows) outcomeCounts.set(row.outcome, (outcomeCounts.get(row.outcome) ?? 0) + row.count);
      const outcomeSummary = [...outcomeCounts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([outcome, count]) => `${outcome}: ${count}`)
        .join(", ");
      return {
        ...base,
        status: "pass",
        message: `Session extraction active in the last ${days} days (${outcomeSummary}).`,
      };
    },
  },
  {
    name: "auto-accept-validation",
    channel: "advisory",
    run: (ctx) => {
      const aa = ctx.autoAccept;
      return {
        name: "auto-accept-validation",
        kind: "heuristic",
        status: aa.validationFailed > 0 ? "warn" : "pass",
        confidence: aa.promoted + aa.validationFailed > 0 ? "high" : "low",
        message:
          aa.validationFailed > 0
            ? `${aa.validationFailed} auto-accept validation attempt(s) failed after passing the confidence threshold (truncated description, invalid frontmatter, etc.) — the affected proposals remain pending for manual review.`
            : aa.promoted > 0
              ? `Auto-accept healthy: ${aa.promoted} proposal(s) promoted, 0 validation failures.`
              : "Auto-accept gate did not run (disabled or no proposals above threshold).",
        evidence: { promoted: aa.promoted, validationFailed: aa.validationFailed },
      };
    },
  },
  {
    // #950: best-effort "installed vs latest release" advisory, gated behind
    // the same --probe/--no-probe flag as endpoint reachability. Computed once
    // in health.ts (network IO), projected here like connectionsAndHarnesses.
    name: "cli-version",
    channel: "advisory",
    run: (ctx) => ctx.versionDrift,
  },
  {
    // #953: registered last — order is load-bearing (see the HEALTH_CHECKS
    // doc comment above). Best-effort scheduler-binary-drift advisory, gated
    // behind the same --probe/--no-probe flag as endpoint reachability and
    // cli-version. Computed once in health.ts (process-spawn IO), projected
    // here like versionDrift/connectionsAndHarnesses.
    name: "scheduler-binary",
    channel: "advisory",
    run: (ctx) => ctx.schedulerBinaryDrift,
  },
];
