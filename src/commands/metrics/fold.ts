// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The fold: state.db's raw `events`, `usage_events` and `improve_runs` rows into
 * metrics.db's daily rollups, one closed UTC day at a time, BEFORE a purge
 * deletes them (see `core/metrics-db.ts` for the tables).
 *
 * - Idempotent per day. A day's rollups are replaced, never added to, so folding
 *   the same day twice, or from two sources that both hold it, cannot double count.
 * - `folded_day` records the source row counts folded per table. A day is folded
 *   again only when a source holds MORE rows of a table than the marker covers
 *   (late rows, or a fuller source such as a backup); a source with fewer rows
 *   never overwrites a fuller fold.
 * - Each day commits in one transaction on metrics.db, rollups and marker
 *   together: a crash leaves no marker, so nothing is purged and the next fold
 *   redoes the day. No ATTACH; state.db is only ever read here.
 * - The purge functions below delete a day's rows only when that day's marker
 *   covers them. Nothing in the hot commands calls any of this.
 */

import { openMetricsDatabase } from "../../core/metrics-db";
import { addToHistogram, emptyHistogram } from "../../core/metrics-histogram";
import { warnOnce } from "../../core/warn";
import { LLM_USAGE_EVENT } from "../../llm/usage-persist";
import { decodeLlmUsageRecord } from "../../llm/usage-telemetry";
import { type Database, openDatabase } from "../../storage/database";
import { type EventRow, eventRowToEnvelope } from "../../storage/repositories/events-repository";
import {
  listIndexCompletedEvents,
  listSelectEvents,
  listUsageEventRows,
} from "../../storage/repositories/metrics-repository";
import { applyReadonlyPragmas } from "../../storage/sqlite-pragmas";
import { withImmediateTransaction } from "../../storage/sqlite-transaction";
import { tallyImproveSkipEvents } from "../health/improve-metrics";
import { dedupeSelects, indexRunsFromEvents, llmRowsFromEvents, toUsageRow } from "./collect";
import type { MetricsUsageRow } from "./types";

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` (UTC) of an epoch-ms instant. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function nextDay(day: string): string {
  return utcDay(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS);
}

// ── Markers ─────────────────────────────────────────────────────────────────

/** Source rows folded for one day, per table. */
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

// ── Source reads ────────────────────────────────────────────────────────────

function hasTable(db: Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/** Row counts per UTC day for the rows before `beforeDay`. */
function countsByDay(db: Database, table: string, column: string, beforeDay: string): Map<string, number> {
  if (!hasTable(db, table)) return new Map();
  const rows = db
    .prepare(`SELECT substr(${column}, 1, 10) AS day, COUNT(*) AS n FROM ${table} WHERE ${column} < ? GROUP BY day`)
    .all(beforeDay) as Array<{ day: string; n: number }>;
  return new Map(rows.map((r) => [r.day, r.n]));
}

// ── Per-day aggregation ─────────────────────────────────────────────────────

interface UsageAgg {
  usage: Map<string, { n: number; positive: number; negative: number; hits: number; zero: number; lastAt: string }>;
  queries: Map<
    string,
    { source: string; query: string; n: number; resultsN: number; resultsSum: number; zeroN: number; lastAt: string }
  >;
  tags: Map<string, { source: string; tag: string; positive: number; negative: number }>;
  searchLatency: Map<string, number[]>;
}

function aggregateUsage(rows: readonly MetricsUsageRow[]): UsageAgg {
  const agg: UsageAgg = { usage: new Map(), queries: new Map(), tags: new Map(), searchLatency: new Map() };
  for (const row of rows) {
    const isSummary = row.ref === undefined;
    const usageKey = JSON.stringify([row.eventType, row.source, row.ref ?? ""]);
    let u = agg.usage.get(usageKey);
    if (!u) {
      u = { n: 0, positive: 0, negative: 0, hits: 0, zero: 0, lastAt: row.at };
      agg.usage.set(usageKey, u);
    }
    u.n += 1;
    if (row.signal === "positive") u.positive += 1;
    if (row.signal === "negative") u.negative += 1;
    if (row.eventType === "search" && isSummary) {
      if ((row.resultCount ?? 0) > 0) u.hits += 1;
      if (row.resultCount === 0) u.zero += 1;
    }
    if (row.at > u.lastAt) u.lastAt = row.at;

    if (row.eventType === "search" && isSummary) {
      if (row.totalMs !== undefined && row.totalMs >= 0) {
        const hist = agg.searchLatency.get(row.source) ?? emptyHistogram();
        addToHistogram(hist, row.totalMs);
        agg.searchLatency.set(row.source, hist);
      }
      const query = row.query?.trim();
      if (query) {
        const key = JSON.stringify([row.source, query]);
        let q = agg.queries.get(key);
        if (!q) {
          q = { source: row.source, query, n: 0, resultsN: 0, resultsSum: 0, zeroN: 0, lastAt: row.at };
          agg.queries.set(key, q);
        }
        q.n += 1;
        if (row.resultCount !== undefined) {
          q.resultsN += 1;
          q.resultsSum += row.resultCount;
        }
        if (row.resultCount === 0) q.zeroN += 1;
        if (row.at > q.lastAt) q.lastAt = row.at;
      }
    }

    if (row.eventType === "feedback" && row.signal !== undefined) {
      for (const tag of row.tags ?? []) {
        const key = JSON.stringify([row.source, tag]);
        const t = agg.tags.get(key) ?? { source: row.source, tag, positive: 0, negative: 0 };
        t[row.signal] += 1;
        agg.tags.set(key, t);
      }
    }
  }
  return agg;
}

// ── Day folds (each runs inside the day's transaction) ──────────────────────

function foldEventsDay(source: Database, metricsDb: Database, day: string): void {
  const next = nextDay(day);
  metricsDb.prepare("DELETE FROM event_daily WHERE day = ?").run(day);
  metricsDb.prepare("DELETE FROM llm_daily WHERE day = ?").run(day);
  metricsDb.prepare("DELETE FROM select_daily WHERE day = ?").run(day);
  metricsDb.prepare("DELETE FROM improve_skip_daily WHERE day = ?").run(day);
  metricsDb.prepare("DELETE FROM latency_daily WHERE day = ? AND kind = 'index'").run(day);

  const byType = source
    .prepare("SELECT event_type, COUNT(*) AS n FROM events WHERE ts >= ? AND ts < ? GROUP BY event_type")
    .all(day, next) as Array<{ event_type: string; n: number }>;
  const insertType = metricsDb.prepare("INSERT INTO event_daily (day, event_type, n) VALUES (?, ?, ?)");
  for (const row of byType) insertType.run(day, row.event_type, row.n);

  // LLM calls: the per-day x stage x process x engine x model x outcome sums the report already
  // uses (`llmRowsFromEvents`), plus a duration histogram per row.
  const llmEvents = (
    source
      .prepare(
        "SELECT id, event_type, ts, ref, metadata_json FROM events WHERE event_type = ? AND ts >= ? AND ts < ? ORDER BY id",
      )
      .all(LLM_USAGE_EVENT, day, next) as EventRow[]
  ).map(eventRowToEnvelope);
  const llmKey = (parts: Array<string | undefined>) => JSON.stringify(parts.map((p) => p ?? ""));
  const llmHists = new Map<string, number[]>();
  for (const event of llmEvents) {
    const record = decodeLlmUsageRecord(event.metadata);
    if (!record) continue;
    const key = llmKey([record.stage, record.process, record.engine, record.model, record.outcome]);
    const hist = llmHists.get(key) ?? emptyHistogram();
    addToHistogram(hist, record.durationMs);
    llmHists.set(key, hist);
  }
  const insertLlm = metricsDb.prepare(
    `INSERT INTO llm_daily (day, stage, process, engine, model, outcome, calls, duration_ms, prompt_tokens,
       completion_tokens, total_tokens, reasoning_tokens, usage_calls, reasoning_calls, duration_hist_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of llmRowsFromEvents(llmEvents)) {
    const hist = llmHists.get(llmKey([row.stage, row.process, row.engine, row.model, row.outcome])) ?? emptyHistogram();
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
      JSON.stringify(hist),
    );
  }

  // Selects, deduped by (searchId, ref) as the report does.
  const selects = new Map<string, { ref: string; source: string; n: number; lastAt: string }>();
  for (const select of dedupeSelects(listSelectEvents(source, day, next))) {
    const key = JSON.stringify([select.ref, select.source ?? ""]);
    const entry = selects.get(key) ?? { ref: select.ref, source: select.source ?? "", n: 0, lastAt: select.ts };
    entry.n += 1;
    if (select.ts > entry.lastAt) entry.lastAt = select.ts;
    selects.set(key, entry);
  }
  const insertSelect = metricsDb.prepare(
    "INSERT INTO select_daily (day, ref, source, n, last_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (const entry of selects.values()) insertSelect.run(day, entry.ref, entry.source, entry.n, entry.lastAt);

  // improve_skipped: what `akm health` counts, kept as the sums and latest snapshots it is built from.
  const skipEvents = (
    source
      .prepare(
        "SELECT id, event_type, ts, ref, metadata_json FROM events WHERE event_type = 'improve_skipped' AND ts >= ? AND ts < ? ORDER BY id",
      )
      .all(day, next) as EventRow[]
  ).map(eventRowToEnvelope);
  const tally = tallyImproveSkipEvents(skipEvents);
  const insertSkip = metricsDb.prepare(
    "INSERT INTO improve_skip_daily (day, reason, summed, snapshot) VALUES (?, ?, ?, ?)",
  );
  for (const reason of new Set([...Object.keys(tally.summed), ...Object.keys(tally.latestSnapshot)])) {
    insertSkip.run(day, reason, tally.summed[reason] ?? 0, tally.latestSnapshot[reason] ?? null);
  }

  // Index runs: how many, and how long (a histogram: medians do not roll up).
  const indexHist = emptyHistogram();
  let indexRuns = 0;
  for (const run of indexRunsFromEvents(listIndexCompletedEvents(source, day, next))) {
    addToHistogram(indexHist, run.totalMs);
    indexRuns += 1;
  }
  if (indexRuns > 0) {
    metricsDb
      .prepare("INSERT INTO latency_daily (day, kind, source, hist_json) VALUES (?, 'index', '', ?)")
      .run(day, JSON.stringify(indexHist));
  }
}

