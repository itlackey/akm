// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { daysToMs, resolveStashDir } from "../core/common";
import { loadConfig } from "../core/config/config";
import { ConfigError, UsageError } from "../core/errors";
import { readEvents } from "../core/events";
import { openLogsDatabase } from "../core/logs-db";
import { classifyPathAccess, describeInaccessiblePath } from "../core/path-access";
import { getConfigPath, getDataDir, getDbPath, getStateDbPathInDataDir } from "../core/paths";
import { listExistingTableNames, listPendingStateMigrations, openStateDatabase } from "../core/state-db";
import { DURATION_UNITS, parseDuration, parseSinceToIso } from "../core/time";
import { probeLlmEndpoint } from "../llm/client";
import type { Database } from "../storage/database";
import { getExtractOutcomeCountsSince } from "../storage/repositories/extract-sessions-repository";
import { countImproveRunsSince } from "../storage/repositories/improve-runs-repository";
import { closeDatabase, openReadonlyExistingDatabase } from "../storage/repositories/index-connection";
import { getAllEntries } from "../storage/repositories/index-entries-repository";
import { queryTaskHistory } from "../storage/repositories/task-history-repository";
import { pkgVersion } from "../version";
import { collectImproveAdvisories } from "./health/advisories";
import {
  HEALTH_CHECKS,
  type HealthCheckContext,
  probeActiveImproveStrategy,
  runHealthEngineProbes,
  runPendingStateMigrationsCheck,
  SESSION_EXTRACTION_LEDGER_WINDOW_DAYS,
} from "./health/checks";
import { collectDataDirUsageAdvisory } from "./health/data-dir-usage";
import { engineLastUsedSince, readLastEngineUsage } from "./health/engine-usage";
import {
  buildImproveSkipSummary,
  computeWallTimeStats,
  countAgentFailureReasons,
  isAgentTaskHistoryRow,
  roundRate,
  summarizeImproveCompleted,
  summarizeImproveRuns,
  taskFailureDetail,
} from "./health/improve-metrics";
import { emptyLlmUsageAggregate, readLlmUsageAggregate } from "./health/llm-usage";
import {
  computeDegradationMetrics,
  computeDenominatorFixedCoverage,
  computeEnrichmentMintingRollup,
  probeStateDbRoundTrip,
} from "./health/metrics";
import { collectPluginStalenessAdvisories } from "./health/plugin-staleness";
import { collectSchedulerBinaryAdvisory } from "./health/scheduler-binary";
import { collectStashExposureAdvisory, type GitRunner } from "./health/stash-exposure";
import { collectSurfacesAdvisories, type EgressConfigView } from "./health/surfaces";
import { buildPerRunSummaries } from "./health/task-runs";
import { buildTypeDirectoryAdvisory } from "./health/type-directory-check";
import {
  ACTIVE_RUN_WARN_MS,
  type AkmHealthResult,
  type DeltaEntry,
  type HealthCheckResult,
  type HealthMetrics,
  IMPROVE_COMPLETED_EVENT,
  type ImproveHealthMetrics,
  type ImproveRunSummary,
  MIN_ROWS_FOR_WORST_TASK_FAIL_RATE,
  type WindowResult,
  type WindowSpec,
} from "./health/types";
import { collectVersionDriftAdvisory } from "./health/version-drift";
import { buildWindowMetrics, computeDeltas, partitionLogBackedRows, resolveWindowCompare } from "./health/windows";

export interface AkmHealthOptions {
  since?: string;
  /** Row grouping. `run` emits one row per improve_runs entry (was `--detail per-run`). */
  groupBy?: "run";
  windowCompare?: string;
  windows?: WindowSpec[];
  /**
   * Clock seam for the health read path. Defaults to `Date.now`. Tests may pin
   * this to a fixed epoch so staleness/window math is deterministic. Purely
   * additive — when omitted, behaviour is identical to calling `Date.now()`.
   */
  now?: () => number;
  /**
   * C2 (#499): explicit state.db path override. Defaults to
   * `getStateDbPathInDataDir()` (the `XDG_DATA_HOME`-derived path). Tests pass a
   * path from their isolated storage root so the entire health read is pinned to
   * one file and never re-reads `process.env` — immune to a parallel test file
   * mutating `XDG_DATA_HOME` across an await boundary and redirecting this read
   * to a foreign/just-deleted DB. Purely additive: omitted ⇒ identical to before.
   */
  stateDbPath?: string;
  /**
   * Explicit logs.db path override (#579). Defaults to `getLogsDbPath()`.
   * Same test-isolation rationale as {@link stateDbPath}.
   */
  logsDbPath?: string;
  /** Stash dir for the `stash-git-exposure` advisory. Defaults to `resolveStashDir()`. */
  stashDir?: string;
  /**
   * Injectable git seam for the `stash-git-exposure` advisory. When omitted, the
   * advisory only runs (via a real `git` subprocess) if the stash is actually a
   * git repo, so the health hot path — including unit tests with non-git sandbox
   * stashes — never spawns. Tests pass a fake to exercise the advisory directly.
   */
  stashExposureGit?: GitRunner;
  /**
   * Probe LLM engine reachability in the engine checks (#914). Off by default
   * so library callers and tests stay offline; the CLI turns it on unless
   * `--no-probe` is given.
   */
  probe?: boolean;
}

