// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-0b.7c -- two reference re-key implementations used ONLY by the smoke
 * test (`rekey-merge-property.test.ts`) to prove `checkRekeyInvariants`
 * actually discriminates correct from incorrect re-key behavior. Chunk 8's
 * real full-table re-key function does not exist yet (anchors.md E.5) --
 * these are NOT it, and nothing in `rekey-generator.ts` or
 * `rekey-invariants.ts` imports this file or hard-codes anything about it.
 *
 * Both generalize `rekeyStateDbForMove`'s exact per-pair algebra
 * (`src/commands/mv-cli.ts:898-967`, pair-construction :910-922, per-table
 * DELETE-then-UPDATE :930-934) from "one asset, one move" to "every logical
 * asset in the model, one full-table pass": for each asset, if a row exists
 * under the bare spelling, it is re-keyed onto the canonical (origin-
 * qualified) key.
 *
 *   - `naiveClobberRekey` -- copies mv-cli's DELETE-then-rename VERBATIM
 *     (unconditional `DELETE ... WHERE key = canonical` then `UPDATE ... SET
 *     key = canonical WHERE key = bare`): whichever row already sat at the
 *     canonical key is discarded outright, and the moved (bare) row's fields
 *     always win a collision -- `updated_at` is never compared. This is
 *     EXACTLY the "target-clobbers" behavior anchors.md E.2 says the
 *     single-item function was never asked to prove wrong.
 *   - `correctReferenceRekey` -- adds the ONE thing naive lacks: on a
 *     collision, compare `updated_at` between the moved row and the row
 *     already at the canonical key, keep the more-recent row's FULL field
 *     set, and write it under the canonical key (invariant 3,
 *     "most-recently-updated wins").
 *
 * Event-shaped tables (`events`, `proposals`) have no PK collision to
 * resolve -- multiple rows may already share a ref -- so both
 * implementations re-key them identically: `UPDATE ... SET ref = canonical
 * WHERE ref = bare`. This is deliberate: it isolates the discrimination
 * proof to invariant 3 (scalar merge), never invariant 2 (event rows
 * carried as-is) -- both references pass invariant 2, only naive fails
 * invariant 3.
 */

import { openStateDatabase } from "../../../src/core/state-db";
import type { Database, SqlValue } from "../../../src/storage/database";
import { bareRef, canonicalRef, type RawRow, type RekeyFn, type RekeyModel } from "./rekey-model";

type ScalarTable = "asset_salience" | "asset_outcome";
type EventTable = "events" | "proposals";

function rekeyScalarTable(db: Database, table: ScalarTable, model: RekeyModel, mode: "naive" | "correct"): void {
  const keyColumn = "asset_ref";
  for (const asset of model.assets) {
    const bare = bareRef(asset.key);
    const canonical = canonicalRef(asset.key);

    const moved = db.prepare(`SELECT * FROM ${table} WHERE ${keyColumn} = ?`).get(bare) as RawRow | undefined;
    if (!moved) continue; // nothing seeded under the bare spelling for this asset+table -- no-op, matches mv-cli.ts:932.

    if (mode === "naive") {
      db.prepare(`DELETE FROM ${table} WHERE ${keyColumn} = ?`).run(canonical);
      db.prepare(`UPDATE ${table} SET ${keyColumn} = ? WHERE ${keyColumn} = ?`).run(canonical, bare);
      continue;
    }

    const existing = db.prepare(`SELECT * FROM ${table} WHERE ${keyColumn} = ?`).get(canonical) as RawRow | undefined;
    if (!existing) {
      // No collision: simple rename, identical to naive in this branch.
      db.prepare(`UPDATE ${table} SET ${keyColumn} = ? WHERE ${keyColumn} = ?`).run(canonical, bare);
      continue;
    }

    // Collision: most-recently-updated-wins (invariant 3) -- the rule naive does not implement.
    const winner = (moved.updated_at as number) >= (existing.updated_at as number) ? moved : existing;
    db.prepare(`DELETE FROM ${table} WHERE ${keyColumn} = ?`).run(canonical);
    db.prepare(`DELETE FROM ${table} WHERE ${keyColumn} = ?`).run(bare);
    reinsertWinner(db, table, keyColumn, winner, canonical);
  }
}

/** Re-insert `winner`'s full field set under `canonicalKey`, generically (column set read from the row itself, not hard-coded, so it self-adapts to either scalar table's schema). */
function reinsertWinner(
  db: Database,
  table: ScalarTable,
  keyColumn: string,
  winner: RawRow,
  canonicalKey: string,
): void {
  const row: RawRow = { ...winner, [keyColumn]: canonicalKey };
  const columns = Object.keys(row);
  const placeholders = columns.map(() => "?").join(", ");
  db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`).run(
    ...(columns.map((c) => row[c]) as SqlValue[]),
  );
}

function rekeyEventTable(db: Database, table: EventTable, model: RekeyModel): void {
  for (const asset of model.assets) {
    const bare = bareRef(asset.key);
    const canonical = canonicalRef(asset.key);
    // No PK collision possible (many rows may share one ref) -- a plain
    // re-key, identical under both reference implementations.
    db.prepare(`UPDATE ${table} SET ref = ? WHERE ref = ?`).run(canonical, bare);
  }
}

function applyFullTablePass(dbPath: string, model: RekeyModel, scalarMode: "naive" | "correct"): void {
  const db = openStateDatabase(dbPath);
  try {
    db.transaction(() => {
      rekeyScalarTable(db, "asset_salience", model, scalarMode);
      rekeyScalarTable(db, "asset_outcome", model, scalarMode);
      rekeyEventTable(db, "events", model);
      rekeyEventTable(db, "proposals", model);
    })();
  } finally {
    db.close();
  }
}

/** The CORRECT reference: most-recently-updated wins on a scalar-table collision. Expected to satisfy every WI-0b.7b invariant. */
export const correctReferenceRekey: RekeyFn = (dbPath, model) => applyFullTablePass(dbPath, model, "correct");

/** The NAIVE reference: `rekeyStateDbForMove`'s delete-then-rename, generalized to a full-table pass, WITHOUT `updated_at` comparison. Expected to FAIL invariant 3 on a collision seed -- this is what proves the harness tests the stronger rule. */
export const naiveClobberRekey: RekeyFn = (dbPath, model) => applyFullTablePass(dbPath, model, "naive");
