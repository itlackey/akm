// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm metrics` result shape (schemaVersion 1). See
 * docs/plans/metrics-command.md §3. Every renderer (text, md, html) is a pure
 * function of this envelope.
 */

import type { AcceptRateEntry } from "../health/accept-rate";
import type { LlmUsageAggregate } from "../health/types-metrics";

/** One `usage_events` row in the window (search/show/curate/feedback). */
export interface MetricsUsageRow {
  id: number;
  /** ISO-8601 UTC, normalized from the table's `YYYY-MM-DD HH:MM:SS`. */
  at: string;
  eventType: string;
  /** Durable `bundle//conceptId`; absent on search/curate summary rows. */
  ref?: string;
  query?: string;
  signal?: "positive" | "negative";
  source: string;
  /** Summary-row result count (search); absent on per-hit rows. */
  resultCount?: number;
  /** Persisted search wall time (summary rows written after the timing fix). */
  totalMs?: number;
  reason?: string;
  tags?: string[];
}

/** The `llm_usage` events of one UTC day x stage x process x engine x model x outcome, summed. */
export interface MetricsLlmRow {
  /** `YYYY-MM-DD` (UTC). */
  day: string;
  stage?: string;
  process?: string;
  engine?: string;
  model?: string;
  outcome: "success" | "error";
  calls: number;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  /** Sum of each call's total, or of its prompt + completion when it had none. */
  totalTokens: number;
  reasoningTokens: number;
}

export interface MetricsDailyUsage {
  /** `YYYY-MM-DD` (UTC). */
  day: string;
  search: number;
  show: number;
  curate: number;
  feedback: number;
}

export interface MetricsAssetUsage {
  ref: string;
  shows: number;
  searchHits: number;
  selects: number;
  positive: number;
  negative: number;
  lastUsedAt?: string;
}

export interface MetricsQueryCount {
  query: string;
  count: number;
  /** Mean result count across the query's summary rows; `null` when none carry one. */
  avgResults: number | null;
  lastAt: string;
}

export interface MetricsFeedbackAsset {
  ref: string;
  positive: number;
  negative: number;
  /** `computeValenceScore(...).valence` (src/commands/improve/feedback-valence.ts). */
  valence: number;
  lastAt: string;
}

export interface MetricsNegativeFeedback {
  ref: string;
  at: string;
  reason?: string;
  tags?: string[];
}

export interface MetricsUtilityAsset {
  ref: string;
  utility: number;
  showCount: number;
  searchCount: number;
  selectRate: number;
  lastUsedAt?: string;
}

export interface MetricsOutcomeAsset {
  ref: string;
  outcomeScore: number;
  retrievalCount: number;
  negativeFeedbackCount: number;
  acceptedChangeCount: number;
}

export interface MetricsTaskSummary {
  taskId: string;
  runs: number;
  failed: number;
  medianMs: number | null;
}

export interface MetricsIndexRun {
  at: string;
  mode: "full" | "incremental";
  totalMs: number;
}

export interface AkmMetricsResult {
  schemaVersion: 1;
  window: { since: string; until: string };
  filters: { source: string; bundles: string[]; ref?: string };
  usage: {
    totals: {
      searches: number;
      shows: number;
      curates: number;
      selects: number;
      zeroResultSearches: number;
      distinctAssets: number;
      distinctQueries: number;
    };
    /** selects / searches that returned at least one hit; `null` when that is 0. */
    selectRate: number | null;
    /** Median persisted search `totalMs`; `null` when no row in the window carries one. */
    searchMedianMs: number | null;
    daily: MetricsDailyUsage[];
    topAssets: MetricsAssetUsage[];
    topQueries: MetricsQueryCount[];
    zeroResultQueries: MetricsQueryCount[];
    bySource: Record<string, number>;
  };
  feedback: {
    totals: { positive: number; negative: number };
    byAsset: MetricsFeedbackAsset[];
    byTag: Record<string, { positive: number; negative: number }>;
    recentNegative: MetricsNegativeFeedback[];
  };
  utility: {
    /** Rows in utility_scores (after filters). 0 with a note when index.db is missing. */
    count: number;
    /** Ten buckets: "0.0-0.1" … "0.9-1.0". */
    histogram: Array<{ bucket: string; count: number }>;
    lowest: MetricsUtilityAsset[];
    highest: MetricsUtilityAsset[];
    /** Indexed entries with no utility_scores row. */
    neverUsed: number;
  };
  outcomes: { lowestOutcome: MetricsOutcomeAsset[] };
  llm: LlmUsageAggregate;
  index: { runs: number; medianMs: number | null; recent: MetricsIndexRun[] };
  tasks: { runs: number; failed: number; failRate: number | null; byTask: MetricsTaskSummary[] };
  proposals: { byStatus: Record<string, number>; acceptRateBySource: AcceptRateEntry[] };
  workflows: { runs: number; byStatus: Record<string, number>; tokens: number; byModel: Record<string, number> };
  /**
   * Window rows: usage rows as recorded, LLM calls summed per day and
   * dimension. Present when `--format html` or `--detail full`; the HTML
   * dashboard re-aggregates from these client-side.
   */
  rows?: { usage: MetricsUsageRow[]; llm: MetricsLlmRow[] };
  notes: string[];
}
