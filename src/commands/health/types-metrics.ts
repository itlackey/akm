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
  /**
   * #943: reason-value breakdown behind {@link agentFailureRate} — how many
   * command-task failures in the window carry each `detail.reason` value
   * (`timeout`, `non_zero_exit`, `spawn_failed`, …; see `AgentFailureReason`
   * in `src/integrations/agent/spawn.ts`). Lets a health consumer see
   * "timeout-dominant" from data instead of grepping task logs.
   */
  agentFailureReasonCounts: Record<string, number>;
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
  /** Count of calls whose `outcome` was `"error"` (#944). Additive to the existing shape. */
  failures: number;
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
  /** Count of calls whose `outcome` was `"error"` (#944). Additive to the existing shape. */
  failures: number;
}

/**
 * One row of the process x engine x model cross-tab (#944) —
 * {@link LlmUsageStageAggregate}'s fields keyed on the composite identity of a
 * call, instead of on one dimension at a time like `byStage`/`byProcess`/
 * `byEngine`. Answers "which engine/model did a given process actually use,
 * and what did it cost" in one row instead of requiring a caller to
 * cross-reference three separate 1-D breakdowns by hand.
 */
export interface LlmUsageCrossTabRow extends LlmUsageStageAggregate {
  /** Owning process, or `"unattributed"` when the call carried no `process`. */
  process: string;
  /** Selected engine name, or `"unattributed"` when the call carried no `engine`. */
  engine: string;
  /** Model id, or `"unattributed"` when the call carried no `model`. */
  model: string;
}
