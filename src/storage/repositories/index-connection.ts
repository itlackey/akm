// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index.db` connection lifecycle for the storage layer.
 *
 * Opens/closes the index database, arming the sqlite-vec extension and (for the
 * managed open path) running `ensureSchema`. Extracted verbatim from
 * `src/indexer/db/db.ts` (WI-5a); it now lives BELOW the indexer, so the storage
 * loan helpers (`index-db.ts`, `registry-cache.ts`) import their opener from a
 * sibling here instead of reaching up into the indexer — inverting the old
 * storage→indexer arrow.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import { getDbPath } from "../../core/paths";
import type { Database } from "../database";
import { openDatabase } from "../database";
import { openManagedDatabase } from "../managed-db";
import { ensureSchema } from "./index-schema";
import { loadVecExtension, warnIfVecMissing } from "./index-vec-repository";

export function openIndexDatabase(dbPath?: string, options?: { embeddingDim?: number }): Database {
  return openManagedDatabase({
    path: dbPath ?? getDbPath(),
    init: (db) => {
      // Try to load sqlite-vec extension
      loadVecExtension(db);

      // Dim resolution: explicit option wins; otherwise consult the on-disk
      // config so unparameterised opens (registry providers, graph helpers,
      // ad-hoc CLI subcommands) honour the operator-declared dimension. Only if
      // both are absent do we fall through to the no-clobber path, which keeps
      // ensureSchema from touching `index_meta.embeddingDim` at all.
      const resolvedDim = options?.embeddingDim ?? resolveConfiguredEmbeddingDim();
      ensureSchema(db, resolvedDim);

      // Warn once at init if using JS fallback with many entries
      warnIfVecMissing(db, { once: true });
    },
  });
}

/**
 * Read the operator-configured embedding dimension from the on-disk config.
 * Returns `undefined` when no config file is present, when the config has
 * no `embedding.dimension` set, or when reading the config throws (e.g.
 * inside isolated test fixtures with no XDG home). Failure is silent on
 * purpose — every openDatabase() call would otherwise have to handle a
 * config-not-found error path, and the fallback (no-clobber semantics) is
 * already correct.
 */
function resolveConfiguredEmbeddingDim(): number | undefined {
  try {
    const esmRequire = createRequire(import.meta.url);
    const { loadConfig } = esmRequire("../../core/config/config") as typeof import("../../core/config/config");
    const dim = loadConfig().embedding?.dimension;
    if (typeof dim === "number" && Number.isInteger(dim) && dim > 0 && dim <= 4096) {
      return dim;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function openExistingDatabase(dbPath?: string): Database {
  // Existing-DB callers must not mutate schema or embedding metadata on open,
  // but some paths still need write access to usage_events and other tables —
  // so init only loads the vec extension, it does not run ensureSchema.
  return openManagedDatabase({ path: dbPath ?? getDbPath(), init: loadVecExtension });
}

/**
 * Open an existing index for queries without creating directories, a database
 * file, journals, or running write-capable pragmas/schema initialization.
 */
export function openReadonlyExistingDatabase(dbPath?: string): Database | undefined {
  const resolvedPath = dbPath ?? getDbPath();
  if (!fs.existsSync(resolvedPath)) return undefined;
  return openDatabase(resolvedPath, { readonly: true, create: false });
}

export function closeDatabase(db: Database): void {
  db.close();
}
