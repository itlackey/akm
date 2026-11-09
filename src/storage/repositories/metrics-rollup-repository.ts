// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Read side of metrics.db (`core/metrics-db.ts`; the fold in `commands/metrics/fold.ts` writes it), for the
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

const DAY_MS = 86_400_000;

function utcDay(ms: number): string {
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