const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000;

export function parseHealthSince(since?: string): string {
  if (since === undefined || since.trim() === "") {
    return new Date(Date.now() - DEFAULT_SINCE_MS).toISOString();
  }
  const trimmed = since.trim();
  // Unit grammar is the CLI-wide canonical map: `m` = minutes, `M` = months.
  // (Historically `--since 5m` meant 5 months here; it now means 5 minutes,
  // with `5M` for months — unified with consolidate / `--window-compare`.)
  // Not lower-cased: case distinguishes `m` (minutes) from `M` (months).
  const durationMs = parseDuration(trimmed, DURATION_UNITS);
  if (durationMs !== null) {
    return new Date(Date.now() - durationMs).toISOString();
  }
  return parseSinceToIso(trimmed);
}

function validateAkmHealthOptions(options: AkmHealthOptions): void {
  if (options.groupBy !== undefined && options.groupBy !== "run") {
    throw new UsageError(`Invalid value for --group-by: ${options.groupBy}. Expected: run`, "INVALID_FLAG_VALUE");
  }
  if (options.windowCompare !== undefined && options.windows !== undefined && options.windows.length > 0) {
    throw new UsageError("--window-compare and --windows are mutually exclusive.", "INVALID_FLAG_VALUE");
  }
  if (options.windows) {
    if (options.windows.length > 4) {
      throw new UsageError("--windows accepts at most 4 entries.", "INVALID_FLAG_VALUE");
    }
    const seen = new Set<string>();
    for (const spec of options.windows) {
      if (seen.has(spec.name)) {
        throw new UsageError(`--windows has duplicate name: ${spec.name}`, "INVALID_FLAG_VALUE");
      }
      seen.add(spec.name);
    }
  }
}

// ── akmHealth phase helpers (chunk-9 WI-9.5b; file-level decompose following
// the function's natural gather/advise/check/assemble phases) ───────────────

interface TaskHistoryPhase {
  tableNames: string[];
  missingTables: string[];
  probe: ReturnType<typeof probeStateDbRoundTrip>;
  taskRowCount: number;
  taskRowsWithLogsCount: number;
  existingLogRowsCount: number;
  stuckActiveRuns: number;
  stuckActiveTasks: { taskId: string; ageMs: number }[];
  logBackingRate: number;
  taskFailRate: number;
  worstTaskFailRate: { taskId: string; rate: number; rows: number } | null;
  agentFailureRate: number;
  agentFailureReasonCounts: Record<string, number>;
}

/**
 * Item 7: dedupe stuck-active rows by task_id (keeping the oldest/largest age
 * per id) so the `active-runs` check can name WHICH tasks are stuck instead of
 * just a count. No pid/liveness probing — purely a projection of the rows
 * already read.
 */
function dedupeStuckActiveTasks(
  rows: { task_id: string; started_at: string }[],
  now: () => number,
): { taskId: string; ageMs: number }[] {
  const byTask = new Map<string, number>();
  for (const row of rows) {
    const ageMs = now() - new Date(row.started_at).getTime();
    const existing = byTask.get(row.task_id);
    if (existing === undefined || ageMs > existing) byTask.set(row.task_id, ageMs);
  }
  return [...byTask.entries()].map(([taskId, ageMs]) => ({ taskId, ageMs }));
}

/**
 * Item 6: group task_history rows by task_id and return the one with the
 * highest fail rate among tasks with at least MIN_ROWS_FOR_WORST_TASK_FAIL_RATE
 * rows in the window — surfaces a consistently-failing task that a large,
 * mostly-healthy population would otherwise hide behind the aggregate rate.
 * `null` when no task_id meets the row-count floor. Ties break toward the
 * task with more rows (a stronger signal), then by task_id for determinism.
 */
