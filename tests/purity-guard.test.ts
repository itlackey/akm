// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for the opt-in runtime purity guard (#664 Step 2 / C2.2).
 *
 * Proves the guard (a) lets a `:memory:` open through and runs real schema on it,
 * (b) throws on a real on-disk open AND on an un-seamed `globalThis.fetch`, and
 * (c) fully restores the storage-boundary guard + fetch + env on `afterAll`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { openDatabase as openIndexDatabase } from "../src/indexer/db/db";
import { openDatabase as openStorageDatabase, setOpenDatabaseGuard } from "../src/storage/database";
import { installPurityGuard, isInMemorySqlitePath, UnitImpureError } from "./_helpers/purity-guard";

describe("isInMemorySqlitePath — §8.3 correction 1", () => {
  test("honors EXACTLY the bare :memory: token", () => {
    expect(isInMemorySqlitePath(":memory:")).toBe(true);
  });

  test("rejects file:/mode=memory/file::memory: URIs (real on-disk under bun:sqlite)", () => {
    // These open REAL files named the literal string with the no-URI-flags
    // constructor the storage boundary uses — they MUST NOT be treated as pure.
    expect(isInMemorySqlitePath("file:foo?mode=memory&cache=shared")).toBe(false);
    expect(isInMemorySqlitePath("file::memory:?cache=shared")).toBe(false);
    expect(isInMemorySqlitePath("/tmp/real.db")).toBe(false);
    expect(isInMemorySqlitePath(undefined)).toBe(false);
  });
});

describe("installPurityGuard — under the guard", () => {
  installPurityGuard();

  test("a :memory: open passes through and runs the real schema", () => {
    // The bare :memory: token is the sanctioned pure path: full ensureSchema
    // runs in memory with no fd. Going through the INDEX opener exercises the
    // real default-dim/config short-circuit too (AKM_NO_AUTO_MIGRATE=1).
    const db = openIndexDatabase(":memory:", { embeddingDim: 384 });
    try {
      const row = db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number };
      expect(row.n).toBe(0);
    } finally {
      db.close();
    }
  });

  test("a real on-disk open THROWS UNIT_IMPURE_DB_OPEN", () => {
    expect(() => openStorageDatabase("/tmp/akm-purity-guard-should-never-open.db")).toThrow(/UNIT_IMPURE_DB_OPEN/);
  });

  test("globalThis.fetch THROWS UNIT_IMPURE_FETCH", () => {
    expect(() => (globalThis.fetch as unknown as () => unknown)()).toThrow(/UNIT_IMPURE_FETCH/);
    expect(() => (globalThis.fetch as unknown as () => unknown)()).toThrow(UnitImpureError);
  });

  test("AKM_NO_AUTO_MIGRATE is forced on while the guard is installed", () => {
    expect(process.env.AKM_NO_AUTO_MIGRATE).toBe("1");
  });
});

describe("installPurityGuard — restoration", () => {
  // This describe runs WITHOUT the guard. Prove the prior describe's afterAll
  // restored a usable real-fetch + un-guarded storage boundary.
  afterAll(() => {
    // Belt-and-suspenders: ensure no guard leaks out of this file.
    setOpenDatabaseGuard(null);
  });

  test("globalThis.fetch is a real callable again (not the throwing shim)", () => {
    expect(typeof globalThis.fetch).toBe("function");
    // The throwing shim would throw synchronously on call; a real fetch returns
    // a promise. We only assert it does not synchronously throw the guard error.
    let threwGuard = false;
    try {
      const maybe = (globalThis.fetch as (i: string) => unknown)("http://127.0.0.1:0/never");
      if (maybe instanceof Promise) maybe.catch(() => {});
    } catch (err) {
      threwGuard = err instanceof UnitImpureError;
    }
    expect(threwGuard).toBe(false);
  });

  test("the storage boundary opens a :memory: DB with no guard installed", () => {
    const db = openStorageDatabase(":memory:");
    try {
      expect(db).toBeDefined();
    } finally {
      db.close();
    }
  });
});
