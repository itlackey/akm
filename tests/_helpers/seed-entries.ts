// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Seed `entries` rows into an in-memory (`:memory:`) index DB (#664 Seam 2).
 *
 * The improve planner reads only the `entries` table. This helper lets a unit
 * test populate that table directly — via the REAL `upsertEntry`, read back via
 * the REAL `getAllEntries` SQL — with no on-disk `akmIndex({full:true})` and no
 * socket/disk fd. Because both seed and read go through production code there is
 * zero query-logic drift to keep in sync.
 *
 * Usage:
 *   const seeded = seedEntries([{ name: "auth-tips", type: "memory" }]);
 *   await akmImprove({ ..., getAllEntries: seeded.getAllEntries });
 *   seeded.close();
 */

import path from "node:path";
import { TYPE_DIRS } from "../../src/core/asset/asset-spec";
import { EMBEDDING_DIM, openDatabase, upsertEntry } from "../../src/indexer/db/db";
import { type GetAllEntries, inMemoryGetAllEntries } from "../../src/indexer/db/entry-reader";
import type { StashEntry } from "../../src/indexer/passes/metadata";
import { buildSearchText } from "../../src/indexer/search/search-fields";
import type { Database } from "../../src/storage/database";

/** A row to seed. `name` + `type` are required; everything else defaults. */
export interface SeedEntrySpec extends Partial<StashEntry> {
  name: string;
  type: string;
  /** Owning stash dir (defaults to a synthetic path). */
  stashDir?: string;
  /** On-disk path the entry maps to (defaults to `<stashDir>/<type>s/<name>.md`). */
  filePath?: string;
}

export interface SeededEntries {
  /** The open in-memory DB (real schema). Close via {@link close}. */
  db: Database;
  /** Inject this into `akmImprove`/`collectEligibleRefs` as the entry source. */
  getAllEntries: GetAllEntries;
  /** Close the in-memory DB. */
  close: () => void;
}

const DEFAULT_STASH = "/seed/stash";

export function seedEntries(specs: SeedEntrySpec[]): SeededEntries {
  // #664 §8.1 caveat: pass embeddingDim explicitly so the `:memory:` schema is
  // host-config-independent — this short-circuits the config read that would
  // otherwise reach loadConfig()/maybeAutoMigrateConfigFile and rewrite the
  // operator's real config.json + print a banner.
  const db = openDatabase(":memory:", { embeddingDim: EMBEDDING_DIM });
  for (const spec of specs) {
    const { stashDir: specStash, filePath: specFile, ...rest } = spec;
    const stashDir = specStash ?? DEFAULT_STASH;
    const entry = rest as StashEntry;
    // Use the canonical type→dir map (memory→memories, etc.) so the seeded
    // filePath matches AKM's real on-disk layout and the planner's path/existence
    // guards behave as they would against a real stash. Falls back to naive
    // pluralization only for an unregistered/unknown type.
    const typeDir = TYPE_DIRS[entry.type] ?? `${entry.type}s`;
    const filePath = specFile ?? path.join(stashDir, typeDir, `${entry.name}.md`);
    const dirPath = path.dirname(filePath);
    const entryKey = `${stashDir}:${entry.type}:${entry.name}`;
    upsertEntry(db, entryKey, dirPath, filePath, stashDir, entry, buildSearchText(entry));
  }
  return { db, getAllEntries: inMemoryGetAllEntries(db), close: () => db.close() };
}
