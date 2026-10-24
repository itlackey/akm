// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Top-level `akm health` result shape (chunk-9 WI-9.5d per-domain split of
 * `./types`) — the return type of `akmHealth()`, combining every other
 * domain (checks, metrics, improve, per-run, window-compare).
 */

import type { AcceptRateEntry } from "./accept-rate";
import type { HealthCheckResult } from "./types-checks";
import type { ImproveHealthMetrics } from "./types-improve";
import type { HealthMetrics } from "./types-metrics";
import type { ImproveRunSummary } from "./types-runs";
import type { DeltaEntry, WindowResult } from "./types-windows";

/**
 * The extra dataset `akm health --report` adds over the plain check: the
 * report parameters as the user spelled them, plus the pending proposal queue.
 * A DATA field, not presentation — its presence is what lets the registered
 * md/html report renderers stay pure functions of the result, and it is what
 * makes the full report reachable in every `--format`, not just `html`.
 */
export interface HealthReportContext {
  /** Window label as the user typed it (`--since`), e.g. "24h". */
  window: string;
  /** Duration label or chronological explicit-window names, e.g. "24h" or "older → newer". */
  compare: string;
  /** Whether `compare` names one duration or the explicit `--windows` sequence. */
  comparisonMode: "duration" | "custom";
  /** Pending proposal queue at report time. */
  pendingProposals: { ref: string; source: string; createdAt: string }[];
  /**
   * Accept-rate-per-source metrics (F-4 / #385), folded from the removed
   * `akm history --accept-rate-by-source` flag. See ./accept-rate.ts.
   */
  acceptRateBySource: AcceptRateEntry[];
}

export interface AkmHealthResult {
  schemaVersion: 3;
  ok: boolean;
  status: "pass" | "warn" | "fail";
  since: string;
  hardChecks: HealthCheckResult[];
  advisories: HealthCheckResult[];
  metrics: HealthMetrics;
  improve: ImproveHealthMetrics;
  runs?: ImproveRunSummary[];
  windows?: WindowResult[];
  deltas?: Record<string, DeltaEntry>;
  report?: HealthReportContext;
}

/** Event type recorded on each completed improve run. */
export const IMPROVE_COMPLETED_EVENT = "improve_completed";

/** An active task older than this (ms) is treated as stuck. */
export const ACTIVE_RUN_WARN_MS = 15 * 60 * 1000;
