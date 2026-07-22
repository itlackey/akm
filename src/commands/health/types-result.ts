// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Top-level `akm health` result shape (chunk-9 WI-9.5d per-domain split of
 * `./types`) — the return type of `akmHealth()`, combining every other
 * domain (checks, metrics, improve, session-log, per-run, window-compare).
 */

import type { HealthCheckResult } from "./types-checks";
import type { ImproveHealthMetrics } from "./types-improve";
import type { HealthMetrics } from "./types-metrics";
import type { ImproveRunSummary } from "./types-runs";
import type { SessionLogAdvisory } from "./types-session-log";
import type { DeltaEntry, WindowResult } from "./types-windows";

export interface AkmHealthResult {
  schemaVersion: 3;
  ok: boolean;
  status: "pass" | "warn" | "fail";
  since: string;
  hardChecks: HealthCheckResult[];
  advisories: HealthCheckResult[];
  metrics: HealthMetrics;
  improve: ImproveHealthMetrics;
  sessionLogAdvisories: SessionLogAdvisory[];
  runs?: ImproveRunSummary[];
  windows?: WindowResult[];
  deltas?: Record<string, DeltaEntry>;
}

/** Event type recorded on each completed improve run. */
export const IMPROVE_COMPLETED_EVENT = "improve_completed";

/** An active task older than this (ms) is treated as stuck. */
export const ACTIVE_RUN_WARN_MS = 15 * 60 * 1000;
