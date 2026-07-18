// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index.db` entries repository — CRUD, lookup, re-key, delete-cascade, and the
 * usage-event relink + workflow-document + tag-set reads that key on `entries`.
 *
 * Owns ALL raw SQL against the `entries` table (WS5). Extracted verbatim from
 * `src/indexer/db/db.ts` (WI-5a); the shared row/option shapes now come from the
 * leaf types + mapper modules rather than from the old `db.ts` hub.
 */

import path from "node:path";
import { parseAssetRef } from "../../core/asset/asset-ref";
import { bestEffort } from "../../core/best-effort";
import { warn } from "../../core/warn";
import type { StashEntry } from "../../indexer/passes/metadata";
import { buildSearchText } from "../../indexer/search/search-fields";
import type { Database } from "../database";
import { ENTRY_COLUMNS, type EntryRow, rowToIndexedEntry } from "./index-entry-mapper";
import type {
  DbIndexedEntry,
  EntryProvenance,
  EntryRefRow,
  RekeyEntryOptions,
  RelinkUsageEventsOptions,
} from "./index-entry-types";
import { SQLITE_CHUNK_SIZE } from "./index-sql";
import { isVecAvailable } from "./index-vec-repository";

// ── Entry operations ────────────────────────────────────────────────────────

/**
 * Insert or update an entry in the `entries` table. Returns the row id.
 *
 * **Important:** This does not update the FTS index. Callers must call
 * `rebuildFts()` after all upserts are complete for full-text search to
 * reflect the changes.
 */
export function upsertEntry(
  db: Database,
  entryKey: string,
  dirPath: string,
  filePath: string,
  stashDir: string,
  entry: StashEntry,
  searchText: string,
  provenance?: EntryProvenance,
): number {
  // Hot path during indexing — cache the two prepared statements per
  // database connection so we don't pay the SQL parse/compile cost on
  // every call. The dirty-mark INSERT and the upsert-with-RETURNING
  // share the same WeakMap so they live and die with the connection.
  const stmts = getUpsertStmts(db);
  // Phase 5A / Advantage D5: surface derived memory parent ref into the
  // dedicated `derived_from` column so retrieval-time lookup (parent→child)
  // does not have to scan + JSON-decode every memory row.
  const derivedFrom =
    typeof entry.derivedFrom === "string" && entry.derivedFrom.trim() ? entry.derivedFrom.trim() : null;
  // Chunk-5 Step 2 (spec §14.4): populate the additive identity/provenance
  // columns alongside the legacy ones. `type` mirrors `entry_type` (the open
  // token) unconditionally; `item_ref`/bundle/component/concept/adapter come
  // from the write-boundary derivation when available (NULL otherwise, healed
  // by the next full index). `content_hash`/`document_json` stay NULL until the
  // Step-3 writer swap that owns diff-persistence populates them.
  const result = stmts.upsert.get(
    entryKey,
    dirPath,
    filePath,
    stashDir,
    JSON.stringify(entry),
    searchText,
    entry.type,
    derivedFrom,
    provenance?.itemRef ?? null,
    provenance?.bundleId ?? null,
    provenance?.componentId ?? null,
    provenance?.conceptId ?? null,
    provenance?.adapterId ?? null,
    entry.type,
  ) as { id: number } | undefined;
  if (!result) throw new Error("upsertEntry: entry_key not found after upsert");

  // Mark this entry as FTS-dirty so `rebuildFts({ incremental: true })`
  // only revisits entries that actually changed. INSERT OR IGNORE is
  // idempotent across multiple upserts of the same row.
  stmts.markDirty.run(result.id);
  return result.id;
}

interface UpsertStmts {
  upsert: ReturnType<Database["prepare"]>;
  markDirty: ReturnType<Database["prepare"]>;
}

const upsertStmtsByDb = new WeakMap<Database, UpsertStmts>();

