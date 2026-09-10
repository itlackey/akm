// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index.db` entries repository — CRUD, lookup, re-key, delete-cascade, and the
 * usage-event relink + workflow-document + tag-set reads that key on `entries`.
 *
 * Owns ALL raw SQL against the `entries` table. The shared row/option shapes
 * come from the leaf types + mapper modules.
 */

import fs from "node:fs";
import path from "node:path";
import { parseBundleRef } from "../../core/asset/asset-ref";
import { conceptIdFromTypeName } from "../../core/asset/resolve-ref";
import { bestEffort } from "../../core/best-effort";
import { isPathAbsent } from "../../core/path-access";
import { getStateDbPath, withStateDb } from "../../core/state-db";
import { warn } from "../../core/warn";
import {
  getMarkdownFragmentContent,
  hasMarkdownFragmentContent,
  type IndexDocument,
} from "../../indexer/passes/metadata";
import { buildSearchText } from "../../indexer/search/search-fields";
import type { Database, SqlValue } from "../database";
import { ENTRY_COLUMNS, type EntryRow, rowToIndexedEntry } from "./index-entry-mapper";
import type { DbIndexedEntry, EntryProvenance, RekeyEntryOptions, RelinkUsageEventsOptions } from "./index-entry-types";
import { deleteFragmentSource, replaceFragmentSource } from "./index-fts-repository";
import { SQLITE_CHUNK_SIZE } from "./index-sql";

// ── Entry operations ────────────────────────────────────────────────────────

/**
 * Insert or update one canonical entry and all synchronously derived search
 * state. Returns the stable row id.
 *
 * The entries row and its safe-Markdown fragment source commit as one SQLite
 * transaction. Callers therefore cannot publish an entry and forget the
 * fragment-source write. (Unit derivation — `unit_texts`/`units_fts`/
 * `entry_units` — is the caller's job, driven by reconcile: a changed
 * `search_text` needs no explicit vector invalidation here, since a new
 * document simply derives new content-addressed unit hashes.)
 */
export function upsertEntry(
  db: Database,
  filePath: string,
  entry: IndexDocument,
  searchText: string,
  provenance: EntryProvenance,
  contentHash?: string,
): number {
  // Hot path during indexing — cache prepared statements per database
  // connection so we don't pay the SQL parse/compile cost on every call.
  const stmts = getUpsertStmts(db);
  // Phase 5A / Advantage D5: surface derived memory parent ref into the
  // dedicated `derived_from` column so retrieval-time lookup (parent→child)
  // does not have to scan + JSON-decode every memory row.
  const derivedFrom =
    typeof entry.derivedFrom === "string" && entry.derivedFrom.trim() ? entry.derivedFrom.trim() : null;
  // `content_hash` is optional on the LLM-enrichment re-upsert; a missing hash
  // preserves the scan writer's current value.
  const apply = (): number => {
    const result = stmts.upsert.get(
      provenance.itemRef,
      provenance.bundleId,
      provenance.componentId,
      provenance.conceptId,
      provenance.adapterId,
      entry.type,
      filePath,
      contentHash ?? null,
      JSON.stringify(entry),
      searchText,
      derivedFrom,
    ) as { id: number } | undefined;
    if (!result) throw new Error("upsertEntry: item_ref not found after upsert");

    replaceFragmentSource(
      db,
      result.id,
      hasMarkdownFragmentContent(entry) ? (getMarkdownFragmentContent(entry) ?? null) : undefined,
    );
    return result.id;
  };
  // Always enter the driver's transaction wrapper. Both supported SQLite
  // drivers lower a transaction opened inside another transaction to a
  // savepoint, so a caller that catches this mutation's error cannot commit a
  // partial entries row through its outer transaction.
  return db.transaction(apply)();
}

interface UpsertStmts {
  upsert: ReturnType<Database["prepare"]>;
}

const upsertStmtsByDb = new WeakMap<Database, UpsertStmts>();

// item_ref is the sole durable conflict target. `content_hash` COALESCEs so a
// metadata-only enrichment pass cannot wipe a scan hash.
const UPSERT_SET_CLAUSE = `SET
        bundle_id = excluded.bundle_id,
        component_id = excluded.component_id,
        concept_id = excluded.concept_id,
        adapter_id = excluded.adapter_id,
        type = excluded.type,
        file_path = excluded.file_path,
        document_json = excluded.document_json,
        search_text = excluded.search_text,
        derived_from = excluded.derived_from,
        content_hash = COALESCE(excluded.content_hash, content_hash)`;

