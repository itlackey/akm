// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure aggregation behind `akm metrics`: rows read from the stores in, the
 * {@link AkmMetricsResult} envelope out. Nothing here touches a database, the
 * clock or the config, so every section is unit-testable from plain rows.
 * `metrics.ts` reads the rows and calls {@link buildMetricsResult}.
 */

import {
  addToHistogram,
  emptyHistogram,
  histogramCount,
  histogramMedian,
  mergeHistogram,
} from "../../core/metrics-histogram";
import { aggregateUsage, dedupeSelects, toUsageRow } from "../../indexer/metrics/rows";
import type { UsageEventRow } from "../../indexer/usage/usage-events";
import type { UtilityWithRef } from "../../storage/repositories/index-utility-repository";
import type { SelectEventRow } from "../../storage/repositories/metrics-repository";
import type { QueryDailyRow, TagDailyRow, UsageDailyRow } from "../../storage/repositories/metrics-rollup-repository";
import type { AssetOutcomeRow } from "../../storage/repositories/outcome-repository";
import { decodeTaskHistoryMetadata, type TaskHistoryRow } from "../../storage/repositories/task-history-repository";
import { computeWallTimeStats } from "../health/improve-metrics";
import type { LlmUsageAggregate } from "../health/types-metrics";
import { computeValenceScore } from "../improve/feedback-valence";
import type {
  AkmMetricsResult,
  MetricsAssetUsage,
  MetricsDailyUsage,
  MetricsFeedbackAsset,
  MetricsIndexRun,
  MetricsLlmRow,
  MetricsNegativeFeedback,
  MetricsOutcomeAsset,
  MetricsQueryCount,
  MetricsTaskSummary,
  MetricsUsageRow,
  MetricsUtilityAsset,
} from "./types";

const DAY_MS = 86_400_000;
/** Utility is a score in [0, 1], reported in ten equal buckets. */
const UTILITY_BUCKETS = 10;

/** The coverage note naming where dedupe starts, or nothing when no select carries a `searchId`. */
function selectDedupeNotes(selects: SelectEventRow[]): string[] {
  const first = selects.filter((select) => select.searchId !== undefined).map((select) => select.ts);
  if (first.length === 0) return [];
  return [
    `Selects deduped from ${first.reduce((a, b) => (a < b ? a : b)).slice(0, 10)}; earlier selects are counted as recorded.`,
  ];
}

/** Mean result counts are rounded to two decimals. */
const MEAN_SCALE = 100;
/** `improve.eventRetentionDays` default (`runRetentionPurgePass`); 0 disables the purge. */
export const DEFAULT_EVENT_RETENTION_DAYS = 90;

/**
 * Days of the window that only metrics.db still holds (see `storage/repositories/metrics-rollup-repository.ts`),
 * folded into the sections built from raw rows. Each part covers its own days: usage and queries the days
 * before the oldest raw usage row, selects, LLM calls and index runs the days before the oldest raw event.
 */
export interface MetricsRollup {
  /** `usage_daily` rows of the report's source. */
  usage: UsageDailyRow[];
  queries: QueryDailyRow[];
  tags: TagDailyRow[];
  /** Selects per ref, the ref already resolved to the durable form. */
  selects: Array<{ ref: string; n: number; lastAt: string }>;
  /** Search `totalMs` histogram over the rollup days (empty when there are none). */
  searchHist: number[];
  llm: MetricsLlmRow[];
  indexRuns: number;
  indexHist: number[];
}

/** Everything {@link buildMetricsResult} needs, already read and window-filtered by the caller. */
export interface MetricsInput {
  window: { since: string; until: string };
  /** The usage source the rows were limited to. */
  source: string;
  /** The cap on every ranked list. */
  top: number;
  /** Attach {@link AkmMetricsResult.rows}. */
  includeRows: boolean;
  usage: UsageEventRow[];
  /** `select` events in the window. */
  selects: SelectEventRow[];
  /** `undefined` when `index.db` is missing or unreadable. */
  utility: UtilityWithRef[] | undefined;
  outcomes: AssetOutcomeRow[];
  llm: LlmUsageAggregate;
  llmRows: MetricsLlmRow[];
  indexRuns: MetricsIndexRun[];
  tasks: TaskHistoryRow[];
  proposals: AkmMetricsResult["proposals"];
  workflows: AkmMetricsResult["workflows"];
  /** Notes the caller already gathered (missing stores, retention). */
  notes: string[];
  /** The window's days that only metrics.db holds, when it reaches back past state.db's raw rows. */
  rollup?: MetricsRollup;
}

