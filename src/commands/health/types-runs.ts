// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Per-run improve summary shape (chunk-9 WI-9.5d per-domain split of
 * `./types`). Used by `akm health --group-by run` and the HTML/Markdown
 * report renderers.
 */

import type { ImproveHealthMetrics } from "./types-improve";

export interface ImproveRunSummary {
  id: string;
  startedAt: string;
  completedAt: string;
  wallTimeMs: number;
  ok: boolean;
  /** Decoder disposition for this persisted result row. */
  resultStatus?: "valid" | "normalized" | "invalid";
  /** True when the decoded envelope is complete rather than terminated/normalized/invalid. */
  resultComplete?: boolean;
  strategy: string | null;
  legacyProfile: string | null;
  scope: { mode: string; value?: string };
  /**
   * The scheduled task that launched this improve run (e.g.
   * `akm-improve-frequent`), resolved by matching the run's start time to a
   * `task_history` row with a `task_id` beginning `akm-improve` (±5 min).
   * `"manual"` when no scheduled task matches (a hand-run `akm improve`).
   * Drives the health report's Task column + task filter.
   */
  taskId: string;
  actions: ImproveHealthMetrics["actions"];
  memorySummary: ImproveHealthMetrics["memorySummary"];
  memoryCleanup: ImproveHealthMetrics["memoryCleanup"];
  consolidation: ImproveHealthMetrics["consolidation"];
  memoryInference: ImproveHealthMetrics["memoryInference"];
  graphExtraction: ImproveHealthMetrics["graphExtraction"];
  reflectsWithErrorContext: number;
  evalCasesWritten: number;
  orphansPurged: number;
  lintFixed: number;
  lintFlagged: number;
}
