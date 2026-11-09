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
 * - A day's transaction first re-reads the marker and re-counts the source, and folds a table only when the
 *   source still holds MORE rows than the marker covers. Another process may have folded and purged the day
 *   since this one listed it; its rows are gone, so redoing the day would erase its rollups.
 * - The guarded purges live in `storage/repositories/metrics-rollup-repository.ts`: they delete a day's rows
 *   only when that day's marker covers them. Nothing in the hot commands calls any of this.
 */

import type { MetricsUsageRow } from "../../commands/metrics/types";
import { openMetricsDatabase } from "../../core/metrics-db";
import { addToHistogram, emptyHistogram } from "../../core/metrics-histogram";
import { warnOnce } from "../../core/warn";
import { LLM_USAGE_EVENT } from "../../llm/usage-persist";
import { decodeLlmUsageRecord } from "../../llm/usage-telemetry";
import { type Database, openDatabase } from "../../storage/database";
import { eventRowToEnvelope } from "../../storage/repositories/events-repository";
import {
  countEventsByType,
  countRowsByDay,
  countRowsInDay,
  hasTable,
  listEventsOfType,
  listImproveRunsStartedIn,
  listIndexCompletedEvents,
  listSelectEvents,
  listUsageEventRows,
} from "../../storage/repositories/metrics-repository";
import {
  type FoldedCounts,
  type FoldedDays,
  insertImproveRunsOnce,
  readFoldedDay,
  readFoldedDays,
  replaceEventsDayRollup,
  replaceUsageDayRollup,
  utcDay,
  writeFoldedDay,
} from "../../storage/repositories/metrics-rollup-repository";
import { applyReadonlyPragmas } from "../../storage/sqlite-pragmas";
import { withImmediateTransaction } from "../../storage/sqlite-transaction";
import {
  aggregateUsage,
  dedupeSelects,
  indexRunsFromEvents,
  llmRowsFromEvents,
  tallyImproveSkipEvents,
  toUsageRow,
} from "./rows";

const DAY_MS = 86_400_000;

function nextDay(day: string): string {
  return utcDay(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS);
}

// ── Day folds (each runs inside the day's transaction) ──────────────────────

function foldEventsDay(source: Database, metricsDb: Database, day: string): void {
  const next = nextDay(day);

  // LLM calls: the per-day x stage x process x engine x model x outcome sums the report already
  // uses (`llmRowsFromEvents`), plus a duration histogram per row.
  const llmEvents = listEventsOfType(source, LLM_USAGE_EVENT, day, next).map(eventRowToEnvelope);
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
  const llm = llmRowsFromEvents(llmEvents).map((row) => ({
    ...row,
    histJson: JSON.stringify(
      llmHists.get(llmKey([row.stage, row.process, row.engine, row.model, row.outcome])) ?? emptyHistogram(),
    ),
  }));

  // Selects, deduped by (searchId, ref) as the report does.
  const selects = new Map<string, { ref: string; source: string; n: number; lastAt: string }>();
  for (const select of dedupeSelects(listSelectEvents(source, day, next))) {
    const key = JSON.stringify([select.ref, select.source ?? ""]);
    const entry = selects.get(key) ?? { ref: select.ref, source: select.source ?? "", n: 0, lastAt: select.ts };
    entry.n += 1;
    if (select.ts > entry.lastAt) entry.lastAt = select.ts;
    selects.set(key, entry);
  }

  // improve_skipped: what `akm health` counts, kept as the sums and latest snapshots it is built from.
  const tally = tallyImproveSkipEvents(listEventsOfType(source, "improve_skipped", day, next).map(eventRowToEnvelope));
  const skips = [...new Set([...Object.keys(tally.summed), ...Object.keys(tally.latestSnapshot)])].map((reason) => ({
    reason,
    summed: tally.summed[reason] ?? 0,
    snapshot: tally.latestSnapshot[reason] ?? null,
  }));

  // Index runs: how many, and how long (a histogram: medians do not roll up).
  const indexHist = emptyHistogram();
  let indexRuns = 0;
  for (const run of indexRunsFromEvents(listIndexCompletedEvents(source, day, next))) {
    addToHistogram(indexHist, run.totalMs);
    indexRuns += 1;
  }

  replaceEventsDayRollup(metricsDb, day, {
    byType: countEventsByType(source, day, next),
    llm,
    selects: [...selects.values()],
    skips,
    ...(indexRuns > 0 ? { indexHistJson: JSON.stringify(indexHist) } : {}),
  });
}

