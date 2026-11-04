// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Observability read models: the overview, the week's pulse, health, retrieval and impact trends, task history. */

import os from "node:os";
import { akmHealth, parseHealthSince } from "../commands/health";
import { buildTasks } from "../commands/metrics/collect";
import { akmMetrics, metricsWindow, readUsageRows } from "../commands/metrics/metrics-cli";
import { UsageError } from "../core/errors";
import { listRecentImproveRuns } from "../storage/repositories/improve-runs-repository";
import {
  decodeTaskHistoryMetadata,
  queryTaskHistory,
  type TaskHistoryRow,
} from "../storage/repositories/task-history-repository";
import { pkgVersion } from "../version";
import { pChart, weekOf, weekRange } from "./derive";
import { filledActivity, retrievalSeries } from "./metrics";
import { clampLimit, section, withReadonlyStateDb } from "./readers";

export { improveImpact } from "./impact";
export { overviewPulse as pulse } from "./pulse";

const IMPROVE_RUNS_SHOWN = 10;

/** Health alone, so the overview can run the network probes when asked without reloading its metrics. */
export function health(input: { probe?: boolean } = {}) {
  return akmHealth({ since: "24h", groupBy: "run", probe: input.probe === true, readOnly: true });
}

export function meta() {
  return {
    version: pkgVersion,
    hostname: os.hostname(),
    runtime: process.versions.bun ? "bun" : "node",
  };
}

/** One persisted improve run, projected to what the overview shows. Tolerant: a row from an older release just has fewer fields. */
function summarizeImproveRun(row: ReturnType<typeof listRecentImproveRuns>[number]) {
  let result: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.result_json);
    if (parsed && typeof parsed === "object") result = parsed as Record<string, unknown>;
  } catch {
    // An unparseable result still has a row worth listing.
  }
  const byProcess: Record<string, { calls: number; failures: number }> = {};
  const usage = result.usageReport as { byProcessEngineModel?: unknown } | undefined;
  for (const entry of Array.isArray(usage?.byProcessEngineModel) ? usage.byProcessEngineModel : []) {
    const { process, calls, failures } = entry as { process?: string; calls?: number; failures?: number };
    if (!process) continue;
    const bucket = byProcess[process] ?? { calls: 0, failures: 0 };
    bucket.calls += calls ?? 0;
    bucket.failures += failures ?? 0;
    byProcess[process] = bucket;
  }
  const started = Date.parse(row.started_at);
  const completed = Date.parse(row.completed_at);
  return {
    id: row.id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    ok: row.ok === 1,
    durationMs:
      Number.isFinite(started) && Number.isFinite(completed) && completed >= started ? completed - started : null,
    strategy: row.strategy,
    scope: { mode: row.scope_mode, ...(row.scope_value ? { value: row.scope_value } : {}) },
    modelCalls: {
      total: Object.values(byProcess).reduce((sum, bucket) => sum + bucket.calls, 0),
      failures: Object.values(byProcess).reduce((sum, bucket) => sum + bucket.failures, 0),
      byProcess,
    },
    preRunSync: result.preRunSync ?? null,
    sync: result.sync ?? null,
    triage: result.triage ?? null,
  };
}

function failingTasks(rows: TaskHistoryRow[]) {
  return buildTasks(rows.length, rows)
    .byTask.filter((task) => task.failed > 0)
    .sort(
      (a, b) =>
        b.failed / b.runs - a.failed / a.runs ||
        b.failed - a.failed ||
        b.runs - a.runs ||
        a.taskId.localeCompare(b.taskId),
    )
    .slice(0, 20);
}

export async function overview(input: { probe?: boolean; metricsSince?: string } = {}) {
  const errors: Record<string, string> = {};
  const health = await section(errors, "health", () =>
    akmHealth({
      since: "24h",
      groupBy: "run",
      windowCompare: "24h",
      probe: input.probe === true,
      readOnly: true,
    }),
  );
  const metrics = await section(errors, "metrics", () =>
    akmMetrics({ since: input.metricsSince || "30d", indexSnapshot: false }),
  );
  const stateReads = await section(errors, "state", () =>
    withReadonlyStateDb(
      (db) => ({
        improveRuns: listRecentImproveRuns(db, IMPROVE_RUNS_SHOWN).map(summarizeImproveRun),
        // Rank the complete window in the order of the bars (failed runs over runs), not the metrics top-20 by volume.
        taskFailures: metrics ? failingTasks(queryTaskHistory(db, metrics.window)) : null,
      }),
      null,
    ),
  );
  return {
    health,
    metrics: metrics
      ? {
          ...metrics,
          usage: { ...metrics.usage, daily: filledActivity(metrics.usage.daily, metrics.window) },
        }
      : null,
    improveRuns: stateReads?.improveRuns ?? [],
    taskFailures: stateReads?.taskFailures ?? null,
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  };
}

export function taskHistory(input: { taskId?: string; since?: string; limit?: number }) {
  const taskId = (input.taskId ?? "").trim();
  if (!taskId) throw new UsageError("A taskId is required.", "MISSING_REQUIRED_ARGUMENT");
  const window = { since: parseHealthSince(input.since || "30d"), until: new Date().toISOString() };
  if (Date.parse(window.since) >= Date.parse(window.until))
    throw new UsageError("since must be earlier than now.", "INVALID_FLAG_VALUE");
  const limit = clampLimit(input.limit);
  return withReadonlyStateDb(
    (db) => {
      const rows = queryTaskHistory(db, { ...window, taskId });
      const runs = rows.slice(0, limit).map((row) => {
        let metadata: ReturnType<typeof decodeTaskHistoryMetadata> | null = null;
        try {
          metadata = decodeTaskHistoryMetadata(row.metadata_json);
        } catch {
          /* Unknown historical detail stays unknown. */
        }
        return {
          status: row.status,
          startedAt: row.started_at,
          durationMs: metadata?.durationMs ?? null,
          detail: metadata?.detail ?? null,
        };
      });
      return { available: true, totalCount: rows.length, count: runs.length, runs };
    },
    { available: false, totalCount: 0, count: 0, runs: [] },
  );
}

/** The per-day search series over a longer window than the Overview's, for the Improve impact trend. */
export function retrievalTrend(input: { since?: string } = {}) {
  const window = metricsWindow(input.since || "90d");
  const series = retrievalSeries(
    withReadonlyStateDb((db) => readUsageRows(db, window), []),
    window,
  );
  // The same days by ISO week, for a p-chart of the share that found nothing.
  const first = series.daily[0]?.date;
  const weeks = first ? weekRange(first, window.until.slice(0, 10)) : [];
  const perWeek = weeks.map((week) => {
    const days = series.daily.filter((d) => weekOf(d.date) === week);
    return {
      week,
      x: days.reduce((sum, d) => sum + d.zeroResults, 0),
      n: days.reduce((sum, d) => sum + d.searches, 0),
    };
  });
  const chart = pChart(perWeek);
  return { ...series, weekly: chart.points, centre: chart.centre };
}
