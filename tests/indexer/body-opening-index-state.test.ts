// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { getMeta, setMeta } from "../../src/indexer/db/db";
import { reconcileBodyOpeningIndexState } from "../../src/indexer/indexer";
import type { Database as AkmDatabase } from "../../src/storage/database";

/**
 * SPEC-8 finalize-phase state tracking: the index_meta key `indexBodyOpening`
 * records which `index.indexBodyOpening` state the index was last FULLY built
 * with, and {@link reconcileBodyOpeningIndexState} returns a warning message
 * on every incremental run while the current flag diverges from it (the index
 * is MIXED until `akm index --full`).
 *
 * Review-fix pin: a missing meta key on an INCREMENTAL run means the index
 * predates the feature and was therefore built with the flag off — it must be
 * read and seeded as "0", never as the current flag value, so the real-world
 * upgrade-then-enable path warns instead of silently recording "1".
 */
describe("reconcileBodyOpeningIndexState (SPEC-8)", () => {
  let db: AkmDatabase;

  beforeEach(() => {
    db = new Database(":memory:") as unknown as AkmDatabase;
    db.exec("CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  });

  test("first build (full walk, no meta key): records the current flag, no warning", () => {
    expect(reconcileBodyOpeningIndexState(db, true, true)).toBeUndefined();
    expect(getMeta(db, "indexBodyOpening")).toBe("1");
  });

  test("first build with the flag off records '0', no warning", () => {
    expect(reconcileBodyOpeningIndexState(db, false, true)).toBeUndefined();
    expect(getMeta(db, "indexBodyOpening")).toBe("0");
  });

  test("pre-feature index + flag enabled + incremental run: warns and seeds '0' (review fix)", () => {
    // No meta key at all — the index was built by a pre-SPEC-8 version, i.e.
    // with the flag necessarily off. Enabling the flag and running a plain
    // incremental `akm index` must warn, not silently record '1'.
    const warning = reconcileBodyOpeningIndexState(db, true, false);
    expect(warning).toBeDefined();
    expect(warning).toContain("index.indexBodyOpening is enabled");
    expect(warning).toContain("akm index --full");
    expect(getMeta(db, "indexBodyOpening")).toBe("0");

    // Repeat-until-full semantics: the next incremental run warns again.
    expect(reconcileBodyOpeningIndexState(db, true, false)).toBeDefined();
    expect(getMeta(db, "indexBodyOpening")).toBe("0");
  });

  test("pre-feature index + flag disabled + incremental run: silent, seeds '0'", () => {
    expect(reconcileBodyOpeningIndexState(db, false, false)).toBeUndefined();
    expect(getMeta(db, "indexBodyOpening")).toBe("0");
  });

  test("recorded '0' + flag enabled + incremental run: warns and preserves '0'", () => {
    setMeta(db, "indexBodyOpening", "0");
    const warning = reconcileBodyOpeningIndexState(db, true, false);
    expect(warning).toContain("index.indexBodyOpening is enabled");
    expect(warning).toContain("built with it disabled");
    expect(getMeta(db, "indexBodyOpening")).toBe("0");
  });

  test("recorded '1' + flag disabled + incremental run: warns in the opposite direction, preserves '1'", () => {
    setMeta(db, "indexBodyOpening", "1");
    const warning = reconcileBodyOpeningIndexState(db, false, false);
    expect(warning).toContain("index.indexBodyOpening is disabled");
    expect(warning).toContain("built with it enabled");
    expect(getMeta(db, "indexBodyOpening")).toBe("1");
  });

  test("a full walk applies the new state and clears the divergence", () => {
    setMeta(db, "indexBodyOpening", "0");
    expect(reconcileBodyOpeningIndexState(db, true, true)).toBeUndefined();
    expect(getMeta(db, "indexBodyOpening")).toBe("1");
    // Subsequent incremental runs with the same flag stay silent.
    expect(reconcileBodyOpeningIndexState(db, true, false)).toBeUndefined();
    expect(getMeta(db, "indexBodyOpening")).toBe("1");
  });

  test("matching flag and recorded state stay silent on incremental runs", () => {
    setMeta(db, "indexBodyOpening", "1");
    expect(reconcileBodyOpeningIndexState(db, true, false)).toBeUndefined();
    setMeta(db, "indexBodyOpening", "0");
    expect(reconcileBodyOpeningIndexState(db, false, false)).toBeUndefined();
  });
});
