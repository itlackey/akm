// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type {
  ActivityCheck,
  ActivityImpact,
  ActivityOverview,
  ActivityPulse,
  ActivityRetrieval,
  ActivityTaskRun,
  ActivityWorkflowRun,
  ModelCount,
} from "./activity-types";

/** `check` is the first check behind the item, for the view to name by its label. */
export type AttentionItem = {
  tone: "fail" | "warn" | "work";
  text: string;
  href: string;
  action: string;
  check?: string;
};
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
/** Rank recorded faults before ordinary work. Missing pulse data never means an all-clear. */
export function attentionItems(data: ActivityOverview, pulse: ActivityPulse | null): AttentionItem[] {
  const items: AttentionItem[] = [];
  const checks = [...(data.health?.hardChecks ?? []), ...(data.health?.advisories ?? [])];
  for (const status of ["fail", "warn"] as const) {
    const matches = checks.filter((check) => check.status === status);
    if (matches.length)
      items.push({
        tone: status,
        text: plural(matches.length, status === "fail" ? "failing check" : "health warning"),
        check: matches[0].name,
        href: `/activity/overview?view=health&anchor=health-${encodeURIComponent(status)}`,
        action: "Inspect checks",
      });
  }
  // The pulse failure total includes unknown improve outcomes; use recorded false values instead.
  const failedImprove = data.improveRuns.filter((run) => run.ok === false).length;
  const failedTasks = pulse?.tiles.runs.failedTasks.length ?? 0;
  if (failedImprove || failedTasks)
    items.splice(checks.some((check) => check.status === "fail") ? 1 : 0, 0, {
      tone: "fail",
      text: [
        failedImprove && `${plural(failedImprove, "failed improve run")} in latest records`,
        failedTasks && `${plural(failedTasks, "failed task run")} this week`,
      ]
        .filter(Boolean)
        .join(" and "),
      href: "/activity/overview?view=runs",
      action: "Inspect runs",
    });
  const pending = pulse?.attention?.pending;
  if (pending?.count)
    items.push({
      tone: "work",
      text: `${plural(pending.count, "proposal")} waiting for review`,
      href: "/review",
      action: "Review changes",
    });
  if (pulse?.attention?.misses.queries)
    items.push({
      tone: "work",
      text: `${plural(pulse.attention.misses.queries, "query", "queries")} found nothing on multiple days`,
      href: "/activity/overview?view=misses",
      action: "Inspect search gaps",
    });
  if (pulse?.attention?.harm.reverted)
    items.push({
      tone: "work",
      text: `${plural(pulse.attention.harm.reverted, "change")} reverted this week`,
      href: "/activity/improve?anchor=harm",
      action: "Inspect reversions",
    });
  if (pulse?.attention?.setup)
    items.push({
      tone: "work",
      text: "No model connection configured for improvement work",
      href: "/settings/config?section=add-connection",
      action: "Configure connection",
    });
  return items;
}

export const number = (value: number | null | undefined) => (value == null ? "Unknown" : value.toLocaleString());
export const percent = (value: number | null | undefined) =>
  value == null ? "Not measured" : `${Math.round(value * 1000) / 10}%`;
export const duration = (value: number | null | undefined) =>
  value == null ? "Not recorded" : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
export const tokens = (row: ModelCount) =>
  row.calls > 0 && !row.usageCalls ? "Not reported" : number(row.totalTokens);
/**
 * Where an `unknown` check lands: turned off on purpose, not run (not probed, skipped, nothing to inspect), could not
 * run (a remote or program it needed did not answer), or run with nothing to report yet. akm reports no reason code,
 * so the message decides.
 */
export function healthGroup(check: ActivityCheck, checks: ActivityCheck[]): string {
  if (check.status !== "unknown") return check.status;
  if (
    ["connections-and-harnesses", "proposal-queue"].includes(check.name) ||
    (check.name === "session-extraction" &&
      checks.some((item) => item.name === "connections-and-harnesses" && item.status === "unknown"))
  )
    return "off";
  if (/not probed|skipped|no scheduled task|no scheduler/i.test(check.message)) return "unchecked";
  if (/could not|cannot|unable|not reach|failed|not on PATH/i.test(check.message)) return "blocked";
  return "idle";
}
export const outcomeClasses = [
  { key: "judge", label: "Accepted by the judge" },
  { key: "you", label: "Accepted by you" },
  { key: "unknown", label: "Accepted, decider not recorded" },
  { key: "rejected", label: "Rejected" },
  { key: "reverted", label: "Reverted" },
] as const;
/** Baseline UI presentation: trailing seven days; never infer quality from retrieval. */
export function rollingSearch(retrieval: ActivityRetrieval, changed: ActivityImpact["changedAssets"], days = 90) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const labels = Array.from({ length: days }, (_, i) =>
    new Date(today.getTime() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );
  const rows = new Map(retrieval.daily.map((row) => [row.date, row]));
  const rates = labels.map((_, index) => {
    const selected = labels.slice(Math.max(0, index - 6), index + 1).map((day) => rows.get(day));
    if (selected.some((row) => row === undefined)) return null;
    const searches = selected.reduce((sum, row) => sum + (row?.searches ?? 0), 0);
    const misses = selected.reduce((sum, row) => sum + (row?.zeroResults ?? 0), 0);
    return searches >= 5 ? Math.round((1 - misses / searches) * 1000) / 10 : null;
  });
  const marked = new Set(
    changed.filter((item) => item.outcome !== "reverted").map((item) => item.decidedAt.slice(0, 10)),
  );
  const known = rates.filter((rate): rate is number => rate !== null);
  const floor = known.length ? Math.max(0, Math.floor((Math.min(...known) - 10) / 10) * 10) : 0;
  return { labels, rates, marked, floor };
}

