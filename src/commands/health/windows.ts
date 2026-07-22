// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Window handling for `akm health`: `--window-compare` / `--windows` parsing,
 * per-window metric assembly, log-backing partition, and delta computation.
 */

import fs from "node:fs";
import { UsageError } from "../../core/errors";
import { readEvents } from "../../core/events";
import { buildTaskRunId, getLoggedRunIds } from "../../core/logs-db";
import { DURATION_UNITS, parseDuration } from "../../core/time";
import type { Database } from "../../storage/database";
import { queryTaskHistory, type TaskHistoryRow } from "../../storage/repositories/task-history-repository";
import {
  buildImproveSkipSummary,
  computeWallTimeStats,
  parseTaskMetadata,
  roundRate,
  summarizeImproveCompleted,
  summarizeImproveRuns,
} from "./improve-metrics";
import { readLlmUsageAggregate } from "./llm-usage";
import { computeDegradationMetrics, computeDenominatorFixedCoverage } from "./metrics";
import { buildPerRunSummaries } from "./task-runs";
import {
  ACTIVE_RUN_WARN_MS,
  type DeltaEntry,
  type HealthMetrics,
  IMPROVE_COMPLETED_EVENT,
  type ImproveHealthMetrics,
  type WindowResult,
  type WindowSpec,
} from "./types";

/**
 * Parse a `--window-compare <duration>` shorthand into two adjacent windows
 * (current, prior). Duration syntax matches {@link parseHealthSince}.
 */
export function resolveWindowCompare(duration: string, now: () => number = () => Date.now()): WindowSpec[] {
  const trimmed = duration.trim();
  // Canonical CLI unit grammar: `m` = minutes, `M` = months. Not lower-cased,
  // so case distinguishes the two. See core/time.ts DURATION_UNITS.
  const ms = parseDuration(trimmed, DURATION_UNITS);
  if (ms === null) {
    throw new UsageError("--window-compare must be a duration like '24h', '7d', or '30m'.", "INVALID_FLAG_VALUE");
  }
  if (ms <= 0) {
    throw new UsageError("--window-compare must be a positive duration.", "INVALID_FLAG_VALUE");
  }
  const nowMs = now();
  const currentSince = new Date(nowMs - ms).toISOString();
  const currentUntil = new Date(nowMs).toISOString();
  const priorSince = new Date(nowMs - 2 * ms).toISOString();
  const priorUntil = currentSince;
  return [
    { name: "current", since: currentSince, until: currentUntil },
    { name: "prior", since: priorSince, until: priorUntil },
  ];
}

/**
 * Parse a single repeatable `--windows` value of the form
 * `name=...,since=...,until=...`. All keys are optional EXCEPT name and since.
 */
export function parseWindowSpec(raw: string): WindowSpec {
  const fields: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) {
      throw new UsageError(
        `--windows entry must be a comma-separated list of key=value pairs: ${raw}`,
        "INVALID_FLAG_VALUE",
      );
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    fields[key] = value;
  }
  if (!fields.name) {
    throw new UsageError(`--windows entry is missing required 'name': ${raw}`, "INVALID_FLAG_VALUE");
  }
  if (!fields.since) {
    throw new UsageError(`--windows entry is missing required 'since': ${raw}`, "INVALID_FLAG_VALUE");
  }
  return {
    name: fields.name,
    since: fields.since,
    ...(fields.until ? { until: fields.until } : {}),
  };
}

/** Hard-coded list of "interesting" metric paths for window-compare deltas. */
export const INTERESTING_DELTA_PATHS = [
  "improve.actions.reflect.failed",
  "improve.actions.reflect.guardRejected",
  "improve.actions.distill.llmFailed",
  "improve.actions.distill.queued",
  "improve.actions.distill.deferred",
  "improve.consolidation.promoted",
  "improve.memoryInference.written",
  "improve.memoryInference.yieldRate",
  "improve.memoryInference.skippedNoFacts",
  "improve.memoryInference.htmlErrorCount",
  "improve.graphExtraction.cacheHitRate",
  "improve.graphExtraction.failures",
  "improve.graphExtraction.htmlErrors",
  "improve.graphExtraction.nonArrayBatchFailures",
  "improve.sessionExtraction.sessionsScanned",
  "improve.sessionExtraction.proposalsCreated",
  "improve.autoAccept.promoted",
  "improve.autoAccept.validationFailed",
  "improve.wallTime.medianMs",
  "improve.wallTime.p95Ms",
] as const;