function getUpsertStmts(db: Database): UpsertStmts {
  const existing = upsertStmtsByDb.get(db);
  if (existing) return existing;
  const stmts: UpsertStmts = {
    // RETURNING id handles ON CONFLICT DO UPDATE correctly — no second
    // SELECT round-trip needed (last_insert_rowid() is unreliable for
    // ON CONFLICT). Use `.get()` so a single row comes back.
    upsert: db.prepare(`
      INSERT INTO entries (
        item_ref, bundle_id, component_id, concept_id, adapter_id, type,
        file_path, content_hash, document_json, search_text, derived_from
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_ref) DO UPDATE ${UPSERT_SET_CLAUSE}
      RETURNING id
    `),
  };
  upsertStmtsByDb.set(db, stmts);
  return stmts;
}

/**
 * Phase 5A / Advantage D5: look up the derived-memory child row whose
 * `derived_from` column matches `parentRef` (the 0.9.0 conceptId, e.g.
 * `"memories/claude-prefs"` — Group-C item 2 flip).
 *
 * Returns the most-recently-updated derived child when multiple exist (one
 * parent should yield exactly one `.derived` child in practice, but the
 * ordering keeps results deterministic). Returns `null` when no derived
 * child has been indexed for this parent.
 */
export function getDerivedForParent(db: Database, parentRef: string, bundleId?: string): DbIndexedEntry | null {
  if (!parentRef) return null;
  const sourceScope = bundleId ? "AND bundle_id = ?" : "";
  const row = db
    .prepare(
      `SELECT ${ENTRY_COLUMNS}
         FROM entries
         WHERE derived_from = ?
         ${sourceScope}
         ORDER BY id DESC
         LIMIT 1`,
    )
    .get(parentRef, ...(bundleId ? [bundleId] : [])) as EntryRow | undefined;
  if (!row) return null;
  return rowToIndexedEntry(row, "getDerivedForParent");
}

/**
 * 03-R3: for the given derived-twin row ids, fetch each twin's BASE memory
 * `beliefState`, keyed by twin id.
 *
 * Used by the derived-twin belief inheritance in search ranking: a `.derived`
 * twin has no belief state of its own, so it inherits its base memory's
 * demoting state (contradicted/superseded/…) at search time. A twin's durable
 * `item_ref` is exactly its base ref plus the `.derived` suffix, so the base is
 * found by stripping that suffix. Returns a map
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
          `SELECT twin.id AS twin_id, json_extract(base.document_json, '$.beliefState') AS belief
           FROM entries twin
           JOIN entries base
             ON base.type = 'memory'
             AND base.item_ref = substr(twin.item_ref, 1, length(twin.item_ref) - length('.derived'))
           WHERE twin.id IN (${placeholders})
             AND twin.item_ref LIKE '%.derived'
             AND json_extract(base.document_json, '$.beliefState') IS NOT NULL`,
        )
        .all(...chunk) as { twin_id: number; belief: string | null }[];
      for (const r of rows) {
        if (typeof r.belief === "string" && r.belief.trim().length > 0) out.set(r.twin_id, r.belief.trim());
      }
    }, "belief-state inheritance is best-effort");
  }
  return out;
}

/**
 * Re-key an entries row in place for the opt-in source-maintenance script.
 *
 * The row id is preserved on purpose — `utility_scores` and
 * `utility_scores_scoped` are keyed by `entry_id`, so an UPDATE (rather than
 * a delete + insert under the new `item_ref`) is what keeps the asset's
 * accumulated usage-ranking history attached across a rename.
 * (`asset_salience` / `asset_outcome` live in state.db keyed by `asset_ref`
 * TEXT and are re-keyed separately by `akm mv` — see the state rekey
 * helper.) `document_json.name` (and `filename`, when present) is patched
 * and `search_text` rebuilt so search reflects the new name. Its
 * safe-Markdown fragment source is updated in the same transaction as the
 * canonical identity; the new `search_text` needs no explicit vector
 * invalidation — content-addressed units simply derive new hashes on the
 * next reconcile.
 *
 * Bundle-qualified `usage_events.entry_ref` rows for the old conceptId are
 * rewritten to the new item ref. Without this, events keep the old
 * ref, `relinkUsageEvents` finds no matching entry after the next full
 * rebuild, and the utility history the re-key exists to preserve silently
 * resets. DETACHED orphan events already sitting at the new ref (entry_id
 * NULL — a deleted stranger's history) are deleted first, so the moved asset
 * never adopts them (live asset's history wins, matching the stale-row
 * eviction below).
 *
 * A stale row already occupying the new item ref (the caller has verified no
 * FILE exists at the target, so such a row can only be a leftover for a
 * deleted file) is evicted first — through {@link deleteRelatedRows}, so its
 * child rows (utility scores, usage events) go with it. The moved row keeps
 * its id.
 *
 * Returns the surviving row id, or `null` when no row matches the old item ref
 * (nothing indexed under the old name — the caller falls open and the next
 * full `akm index` picks the file up as a fresh entry).
 */