function computeWorstTaskFailRate(
  rows: { task_id: string; status: string }[],
): { taskId: string; rate: number; rows: number } | null {
  const byTask = new Map<string, { total: number; failed: number }>();
  for (const row of rows) {
    const entry = byTask.get(row.task_id) ?? { total: 0, failed: 0 };
    entry.total += 1;
    if (row.status === "failed") entry.failed += 1;
    byTask.set(row.task_id, entry);
  }
  let worst: { taskId: string; rate: number; rows: number } | null = null;
  for (const [taskId, { total, failed }] of byTask) {
    if (total < MIN_ROWS_FOR_WORST_TASK_FAIL_RATE) continue;
    const rate = failed / total;
    if (
      worst === null ||
      rate > worst.rate ||
      (rate === worst.rate && (total > worst.rows || (total === worst.rows && taskId < worst.taskId)))
    ) {
      worst = { taskId, rate, rows: total };
    }
  }
  return worst;
}

/** Table presence, the state.db round-trip probe, and task_history-derived rates. */
function gatherTaskHistoryPhase(
  db: Database,
  logsDb: Database | undefined,
  since: string,
  stateDbPath: string,
  now: () => number,
): TaskHistoryPhase {
  const tables = listExistingTableNames(db, ["events", "task_history", "proposals", "schema_migrations"]);
  const tableNames = tables.map((row) => row.name).sort();
  const requiredTables = ["events", "proposals", "schema_migrations", "task_history"];
  const missingTables = requiredTables.filter((name) => !tableNames.includes(name));

  const probe = probeStateDbRoundTrip(stateDbPath);

  const taskRows = queryTaskHistory(db, { since });
  const { withLogs: taskRowsWithLogs, backed: existingLogRows } = partitionLogBackedRows(taskRows, logsDb);
  const failedTaskRows = taskRows.filter((row) => row.status === "failed");
  const activeRows = taskRows.filter((row) => row.status === "active" && row.completed_at === null);
  const stuckActiveRows = activeRows.filter((row) => now() - new Date(row.started_at).getTime() > ACTIVE_RUN_WARN_MS);
  // D8 (spec §5.3): a marked "command" row or a legacy (unmarked) "prompt"
  // row is the agent/LLM arm; an unmarked "command" row is the legacy
  // native shell/script arm and must not be counted here (see
  // isAgentTaskHistoryRow's header comment for the full mapping).
  const agentRows = taskRows.filter((row) => isAgentTaskHistoryRow(row));
  const agentFailures = agentRows.filter((row) => {
    const detail = taskFailureDetail(row);
    return typeof detail?.reason === "string" && detail.reason.length > 0;
  });
  const logBackingRate = taskRowsWithLogs.length === 0 ? 1 : existingLogRows.length / taskRowsWithLogs.length;
  const taskFailRate = taskRows.length === 0 ? 0 : failedTaskRows.length / taskRows.length;
  const agentFailureRate = agentRows.length === 0 ? 0 : agentFailures.length / agentRows.length;

  return {
    tableNames,
    missingTables,
    probe,
    taskRowCount: taskRows.length,
    taskRowsWithLogsCount: taskRowsWithLogs.length,
    existingLogRowsCount: existingLogRows.length,
    stuckActiveRuns: stuckActiveRows.length,
    stuckActiveTasks: dedupeStuckActiveTasks(stuckActiveRows, now),
    logBackingRate,
    taskFailRate,
    worstTaskFailRate: computeWorstTaskFailRate(taskRows),
    agentFailureRate,
    agentFailureReasonCounts: countAgentFailureReasons(agentFailures),
  };
}

interface EgressConfigPhase {
  egressConfigView: EgressConfigView | undefined;
  /** #949: configured `kind: "llm"` engine names with `enableThinking: false`. */
  thinkingOffEngines: string[];
}

/**
 * Config fields the surfaces advisory and (#949) the `thinking-control`
 * check need. Best-effort: an unloadable config leaves both fields at their
 * empty fallback and the callers degrade to their generic/unknown states.
 */
function gatherEgressConfigPhase(): EgressConfigPhase {
  let egressConfigView: EgressConfigView | undefined;
  let thinkingOffEngines: string[] = [];
  try {
    const config = loadConfig();
    egressConfigView = config as EgressConfigView;
    thinkingOffEngines = Object.entries(config.engines ?? {})
      .filter(([, engine]) => engine.kind === "llm" && engine.enableThinking === false)
      .map(([name]) => name);
  } catch {
    // fall through with undefined/empty
  }
  return { egressConfigView, thinkingOffEngines };
}

interface ImproveSummaryPhase {
  improveSummary: ImproveHealthMetrics;
  perRunSummaries: ImproveRunSummary[];
}

