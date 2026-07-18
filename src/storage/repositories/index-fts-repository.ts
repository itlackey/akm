// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index.db` FTS5 search + rebuild repository.
 *
 * Owns the `entries_fts` full-text query path and the incremental/full FTS
 * rebuild. Extracted verbatim from `src/indexer/db/db.ts` (WI-5a).
 */

import { warn } from "../../core/warn";
import type { StashEntry } from "../../indexer/passes/metadata";
import { buildPrefixQuery, sanitizeFtsQuery } from "../../indexer/search/fts-query";
import { buildSearchFields } from "../../indexer/search/search-fields";
import type { Database, SqlValue } from "../database";
import type { DbSearchResult } from "./index-entry-types";
import { SQLITE_CHUNK_SIZE } from "./index-sql";

export function searchFts(
  db: Database,
  query: string,
  limit: number,
  entryType?: string,
  excludeTypes?: string[],
): DbSearchResult[] {
  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return [];

  // Try the exact AND query first
  const exactResults = runFtsQuery(db, ftsQuery, limit, entryType, excludeTypes);
  if (exactResults.length > 0) return exactResults;

  // Exact match returned zero results — try prefix fallback.
  // Append FTS5 `*` suffix to each token that is >= 3 characters long.
  // Short tokens (1-2 chars) are excluded from prefix expansion because
  // they produce too many false positives.
  const prefixQuery = buildPrefixQuery(ftsQuery);
  if (!prefixQuery) return [];

  return runFtsQuery(db, prefixQuery, limit, entryType, excludeTypes);
}

function runFtsQuery(
  db: Database,
  ftsQuery: string,
  limit: number,
  entryType?: string,
  excludeTypes?: string[],
): DbSearchResult[] {
  // #627 — exclude-type clause. Only applies on the untyped ('any') path; an
  // explicit include filter (entryType) already narrows to a single type, so
  // exclusion is redundant there. An empty list skips the clause entirely
  // (never emit `NOT IN ()`, which is a SQL error / always-false).
  const excludes = excludeTypes && excludeTypes.length > 0 ? excludeTypes : [];

  // The typed and untyped paths differ ONLY by one WHERE clause (an entry_type
  // equality vs. an optional NOT IN exclusion) and their param order — the
  // SELECT/JOIN/ORDER/LIMIT is shared, so build it once. Join on integer
  // entry_id directly (no CAST; we store integer). bm25() per-column weights:
  // entry_id(0), name(10), description(5), tags(3), hints(2), content(1).
  let filterClause: string;
  let params: unknown[];
  if (entryType && entryType !== "any") {
    filterClause = "AND e.entry_type = ?";
    params = [ftsQuery, entryType, limit];
  } else {
    filterClause = excludes.length > 0 ? `AND e.entry_type NOT IN (${excludes.map(() => "?").join(", ")})` : "";
    // Param order: MATCH, then the NOT IN values, then LIMIT.
    params = [ftsQuery, ...excludes, limit];
  }

  const sql = `
    SELECT e.id, e.file_path AS filePath, e.entry_json, e.search_text AS searchText,
           bm25(entries_fts, 0, 10.0, 5.0, 3.0, 2.0, 1.0) AS bm25Score
    FROM entries_fts f
    JOIN entries e ON e.id = f.entry_id
    WHERE entries_fts MATCH ?
      ${filterClause}
    ORDER BY bm25Score, e.id ASC
    LIMIT ?
  `;

  try {
    const rows = db.prepare(sql).all(...(params as SqlValue[])) as Array<{
      id: number;
      filePath: string;
      entry_json: string;
      searchText: string;
      bm25Score: number;
    }>;

    // Guard against corrupt JSON — skip the row rather than crashing
    const results: DbSearchResult[] = [];
    for (const row of rows) {
      let entry: StashEntry;
      try {
        entry = JSON.parse(row.entry_json) as StashEntry;
      } catch {
        warn(`[db] searchFts: skipping entry id=${row.id} — corrupt entry_json`);
        continue;
      }
      results.push({
        id: row.id,
        filePath: row.filePath,
        entry,
        searchText: row.searchText,
        bm25Score: row.bm25Score,
      });
    }
    return results;
  } catch (err) {
    warn("[db] runFtsQuery failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

/**
 * Rebuild the FTS5 search index.
 *
 * `incremental` (default `false`): when true, only rebuild rows that
 * `upsertEntry` marked dirty since the last `rebuildFts` call. The full path
 * (default) wipes `entries_fts` and re-inserts every row from `entries` —
 * appropriate for `akm index --full` and version-upgrade rebuilds.
 *
 * Both paths are wrapped in a single transaction so the FTS table is never
 * left in a half-rebuilt state.
 *
 * Skipped corrupt-JSON rows are aggregated into one warning instead of
 * spamming stderr per-entry.
 */
export function rebuildFts(db: Database, options?: { incremental?: boolean }): void {
  const incremental = options?.incremental === true;

  db.transaction(() => {
    let rows: Array<{ id: number; entry_json: string }>;
    if (incremental) {
      // Read the dirty queue and join against entries to get the JSON.
      // Then drop the matching rows from entries_fts so the INSERT below
      // doesn't double-up. The dirty list is drained at the end.
      rows = db
        .prepare(
          `SELECT e.id AS id, e.entry_json AS entry_json
             FROM entries_fts_dirty d
             JOIN entries e ON e.id = d.entry_id`,
        )
        .all() as typeof rows;
      if (rows.length === 0) return;
      const ids = rows.map((r) => r.id);
      // Delete only the dirty FTS rows — chunk to stay under
      // SQLITE_MAX_VARIABLE_NUMBER on large dirty queues.
      for (let i = 0; i < ids.length; i += SQLITE_CHUNK_SIZE) {
        const chunk = ids.slice(i, i + SQLITE_CHUNK_SIZE);
        const placeholders = chunk.map(() => "?").join(",");
        db.prepare(`DELETE FROM entries_fts WHERE entry_id IN (${placeholders})`).run(...chunk);
      }
    } else {
      // Full path: wipe and re-read every row.
      db.exec("DELETE FROM entries_fts");
      rows = db.prepare("SELECT id, entry_json FROM entries").all() as typeof rows;
    }

    const insertStmt = db.prepare(
      "INSERT INTO entries_fts (entry_id, name, description, tags, hints, content) VALUES (?, ?, ?, ?, ?, ?)",
    );

    let skipped = 0;
    for (const row of rows) {
      let entry: StashEntry;
      let fields: ReturnType<typeof buildSearchFields>;
      try {
        entry = JSON.parse(row.entry_json) as StashEntry;
        fields = buildSearchFields(entry);
      } catch {
        skipped++;
        continue;
      }
      insertStmt.run(row.id, fields.name, fields.description, fields.tags, fields.hints, fields.content);
    }

    if (skipped > 0) {
      warn(`[db] rebuildFts: skipped ${skipped} entr${skipped === 1 ? "y" : "ies"} with invalid entry_json`);
    }

    // Always drain the dirty queue — both paths converge here. The
    // incremental path drains it because we just consumed every dirty row;
    // the full path drains it because a full rebuild covers everything the
    // dirty list tracks. The table is guaranteed to exist (created by
    // ensureSchema()).
    //
    // BUG-L1: previously the if/else arms ran identical statements — the
    // duplication has been collapsed.
    db.exec("DELETE FROM entries_fts_dirty");
  })();
}
