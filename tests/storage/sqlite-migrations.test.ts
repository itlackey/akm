// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `assertMigrationRegistry` duplicate-ID detection.
 *
 * A `MIGRATIONS` array is compiled in, so a duplicate `id` is a dev-time bug,
 * not something that can appear or disappear between calls within a process.
 * This used to be re-checked inside `inspectMigrationLedger` on every single
 * DB open (state.db's `STATE_MIGRATIONS` array runs into the hundreds of
 * entries) even though each consumer already calls `assertMigrationRegistry`
 * once on its own array at module load. This test is the replacement for that
 * per-open re-check: it pins the duplicate-detection behavior directly.
 */

import { describe, expect, test } from "bun:test";
import { assertMigrationRegistry } from "../../src/storage/sqlite-migrations";

describe("assertMigrationRegistry", () => {
  test("accepts a registry with unique IDs", () => {
    expect(() =>
      assertMigrationRegistry([
        { id: "001-init", up: "CREATE TABLE a (id TEXT)" },
        { id: "002-add-col", up: "ALTER TABLE a ADD COLUMN b TEXT" },
      ]),
    ).not.toThrow();
  });

  test("accepts an empty registry", () => {
    expect(() => assertMigrationRegistry([])).not.toThrow();
  });

  test("throws naming the duplicate ID", () => {
    expect(() =>
      assertMigrationRegistry([
        { id: "001-init", up: "CREATE TABLE a (id TEXT)" },
        { id: "002-add-col", up: "ALTER TABLE a ADD COLUMN b TEXT" },
        { id: "001-init", up: "CREATE TABLE a (id TEXT)" },
      ]),
    ).toThrow("Migration registry contains duplicate ID 001-init.");
  });
});
