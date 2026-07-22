// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { resolveStashDir } from "../core/common";
import { loadConfig } from "../core/config/config";
import { ConfigError, UsageError } from "../core/errors";
import { readEvents } from "../core/events";
import { openLogsDatabase } from "../core/logs-db";
import { getCacheDir, getConfigDir, getConfigPath, getDataDir, getStateDbPathInDataDir } from "../core/paths";
import { listExistingTableNames, openStateDatabase } from "../core/state-db";
import { DURATION_UNITS, parseDuration, parseSinceToIso } from "../core/time";
import { readSemanticStatus } from "../indexer/search/semantic-status";
import type { SessionLogEntry } from "../integrations/session-logs";
import { getExecutionLogCandidates } from "../integrations/session-logs";
import type { Database } from "../storage/database";
import { queryTaskHistory } from "../storage/repositories/task-history-repository";
import { collectImproveAdvisories } from "./health/advisories";
import { HEALTH_CHECKS, type HealthCheckContext } from "./health/checks";
import {
  buildImproveSkipSummary,
  computeWallTimeStats,
  parseTaskMetadata,
  roundRate,
  summarizeImproveCompleted,
  summarizeImproveRuns,
} from "./health/improve-metrics";
import { readLlmUsageAggregate } from "./health/llm-usage";
import {
  computeDegradationMetrics,
  computeDenominatorFixedCoverage,
  computeEnrichmentMintingRollup,
  probeStateDbRoundTrip,
} from "./health/metrics";
import { collectStashExposureAdvisory, type GitRunner } from "./health/stash-exposure";
import { collectSurfacesAdvisories, type EgressConfigView } from "./health/surfaces";
import { buildPerRunSummaries } from "./health/task-runs";
import {
  ACTIVE_RUN_WARN_MS,
  type AkmHealthResult,
  type DeltaEntry,
  type HealthCheckResult,
  type HealthMetrics,
  IMPROVE_COMPLETED_EVENT,
  type ImproveHealthMetrics,
  type ImproveRunSummary,
  type SessionLogAdvisory,
  type WindowResult,
  type WindowSpec,
} from "./health/types";
import { buildWindowMetrics, computeDeltas, partitionLogBackedRows, resolveWindowCompare } from "./health/windows";

export interface AkmHealthOptions {
  since?: string;
  /** Row grouping. `run` emits one row per improve_runs entry (was `--detail per-run`). */
  groupBy?: "run";
  windowCompare?: string;
  windows?: WindowSpec[];
  getExecutionLogCandidatesFn?: (sinceDays?: number) => SessionLogEntry[];
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
  logBackingRate: number;
  taskFailRate: number;
  agentFailureRate: number;
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
  const stuckActiveRuns = activeRows.filter(
    (row) => now() - new Date(row.started_at).getTime() > ACTIVE_RUN_WARN_MS,
  ).length;
  const promptRows = taskRows.filter((row) => row.target_kind === "prompt");
  const promptFailures = promptRows.filter((row) => {
    const detail = parseTaskMetadata(row).detail;
    return typeof detail?.reason === "string" && detail.reason.length > 0;
  });
  const logBackingRate = taskRowsWithLogs.length === 0 ? 1 : existingLogRows.length / taskRowsWithLogs.length;
  const taskFailRate = taskRows.length === 0 ? 0 : failedTaskRows.length / taskRows.length;
  const agentFailureRate = promptRows.length === 0 ? 0 : promptFailures.length / promptRows.length;

  return {
    tableNames,
    missingTables,
    probe,
    taskRowCount: taskRows.length,
    taskRowsWithLogsCount: taskRowsWithLogs.length,
    existingLogRowsCount: existingLogRows.length,
    stuckActiveRuns,
    logBackingRate,
    taskFailRate,
    agentFailureRate,
  };
}

interface SemanticConfigPhase {
  semanticStatus: ReturnType<typeof readSemanticStatus>;
  semanticSearchMode: string | undefined;
  embeddingEndpoint: string | undefined;
  egressConfigView: EgressConfigView | undefined;
}

