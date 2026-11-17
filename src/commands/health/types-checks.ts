// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Health-check result shape (chunk-9 WI-9.5d per-domain split of `./types`).
 * Consumed by the check registry (`health/checks.ts`), the advisory
 * collectors, and the report renderers.
 */

/**
 * Why a check has no result: the feature is `off`, the probe was `not-probed`, the check `blocked` (it could not run
 * or could not decide), or nothing has happened yet (`idle`).
 */
export type HealthUnknownReason = "off" | "not-probed" | "blocked" | "idle";

export interface HealthCheckResult {
  name: string;
  kind: "deterministic" | "heuristic";
  status: "pass" | "warn" | "fail" | "unknown";
  /** Set on every `unknown` result, from the code path that knows; absent on any other status. */
  reason?: HealthUnknownReason;
  message: string;
  confidence: "high" | "medium" | "low";
  evidence?: Record<string, unknown>;
}
