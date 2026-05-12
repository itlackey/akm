/**
 * Shared time and date utilities.
 *
 * Centralises parsing of user-facing `--since` values so that all consumers
 * interpret the same set of formats (ISO-8601, epoch ms, plain date strings)
 * consistently without private re-implementations drifting apart.
 */

import { UsageError } from "./errors";

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
