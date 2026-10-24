// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Health-check result shape.
 * Consumed by the check registry (`health/checks.ts`), the advisory
 * collectors, and the report renderers.
 */

export interface HealthCheckResult {
  name: string;
  kind: "deterministic" | "heuristic";
  status: "pass" | "warn" | "fail" | "unknown";
  message: string;
  confidence: "high" | "medium" | "low";
  evidence?: Record<string, unknown>;
}
