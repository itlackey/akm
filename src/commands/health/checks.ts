// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AkmConfig } from "../../core/config/config";
import { EXTRACT_INFRASTRUCTURE_SKIP_REASONS } from "../../core/improve-types";
import { listPendingStateMigrations, type StateDatabaseMigrationReport } from "../../core/state-db";
import { learningStatus } from "../../setup/learning";
import type { ExtractOutcomeCount } from "../../storage/repositories/extract-sessions-repository";
import {
  STATE_DB_FREELIST_WARN_RATIO,
  type StateDbFreelistInfo,
  type StateDbIntegrityResult,
} from "../../storage/state-db-integrity";
import { resolveImproveStrategy, resolveProcessEnabled } from "../improve/improve-strategies";
import { resolveProposalQueueTarget } from "../proposal/repository";
import type { ImproveRunOutcomes, TaskRunCounts } from "./improve-metrics";
import { type SemanticSearchState, semanticSearchCheck } from "./semantic-search-check";
import { type HealthCheckResult, type ImproveHealthMetrics, TASK_FAIL_RATE_WARN } from "./types";

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
  /** The window's runs by what started them, and how many tasks they belong to. */
  taskRuns: TaskRunCounts;
  /** Fraction of task_history rows in the window whose status is `failed` (0..1, raw). */
  taskFailRate: number;
  /** Active runs whose owner process is gone (`classifyAttempt`). */
  stuckActiveRuns: number;
  /** One entry per task with such a run: which task and how long ago it started. */
  stuckActiveTasks: { taskId: string; ageMs: number }[];
  /** Tasks with an active run whose owner cannot be told apart from a live one (another host, no liveness evidence). */
  unverifiedActiveTasks: { taskId: string; ageMs: number }[];
  /**
   * The task_id with the highest per-task fail rate among tasks with at least
   * `MIN_ROWS_FOR_WORST_TASK_FAIL_RATE` rows in the window. `null` when no
   * task_id meets the row-count floor.
   */
  worstTaskFailRate: { taskId: string; rate: number; rows: number } | null;
  /**
   * #943: `detail.reason` breakdown across the window's agent dispatch
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
  /** #1289: whether the primary stash's proposal queue has a writable owner, resolved once (`proposalQueueState`). */
  proposalQueue: ProposalQueueState | undefined;
  autoAccept: ImproveHealthMetrics["autoAccept"];
  /** Recorded failures and signal interruptions in the selected window, scheduled or manual. */
  improveOutcomes: ImproveRunOutcomes;
  /** The `index-sources` check, collected once (`index-sources.ts`). */
  indexSources: HealthCheckResult;
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

/** Who owns the primary stash's proposal queue, and whether the active strategy extracts. */
export interface ProposalQueueState {
  stashDir: string;
  /** Background learning is on (`improve.enabled`). */
  learningOn: boolean;
  /** The configured improve strategy's name, as the resolver reports it; absent when it did not resolve. */
  strategy?: string;
  /** The resolver's refusal of the configured strategy (a removed or unknown one); absent when it resolved. */
  strategyError?: string;
  /** The configured improve strategy enables the extract process. */
  extractEnabled: boolean;
  /** The resolver's refusal; absent when the queue has a writable owner. */
  problem?: string;
}

/**
 * Resolve the proposal queue owner through the resolver extract and every other
 * proposal writer use. A strategy that does not resolve carries the resolver's error: extraction is then not known to
 * be on or off.
 */
