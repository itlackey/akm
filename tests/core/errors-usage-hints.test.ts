// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit coverage for the `UsageErrorCode` members COMPOSITION_INVALID,
 * TASK_SOURCE_INVALID, TARGET_REF_INVALID, WORKFLOW_SOURCE_INVALID and
 * INPUT_BINDING_INVALID, and their `USAGE_HINTS` entries:
 * `new UsageError('x', '<code>').hint()` returns the hint string below for
 * each of the five.
 *
 * This is a unit-level companion to `tests/integration/cli-errors.test.ts`'s
 * hint coverage. This file tests `src/core/errors.ts` directly with no
 * CLI/process plumbing.
 */

import { describe, expect, test } from "bun:test";
import { UsageError, type UsageErrorCode } from "../../src/core/errors";

/**
 * The five codes, each paired with its required USAGE_HINTS entry. Typing this
 * array as `UsageErrorCode` is deliberate: a code missing from the
 * UsageErrorCode union fails to typecheck here, which is not a mistake to work
 * around with a cast.
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

describe("diagnostics — five new UsageErrorCode members + USAGE_HINTS", () => {
  for (const [code, expectedHint] of NEW_CODE_HINTS) {
    test(`${code}: constructible as a UsageError, kind "usage", code round-trips, hint() returns the exact string`, () => {
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