// ── Filters ─────────────────────────────────────────────────────────────────

// ── Notes ───────────────────────────────────────────────────────────────────

/**
 * One note per store whose retention is shorter than the window, naming the
 * store, how long it keeps rows and where the data effectively starts. A
 * retention of 0 or less means the store is never purged.
 */
export function retentionNotes(args: {
  sinceIso: string;
  nowMs: number;
  usageRetentionDays: number;
  eventRetentionDays: number;
}): string[] {
  const stores = [
    { store: "usage_events (search, show, curate and feedback rows)", days: args.usageRetentionDays },
    { store: "events (selects, LLM calls and index runs)", days: args.eventRetentionDays },
  ];
  const notes: string[] = [];
  const sinceMs = Date.parse(args.sinceIso);
  for (const { store, days } of stores) {
    if (!Number.isFinite(days) || days <= 0) continue;
    const effectiveMs = args.nowMs - days * DAY_MS;
    if (sinceMs >= effectiveMs) continue;
    notes.push(
      `${store} keeps ${days} days, so the window starts ${args.sinceIso} but its data starts no earlier than ${new Date(effectiveMs).toISOString()}.`,
    );
  }
  return notes;
}

// ── Small helpers ───────────────────────────────────────────────────────────

function median(values: number[]): number | null {
  return values.length === 0 ? null : computeWallTimeStats(values).medianMs;
}

function meanOf(sum: number, count: number): number | null {
  return count === 0 ? null : Math.round((sum / count) * MEAN_SCALE) / MEAN_SCALE;
}

function byCountThenKey<T extends { count: number }>(key: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => b.count - a.count || key(a).localeCompare(key(b));
}

// ── Sections ────────────────────────────────────────────────────────────────