function foldUsageDay(metricsDb: Database, day: string, rows: readonly MetricsUsageRow[]): void {
  metricsDb.prepare("DELETE FROM usage_daily WHERE day = ?").run(day);
  metricsDb.prepare("DELETE FROM query_daily WHERE day = ?").run(day);
  metricsDb.prepare("DELETE FROM feedback_tag_daily WHERE day = ?").run(day);
  metricsDb.prepare("DELETE FROM latency_daily WHERE day = ? AND kind = 'search'").run(day);
  const agg = aggregateUsage(rows);
  const insertUsage = metricsDb.prepare(
    "INSERT INTO usage_daily (day, event_type, source, ref, n, positive, negative, hits, zero, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const [key, u] of agg.usage) {
    const [eventType, source, ref] = JSON.parse(key) as [string, string, string];
    insertUsage.run(day, eventType, source, ref, u.n, u.positive, u.negative, u.hits, u.zero, u.lastAt);
  }
  const insertQuery = metricsDb.prepare(
    "INSERT INTO query_daily (day, source, query, n, results_n, results_sum, zero_n, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const q of agg.queries.values()) {
    insertQuery.run(day, q.source, q.query, q.n, q.resultsN, q.resultsSum, q.zeroN, q.lastAt);
  }
  const insertTag = metricsDb.prepare(
    "INSERT INTO feedback_tag_daily (day, source, tag, positive, negative) VALUES (?, ?, ?, ?, ?)",
  );
  for (const t of agg.tags.values()) insertTag.run(day, t.source, t.tag, t.positive, t.negative);
  const insertLatency = metricsDb.prepare(
    "INSERT INTO latency_daily (day, kind, source, hist_json) VALUES (?, 'search', ?, ?)",
  );
  for (const [source, hist] of agg.searchLatency) insertLatency.run(day, source, JSON.stringify(hist));
}