export type TimelineRun = {
  at: string;
  tone: "ok" | "fail" | "other";
  durationMs: number | null;
  said: string;
  /** A workflow run's id, for its trace. */
  runId?: string;
};
/** `recorded` is how many runs the window holds when akm says; a row can draw fewer (`runs`). */
export type TimelineRow = { name: string; task?: string; runs: TimelineRun[]; recorded: number | null };
const trigger = (value: ActivityTaskRun["trigger"]) =>
  value === "schedule" ? ", started by the schedule" : value === "manual" ? ", started by hand" : "";
/**
 * The runs Desktop is given, as rows on one clock: a row per task, a row per workflow, then improve runs and index
 * builds. Only runs that started inside the metrics window are drawn. Nothing is derived: a gap is a time with no
 * recorded run.
 */
export function runTimelineRows(
  data: ActivityOverview,
  taskRuns: ActivityTaskRun[],
  workflowRuns: ActivityWorkflowRun[],
): TimelineRow[] {
  const window = data.metrics?.window;
  if (!window) return [];
  const since = Date.parse(window.since);
  const until = Date.parse(window.until);
  const inside = (at: string) => Date.parse(at) >= since && Date.parse(at) <= until;
  const rows: TimelineRow[] = [];
  const byTask = new Map<string, TimelineRun[]>();
  for (const run of taskRuns) {
    if (!inside(run.startedAt)) continue;
    const list = byTask.get(run.taskId) ?? [];
    list.push({
      at: run.startedAt,
      tone: run.status === "completed" ? "ok" : run.status === "failed" ? "fail" : "other",
      durationMs: run.durationMs,
      said: `${run.status}${trigger(run.trigger)}`,
    });
    byTask.set(run.taskId, list);
  }
  for (const [task, runs] of [...byTask].sort((a, b) => a[0].localeCompare(b[0])))
    rows.push({ name: task, task, recorded: null, runs });
  const byWorkflow = new Map<string, TimelineRun[]>();
  for (const run of workflowRuns) {
    if (!inside(run.createdAt)) continue;
    const name = `Workflow ${run.title || run.workflowRef}`;
    const end = run.completedAt ? Date.parse(run.completedAt) : Number.NaN;
    const list = byWorkflow.get(name) ?? [];
    list.push({
      at: run.createdAt,
      tone: run.status === "completed" ? "ok" : run.status === "failed" ? "fail" : "other",
      durationMs: Number.isFinite(end) ? Math.max(0, end - Date.parse(run.createdAt)) : null,
      said: `${run.status}${run.harness ? `, started by ${run.harness}` : ""}`,
      runId: run.id,
    });
    byWorkflow.set(name, list);
  }
  for (const [name, runs] of [...byWorkflow].sort((a, b) => a[0].localeCompare(b[0])))
    rows.push({ name, recorded: null, runs });
  const improve = data.improveRuns.filter((run) => inside(run.startedAt));
  if (improve.length)
    rows.push({
      name: "Improve",
      recorded: null,
      runs: improve.map((run) => ({
        at: run.startedAt,
        tone: run.ok === true ? "ok" : run.ok === false ? "fail" : "other",
        durationMs: run.durationMs,
        said: run.ok === true ? "finished" : run.ok === false ? "failed" : "outcome not recorded",
      })),
    });
  const index = data.metrics?.index;
  const builds = (index?.recent ?? []).filter((run) => inside(run.at));
  if (index && builds.length)
    rows.push({
      name: "Index builds",
      recorded: index.runs,
      runs: builds.map((run) => ({ at: run.at, tone: "ok", durationMs: run.totalMs, said: `${run.mode} build` })),
    });
  return rows;
}
