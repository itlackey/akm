// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Top-level `akm health` metrics + LLM usage aggregates. */

export interface HealthMetrics {
  taskFailRate: number;
  agentFailureRate: number;
  /**
   * #943: reason-value breakdown behind {@link agentFailureRate} — how many
   * command-task failures in the window carry each `detail.reason` value
   * (`timeout`, `non_zero_exit`, `spawn_failed`, …; see `AgentFailureReason`
   * in `src/integrations/agent/spawn.ts`).
   */
  agentFailureReasonCounts: Record<string, number>;
  stuckActiveRuns: number;
  /**
   * LLM usage aggregated from the window's `llm_usage` events (#576): real
   * token + wall-time accounting, attributed to the stage, process, and engine
   * that made each call. Calls outside any stage land under `unattributed`.
   */
  llmUsage: LlmUsageAggregate;
}

/** Aggregated LLM usage over a window: a total plus per-dimension breakdowns. */
export interface LlmUsageAggregate {
  /** Number of `llm_usage` events (== number of LLM calls) in the window. */
  calls: number;
  totalDurationMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  /** Count of calls whose `outcome` was `"error"` (#944). */
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
  /** Count of calls whose `outcome` was `"error"` (#944). */
  failures: number;
}

/**
 * One row of the process x engine x model cross-tab (#944) —
 * {@link LlmUsageStageAggregate}'s fields keyed on the composite identity of a
 * call. Consumed by `akm improve report`.
 */
export interface LlmUsageCrossTabRow extends LlmUsageStageAggregate {
  /** Owning process, or `"unattributed"` when the call carried no `process`. */
  process: string;
  /** Selected engine name, or `"unattributed"` when the call carried no `engine`. */
  engine: string;
  /** Model id, or `"unattributed"` when the call carried no `model`. */
  model: string;
}
