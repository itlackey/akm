// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Read side of metrics.db (`core/metrics-db.ts`; the fold in `indexer/metrics/fold.ts` writes it), for the
 * readers that need a window older than state.db's raw rows.
 *
 * One rule decides where each day comes from, so a window spanning both stores neither double counts nor
 * drops a day: a UTC day older than the oldest raw row the window returns (of that kind) is read from
 * metrics.db, every other day from state.db. A purge deletes whole UTC days, so no day is in
 * both. A rollup day belongs to the window that contains its midnight ({@link rollupDayRange}): adjacent
 * windows share no day, and a window that starts mid-day does not include that day's rollup.
 */

import fs from "node:fs";
import path from "node:path";
import type { MetricsLlmRow } from "../../commands/metrics/types";
import { warnOnce } from "../../core/warn";
import { type Database, openDatabase } from "../database";
import { applyReadonlyPragmas } from "../sqlite-pragmas";
import { withImmediateTransaction } from "../sqlite-transaction";
import { FOLD_SOURCES, type FoldSourceKey, type ImproveRunSourceRow } from "./metrics-repository";

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` (UTC) of an epoch-ms instant. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` of the first UTC midnight at or after `iso`. */
function ceilDay(iso: string): string {
  const ms = Date.parse(iso);
  return utcDay(Math.ceil(ms / DAY_MS) * DAY_MS);
}

/**
 * The days `[from, to)` of the window `[sinceIso, untilIso)` that metrics.db serves: those whose midnight is
 * in the window and that come before the day of `oldestRaw`, the oldest raw row of the same kind (events of one
 * type, usage rows of one source) that state.db returned for the window; none returned means every day of the
 * window is a rollup day. A purge removes whole days, so a day with raw rows of the kind is never also a rollup
 * day, and a day with none has no rollup rows of it either. `undefined` when the raw rows cover the window.
 */
export function rollupDayRange(
  sinceIso: string,
  untilIso: string,
  oldestRaw: string | undefined,
): { from: string; to: string } | undefined {
  const from = ceilDay(sinceIso);
  const upper = ceilDay(untilIso);
  const boundary = oldestRaw === undefined ? upper : oldestRaw.slice(0, 10);
  const to = upper < boundary ? upper : boundary;
  return from < to ? { from, to } : undefined;
}

/** metrics.db beside a state.db file. */
export function metricsDbPathBeside(stateDbPath: string): string {
  return path.join(path.dirname(stateDbPath), "metrics.db");
}