export function proposalQueueState(config: AkmConfig, stashDir: string): ProposalQueueState {
  let extractEnabled = false;
  let strategy: { strategy: string } | { strategyError: string };
  try {
    const selected = resolveImproveStrategy(undefined, config);
    extractEnabled = resolveProcessEnabled("extract", selected.config);
    strategy = { strategy: selected.name };
  } catch (error) {
    strategy = { strategyError: error instanceof Error ? error.message : String(error) };
  }
  const base = { stashDir, learningOn: learningStatus(config).on, ...strategy, extractEnabled };
  try {
    resolveProposalQueueTarget(stashDir, config);
    return base;
  } catch (error) {
    return { ...base, problem: error instanceof Error ? error.message : String(error) };
  }
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
 * when one reason accounts for at least half of the window's agent dispatch
 * failures — e.g. "(timeout-dominant: 9/12 agent dispatch failures)" — so an
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

/** "132 runs of 8 tasks (120 scheduled, 12 manual)": what `task-fail-rate` counted, by what started each run. */
function describeTaskRuns(counts: TaskRunCounts): string {
  const noun = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const byTrigger = [
    counts.scheduled > 0 ? `${counts.scheduled} scheduled` : "",
    counts.manual > 0 ? `${counts.manual} manual` : "",
    counts.unrecorded > 0 ? `${counts.unrecorded} with no recorded trigger` : "",
    counts.unreadable > 0 ? `${counts.unreadable} unreadable` : "",
  ].filter(Boolean);
  return `${noun(counts.runs, "run")} of ${noun(counts.tasks, "task")}${byTrigger.length > 0 ? ` (${byTrigger.join(", ")})` : ""}`;
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
      // A skipped probe proved nothing: it is unknown, not a pass.
      ...(ctx.probe.skipped
        ? ({ status: "unknown", reason: "not-probed" } as const)
        : { status: ctx.probe.ok ? ("pass" as const) : ("fail" as const) }),
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
    // Whether an active run's akm is still there is `classifyAttempt`'s answer (owner pid, host, boot), never the
    // run's age: a long run is not a stuck one.
    name: "active-runs",
    channel: "hard",
    run: (ctx) => {
      const name = (tasks: { taskId: string; ageMs: number }[]) =>
        [...tasks]
          .sort((a, b) => b.ageMs - a.ageMs)
          .map((t) => `${t.taskId} (started ${Math.round(t.ageMs / 60000)}m ago)`)
          .join(", ");
      const base = { name: "active-runs", kind: "deterministic", confidence: "high" } as const;
      const evidence = {
        stuckActiveRuns: ctx.stuckActiveRuns,
        stuckActiveTasks: ctx.stuckActiveTasks,
        unverifiedActiveTasks: ctx.unverifiedActiveTasks,
      };
      if (ctx.stuckActiveRuns > 0) {
        const unverified =
          ctx.unverifiedActiveTasks.length > 0
            ? ` Cannot tell whether ${name(ctx.unverifiedActiveTasks)} are still running.`
            : "";
        return {
          ...base,
          status: "warn",
          message: `${ctx.stuckActiveRuns} active task run(s) whose akm process is gone: ${name(ctx.stuckActiveTasks)}.${unverified}`,
          evidence,
        };
      }
      if (ctx.unverifiedActiveTasks.length > 0) {
        return {
          ...base,
          status: "unknown",
          reason: "blocked",
          message: `Cannot tell whether ${name(ctx.unverifiedActiveTasks)} are still running: the owner is on another host or recorded no liveness evidence.`,
          evidence,
        };
      }
      return {
        ...base,
        status: "pass",
        message: "Every active task run has a live owner, or there are none.",
        evidence,
      };
    },
  },
  {
    name: "connections-and-harnesses",
    channel: "hard",
    run: (ctx) => ctx.connectionsAndHarnesses,
  },
  {
    name: "improve-failures",
    channel: "advisory",
    run: (ctx) => {
      const { failedRunIds, interruptedRunIds } = ctx.improveOutcomes;
      const interruption =
        interruptedRunIds.length > 0
          ? `${interruptedRunIds.length} improve run(s) were interrupted by a signal; cancellation versus failure is unknown.`
          : "";
      return {
        name: "improve-failures",
        kind: "deterministic",
        ...(failedRunIds.length > 0
          ? { status: "warn" as const }
          : interruptedRunIds.length > 0
            ? ({ status: "unknown", reason: "blocked" } as const)
            : { status: "pass" as const }),
        confidence: "high",
        message:
          failedRunIds.length > 0 || interruptedRunIds.length > 0
            ? `${failedRunIds.length} improve run(s) recorded failures since ${ctx.since}.${interruption ? ` ${interruption}` : ""} Inspect \`akm doctor --since ${ctx.since} --group-by run\`.`
            : "No improve runs recorded failures or signal interruptions in this window.",
        evidence: {
          failedRuns: failedRunIds.length,
          runIds: failedRunIds,
          interruptedRuns: interruptedRunIds.length,
          interruptedRunIds,
        },
      };
    },
  },
  {
    name: "index-sources",
    channel: "hard",
    run: (ctx) => ctx.indexSources,
  },
  {
    name: "semantic-search",
    channel: "hard",
    run: (ctx) => semanticSearchCheck(ctx.semanticSearch),
  },
  {
    // C2 (13-bus-factor): the cron task-failure rate was computed but never
    // surfaced as an advisory, so a sustained 15–16% fail rate stayed
    // invisible on `akm health`. Warn at/above TASK_FAIL_RATE_WARN (5%).
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

      // #943: name the dominant agent dispatch failure reason (timeout,
      // non_zero_exit, spawn_failed, …) when the check is already warning, so
      // "timeout-dominant" is visible without grepping task logs.
      const agentFailureReasonCounts = ctx.agentFailureReasonCounts ?? {};
      const dominant = warn ? dominantAgentFailureReason(agentFailureReasonCounts) : undefined;
      const dominantSuffix = dominant
        ? ` (${dominant.reason}-dominant: ${dominant.count}/${dominant.total} agent dispatch failures)`
        : "";

      const counted = describeTaskRuns(ctx.taskRuns);
      let message: string;
      if (ctx.taskRowCount === 0) {
        message = `No task runs since ${ctx.since} — no task-fail-rate signal.`;
      } else if (warn) {
        const parts: string[] = [];
        if (aggregateWarn) {
          parts.push(`aggregate ${pctStr} across ${counted} since ${ctx.since} ≥ ${thresholdPct}`);
        }
        if (worstWarn && worst) {
          const worstPctStr = `${(worst.rate * 100).toFixed(1)}%`;
          parts.push(`task "${worst.taskId}" fails ${worstPctStr} of its ${worst.rows} run(s) ≥ ${thresholdPct}`);
        }
        message = `Task fail rate warning: ${parts.join("; ")}${dominantSuffix} — inspect failed runs (ok=false) for early-exit/harness errors.`;
      } else {
        message = `Task fail rate ${pctStr} across ${counted} since ${ctx.since} (below ${thresholdPct} threshold).`;
      }

      return {
        name: "task-fail-rate",
        kind: "deterministic",
        // No run in the window is no signal, not a pass.
        ...(ctx.taskRowCount === 0
          ? ({ status: "unknown", reason: "idle" } as const)
          : { status: warn ? ("warn" as const) : ("pass" as const) }),
        confidence: "high",
        message,
        evidence: {
          taskFailRate: ctx.taskFailRate,
          taskRowCount: ctx.taskRowCount,
          taskRuns: ctx.taskRuns,
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
        // Extraction is off when the strategy does not enable it; with the config unreadable that is not known.
        const reason =
          !ctx.proposalQueue || ctx.proposalQueue.strategyError
            ? "blocked"
            : ctx.proposalQueue.extractEnabled
              ? "idle"
              : "off";
        return { ...base, status: "unknown", reason, message: `No extraction recorded in the last ${days} days.` };
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

      // #1290: some sessions harvested while others had candidate writes fail. A failed write that is not a validator
      // refusal keeps the session's hash null, so it is retried; a row stops counting once the session is extracted
      // again, and a refusal (hash recorded) is no infrastructure failure. A session that queued some candidates and
      // failed to write others is recorded as `candidates_queued`.
      const unresolvedWrites = rows
        .filter((row) => row.retryable && ["proposal_write_failed", "candidates_queued"].includes(row.outcome))
        .reduce((sum, row) => sum + row.count, 0);
      if (unresolvedWrites > 0) {
        return {
          ...base,
          evidence: { ...base.evidence, unresolvedWriteFailures: unresolvedWrites },
          status: "warn",
          message: `${unresolvedWrites} of ${totalRows} sessions in the last ${days} days had candidate writes fail (proposal_write_failed) and are not yet extracted again.`,
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
    // #1289: the same resolver extract calls before it spends model work. Only for learning that is on: the
    // strategy enables extract, or the ledger shows extraction ran (a hook-driven machine has no strategy).
    name: "proposal-queue",
    channel: "advisory",
    run: (ctx) => {
      const base = { name: "proposal-queue", kind: "deterministic", confidence: "high" } as const;
      if (!ctx.proposalQueue) {
        return {
          ...base,
          status: "unknown",
          reason: "blocked",
          message: "The primary stash or config could not be read; the proposal queue owner was not checked.",
        };
      }
      const { stashDir, learningOn, strategy, strategyError, extractEnabled, problem } = ctx.proposalQueue;
      const ranRecently = ctx.sessionExtractionLedger.rows.some((row) => row.count > 0);
      if (!learningOn) {
        return {
          ...base,
          status: "unknown",
          reason: "off",
          message: "Learning is off, so the proposal queue owner was not checked.",
        };
      }
      if (strategyError && !ranRecently) {
        return {
          ...base,
          status: "unknown",
          reason: "blocked",
          message: `The configured improve strategy does not resolve, so the proposal queue owner was not checked: ${strategyError}`,
        };
      }
      if (!extractEnabled && !ranRecently) {
        return {
          ...base,
          status: "unknown",
          reason: "off",
          message: `Session extraction is not enabled in improve strategy "${strategy}", so the proposal queue owner was not checked.`,
        };
      }
      if (!problem)
        return { ...base, status: "pass", message: `The proposal queue of ${stashDir} has a writable owner.` };
      return {
        ...base,
        status: "warn",
        message: `Extraction cannot queue proposals: ${problem} Register ${stashDir} as a writable bundle (\`akm bundle add\`), or mark its owner writable.`,
        evidence: { stashDir, problem },
      };
    },
  },
  {
    name: "auto-accept-validation",
    channel: "advisory",
    run: (ctx) => {
      const aa = ctx.autoAccept;
      const base = {
        name: "auto-accept-validation",
        kind: "heuristic",
        evidence: { promoted: aa.promoted, validationFailed: aa.validationFailed },
      } as const;
      if (aa.validationFailed > 0) {
        return {
          ...base,
          status: "warn",
          confidence: "high",
          message: `${aa.validationFailed} auto-accept validation attempt(s) failed after passing the confidence threshold (truncated description, invalid frontmatter, etc.) — the affected proposals remain pending for manual review.`,
        };
      }
      if (aa.promoted > 0) {
        return {
          ...base,
          status: "pass",
          confidence: "high",
          message: `Auto-accept healthy: ${aa.promoted} proposal(s) promoted, 0 validation failures.`,
        };
      }
      return {
        ...base,
        status: "unknown",
        reason: "idle",
        confidence: "low",
        message:
          "Auto-accept did not promote or reject any proposal in this window (disabled, or none above the threshold).",
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