function buildUsage(input: MetricsInput, rows: MetricsUsageRow[]): AkmMetricsResult["usage"] {
  // Raw rows and metrics.db rollup rows are counted by one loop: the raw rows are first folded into the
  // rollup shape (`aggregateUsage`, the rules the fold uses), so a day read either way counts the same.
  const raw = aggregateUsage(rows);
  const rollup = input.rollup;
  const usageRows = [...raw.usage, ...(rollup?.usage ?? []).map((r) => ({ ...r, source: input.source }))];
  const queryRows = [...raw.queries, ...(rollup?.queries ?? [])];
  const selectRows = [...input.selects.map((s) => ({ ref: s.ref, n: 1, lastAt: s.ts })), ...(rollup?.selects ?? [])];

  const days = new Map<string, MetricsDailyUsage>();
  const bumpDay = (day: string, field: keyof Omit<MetricsDailyUsage, "day">, n: number) => {
    const entry = days.get(day) ?? { day, search: 0, show: 0, curate: 0, feedback: 0 };
    entry[field] += n;
    days.set(day, entry);
  };

  const assets = new Map<string, MetricsAssetUsage>();
  const asset = (ref: string): MetricsAssetUsage => {
    let entry = assets.get(ref);
    if (!entry) {
      entry = { ref, shows: 0, searchHits: 0, selects: 0, positive: 0, negative: 0 };
      assets.set(ref, entry);
    }
    return entry;
  };
  const touch = (entry: MetricsAssetUsage, at: string) => {
    if (entry.lastUsedAt === undefined || at > entry.lastUsedAt) entry.lastUsedAt = at;
  };

  const queries = new Map<string, { count: number; resultsSum: number; resultsN: number; lastAt: string }>();
  const zeroQueries = new Map<string, { count: number; lastAt: string }>();
  const bySource: Record<string, number> = {};
  let searches = 0;
  let searchesWithHits = 0;
  let zeroResultSearches = 0;
  let shows = 0;
  let curates = 0;

  for (const r of usageRows) {
    bySource[r.source] = (bySource[r.source] ?? 0) + r.n;
    const isSummary = r.ref === "";
    if (r.event_type === "search") {
      if (!isSummary) {
        const entry = asset(r.ref);
        entry.searchHits += r.n;
        touch(entry, r.last_at);
      } else {
        searches += r.n;
        bumpDay(r.day, "search", r.n);
        searchesWithHits += r.hits;
        zeroResultSearches += r.zero;
      }
    } else if (r.event_type === "curate") {
      if (isSummary) {
        curates += r.n;
        bumpDay(r.day, "curate", r.n);
      }
    } else if (r.event_type === "show") {
      shows += r.n;
      bumpDay(r.day, "show", r.n);
      if (!isSummary) {
        const entry = asset(r.ref);
        entry.shows += r.n;
        touch(entry, r.last_at);
      }
    } else if (r.event_type === "feedback") {
      // Signed rows only, so the daily series and the totals count the same rows.
      const signed = r.positive + r.negative;
      if (signed === 0) continue;
      bumpDay(r.day, "feedback", signed);
      if (!isSummary) {
        const entry = asset(r.ref);
        entry.positive += r.positive;
        entry.negative += r.negative;
        touch(entry, r.last_at);
      }
    }
  }

  for (const q of queryRows) {
    const entry = queries.get(q.query) ?? { count: 0, resultsSum: 0, resultsN: 0, lastAt: q.last_at };
    entry.count += q.n;
    entry.resultsSum += q.results_sum;
    entry.resultsN += q.results_n;
    if (q.last_at > entry.lastAt) entry.lastAt = q.last_at;
    queries.set(q.query, entry);
    if (q.zero_n > 0) {
      const zero = zeroQueries.get(q.query) ?? { count: 0, lastAt: q.last_at };
      zero.count += q.zero_n;
      if (q.last_at > zero.lastAt) zero.lastAt = q.last_at;
      zeroQueries.set(q.query, zero);
    }
  }

  let selectCount = 0;
  for (const select of selectRows) {
    selectCount += select.n;
    const entry = asset(select.ref);
    entry.selects += select.n;
    touch(entry, select.lastAt);
  }

  // Latency: exact over raw rows; over rollup days an estimate from the duration histograms.
  const searchMs = rows
    .filter((row) => row.eventType === "search" && row.ref === undefined)
    .flatMap((row) => (row.totalMs !== undefined && row.totalMs >= 0 ? [row.totalMs] : []));
  const searchHist = emptyHistogram();
  const rollupLatency = !!rollup && histogramCount(rollup.searchHist) > 0;
  if (rollup && rollupLatency) {
    for (const ms of searchMs) addToHistogram(searchHist, ms);
    mergeHistogram(searchHist, rollup.searchHist);
  }

  const toQueryCount = (
    query: string,
    entry: { count: number; resultsSum: number; resultsN: number; lastAt: string },
  ): MetricsQueryCount => ({
    query,
    count: entry.count,
    avgResults: meanOf(entry.resultsSum, entry.resultsN),
    lastAt: entry.lastAt,
  });

  return {
    totals: {
      searches,
      shows,
      curates,
      selects: selectCount,
      zeroResultSearches,
      searchesWithHits,
      distinctAssets: assets.size,
      distinctQueries: queries.size,
    },
    selectsPerSearch: searchesWithHits > 0 ? selectCount / searchesWithHits : null,
    // Exact over raw rows; over rollup days an estimate from the duration histograms.
    searchMedianMs: rollupLatency ? histogramMedian(searchHist) : median(searchMs),
    daily: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    topAssets: [...assets.values()]
      .sort(
        (a, b) =>
          b.shows - a.shows || b.searchHits - a.searchHits || b.selects - a.selects || a.ref.localeCompare(b.ref),
      )
      .slice(0, input.top),
    topQueries: [...queries.entries()]
      .map(([query, entry]) => toQueryCount(query, entry))
      .sort(byCountThenKey((item) => item.query))
      .slice(0, input.top),
    zeroResultQueries: [...zeroQueries.entries()]
      .map(([query, entry]) => ({ query, count: entry.count, avgResults: 0, lastAt: entry.lastAt }))
      .sort(byCountThenKey((item) => item.query))
      .slice(0, input.top),
    bySource,
  };
}

