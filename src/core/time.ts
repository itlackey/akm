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

/**
 * Parse a compact duration shorthand (e.g. `"30d"`, `"12h"`, `"6m"`) into a
 * number of milliseconds using an explicit `units` map, or return `null` when
 * the input does not match `<digits><letter>` or the unit is not in the map.
 *
 * The unit map is passed by the caller ON PURPOSE: the codebase historically
 * disagreed on what `"m"` means — some call sites read it as MINUTES
 * (`consolidate`, `--window-compare`) and others as MONTHS (`akm health`,
 * `--expires`). This helper deliberately does NOT pick a winner; each caller
 * supplies the multipliers matching its own long-standing semantics so this
 * consolidation is pure DRY and changes no observable behaviour. See the TODO
 * at `parseHealthSince` for the unresolved product decision.
 *
 * Matching is case-sensitive against the map keys; callers that accept
 * mixed-case units (e.g. `"7D"`) should lower-case the spec before calling.
 * Amount is parsed with base-10 `parseInt`; `null` is returned rather than
 * throwing so each caller keeps its own error/fallback policy.
 */
export function parseDuration(spec: string, units: Record<string, number>): number | null {
  const match = spec.trim().match(/^(\d+)([a-zA-Z]+)$/);
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