/** The file a handle was opened on, or undefined for an in-memory or unnamed database. */
function mainFile(db: Database): string | undefined {
  try {
    const rows = db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>;
    const file = rows.find((row) => row.name === "main")?.file;
    return file ? file : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run `fn` on metrics.db beside the state.db file (`stateDb`'s own, or `stateDbPath`), opened read-only. The
 * result is `undefined` when there is no metrics.db yet, or it cannot be read (one warning for a file that
 * exists but cannot be read), so a reader falls back to the raw rows it already has.
 */
export function withMetricsHistory<T>(
  stateDb: Database | undefined,
  stateDbPath: string | undefined,
  fn: (metrics: Database) => T,
): T | undefined {
  const stateFile = stateDbPath ?? (stateDb ? mainFile(stateDb) : undefined);
  if (!stateFile) return undefined;
  const file = metricsDbPathBeside(stateFile);
  if (!fs.existsSync(file)) return undefined;
  let metrics: Database | undefined;
  try {
    metrics = openDatabase(file, { readonly: true, create: false });
    applyReadonlyPragmas(metrics);
    return fn(metrics);
  } catch (error) {
    warnOnce(
      "metrics-db-unreadable",
      `[metrics.db] could not be read (${error instanceof Error ? error.message : String(error)}); windows older than state.db's rows are incomplete.`,
    );
    return undefined;
  } finally {
    try {
      metrics?.close();
    } catch {
      // read-only handle; nothing to lose
    }
  }
}

// ── Rollup rows ─────────────────────────────────────────────────────────────

export interface UsageDailyRow {
  day: string;
  event_type: string;
  /** `''` for a summary row (a search or curate has one with no ref). */
  ref: string;
  n: number;
  positive: number;
  negative: number;
  hits: number;
  zero: number;
  last_at: string;
}

export interface QueryDailyRow {
  day: string;
  query: string;
  n: number;
  results_n: number;
  results_sum: number;
  zero_n: number;
  last_at: string;
}

export interface TagDailyRow {
  tag: string;
  positive: number;
  negative: number;
}

export interface SelectDailyRow {
  day: string;
  ref: string;
  n: number;
  last_at: string;
}

export function readUsageDaily(db: Database, range: { from: string; to: string }, source: string): UsageDailyRow[] {
  return db
    .prepare(
      `SELECT day, event_type, ref, n, positive, negative, hits, zero, last_at FROM usage_daily
       WHERE day >= ? AND day < ? AND source = ? ORDER BY day, event_type, ref`,
    )
    .all(range.from, range.to, source) as UsageDailyRow[];
}

export function readQueryDaily(db: Database, range: { from: string; to: string }, source: string): QueryDailyRow[] {
  return db
    .prepare(
      `SELECT day, query, n, results_n, results_sum, zero_n, last_at FROM query_daily
       WHERE day >= ? AND day < ? AND source = ? ORDER BY day, query`,
    )
    .all(range.from, range.to, source) as QueryDailyRow[];
}

export function readTagDaily(db: Database, range: { from: string; to: string }, source: string): TagDailyRow[] {
  return db
    .prepare(
      `SELECT tag, SUM(positive) AS positive, SUM(negative) AS negative FROM feedback_tag_daily
       WHERE day >= ? AND day < ? AND source = ? GROUP BY tag ORDER BY tag`,
    )
    .all(range.from, range.to, source) as TagDailyRow[];
}

/** Selects of the days, for `source` and for those recorded before selects carried one (`''`). */
export function readSelectDaily(db: Database, range: { from: string; to: string }, source: string): SelectDailyRow[] {
  return db
    .prepare(
      `SELECT day, ref, SUM(n) AS n, MAX(last_at) AS last_at FROM select_daily
       WHERE day >= ? AND day < ? AND (source = ? OR source = '') GROUP BY day, ref ORDER BY day, ref`,
    )
    .all(range.from, range.to, source) as SelectDailyRow[];
}

/** The days' histograms of one latency `kind` (and `source` for `search`), summed bucket by bucket. */
export function readLatencyHistograms(
  db: Database,
  range: { from: string; to: string },
  kind: "search" | "index",
  source: string,
): number[][] {
  const rows = db
    .prepare("SELECT hist_json FROM latency_daily WHERE day >= ? AND day < ? AND kind = ? AND source = ?")
    .all(range.from, range.to, kind, kind === "index" ? "" : source) as Array<{ hist_json: string }>;
  const out: number[][] = [];
  for (const row of rows) {
    try {
      const parsed: unknown = JSON.parse(row.hist_json);
      if (Array.isArray(parsed)) out.push(parsed.map((n) => (typeof n === "number" ? n : 0)));
    } catch {
      // A damaged histogram adds nothing.
    }
  }
  return out;
}

/** LLM rows of the days, in the shape the report and the dashboard already carry. */
export function readLlmDaily(db: Database, range: { from: string; to: string }): MetricsLlmRow[] {
  const rows = db
    .prepare(
      `SELECT day, stage, process, engine, model, outcome, calls, duration_ms, prompt_tokens, completion_tokens,
              total_tokens, reasoning_tokens, usage_calls, reasoning_calls
       FROM llm_daily WHERE day >= ? AND day < ? ORDER BY day, stage, process, engine, model, outcome`,
    )
    .all(range.from, range.to) as Array<{
    day: string;
    stage: string;
    process: string;
    engine: string;
    model: string;
    outcome: "success" | "error";
    calls: number;
    duration_ms: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    reasoning_tokens: number;
    usage_calls: number;
    reasoning_calls: number;
  }>;
  return rows.map((r) => ({
    day: r.day,
    ...(r.stage ? { stage: r.stage } : {}),
    ...(r.process ? { process: r.process } : {}),
    ...(r.engine ? { engine: r.engine } : {}),
    ...(r.model ? { model: r.model } : {}),
    outcome: r.outcome,
    calls: r.calls,
    durationMs: r.duration_ms,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    totalTokens: r.total_tokens,
    reasoningTokens: r.reasoning_tokens,
    usageCalls: r.usage_calls,
    reasoningCalls: r.reasoning_calls,
  }));
}

/** How many events of `eventType` the days hold (all of `event_daily`'s counts). */
export function readEventDailyCount(db: Database, range: { from: string; to: string }, eventType: string): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(n), 0) AS n FROM event_daily WHERE day >= ? AND day < ? AND event_type = ?")
    .get(range.from, range.to, eventType) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** The days' `improve_skipped` tallies, rebuilt as `akm health` builds one from events (the latest day's snapshot wins). */
export function readSkipDaily(
  db: Database,
  range: { from: string; to: string },
): { summed: Record<string, number>; latestSnapshot: Record<string, number> } {
  const rows = db
    .prepare("SELECT day, reason, summed, snapshot FROM improve_skip_daily WHERE day >= ? AND day < ? ORDER BY day")
    .all(range.from, range.to) as Array<{ day: string; reason: string; summed: number; snapshot: number | null }>;
  const summed: Record<string, number> = {};
  const latestSnapshot: Record<string, number> = {};
  for (const row of rows) {
    if (row.summed > 0) summed[row.reason] = (summed[row.reason] ?? 0) + row.summed;
    if (row.snapshot !== null) latestSnapshot[row.reason] = row.snapshot;
  }
  return { summed, latestSnapshot };
}

/** The first folded day, or undefined for an empty metrics.db. */
export function firstFoldedDay(db: Database): string | undefined {
  const row = db.prepare("SELECT MIN(day) AS day FROM folded_day").get() as { day: string | null } | undefined;
  return row?.day ?? undefined;
}

// ── Fold writes (metrics.db) ────────────────────────────────────────────────

/** Source rows folded for one day, per table: what the day's marker covers. */
export interface FoldedCounts {
  events: number;
  usage: number;
  runs: number;
}

/** Every folded day with the counts its marker covers: the purge guard. */
export type FoldedDays = ReadonlyMap<string, FoldedCounts>;

export function readFoldedDays(metricsDb: Database): Map<string, FoldedCounts> {
  const rows = metricsDb.prepare("SELECT day, src_events, src_usage, src_runs FROM folded_day").all() as Array<{
    day: string;
    src_events: number;
    src_usage: number;
    src_runs: number;
  }>;
  return new Map(rows.map((r) => [r.day, { events: r.src_events, usage: r.src_usage, runs: r.src_runs }]));
}

/** One day's marker; read inside the day's transaction, where no other writer can change it. */
export function readFoldedDay(metricsDb: Database, day: string): FoldedCounts | undefined {
  return readFoldedDays(metricsDb).get(day);
}

export function writeFoldedDay(metricsDb: Database, day: string, foldedAt: string, counts: FoldedCounts): void {
  metricsDb
    .prepare(
      "INSERT OR REPLACE INTO folded_day (day, folded_at, src_events, src_usage, src_runs) VALUES (?, ?, ?, ?, ?)",
    )
    .run(day, foldedAt, counts.events, counts.usage, counts.runs);
}

export interface EventsDayRollup {
  byType: Array<{ eventType: string; n: number }>;
  llm: Array<MetricsLlmRow & { histJson: string }>;
  selects: Array<{ ref: string; source: string; n: number; lastAt: string }>;
  skips: Array<{ reason: string; summed: number; snapshot: number | null }>;
  /** The index-run duration histogram, when the day had index runs. */
  indexHistJson?: string;
}

/** Replace one day's event-derived rollups (never added to, so a refold cannot double count). */
export function replaceEventsDayRollup(metricsDb: Database, day: string, data: EventsDayRollup): void {
  for (const table of ["event_daily", "llm_daily", "select_daily", "improve_skip_daily"]) {
    metricsDb.prepare(`DELETE FROM ${table} WHERE day = ?`).run(day);
  }
  metricsDb.prepare("DELETE FROM latency_daily WHERE day = ? AND kind = 'index'").run(day);

  const insertType = metricsDb.prepare("INSERT INTO event_daily (day, event_type, n) VALUES (?, ?, ?)");
  for (const row of data.byType) insertType.run(day, row.eventType, row.n);

  const insertLlm = metricsDb.prepare(
    `INSERT INTO llm_daily (day, stage, process, engine, model, outcome, calls, duration_ms, prompt_tokens,
       completion_tokens, total_tokens, reasoning_tokens, usage_calls, reasoning_calls, duration_hist_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of data.llm) {
    insertLlm.run(
      day,
      row.stage ?? "",
      row.process ?? "",
      row.engine ?? "",
      row.model ?? "",
      row.outcome,
      row.calls,
      row.durationMs,
      row.promptTokens,
      row.completionTokens,
      row.totalTokens,
      row.reasoningTokens,
      row.usageCalls,
      row.reasoningCalls,
      row.histJson,
    );
  }

  const insertSelect = metricsDb.prepare(
    "INSERT INTO select_daily (day, ref, source, n, last_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (const entry of data.selects) insertSelect.run(day, entry.ref, entry.source, entry.n, entry.lastAt);

  const insertSkip = metricsDb.prepare(
    "INSERT INTO improve_skip_daily (day, reason, summed, snapshot) VALUES (?, ?, ?, ?)",
  );
  for (const skip of data.skips) insertSkip.run(day, skip.reason, skip.summed, skip.snapshot);

  if (data.indexHistJson !== undefined) {
    metricsDb
      .prepare("INSERT INTO latency_daily (day, kind, source, hist_json) VALUES (?, 'index', '', ?)")
      .run(day, data.indexHistJson);
  }
}

export interface UsageDayRollup {
  usage: Array<UsageDailyRow & { source: string }>;
  queries: Array<QueryDailyRow & { source: string }>;
  tags: Array<TagDailyRow & { source: string }>;
  latency: Array<{ source: string; histJson: string }>;
}

/** Replace one day's usage-derived rollups. */
export function replaceUsageDayRollup(metricsDb: Database, day: string, data: UsageDayRollup): void {
  for (const table of ["usage_daily", "query_daily", "feedback_tag_daily"]) {
    metricsDb.prepare(`DELETE FROM ${table} WHERE day = ?`).run(day);
  }
  metricsDb.prepare("DELETE FROM latency_daily WHERE day = ? AND kind = 'search'").run(day);

  const insertUsage = metricsDb.prepare(
    "INSERT INTO usage_daily (day, event_type, source, ref, n, positive, negative, hits, zero, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const u of data.usage) {
    insertUsage.run(day, u.event_type, u.source, u.ref, u.n, u.positive, u.negative, u.hits, u.zero, u.last_at);
  }
  const insertQuery = metricsDb.prepare(
    "INSERT INTO query_daily (day, source, query, n, results_n, results_sum, zero_n, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const q of data.queries) {
    insertQuery.run(day, q.source, q.query, q.n, q.results_n, q.results_sum, q.zero_n, q.last_at);
  }
  const insertTag = metricsDb.prepare(
    "INSERT INTO feedback_tag_daily (day, source, tag, positive, negative) VALUES (?, ?, ?, ?, ?)",
  );
  for (const t of data.tags) insertTag.run(day, t.source, t.tag, t.positive, t.negative);
  const insertLatency = metricsDb.prepare(
    "INSERT INTO latency_daily (day, kind, source, hist_json) VALUES (?, 'search', ?, ?)",
  );
  for (const l of data.latency) insertLatency.run(day, l.source, l.histJson);
}

/** A run never changes once recorded: the row already folded is kept. */
export function insertImproveRunsOnce(metricsDb: Database, rows: readonly ImproveRunSourceRow[]): void {
  const insert = metricsDb.prepare(
    `INSERT OR IGNORE INTO improve_runs (id, started_at, completed_at, stash_dir, dry_run, strategy, scope_mode,
       scope_value, guidance, ok, result_json, metrics_json, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    insert.run(
      r.id,
      r.started_at,
      r.completed_at,
      r.stash_dir,
      r.dry_run,
      r.strategy,
      r.scope_mode,
      r.scope_value,
      r.guidance,
      r.ok,
      r.result_json,
      r.metrics_json,
      r.metadata_json,
    );
  }
}

// ── Guarded purge (state.db) ────────────────────────────────────────────────

/** Days per DELETE, under SQLite's bound-parameter ceiling. */
const PURGE_CHUNK = 400;

/**
 * Delete rows of whole UTC days older than `retentionDays`, but only the days
 * whose marker covers every row about to go. A day with no marker, or fewer
 * folded rows than the table now holds, keeps its rows. The cutoff is the start
 * of the UTC day `retentionDays` ago, so a day is kept or purged whole. The
 * count and the delete share one transaction, so a row that lands between them
 * is not deleted unfolded.
 */
function purgeFoldedDays(
  db: Database,
  key: FoldSourceKey,
  retentionDays: number,
  folded: FoldedDays,
  nowMs: number,
): number {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
  const { table, column } = FOLD_SOURCES[key];
  const cutoffDay = utcDay(nowMs - retentionDays * DAY_MS);
  return withImmediateTransaction(db, () => {
    const counts = db
      .prepare(`SELECT substr(${column}, 1, 10) AS day, COUNT(*) AS n FROM ${table} WHERE ${column} < ? GROUP BY day`)
      .all(cutoffDay) as Array<{ day: string; n: number }>;
    const purgeable = counts.filter((c) => (folded.get(c.day)?.[key] ?? 0) >= c.n).map((c) => c.day);
    let deleted = 0;
    for (let i = 0; i < purgeable.length; i += PURGE_CHUNK) {
      const chunk = purgeable.slice(i, i + PURGE_CHUNK);
      const result = db
        .prepare(
          `DELETE FROM ${table} WHERE ${column} < ? AND substr(${column}, 1, 10) IN (${chunk.map(() => "?").join(",")})`,
        )
        .run(cutoffDay, ...chunk);
      deleted += Number(result.changes ?? 0);
    }
    return deleted;
  });
}

/** Folded-day-guarded replacement for the plain age purge of `events`. */
export function purgeFoldedEvents(db: Database, retentionDays: number, folded: FoldedDays, nowMs = Date.now()): number {
  return purgeFoldedDays(db, "events", retentionDays, folded, nowMs);
}

/** Folded-day-guarded replacement for the plain age purge of `improve_runs`. */
export function purgeFoldedImproveRuns(
  db: Database,
  retentionDays: number,
  folded: FoldedDays,
  nowMs = Date.now(),
): number {
  return purgeFoldedDays(db, "runs", retentionDays, folded, nowMs);
}

/** Folded-day-guarded replacement for the plain age purge of `usage_events`. */
export function purgeFoldedUsageEvents(
  db: Database,
  retentionDays: number,
  folded: FoldedDays,
  nowMs = Date.now(),
): number {
  return purgeFoldedDays(db, "usage", retentionDays, folded, nowMs);
}
