// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import { loadConfig } from "../../core/config/config";
import { applyEntryFilters } from "../../indexer/search/db-search";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import { closeDatabase, openReadonlyExistingDatabase } from "../../storage/repositories/index-connection";
import { getEntriesByIds, getEntryIdByFilePath } from "../../storage/repositories/index-entries-repository";
import { getMeta } from "../../storage/repositories/index-meta-repository";
import {
  getAllEntriesForEmbedding,
  getNeighborsByEntryId,
  hasStoredEmbedding,
} from "../../storage/repositories/index-vec-repository";

const RELATED_LIMIT = 20;

/**
 * The indexed assets whose stored embeddings are nearest to one asset's, with no query embedding and no network.
 * Search's own entry filter keeps the matches to enabled bundles, and `scope: "bundle"` to the asset's bundle;
 * protected and generated assets are never listed.
 */
export function relatedAssets(file: string, bundle: string, scope: "all" | "bundle") {
  const unavailable = (note: string) => ({ available: false, note, matches: [] });
  const db = openReadonlyExistingDatabase();
  if (!db) return unavailable("No index is available. Build the AKM index to compare stored embeddings.");
  try {
    const id = getEntryIdByFilePath(db, file);
    if (id === undefined || !hasStoredEmbedding(db, id))
      return unavailable(
        "No stored embedding for this asset. Run AKM indexing with embeddings enabled; browsing here never calls a provider.",
      );
    if (getAllEntriesForEmbedding(db, [id], getMeta(db, "embeddingFingerprint")).length)
      return unavailable("This asset's embedding belongs to an older model. Refresh the index before comparing it.");
    const sources = resolveSourceEntries(undefined, loadConfig()).filter((source) => !source.unresolved);
    const filterOptions = {
      db,
      sources,
      restrictToSources: true,
      includeProposed: false,
      beliefFilter: "all",
    } as const;
    const neighbours = getNeighborsByEntryId(db, id, RELATED_LIMIT, undefined, (ids) => {
      const rows = getEntriesByIds(db, ids).filter(
        (row) =>
          row.id !== id &&
          row.itemRef &&
          !["secret", "env", "session"].includes(row.entry.type) &&
          (scope === "all" || row.bundleId === bundle) &&
          fs.existsSync(row.filePath),
      );
      return new Set(applyEntryFilters(rows, filterOptions).map((row) => row.id));
    });
    const rows = new Map(
      getEntriesByIds(
        db,
        neighbours.map((match) => match.id),
      ).map((row) => [row.id, row]),
    );
    const matches = neighbours.flatMap((match) => {
      const row = rows.get(match.id);
      if (!row) return [];
      return [
        {
          ref: row.itemRef,
          title: row.entry.toc?.find((heading) => heading.level === 1)?.text || row.entry.name,
          type: row.entry.type,
          cosine: Math.max(-1, Math.min(1, 1 - match.distance ** 2 / 2)),
        },
      ];
    });
    return {
      available: true,
      matches,
      note: `Up to ${RELATED_LIMIT} nearest stored embeddings. Scores describe indexed content; refresh the index after external edits.`,
    };
  } finally {
    closeDatabase(db);
  }
}
