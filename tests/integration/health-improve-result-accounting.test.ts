// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { summarizeImproveRuns } from "../../src/commands/health/improve-metrics";
import type { ImproveResultEnvelope } from "../../src/core/improve-result";
import { openStateDatabase } from "../../src/core/state-db";
import { recordImproveRun } from "../../src/storage/repositories/improve-runs-repository";
import { type Cleanup, withIsolatedAkmStorage } from "../_helpers/sandbox";

let cleanup: Cleanup = () => {};

beforeEach(() => {
  cleanup = withIsolatedAkmStorage().cleanup;
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

describe("summarizeImproveRuns result-row accounting", () => {
  test("counts normalized rows and skips malformed rows without admitting them to metrics", () => {
    const now = Date.now();
    const db = openStateDatabase();

    const insert = (id: string, ageMs: number, result: unknown) => {
      const startedAt = new Date(now - ageMs).toISOString();
      recordImproveRun(db, {
        id,
        startedAt,
        completedAt: startedAt,
        stashDir: "/tmp/stash",
        dryRun: false,
        legacyProfile: "default",
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: (result as { ok?: unknown }).ok === true,
        result: result as ImproveResultEnvelope,
      });
    };

    try {
      insert("complete", 120_000, {
        schemaVersion: 1,
        ok: true,
        profile: "default",
        scope: { mode: "all" },
        dryRun: false,
        memorySummary: { eligible: 25, derived: 5 },
        plannedRefs: [{ ref: "memory:complete" }],
        actions: [],
      });
      insert("published-0.8-staleness", 150_000, {
        schemaVersion: 1,
        ok: true,
        scope: { mode: "all" },
        dryRun: false,
        memorySummary: { eligible: 7, derived: 2 },
        plannedRefs: [{ ref: "memory:stale-a" }, { ref: "memory:stale-b" }],
        actions: [],
        stalenessDetection: {
          considered: 8,
          deprecated: 2,
          confirmed: 4,
          skipped: 2,
          durationMs: 125,
          warnings: [],
        },
      });
      insert("known-interrupted", 90_000, {
        schemaVersion: 1,
        ok: false,
        profile: "default",
        scope: { mode: "all" },
        dryRun: false,
        plannedRefs: [],
        actions: [],
        terminated: { reason: "SIGTERM", at: new Date(now - 90_000).toISOString() },
      });
      insert("over-broad-legacy", 60_000, {
        schemaVersion: 1,
        ok: true,
        profile: "default",
        scope: { mode: "all" },
        dryRun: false,
        plannedRefs: Array.from({ length: 10 }, (_, index) => ({ ref: `memory:invalid-${index}` })),
        actions: [],
        terminated: { reason: "not-interrupted", at: new Date(now - 60_000).toISOString() },
      });
      insert("malformed-staleness", 45_000, {
        schemaVersion: 1,
        ok: true,
        scope: { mode: "all" },
        dryRun: false,
        memorySummary: { eligible: 999, derived: 999 },
        plannedRefs: Array.from({ length: 10 }, (_, index) => ({ ref: `memory:stale-invalid-${index}` })),
        actions: [],
        stalenessDetection: {
          considered: 8,
          deprecated: 2,
          confirmed: 4,
          skipped: 2,
          durationMs: 125,
        },
      });
      insert("unsupported-version", 30_000, {
        schemaVersion: 99,
        ok: true,
        scope: { mode: "all" },
        dryRun: false,
        memorySummary: { eligible: 999, derived: 999 },
        plannedRefs: Array.from({ length: 10 }, (_, index) => ({ ref: `memory:future-${index}` })),
        actions: [],
      });

      const summary = summarizeImproveRuns(db, new Date(now - 300_000).toISOString());

      // windows[].runs retains its historical all-row denominator. Decoder
      // accounting is additive and must not silently narrow that count.
      expect(summary.runCount).toBe(6);
      expect(summary.metrics.resultRows).toEqual({
        total: 6,
        included: 3,
        normalized: 1,
        skipped: { invalid: 3 },
      });
      expect(summary.metrics.plannedRefs).toBe(3);
      expect(summary.metrics.memorySummary).toEqual({ eligible: 25, derived: 5 });
    } finally {
      db.close();
    }
  });

  test("selects the latest complete snapshot deterministically when timestamps tie", () => {
    const now = Date.now();
    const timestamp = new Date(now - 60_000).toISOString();
    const db = openStateDatabase();

    try {
      // Insert in reverse lexical order so row encounter order cannot
      // accidentally provide the tie-break.
      for (const [id, ok, eligible] of [
        ["run-z", false, 90],
        ["run-a", true, 10],
      ] as const) {
        recordImproveRun(db, {
          id,
          startedAt: timestamp,
          completedAt: timestamp,
          stashDir: "/tmp/stash",
          dryRun: false,
          strategy: "default",
          scopeMode: "all",
          scopeValue: null,
          guidance: null,
          ok,
          result: {
            schemaVersion: 2,
            ok,
            strategy: "default",
            scope: { mode: "all" },
            dryRun: false,
            memorySummary: { eligible, derived: 1 },
            plannedRefs: [],
            actions: [],
          } as ImproveResultEnvelope,
        });
      }

      const summary = summarizeImproveRuns(db, new Date(now - 300_000).toISOString());
      expect(summary.metrics.memorySummary).toEqual({ eligible: 90, derived: 1 });
    } finally {
      db.close();
    }
  });
});
