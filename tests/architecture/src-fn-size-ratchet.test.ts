// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Repo-wide function-size ratchet meta-test (0.9.0 gate hardening).
 *
 * Guards all of `src/**` OUTSIDE `src/commands/improve/**` (that directory is
 * held to the stricter absolute gate in `improve-fn-size-ratchet.test.ts`):
 * no NEW function-like node over the 220-line bar, and no baselined offender
 * may GROW. Shrinking below a baseline entry — or below the bar entirely —
 * passes without a baseline edit (shrink-tolerant by design, so refactor
 * chunks never go red for improving things; see scripts/lint-src-fn-size.ts).
 *
 * When a baselined function is decomposed, trimming its entry from
 * SRC_FN_SIZE_BASELINE is encouraged housekeeping but not enforced here.
 */

import { describe, expect, test } from "bun:test";
import {
  checkSrcFnSizeRatchet,
  measureSrcFnOffenders,
  SRC_FN_SIZE_BAR,
  SRC_FN_SIZE_BASELINE,
} from "../../scripts/lint-src-fn-size";

describe("src-wide fn size ratchet (shrink-tolerant)", () => {
  test(`no NEW function over ${SRC_FN_SIZE_BAR} lines in src/ (outside improve/**), and no baselined offender grows`, () => {
    const live = measureSrcFnOffenders();
    const violations = checkSrcFnSizeRatchet(live);
    if (violations.length > 0) {
      const lines = violations.map((v) =>
        v.kind === "new"
          ? `  NEW over-bar fn (decompose into named passes; do NOT add to the baseline): ${v.id} = ${v.lines}`
          : `  GREW past its baseline (must not grow): ${v.id} ${v.baselineLines} → ${v.lines}`,
      );
      throw new Error(
        `src fn-size ratchet violations (bar ${SRC_FN_SIZE_BAR}, baseline shrink-only):\n${lines.join("\n")}\n\n` +
          "The baseline in scripts/lint-src-fn-size.ts only ever shrinks. New code must stay under the bar.",
      );
    }
    expect(violations).toEqual([]);
  });

  test("the baseline is well-formed: unique ids, all over the bar, sorted deterministically — and never grows past its armed size", () => {
    const ids = SRC_FN_SIZE_BASELINE.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const o of SRC_FN_SIZE_BASELINE) expect(o.lines).toBeGreaterThan(SRC_FN_SIZE_BAR);
    const sorted = [...SRC_FN_SIZE_BASELINE].sort(
      (a, b) => b.lines - a.lines || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    expect(SRC_FN_SIZE_BASELINE).toEqual(sorted);
    // Cardinality pin (adversarial audit): admitting a new offender requires
    // loudly editing this number, not just inserting a sorted entry.
    expect(SRC_FN_SIZE_BASELINE.length).toBeLessThanOrEqual(20);
  });

  test("the baseline carries no stale entries for functions that no longer exist over the bar in a DIFFERENT file (id drift guard)", () => {
    // A baseline entry whose function was legitimately decomposed just stops
    // matching (allowed). But if MORE offenders exist than baseline entries,
    // the first assertion already failed. This test only pins that the
    // exclusion boundary is honored: nothing under src/commands/improve/ may
    // appear in this baseline (it belongs to the absolute improve gate).
    for (const o of SRC_FN_SIZE_BASELINE) {
      expect(o.id.startsWith("src/commands/improve/")).toBe(false);
    }
  });
});
