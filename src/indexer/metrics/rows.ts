// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The counting rules of the metrics rollups, as pure functions of rows: what counts as a search, a signed
 * feedback row, a deduped select, an LLM call. The report (`commands/metrics/collect.ts`) and the fold into
 * metrics.db (`./fold.ts`) both count through here, so a day read raw and a day read from its rollup agree.
 */

import type { MetricsIndexRun, MetricsLlmRow, MetricsUsageRow } from "../../commands/metrics/types";
import type { EventEnvelope } from "../../core/events-types";
import { addToHistogram, emptyHistogram } from "../../core/metrics-histogram";
import { decodeLlmUsageRecord, type LlmUsageRecord } from "../../llm/usage-telemetry";
import type { SelectEventRow } from "../../storage/repositories/metrics-repository";
import type { QueryDailyRow, TagDailyRow, UsageDailyRow } from "../../storage/repositories/metrics-rollup-repository";
import type { UsageEventRow } from "../usage/usage-events";

/**
 * Keep the first select per (searchId, ref): a result shown twice after one
 * search is one select. Rows from before selects carried a `searchId` have no
 * key to dedupe on and are all kept.
 */
export function dedupeSelects(selects: SelectEventRow[]): SelectEventRow[] {
  const seen = new Set<string>();
  return selects.filter((select) => {
    if (select.searchId === undefined) return true;
    const key = `${select.searchId}\u0000${select.ref}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  const agent = metadata.agent as { harness?: unknown; session?: unknown } | undefined;
  const harness = typeof agent?.harness === "string" && agent.harness ? agent.harness : undefined;
  const session = typeof agent?.session === "string" && agent.session ? agent.session : undefined;
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
    ...(harness ? { agent: { harness, ...(session ? { session } : {}) } } : {}),
  };
}

/**
 * `llm_usage` events summed per UTC day x stage x process x engine x model x
 * outcome: the rows the dashboard re-aggregates. One row per call would be the
 * largest thing in the page, and the page only ever filters them by date.
 * Events that do not decode are skipped; rows come out in first-seen order.
 */
export function llmRowsFromEvents(events: EventEnvelope[]): MetricsLlmRow[] {
  const rows = new Map<string, MetricsLlmRow>();
  for (const event of events) {
    const record = decodeLlmUsageRecord(event.metadata);
    if (!record) continue;
    const day = event.ts.slice(0, 10);
    const key = JSON.stringify([day, record.stage, record.process, record.engine, record.model, record.outcome]);
    let row = rows.get(key);
    if (!row) {
      row = {
        day,
        ...(record.stage !== undefined ? { stage: record.stage } : {}),
        ...(record.process !== undefined ? { process: record.process } : {}),
        ...(record.engine !== undefined ? { engine: record.engine } : {}),
        ...(record.model !== undefined ? { model: record.model } : {}),
        outcome: record.outcome,
        calls: 0,
        durationMs: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        reasoningTokens: 0,
        usageCalls: 0,
        reasoningCalls: 0,
      };
      rows.set(key, row);
    }
    row.calls += 1;
    row.durationMs += record.durationMs;
    row.promptTokens += record.promptTokens ?? 0;
    row.completionTokens += record.completionTokens ?? 0;
    // A call without a total counts as prompt + completion, as the dashboard did per call.
    row.totalTokens += record.totalTokens ?? (record.promptTokens ?? 0) + (record.completionTokens ?? 0);
    row.reasoningTokens += record.reasoningTokens ?? 0;
    if (hasTokenUsage(record)) row.usageCalls += 1;
    if (record.reasoningTokens !== undefined) row.reasoningCalls += 1;
  }
  return [...rows.values()];
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

/** True when the provider response carried any token count. Absent usage is unknown, not zero. */
export function hasTokenUsage(record: LlmUsageRecord): boolean {
  return (
    record.promptTokens !== undefined ||
    record.completionTokens !== undefined ||
    record.totalTokens !== undefined ||
    record.reasoningTokens !== undefined
  );
}

// ── Improve skips ───────────────────────────────────────────────────────────

/**
 * A window's improve_skipped events, tallied (see `buildImproveSkipSummary`): `summed` counts the
 * per-occurrence events per reason, `latestSnapshot` keeps the last count-bearing event's count per reason.
 * metrics.db keeps one tally per day so a window older than state.db's raw rows is rebuilt the same way.
 */
export interface SkipTally {
  summed: Record<string, number>;
  latestSnapshot: Record<string, number>;
}

export function tallyImproveSkipEvents(events: EventEnvelope[]): SkipTally {
  // Two kinds of skip events:
  //  - Per-occurrence (no `count`): one event per skipped ref → SUM is correct.
  //  - Aggregated snapshot (carries `count`): a single per-run event whose count
  //    is the number of refs that hit a STABLE, whole-stash condition that run
  //    (`no_new_signal`, `strategy_filtered_all_passes`). Each run re-counts the
  //    same stable set, so summing across the window re-counts it N times (the
  //    2.7M / 3M inflation). For these we keep the MOST RECENT run's count — the
  //    current snapshot — matching how memorySummary is handled. Events arrive
  //    in chronological (offset) order, so the last count-bearing event per
  //    reason is the latest run's value.
  const tally: SkipTally = { summed: {}, latestSnapshot: {} };
  for (const event of events) {
    const reason =
      typeof event.metadata?.reason === "string" && event.metadata.reason.trim() ? event.metadata.reason : "unknown";
    const rawCount = event.metadata?.count;
    if (typeof rawCount === "number" && Number.isFinite(rawCount) && rawCount > 0) {
      tally.latestSnapshot[reason] = rawCount; // overwrite → keeps the latest run's snapshot
    } else {
      tally.summed[reason] = (tally.summed[reason] ?? 0) + 1;
    }
  }
  return tally;
}

// ── Usage rows ──────────────────────────────────────────────────────────────

/** `usage_events` rows counted per UTC day: the shape of `usage_daily`, `query_daily` and `feedback_tag_daily`. */
export interface UsageAggregate {
  /** One row per day x event type x source x ref (`''` for a search or curate summary row). */
  usage: Array<UsageDailyRow & { source: string }>;
  /** Search summary rows with a query, per day x source x query. */
  queries: Array<QueryDailyRow & { source: string }>;
  /** Signed feedback per day x source x tag. */
  tags: Array<TagDailyRow & { source: string }>;
  /** Search `totalMs` histograms per day x source. */
  searchLatency: Array<{ day: string; source: string; hist: number[] }>;
}

export function aggregateUsage(rows: readonly MetricsUsageRow[]): UsageAggregate {
  const usage = new Map<string, UsageAggregate["usage"][number]>();
  const queries = new Map<string, UsageAggregate["queries"][number]>();
  const tags = new Map<string, UsageAggregate["tags"][number]>();
  const latency = new Map<string, UsageAggregate["searchLatency"][number]>();
  for (const row of rows) {
    // A search or curate writes one summary row (no ref) plus one row per hit; the summary row is the unit counted.
    const isSummary = row.ref === undefined;
    const day = row.at.slice(0, 10);
    const usageKey = JSON.stringify([day, row.eventType, row.source, row.ref ?? ""]);
    let u = usage.get(usageKey);
    if (!u) {
      u = {
        day,
        event_type: row.eventType,
        source: row.source,
        ref: row.ref ?? "",
        n: 0,
        positive: 0,
        negative: 0,
        hits: 0,
        zero: 0,
        last_at: row.at,
      };
      usage.set(usageKey, u);
    }
    u.n += 1;
    if (row.signal === "positive") u.positive += 1;
    if (row.signal === "negative") u.negative += 1;
    if (row.eventType === "search" && isSummary) {
      if ((row.resultCount ?? 0) > 0) u.hits += 1;
      if (row.resultCount === 0) u.zero += 1;
    }
    if (row.at > u.last_at) u.last_at = row.at;

    if (row.eventType === "search" && isSummary) {
      if (row.totalMs !== undefined && row.totalMs >= 0) {
        const key = JSON.stringify([day, row.source]);
        const entry = latency.get(key) ?? { day, source: row.source, hist: emptyHistogram() };
        addToHistogram(entry.hist, row.totalMs);
        latency.set(key, entry);
      }
      const query = row.query?.trim();
      if (query) {
        const key = JSON.stringify([day, row.source, query]);
        let q = queries.get(key);
        if (!q) {
          q = { day, source: row.source, query, n: 0, results_n: 0, results_sum: 0, zero_n: 0, last_at: row.at };
          queries.set(key, q);
        }
        q.n += 1;
        if (row.resultCount !== undefined) {
          q.results_n += 1;
          q.results_sum += row.resultCount;
        }
        if (row.resultCount === 0) q.zero_n += 1;
        if (row.at > q.last_at) q.last_at = row.at;
      }
    }

    if (row.eventType === "feedback" && row.signal !== undefined) {
      for (const tag of row.tags ?? []) {
        const key = JSON.stringify([row.source, tag]);
        const t = tags.get(key) ?? { source: row.source, tag, positive: 0, negative: 0 };
        t[row.signal] += 1;
        tags.set(key, t);
      }
    }
  }
  return {
    usage: [...usage.values()],
    queries: [...queries.values()],
    tags: [...tags.values()],
    searchLatency: [...latency.values()],
  };
}