/**
 * A run's `result_json` without the persisted ref list `strategyFilteredRefs`
 * (about 365 KB a run, a list of refs rather than a metric); its length is kept
 * as `strategyFilteredCount`. A value that is not a JSON object is kept as it is.
 */
export function slimImproveResultJson(resultJson: string): string {
  try {
    const parsed: unknown = JSON.parse(resultJson);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return resultJson;
    const result = parsed as Record<string, unknown>;
    if (!("strategyFilteredRefs" in result)) return resultJson;
    const refs = result.strategyFilteredRefs;
    delete result.strategyFilteredRefs;
    if (Array.isArray(refs)) result.strategyFilteredCount = refs.length;
    return JSON.stringify(result);
  } catch {
    return resultJson;
  }
}

function foldRunsDay(source: Database, metricsDb: Database, day: string): void {
  const rows = source
    .prepare(
      `SELECT id, started_at, completed_at, stash_dir, dry_run, strategy, scope_mode, scope_value, guidance, ok,
              result_json, metrics_json, metadata_json
       FROM improve_runs WHERE started_at >= ? AND started_at < ?`,
    )
    .all(day, nextDay(day)) as Array<{
    id: string;
    started_at: string;
    completed_at: string | null;
    stash_dir: string;
    dry_run: number;
    strategy: string | null;
    scope_mode: string;
    scope_value: string | null;
    guidance: string | null;
    ok: number;
    result_json: string;
    metrics_json: string | null;
    metadata_json: string;
  }>;
  // A run never changes once recorded: keep the row already folded.
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
      slimImproveResultJson(r.result_json),
      r.metrics_json,
      r.metadata_json,
    );
  }
}

