// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Usage event helpers for telemetry and utility-based re-ranking.
 *
 * Schema (state.db baseline, src/core/state/migrations.ts):
 *   id, event_type, query, entry_id (nullable), entry_ref, signal, metadata, source, created_at
 */

import type { Database } from "../../storage/database";
import { SQLITE_CHUNK_SIZE } from "../../storage/repositories/index-sql";
import { resolveAgentIdentity } from "../../workflows/runtime/agent-identity";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Provenance of a usage event. `"user"` = interactive/direct invocation
 * (including agent sessions acting for the user); `"improve"` = the improve
 * pipeline's own retrievals; `"task"` = scheduled work; `"audit"` = eval or
 * measurement traffic; `"unknown"` = unattributed legacy/extension traffic.
 * Machine and unattributed sources are excluded from demand and utility.
 */
export type UsageEventSource = "user" | "improve" | "task" | "audit" | "unknown";

const USAGE_EVENT_SOURCES = new Set<UsageEventSource>(["user", "improve", "task", "audit", "unknown"]);

/**
 * Resolve subprocess provenance without treating an invalid value as user
 * demand.
 *
 * `fallback` is what an unset/empty ambient value resolves to — it defaults to `"user"`.
 * A caller that
 * already knows the invocation's provenance (the task runner, threading its
 * `ExecutionProvenanceContext`) passes its resolved value as the fallback
 * instead, so a recognized ambient `AKM_EVENT_SOURCE` still wins everywhere it
 * won before, and only the *default* changes.
 */
export function resolveUsageEventSource(
  env: Record<string, string | undefined> = process.env,
  fallback: UsageEventSource = "user",
): UsageEventSource {
  const raw = env.AKM_EVENT_SOURCE;
  if (raw === undefined || raw === "") return fallback;
  return USAGE_EVENT_SOURCES.has(raw as UsageEventSource) ? (raw as UsageEventSource) : "unknown";
}

export interface UsageEvent {
  event_type: string;
  query?: string;
  entry_id?: number;
  entry_ref?: string;
  signal?: string;
  metadata?: string;
  /** Event source (see {@link UsageEventSource}). Omitted events are unattributed. */
  source?: UsageEventSource;
}

export interface UsageEventRow {
  id: number;
  event_type: string;
  query: string | null;
  entry_id: number | null;
  entry_ref: string | null;
  signal: string | null;
  metadata: string | null;
  source: string;
  created_at: string;
}

// ── Insert ───────────────────────────────────────────────────────────────────

/**
 * Insert a usage event into the database. Fire-and-forget: errors are
 * silently caught so callers are never blocked or disrupted.
 */
export function insertUsageEvent(db: Database, event: UsageEvent): void {
  try {
    insertUsageEventStrict(db, event);
  } catch {
    /* fire-and-forget: silently ignore errors */
  }
}

/**
 * The metadata a usage event is stored with: the caller's, plus `agent: { harness, session? }` when the environment
 * names the agent harness akm runs under (the same resolution workflow runs record). A caller's own `agent` key wins,
 * and metadata that is not a JSON object is stored as given.
 */
export function withAgentIdentity(metadata: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  const { harness, sessionId } = resolveAgentIdentity(env);
  if (!harness) return metadata ?? null;
  let parsed: Record<string, unknown> = {};
  if (metadata) {
    try {
      const value: unknown = JSON.parse(metadata);
      if (!value || typeof value !== "object" || Array.isArray(value)) return metadata;
      parsed = value as Record<string, unknown>;
    } catch {
      return metadata;
    }
  }
  return JSON.stringify({ agent: { harness, ...(sessionId ? { session: sessionId } : {}) }, ...parsed });
}

