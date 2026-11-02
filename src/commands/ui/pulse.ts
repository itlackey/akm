// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `GET /api/overview/pulse`: the last seven days against the eight weeks before them (three tiles), the four-week improve
 * line, and what needs attention. Every figure is derived from the same stores `akm metrics` and `akm health` read, and a
 * range is only claimed when there is enough data to have a usual.
 */

import { loadConfig } from "../../core/config/config";
import { queryImproveRuns } from "../../storage/repositories/improve-runs-repository";
import { listStateProposals } from "../../storage/repositories/proposals-repository";
import { queryTaskHistory } from "../../storage/repositories/task-history-repository";
import { metricsWindow, readLlmRows, readUsageRows } from "../metrics/metrics-cli";
import type { MetricsUsageRow } from "../metrics/types";
import { proposalWaitingSince } from "../proposal/proposal-types";
import { againstUsual, classifyOutcome } from "./derive";
import { isUserSearch, missesFromRows } from "./misses";
import { tryStashDir, withReadonlyStateDb } from "./readers";
import { nearestRank } from "./stats";

const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();

export function overviewPulse() {
  const now = Date.now();
  const weekAgo = iso(now - 7 * DAY);
  const baselineStart = iso(now - 63 * DAY);
  const window = metricsWindow("70d", now);
  const stashDir = tryStashDir();
  const state = withReadonlyStateDb(
    (db) => ({
      usage: readUsageRows(db, window),
      llm: readLlmRows(db, window),
      runs: queryImproveRuns(db, weekAgo),
      tasks: queryTaskHistory(db, { since: weekAgo }),
      proposals: stashDir ? listStateProposals(db, { stashDir, withContent: false }) : [],
    }),
    { usage: [], llm: [], runs: [], tasks: [], proposals: [] },
  );
  const rows = state.usage;

  // Found nothing: this week's share against the eight weeks before.
  const searches = rows.filter(isUserSearch);
  const current = searches.filter((row) => row.at >= weekAgo);
  const baseline = searches.filter((row) => row.at >= baselineStart && row.at < weekAgo);
  const miss = (list: MetricsUsageRow[]) => list.filter((row) => row.resultCount === 0).length;
  const missedNow = miss(current);
  const foundNothing = {
    x: missedNow,
    n: current.length,
    rate: current.length ? missedNow / current.length : null,
    usual: againstUsual(missedNow, current.length, miss(baseline), baseline.length),
  };

  // Negative feedback: a count this week against the weekly counts before it.
  const negative = rows.filter((row) => row.eventType === "feedback" && row.signal === "negative");
  const negativeNow = negative.filter((row) => row.at >= weekAgo);
  const perWeek = Array.from({ length: 8 }, (_, i) => {
    const from = iso(now - 63 * DAY + i * 7 * DAY);
    const to = iso(now - 63 * DAY + (i + 1) * 7 * DAY);
    return negative.filter((row) => row.at >= from && row.at < to).length;
  });
  const weeksWithData = perWeek.filter((count) => count > 0).length;
  const sortedWeeks = [...perWeek].sort((a, b) => a - b);
  const latest = negativeNow.sort((a, b) => b.at.localeCompare(a.at))[0];
  const negativeFeedback = {
    count: negativeNow.length,
    assets: new Set(negativeNow.map((row) => row.ref).filter(Boolean)).size,
    usual:
      weeksWithData >= 4
        ? { low: nearestRank(sortedWeeks, 0.1), high: nearestRank(sortedWeeks, 0.9), state: "ok" as const }
        : { low: null, high: null, state: "low-data" as const },
    latest: latest ? { ref: latest.ref ?? null, at: latest.at } : null,
  };

  const failedTasks = state.tasks.filter((row) => row.status === "failed");
  const runs = {
    improve: { ok: state.runs.filter((run) => run.ok === 1).length, total: state.runs.length },
    tasks: { ok: state.tasks.filter((row) => row.status === "completed").length, total: state.tasks.length },
    failedTasks: failedTasks
      .sort((a, b) => b.started_at.localeCompare(a.started_at))
      .slice(0, 3)
      .map((row) => ({ taskId: row.task_id, at: row.started_at })),
  };

  // The improve line: what happened to the proposals made in the last four weeks.
  const fourWeeks = iso(now - 28 * DAY);
  const recent = state.proposals.filter((p) => p.createdAt >= fourWeeks);
  const classes = recent.map((p) => ({ p, outcome: classifyOutcome(p) }));
  const llmCalls = state.llm
    .filter((row) => row.day >= fourWeeks.slice(0, 10))
    .reduce((sum, row) => sum + row.calls, 0);
  const improveLine = {
    weeks: 4,
    proposed: recent.length,
    // A revert writes a rejected review, so count by outcome class: a reverted proposal was accepted first.
    accepted: classes.filter((c) => ["judge", "you", "unknown", "reverted"].includes(c.outcome)).length,
    acceptedThenReverted: classes.filter((c) => c.outcome === "reverted").length,
    rejected: classes.filter((c) => c.outcome === "rejected").length,
    rejectedByYou: classes.filter((c) => c.outcome === "rejected" && c.p.review?.decidedBy === "human").length,
    waiting: classes.filter((c) => c.outcome === "pending").length,
    calls: llmCalls,
  };

  // Needs attention.
  const pending = state.proposals.filter((p) => p.status === "pending");
  const oldest = pending.map((p) => proposalWaitingSince(p)).sort()[0] ?? null;
  const repeated = missesFromRows(current).filter((m) => m.repeated);
  const revertedThisWeek = state.proposals.filter((p) => p.status === "reverted" && p.updatedAt >= weekAgo).length;
  const failedImprove = state.runs.filter((run) => run.ok !== 1).length;
  const connections = Object.keys(loadConfig().connections ?? {}).length;
  const attention = {
    pending: { count: pending.length, oldest },
    misses: { queries: repeated.length },
    failedRuns: { improve: failedImprove, tasks: failedTasks.length },
    harm: { reverted: revertedThisWeek },
    setup: connections === 0 ? { needs: "a model connection" } : null,
  };

  return {
    window: {
      current: { since: weekAgo, until: iso(now) },
      baseline: { since: baselineStart, until: weekAgo, weeks: 8 },
    },
    tiles: { foundNothing, negativeFeedback, runs },
    improveLine,
    attention,
  };
}
