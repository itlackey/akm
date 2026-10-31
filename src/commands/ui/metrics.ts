// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { computeWallTimeStats } from "../health/improve-metrics";
import type { MetricsUsageRow } from "../metrics/types";
import { type Proposal, proposalWaitingSince } from "../proposal/proposal-types";

/** Drill-down over the same user-attributed summary rows that `akm metrics` counts. */
export function retrievalSeries(rows: MetricsUsageRow[]) {
  const days = new Map<string, { searches: number; zeroResults: number; durations: number[] }>();
  const queries = new Map<string, { date: string; query: string; count: number }>();
  for (const row of rows) {
    if (row.eventType !== "search" || row.ref !== undefined) continue;
    const date = row.at.slice(0, 10);
    const day = days.get(date) ?? { searches: 0, zeroResults: 0, durations: [] };
    day.searches++;
    if (row.totalMs !== undefined && row.totalMs >= 0) day.durations.push(row.totalMs);
    if (row.resultCount === 0) {
      day.zeroResults++;
      const query = row.query?.trim();
      if (query) {
        const key = JSON.stringify([date, query]);
        const entry = queries.get(key) ?? { date, query, count: 0 };
        entry.count++;
        queries.set(key, entry);
      }
    }
    days.set(date, day);
  }
  return {
    daily: [...days]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, day]) => ({
        date,
        searches: day.searches,
        zeroResults: day.zeroResults,
        medianMs: day.durations.length ? computeWallTimeStats(day.durations).medianMs : null,
        latencySamples: day.durations.length,
      })),
    zeroResultQueries: [...queries.values()].sort(
      (a, b) => b.date.localeCompare(a.date) || b.count - a.count || a.query.localeCompare(b.query),
    ),
  };
}

export const PROPOSAL_AGE_BANDS = ["underDay", "underWeek", "older", "unknown"] as const;
export type ProposalAgeBand = (typeof PROPOSAL_AGE_BANDS)[number];

export function proposalAgeBand(proposal: Proposal, now: number): ProposalAgeBand {
  const age = now - Date.parse(proposalWaitingSince(proposal));
  if (!Number.isFinite(age) || age < 0) return "unknown";
  if (age < 86_400_000) return "underDay";
  return age < 7 * 86_400_000 ? "underWeek" : "older";
}

/** A current snapshot, not a reconstructed history. Count before list limits. */
export function proposalBacklog(proposals: Proposal[], now: number) {
  const groups = new Map<string, { source: string } & Record<ProposalAgeBand, number>>();
  for (const proposal of proposals) {
    const row = groups.get(proposal.source) ?? {
      source: proposal.source,
      underDay: 0,
      underWeek: 0,
      older: 0,
      unknown: 0,
    };
    row[proposalAgeBand(proposal, now)]++;
    groups.set(row.source, row);
  }
  return [...groups.values()].sort((a, b) => a.source.localeCompare(b.source));
}