// ── foldClosedDays ──────────────────────────────────────────────────────────

export interface FoldReport {
  /** Days written (new, or redone because a source held more rows). */
  folded: string[];
  /** Days whose fold failed and rolled back: their rows are not purgeable. */
  failed: Array<{ day: string; error: string }>;
}

/**
 * Fold every closed UTC day (before today) of `source` that metrics.db does not
 * yet cover. `source` is an open state.db handle, or the path of a state.db file
 * (opened read-only and closed here): the live database, or a copy such as a
 * backup, whose rows fold into the same days without double counting. A source
 * without a table is read as having no rows of it.
 */
export function foldClosedDays(
  source: Database | string,
  metricsDb: Database,
  opts: { nowMs?: number } = {},
): FoldReport {
  const owned = typeof source === "string" ? openDatabase(source, { readonly: true, create: false }) : undefined;
  const db = owned ?? (source as Database);
  try {
    if (owned) applyReadonlyPragmas(owned);
    return foldFrom(db, metricsDb, opts.nowMs ?? Date.now());
  } finally {
    owned?.close();
  }
}

/** The closed UTC days of `source` that a fold would write now, with the per-table counts that decide it. */
function pendingDays(source: Database, folded: FoldedDays, nowMs: number) {
  const today = utcDay(nowMs);
  const eventCounts = countsByDay(source, "events", "ts", today);
  const usageCounts = countsByDay(source, "usage_events", "created_at", today);
  const runCounts = countsByDay(source, "improve_runs", "started_at", today);
  const days = [...new Set([...eventCounts.keys(), ...usageCounts.keys(), ...runCounts.keys()])].sort();
  const need = (day: string, counts: Map<string, number>, field: keyof FoldedCounts) =>
    (counts.get(day) ?? 0) > (folded.get(day)?.[field] ?? 0);
  const todo = days.filter(
    (day) => need(day, eventCounts, "events") || need(day, usageCounts, "usage") || need(day, runCounts, "runs"),
  );
  return { todo, eventCounts, usageCounts, runCounts, need };
}

/**
 * The closed UTC days `source` holds rows of that `folded` does not cover (what the next fold would write),
 * oldest first: what `akm health` reports when the fold has not run for a while.
 */
export function unfoldedClosedDays(source: Database, folded: FoldedDays, nowMs: number): string[] {
  return pendingDays(source, folded, nowMs).todo;
}