export function rekeyEntryInPlace(db: Database, opts: RekeyEntryOptions): number | null {
  const oldItemRef = `${opts.sourceName}//${opts.oldRef}`;
  const row = db
    .prepare("SELECT id, file_path, document_json, search_text, type FROM entries WHERE item_ref = ?")
    .get(oldItemRef) as
    | {
        id: number;
        file_path: string;
        document_json: string;
        search_text: string;
        type: string;
      }
    | undefined
    | null;
  if (!row) return null;
  const sourceRoot = path.resolve(opts.sourceRoot);
  const currentPath = path.resolve(row.file_path);
  if (currentPath !== sourceRoot && !currentPath.startsWith(`${sourceRoot}${path.sep}`)) {
    throw new Error(`Refusing to re-key entry ${oldItemRef}: source root does not match.`);
  }

  // Patch the JSON payload. On corrupt document_json still re-key identity/path so
  // the utility history survives; the next full index heals the JSON.
  let documentJson = row.document_json;
  let searchText = row.search_text;
  let document: IndexDocument | undefined;
  try {
    const entry = JSON.parse(row.document_json) as IndexDocument;
    entry.name = opts.newName;
    if (typeof entry.filename === "string") entry.filename = path.basename(opts.newFilePath);
    if (opts.newDerivedFrom !== undefined) entry.derivedFrom = opts.newDerivedFrom;
    documentJson = JSON.stringify(entry);
    searchText = buildSearchText(entry);
    document = entry;
  } catch {
    /* corrupt document_json — identity/path-only re-key */
  }

  const expectedNewRef = conceptIdFromTypeName(row.type, opts.newName);
  if (opts.newRef !== expectedNewRef) {
    throw new Error(`Refusing to re-key entry ${oldItemRef}: target ref does not match the entry type and name.`);
  }
  const newItemRef = `${opts.sourceName}//${opts.newRef}`;

  db.transaction(() => {
    const stale = db.prepare("SELECT id FROM entries WHERE item_ref = ?").get(newItemRef) as
      | { id: number }
      | undefined
      | null;
    if (stale && stale.id !== row.id) {
      // Full child-row cleanup (utility scores, usage events, fragment
      // source) BEFORE the entries delete — the FK-less child rows would
      // otherwise orphan permanently.
      deleteRelatedRows(db, [{ id: stale.id }]);
      db.prepare("DELETE FROM entries WHERE id = ?").run(stale.id);
    }
    db.prepare(
      "UPDATE entries SET file_path = ?, document_json = ?, search_text = ?, item_ref = ?, concept_id = ? WHERE id = ?",
    ).run(opts.newFilePath, documentJson, searchText, newItemRef, opts.newRef, row.id);
    if (opts.newDerivedFrom !== undefined) {
      db.prepare("UPDATE entries SET derived_from = ? WHERE id = ?").run(opts.newDerivedFrom, row.id);
    }
    if (document)
      replaceFragmentSource(
        db,
        row.id,
        hasMarkdownFragmentContent(document) ? (getMarkdownFragmentContent(document) ?? null) : undefined,
      );
    else deleteFragmentSource(db, [row.id]);
  })();

  // Re-point usage history at the new ref. Chunk-8 WI-8.3: usage_events lives in
  // state.db now, so this is a SEPARATE cross-DB transaction (best-effort — the
  // rename itself already committed above; on failure the next full index's
  // relinkUsageEvents re-attaches by ref). See the docstring for the spellings
  // and the live-asset-wins collision policy.
  rewriteUsageEventRefForMove(opts);

  return row.id;
}

/**
 * Rewrite `usage_events.entry_ref` from `opts.oldRef` to `opts.newRef` in
 * state.db. DETACHED orphan events (entry_id NULL) already sitting AT the new
 * ref are evicted first so the moved asset never adopts a deleted stranger's
 * history (live-asset-wins). Best-effort + guarded on state.db's existence.
 */
