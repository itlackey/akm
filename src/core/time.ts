// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared time and date utilities.
 *
 * Centralises parsing of user-facing `--since` values so that all consumers
 * interpret the same set of formats (ISO-8601, epoch ms, plain date strings)
 * consistently without private re-implementations drifting apart.
 */

import { UsageError } from "./errors";

// ── Duration-shorthand parsing ───────────────────────────────────────────────

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A month is approximated as 30 days — this shorthand is not calendar-exact. */
const MONTH_MS = 30 * DAY_MS;

/**
 * Canonical duration-shorthand unit map shared by every `--since` / `--expires`
 * / `--window-compare` consumer.
 *
 * The grammar is intentionally uniform across the whole CLI:
 *   - `m` = MINUTES, `M` = MONTHS (30-day approximation)
 *   - `h`/`H` = hours, `d`/`D` = days
 *
 * Matching is CASE-SENSITIVE (see {@link parseDuration}), which is what lets
 * `m` and `M` mean different things. Historically `akm health --since` and
 * `remember --expires` read a case-insensitive `m` as MONTHS while
 * `consolidate` / `--window-compare` read it as MINUTES; that split is now
 * resolved in favour of the conventional `m`=minutes, with `M` reserved for
 * months. Upper-case `H`/`D` aliases are retained so specs that previously
 * relied on the old case-insensitive parsers (e.g. `"7D"`) keep working.
 */
export const DURATION_UNITS: Readonly<Record<string, number>> = {
  m: MINUTE_MS,
  M: MONTH_MS,
  h: HOUR_MS,
  H: HOUR_MS,
  d: DAY_MS,
  D: DAY_MS,
};

/**
 * Parse a compact duration shorthand (e.g. `"30d"`, `"12h"`, `"5m"`, `"3M"`)
 * into a number of milliseconds using an explicit `units` map (default
 * {@link DURATION_UNITS}), or return `null` when the input does not match
 * `<digits><letter>` or the unit is not in the map.
 *
 * Matching is CASE-SENSITIVE against the map keys, so `m` (minutes) and `M`
 * (months) are distinct — do NOT lower-case the spec before calling, or the
 * two collapse. Amount is parsed with base-10 `parseInt`; `null` is returned
 * rather than throwing so each caller keeps its own error/fallback policy.
 */
export function parseDuration(spec: string, units: Record<string, number> = DURATION_UNITS): number | null {
  const match = spec.trim().match(/^(\d+)([a-zA-Z])$/);
  if (!match) return null;
  const amount = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(amount)) return null;
  const multiplier = units[match[2] ?? ""];
  if (multiplier === undefined) return null;
  return amount * multiplier;
}

// ── Since-flag parsing ───────────────────────────────────────────────────────

/**
 * Parse a user-supplied `--since` value and return an ISO-8601 timestamp
 * string (e.g. `"2026-01-15T10:30:00.000Z"`).
 *
 * Accepted input formats:
 *   - ISO-8601 timestamp (preferred): `"2026-04-01T00:00:00Z"`
 *   - Plain date: `"2026-04-01"` (interpreted as start-of-day UTC)
 *   - Epoch milliseconds (pure digit string): `"1744329600000"`
 *   - Any other value parseable by `new Date()`
 *
 * Callers that need a different wire format (e.g. SQLite `"YYYY-MM-DD HH:MM:SS"`)
 * should convert the returned ISO string themselves.
 *
 * @throws {UsageError} when `since` is empty or cannot be parsed as a date.
 */
export function parseSinceToIso(since: string): string {
  const trimmed = since.trim();
  if (!trimmed) {
    throw new UsageError("--since cannot be empty.", "INVALID_FLAG_VALUE");
  }
  // Pure-digit input → epoch milliseconds
  if (/^\d+$/.test(trimmed)) {
    const ms = Number.parseInt(trimmed, 10);
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) {
      throw new UsageError(`Invalid --since value: ${since}`, "INVALID_FLAG_VALUE");
    }
    return d.toISOString();
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new UsageError(
      `Invalid --since value: ${since}. Expected ISO timestamp (e.g. 2026-04-01T00:00:00Z) or epoch ms.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return parsed.toISOString();
}

/**
 * Convert an ISO-8601 timestamp string to the SQLite datetime format
 * `"YYYY-MM-DD HH:MM:SS"` used by `datetime('now')`.
 */
export function isoToSqlite(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d+Z$/, "");
}