function buildFeedback(
  top: number,
  rows: MetricsUsageRow[],
  rollup?: Pick<MetricsRollup, "usage" | "tags">,
): AkmMetricsResult["feedback"] {
  const totals = { positive: 0, negative: 0 };
  const byAsset = new Map<string, { positive: number; negative: number; lastAt: string }>();
  const byTag: Record<string, { positive: number; negative: number }> = {};
  const negatives: Array<MetricsNegativeFeedback & { id: number }> = [];

  for (const row of rows) {
    if (row.eventType !== "feedback" || row.signal === undefined) continue;
    totals[row.signal] += 1;
    if (row.ref !== undefined) {
      const entry = byAsset.get(row.ref) ?? { positive: 0, negative: 0, lastAt: row.at };
      entry[row.signal] += 1;
      if (row.at > entry.lastAt) entry.lastAt = row.at;
      byAsset.set(row.ref, entry);
    }
    for (const tag of row.tags ?? []) {
      byTag[tag] ??= { positive: 0, negative: 0 };
      byTag[tag][row.signal] += 1;
    }
    if (row.signal === "negative" && row.ref !== undefined) {
      negatives.push({
        id: row.id,
        ref: row.ref,
        at: row.at,
        ...(row.reason !== undefined ? { reason: row.reason } : {}),
        ...(row.tags ? { tags: row.tags } : {}),
      });
    }
  }

  for (const r of rollup?.usage ?? []) {
    if (r.event_type !== "feedback" || r.positive + r.negative === 0) continue;
    totals.positive += r.positive;
    totals.negative += r.negative;
    if (r.ref === "") continue;
    const entry = byAsset.get(r.ref) ?? { positive: 0, negative: 0, lastAt: r.last_at };
    entry.positive += r.positive;
    entry.negative += r.negative;
    if (r.last_at > entry.lastAt) entry.lastAt = r.last_at;
    byAsset.set(r.ref, entry);
  }
  for (const t of rollup?.tags ?? []) {
    byTag[t.tag] ??= { positive: 0, negative: 0 };
    byTag[t.tag]!.positive += t.positive;
    byTag[t.tag]!.negative += t.negative;
  }

  const assetRows: MetricsFeedbackAsset[] = [...byAsset.entries()].map(([ref, entry]) => ({
    ref,
    positive: entry.positive,
    negative: entry.negative,
    valence: computeValenceScore(entry).valence,
    lastAt: entry.lastAt,
  }));
  return {
    totals,
    byAsset: assetRows
      .sort((a, b) => b.positive + b.negative - (a.positive + a.negative) || a.ref.localeCompare(b.ref))
      .slice(0, top),
    byTag: Object.fromEntries(Object.entries(byTag).sort(([a], [b]) => a.localeCompare(b))),
    recentNegative: negatives
      .sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)
      .slice(0, top)
      .map(({ id: _id, ...rest }) => rest),
  };
}

function buildUtility(input: MetricsInput): AkmMetricsResult["utility"] {
  const histogram = Array.from({ length: UTILITY_BUCKETS }, (_, index) => ({
    bucket: `${(index / UTILITY_BUCKETS).toFixed(1)}-${((index + 1) / UTILITY_BUCKETS).toFixed(1)}`,
    count: 0,
  }));
  const scored: MetricsUtilityAsset[] = [];
  let neverUsed = 0;
  for (const entry of input.utility ?? []) {
    if (!entry.score) {
      neverUsed += 1;
      continue;
    }
    const clamped = Math.min(1, Math.max(0, entry.score.utility));
    const bucket = histogram[Math.min(UTILITY_BUCKETS - 1, Math.floor(clamped * UTILITY_BUCKETS))];
    if (bucket) bucket.count += 1;
    scored.push({
      ref: entry.ref,
      utility: entry.score.utility,
      showCount: entry.score.showCount,
      searchCount: entry.score.searchCount,
      selectRate: entry.score.selectRate,
      ...(entry.score.lastUsedAt !== undefined ? { lastUsedAt: entry.score.lastUsedAt } : {}),
    });
  }
  return {
    count: scored.length,
    histogram,
    lowest: [...scored].sort((a, b) => a.utility - b.utility || a.ref.localeCompare(b.ref)).slice(0, input.top),
    highest: [...scored].sort((a, b) => b.utility - a.utility || a.ref.localeCompare(b.ref)).slice(0, input.top),
    neverUsed,
  };
}