function getUpsertStmts(db: Database): UpsertStmts {
  const existing = upsertStmtsByDb.get(db);
  if (existing) return existing;
  const stmts: UpsertStmts = {
    // RETURNING id handles ON CONFLICT DO UPDATE correctly — no second
    // SELECT round-trip needed (last_insert_rowid() is unreliable for
    // ON CONFLICT). Use `.get()` so a single row comes back.
    upsert: db.prepare(`
      INSERT INTO entries (
        entry_key, dir_path, file_path, stash_dir, entry_json, search_text, entry_type, derived_from,
        item_ref, bundle_id, component_id, concept_id, adapter_id, type
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entry_key) DO UPDATE SET
        dir_path = excluded.dir_path,
        file_path = excluded.file_path,
        stash_dir = excluded.stash_dir,
        entry_json = excluded.entry_json,
        search_text = excluded.search_text,
        entry_type = excluded.entry_type,
        derived_from = excluded.derived_from,
        item_ref = excluded.item_ref,
        bundle_id = excluded.bundle_id,
        component_id = excluded.component_id,
        concept_id = excluded.concept_id,
        adapter_id = excluded.adapter_id,
        type = excluded.type
      RETURNING id
    `),
    markDirty: db.prepare("INSERT OR IGNORE INTO entries_fts_dirty (entry_id) VALUES (?)"),
  };
  upsertStmtsByDb.set(db, stmts);
  return stmts;
}

/**
 * Phase 5A / Advantage D5: look up the derived-memory child row whose
 * `derived_from` column matches `parentRef` (e.g. `"memory:claude-prefs"`).
 *
 * Returns the most-recently-updated derived child when multiple exist (one
 * parent should yield exactly one `.derived` child in practice, but the
 * ordering keeps results deterministic). Returns `null` when no derived
 * child has been indexed for this parent.
 */
