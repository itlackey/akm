// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `cli-usage-store` advisory for `akm doctor`: CLI usage capture is fail-open, so a corrupt `cli_usage_*` store
 * stops collection permanently without any command failing. Silent when the store is absent or readable. Tables
 * are never recreated here.
 */

import { usageStoreProblem } from "../../cli/usage";
import type { HealthCheckResult } from "./types";

export function collectCliUsageStoreAdvisory(
  problem: () => string | undefined = usageStoreProblem,
): HealthCheckResult | undefined {
  const reason = problem();
  if (reason === undefined) return undefined;
  return {
    name: "cli-usage-store",
    kind: "deterministic",
    status: "warn",
    confidence: "high",
    message: `The CLI usage store (metrics.db) cannot be read, so usage collection has stopped: ${reason}. Move or delete metrics.db to restart collection.`,
    evidence: { reason },
  };
}