/** Insert a usage event and let a failed write throw, for callers whose record is the event itself. */
export function insertUsageEventStrict(db: Database, event: UsageEvent): void {
  db.prepare(
    `INSERT INTO usage_events (event_type, query, entry_id, entry_ref, signal, metadata, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.event_type,
    event.query ?? null,
    event.entry_id ?? null,
    event.entry_ref ?? null,
    event.signal ?? null,
    withAgentIdentity(event.metadata),
    event.source ?? "unknown",
  );
}

// ── Query ────────────────────────────────────────────────────────────────────

/**
 * User feedback counts for many assets at once, keyed by durable `entry_ref`.
 * Only feedback newer than {@link USAGE_EVENT_RETENTION_DAYS} counts, whether or not
 * a full index has purged the older rows yet. A negative that carried an exact fix does not count once an accepted
 * `feedback` proposal for the asset exists at or after it (the rule `akm
 * improve` uses for a fix already acted on); reverting that proposal makes it
 * count again. Refs with no user feedback are absent from the map. Read in one
 * query per chunk of refs.
 */
export function countFeedbackSignalsByRef(
  db: Database,
  refs: readonly string[],
): Map<string, { pos: number; neg: number }> {
  const counts = new Map<string, { pos: number; neg: number }>();
  const cutoff = new Date(Date.now() - USAGE_EVENT_RETENTION_DAYS * 86_400_000).toISOString();
  for (let i = 0; i < refs.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = refs.slice(i, i + SQLITE_CHUNK_SIZE);
    const rows = db
      .prepare(
        `SELECT u.entry_ref,
           SUM(CASE WHEN u.signal = 'positive' THEN 1 ELSE 0 END) AS pos,
           SUM(CASE WHEN u.signal = 'negative' AND NOT (
             json_extract(u.metadata, '$.fix') IS NOT NULL AND EXISTS (
               SELECT 1 FROM proposals p
               WHERE p.ref = u.entry_ref AND p.source = 'feedback' AND p.status = 'accepted'
                 AND julianday(p.created_at) >= julianday(u.created_at))
           ) THEN 1 ELSE 0 END) AS neg
         FROM usage_events u
         WHERE u.event_type = 'feedback' AND u.source = 'user' AND u.entry_ref IN (${chunk.map(() => "?").join(",")})
           AND datetime(u.created_at) >= datetime(?)
         GROUP BY u.entry_ref`,
      )
      .all(...chunk, cutoff) as Array<{ entry_ref: string; pos: number; neg: number }>;
    for (const row of rows) counts.set(row.entry_ref, { pos: row.pos, neg: row.neg });
  }
  return counts;
}

/**
 * How many times each asset was shown, by durable `entry_ref`: user-attributed `show` events newer than
 * {@link USAGE_EVENT_RETENTION_DAYS}. With a `project`, only shows that recorded it count (older shows,
 * which recorded none, cannot be placed in a project and do not); without one, every show counts.
 * Search and curate results are impressions, not use, and are not counted.
 */
export function countShownByRef(db: Database, project?: string): Map<string, number> {
  const cutoff = new Date(Date.now() - USAGE_EVENT_RETENTION_DAYS * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT entry_ref, COUNT(*) AS shown FROM usage_events
       WHERE event_type = 'show' AND source = 'user' AND entry_ref IS NOT NULL
         AND datetime(created_at) >= datetime(?)
         AND (? IS NULL OR CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.project') END = ?)
       GROUP BY entry_ref`,
    )
    .all(cutoff, project ?? null, project ?? null) as Array<{ entry_ref: string; shown: number }>;
  return new Map(rows.map((row) => [row.entry_ref, row.shown]));
}

/** When {@link USAGE_EVENT_RETENTION_DAYS} reaches back to now, as an ISO timestamp. */
export function usageRetentionSince(): string {
  return new Date(Date.now() - USAGE_EVENT_RETENTION_DAYS * 86_400_000).toISOString();
}

/**
 * How many times each asset was shown, how many searches returned it, and when it was last shown, by durable
 * `entry_ref`: user-attributed events at or after `sinceIso`, in one pass. The same definition of use as the utility aggregation in the indexer,
 * read live instead of as of the last index.
 */
export function countUseByRef(
  db: Database,
  sinceIso: string,
): Map<string, { shows: number; searches: number; lastShownAt: string | null }> {
  const rows = db
    .prepare(
      `SELECT entry_ref,
              SUM(CASE WHEN event_type = 'show' THEN 1 ELSE 0 END) AS shows,
              SUM(CASE WHEN event_type = 'search' THEN 1 ELSE 0 END) AS searches,
              MAX(CASE WHEN event_type = 'show' THEN datetime(created_at) END) AS last_shown
       FROM usage_events
       WHERE event_type IN ('show', 'search') AND source = 'user' AND entry_ref IS NOT NULL
         AND datetime(created_at) >= datetime(?)
       GROUP BY entry_ref`,
    )
    .all(sinceIso) as Array<{ entry_ref: string; shows: number; searches: number; last_shown: string | null }>;
  return new Map(
    rows.map((row) => [
      row.entry_ref,
      {
        shows: row.shows,
        searches: row.searches,
        // SQLite's datetime() is UTC without a zone: say so, so it parses as UTC everywhere.
        lastShownAt: row.last_shown ? `${row.last_shown.replace(" ", "T")}Z` : null,
      },
    ]),
  );
}