export function getDerivedForParent(db: Database, parentRef: string): DbIndexedEntry | null {
  if (!parentRef) return null;
  try {
    const row = db
      .prepare(
        `SELECT ${ENTRY_COLUMNS}
         FROM entries
         WHERE derived_from = ?
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(parentRef) as EntryRow | undefined;
    if (!row) return null;
    return rowToIndexedEntry(row, "getDerivedForParent");
  } catch {
    /* `derived_from` column may not exist on legacy DBs that haven't been
       rebuilt; treat as "no derived child". */
    return null;
  }
}

/**
 * 03-R3: for the given derived-twin row ids, fetch each twin's BASE memory
 * `beliefState`, keyed by twin id.
 *
 * Used by the derived-twin belief inheritance in search ranking: a `.derived`
 * twin has no belief state of its own, so it inherits its base memory's
 * demoting state (contradicted/superseded/…) at search time. A twin's
 * `entry_key` is exactly its base's `entry_key` plus the `.derived` suffix
 * (same stash + type prefix, `<name>` vs `<name>.derived`), so the base is
 * found by stripping that suffix — no ref/prefix reconstruction. Returns a map
 * of twin id → base beliefState for bases that carry a non-empty state.
 * Best-effort: any query error (e.g. legacy DB) yields no inheritance rather
 * than failing the search.
 */
export function getBaseBeliefStatesForDerivedTwins(db: Database, twinIds: number[]): Map<number, string> {
  const out = new Map<number, string>();
  if (twinIds.length === 0) return out;
  // Chunk at SQLITE_CHUNK_SIZE like the sibling bulk-by-id helpers, so a large
  // `--limit` candidate set never trips SQLITE_MAX_VARIABLE_NUMBER (which would
  // otherwise fall into the best-effort catch and silently disable the feature).
  for (let i = 0; i < twinIds.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = twinIds.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    bestEffort(() => {
      const rows = db
        .prepare(
          `SELECT twin.id AS twin_id, json_extract(base.entry_json, '$.beliefState') AS belief
           FROM entries twin
           JOIN entries base
             ON base.entry_type = 'memory'
            AND base.entry_key = substr(twin.entry_key, 1, length(twin.entry_key) - length('.derived'))
           WHERE twin.id IN (${placeholders})
             AND twin.entry_key LIKE '%.derived'
             AND json_extract(base.entry_json, '$.beliefState') IS NOT NULL`,
        )
        .all(...chunk) as { twin_id: number; belief: string | null }[];
      for (const r of rows) {
        if (typeof r.belief === "string" && r.belief.trim().length > 0) out.set(r.twin_id, r.belief.trim());
      }
    }, "legacy DB / entry_json without beliefState — treat as no twin inheritance");
  }
  return out;
}

/**
 * SPEC-7 (`akm mv`): re-key an entries row IN PLACE after an on-disk rename.
 *
 * The row id is preserved on purpose — `utility_scores`,
 * `utility_scores_scoped`, and `embeddings` are keyed by `entry_id`, so an
 * UPDATE (rather than a delete + insert under the new `entry_key`) is what
 * keeps the asset's accumulated usage-ranking history attached across a
 * rename. (`asset_salience` / `asset_outcome` live in state.db keyed by
 * `asset_ref` TEXT and are re-keyed separately by `akm mv` — see
 * mv-cli.ts `rekeyStateDbForMove`.) `entry_json.name` (and `filename`, when
 * present) is patched and `search_text` rebuilt so search reflects the new
 * name; the row is marked FTS-dirty for the caller's
 * `rebuildFts({incremental: true})`.
 *
 * `usage_events.entry_ref` rows for the old ref are rewritten to the new ref
 * in the same transaction — both the bare `type:name` spelling and the
 * origin-qualified `origin//type:name` spelling (search/show writers persist
 * either, see {@link getRetrievalCounts}). Without this, events keep the old
 * ref, `relinkUsageEvents` finds no matching entry after the next full
 * rebuild, and the utility history the re-key exists to preserve silently
 * resets. DETACHED orphan events already sitting at the new ref (entry_id
 * NULL — a deleted stranger's history) are deleted first, so the moved asset
 * never adopts them (live asset's history wins, matching the stale-row
 * eviction below).
 *
 * A stale row already occupying `newEntryKey` (the caller has verified no
 * FILE exists at the target, so such a row can only be a leftover for a
 * deleted file) is evicted first — through {@link deleteRelatedRows}, so its
 * child rows (embeddings, entries_vec, utility scores, usage events) go with
 * it. A bare `DELETE FROM entries` would trip the non-CASCADE `embeddings`
 * FK under `PRAGMA foreign_keys = ON` and roll back the whole re-key.
 * The moved row keeps its id.
 *
 * Returns the surviving row id, or `null` when no row matches `oldEntryKey`
 * (nothing indexed under the old name — the caller falls open and the next
 * full `akm index` picks the file up as a fresh entry).
 */
export function rekeyEntryInPlace(db: Database, opts: RekeyEntryOptions): number | null {
  const row = db
    .prepare("SELECT id, stash_dir, entry_json, search_text FROM entries WHERE entry_key = ?")
    .get(opts.oldEntryKey) as
    | { id: number; stash_dir: string; entry_json: string; search_text: string }
    | undefined
    | null;
  if (!row) return null;
  if (opts.sourceRoot && path.resolve(row.stash_dir) !== path.resolve(opts.sourceRoot)) {
    throw new Error(`Refusing to re-key entry ${opts.oldEntryKey}: source root does not match.`);
  }

  // Patch the JSON payload. On corrupt entry_json still re-key key + paths so
  // the utility history survives; the next full index heals the JSON.
  let entryJson = row.entry_json;
  let searchText = row.search_text;
  try {
    const entry = JSON.parse(row.entry_json) as StashEntry;
    entry.name = opts.newName;
    if (typeof entry.filename === "string") entry.filename = path.basename(opts.newFilePath);
    if (opts.newDerivedFrom !== undefined) entry.derivedFrom = opts.newDerivedFrom;
    entryJson = JSON.stringify(entry);
    searchText = buildSearchText(entry);
  } catch {
    /* corrupt entry_json — key/path-only re-key */
  }

  db.transaction(() => {
    const stale = db.prepare("SELECT id FROM entries WHERE entry_key = ?").get(opts.newEntryKey) as
      | { id: number }
      | undefined
      | null;
    if (stale && stale.id !== row.id) {
      // Full child-row cleanup (embeddings, entries_vec, utility scores,
      // usage events, FTS + dirty marks) BEFORE the entries delete: the
      // `embeddings` FK is non-CASCADE and `foreign_keys = ON`, so a bare
      // entries delete would throw and roll back the entire re-key; and
      // without it the FK-less child rows would orphan permanently.
      deleteRelatedRows(db, [{ id: stale.id }]);
      db.prepare("DELETE FROM entries WHERE id = ?").run(stale.id);
    }
    db.prepare(
      "UPDATE entries SET entry_key = ?, dir_path = ?, file_path = ?, entry_json = ?, search_text = ? WHERE id = ?",
    ).run(opts.newEntryKey, path.dirname(opts.newFilePath), opts.newFilePath, entryJson, searchText, row.id);
    if (opts.newDerivedFrom !== undefined) {
      db.prepare("UPDATE entries SET derived_from = ? WHERE id = ?").run(opts.newDerivedFrom, row.id);
    }
    // Re-point usage history at the new ref (see the docstring): the bare
    // spelling exactly, and the origin-qualified spelling by rewriting only
    // the part after the last `//` (stored origins never contain `//`, so a
    // qualified ref has exactly one — same normalization as
    // getRetrievalCounts). Legacy DBs may predate usage_events.
    try {
      // Live-asset-wins collision policy, mirroring the stale-entries eviction
      // above and mv's state.db re-key: DETACHED orphan events (entry_id NULL
      // — a deleted asset's history retained by a full rebuild) already
      // sitting AT the new ref are evicted BEFORE the old→new rewrite. No
      // stale entries row exists for them, so the deleteRelatedRows path
      // never sees them (it deletes by entry_id only) — left in place, the
      // moved asset would adopt the stranger's history: getRetrievalCounts
      // reads by entry_ref immediately, and the next full rebuild's
      // relinkUsageEvents would attach every stranger event by ref.
      if (opts.sourceName) {
        const origins = new Set([opts.sourceName]);
        if (opts.sourceName === "stash" && opts.includeLegacyBare) origins.add("local");
        for (const origin of origins) {
          const oldQualifiedRef = `${origin}//${opts.oldRef}`;
          const newQualifiedRef = `${origin}//${opts.newRef}`;
          db.prepare("DELETE FROM usage_events WHERE entry_id IS NULL AND entry_ref = ?").run(newQualifiedRef);
          db.prepare("UPDATE usage_events SET entry_ref = ? WHERE entry_ref = ?").run(newQualifiedRef, oldQualifiedRef);
        }
      }
      if (opts.includeLegacyBare || !opts.sourceName) {
        db.prepare("DELETE FROM usage_events WHERE entry_id IS NULL AND entry_ref = ?").run(opts.newRef);
        db.prepare("UPDATE usage_events SET entry_ref = ? WHERE entry_ref = ?").run(opts.newRef, opts.oldRef);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missingLegacyUsageSchema =
        /no such table:\s*(?:main\.)?usage_events\b/i.test(message) ||
        /no such column:\s*(?:usage_events\.)?(?:entry_id|entry_ref)\b/i.test(message) ||
        /table\s+usage_events\s+has no column named\s+(?:entry_id|entry_ref)\b/i.test(message);
      if (!missingLegacyUsageSchema) throw error;
    }
    db.prepare("INSERT OR IGNORE INTO entries_fts_dirty (entry_id) VALUES (?)").run(row.id);
  })();

  return row.id;
}

/**
 * Phase 2A / Rec 5: bulk-load positive feedback event counts for the given
 * entry ids. Used by the utility-decay forgetting curve to stabilize
 * (extend the half-life of) memories that have repeatedly proven useful.
 *
 * Returns a `Map<entryId, count>` containing only entries with at least one
 * positive feedback event — missing ids implicitly map to `0`. Chunks at
 * `SQLITE_CHUNK_SIZE` (500) to respect `SQLITE_MAX_VARIABLE_NUMBER`.
 *
 * Cheap when called with zero ids, and silently empty when the
 * `usage_events` table is missing.
 */
export function getPositiveFeedbackCountsByIds(db: Database, ids: number[]): Map<number, number> {
  const result = new Map<number, number>();
  if (ids.length === 0) return result;
  for (let i = 0; i < ids.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    bestEffort(() => {
      const rows = db
        .prepare(
          `SELECT entry_id, COUNT(*) AS cnt
             FROM usage_events
             WHERE event_type = 'feedback'
               AND signal = 'positive'
               AND entry_id IN (${placeholders})
             GROUP BY entry_id`,
        )
        .all(...chunk) as Array<{ entry_id: number | null; cnt: number }>;
      for (const row of rows) {
        if (row.entry_id !== null && row.cnt > 0) {
          result.set(row.entry_id, row.cnt);
        }
      }
    }, "usage_events table may be missing on legacy DBs — treat as zero counts");
  }
  return result;
}

function deleteEntriesWhere(db: Database, column: "dir_path" | "stash_dir", value: string): void {
  db.transaction(() => {
    const ids = db.prepare(`SELECT id FROM entries WHERE ${column} = ?`).all(value) as Array<{ id: number }>;
    deleteRelatedRows(db, ids);
    db.prepare(`DELETE FROM entries WHERE ${column} = ?`).run(value);
  })();
}

export function deleteEntriesByDir(db: Database, dirPath: string): void {
  deleteEntriesWhere(db, "dir_path", dirPath);
}

export function deleteEntriesByStashDir(db: Database, stashDir: string): void {
  deleteEntriesWhere(db, "stash_dir", stashDir);
}

function deleteRelatedRows(db: Database, ids: Array<{ id: number }>): void {
  if (ids.length === 0) return;
  const numericIds = ids.map((r) => r.id);
  const vecAvail = isVecAvailable(db);

  // Drop matching FTS rows + dirty markers immediately so an incremental
  // rebuild after a deletion doesn't try to re-index entries that no longer
  // exist (and so a full scan after deletion sees a consistent FTS).
  for (let i = 0; i < numericIds.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = numericIds.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    bestEffort(
      () => db.prepare(`DELETE FROM entries_fts WHERE entry_id IN (${placeholders})`).run(...chunk),
      "fts table may not exist on a brand-new db",
    );
    bestEffort(
      () => db.prepare(`DELETE FROM entries_fts_dirty WHERE entry_id IN (${placeholders})`).run(...chunk),
      "fts dirty table is created lazily by upsertEntry",
    );
  }

  // Process in chunks to stay within SQLITE_MAX_VARIABLE_NUMBER
  for (let i = 0; i < numericIds.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = numericIds.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    bestEffort(
      () => db.prepare(`DELETE FROM embeddings WHERE id IN (${placeholders})`).run(...chunk),
      "delete embeddings for entries",
    );
    if (vecAvail) {
      bestEffort(
        () => db.prepare(`DELETE FROM entries_vec WHERE id IN (${placeholders})`).run(...chunk),
        "delete entries_vec for entries",
      );
    }
    // Clean up utility scores before deleting entries
    bestEffort(
      () => db.prepare(`DELETE FROM utility_scores WHERE entry_id IN (${placeholders})`).run(...chunk),
      "delete utility_scores for entries",
    );
    bestEffort(
      () => db.prepare(`DELETE FROM utility_scores_scoped WHERE entry_id IN (${placeholders})`).run(...chunk),
      "delete utility_scores_scoped for entries",
    );
    // Clean up usage events before deleting entries
    bestEffort(
      () => db.prepare(`DELETE FROM usage_events WHERE entry_id IN (${placeholders})`).run(...chunk),
      "delete usage_events for entries",
    );
  }

  // #624-P1: graph_files is NO LONGER keyed on entries.id, so deleting an
  // entries row must NOT wipe the extracted graph (that is the whole point —
  // the graph survives a reindex when body_hash is unchanged). We therefore do
  // NOT delete graph_files here. We DO, however, recompute graph_meta counts
  // for the stash roots touched by the deleted entries so the summary numbers
  // stay consistent with the live child rows (the counts are derived, and the
  // entries delete may have changed which files are considered/indexed).
  //
  // Resolve the affected stash roots from the entries rows BEFORE deletion.
  const affectedStashRoots = new Set<string>();
  for (let i = 0; i < numericIds.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = numericIds.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    bestEffort(() => {
      const rows = db
        .prepare(`SELECT DISTINCT stash_dir FROM entries WHERE id IN (${placeholders})`)
        .all(...chunk) as Array<{ stash_dir: string }>;
      for (const row of rows) {
        if (row.stash_dir) affectedStashRoots.add(row.stash_dir);
      }
    }, "resolve stash roots for graph_meta recompute");
  }
  for (const stashRoot of affectedStashRoots) {
    bestEffort(
      () =>
        db
          .prepare(
            `UPDATE graph_meta
             SET extracted_files = (SELECT COUNT(*) FROM graph_files WHERE stash_root = ?),
                 entity_count    = (SELECT COUNT(*) FROM graph_file_entities WHERE stash_root = ?),
                 relation_count  = (SELECT COUNT(*) FROM graph_file_relations WHERE stash_root = ?)
             WHERE stash_root = ?`,
          )
          .run(stashRoot, stashRoot, stashRoot, stashRoot),
      "sync graph_meta counts after entries delete",
    );
  }
}

/**
 * Delete entries by their primary key IDs, along with all related rows
 * (embeddings, entries_vec, entries_fts, utility_scores, usage_events).
 *
 * Used by the `--clean` post-pass to remove stale entries whose source files
 * no longer exist on disk.
 */
export function deleteEntriesByIds(db: Database, ids: number[]): void {
  if (ids.length === 0) return;
  db.transaction(() => {
    const idObjs = ids.map((id) => ({ id }));
    deleteRelatedRows(db, idObjs);
    for (let i = 0; i < ids.length; i += SQLITE_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + SQLITE_CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(",");
      db.prepare(`DELETE FROM entries WHERE id IN (${placeholders})`).run(...chunk);
    }
  })();
}

// ── All entries ─────────────────────────────────────────────────────────────

function parseEntryRows(rows: Array<Record<string, unknown>>, context: string): DbIndexedEntry[] {
  const entries: DbIndexedEntry[] = [];
  for (const row of rows as EntryRow[]) {
    const mapped = rowToIndexedEntry(row, context);
    if (mapped) entries.push(mapped);
  }
  return entries;
}

export function getAllEntries(db: Database, entryType?: string, excludeTypes?: string[]): DbIndexedEntry[] {
  let sql: string;
  let params: unknown[];

  // #627 — exclude-type clause applies only on the untyped ('any') path. Empty
  // list skips the clause (never `NOT IN ()`).
  const excludes = excludeTypes && excludeTypes.length > 0 ? excludeTypes : [];

  if (entryType && entryType !== "any") {
    sql = `SELECT ${ENTRY_COLUMNS} FROM entries WHERE entry_type = ?`;
    params = [entryType];
  } else if (excludes.length > 0) {
    sql = `SELECT ${ENTRY_COLUMNS} FROM entries WHERE entry_type NOT IN (${excludes.map(() => "?").join(", ")})`;
    params = [...excludes];
  } else {
    sql = `SELECT ${ENTRY_COLUMNS} FROM entries`;
    params = [];
  }

  const rows = db.prepare(sql).all(...(params as Array<string>)) as Array<Record<string, unknown>>;
  return parseEntryRows(rows, "getAllEntries");
}

export function findEntryIdByRef(db: Database, ref: string, stashDir?: string): number | undefined {
  const parsed = parseAssetRef(ref);
  const nameVariants = [parsed.name];
  if (parsed.name.endsWith(".md")) {
    nameVariants.push(parsed.name.slice(0, -3));
  } else {
    nameVariants.push(`${parsed.name}.md`);
  }

  const stmt = db.prepare(
    `SELECT id FROM entries
     WHERE entry_type = ?
       AND substr(entry_key, length(entry_key) - length(?) + 1) = ?
       ${stashDir ? "AND stash_dir = ?" : ""}
     LIMIT 1`,
  );

  for (const name of nameVariants) {
    const suffix = `${parsed.type}:${name}`;
    const row = stmt.get(parsed.type, suffix, suffix, ...(stashDir ? [stashDir] : [])) as { id: number } | undefined;
    if (row) return row.id;
  }

  return undefined;
}

export function getEntryCount(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM entries").get() as { cnt: number };
  return row.cnt;
}

export function getEmbeddableEntryCount(db: Database): number {
  return getEntryCount(db);
}

export function getEntryById(
  db: Database,
  id: number,
): { filePath: string; stashDir: string; entry: StashEntry } | undefined {
  const row = db.prepare("SELECT file_path, stash_dir, entry_json FROM entries WHERE id = ?").get(id) as
    | { file_path: string; stash_dir: string; entry_json: string }
    | undefined;
  if (!row) return undefined;
  // Guard against corrupt JSON
  let entry: StashEntry;
  try {
    entry = JSON.parse(row.entry_json) as StashEntry;
  } catch {
    warn(`[db] getEntryById: skipping entry id=${id} — corrupt entry_json`);
    return undefined;
  }
  return { filePath: row.file_path, stashDir: row.stash_dir, entry };
}

export function getEntriesByDir(db: Database, dirPath: string): DbIndexedEntry[] {
  const rows = db.prepare(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE dir_path = ?`).all(dirPath) as Array<
    Record<string, unknown>
  >;
  return parseEntryRows(rows, "getEntriesByDir");
}

/**
 * Resolve a single `entries.id` by exact `file_path` (the canonical on-disk
 * path), or `undefined` if no row matches.
 *
 * Lifted verbatim (WS5) from the inline `SELECT id FROM entries WHERE
 * file_path = ? LIMIT 1` in commands/search.ts so all `entries` SQL lives in
 * this module. The result is a plain number materialised before return —
 * nothing lazy crosses a connection boundary.
 */
export function getEntryIdByFilePath(db: Database, filePath: string): number | undefined {
  const row = db.prepare("SELECT id FROM entries WHERE file_path = ? LIMIT 1").get(filePath) as
    | { id: number }
    | undefined;
  return row?.id;
}

/**
 * Set of every non-empty `entries.file_path` currently indexed (across all
 * stashes/sources). Used by staleness detection to spot files that exist on
 * disk but were never indexed — a clock-independent signal for newly-added
 * assets that an mtime-vs-builtAt comparison can miss when the two clocks
 * (filesystem vs wall-clock) are skewed within the same millisecond.
 */
export function getIndexedFilePaths(db: Database): Set<string> {
  const rows = db
    .prepare("SELECT DISTINCT file_path FROM entries WHERE file_path IS NOT NULL AND file_path <> ''")
    .all() as Array<{
    file_path: string;
  }>;
  return new Set(rows.map((r) => r.file_path));
}

/**
 * Resolve a single `entries.file_path` by primary key, or `undefined` if no
 * row matches.
 *
 * Lifted verbatim (WS5) from the inline `SELECT file_path FROM entries WHERE
 * id = ?` in commands/feedback-cli.ts. Unlike {@link getEntryById}, this does
 * NOT parse `entry_json`, so a row with corrupt JSON still yields its path —
 * preserving feedback-cli's pre-extraction behaviour byte-for-byte.
 */
export function getEntryFilePathById(db: Database, id: number): string | undefined {
  const row = db.prepare("SELECT file_path FROM entries WHERE id = ?").get(id) as { file_path: string } | undefined;
  return row?.file_path;
}

/**
 * Fetch every `(file_path, entry_json)` row whose entry belongs to a given
 * stash root — matched either by exact `stash_dir` OR by `file_path` prefix.
 *
 * Lifted verbatim (WS5) from the inline query in commands/graph.ts'
 * `buildRefByPath`. The full result set is materialised with `.all()` before
 * return so callers can iterate it after the connection closes (WS5
 * connection-lifetime rule). JSON parsing stays with the caller, unchanged.
 */
export function getEntryRefRowsForStashRoot(db: Database, stashRoot: string): EntryRefRow[] {
  return db
    .prepare("SELECT file_path, entry_json FROM entries WHERE stash_dir = ? OR file_path LIKE ?")
    .all(stashRoot, `${stashRoot}%`) as EntryRefRow[];
}

// ── Indexer-phase helpers (moved from indexer.ts) ────────────────────────────

/**
 * Upsert a workflow document record for an indexed entry.
 * Persists the parsed workflow AST as JSON alongside a FNV-1a hash of the
 * source content for future incremental fast-paths.
 */
export function upsertWorkflowDocument(
  db: Database,
  entryId: number,
  doc: import("../../workflows/schema").WorkflowDocument,
  content: Buffer,
): void {
  const sourceHash = computeSourceHash(content);
  db.prepare(
    `INSERT INTO workflow_documents (entry_id, schema_version, document_json, source_path, source_hash, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(entry_id) DO UPDATE SET
       schema_version = excluded.schema_version,
       document_json = excluded.document_json,
       source_path = excluded.source_path,
       source_hash = excluded.source_hash,
       updated_at = excluded.updated_at`,
  ).run(entryId, doc.schemaVersion, JSON.stringify(doc), doc.source.path, sourceHash, new Date().toISOString());
}

/**
 * Compute a cheap FNV-1a hash of a buffer for source-identity tracking.
 * Not security-sensitive; used as an incremental fast-path skip key.
 */
export function computeSourceHash(content: Buffer): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Return distinct zero-result search queries from the `usage_events` table
 * within the given lookback window.
 *
 * Reads from `usage_events` (event_type = 'search') where the metadata JSON
 * blob contains `resultCount = 0`. The `search_events` table never existed;
 * all errors are caught and an empty array is returned so callers never need
 * to guard against DB schema differences.
 */
export function getZeroResultSearches(db: Database, sinceDays = 30): string[] {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT json_extract(metadata, '$.query') AS query
         FROM usage_events
         WHERE event_type = 'search'
           AND created_at >= ?
           AND json_extract(metadata, '$.resultCount') = 0
         ORDER BY created_at DESC LIMIT 20`,
      )
      .all(since) as { query: string | null }[];
    return rows.map((r) => r.query).filter((q): q is string => q !== null);
  } catch {
    return []; // table may not exist in older DBs
  }
}

/**
 * Look up an entry by its integer numeric id.
 * Returns null when no matching row is found.
 */
export function getEntryByRef(db: Database, type: string, name: string): { id: number } | null {
  return db.prepare("SELECT id FROM entries WHERE entry_type = ? AND entry_key = ?").get(type, `${type}:${name}`) as {
    id: number;
  } | null;
}

/**
 * Source mapping used to preserve qualified usage-event identity while relinking.
 */
function resolveUsageEventEntryId(db: Database, ref: string, options: RelinkUsageEventsOptions): number | undefined {
  const parsed = parseAssetRef(ref);
  if (!parsed.origin) {
    return options.defaultStashDir ? findEntryIdByRef(db, ref, options.defaultStashDir) : undefined;
  }

  const source =
    parsed.origin === "local" || parsed.origin === "stash"
      ? options.sources?.[0]
      : options.sources?.find((candidate) => candidate.registryId === parsed.origin);
  return source ? findEntryIdByRef(db, ref, source.path) : undefined;
}

/**
 * Re-link detached usage_events to their current entry_ids via entry_ref.
 *
 * After a full rebuild, entry IDs change. This restores each event's link
 * using the stable `entry_ref` column so usage history survives a reindex.
 */
export function relinkUsageEvents(db: Database, options: RelinkUsageEventsOptions = {}): void {
  bestEffort(() => {
    // Step 1: null out stale entry_ids (entry was deleted, re-keyed, etc).
    // Leaving them in place would let `recomputeUtilityScores` aggregate
    // by an entry_id that no longer exists in `entries`, then trip the FK
    // constraint on the utility_scores INSERT and roll back the entire
    // finalize transaction. Nulled rows can be re-resolved by step 2 below;
    // events whose entry is permanently gone simply stay null and age out
    // via the 90-day retention policy.
    db.exec(`
      UPDATE usage_events
      SET entry_id = NULL
      WHERE entry_id IS NOT NULL
        AND entry_id NOT IN (SELECT id FROM entries)
    `);

    // Step 2: re-resolve each distinct ref inside its source boundary. Qualified
    // refs require an origin→root mapping; bare legacy refs require the explicit
    // historical/default root. This keeps duplicate refs from adopting whichever
    // entries row SQLite happens to return first while retaining indexed lookups.
    const refs = db
      .prepare("SELECT DISTINCT entry_ref AS ref FROM usage_events WHERE entry_id IS NULL AND entry_ref IS NOT NULL")
      .all() as { ref: string }[];

    const update = db.prepare("UPDATE usage_events SET entry_id = ? WHERE entry_ref = ? AND entry_id IS NULL");
    const relinkTx = db.transaction(() => {
      for (const { ref } of refs) {
        let id: number | undefined;
        try {
          id = resolveUsageEventEntryId(db, ref, options);
        } catch (err) {
          if (err instanceof Error && err.name === "UsageError") continue;
          throw err;
        }
        if (id !== undefined) update.run(id, ref);
      }
    });
    relinkTx();
  }, "usage_events table may not exist yet during entry_id re-resolution");
}

/**
 * Walk indexed entries and collect a deduplicated set of tags. When
 * `entryType` is provided, only entries of that type contribute tags.
 *
 * Pure read; never mutates the DB. Used by `akm lessons coverage` (Phase 7A)
 * to compute the diff between all-asset tags and lesson tags. Tags are
 * normalised by trimming and lower-casing, and blank tags are dropped.
 *
 * SQL owner: this module owns ALL raw SQL against the `entries` table (WS5),
 * so the `lessons coverage` read lives here rather than leaking into cli.ts.
 * The result set is fully materialised (`.all()` then iterate) before return.
 */
export function collectTagSetFromEntries(db: Database, entryType: string | undefined): Set<string> {
  const tags = new Set<string>();
  const stmt = entryType
    ? db.prepare("SELECT entry_json FROM entries WHERE entry_type = ?")
    : db.prepare("SELECT entry_json FROM entries");
  const rows = (entryType ? stmt.all(entryType) : stmt.all()) as Array<{ entry_json: string }>;
  for (const row of rows) {
    let parsed: { tags?: unknown };
    try {
      parsed = JSON.parse(row.entry_json) as { tags?: unknown };
    } catch {
      continue;
    }
    if (!Array.isArray(parsed.tags)) continue;
    for (const tag of parsed.tags) {
      if (typeof tag === "string" && tag.trim().length > 0) {
        tags.add(tag.trim().toLowerCase());
      }
    }
  }
  return tags;
}
