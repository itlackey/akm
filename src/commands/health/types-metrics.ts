// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Top-level `akm health` metrics + LLM usage aggregates (chunk-9 WI-9.5d
 * per-domain split of `./types`).
 */

export interface HealthMetrics {
  taskFailRate: number;
  agentFailureRate: number;
  stuckActiveRuns: number;
  logBackingRate: number;
  probeRoundTripMs: number | null;
  /**
   * Per-stage LLM usage aggregates (#576), derived from `llm_usage` events in
   * the window. Replaces the prior GPU-time proxy: real token + wall-time
   * accounting attributed to the pipeline stage that made each call. `stages`
   * is keyed by stage name (`"reflect"`, `"memory-inference"`, …); calls made
   * outside any stage scope land under the `unattributed` key.
   */
  llmUsage: LlmUsageAggregate;
}

/** Aggregated LLM usage over a window: a total plus a per-stage breakdown. */
export interface LlmUsageAggregate {
  /** Number of `llm_usage` events (== number of LLM calls) in the window. */
  calls: number;
  totalDurationMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  /** Per-stage breakdown, keyed by stage name (unscoped calls → `unattributed`). */
  byStage: Record<string, LlmUsageStageAggregate>;
  /** Per-process breakdown using durable improve/runtime attribution. */
  byProcess: Record<string, LlmUsageStageAggregate>;
  /** Per-engine breakdown using the selected public engine name. */
  byEngine: Record<string, LlmUsageStageAggregate>;
}

/** LLM usage totals for one pipeline stage. */
export interface LlmUsageStageAggregate {
  calls: number;
  totalDurationMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
}