function taskDurationMs(row: TaskHistoryRow): number | undefined {
  try {
    return decodeTaskHistoryMetadata(row.metadata_json).durationMs;
  } catch {
    return undefined;
  }
}

export function buildTasks(top: number, rows: TaskHistoryRow[]): AkmMetricsResult["tasks"] {
  const byTask = new Map<string, { runs: number; failed: number; durations: number[] }>();
  let failed = 0;
  for (const row of rows) {
    const entry = byTask.get(row.task_id) ?? { runs: 0, failed: 0, durations: [] };
    entry.runs += 1;
    if (row.status === "failed") {
      entry.failed += 1;
      failed += 1;
    }
    const durationMs = taskDurationMs(row);
    if (durationMs !== undefined) entry.durations.push(durationMs);
    byTask.set(row.task_id, entry);
  }
  const summaries: MetricsTaskSummary[] = [...byTask.entries()].map(([taskId, entry]) => ({
    taskId,
    runs: entry.runs,
    failed: entry.failed,
    medianMs: median(entry.durations),
  }));
  return {
    runs: rows.length,
    failed,
    // Same definition as `akm health`'s task fail rate: failed runs over every run in the window.
    failRate: rows.length > 0 ? failed / rows.length : null,
    byTask: summaries.sort((a, b) => b.runs - a.runs || a.taskId.localeCompare(b.taskId)).slice(0, top),
  };
}

function buildIndex(
  top: number,
  runs: MetricsIndexRun[],
  rollup?: Pick<MetricsRollup, "indexRuns" | "indexHist">,
): AkmMetricsResult["index"] {
  const hist = emptyHistogram();
  if (rollup && rollup.indexRuns > 0) {
    for (const run of runs) addToHistogram(hist, run.totalMs);
    mergeHistogram(hist, rollup.indexHist);
  }
  return {
    runs: runs.length + (rollup?.indexRuns ?? 0),
    // Exact over raw runs; with rollup days an estimate from the duration histograms.
    medianMs: rollup && rollup.indexRuns > 0 ? histogramMedian(hist) : median(runs.map((run) => run.totalMs)),
    // Input is oldest first; reversing before the stable sort puts later rows first within one timestamp.
    recent: [...runs]
      .reverse()
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, top),
  };
}

// ── Entry point ─────────────────────────────────────────────────────────────

export function buildMetricsResult(input: MetricsInput): AkmMetricsResult {
  const rows = input.usage.map(toUsageRow);
  const outcomes: MetricsOutcomeAsset[] = input.outcomes.slice(0, input.top).map((row) => ({
    ref: row.asset_ref,
    outcomeScore: row.outcome_score,
    retrievalCount: row.retrieval_count,
    negativeFeedbackCount: row.negative_feedback_count,
    acceptedChangeCount: row.accepted_change_count,
  }));
  // A select recorded before `source` existed is kept for every source.
  const selects = dedupeSelects(input.selects.filter((s) => s.source === undefined || s.source === input.source));
  return {
    schemaVersion: 1,
    window: input.window,
    filters: { source: input.source },
    usage: buildUsage({ ...input, selects }, rows),
    feedback: buildFeedback(input.top, rows, input.rollup),
    utility: buildUtility(input),
    outcomes: { lowestOutcome: outcomes },
    llm: input.llm,
    index: buildIndex(input.top, input.indexRuns, input.rollup),
    tasks: buildTasks(input.top, input.tasks),
    proposals: input.proposals,
    workflows: input.workflows,
    ...(input.includeRows ? { rows: { usage: rows, llm: [...(input.rollup?.llm ?? []), ...input.llmRows] } } : {}),
    notes: [...input.notes, ...selectDedupeNotes(selects)],
  };
}
