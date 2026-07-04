// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Coverage-hardening: `classifyImproveAction` classification boundaries.
 *
 * MEMORY records a real production bug (deep-tuning #1, fixed in beta.50):
 * gated SKIPS were folded into `rejected`, so `rejectedCount` was dominated by
 * the ~13k-ref gated pool and the "accept rate" was meaningless. The fix routed
 * gated skips into a new `skipped` bucket and left `rejected` for genuine
 * content-policy rejections only.
 *
 * The existing suite only exercises 4-5 of the 11 `ImproveActionMode` variants
 * (via `computeImproveRunMetrics` in tests/state-db/improve-runs.test.ts). This
 * file pins the bucket for EVERY variant of the canonical union directly, so a
 * future edit that silently re-collapses skipped→rejected (or any other bucket
 * drift) fails here. This is the exact "one shape tested, other branches could
 * be broken" gap the coverage-hardening pass targets.
 */

import { describe, expect, test } from "bun:test";
import { classifyImproveAction, type ImproveActionClass, type ImproveActionMode } from "../../src/core/improve-types";

// The full canonical union, kept in sync with `ImproveActionMode`. If a new
// variant is added to the source union but not here, the `assertNever` arm in
// classifyImproveAction throws for it — but this table also documents intent.
const EXPECTED: ReadonlyArray<readonly [ImproveActionMode, ImproveActionClass]> = [
  ["reflect", "accepted"],
  ["distill", "accepted"],
  ["memory-inference", "accepted"],
  ["graph-extraction", "accepted"],
  ["reflect-cooldown", "skipped"],
  ["reflect-skipped", "skipped"],
  ["distill-skipped", "skipped"],
  ["reflect-guard-rejected", "rejected"],
  ["reflect-failed", "error"],
  ["error", "error"],
  ["memory-prune", "noop"],
];

describe("classifyImproveAction — every variant maps to its documented bucket", () => {
  for (const [mode, cls] of EXPECTED) {
    test(`${mode} => ${cls}`, () => {
      expect(classifyImproveAction(mode)).toBe(cls);
    });
  }
});

describe("classifyImproveAction — the skipped-vs-rejected boundary (deep-tuning #1)", () => {
  test("ALL gated skips classify as 'skipped', NEVER 'rejected'", () => {
    // This is the regression that polluted rejectedCount: cooldown / eligibility
    // / pool-delta skips are the run declining to act, not value-rejection.
    const gatedSkips: ImproveActionMode[] = ["reflect-cooldown", "reflect-skipped", "distill-skipped"];
    for (const mode of gatedSkips) {
      expect(classifyImproveAction(mode)).toBe("skipped");
      expect(classifyImproveAction(mode)).not.toBe("rejected");
    }
  });

  test("'reflect-guard-rejected' is the ONLY mode that classifies as 'rejected'", () => {
    const rejectedModes = EXPECTED.filter(([, cls]) => cls === "rejected").map(([mode]) => mode);
    expect(rejectedModes).toEqual(["reflect-guard-rejected"]);
  });

  test("failures classify as 'error', not 'accepted' or 'skipped'", () => {
    for (const mode of ["reflect-failed", "error"] as ImproveActionMode[]) {
      expect(classifyImproveAction(mode)).toBe("error");
    }
  });

  test("'memory-prune' is bookkeeping noop — counted in NO numeric bucket", () => {
    // A noop must not inflate accepted/rejected/skipped/error.
    expect(classifyImproveAction("memory-prune")).toBe("noop");
  });
});

describe("classifyImproveAction — bucket partition invariants", () => {
  test("every mapped class is one of the five canonical buckets", () => {
    const canonical: ImproveActionClass[] = ["accepted", "rejected", "skipped", "error", "noop"];
    for (const [mode] of EXPECTED) {
      expect(canonical).toContain(classifyImproveAction(mode));
    }
  });

  test("bucket distribution matches the documented taxonomy counts", () => {
    const counts: Record<ImproveActionClass, number> = {
      accepted: 0,
      rejected: 0,
      skipped: 0,
      error: 0,
      noop: 0,
    };
    for (const [mode] of EXPECTED) {
      counts[classifyImproveAction(mode)] += 1;
    }
    // 4 write-actions accepted, 3 gated skips, 1 guard-reject, 2 errors, 1 noop.
    expect(counts).toEqual({ accepted: 4, rejected: 1, skipped: 3, error: 2, noop: 1 });
  });
});
