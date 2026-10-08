// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure aggregation behind `akm metrics`: rows read from the stores in, the
 * {@link AkmMetricsResult} envelope out. Nothing here touches a database, the
 * clock or the config, so every section is unit-testable from plain rows.
 * `metrics-cli.ts` reads the rows and calls {@link buildMetricsResult}.
 */

import type { EventEnvelope } from "../../core/events-types";
import type { UsageEventRow } from "../../indexer/usage/usage-events";
import { decodeLlmUsageRecord } from "../../llm/usage-telemetry";
import type { UtilityWithRef } from "../../storage/repositories/index-utility-repository";
import type { AssetOutcomeRow } from "../../storage/repositories/outcome-repository";
import { decodeTaskHistoryMetadata, type TaskHistoryRow } from "../../storage/repositories/task-history-repository";
import { computeWallTimeStats } from "../health/improve-metrics";
import type { LlmUsageAggregate } from "../health/types-metrics";
import { computeValenceScore } from "../improve/feedback-valence";
import type {
  AkmMetricsResult,
  MetricsAssetUsage,
  MetricsDailyUsage,
  MetricsEngineCost,
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
/** Costs are rounded to a millionth of a currency unit so float noise never reaches the output. */
const COST_SCALE = 1_000_000;
/** Mean result counts are rounded to two decimals. */
const MEAN_SCALE = 100;
/** `engines.<name>.pricing` is per this many tokens. */
const TOKENS_PER_PRICE_UNIT = 1_000_000;
/** `improve.eventRetentionDays` default (`runRetentionPurgePass`); 0 disables the purge. */
export const DEFAULT_EVENT_RETENTION_DAYS = 90;

/** `engines.<name>.pricing` as configured. */
export interface EnginePricing {
  inputPerMillion: number;
  outputPerMillion: number;
  currency?: string;
}

export interface MetricsFilters {
  source: string;
  bundles: string[];
  ref?: string;
}

/** Everything {@link buildMetricsResult} needs, already read and window-filtered by the caller. */
export interface MetricsInput {
  window: { since: string; until: string };
  filters: MetricsFilters;
  /** `--top`: the cap on every ranked list. */
  top: number;
  /** Attach {@link AkmMetricsResult.rows}. */
  includeRows: boolean;
  usage: UsageEventRow[];
  /** `select` events in the window. */
  selects: Array<{ ts: string; ref: string }>;
  /** `undefined` when `index.db` is missing or unreadable. */
  utility: UtilityWithRef[] | undefined;
  outcomes: AssetOutcomeRow[];
  llm: LlmUsageAggregate;
  llmRows: MetricsLlmRow[];
  /** `engines.<name>.pricing`, keyed by engine name. */
  pricing: Record<string, EnginePricing>;
  indexRuns: MetricsIndexRun[];
  tasks: TaskHistoryRow[];
  proposals: AkmMetricsResult["proposals"];
  workflows: AkmMetricsResult["workflows"];
  /** Notes the caller already gathered (missing stores, retention, filters). */
  notes: string[];
}

// ── Filters ─────────────────────────────────────────────────────────────────

/** Whether a durable ref passes the `--bundle` / `--ref` filters. */
export function refMatchesFilters(ref: string, filters: Pick<MetricsFilters, "bundles" | "ref">): boolean {
  if (filters.ref !== undefined) return ref === filters.ref;
  if (filters.bundles.length === 0) return true;
  return filters.bundles.some((bundle) => ref.startsWith(`${bundle}//`));
}

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

// ── Row mapping ─────────────────────────────────────────────────────────────

/** `usage_events.created_at` (`YYYY-MM-DD HH:MM:SS`, UTC) as an ISO-8601 string. */
export function usageCreatedAtToIso(createdAt: string): string {
  const text = createdAt.includes("T") ? createdAt : `${createdAt.replace(" ", "T")}Z`;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? createdAt : new Date(ms).toISOString();
}

function parseMetadata(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Map one `usage_events` row to the shape reported (and carried to the HTML dashboard). */
export function toUsageRow(row: UsageEventRow): MetricsUsageRow {
  const metadata = parseMetadata(row.metadata);
  const resultCount = finiteNumber(metadata.resultCount);
  const totalMs = finiteNumber(metadata.totalMs);
  const reason = typeof metadata.reason === "string" && metadata.reason.trim() ? metadata.reason : undefined;
  const tags = Array.isArray(metadata.tags)
    ? metadata.tags.filter((tag): tag is string => typeof tag === "string")
    : undefined;
  return {
    id: row.id,
    at: usageCreatedAtToIso(row.created_at),
    eventType: row.event_type,
    ...(row.entry_ref ? { ref: row.entry_ref } : {}),
    ...(row.query ? { query: row.query } : {}),
    ...(row.signal === "positive" || row.signal === "negative" ? { signal: row.signal } : {}),
    source: row.source,
    ...(resultCount !== undefined ? { resultCount } : {}),
    ...(totalMs !== undefined ? { totalMs } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
  };
}

/** `llm_usage` events as the raw rows the dashboard re-aggregates; events that do not decode are skipped. */
export function llmRowsFromEvents(events: EventEnvelope[]): MetricsLlmRow[] {
  const rows: MetricsLlmRow[] = [];
  for (const event of events) {
    const record = decodeLlmUsageRecord(event.metadata);
    if (!record) continue;
    rows.push({
      at: event.ts,
      ...(record.stage !== undefined ? { stage: record.stage } : {}),
      ...(record.process !== undefined ? { process: record.process } : {}),
      ...(record.engine !== undefined ? { engine: record.engine } : {}),
      ...(record.model !== undefined ? { model: record.model } : {}),
      outcome: record.outcome,
      durationMs: record.durationMs,
      ...(record.promptTokens !== undefined ? { promptTokens: record.promptTokens } : {}),
      ...(record.completionTokens !== undefined ? { completionTokens: record.completionTokens } : {}),
      ...(record.totalTokens !== undefined ? { totalTokens: record.totalTokens } : {}),
      ...(record.reasoningTokens !== undefined ? { reasoningTokens: record.reasoningTokens } : {}),
    });
  }
  return rows;
}

/** `index_completed` events as index runs; rows without a numeric `totalMs` are skipped. */
export function indexRunsFromEvents(events: Array<{ ts: string; metadata_json: string }>): MetricsIndexRun[] {
  const runs: MetricsIndexRun[] = [];
  for (const event of events) {
    const metadata = parseMetadata(event.metadata_json);
    const totalMs = finiteNumber(metadata.totalMs);
    if (totalMs === undefined) continue;
    runs.push({ at: event.ts, mode: metadata.mode === "full" ? "full" : "incremental", totalMs });
  }
  return runs;
}

// ── Small helpers ───────────────────────────────────────────────────────────

function median(values: number[]): number | null {
  return values.length === 0 ? null : computeWallTimeStats(values).medianMs;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * MEAN_SCALE) / MEAN_SCALE;
}

function byCountThenKey<T extends { count: number }>(key: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => b.count - a.count || key(a).localeCompare(key(b));
}

// ── Sections ────────────────────────────────────────────────────────────────

function buildUsage(input: MetricsInput, rows: MetricsUsageRow[]): AkmMetricsResult["usage"] {
  // A search or curate writes one summary row (no ref) plus one row per hit. A
  // bundle or ref filter drops the summary rows with the refs they lack, so the
  // hit rows are what is counted: each is a search that returned a matching asset.
  const hitMode = input.filters.bundles.length > 0 || input.filters.ref !== undefined;
  const isUnit = (row: MetricsUsageRow) => (hitMode ? row.ref !== undefined : row.ref === undefined);

  const days = new Map<string, MetricsDailyUsage>();
  const bump = (at: string, field: keyof Omit<MetricsDailyUsage, "day">) => {
    const day = at.slice(0, 10);
    const entry = days.get(day) ?? { day, search: 0, show: 0, curate: 0, feedback: 0 };
    entry[field] += 1;
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

  const queries = new Map<string, { count: number; results: number[]; lastAt: string }>();
  const zeroQueries = new Map<string, { count: number; lastAt: string }>();
  const bySource: Record<string, number> = {};
  const searchMs: number[] = [];
  let searches = 0;
  let searchesWithHits = 0;
  let zeroResultSearches = 0;
  let shows = 0;
  let curates = 0;

  for (const row of rows) {
    bySource[row.source] = (bySource[row.source] ?? 0) + 1;
    if (row.eventType === "search") {
      if (row.ref !== undefined) {
        const entry = asset(row.ref);
        entry.searchHits += 1;
        touch(entry, row.at);
      }
      if (!isUnit(row)) continue;
      searches += 1;
      bump(row.at, "search");
      if (hitMode || (row.resultCount ?? 0) > 0) searchesWithHits += 1;
      if (row.resultCount === 0) zeroResultSearches += 1;
      if (row.totalMs !== undefined) searchMs.push(row.totalMs);
      const query = row.query?.trim();
      if (query) {
        const entry = queries.get(query) ?? { count: 0, results: [], lastAt: row.at };
        entry.count += 1;
        if (row.resultCount !== undefined) entry.results.push(row.resultCount);
        if (row.at > entry.lastAt) entry.lastAt = row.at;
        queries.set(query, entry);
        if (row.resultCount === 0) {
          const zero = zeroQueries.get(query) ?? { count: 0, lastAt: row.at };
          zero.count += 1;
          if (row.at > zero.lastAt) zero.lastAt = row.at;
          zeroQueries.set(query, zero);
        }
      }
    } else if (row.eventType === "curate") {
      if (isUnit(row)) {
        curates += 1;
        bump(row.at, "curate");
      }
    } else if (row.eventType === "show") {
      shows += 1;
      bump(row.at, "show");
      if (row.ref !== undefined) {
        const entry = asset(row.ref);
        entry.shows += 1;
        touch(entry, row.at);
      }
    } else if (row.eventType === "feedback") {
      bump(row.at, "feedback");
      if (row.ref !== undefined && row.signal !== undefined) {
        const entry = asset(row.ref);
        entry[row.signal] += 1;
        touch(entry, row.at);
      }
    }
  }

  for (const select of input.selects) {
    const entry = asset(select.ref);
    entry.selects += 1;
    touch(entry, select.ts);
  }

  const toQueryCount = (
    query: string,
    entry: { count: number; results: number[]; lastAt: string },
  ): MetricsQueryCount => ({
    query,
    count: entry.count,
    avgResults: mean(entry.results),
    lastAt: entry.lastAt,
  });

  return {
    totals: {
      searches,
      shows,
      curates,
      selects: input.selects.length,
      zeroResultSearches,
      distinctAssets: assets.size,
      distinctQueries: queries.size,
    },
    selectRate: searchesWithHits > 0 ? input.selects.length / searchesWithHits : null,
    searchMedianMs: median(searchMs),
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

function buildFeedback(top: number, rows: MetricsUsageRow[]): AkmMetricsResult["feedback"] {
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
    if (!refMatchesFilters(entry.ref, input.filters)) continue;
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

/**
 * Cost per engine that has `pricing`: prompt tokens at the input rate and
 * completion tokens at the output rate. Reasoning tokens are part of the
 * completion count, so they are not charged again. An engine without pricing
 * is left out rather than shown as zero.
 */
export function computeEngineCosts(
  byEngine: LlmUsageAggregate["byEngine"],
  pricing: Record<string, EnginePricing>,
): MetricsEngineCost[] {
  const costs: MetricsEngineCost[] = [];
  for (const [engine, usage] of Object.entries(byEngine).sort(([a], [b]) => a.localeCompare(b))) {
    const price = pricing[engine];
    if (!price) continue;
    const raw =
      (usage.promptTokens * price.inputPerMillion + usage.completionTokens * price.outputPerMillion) /
      TOKENS_PER_PRICE_UNIT;
    costs.push({
      engine,
      currency: price.currency ?? "USD",
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cost: Math.round(raw * COST_SCALE) / COST_SCALE,
    });
  }
  return costs;
}

function taskDurationMs(row: TaskHistoryRow): number | undefined {
  try {
    return decodeTaskHistoryMetadata(row.metadata_json).durationMs;
  } catch {
    return undefined;
  }
}

function buildTasks(top: number, rows: TaskHistoryRow[]): AkmMetricsResult["tasks"] {
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

function buildIndex(top: number, runs: MetricsIndexRun[]): AkmMetricsResult["index"] {
  return {
    runs: runs.length,
    medianMs: median(runs.map((run) => run.totalMs)),
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
  return {
    schemaVersion: 1,
    window: input.window,
    filters: {
      source: input.filters.source,
      bundles: input.filters.bundles,
      ...(input.filters.ref !== undefined ? { ref: input.filters.ref } : {}),
    },
    usage: buildUsage(input, rows),
    feedback: buildFeedback(input.top, rows),
    utility: buildUtility(input),
    outcomes: { lowestOutcome: outcomes },
    llm: { ...input.llm, cost: computeEngineCosts(input.llm.byEngine, input.pricing) },
    index: buildIndex(input.top, input.indexRuns),
    tasks: buildTasks(input.top, input.tasks),
    proposals: input.proposals,
    workflows: input.workflows,
    ...(input.includeRows ? { rows: { usage: rows, llm: input.llmRows } } : {}),
    notes: input.notes,
  };
}