/** Extract-ledger outcome counts for the `session-extraction` check's window, independent of `--since`. */
function gatherSessionExtractionLedgerPhase(
  db: Database,
  now: () => number,
): HealthCheckContext["sessionExtractionLedger"] {
  const since = new Date(now() - daysToMs(SESSION_EXTRACTION_LEDGER_WINDOW_DAYS)).toISOString();
  return { since, rows: getExtractOutcomeCountsSince(db, since) };
}

/**
 * Assemble the window's improve-pipeline summary: invoked/completed/skipped
 * counts from events, the per-run result_json aggregate, wall-time stats, and
 * the WS-5 coverage/degradation/enrichment-minting rollups.
 */
function gatherImproveSummaryPhase(
  db: Database,
  stateDbPath: string,
  since: string,
  now: () => number,
): ImproveSummaryPhase {
  const improveInvoked = readEvents({ since, type: "improve_invoked" }, { dbPath: stateDbPath }).events.length;
  const improveCompletedEvents = readEvents({ since, type: IMPROVE_COMPLETED_EVENT }, { dbPath: stateDbPath }).events;
  const improveSkippedEvents = readEvents({ since, type: "improve_skipped" }, { dbPath: stateDbPath }).events;
  const eventsMetrics = summarizeImproveCompleted(improveCompletedEvents);
  const { metrics: improveSummary } = summarizeImproveRuns(db, since);
  improveSummary.invoked = improveInvoked;
  improveSummary.completed = eventsMetrics.completed;
  const skipSummary = buildImproveSkipSummary(improveSkippedEvents);
  improveSummary.skipped = skipSummary.skipped;
  improveSummary.skipReasons = skipSummary.skipReasons;
  const perRunSummaries = buildPerRunSummaries(db, since);
  const wallTimes = perRunSummaries.map((run) => run.wallTimeMs).filter((ms) => Number.isFinite(ms) && ms > 0);
  improveSummary.wallTime = computeWallTimeStats(wallTimes, improveSummary.wallTime.byPhase);

  // WS-5: Compute denominator-fixed coverage and per-run degradation metrics
  // for the main health path (not just window-compare mode).
  const until = new Date(now()).toISOString();
  const totalAssetsMain = improveSummary.memorySummary.eligible + improveSummary.memorySummary.derived;
  improveSummary.coverage = computeDenominatorFixedCoverage(
    db,
    totalAssetsMain,
    improveSummary.memorySummary.eligible,
    since,
    until,
  );
  const degradationMain = computeDegradationMetrics(db, since, until);
  if (degradationMain) {
    improveSummary.degradation = degradationMain;
  }
  improveSummary.enrichmentMinting = computeEnrichmentMintingRollup(db, since, until);

  return { improveSummary, perRunSummaries };
}

/**
 * The best-effort advisory groups beyond the health-check registry: improve
 * advisories, the `stash-git-exposure` probe, the 08 surfaces group
 * (binary-config-skew, egress-endpoints), `type-directory-disagreement`
 * (#831), `data-dir-usage` (#896), and `plugin-version` (itlackey/akm#832).
 * Order matches emission order in the returned array. A probe/filesystem
 * failure in any try/catch must not abort the health report — each group
 * degrades to "no advisory" independently.
 */
