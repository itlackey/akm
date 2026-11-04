import type { ActivityOverview, ActivityPulse } from "./activity-types";

export const healthCheckAnchor = (name: string) => `health-check-${encodeURIComponent(name)}`;
export interface HomeConcern {
  key: string;
  tone: "fail" | "warn";
  title: string;
  description: string;
  href: string;
  action: string;
}
const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

/** Presentation only. Keep recorded failure, unknown outcome and ordinary review work separate. */
export function homeConcerns(data: ActivityOverview | null): HomeConcern[] {
  if (!data) return [];
  const checks = [...(data.health?.hardChecks ?? []), ...(data.health?.advisories ?? [])];
  const checkItems = (status: "fail" | "warn") =>
    checks
      .filter((check) => check.status === status)
      .map((check) => ({
        key: check.name,
        tone: status,
        title: check.name.replaceAll("-", " ").replace(/^./, (letter) => letter.toUpperCase()),
        description: check.message,
        action: "Inspect",
        href: `/activity/overview?${new URLSearchParams({ view: "health", anchor: healthCheckAnchor(check.name) })}`,
      }));
  const runs: HomeConcern[] = [];
  // metrics uses the requested seven-day window; pulse.failedTasks is only a three-row preview.
  const failedTasks = data.metrics?.tasks.failed;
  if (failedTasks)
    runs.push({
      key: "task-runs",
      tone: "fail",
      title: `${plural(failedTasks, "task run")} failed`,
      description: "Recorded in the past 7 days.",
      action: "View runs",
      href: "/activity/overview?view=runs&window=7d&anchor=automation",
    });
  const failedImprove = data.improveRuns.filter((run) => run.ok === false).length;
  if (failedImprove)
    runs.push({
      key: "improve-runs",
      tone: "fail",
      title: `${plural(failedImprove, "improvement run")} failed`,
      description: `Among the ${data.improveRuns.length} latest records, across all time.`,
      action: "View runs",
      href: "/activity/overview?view=runs&anchor=run-history",
    });
  return [...checkItems("fail"), ...runs, ...checkItems("warn")];
}

export function taskOutcomes(data: ActivityOverview | null, pulse: ActivityPulse | null) {
  // The core pulse falls back to empty arrays when the state store is unavailable.
  // Require the overview's explicit availability before treating zeros as measured.
  if (!data?.metrics || data.taskFailures === null || data.errors?.state || !pulse?.attention) return null;
  const completed = pulse.tiles.runs.tasks.ok,
    total = pulse.tiles.runs.tasks.total,
    failed = pulse.attention.failedRuns.tasks;
  if (![completed, total, failed].every((n) => Number.isSafeInteger(n) && n >= 0) || completed + failed > total)
    return null;
  return { completed, failed, other: total - completed - failed, total };
}

export function homeCoverage(data: ActivityOverview | null, pulse: ActivityPulse | null) {
  const unavailable = new Set<string>();
  if (!data?.health) unavailable.add("Health checks");
  if (!data?.metrics) unavailable.add("Activity measurements");
  if (!data || data.taskFailures === null || data.errors?.state) unavailable.add("Run records");
  if (!pulse || (data && !taskOutcomes(data, pulse))) unavailable.add("Weekly task outcomes");
  for (const key of Object.keys(data?.errors ?? {})) {
    if (!["health", "metrics", "state"].includes(key)) unavailable.add(key);
  }
  return [...unavailable];
}
