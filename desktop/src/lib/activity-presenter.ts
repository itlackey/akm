// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type {
  ActivityCheck,
  ActivityImpact,
  ActivityOverview,
  ActivityPulse,
  ActivityRetrieval,
  ModelCount,
} from "./activity-types";

export type AttentionItem = { tone: "fail" | "warn" | "work"; text: string; href: string; action: string };
/** Rank recorded faults before ordinary work. Missing pulse data never means an all-clear. */
export function attentionItems(data: ActivityOverview, pulse: ActivityPulse | null): AttentionItem[] {
  const items: AttentionItem[] = [];
  const checks = [...(data.health?.hardChecks ?? []), ...(data.health?.advisories ?? [])];
  for (const status of ["fail", "warn"] as const) {
    const matches = checks.filter((check) => check.status === status);
    if (matches.length)
      items.push({
        tone: status,
        text: `${matches.length} ${status === "fail" ? "failing checks" : "health warnings"} · ${matches[0].name}`,
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
      text: `${failedImprove} failed improve runs in latest records · ${failedTasks} failed task runs this week`,
      href: "/activity/overview?view=runs",
      action: "Inspect runs",
    });
  const pending = pulse?.attention?.pending;
  if (pending?.count)
    items.push({
      tone: "work",
      text: `${pending.count} proposals waiting for review`,
      href: "/review",
      action: "Review changes",
    });
  if (pulse?.attention?.misses.queries)
    items.push({
      tone: "work",
      text: `${pulse.attention.misses.queries} queries found nothing on multiple days`,
      href: "/activity/overview?view=misses",
      action: "Inspect search gaps",
    });
  if (pulse?.attention?.harm.reverted)
    items.push({
      tone: "work",
      text: `${pulse.attention.harm.reverted} changes reverted this week`,
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
export function healthGroup(check: ActivityCheck, checks: ActivityCheck[], probed = false): string {
  if (check.status !== "unknown") return check.status;
  if (
    ["connections-and-harnesses", "proposal-queue"].includes(check.name) ||
    (check.name === "session-extraction" &&
      checks.some((item) => item.name === "connections-and-harnesses" && item.status === "unknown"))
  )
    return "off";
  return probed || /not probed/i.test(check.message) ? "unchecked" : "idle";
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