function rewriteUsageEventRefForMove(opts: RekeyEntryOptions): void {
  // Every other failure in here throws (see the catch below) precisely because
  // a move that quietly drops its usage history is a wrong answer wearing a
  // success. An unreadable state.db must not be the one silent exception —
  // only a state.db that was never created skips (#791).
  if (isPathAbsent(getStateDbPath())) return;
  // `usage_events.entry_ref` is the fully-qualified item_ref
  // (`<bundle>//<conceptId>`).
  const rename = (stateDb: Database, oldR: string, newR: string): void => {
    stateDb.prepare("DELETE FROM usage_events WHERE entry_id IS NULL AND entry_ref = ?").run(newR);
    stateDb.prepare("UPDATE usage_events SET entry_ref = ? WHERE entry_ref = ?").run(newR, oldR);
  };
  try {
    withStateDb((stateDb) => {
      stateDb.transaction(() => {
        rename(stateDb, `${opts.sourceName}//${opts.oldRef}`, `${opts.sourceName}//${opts.newRef}`);
      })();
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to rewrite usage events for move: ${message}`, { cause: error });
  }
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
 * Cheap when called with zero ids, and silently empty when state.db (or its
 * `usage_events` table) is absent.
 *
 * Chunk-8 WI-8.3: usage_events lives in state.db — this reads it there (no
 * entries join needed; the ids are supplied by the caller). Gated by the caller
 * (`shouldQueryPositiveFeedbackCounts`) so the state.db open is not on the
 * default search hot path.
 */
export function getPositiveFeedbackCountsByIds(ids: number[]): Map<number, number> {
  const result = new Map<number, number>();
  if (ids.length === 0 || !fs.existsSync(getStateDbPath())) return result;
  bestEffort(() => {
    withStateDb((stateDb) => {
      for (let i = 0; i < ids.length; i += SQLITE_CHUNK_SIZE) {
        const chunk = ids.slice(i, i + SQLITE_CHUNK_SIZE);
        const placeholders = chunk.map(() => "?").join(",");
        const rows = stateDb
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
      }
    });
  }, "positive feedback counts are best-effort");
  return result;
}

/**
 * Rows whose `file_path` sits directly in `dirPath`. A half-open byte range
 * over `idx_entries_file_path` (`[dir + sep, dir + sep + 1)`) turns the lookup
 * into an index seek; the range is exact for "starts with `dir/`" but also
 * admits nested subdirectories (`/a/b/c/x.md` for `/a/b`), so the dirname
 * post-filter stays.
 */
function selectRowsInDirectory<T extends { file_path: string }>(
  db: Database,
  dirPath: string,
  columns: string,
  bundleId?: string,
): T[] {
  const resolvedDir = path.resolve(dirPath);
  const prefix = resolvedDir + path.sep;
  const upperBound = resolvedDir + String.fromCharCode(path.sep.charCodeAt(0) + 1);
  const params: SqlValue[] = [prefix, upperBound];
  let sql = `SELECT ${columns} FROM entries WHERE file_path >= ? AND file_path < ?`;
  if (bundleId) {
    sql += " AND bundle_id = ?";
    params.push(bundleId);
  }
  const rows = db.prepare(sql).all(...params) as T[];
  return rows.filter((row) => path.dirname(row.file_path) === resolvedDir);
}

function rowsInDirectory(db: Database, dirPath: string, bundleId?: string): Array<{ id: number; item_ref: string }> {
  return selectRowsInDirectory<{ id: number; item_ref: string; file_path: string }>(
    db,
    dirPath,
    "id, item_ref, file_path",
    bundleId,
  );
}

function deleteEntryRows(
  db: Database,
  rows: Array<{ id: number }>,
  options: { cleanupUsageEvents?: boolean } = {},
): number[] {
  if (rows.length === 0) return [];
  deleteRelatedRows(db, rows, options);
  for (let i = 0; i < rows.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    db.prepare(`DELETE FROM entries WHERE id IN (${placeholders})`).run(...chunk.map((row) => row.id));
  }
  return rows.map((row) => row.id);
}

export function deleteEntriesByDirAndBundle(
  db: Database,
  dirPath: string,
  bundleId: string,
  options: { cleanupUsageEvents?: boolean } = {},
): number[] {
  return db.transaction(() => deleteEntryRows(db, rowsInDirectory(db, dirPath, bundleId), options))();
}

/** Delete every entry and child row belonging to one canonical bundle. */
export function deleteEntriesByBundle(db: Database, bundleId: string): void {
  db.transaction(() => {
    const rows = db.prepare("SELECT id FROM entries WHERE bundle_id = ?").all(bundleId) as Array<{ id: number }>;
    deleteEntryRows(db, rows);
  })();
}

/**
 * Delete the complete regenerable entry generation through the same child-row
 * authority used by targeted deletes. The caller may retain cross-database
 * usage events so the finalize pass can relink them to the new row ids.
 */
export function deleteAllEntries(db: Database, options: { cleanupUsageEvents?: boolean } = {}): number[] {
  return db.transaction(() => {
    const rows = db.prepare("SELECT id FROM entries").all() as Array<{ id: number }>;
    return deleteEntryRows(db, rows, options);
  })();
}

/**
 * Diff-persist orphan delete: remove every entry under `dirPath` whose durable
 * `item_ref` is not in `keepRefs`.
 *
 * Replaces the old per-dir `deleteEntriesByDir` + full re-insert: the caller
 * upserts the current file set first (ON CONFLICT preserving `entries.id`, so
 * utility / usage stay attached to unchanged rows), then calls this
 * to prune only the departed rows. The net row-state for the directory is identical
 * to delete-then-reinsert; the win is that unchanged rows keep their id.
 *
 * Both directory- and bundle-scoped so overlapping physical roots cannot
 * prune one another's rows.
 */
export function deleteEntriesByDirExceptRefs(
  db: Database,
  dirPath: string,
  bundleId: string,
  keepRefs: ReadonlySet<string>,
  options: { cleanupUsageEvents?: boolean } = {},
): number[] {
  return db.transaction(() => {
    const doomed = rowsInDirectory(db, dirPath, bundleId).filter((row) => !keepRefs.has(row.item_ref));
    return deleteEntryRows(db, doomed, options);
  })();
}

function deleteRelatedRows(
  db: Database,
  ids: Array<{ id: number }>,
  options: { cleanupUsageEvents?: boolean } = {},
): void {
  if (ids.length === 0) return;
  const numericIds = ids.map((r) => r.id);

  // The safe-Markdown fragment source is part of the canonical mutation
  // boundary, not a caller-maintained dirty queue. Delete it before the
  // parent row inside this transaction (redundant with entry_fragments' own
  // ON DELETE CASCADE, but explicit here alongside the other child-row
  // cleanup this function owns).
  deleteFragmentSource(db, numericIds);

  // Process in chunks to stay within SQLITE_MAX_VARIABLE_NUMBER
  for (let i = 0; i < numericIds.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = numericIds.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    // Clean up utility scores before deleting entries
    bestEffort(
      () => db.prepare(`DELETE FROM utility_scores WHERE entry_id IN (${placeholders})`).run(...chunk),
      "delete utility_scores for entries",
    );
    bestEffort(
      () => db.prepare(`DELETE FROM utility_scores_scoped WHERE entry_id IN (${placeholders})`).run(...chunk),
      "delete utility_scores_scoped for entries",
    );
  }

  // Graph rows are independently keyed and intentionally survive entry
  // deletion. Resolve their owning roots through the canonical physical path
  // before entries disappear, then refresh the derived summary counts.
  const affectedGraphRoots = new Set<string>();
  for (let i = 0; i < numericIds.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = numericIds.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    bestEffort(() => {
      const rows = db
        .prepare(
          `SELECT DISTINCT gf.stash_root
             FROM graph_files gf
             JOIN entries e ON e.file_path = gf.file_path
            WHERE e.id IN (${placeholders})`,
        )
        .all(...chunk) as Array<{ stash_root: string }>;
      for (const row of rows) affectedGraphRoots.add(row.stash_root);
    }, "resolve graph roots for graph_meta recompute");
  }
  for (const stashRoot of affectedGraphRoots) {
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

  // usage_events lives in state.db, outside this transaction. Index persistence
  // disables this cleanup and runs it only after its index.db transaction
  // commits; standalone delete callers retain the immediate behavior.
  if (options.cleanupUsageEvents !== false) deleteUsageEventsByEntryIds(numericIds);

  // graph_files is keyed by its own stash_root/file_path/body_hash identity,
  // so deleting an entry row intentionally leaves extracted graph data intact.
}

export function deleteUsageEventsByEntryIds(entryIds: number[]): void {
  if (entryIds.length === 0 || !fs.existsSync(getStateDbPath())) return;
  bestEffort(() => {
    withStateDb((stateDb) => {
      for (let i = 0; i < entryIds.length; i += SQLITE_CHUNK_SIZE) {
        const chunk = entryIds.slice(i, i + SQLITE_CHUNK_SIZE);
        const placeholders = chunk.map(() => "?").join(",");
        stateDb.prepare(`DELETE FROM usage_events WHERE entry_id IN (${placeholders})`).run(...chunk);
      }
    });
  }, "delete usage_events (state.db) for entries");
}

/**
 * Delete entries by their primary key IDs, along with all related rows
 * (entry_fragments, entry_units, utility scores, usage_events).
 *
 * Used by `reconcile.ts` to remove entries whose source files are gone.
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
    sql = `SELECT ${ENTRY_COLUMNS} FROM entries WHERE type = ?`;
    params = [entryType];
  } else if (excludes.length > 0) {
    sql = `SELECT ${ENTRY_COLUMNS} FROM entries WHERE type NOT IN (${excludes.map(() => "?").join(", ")})`;
    params = [...excludes];
  } else {
    sql = `SELECT ${ENTRY_COLUMNS} FROM entries`;
    params = [];
  }

  const rows = db.prepare(sql).all(...(params as Array<string>)) as Array<Record<string, unknown>>;
  return parseEntryRows(rows, "getAllEntries");
}

/**
 * Resolve a single `entries.id` from a new-grammar `[bundle//]conceptId` ref,
 * keying on the canonical stored `item_ref` (ref-grammar decision D-R1/D-R4).
 * The optional `bundleId` scopes the match to one indexed bundle.
 */
export function findEntryIdByRef(db: Database, ref: string, bundleId?: string): number | undefined {
  return findEntryIdByBundleRef(db, ref, bundleId);
}

/** `name` plus its `.md`-toggled sibling — the markdown ext-keep/strip ambiguity. */
function withMdVariants(name: string): string[] {
  return name.endsWith(".md") ? [name, name.slice(0, -3)] : [name, `${name}.md`];
}

/**
 * Current (`[bundle//]conceptId`) id lookup: match `item_ref` exactly when
 * bundle-qualified or by `//conceptId` suffix when short.
 */
function findEntryIdByBundleRef(db: Database, ref: string, bundleId?: string): number | undefined {
  const parsed = parseBundleRef(ref);
  const conceptVariants = withMdVariants(parsed.conceptId);

  // item_ref is the canonical stored spelling post-flip.
  for (const conceptId of conceptVariants) {
    const id = matchIdByItemRef(db, parsed.bundle, conceptId, bundleId);
    if (id !== undefined) return id;
  }
  return undefined;
}

/**
 * Match a row `id` by `item_ref`: exact `bundle//conceptId` when `bundle` is
 * known, else the `//conceptId` SUFFIX (short ref — any bundle). The suffix
 * uses `substr(...) = ...` (never LIKE) so `_`/`%` in a conceptId are literal,
 * and includes the `//` boundary so a segment split never false-matches.
 *
 * ── Deterministic winner (`ORDER BY id ASC`) ──
 *
 * A SHORT ref can match one concept id across MULTIPLE bundles (e.g. the same
 * `knowledge/guide` in the primary stash and an installed source). The bare
 * `LIMIT 1` this replaced picked whichever row SQLite happened to visit first —
 * a nondeterministic winner when two bundles share a conceptId. We now impose a
 * total order (`ORDER BY id ASC`) so the winner is STABLE across runs.
 *
 * `id ASC` is also the SENSIBLE choice, not just a stable tiebreak: a full index
 * walks its sources in installation-precedence order (`resolveSourceEntries`,
 * primary stash first — the same order `resolveSourcesForOrigin` calls "local"),
 * so the highest-precedence source's rows carry the LOWEST ids. Ascending id
 * therefore prefers the primary/highest-precedence bundle — mirroring what a
 * precedence-ordered scan would pick — while staying a pure config-free leaf
 * (true installation-priority resolution against an injected bundle list is
 * `resolveRef`'s job; this DB helper takes no config handle). The exact-bundle
 * arm is single-row under the UNIQUE `item_ref` index.
 */
function matchIdByItemRef(
  db: Database,
  bundle: string | undefined,
  conceptId: string,
  bundleId?: string,
): number | undefined {
  const scope = bundleId ? "AND bundle_id = ?" : "";
  if (bundle !== undefined) {
    const itemRef = `${bundle}//${conceptId}`;
    const row = db
      .prepare(`SELECT id FROM entries WHERE item_ref = ? ${scope} ORDER BY id ASC LIMIT 1`)
      .get(itemRef, ...(bundleId ? [bundleId] : [])) as { id: number } | undefined;
    return row?.id;
  }
  const suffix = `//${conceptId}`;
  const row = db
    .prepare(
      `SELECT id FROM entries
       WHERE substr(item_ref, length(item_ref) - length(?) + 1) = ?
         ${scope}
       ORDER BY id ASC
       LIMIT 1`,
    )
    .get(suffix, suffix, ...(bundleId ? [bundleId] : [])) as { id: number } | undefined;
  return row?.id;
}

export function getEntryCount(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM entries").get() as { cnt: number };
  return row.cnt;
}

/**
 * Per-asset-type entry counts (keyed by `type`, e.g. "skill",
 * "knowledge", "memory"). Used by `akm info` to break down the aggregate
 * `indexStats.entryCount` (R-057).
 */
export function getEntryCountByType(db: Database): Record<string, number> {
  const rows = db.prepare("SELECT type, COUNT(*) AS cnt FROM entries GROUP BY type").all() as Array<{
    type: string;
    cnt: number;
  }>;
  const out: Record<string, number> = {};
  for (const row of rows) {
    out[row.type] = row.cnt;
  }
  return out;
}

export function getEmbeddableEntryCount(db: Database): number {
  return getEntryCount(db);
}

export function getEntryById(
  db: Database,
  id: number,
):
  | {
      filePath: string;
      entry: IndexDocument;
      itemRef: string;
      bundleId: string;
      componentId: string;
      conceptId: string;
      adapterId: string;
    }
  | undefined {
  const row = db
    .prepare(
      "SELECT file_path, document_json, item_ref, bundle_id, component_id, concept_id, adapter_id FROM entries WHERE id = ?",
    )
    .get(id) as
    | {
        file_path: string;
        document_json: string;
        item_ref: string;
        bundle_id: string;
        component_id: string;
        concept_id: string;
        adapter_id: string;
      }
    | undefined;
  if (!row) return undefined;
  // Guard against corrupt JSON
  let entry: IndexDocument;
  try {
    entry = JSON.parse(row.document_json) as IndexDocument;
  } catch {
    warn(`[db] getEntryById: skipping entry id=${id} — corrupt document_json`);
    return undefined;
  }
  return {
    filePath: row.file_path,
    entry,
    itemRef: row.item_ref,
    bundleId: row.bundle_id,
    componentId: row.component_id,
    conceptId: row.concept_id,
    adapterId: row.adapter_id,
  };
}

export function getEntriesByDir(db: Database, dirPath: string): DbIndexedEntry[] {
  return parseEntryRows(selectRowsInDirectory<EntryRow>(db, dirPath, ENTRY_COLUMNS), "getEntriesByDir");
}

/** Return every directory previously indexed for one canonical bundle. */
export function getIndexedDirPathsByBundleId(db: Database, bundleId: string): string[] {
  const rows = db.prepare("SELECT file_path FROM entries WHERE bundle_id = ?").all(bundleId) as Array<{
    file_path: string;
  }>;
  return [...new Set(rows.map((row) => path.dirname(row.file_path)))];
}

/** Return every persisted bundle owner for one physical directory. */
export function getIndexedBundleIdsByDir(db: Database, dirPath: string): string[] {
  const rows = selectRowsInDirectory<{ bundle_id: string; file_path: string }>(db, dirPath, "bundle_id, file_path");
  return [...new Set(rows.map((row) => row.bundle_id))];
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
 * NOT parse `document_json`, so a row with corrupt JSON still yields its path —
 * preserving feedback-cli's pre-extraction behaviour byte-for-byte.
 */
export function getEntryFilePathById(db: Database, id: number): string | undefined {
  const row = db.prepare("SELECT file_path FROM entries WHERE id = ?").get(id) as { file_path: string } | undefined;
  return row?.file_path;
}

// ── Indexer-phase helpers (moved from indexer.ts) ────────────────────────────

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
 * Look up an entry `id` by a new-grammar `[bundle//]conceptId` ref, resolving
 * against the canonical stored `item_ref`. Returns `{ id }` or `null`.
 */
export function getEntryByRef(db: Database, ref: string): { id: number } | null {
  const id = findEntryIdByRef(db, ref);
  return id === undefined ? null : { id };
}

/**
 * The fully-qualified `item_ref` (`<bundle>//<conceptId>`, the durable stored
 * spelling — spec §11.1 D-R3) for an entry `id`, or `null` when the row is gone
 * The usage-event / salience / feedback writers derive the durable
 * key from this so a stored key is always the resolved entry's canonical ref,
 * never raw input (D-R3: durable keys are never derived from input).
 */
export function getItemRefById(db: Database, id: number): string | null {
  const row = db.prepare("SELECT item_ref FROM entries WHERE id = ?").get(id) as { item_ref: string } | undefined;
  return row?.item_ref ?? null;
}

/**
 * Resolve a `usage_events.entry_ref` to its live `entries.id`. `entry_ref` is
 * the fully-qualified `bundle//conceptId` `item_ref` spelling, so this keys
 * directly on the globally-unique `item_ref`. Bare durable refs are invalid and
 * remain detached.
 */
function resolveUsageEventEntryId(db: Database, ref: string): number | undefined {
  if (parseBundleRef(ref).bundle === undefined) return undefined;
  return findEntryIdByRef(db, ref);
}

/**
 * Re-link detached usage_events to their current entry_ids via entry_ref.
 *
 * After a full rebuild, entry IDs change. This restores each event's link
 * using the stable `entry_ref` column so usage history survives a reindex.
 *
 * Cross-DB (Chunk-8 WI-8.3): `usage_events` lives in `stateDb` while `entries`
 * lives in `indexDb`. The stale-id null-out (formerly a single-DB
 * `NOT IN (SELECT id FROM entries)`) is done in two bounded passes — the set of
 * distinct linked entry_ids in usage_events is small — and the re-resolution
 * reads `entries` from `indexDb`.
 */
function qualifiedUsageEventsTable(stateSchema?: string): string {
  if (stateSchema === undefined) return "usage_events";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(stateSchema)) throw new Error("Invalid attached state schema name.");
  return `"${stateSchema}".usage_events`;
}

export function relinkUsageEvents(indexDb: Database, stateDb: Database, options: RelinkUsageEventsOptions = {}): void {
  const usageEvents = qualifiedUsageEventsTable(options.stateSchema);
  bestEffort(() => {
    // Step 1: null out stale entry_ids (entry was deleted, re-keyed, etc).
    // Leaving them in place would let `recomputeUtilityScores` aggregate by an
    // entry_id that no longer exists in `entries`, then trip the FK constraint
    // on the utility_scores INSERT and roll back the entire finalize
    // transaction. Nulled rows can be re-resolved by step 2 below; events whose
    // entry is permanently gone simply stay null and age out via retention.
    const linkedRows = stateDb
      .prepare(`SELECT DISTINCT entry_id AS id, entry_ref AS ref FROM ${usageEvents} WHERE entry_id IS NOT NULL`)
      .all() as Array<{ id: number; ref: string | null }>;
    const entryIdentity = indexDb.prepare("SELECT item_ref AS itemRef FROM entries WHERE id = ?");
    const staleLinks = linkedRows.filter(({ id, ref }) => {
      const live = entryIdentity.get(id) as { itemRef: string } | null | undefined;
      return live == null || (ref !== null && live.itemRef !== ref);
    });
    if (staleLinks.length > 0) {
      const nullOut = stateDb.prepare(
        `UPDATE ${usageEvents} SET entry_id = NULL WHERE entry_id = ? AND entry_ref IS ?`,
      );
      const nullTx = stateDb.transaction(() => {
        for (const { id, ref } of staleLinks) nullOut.run(id, ref);
      });
      nullTx();
    }

    // Step 2: re-resolve each fully-qualified ref. Bare rows are not current
    // durable identities and remain detached.
    const refs = stateDb
      .prepare(`SELECT DISTINCT entry_ref AS ref FROM ${usageEvents} WHERE entry_id IS NULL AND entry_ref IS NOT NULL`)
      .all() as { ref: string }[];

    const update = stateDb.prepare(`UPDATE ${usageEvents} SET entry_id = ? WHERE entry_ref = ? AND entry_id IS NULL`);
    const relinkTx = stateDb.transaction(() => {
      for (const { ref } of refs) {
        let id: number | undefined;
        try {
          id = resolveUsageEventEntryId(indexDb, ref);
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
