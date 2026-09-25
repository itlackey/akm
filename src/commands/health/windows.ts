// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Window handling for `akm health`: `--window-compare` / `--windows` parsing,
 * per-window metric assembly, and delta computation between two windows.
 */

import { UsageError } from "../../core/errors";
import { readEvents } from "../../core/events";
import { DURATION_UNITS, parseDuration } from "../../core/time";
import type { Database } from "../../storage/database";
import { queryTaskHistory } from "../../storage/repositories/task-history-repository";
import {
  buildImproveSkipSummary,
  computeWallTimeStats,
  computeWindowProposalCoverage,
  countAgentFailureReasons,
  isAgentTaskHistoryRow,
  roundRate,
  summarizeImproveRuns,
  taskFailureDetail,
} from "./improve-metrics";
import { readLlmUsageAggregate } from "./llm-usage";
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

/**
 * Metric paths diffed between the earliest and latest window (`deltas` in the
 * JSON result; the delta column of `--format md`). Paths are relative to a
 * {@link WindowResult}.
 */
export const INTERESTING_DELTA_PATHS = [
  "improve.actions.reflect.failed",
  "improve.actions.distill.queued",
  "improve.actions.distill.llmFailed",
  "improve.consolidation.promoted",
  "improve.memoryInference.written",
  "improve.memoryInference.yieldRate",
  "improve.memoryInference.skippedNoFacts",
  "improve.graphExtraction.failures",
  "improve.autoAccept.promoted",
  "improve.autoAccept.validationFailed",
  "improve.coverage.acceptedProposals",
  "improve.coverage.distinctRefs",
  "improve.wallTime.medianMs",
  "improve.wallTime.p95Ms",
  "metrics.llmUsage.calls",
  "metrics.llmUsage.totalTokens",
  "metrics.llmUsage.totalDurationMs",
  "metrics.llmUsage.failures",
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

export function buildWindowMetrics(
  db: Database,
  stateDbPath: string,
  since: string,
  until: string,
  now: () => number = () => Date.now(),
): WindowMetricsBundle {
  const untilMs = new Date(until).getTime();
  const taskRows = queryTaskHistory(db, { since }).filter((row) => {
    const startMs = new Date(row.started_at).getTime();
    return !Number.isFinite(untilMs) || startMs < untilMs;
  });
  const failedTaskRows = taskRows.filter((row) => row.status === "failed");
  const activeRows = taskRows.filter((row) => row.status === "active" && row.completed_at === null);
  const stuckActiveRuns = activeRows.filter(
    (row) => now() - new Date(row.started_at).getTime() > ACTIVE_RUN_WARN_MS,
  ).length;
  const agentRows = taskRows.filter((row) => isAgentTaskHistoryRow(row));
  const agentFailures = agentRows.filter((row) => {
    const detail = taskFailureDetail(row);
    return typeof detail?.reason === "string" && detail.reason.length > 0;
  });
  const taskFailRate = taskRows.length === 0 ? 0 : failedTaskRows.length / taskRows.length;
  const agentFailureRate = agentRows.length === 0 ? 0 : agentFailures.length / agentRows.length;

  const eventsBeforeUntil = (type: string) =>
    readEvents({ since, type }, { dbPath: stateDbPath }).events.filter(
      (event) => new Date(event.ts ?? since).getTime() < untilMs,
    );
  const { metrics: improve, runCount } = summarizeImproveRuns(db, since, until);
  improve.invoked = eventsBeforeUntil("improve_invoked").length;
  improve.completed = eventsBeforeUntil(IMPROVE_COMPLETED_EVENT).length;
  const skipSummary = buildImproveSkipSummary(eventsBeforeUntil("improve_skipped"));
  improve.skipped = skipSummary.skipped;
  improve.skipReasons = skipSummary.skipReasons;
  // Wall times come from the same improve-runs window as the per-run
  // reporting so counts and percentiles stay aligned with it.
  improve.wallTime = computeWallTimeStats(
    buildPerRunSummaries(db, since, until)
      .map((run) => run.wallTimeMs)
      .filter((ms) => Number.isFinite(ms) && ms > 0),
  );
  improve.coverage = computeWindowProposalCoverage(db, since, until);

  const metrics: HealthMetrics = {
    taskFailRate: roundRate(taskFailRate),
    agentFailureRate: roundRate(agentFailureRate),
    agentFailureReasonCounts: countAgentFailureReasons(agentFailures),
    stuckActiveRuns,
    llmUsage: readLlmUsageAggregate(stateDbPath, since, until),
  };

  return { improve, metrics, runs: runCount };
}