function foldUsageDay(metricsDb: Database, day: string, rows: readonly MetricsUsageRow[]): void {
  const agg = aggregateUsage(rows);
  replaceUsageDayRollup(metricsDb, day, {
    usage: agg.usage,
    queries: agg.queries,
    tags: agg.tags,
    latency: agg.searchLatency.map((l) => ({ source: l.source, histJson: JSON.stringify(l.hist) })),
  });
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
  const rows = listImproveRunsStartedIn(source, day, nextDay(day));
  insertImproveRunsOnce(
    metricsDb,
    rows.map((r) => ({ ...r, result_json: slimImproveResultJson(r.result_json) })),
  );
}

/** One day's `usage_events` as report rows, read from `source`. */
function readUsageDay(source: Database, day: string): MetricsUsageRow[] {
  return listUsageEventRows(source, {
    sinceIso: `${day}T00:00:00.000Z`,
    untilIso: `${nextDay(day)}T00:00:00.000Z`,
  })
    .map(toUsageRow)
    .filter((row) => row.at.slice(0, 10) === day);
}

/**
 * Fold one day inside its open metrics.db transaction; `false` when nothing was written. Pending days were
 * listed before this transaction, and another process may have folded and purged the day since, so the marker
 * and the source counts are read again here: a table is folded only when the source still holds more rows
 * than the marker covers. The write lock this transaction holds is what keeps those two reads true until
 * the commit, because a purge needs a marker, and markers are only written under that lock.
 */
function foldDay(
  source: Database,
  metricsDb: Database,
  day: string,
  nowMs: number,
  usageRows: readonly MetricsUsageRow[] | undefined,
): boolean {
  const next = nextDay(day);
  const marker: FoldedCounts = readFoldedDay(metricsDb, day) ?? { events: 0, usage: 0, runs: 0 };
  const now: FoldedCounts = {
    events: countRowsInDay(source, "events", day, next),
    usage: countRowsInDay(source, "usage", day, next),
    runs: countRowsInDay(source, "runs", day, next),
  };
  const doEvents = now.events > marker.events;
  const doUsage = now.usage > marker.usage;
  const doRuns = now.runs > marker.runs;
  if (!doEvents && !doUsage && !doRuns) return false;
  if (doEvents) foldEventsDay(source, metricsDb, day);
  // The rows read before the transaction are used only while they still match the day's count.
  if (doUsage) foldUsageDay(metricsDb, day, usageRows?.length === now.usage ? usageRows : readUsageDay(source, day));
  if (doRuns) foldRunsDay(source, metricsDb, day);
  writeFoldedDay(metricsDb, day, new Date(nowMs).toISOString(), {
    events: doEvents ? now.events : marker.events,
    usage: doUsage ? now.usage : marker.usage,
    runs: doRuns ? now.runs : marker.runs,
  });
  return true;
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
  const eventCounts = countRowsByDay(source, "events", today);
  const usageCounts = countRowsByDay(source, "usage", today);
  const runCounts = countRowsByDay(source, "runs", today);
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
  const { todo, usageCounts, need } = pendingDays(source, folded, nowMs);
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
    try {
      if (withImmediateTransaction(metricsDb, () => foldDay(source, metricsDb, day, nowMs, usageByDay.get(day)))) {
        report.folded.push(day);
      }
    } catch (error) {
      report.failed.push({ day, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
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
