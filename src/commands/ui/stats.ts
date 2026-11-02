// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Small pure helpers for the dashboard's series: UTC days and weeks, zero-filling, and rate intervals. */

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` of an ISO timestamp or date. */
function utcDay(iso: string): string {
  return iso.slice(0, 10);
}

/** Every UTC day from `from` to `to` inclusive, as `YYYY-MM-DD`. Empty when `to` is before `from`. */
export function dayRange(from: string, to: string): string[] {
  const days: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return days;
  for (let at = start; at <= end; at += DAY_MS) days.push(new Date(at).toISOString().slice(0, 10));
  return days;
}

/** The Monday (ISO week start) of the UTC week that holds `day`, as `YYYY-MM-DD`. */
export function isoWeekStart(day: string): string {
  const at = new Date(`${day}T00:00:00Z`);
  // A value that is not a date has no week; callers compare it against real weeks and it matches none.
  if (Number.isNaN(at.getTime())) return "";
  const offset = (at.getUTCDay() + 6) % 7;
  return new Date(at.getTime() - offset * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Give every day inside the data's own coverage a row. Coverage starts at the first recorded day, because a day
 * before that is unknown, not zero, and ends at `until`. `blank(day)` makes the row for a day with no events.
 * The first day of a window that opens mid-day and the day holding `until` are marked partial.
 */
export function zeroFill<T extends { day: string }>(
  rows: T[],
  blank: (day: string) => T,
  window: { since: string; until: string },
): Array<T & { partial?: true }> {
  if (rows.length === 0) return [];
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const first = rows.map((row) => row.day).sort()[0] as string;
  const until = utcDay(window.until);
  const opensMidDay = !window.since.slice(10).startsWith("T00:00:00");
  return dayRange(first, until).map((day) => {
    const row = byDay.get(day) ?? blank(day);
    const partial = day === until || (opensMidDay && day === utcDay(window.since));
    return partial ? { ...row, partial: true as const } : row;
  });
}

/** The nearest-rank percentile `p` (0..1) of an ascending list; null for an empty list. */
export function nearestRank(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1] as number;
}

/** The smallest k with P(X <= k) >= q for X ~ Binomial(n, p): the exact quantile, computed from the pmf. */
export function binomialQuantile(n: number, p: number, q: number): number {
  if (n <= 0) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return n;
  let pmf = (1 - p) ** n;
  let cdf = pmf;
  let k = 0;
  while (cdf < q && k < n) {
    pmf *= ((n - k) / (k + 1)) * (p / (1 - p));
    k += 1;
    cdf += pmf;
  }
  return k;
}
