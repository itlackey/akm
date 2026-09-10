// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm bundle update --all` with nothing configured (or nothing to update)
 * never runs an embedding pass, so `readCurrentIndexSummary`'s fallback used
 * to build a `stubIndexVerification` (`ok: true, entryCount: 0,
 * embeddingCount: 0, vecAvailable: false`) for a run that verified nothing
 * (#954, field-report follow-up). `UpdateIndexSummary.verification` is now
 * optional and `stubIndexVerification` is gone; `buildUpdateResponse` derives
 * `index.semanticStatus` directly from `finalConfig.semanticSearchMode`
 * instead of reading it off a fabricated verification object.
 *
 * This is a hygiene/simplification fix, not a behavior fix, and these two
 * tests are accordingly pinning-not-regression tests: `stubIndexVerification`
 * computed `semanticStatus` with the exact same
 * `semanticSearchMode === "off" ? "disabled" : "pending"` ternary that
 * `buildUpdateResponse`'s fallback uses now, so `result.index.semanticStatus`
 * below was already correct before this change — a do-nothing revert to
 * `stubIndexVerification` would pass both assertions unchanged. What the fix
 * actually removes is the OTHER fabricated fields
 * (`entryCount`/`embeddingCount`/`vecAvailable`/`ok`/`message`); none of
 * those ever reached `UpdateResponse` (`buildUpdateResponse` only ever read
 * `.semanticStatus` off `verification`), so there is no independently
 * observable behavior difference for a test to pin beyond the
 * already-unchanged `semanticStatus` contract asserted here. This drives the
 * real `akmUpdate` coordinator (a real `index.db`, hence tests/integration/
 * per the ORG-03..06 rule).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { akmUpdate } from "../../src/commands/sources/installed-stashes";
import { saveConfig } from "../../src/core/config/config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

describe("akm bundle update: no-op fallback reports a real semanticStatus (#954)", () => {
  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });
  afterEach(() => {
    storage.cleanup();
  });

  test("--all with no configured sources reports 'disabled' when semantic search is off, not a fabricated verified state", async () => {
    saveConfig({ semanticSearchMode: "off" });

    const result = await akmUpdate({ stashDir: storage.stashDir, all: true });

    expect(result.processed).toEqual([]);
    expect(result.index.totalEntries).toBe(0);
    // The fallback never ran a real embedding pass — it must not report a
    // verified status ("ready-js"/"ready-vec"/"blocked"), only "disabled".
    expect(result.index.semanticStatus).toBe("disabled");
  });

  test("--all with no configured sources reports 'pending' when semantic search is on, not a fabricated 0/0 verification", async () => {
    saveConfig({ semanticSearchMode: "auto" });

    const result = await akmUpdate({ stashDir: storage.stashDir, all: true });

    expect(result.processed).toEqual([]);
    expect(result.index.totalEntries).toBe(0);
    // "pending", not "ready-js"/"ready-vec" — nothing was actually verified
    // this run, so the fallback must not claim otherwise.
    expect(result.index.semanticStatus).toBe("pending");
  });
});