function foldFrom(source: Database, metricsDb: Database, nowMs: number): FoldReport {
  const folded = readFoldedDays(metricsDb);
  const report: FoldReport = { folded: [], failed: [] };
  const { todo, eventCounts, usageCounts, runCounts, need } = pendingDays(source, folded, nowMs);
  if (todo.length === 0) return report;

  // usage_events has no index on created_at: read the needed range once and group it by day.
  const usageDays = new Set(todo.filter((day) => need(day, usageCounts, "usage")));
  const usageByDay = new Map<string, MetricsUsageRow[]>();
  if (usageDays.size > 0 && hasTable(source, "usage_events")) {
    const first = [...usageDays].sort()[0] as string;
    const last = [...usageDays].sort().at(-1) as string;
    for (const row of listUsageEventRows(source, {
      sinceIso: `${first}T00:00:00.000Z`,
      untilIso: `${nextDay(last)}T00:00:00.000Z`,
    })) {
      const mapped = toUsageRow(row);
      const day = mapped.at.slice(0, 10);
      if (!usageDays.has(day)) continue;
      const list = usageByDay.get(day) ?? [];
      list.push(mapped);
      usageByDay.set(day, list);
    }
  }

  for (const day of todo) {
    const doEvents = need(day, eventCounts, "events");
    const doUsage = need(day, usageCounts, "usage");
    const doRuns = need(day, runCounts, "runs");
    try {
      withImmediateTransaction(metricsDb, () => {
        if (doEvents) foldEventsDay(source, metricsDb, day);
        if (doUsage) foldUsageDay(metricsDb, day, usageByDay.get(day) ?? []);
        if (doRuns) foldRunsDay(source, metricsDb, day);
        const previous = folded.get(day);
        metricsDb
          .prepare(
            "INSERT OR REPLACE INTO folded_day (day, folded_at, src_events, src_usage, src_runs) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            day,
            new Date(nowMs).toISOString(),
            doEvents ? (eventCounts.get(day) ?? 0) : (previous?.events ?? 0),
            doUsage ? (usageCounts.get(day) ?? 0) : (previous?.usage ?? 0),
            doRuns ? (runCounts.get(day) ?? 0) : (previous?.runs ?? 0),
          );
      });
      report.folded.push(day);
    } catch (error) {
      report.failed.push({ day, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}

// ── Guarded purge ───────────────────────────────────────────────────────────

/** Days per DELETE, under SQLite's bound-parameter ceiling. */
const PURGE_CHUNK = 400;

/**
 * Delete rows of whole UTC days older than `retentionDays`, but only the days
 * whose marker covers every row about to go. A day with no marker, or fewer
 * folded rows than the table now holds, keeps its rows. The cutoff is the start
 * of the UTC day `retentionDays` ago, so a day is kept or purged whole.
 */
function purgeFoldedDays(
  db: Database,
  spec: { table: string; column: string; field: keyof FoldedCounts },
  retentionDays: number,
  folded: FoldedDays,
  nowMs: number,
): number {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
  const { table, column, field } = spec;
  const cutoffDay = utcDay(nowMs - retentionDays * DAY_MS);
  const counts = db
    .prepare(`SELECT substr(${column}, 1, 10) AS day, COUNT(*) AS n FROM ${table} WHERE ${column} < ? GROUP BY day`)
    .all(cutoffDay) as Array<{ day: string; n: number }>;
  const purgeable = counts.filter((c) => (folded.get(c.day)?.[field] ?? 0) >= c.n).map((c) => c.day);
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
}

/** Folded-day-guarded replacement for the plain age purge of `events`. */
export function purgeFoldedEvents(db: Database, retentionDays: number, folded: FoldedDays, nowMs = Date.now()): number {
  return purgeFoldedDays(db, { table: "events", column: "ts", field: "events" }, retentionDays, folded, nowMs);
}

/** Folded-day-guarded replacement for the plain age purge of `improve_runs`. */
export function purgeFoldedImproveRuns(
  db: Database,
  retentionDays: number,
  folded: FoldedDays,
  nowMs = Date.now(),
): number {
  return purgeFoldedDays(
    db,
    { table: "improve_runs", column: "started_at", field: "runs" },
    retentionDays,
    folded,
    nowMs,
  );
}

/** Folded-day-guarded replacement for the plain age purge of `usage_events`. */
export function purgeFoldedUsageEvents(
  db: Database,
  retentionDays: number,
  folded: FoldedDays,
  nowMs = Date.now(),
): number {
  return purgeFoldedDays(
    db,
    { table: "usage_events", column: "created_at", field: "usage" },
    retentionDays,
    folded,
    nowMs,
  );
}

/**
 * Fold state.db into metrics.db and return the folded days a purge may use, or
 * `undefined` when metrics.db cannot be opened or written: the caller then
 * skips its purge (one warning), so nothing is lost. A day that fails to fold
 * stays out of the map, so its rows stay too.
 */
export function foldBeforePurge(
  stateDb: Database,
  opts: { metricsDbPath?: string; nowMs?: number } = {},
): FoldedDays | undefined {
  try {
    const metricsDb = openMetricsDatabase(opts.metricsDbPath);
    try {
      const report = foldClosedDays(stateDb, metricsDb, { nowMs: opts.nowMs });
      if (report.failed.length > 0) {
        const first = report.failed[0];
        warnOnce(
          "metrics-fold-failed",
          `[metrics.db] could not fold ${report.failed.length} day(s) (first: ${first?.day}: ${first?.error}); their rows are kept.`,
        );
      }
      return readFoldedDays(metricsDb);
    } finally {
      metricsDb.close();
    }
  } catch (error) {
    warnOnce(
      "metrics-db-unavailable",
      `[metrics.db] could not be opened or written (${error instanceof Error ? error.message : String(error)}); the purge of state.db history is skipped so nothing is lost.`,
    );
    return undefined;
  }
}