function gatherAncillaryAdvisories(
  db: Database,
  stateDbPath: string,
  since: string,
  improveSummary: ImproveHealthMetrics,
  options: AkmHealthOptions,
  egressConfigView: EgressConfigView | undefined,
): HealthCheckResult[] {
  const advisories: HealthCheckResult[] = [...collectImproveAdvisories(db, stateDbPath, since, improveSummary)];

  const indexStateMismatch = detectIndexStateGenerationMismatch(db);
  if (indexStateMismatch) advisories.push(indexStateMismatch);

  // 08-F1: surface a `stash-git-exposure` advisory when env/secret assets are
  // git-tracked AND a remote is configured (the leak moment). Best-effort.
  // Cheap guard: only shell out to git when the stash has its OWN `.git` (or a
  // test injected a fake seam), so the hot path never spawns for a non-git
  // stash — the common unit-test case. Trade-off: a stash manually pointed at a
  // bare subdirectory of a parent git repo (no `.git` of its own) is not
  // checked. akm-init always creates `.git` at the stash root, so any
  // akm-initialised stash is covered; this only skips hand-pointed nested ones.
  try {
    const exposureStashDir = options.stashDir ?? resolveStashDir();
    if (options.stashExposureGit || fs.existsSync(path.join(exposureStashDir, ".git"))) {
      const stashExposure = collectStashExposureAdvisory(exposureStashDir, options.stashExposureGit);
      if (stashExposure) advisories.push(stashExposure);
    }
  } catch {
    // Non-fatal — a git/probe failure must not abort the health report.
  }

  // 08 surfaces: the remaining read-only advisory group (binary-config-skew,
  // egress-endpoints). Best-effort — a filesystem probe failure must not abort
  // the health report.
  try {
    advisories.push(
      ...collectSurfacesAdvisories({
        configPath: getConfigPath(),
        config: egressConfigView,
      }),
    );
  } catch {
    // Non-fatal.
  }

  // #831: flag indexed assets whose resolved type disagrees with the type
  // their containing directory declares (see health/type-directory-check.ts).
  // Best-effort — an unreadable index must not abort the health report.
  try {
    const typeDirMismatch = detectTypeDirectoryDisagreements(options.stashDir ?? resolveStashDir());
    if (typeDirMismatch) advisories.push(typeDirMismatch);
  } catch {
    // Non-fatal.
  }

  // #896: report the data dir's total size and its largest top-level
  // subdirectory, so a disk-usage blowup (e.g. unpruned migration snapshot
  // backups, #897) is self-diagnosing instead of requiring `du` archaeology.
  // Best-effort — an unreadable/missing data dir must not abort the health
  // report.
  try {
    const dataDirUsage = collectDataDirUsageAdvisory(getDataDir());
    if (dataDirUsage) advisories.push(dataDirUsage);
  } catch {
    // Non-fatal.
  }

  // itlackey/akm#832: report installed Claude Code harness plugin version(s)
  // and warn when stale or when the plugin's own akm-cli version range no
  // longer admits this CLI. Best-effort — no plugin installed, an unreadable
  // manifest, or a network failure while checking the newest tag must not
  // abort the health report.
  try {
    advisories.push(...collectPluginStalenessAdvisories({ cliVersion: pkgVersion }));
  } catch {
    // Non-fatal.
  }

  return advisories;
}

/**
 * Open index.db read-only, project every entry to `{ filePath, type }`, and
 * build the `type-directory-disagreement` advisory. `stashRoot` is used only
 * to shorten displayed paths (relative to the stash) when it's an ancestor of
 * the entry's path; falls back to the absolute path otherwise. Returns
 * `undefined` when the index is absent/unreadable or nothing disagrees —
 * mirrors {@link detectIndexStateGenerationMismatch}'s best-effort shape.
 */
function detectTypeDirectoryDisagreements(stashRoot: string): HealthCheckResult | undefined {
  let indexDb: ReturnType<typeof openReadonlyExistingDatabase>;
  try {
    indexDb = openReadonlyExistingDatabase(getDbPath());
    if (!indexDb) return undefined;
    const entries = getAllEntries(indexDb).map((entry) => ({ filePath: entry.filePath, type: entry.type }));
    return buildTypeDirectoryAdvisory(entries, undefined, (absPath) =>
      absPath.startsWith(stashRoot) ? path.relative(stashRoot, absPath) : absPath,
    );
  } catch {
    return undefined;
  } finally {
    if (indexDb) {
      try {
        closeDatabase(indexDb);
      } catch {
        // Best-effort advisory: a close failure must not abort health.
      }
    }
  }
}

/**
 * Detect the durable signature of an interrupted cross-database update.
 *
 * `usage_events.entry_ref` is the stable identity while `entry_id` names the
 * current, regenerable index row. A linked event whose id is absent or resolves
 * to a different ref means index.db and state.db describe adjacent generations.
 * Legacy/bare refs and deliberately detached rows are excluded. The scan is
 * streaming and keeps only a bounded evidence sample so health cannot mirror
 * either database into the JS heap.
 *
 * Best-effort by design: an absent/unreadable/incompatible index has its own
 * diagnostics and must not make the state health path throw.
 */
