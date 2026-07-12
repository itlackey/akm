// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { summarizeImproveRuns } from "../src/commands/health/improve-metrics";
import { openStateDatabase } from "../src/core/state-db";
import { recordImproveRun } from "../src/storage/repositories/improve-runs-repository";

describe("health v3 legacy profile metrics", () => {
  test("does not relabel v1 profileFilteredRefs as strategyFilteredRefs", () => {
    const db = openStateDatabase();
    try {
      const now = new Date().toISOString();
      const result = {
        schemaVersion: 1 as const,
        ok: true,
        profile: "nightly",
        scope: { mode: "all" as const },
        dryRun: false,
        memorySummary: { eligible: 1, derived: 0 },
        plannedRefs: [],
        actions: [],
        profileFilteredRefs: [{ ref: "script:legacy", reason: "strategy_filtered_all_passes" as const }],
      };
      recordImproveRun(db, {
        id: "legacy-profile-metric",
        startedAt: now,
        completedAt: now,
        stashDir: "/tmp/legacy",
        dryRun: false,
        legacyProfile: "nightly",
        strategy: null,
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result,
      });
      expect(summarizeImproveRuns(db, new Date(Date.now() - 60_000).toISOString()).metrics.strategyFilteredRefs).toBe(
        0,
      );
    } finally {
      db.close();
    }
  });
});