/**
 * Count usage events of a given `event_type`.
 *
 * Lifted verbatim from `akm improve` (improve.ts) where the show-event count
 * was hand-rolled inline to drive the warning that the retrieval scope matches
 * only search-retrieved assets.
 */
export function countUsageEventsByType(db: Database, eventType: string): number {
  return (db.prepare("SELECT COUNT(*) AS cnt FROM usage_events WHERE event_type = ?").get(eventType) as { cnt: number })
    .cnt;
}

/**
 * Durable refs a user-attributed `search`, `curate` or `show` returned, or a
 * user `feedback` named, at or after `sinceIso`. Machine traffic (`improve`,
 * `task`, `audit`, `unknown`) is not demand, as in {@link countFeedbackSignalsByRef}.
 */
export function listUsedEntryRefs(db: Database, sinceIso: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT entry_ref FROM usage_events
       WHERE event_type IN ('search', 'curate', 'show', 'feedback')
         AND source = 'user'
         AND entry_ref IS NOT NULL
         AND julianday(created_at) >= julianday(?)`,
    )
    .all(sinceIso) as Array<{ entry_ref: string }>;
  return rows.map((row) => row.entry_ref);
}

/**
 * The distinct query texts of user `search` and `curate` events that returned
 * `conceptId` (any bundle prefix), most recent first.
 */
export function listRetrievalQueries(db: Database, conceptId: string): string[] {
  const rows = db
    .prepare(
      `SELECT query, MAX(created_at) AS last_at FROM usage_events
       WHERE event_type IN ('search', 'curate')
         AND source = 'user'
         AND query IS NOT NULL AND trim(query) != ''
         AND instr(entry_ref, '//') > 0
         AND substr(entry_ref, instr(entry_ref, '//') + 2) = ?
       GROUP BY query
       ORDER BY last_at DESC`,
    )
    .all(conceptId) as Array<{ query: string }>;
  return rows.map((row) => row.query);
}

/**
 * Distinct queries of searches that returned nothing in the last `sinceDays`
 * days, most recent first (at most 20). Reads the per-search summary row
 * `logSearchEvent` writes: no `entry_ref`, `resultCount` in its metadata.
 */
export function listZeroResultSearchQueries(db: Database, sinceDays = 30): string[] {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT query, MAX(created_at) AS last_at FROM usage_events
       WHERE event_type = 'search'
         AND entry_ref IS NULL
         AND query IS NOT NULL
         AND json_extract(metadata, '$.resultCount') = 0
         AND julianday(created_at) >= julianday(?)
       GROUP BY query
       ORDER BY last_at DESC
       LIMIT 20`,
    )
    .all(since) as Array<{ query: string }>;
  return rows.map((row) => row.query);
}

/**
 * Usage events older than this many days are purged on every `akm index`, once metrics.db has folded their
 * day (`purgeFoldedUsageEvents`).
 */
export const USAGE_EVENT_RETENTION_DAYS = 90;

/**
 * Rewrite every `usage_events.entry_ref` naming `oldBundleId` to `newBundleId`
 * (`akm bundle rename`). Search ranking counts feedback by `entry_ref`, so an
 * event left under the old prefix stops counting for the renamed bundle's
 * assets. `entry_id` is untouched: the rename keeps every entry's row id. A
 * legacy unqualified ref is not matched by the `<old>//` prefix and is left alone.
 * Returns the number of rows rewritten.
 */
export function renameUsageEventRefs(db: Database, oldBundleId: string, newBundleId: string): number {
  const prefix = `${oldBundleId}//`;
  return Number(
    db
      .prepare(
        `UPDATE usage_events SET entry_ref = ? || substr(entry_ref, length(?) + 1) WHERE substr(entry_ref, 1, length(?)) = ?`,
      )
      .run(newBundleId, oldBundleId, prefix, prefix).changes,
  );
}