export function readNumericPath(obj: unknown, path: string): number {
  const parts = path.split(".");
  let cursor: unknown = obj;
  for (const part of parts) {
    if (typeof cursor !== "object" || cursor === null) return 0;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return typeof cursor === "number" && Number.isFinite(cursor) ? cursor : 0;
}

export function computeDeltas(first: WindowResult, last: WindowResult): Record<string, DeltaEntry> {
  const out: Record<string, DeltaEntry> = {};
  for (const path of INTERESTING_DELTA_PATHS) {
    const from = readNumericPath(first, path);
    const to = readNumericPath(last, path);
    if (from === 0 && to === 0) continue;
    let pctChange: number | string;
    if (from === 0) {
      pctChange = to === 0 ? 0 : "+inf";
    } else {
      pctChange = Number((((to - from) / from) * 100).toFixed(2));
    }
    out[path] = { from, to, pctChange };
  }
  return out;
}

interface WindowMetricsBundle {
  improve: ImproveHealthMetrics;
  metrics: HealthMetrics;
  runs: number;
}

/**
 * Partition task_history rows into "should have a log" (non-null log_path) and
 * "log is actually backed". A run counts as backed when logs.db holds rows for
 * its run_id (#579 — the DB is the primary record); rows written before logs.db
 * existed fall back to the transitional on-disk file check. `logsDb` may be
 * undefined when logs.db could not be opened — then only the file check runs.
 */
export function partitionLogBackedRows(
  taskRows: TaskHistoryRow[],
  logsDb: Database | undefined,
): { withLogs: TaskHistoryRow[]; backed: TaskHistoryRow[] } {
  const withLogs = taskRows.filter((row) => row.log_path !== null);
  const loggedRunIds = logsDb
    ? getLoggedRunIds(
        logsDb,
        withLogs.map((row) => buildTaskRunId(row.task_id, row.started_at)),
      )
    : new Set<string>();
  const backed = withLogs.filter(
    (row) =>
      loggedRunIds.has(buildTaskRunId(row.task_id, row.started_at)) ||
      (row.log_path !== null && fs.existsSync(row.log_path)),
  );
  return { withLogs, backed };
}

export function buildWindowMetrics(
  db: Database,
  stateDbPath: string,
  since: string,
  until: string,
  now: () => number = () => Date.now(),
  logsDb?: Database,
): WindowMetricsBundle {
  const taskRows = queryTaskHistory(db, { since }).filter((row) => {
    const startMs = new Date(row.started_at).getTime();
    const untilMs = new Date(until).getTime();
    return !Number.isFinite(untilMs) || startMs < untilMs;
  });
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

  const improveInvoked = readEvents({ since, type: "improve_invoked" }, { dbPath: stateDbPath }).events.filter(
    (event) => new Date(event.ts ?? since).getTime() < new Date(until).getTime(),
  ).length;
  const improveCompletedEvents = readEvents(
    { since, type: IMPROVE_COMPLETED_EVENT },
    { dbPath: stateDbPath },
  ).events.filter((event) => new Date(event.ts ?? since).getTime() < new Date(until).getTime());
  const improveSkippedEvents = readEvents({ since, type: "improve_skipped" }, { dbPath: stateDbPath }).events.filter(
    (event) => new Date(event.ts ?? since).getTime() < new Date(until).getTime(),
  );
  const eventsMetrics = summarizeImproveCompleted(improveCompletedEvents);
  const { metrics: improveSummary, runCount } = summarizeImproveRuns(db, since, until);
  improveSummary.invoked = improveInvoked;
  improveSummary.completed = eventsMetrics.completed;
  const skipSummary = buildImproveSkipSummary(improveSkippedEvents);
  improveSummary.skipped = skipSummary.skipped;
  improveSummary.skipReasons = skipSummary.skipReasons;
  // Preserve the per-phase aggregation computed by summarizeImproveRuns and
  // derive top-level wall times from the same improve-runs window so counts
  // and percentiles stay aligned with per-run reporting.
  const perRunSummaries = buildPerRunSummaries(db, since, until);
  const wallTimes = perRunSummaries.map((run) => run.wallTimeMs).filter((ms) => Number.isFinite(ms) && ms > 0);
  improveSummary.wallTime = computeWallTimeStats(wallTimes, improveSummary.wallTime.byPhase);

  // WS-5: Compute denominator-fixed coverage from the most recent run's
  // memorySummary (totalAssets = eligible + derived — the fixed denominator).
  const totalAssets = improveSummary.memorySummary.eligible + improveSummary.memorySummary.derived;
  improveSummary.coverage = computeDenominatorFixedCoverage(
    db,
    totalAssets,
    improveSummary.memorySummary.eligible,
    since,
    until,
  );

  // WS-5: Compute per-run degradation metrics (corpus diversity, merge fidelity,
  // generation distribution, oracle spot-check). Health VIEWS only.
  const degradation = computeDegradationMetrics(db, since, until);
  if (degradation) {
    improveSummary.degradation = degradation;
  }

  const metrics: HealthMetrics = {
    taskFailRate: roundRate(taskFailRate),
    agentFailureRate: roundRate(agentFailureRate),
    stuckActiveRuns,
    logBackingRate: roundRate(logBackingRate),
    probeRoundTripMs: null,
    llmUsage: readLlmUsageAggregate(stateDbPath, since, until),
  };

  return { improve: improveSummary, metrics, runs: runCount };
}
