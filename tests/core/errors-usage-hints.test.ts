// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit coverage for the five new `UsageErrorCode` members added in P1a (D7)
 * and their `USAGE_HINTS` entries.
 *
 * See docs/plans/specs/p1a-with-rejection-classifier.md §2.1 (the exact hint
 * strings, reproduced verbatim below), §10 acceptance criterion 1
 * ("src/core/errors.ts declares all five new UsageErrorCode members and a
 * USAGE_HINTS entry for each, with the §2.1 strings"), and behavior row B-24
 * ("`new UsageError('x', '<new code>').hint()` for each of the five returns
 * the §2.1 hint string").
 *
 * This is a unit-level companion to `tests/integration/cli-errors.test.ts`'s
 * hint coverage (that file is a different lane's — see the spec's Lane 0
 * file list, which adds B-24 coverage there additively). This file tests
 * `src/core/errors.ts` directly with no CLI/process plumbing, and is a new
 * file: no existing unit test file for `src/core/errors.ts` was found under
 * `tests/` (only the integration-level `tests/integration/cli-errors.test.ts`
 * and `tests/integration/cli-global-error-handlers.test.ts` exist).
 *
 * TEST-FIRST NOTE: authored under Lane C before `src/core/errors.ts`
 * declares the five codes. The `NEW_CODE_HINTS` declaration below is typed
 * as `UsageErrorCode`, so this file is EXPECTED TO FAIL `bunx tsc --noEmit`
 * until the implementer appends the five members to the `UsageErrorCode`
 * union; the `hint()` assertions are EXPECTED TO FAIL AT RUNTIME too (`bun
 * test` does not type-check, so the mismatch surfaces as a real assertion
 * failure: `USAGE_HINTS` has no entry for an as-yet-undeclared code, so
 * `.hint()` returns `undefined` today) until the implementer also adds the
 * five `USAGE_HINTS` entries.
 */

import { describe, expect, test } from "bun:test";
import { UsageError, type UsageErrorCode } from "../../src/core/errors";

/**
 * The five new codes from spec §2.1, paired with their required USAGE_HINTS
 * entry, reproduced verbatim from the spec table. Typing this array as
 * `UsageErrorCode` is deliberate: until src/core/errors.ts appends these
 * five members to the UsageErrorCode union, this declaration itself fails to
 * typecheck. That compile error is part of this phase's "write failing
 * tests" contract, not a mistake to work around with a cast.
 */
const NEW_CODE_HINTS: ReadonlyArray<readonly [UsageErrorCode, string]> = [
  [
    "COMPOSITION_INVALID",
    "Remove the with: block, or target a tasks/<ref> whose source declares inputs: — commands/<ref> and scripts/<ref> steps are not binding surfaces.",
  ],
  ["TASK_SOURCE_INVALID", "Fix the task source at the reported path and line, then re-run."],
  [
    "TARGET_REF_INVALID",
    "Targets are canonical asset refs: `commands/review`, `scripts/build.sh`, `tasks/nightly`, `workflows/release`.",
  ],
  [
    "WORKFLOW_SOURCE_INVALID",
    "Run `akm lint` to see the failing source location, or `akm workflow plan <ref>` to compile it without writing.",
  ],
  ["INPUT_BINDING_INVALID", "Check the step's with: keys against the target's declared inputs."],
];

describe("D7 diagnostics — five new UsageErrorCode members + USAGE_HINTS (spec §2.1, B-24)", () => {
  for (const [code, expectedHint] of NEW_CODE_HINTS) {
    test(`${code}: constructible as a UsageError, kind "usage", code round-trips, hint() returns the exact §2.1 string`, () => {
      const error = new UsageError("x", code);
      expect(error).toBeInstanceOf(UsageError);
      expect(error).toBeInstanceOf(Error);
      expect(error.kind).toBe("usage");
      expect(error.code).toBe(code);
      expect(error.hint()).toBe(expectedHint);
    });

    test(`${code}: an explicit constructor hint still overrides the USAGE_HINTS default`, () => {
      const error = new UsageError("x", code, "explicit override");
      expect(error.hint()).toBe("explicit override");
    });
  }

  test("all five new codes are distinct from each other and from the pre-existing INVALID_FLAG_VALUE default code", () => {
    const codes = NEW_CODE_HINTS.map(([code]) => code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).not.toContain("INVALID_FLAG_VALUE");
  });

  test("regression guard: the pre-existing default code and its hint are unaffected by the five additions", () => {
    const error = new UsageError("x");
    expect(error.code).toBe("INVALID_FLAG_VALUE");
    expect(error.hint()).toBe("Run `akm <command> --help` to see accepted values.");
  });
});