function detectIndexStateGenerationMismatch(stateDb: Database): HealthCheckResult | undefined {
  let indexDb: Database | undefined;
  try {
    indexDb = openReadonlyExistingDatabase(getDbPath());
    if (!indexDb) return undefined;

    const byId = indexDb.prepare<{ item_ref: string | null }>("SELECT item_ref FROM entries WHERE id = ?");
    const rows = stateDb
      .prepare<{ entry_id: number; entry_ref: string }>(
        "SELECT DISTINCT entry_id, entry_ref FROM usage_events " +
          "WHERE entry_id IS NOT NULL AND entry_ref IS NOT NULL AND instr(entry_ref, '//') > 0",
      )
      .iterate();
    let mismatches = 0;
    const sample: Array<{ entryId: number; entryRef: string; indexedRef: string | null }> = [];
    for (const row of rows) {
      const indexedRef = byId.get(row.entry_id)?.item_ref ?? null;
      if (indexedRef === row.entry_ref) continue;
      mismatches += 1;
      if (sample.length < 5) sample.push({ entryId: row.entry_id, entryRef: row.entry_ref, indexedRef });
    }
    if (mismatches === 0) return undefined;
    return {
      name: "index-state-generation",
      kind: "deterministic",
      status: "warn",
      confidence: "high",
      message:
        `${mismatches} durable usage link(s) disagree with the current searchable index generation. ` +
        "Stop concurrent writers and run 'akm index --full' to relink state to the current index.",
      evidence: { mismatches, sample },
    };
  } catch {
    return undefined;
  } finally {
    if (indexDb) {
      try {
        closeDatabase(indexDb);
      } catch {
        // Best-effort advisory: a close failure must not abort health.
      }
    }
  }
}

interface WindowComparePhaseResult {
  windowResults: WindowResult[] | undefined;
  deltas: Record<string, DeltaEntry> | undefined;
}

/**
 * Phase 3 — window-compare mode. Resolves `--window-compare`/`--windows` into
 * per-window bundles and computes deltas between the earliest and latest
 * window. Top-level metrics retain the primary `--since` query.
 */
function resolveWindowComparePhase(
  options: AkmHealthOptions,
  db: Database,
  stateDbPath: string,
  now: () => number,
  logsDb: Database | undefined,
): WindowComparePhaseResult {
  let windowSpecs: WindowSpec[] | undefined;
  if (options.windowCompare) {
    windowSpecs = resolveWindowCompare(options.windowCompare, now);
  } else if (options.windows && options.windows.length > 0) {
    windowSpecs = options.windows;
  }

  let windowResults: WindowResult[] | undefined;
  let deltas: Record<string, DeltaEntry> | undefined;

  if (windowSpecs) {
    windowResults = windowSpecs.map((spec) => {
      const winSince = parseHealthSince(spec.since);
      const winUntil = spec.until ? parseHealthSince(spec.until) : new Date(now()).toISOString();
      const bundle = buildWindowMetrics(db, stateDbPath, winSince, winUntil, now, logsDb);
      return {
        name: spec.name,
        since: winSince,
        until: winUntil,
        runs: bundle.runs,
        improve: bundle.improve,
        metrics: bundle.metrics,
      };
    });
    if (windowResults.length >= 2) {
      // Deltas always read chronologically: `from` = earliest window,
      // `to` = latest. Positive pctChange on a failure metric (e.g.
      // distill.llmFailed) means things got WORSE going forward in
      // time; negative means improvement. Window 0 in the output
      // array is whatever the user specified first (typically
      // `current` for --window-compare), but the delta direction is
      // independent of that array order.
      const sorted = [...windowResults].sort((a, b) => new Date(a.since).getTime() - new Date(b.since).getTime());
      deltas = computeDeltas(sorted[0]!, sorted[sorted.length - 1]!);
    }
  }

  return { windowResults, deltas };
}

/**
 * The health report for a state.db a managed open cannot reach at all: either
 * the file is not readable (#791), or — the same shape, a different cause —
 * it holds a pending migration the managed open refuses to apply without
 * deliberate consent (`akm upgrade` / `akm migrate apply` are the
 * only two callers allowed to admit a historical-destructive migration; see
 * `beforeMigrationLocked` in `src/core/state/migrations.ts`).
 *
 * `akm health` is what an operator (or a bundler's boot check) runs when
 * something else is misbehaving, so it must survive either problem long
 * enough to NAME it. Previously an unreadable file was already handled this
 * way, but a pending migration was not: the managed open's refusal escaped as
 * a thrown `ConfigError` (exit 78) and crashed the whole command before any
 * check — including this one — could report anything.
 *
 * Reported as a single hard-channel `fail` check — the run genuinely could
 * not open state.db, so every check that depends on it is skipped rather than
 * attempted — and it still exits non-zero, just through health's normal
 * `fail` path instead of a thrown config-error exit.
 */
function degradedStateDbReport(hardCheck: HealthCheckResult, options: AkmHealthOptions): AkmHealthResult {
  return {
    schemaVersion: 3,
    ok: false,
    status: "fail",
    since: parseHealthSince(options.since),
    hardChecks: [hardCheck],
    advisories: [],
    metrics: {
      taskFailRate: 0,
      agentFailureRate: 0,
      agentFailureReasonCounts: {},
      stuckActiveRuns: 0,
      logBackingRate: 0,
      // `null`, not 0: the round-trip probe did not run, which is not the same
      // as it running instantly.
      probeRoundTripMs: null,
      llmUsage: emptyLlmUsageAggregate(),
    },
    improve: summarizeImproveCompleted([]),
  };
}

