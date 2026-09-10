// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * "Not found" must mean exit 1 everywhere.
 *
 * STABILITY.md documents exit 1 as "requested resource missing" and scripts
 * branch on it, but three commands disagreed: `feedback` and `sync` raised
 * UsageError (exit 2, "you typed it wrong") for a well-formed ref that simply
 * did not exist, and `registry remove` returned a SUCCESS envelope with
 * `removed: false` and exit 0 — so `akm registry remove typo && deploy` ran
 * the deploy. A missing proposal additionally reported FILE_NOT_FOUND, whose
 * canned hint ("Check the path exists and is readable") describes a
 * filesystem path, not the id or ref the user actually passed.
 */

import { describe, expect, test } from "bun:test";
import { NotFoundError } from "../../src/core/errors";

describe("not-found error classification", () => {
  test("PROPOSAL_NOT_FOUND hints at the command that lists valid ids", () => {
    const err = new NotFoundError('Proposal "p-123" not found.', "PROPOSAL_NOT_FOUND");

    expect(err.hint()).toContain("akm proposal list");
    // The old FILE_NOT_FOUND hint pointed at a filesystem path, which a
    // proposal id never is.
    expect(err.hint()).not.toContain("path exists");
  });

  test("every not-found code carries the not-found kind (which maps to exit 1)", () => {
    for (const code of [
      "ASSET_NOT_FOUND",
      "SOURCE_NOT_FOUND",
      "WORKFLOW_NOT_FOUND",
      "PROPOSAL_NOT_FOUND",
      "FILE_NOT_FOUND",
      "IMPROVE_RUN_NOT_FOUND",
    ] as const) {
      expect(new NotFoundError("missing", code).kind).toBe("not-found");
    }
  });

  test("IMPROVE_RUN_NOT_FOUND hints at akm improve report, not raw sqlite3 (#944)", () => {
    const err = new NotFoundError("akm improve report: no improve runs recorded yet.", "IMPROVE_RUN_NOT_FOUND");

    expect(err.hint()).toContain("akm improve report --since 30d");
    // #944 exists specifically to make querying state.db by hand unnecessary
    // for this — the hint must not send operators back to raw sqlite3.
    expect(err.hint()).not.toContain("sqlite3");
  });

  test("an explicit hint overrides the code's canned one", () => {
    const err = new NotFoundError(
      'No registry matching "x" is configured.',
      "SOURCE_NOT_FOUND",
      "Run `akm registry list` to see configured registries.",
    );

    expect(err.hint()).toContain("akm registry list");
  });
});
