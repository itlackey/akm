// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `RUN_LEASE_HELD` is the dedicated `TransientErrorCode` a workflow run-lease
 * refusal carries (#948 addendum, dev-team field review 2026-09-09 — moved
 * off `UsageError`/exit 2 onto `TransientError`/exit 75 so a cron wrapper can
 * retry instead of alerting), distinct from the generic `INVALID_FLAG_VALUE`
 * `UsageErrorCode` default — a caller branching on `code` can retry this one,
 * unlike a bad flag.
 */

import { describe, expect, test } from "bun:test";
import { TransientError, UsageError } from "../../src/core/errors";

describe("RUN_LEASE_HELD", () => {
  test("constructible, kind transient, code round-trips, and carries its own default hint", () => {
    const error = new TransientError("Workflow run x is already being driven by engine y.", "RUN_LEASE_HELD");
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe("transient");
    expect(error.code).toBe("RUN_LEASE_HELD");
    expect(error.hint()).toBeDefined();
    expect(error.hint()).not.toBe(new UsageError("x").hint());
  });

  test("an explicit constructor hint still overrides the default", () => {
    const error = new TransientError("x", "RUN_LEASE_HELD", "explicit override");
    expect(error.hint()).toBe("explicit override");
  });

  test("distinct from the default INVALID_FLAG_VALUE UsageError code a caller might otherwise conflate it with", () => {
    expect(new TransientError("x", "RUN_LEASE_HELD").code).not.toBe(new UsageError("x").code);
  });

  test("not a UsageError — it must not classify as exit 2 (#948 addendum)", () => {
    const error = new TransientError("x", "RUN_LEASE_HELD");
    expect(error).not.toBeInstanceOf(UsageError);
  });
});