function unreadableStateDbCheck(detail: string): HealthCheckResult {
  return {
    name: "state-db-readable",
    kind: "deterministic",
    status: "fail",
    confidence: "high",
    message:
      `state.db exists but is not readable: ${detail}. Every other health check is skipped because ` +
      "none of them can read it. Check the owner and mode of the data directory, or point " +
      "AKM_DATA_DIR / XDG_DATA_HOME at a location this user owns.",
    evidence: { detail },
  };
}

export async function akmHealth(options: AkmHealthOptions = {}): Promise<AkmHealthResult> {
  validateAkmHealthOptions(options);
  const now = options.now ?? (() => Date.now());
  const since = parseHealthSince(options.since);
  const stateDbPath = options.stateDbPath ?? getStateDbPathInDataDir();
  const hardChecks: HealthCheckResult[] = [];
  const advisories: HealthCheckResult[] = [];

  // #791: an UNREADABLE state.db, or one with a pending migration the
  // managed open refuses to apply, are the two failures `akm health` most
  // needs to be able to report, because this is the command an operator (or a
  // bundler's boot check) runs to find out why everything else is behaving
  // oddly. Dying here meant health could not diagnose that state at all — not
  // even the checks that never touch state.db got to run. Report it as a
  // finding instead.
  let db: ReturnType<typeof openStateDatabase>;
  try {
    db = openStateDatabase(stateDbPath);
  } catch (error) {
    const { access, code } = classifyPathAccess(stateDbPath);
    if (access === "inaccessible") {
      return degradedStateDbReport(unreadableStateDbCheck(describeInaccessiblePath(stateDbPath, code)), options);
    }
    // The managed open's refusal of a pending historical-destructive
    // migration is a plain `Error`, not a distinguishable error class — so
    // confirm the cause via the read-only preflight (`listPendingStateMigrations`,
    // which never applies anything) rather than pattern-matching the message.
    // A ledger too broken to enumerate at all throws here too; in that case
    // fall through to the generic config-error report below, since it is a
    // genuinely different, rarer failure this check cannot explain.
    let pendingMigrationsCheck: HealthCheckResult | undefined;
    try {
      pendingMigrationsCheck = runPendingStateMigrationsCheck(stateDbPath, { listPendingStateMigrations });
    } catch {
      pendingMigrationsCheck = undefined;
    }
    if (pendingMigrationsCheck?.status === "fail") {
      return degradedStateDbReport(pendingMigrationsCheck, options);
    }
    throw new ConfigError(
      `Unable to open state.db: ${error instanceof Error ? error.message : String(error)}`,
      "INVALID_CONFIG_FILE",
    );
  }

  // logs.db backs the log-backing metric (#579). Best-effort: when it cannot
  // be opened, partitionLogBackedRows falls back to the on-disk file check, so
  // health never hard-fails on a missing/locked logs database.
  let logsDb: ReturnType<typeof openLogsDatabase> | undefined;
  try {
    logsDb = openLogsDatabase(options.logsDbPath);
  } catch {
    logsDb = undefined;
  }

  try {
    // Network probes overlap the local database phases below; awaited where consumed.
    const engineProbesPromise = runHealthEngineProbes({ probeReachable: options.probe ? probeLlmEndpoint : undefined });
    engineProbesPromise.catch(() => undefined);
    // #950: same best-effort, --probe-gated discipline as engineProbesPromise
    // above — started here, alongside it, and awaited later.
    const versionDriftPromise = collectVersionDriftAdvisory(Boolean(options.probe), { cliVersion: pkgVersion });
    versionDriftPromise.catch(() => undefined);
    // #953: same --probe-gated, best-effort discipline as versionDriftPromise
    // above.
    const schedulerBinaryDriftPromise = collectSchedulerBinaryAdvisory(Boolean(options.probe), {
      cliVersion: pkgVersion,
    });
    schedulerBinaryDriftPromise.catch(() => undefined);
    const taskHistory = gatherTaskHistoryPhase(db, logsDb, since, stateDbPath, now);
    const { tableNames, missingTables, probe } = taskHistory;

    const { egressConfigView, thinkingOffEngines } = gatherEgressConfigPhase();

    const { improveSummary } = gatherImproveSummaryPhase(db, stateDbPath, since, now);

    advisories.push(...gatherAncillaryAdvisories(db, stateDbPath, since, improveSummary, options, egressConfigView));

    const sessionExtractionLedger = gatherSessionExtractionLedgerPhase(db, now);

    // #950: computed once (no IO beyond config/env, same as gatherEgressConfigPhase)
    // so `active-improve-strategy` and `engine-last-used` project the same
    // process→engine map instead of each resolving the strategy independently.
    const { check: activeImproveStrategy, processEngines: activeImproveStrategyEngines } = probeActiveImproveStrategy();

    // #950: `engine-last-used` reads a fixed lookback window independent of
    // `--since` (mirrors sessionExtractionLedger's independent window above).
    const engineLastUsedSinceIso = engineLastUsedSince(now);
    const engineLastUsed = readLastEngineUsage(stateDbPath, now);
    const improveRunsInLookbackWindow = countImproveRunsSince(db, engineLastUsedSinceIso);

    const engineProbes = await engineProbesPromise;
    const versionDrift = await versionDriftPromise;
    const schedulerBinaryDrift = await schedulerBinaryDriftPromise;

    // Read once, shared by the `thinking-control` check (#949) and the
    // `metrics.llmUsage` report field below — same window, same aggregate.
    const llmUsage = readLlmUsageAggregate(stateDbPath, since);

    // Run the ordered health-check registry. Each check projects the shared
    // context computed above into one HealthCheckResult; `channel` routes it to
    // hardChecks or advisories. Declaration order in HEALTH_CHECKS is the
    // emission order — see src/commands/health/checks.ts.
    const checkContext: HealthCheckContext = {
      stateDbPath,
      since,
      tableNames,
      missingTables,
      probe,
      taskRowCount: taskHistory.taskRowCount,
      taskFailRate: taskHistory.taskFailRate,
      taskRowsWithLogsCount: taskHistory.taskRowsWithLogsCount,
      existingLogRowsCount: taskHistory.existingLogRowsCount,
      logBackingRate: taskHistory.logBackingRate,
      stuckActiveRuns: taskHistory.stuckActiveRuns,
      stuckActiveTasks: taskHistory.stuckActiveTasks,
      worstTaskFailRate: taskHistory.worstTaskFailRate,
      agentFailureReasonCounts: taskHistory.agentFailureReasonCounts,
      sessionExtraction: improveSummary.sessionExtraction,
      sessionExtractionLedger,
      autoAccept: improveSummary.autoAccept,
      engineProbes,
      thinkingOffEngines,
      llmUsage,
      versionDrift,
      activeImproveStrategy,
      activeImproveStrategyEngines,
      engineLastUsed,
      improveRunsInLookbackWindow,
      schedulerBinaryDrift,
    };
    for (const check of HEALTH_CHECKS) {
      const result = check.run(checkContext);
      if (check.channel === "hard") hardChecks.push(result);
      else advisories.push(result);
    }

    const metrics: HealthMetrics = {
      taskFailRate: roundRate(taskHistory.taskFailRate),
      agentFailureRate: roundRate(taskHistory.agentFailureRate),
      agentFailureReasonCounts: taskHistory.agentFailureReasonCounts,
      stuckActiveRuns: taskHistory.stuckActiveRuns,
      logBackingRate: roundRate(taskHistory.logBackingRate),
      probeRoundTripMs: probe.durationMs,
      llmUsage,
    };

    const hardFailure = hardChecks.some((check) => check.status === "fail");
    const deterministicWarnings = [...hardChecks, ...advisories].some(
      (check) => check.status === "warn" && check.kind === "deterministic",
    );
    const status: AkmHealthResult["status"] = hardFailure ? "fail" : deterministicWarnings ? "warn" : "pass";

    // ── Window-compare mode (Phase 3) ─────────────────────────────────────
    const { windowResults, deltas } = resolveWindowComparePhase(options, db, stateDbPath, now, logsDb);

    // ── Per-run mode (Phase 2) ────────────────────────────────────────────
    let runs: ImproveRunSummary[] | undefined;
    if (options.groupBy === "run") {
      runs = buildPerRunSummaries(db, since);
    }

    return {
      schemaVersion: 3,
      ok: !hardFailure,
      status,
      since,
      hardChecks,
      advisories,
      metrics,
      improve: improveSummary,
      ...(runs ? { runs } : {}),
      ...(windowResults ? { windows: windowResults } : {}),
      ...(deltas ? { deltas } : {}),
    };
  } finally {
    db.close();
    if (logsDb) {
      try {
        logsDb.close();
      } catch {
        // best-effort
      }
    }
  }
}

// Markdown renderers (renderRunsDetailMd / renderWindowCompareMd) live in
// health/md-report.ts, mirroring the HTML extraction in health/html-report.ts.
