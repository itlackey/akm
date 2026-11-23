// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * TESTS for the per-row skip-and-warn dedupe in `listStateProposals` (#898).
 *
 * `akm health --report` alone reads the `proposals` table through this
 * function upwards of half a dozen times in one process (the implicit
 * `--window-compare` pass, the main summary pass, and
 * `computeAcceptRateBySource` each read it independently). A row that fails
 * to parse — such as a legacy `#fragment` ref state migration 026 has not
 * yet normalized — was warned about on EVERY one of those reads, not once.
 * These rows are seeded directly (post-migration), simulating a row a state
 * migration cannot fully resolve, so the dedupe is exercised independently
 * of migration 026.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getStateDbPath, openStateDatabase, stateBundleId } from "../../../src/core/state-db";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../../src/core/warn";
import { listStateProposals } from "../../../src/storage/repositories/proposals-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";
import { withSeam } from "../../_helpers/seams";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
  _resetWarnOnceForTests();
});

/** Seeds two rows carrying the retired `#fragment` ref shape (#898), plus one healthy row. */
function seedFragmentRows(): void {
  const file = getStateDbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = openStateDatabase(file);
  try {
    const insert = db.prepare(
      `INSERT INTO proposals
         (id, bundle_id, ref, status, source, created_at, updated_at, content, frontmatter_json, metadata_json)
       VALUES (?, ?, ?, 'accepted', 'consolidate', ?, ?, 'legacy content', NULL, '{}')`,
    );
    insert.run(
      "fragment-row-a",
      stateBundleId(storage.stashDir),
      "akm//knowledge/brand-aesthetic-guidelines#standalone-frontmatter-layouts",
      "2026-05-27T10:00:00.000Z",
      "2026-05-27T10:00:00.500Z",
    );
    insert.run(
      "fragment-row-b",
      stateBundleId(storage.stashDir),
      "akm//knowledge/other-guide#some-section",
      "2026-06-23T10:00:00.000Z",
      "2026-06-23T10:00:00.500Z",
    );
    insert.run(
      "healthy-row",
      stateBundleId(storage.stashDir),
      "akm//knowledge/already-fine",
      "2026-07-01T10:00:00.000Z",
      "2026-07-01T10:00:00.500Z",
    );
  } finally {
    db.close();
  }
}

describe("listStateProposals — unparseable-row warning is deduped per row per process (#898)", () => {
  test("reading the same broken rows 3 times in one process warns exactly once per row, not once per read", () => {
    seedFragmentRows();
    const file = getStateDbPath();

    const warnings: string[] = [];
    withSeam(
      _setWarnSinkForTests,
      (level, args) => {
        if (level === "warn") warnings.push(String(args[0]));
      },
      () => {
        for (let i = 0; i < 3; i++) {
          const db = openStateDatabase(file);
          try {
            const proposals = listStateProposals(db, { bundleId: stateBundleId(path.resolve(storage.stashDir)) });
            // The well-formed row is always returned; the two broken rows never are.
            expect(proposals.map((p) => p.id)).toEqual(["healthy-row"]);
          } finally {
            db.close();
          }
        }
      },
    );

    // Two distinct broken rows, read 3 times each => 6 parse failures, but
    // only ONE warning line per distinct row id for the life of the process.
    expect(warnings).toHaveLength(2);
    expect(warnings.some((m) => m.includes("fragment-row-a"))).toBe(true);
    expect(warnings.some((m) => m.includes("fragment-row-b"))).toBe(true);
  });
});
