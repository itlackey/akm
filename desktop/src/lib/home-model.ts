// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { ActivityOverview, ActivityPulse } from "./activity-types";

export const healthCheckAnchor = (name: string) => `health-check-${encodeURIComponent(name)}`;
/** What each `akm health` check looks at, in words; a check this Desktop does not know keeps its id, spaced out. */
export const checkLabels: Record<string, string> = {
  "state-db-readable": "State database readable",
  "state-db-schema": "State database schema",
  "state-db-round-trip": "State database write and read",
  "state-db-integrity": "State database integrity",
  "state-db-migrations": "State database migrations",
  "task-history-read": "Task history",
  "active-runs": "Active task runs",
  "connections-and-harnesses": "Connections and harnesses",
  "semantic-search": "Semantic search",
  "task-fail-rate": "Task failure rate",
  "session-extraction": "Session extraction",
  "proposal-queue": "Proposal queue",
  "auto-accept-validation": "Auto-accept validation",
  "cli-version": "akm CLI version",
  "scheduler-binary": "Scheduler's akm binary",
  "index-state-generation": "Index and state generations",
  "stash-git-exposure": "Secrets tracked by git",
  "binary-config-skew": "Config newer than this akm",
  "egress-endpoints": "Remote endpoints",
  "type-directory-disagreement": "Asset types and folders",
  "memory-cleanup-archive": "Memory cleanup archive",
  "data-dir-usage": "Data directory size",
  "plugin-version": "Claude Code plugin",
  "codex-plugin-version": "Codex plugin",
  "opencode-plugin-version": "OpenCode plugin",
  "opencode-v2-plugin-version": "OpenCode 2 plugin",
};
export const checkLabel = (name: string) =>
  checkLabels[name] ?? name.replaceAll("-", " ").replace(/^./, (letter) => letter.toUpperCase());
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
        title: checkLabel(check.name),
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
