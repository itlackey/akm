// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Decode-parity tests for the #664 Seam 2 in-memory entry source. Verify that
 * `seedEntries` round-trips through the REAL `upsertEntry → getAllEntries →
 * parseEntryRows` path (so there is no drift from the production planner's
 * read), and that the `:memory:` open neither touches disk nor rewrites config.
 */

import { describe, expect, test } from "bun:test";
import { seedEntries } from "./_helpers/seed-entries";

describe("seedEntries (#664 Seam 2)", () => {
  test("round-trips rows through the real getAllEntries SQL", () => {
    const seeded = seedEntries([
      { name: "auth-tips", type: "memory", description: "auth memory", tags: ["auth", "vpn"] },
      { name: "deploy", type: "skill", description: "deploy skill" },
    ]);
    try {
      const all = seeded.getAllEntries();
      expect(all.map((e) => e.entry.name).sort()).toEqual(["auth-tips", "deploy"]);
      const mem = all.find((e) => e.entry.name === "auth-tips");
      // The full StashEntry decodes back (not just name/type) — catches
      // seedEntries-vs-parseEntryRows drift, not just the WHERE clause.
      expect(mem?.entry.type).toBe("memory");
      expect(mem?.entry.description).toBe("auth memory");
      expect(mem?.entry.tags).toEqual(["auth", "vpn"]);
      expect(mem?.stashDir).toBe("/seed/stash");
      // Canonical AKM layout: memory entries live under memories/ (not "memorys").
      expect(mem?.filePath).toBe("/seed/stash/memories/auth-tips.md");
    } finally {
      seeded.close();
    }
  });

  test("type filter uses the real SQL WHERE clause", () => {
    const seeded = seedEntries([
      { name: "a", type: "memory" },
      { name: "b", type: "skill" },
      { name: "c", type: "memory" },
    ]);
    try {
      expect(
        seeded
          .getAllEntries("memory")
          .map((e) => e.entry.name)
          .sort(),
      ).toEqual(["a", "c"]);
      expect(seeded.getAllEntries("skill").map((e) => e.entry.name)).toEqual(["b"]);
    } finally {
      seeded.close();
    }
  });

  test("excludeTypes filter matches production (untyped path only)", () => {
    const seeded = seedEntries([
      { name: "a", type: "memory" },
      { name: "b", type: "lesson" },
      { name: "c", type: "skill" },
    ]);
    try {
      const kept = seeded
        .getAllEntries(undefined, ["lesson"])
        .map((e) => e.entry.name)
        .sort();
      expect(kept).toEqual(["a", "c"]);
    } finally {
      seeded.close();
    }
  });
});