/**
 * Semantic-search status + the config fields the embedding-endpoint and
 * surfaces advisories need. Best-effort: an unloadable config leaves the
 * config-derived fields undefined and callers fall back to generic messages.
 */
function gatherSemanticConfigPhase(): SemanticConfigPhase {
  const semanticStatus = readSemanticStatus();
  let semanticSearchMode: string | undefined;
  let embeddingEndpoint: string | undefined;
  let egressConfigView: EgressConfigView | undefined;
  try {
    const config = loadConfig();
    semanticSearchMode = config.semanticSearchMode;
    embeddingEndpoint = config.embedding?.endpoint;
    egressConfigView = config as EgressConfigView;
  } catch {
    // fall through with undefined
  }
  return { semanticStatus, semanticSearchMode, embeddingEndpoint, egressConfigView };
}

interface ImproveSummaryPhase {
  improveSummary: ImproveHealthMetrics;
  perRunSummaries: ImproveRunSummary[];
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
 * The three best-effort advisory groups beyond the health-check registry:
 * improve advisories, the `stash-git-exposure` probe, and the 08 surfaces
 * group (secret-file-perms, binary-config-skew, orphan-stores,
 * egress-endpoints). Order matches emission order in the returned array. A
 * probe/filesystem failure in either try/catch must not abort the health
 * report — each group degrades to "no advisory" independently.
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

  // 08 surfaces: the remaining read-only advisory group (secret-file-perms,
  // binary-config-skew, orphan-stores, egress-endpoints). Best-effort — a
  // filesystem probe failure must not abort the health report.
  try {
    advisories.push(
      ...collectSurfacesAdvisories({
        stashDir: options.stashDir ?? resolveStashDir(),
        cacheDir: getCacheDir(),
        dataDir: getDataDir(),
        configDir: getConfigDir(),
        configPath: getConfigPath(),
        config: egressConfigView,
      }),
    );
  } catch {
    // Non-fatal.
  }

  return advisories;
}

/** Execution-log-derived session advisories. Best-effort: any failure yields an empty list. */
function gatherSessionLogAdvisories(
  since: string,
  now: () => number,
  getExecutionLogCandidatesFn: (sinceDays?: number) => SessionLogEntry[],
): SessionLogAdvisory[] {
  try {
    const sinceDays = Math.max(0, Math.ceil((now() - new Date(since).getTime()) / (24 * 60 * 60 * 1000)));
    return getExecutionLogCandidatesFn(sinceDays).map((entry) => ({
      topic: entry.topic,
      frequency: entry.frequency,
      source: entry.source,
      isFailurePattern: entry.isFailurePattern,
    }));
  } catch {
    return [];
  }
}

interface WindowComparePhaseResult {
  windowResults: WindowResult[] | undefined;
  deltas: Record<string, DeltaEntry> | undefined;
  topLevelImprove: ImproveHealthMetrics;
  topLevelMetrics: HealthMetrics;
  topLevelSince: string;
}

/**
 * Phase 3 — window-compare mode. Resolves `--window-compare`/`--windows` into
 * per-window bundles, then folds window 0 back onto the top-level
 * improve/metrics/since fields (backward compat with the non-window-compare
 * shape) and computes deltas between the earliest and latest window.
 */
function resolveWindowComparePhase(
  options: AkmHealthOptions,
  db: Database,
  stateDbPath: string,
  now: () => number,
  logsDb: Database | undefined,
  probe: TaskHistoryPhase["probe"],
  improveSummary: ImproveHealthMetrics,
  metrics: HealthMetrics,
  since: string,
): WindowComparePhaseResult {
  let windowSpecs: WindowSpec[] | undefined;
  if (options.windowCompare) {
    windowSpecs = resolveWindowCompare(options.windowCompare, now);
  } else if (options.windows && options.windows.length > 0) {
    windowSpecs = options.windows;
  }

  let windowResults: WindowResult[] | undefined;
  let deltas: Record<string, DeltaEntry> | undefined;
  let topLevelImprove = improveSummary;
  let topLevelMetrics = metrics;
  let topLevelSince = since;

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
    // Preserve backward compat: top-level improve/metrics reflect window 0.
    if (windowResults.length > 0) {
      const firstWindow = windowResults[0]!;
      topLevelImprove = firstWindow.improve;
      topLevelMetrics = { ...firstWindow.metrics, probeRoundTripMs: probe.durationMs };
      topLevelSince = firstWindow.since;
    }
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

  return { windowResults, deltas, topLevelImprove, topLevelMetrics, topLevelSince };
}

