// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Meta-test for the shrink-only allowlist ratchet in
 * `scripts/lint-tests-isolation.ts`.
 *
 * The grandfather allowlist (Rule-1 `ALLOWED_FILES` + Rule-2
 * `ENV_ASSIGN_ALLOWED`) may only ever get SMALLER as files migrate onto the
 * `withIsolatedAkmStorage` composite. This test fails if the live combined size
 * grows past the recorded baseline — forcing the baseline to be lowered (never
 * raised) in any change that touches the lists. It also asserts the linter
 * itself is clean, so the ratchet and the rules are exercised together.
 */

import { describe, expect, test } from "bun:test";

import { ALLOWLIST_RATCHET_BASELINE, combinedAllowlistSize, lintAllTestFiles } from "../scripts/lint-tests-isolation";

describe("lint-tests-isolation allowlist ratchet", () => {
  test("combined allowlist never grows past the recorded baseline", () => {
    expect(combinedAllowlistSize()).toBeLessThanOrEqual(ALLOWLIST_RATCHET_BASELINE);
  });

  test("the recorded baseline tracks the live size (no stale slack)", () => {
    // The baseline must equal the live size: when entries are removed the
    // baseline is lowered in the same change. This prevents the ceiling from
    // silently drifting above the real count and re-opening room to grow.
    expect(ALLOWLIST_RATCHET_BASELINE).toBe(combinedAllowlistSize());
  });

  test("the test suite currently has zero isolation/determinism violations", () => {
    const violations = lintAllTestFiles();
    if (violations.length > 0) {
      const summary = violations.map((v) => `${v.file}:${v.line} [${v.rule}]`).join("\n");
      throw new Error(`lint-tests-isolation found violations:\n${summary}`);
    }
    expect(violations.length).toBe(0);
  });
});
