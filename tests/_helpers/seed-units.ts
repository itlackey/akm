/**
 * Test-only replacement for the old `rebuildFts(db)` helper (deleted with
 * `entries_fts`/`entry_fragments_fts`, index-redesign B5c): derive and
 * persist `unit_texts`/`units_fts`/`entry_units` for whatever is currently in
 * `entries`, the same way `reconcile.ts` does per-file.
 *
 * Production code never needs this as a bulk operation — reconcile derives
 * units incrementally, per file, as part of the same write that upserts the
 * `entries` row. Tests that insert `entries` rows directly (via `upsertEntry`
 * or raw SQL, bypassing the file walk) need an equivalent bulk seed so the
 * units search path has something to find. A generous fixed `maxChars`
 * avoids a real provider probe (`unitMaxChars(probeProviderLimits(...))`) —
 * test fixture bodies are always far smaller.
 */

import type { IndexDocument } from "../../src/indexer/passes/metadata";
import { toUnitSource } from "../../src/indexer/reconcile";
import { deriveUnits } from "../../src/indexer/units/unit";
import type { Database } from "../../src/storage/database";
import { insertNewUnitTexts } from "../../src/storage/repositories/files-repository";
import { replaceEntryUnits } from "../../src/storage/repositories/units-repository";

/** Far beyond any test fixture body — never trips deriveUnits's overflow split. */
const TEST_UNIT_MAX_CHARS = 200_000;

export function seedUnitsForAllEntries(db: Database, maxChars = TEST_UNIT_MAX_CHARS): void {
  const rows = db.prepare("SELECT id, document_json FROM entries").all() as Array<{
    id: number;
    document_json: string;
  }>;
  for (const row of rows) {
    let entry: IndexDocument;
    try {
      entry = JSON.parse(row.document_json) as IndexDocument;
    } catch {
      continue;
    }
    const units = deriveUnits(toUnitSource(row.id, entry), maxChars);
    insertNewUnitTexts(
      db,
      units.map((unit) => ({ hash: unit.hash, kind: unit.fragmentId === null ? "card" : "fragment", text: unit.text })),
    );
    replaceEntryUnits(
      db,
      row.id,
      units.map((unit) => ({ ordinal: unit.ordinal, fragmentId: unit.fragmentId, hash: unit.hash })),
    );
  }
}
