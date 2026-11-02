// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** `GET /api/search/misses`: what people searched for and akm found nothing, grouped by query. */

import { metricsWindow, readUsageRows } from "../metrics/metrics-cli";
import type { MetricsUsageRow } from "../metrics/types";
import { withReadonlyStateDb } from "./readers";

export interface Miss {
  query: string;
  count: number;
  /** Distinct UTC days the query came up with nothing. */
  days: number;
  lastAt: string;
  /** True when the same query found nothing on two or more days: a gap, not a typo. */
  repeated: boolean;
}

/** A search the user ran themselves, not a lookup of one asset and not an agent's search. */
export const isUserSearch = (row: MetricsUsageRow): boolean =>
  row.eventType === "search" && row.ref === undefined && row.source === "user";

const normalize = (query: string): string => query.trim().replace(/\s+/g, " ").toLowerCase();

/** The user's searches that found nothing, grouped by normalised query, repeats first then most recent. */
export function missesFromRows(rows: MetricsUsageRow[]): Miss[] {
  const byQuery = new Map<string, { query: string; count: number; days: Set<string>; lastAt: string }>();
  for (const row of rows) {
    if (!isUserSearch(row) || row.resultCount !== 0) continue;
    const query = row.query?.trim();
    if (!query) continue;
    const key = normalize(query);
    const entry = byQuery.get(key) ?? { query, count: 0, days: new Set<string>(), lastAt: row.at };
    entry.count += 1;
    entry.days.add(row.at.slice(0, 10));
    if (row.at > entry.lastAt) {
      entry.lastAt = row.at;
      entry.query = query;
    }
    byQuery.set(key, entry);
  }
  return [...byQuery.values()]
    .map(({ days, ...rest }) => ({ ...rest, days: days.size, repeated: days.size >= 2 }))
    .sort(
      (a, b) =>
        Number(b.repeated) - Number(a.repeated) || b.lastAt.localeCompare(a.lastAt) || a.query.localeCompare(b.query),
    );
}

export function searchMisses(query: URLSearchParams) {
  const window = metricsWindow(query.get("since") || "30d");
  const rows = withReadonlyStateDb((db) => readUsageRows(db, window), []);
  const misses = missesFromRows(rows);
  return {
    searches: rows.filter(isUserSearch).length,
    foundNothing: misses.reduce((sum, m) => sum + m.count, 0),
    misses,
  };
}
