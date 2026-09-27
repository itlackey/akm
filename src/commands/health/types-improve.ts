// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Improve-pipeline metric shapes for `akm health`: the window-level
 * {@link ImproveHealthMetrics} accumulator. Every field here is rendered by
 * the md/html report, read per window by the Discord health script
 * (`improve.coverage.distinctRefs`), or diffed by `--window-compare`. A
 * counter nothing renders does not belong here.
 */

export interface ImproveResultRowAccounting {
  /** Non-dry-run improve-result rows observed in the requested window. */
  total: number;
  /** Rows decoded and admitted to result-derived metrics. */
  included: number;
  /** Rows omitted from result-derived metrics, grouped by bounded reason. */
  skipped: { invalid: number };
}

export interface ImproveHealthMetrics {
  /** `improve_invoked` events in the window. */
  invoked: number;
  /** `improve_completed` events in the window. */
  completed: number;
  /** `improve_skipped` events in the window; see {@link skipReasons}. */
  skipped: number;
  /**
   * `skipped` by reason. A per-occurrence event counts 1; a reason whose
   * events carry a `count` (a whole-stash snapshot such as `no_new_signal`)
   * reports the most recent run's count, never the sum across runs.
   */
  skipReasons: Record<string, number>;
  /** Always emitted by `akm health`; optional for hand-built values. */
  resultRows?: ImproveResultRowAccounting;
  /** `improve_runs.result_json.actions[]` outcomes by mode. */
  actions: {
    reflect: { ok: number; failed: number; cooldown: number; skipped: number };
    distill: {
      queued: number;
      llmFailed: number;
      /** LLM-judge rejection (`quality_rejected` / `review_needed`). */
      judgeRejected: number;
      /** Deterministic lint/schema rejection (`validation_failed`). */
      validatorRejected: number;
      configDisabled: number;
      /** Pre-loop skips (`distillSkipped.total`); by reason in {@link skippedByReason}. */
      skipped: number;
      skippedByReason: Record<string, number>;
    };
    memoryPrune: number;
    memoryInference: number;
    graphExtraction: number;
    error: number;
  };
  autoAccept: {
    /** Proposals promoted by the auto-accept gate. */
    promoted: number;
    /** Proposals that passed the confidence threshold but failed validation; they stay pending. */
    validationFailed: number;
  };
  /** Whole-stash snapshot from the newest complete run in the window — never a sum across runs. */
  memorySummary: { eligible: number; derived: number };
  consolidation: {
    processed: number;
    promoted: number;
    merged: number;
    deleted: number;
    contradicted: number;
    /** Memories the LLM saw in a chunk but proposed no op for. */
    judgedNoAction: number;
    failedChunks: number;
    totalChunks: number;
    durationMs: number;
  };
  memoryInference: {
    /** Pending parents inspected, including cache hits. */
    considered: number;
    /** `considered − cacheHits − skippedAborted`: parents that actually hit the LLM. */
    freshAttempts: number;
    written: number;
    skippedNoFacts: number;
    /** `written / freshAttempts`, 4dp; 0 when `freshAttempts` is 0. */
    yieldRate: number;
    durationMs: number;
  };
  graphExtraction: {
    extractedFiles: number;
    entities: number;
    relations: number;
    failures: number;
    durationMs: number;
  };
  /** Wall time of the window's improve runs (nearest-rank percentiles). */
  wallTime: { medianMs: number; p95Ms: number };
  /**
   * Proposals accepted in the window (`updated_at` within `[since, until)`).
   * `distinctRefs` counts assets touched — repeated rewrites of one asset
   * count once — and is what the Discord health script reads per window.
   */
  coverage: { acceptedProposals: number; distinctRefs: number };
}

/**
 * Cron task failure rate at or above which the `task-fail-rate` advisory
 * warns; also the HTML report's fail-rate badge cutoff, so the two cannot drift.
 */
export const TASK_FAIL_RATE_WARN = 0.05;

/**
 * Minimum task_history rows a single task_id needs in the window before its
 * own fail rate feeds `task-fail-rate` — a task run once and failed once is
 * not a 100% signal.
 */
export const MIN_ROWS_FOR_WORST_TASK_FAIL_RATE = 5;