export function akmHealth(options: AkmHealthOptions = {}): AkmHealthResult {
  validateAkmHealthOptions(options);
  const now = options.now ?? (() => Date.now());
  const since = parseHealthSince(options.since);
  const stateDbPath = options.stateDbPath ?? getStateDbPathInDataDir();
  const hardChecks: HealthCheckResult[] = [];
  const advisories: HealthCheckResult[] = [];
  const getExecutionLogCandidatesFn = options.getExecutionLogCandidatesFn ?? getExecutionLogCandidates;

  let db: ReturnType<typeof openStateDatabase> | undefined;
  try {
    db = openStateDatabase(stateDbPath);
  } catch (error) {
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
    const taskHistory = gatherTaskHistoryPhase(db, logsDb, since, stateDbPath, now);
    const { tableNames, missingTables, probe } = taskHistory;

    const { semanticStatus, semanticSearchMode, embeddingEndpoint, egressConfigView } = gatherSemanticConfigPhase();

    const { improveSummary } = gatherImproveSummaryPhase(db, stateDbPath, since, now);

    advisories.push(...gatherAncillaryAdvisories(db, stateDbPath, since, improveSummary, options, egressConfigView));

    const sessionLogEntries = gatherSessionLogAdvisories(since, now, getExecutionLogCandidatesFn);

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
      semanticStatus,
      semanticSearchMode,
      embeddingEndpoint,
      sessionLogEntries,
      sessionExtraction: improveSummary.sessionExtraction,
      autoAccept: improveSummary.autoAccept,
    };
    for (const check of HEALTH_CHECKS) {
      const result = check.run(checkContext);
      if (check.channel === "hard") hardChecks.push(result);
      else advisories.push(result);
    }

    const metrics: HealthMetrics = {
      taskFailRate: roundRate(taskHistory.taskFailRate),
      agentFailureRate: roundRate(taskHistory.agentFailureRate),
      stuckActiveRuns: taskHistory.stuckActiveRuns,
      logBackingRate: roundRate(taskHistory.logBackingRate),
      probeRoundTripMs: probe.durationMs,
      llmUsage: readLlmUsageAggregate(stateDbPath, since),
    };

    const hardFailure = hardChecks.some((check) => check.status === "fail");
    const deterministicWarnings = [...hardChecks, ...advisories].some(
      (check) => check.status === "warn" && check.kind === "deterministic",
    );
    const status: AkmHealthResult["status"] = hardFailure ? "fail" : deterministicWarnings ? "warn" : "pass";

    // ── Window-compare mode (Phase 3) ─────────────────────────────────────
    const { windowResults, deltas, topLevelImprove, topLevelMetrics, topLevelSince } = resolveWindowComparePhase(
      options,
      db,
      stateDbPath,
      now,
      logsDb,
      probe,
      improveSummary,
      metrics,
      since,
    );

    // ── Per-run mode (Phase 2) ────────────────────────────────────────────
    let runs: ImproveRunSummary[] | undefined;
    if (options.groupBy === "run") {
      runs = buildPerRunSummaries(db, since);
    }

    return {
      schemaVersion: 3,
      ok: !hardFailure,
      status,
      since: topLevelSince,
      hardChecks,
      advisories,
      metrics: topLevelMetrics,
      improve: topLevelImprove,
      sessionLogAdvisories: sessionLogEntries,
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
