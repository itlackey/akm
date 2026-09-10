// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure, no-DB coverage for `isSqliteContentionError` (#948) — the single
 * shared classifier `isRetryableBeginError` (state-db.ts) and
 * `isLeaseContentionSqliteError` (workflow-runs-repository.ts) both now
 * delegate to. Codes, message shapes, the phantom-BEGIN marker, and the
 * negative cases that must NOT be classified as contention.
 */

import { describe, expect, test } from "bun:test";
import { isSqliteContentionError } from "../../src/core/state-db";

describe("isSqliteContentionError (pure, no DB)", () => {
  test("SQLITE_BUSY code is contention", () => {
    expect(isSqliteContentionError(Object.assign(new Error("busy"), { code: "SQLITE_BUSY" }))).toBe(true);
  });

  test("SQLITE_LOCKED code is contention", () => {
    expect(isSqliteContentionError(Object.assign(new Error("locked"), { code: "SQLITE_LOCKED" }))).toBe(true);
  });

  test('"database is locked" message text is contention', () => {
    expect(isSqliteContentionError(new Error("database is locked"))).toBe(true);
  });

  test('"database table is locked" message text is contention', () => {
    expect(isSqliteContentionError(new Error("database table is locked"))).toBe(true);
  });

  test("message matching is case-insensitive", () => {
    expect(isSqliteContentionError(new Error("Database Is Locked"))).toBe(true);
  });

  test("the phantom-BEGIN marker is contention", () => {
    expect(
      isSqliteContentionError(new Error("BEGIN IMMEDIATE did not open a transaction (phantom contention state)")),
    ).toBe(true);
  });

  test("a non-Error thrown value is handled via String() coercion", () => {
    expect(isSqliteContentionError("database is locked")).toBe(true);
    expect(isSqliteContentionError("some unrelated string")).toBe(false);
  });

  test("an unrelated Error is NOT contention", () => {
    expect(isSqliteContentionError(new Error("NOT NULL constraint failed: t.x"))).toBe(false);
  });

  test("corruption-shaped text NOT in the shared set (disk I/O error) is NOT contention", () => {
    // Distinct from workflow-runs-repository.ts's isLeaseContentionSqliteError,
    // which adds this text on top of the shared classifier for its own
    // narrower cross-process race (with a live-lease confirmation before
    // reclassifying). The shared classifier alone must not match it.
    expect(isSqliteContentionError(new Error("disk I/O error"))).toBe(false);
  });

  test("corruption-shaped text NOT in the shared set (disk image malformed) is NOT contention", () => {
    expect(isSqliteContentionError(new Error("database disk image is malformed"))).toBe(false);
  });

  test("an unrelated error carrying an unrelated code is NOT contention", () => {
    expect(isSqliteContentionError(Object.assign(new Error("nope"), { code: "SQLITE_CONSTRAINT" }))).toBe(false);
  });
});
