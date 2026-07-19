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
import { type AssetRef, makeAssetRef, parseAssetRef, parseBundleRef } from "../../core/asset/asset-ref";
import { classifyRefGrammar, conceptIdToLegacy, legacyConceptId } from "../../core/asset/resolve-ref";
import { bestEffort } from "../../core/best-effort";
import { warn } from "../../core/warn";
import type { IndexDocument } from "../../indexer/passes/metadata";
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
  entry: IndexDocument,
  searchText: string,
  provenance?: EntryProvenance,
  contentHash?: string,
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
  // by the next full index). `content_hash` (F4a M-core-2) is `doc.hash` from
  // the diff-persist writer; a NULL passed here PRESERVES any existing hash (the
  // ON CONFLICT COALESCE below) so the LLM-enrichment re-upsert cannot wipe it.
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
    contentHash ?? null,
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
        item_ref, bundle_id, component_id, concept_id, adapter_id, type, content_hash
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        type = excluded.type,
        content_hash = COALESCE(excluded.content_hash, content_hash)
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
      // Chunk-5 flip F1: a twin's identity suffix is `.derived` on BOTH the
      // legacy `entry_key` (`<stash>:memory:<name>.derived`) and the new
      // `item_ref` (`<bundle>//memories/<name>.derived`). Join the base by
      // stripping that suffix on EITHER column so both fully-migrated rows
      // (item_ref path) and NULL-`item_ref` rows (legacy path) inherit. On a
      // consistent index both predicates select the SAME base row, so the OR
      // never double-counts; `substr(NULL, …)` is NULL and matches nothing, so
      // a NULL `item_ref` simply falls through to the entry_key predicate.
      // F5: the `entry_key` arm is the deletable legacy shim.
      const rows = db
        .prepare(
          `SELECT twin.id AS twin_id, json_extract(base.entry_json, '$.beliefState') AS belief
           FROM entries twin
           JOIN entries base
             ON base.entry_type = 'memory'
            AND (
                 base.entry_key = substr(twin.entry_key, 1, length(twin.entry_key) - length('.derived'))
              OR base.item_ref = substr(twin.item_ref, 1, length(twin.item_ref) - length('.derived'))
            )
           WHERE twin.id IN (${placeholders})
             AND (twin.entry_key LIKE '%.derived' OR twin.item_ref LIKE '%.derived')
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
  // F5: delete — the row is located by its legacy `entry_key`; the caller (mv)
  // always has it and it is the UNIQUE identity column during the F1 window.
  const row = db
    .prepare("SELECT id, stash_dir, entry_json, search_text, entry_type, item_ref FROM entries WHERE entry_key = ?")
    .get(opts.oldEntryKey) as
    | {
        id: number;
        stash_dir: string;
        entry_json: string;
        search_text: string;
        entry_type: string;
        item_ref: string | null;
      }
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
    const entry = JSON.parse(row.entry_json) as IndexDocument;
    entry.name = opts.newName;
    if (typeof entry.filename === "string") entry.filename = path.basename(opts.newFilePath);
    if (opts.newDerivedFrom !== undefined) entry.derivedFrom = opts.newDerivedFrom;
    entryJson = JSON.stringify(entry);
    searchText = buildSearchText(entry);
  } catch {
    /* corrupt entry_json — key/path-only re-key */
  }

  // Chunk-5 flip F1: keep `item_ref`/`concept_id` consistent with the rename so
  // a post-mv new-grammar lookup finds the moved row by its NEW conceptId. The
  // bundle prefix is carried over from the existing item_ref unchanged (mv never
  // crosses bundles); a NULL item_ref (write-back row) stays NULL and is healed
  // on the next full index, exactly like the legacy columns before the flip.
  let newItemRef: string | null = null;
  let newConceptId: string | null = null;
  if (row.item_ref) {
    const boundary = row.item_ref.indexOf("//");
    const bundle = boundary >= 0 ? row.item_ref.slice(0, boundary) : undefined;
    newConceptId = legacyConceptId(row.entry_type, opts.newName);
    newItemRef = bundle !== undefined ? `${bundle}//${newConceptId}` : newConceptId;
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
    if (newItemRef !== null) {
      db.prepare("UPDATE entries SET item_ref = ?, concept_id = ? WHERE id = ?").run(newItemRef, newConceptId, row.id);
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

/**
 * Delete every entry (and its child rows) under a source's stash root.
 *
 * Chunk-5 flip F1: this keys on `stash_dir` — the physical source-root path,
 * which is orthogonal to the ref grammar and identifies rows regardless of
 * whether their `item_ref` is populated or NULL. No item_ref predicate is
 * needed (or correct) here; both grammars' rows are removed by location.
 */
export function deleteEntriesByStashDir(db: Database, stashDir: string): void {
  deleteEntriesWhere(db, "stash_dir", stashDir);
}

/**
 * Diff-persist orphan delete (Chunk-5 flip F4a M-core-2): remove every entry
 * (and its child rows, via {@link deleteRelatedRows}) under `dirPath` whose
 * `entry_key` is NOT in `keepKeys` — the rows for files that vanished from a
 * rescanned directory.
 *
 * Replaces the old per-dir `deleteEntriesByDir` + full re-insert: the caller
 * upserts the current file set FIRST (ON CONFLICT preserving `entries.id`, so
 * embeddings / utility / usage stay attached to unchanged rows), then calls this
 * to prune only the DEPARTED rows. The net row-state of `dir_path` is identical
 * to delete-then-reinsert; the win is that unchanged rows keep their id.
 *
 * Keyed on `entry_key` rather than `item_ref`: the diff must be exact regardless
 * of whether a row's `item_ref` is populated (legacy rows and NULL-provenance
 * write-back rows exist), and `entry_key` is never NULL and mirrors the upsert
 * conflict target precisely. Dir-scoped (not stash-dir-scoped) so it is safe
 * under the per-dir incremental freshness gate — untouched (skipped) sibling
 * directories are never in scope.
 */
export function deleteEntriesByDirExceptKeys(db: Database, dirPath: string, keepKeys: ReadonlySet<string>): void {
  db.transaction(() => {
    const rows = db.prepare("SELECT id, entry_key FROM entries WHERE dir_path = ?").all(dirPath) as Array<{
      id: number;
      entry_key: string;
    }>;
    const doomed = rows.filter((r) => !keepKeys.has(r.entry_key));
    if (doomed.length === 0) return;
    deleteRelatedRows(db, doomed);
    for (let i = 0; i < doomed.length; i += SQLITE_CHUNK_SIZE) {
      const chunk = doomed.slice(i, i + SQLITE_CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(",");
      db.prepare(`DELETE FROM entries WHERE id IN (${placeholders})`).run(...chunk.map((r) => r.id));
    }
  })();
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

/**
 * Resolve a single `entries.id` from a ref string, accepting BOTH the new
 * `[bundle//]conceptId` grammar and the pre-0.9.0 `[origin//]type:name` grammar
 * at the input edge (Chunk-5 flip F1, ref-grammar decision D-R1/D-R4).
 *
 * A new-grammar ref keys on `item_ref` (the canonical stored spelling) —
 * preferred but never sole: rows whose `item_ref` is still NULL (write-back
 * fast-path, healed on next full index) stay findable via the legacy
 * `entry_key` predicate reached by reverse-translating the conceptId. A legacy
 * ref keeps the EXACT pre-flip `entry_key`-suffix behavior (the green suite is
 * the proof). The optional `stashDir` scopes the match to one source root, as
 * before.
 */
export function findEntryIdByRef(db: Database, ref: string, stashDir?: string): number | undefined {
  if (classifyRefGrammar(ref) === "bundle") {
    return findEntryIdByBundleRef(db, ref, stashDir);
  }
  // F5: delete — legacy `[origin//]type:name` grammar path (exact pre-flip
  // behavior; the whole existing suite exercises this branch).
  return findEntryIdByLegacyRef(db, ref, stashDir);
}

/** `name` plus its `.md`-toggled sibling — the markdown ext-keep/strip ambiguity. */
function withMdVariants(name: string): string[] {
  return name.endsWith(".md") ? [name, name.slice(0, -3)] : [name, `${name}.md`];
}

/**
 * New-grammar (`[bundle//]conceptId`) id lookup: match `item_ref` first (exact
 * when bundle-qualified, `//conceptId`-suffix when short), then fall back to the
 * legacy `entry_key` predicate for NULL-`item_ref` rows.
 */
function findEntryIdByBundleRef(db: Database, ref: string, stashDir?: string): number | undefined {
  const parsed = parseBundleRef(ref);
  const conceptVariants = withMdVariants(parsed.conceptId);

  // Prefer item_ref.
  for (const conceptId of conceptVariants) {
    const id = matchIdByItemRef(db, parsed.bundle, conceptId, stashDir);
    if (id !== undefined) return id;
  }
  // F5: delete — legacy fallback so NULL-item_ref rows stay findable by new refs.
  for (const conceptId of conceptVariants) {
    const legacy = conceptIdToLegacy(conceptId);
    if (!legacy) continue;
    const id = matchIdByLegacyEntryKey(db, legacy.type, legacy.name, stashDir);
    if (id !== undefined) return id;
  }
  return undefined;
}

/**
 * Match a row `id` by `item_ref`: exact `bundle//conceptId` when `bundle` is
 * known, else the `//conceptId` SUFFIX (short ref — any bundle). The suffix
 * uses `substr(...) = ...` (never LIKE) so `_`/`%` in a conceptId are literal,
 * and includes the `//` boundary so a segment split never false-matches.
 */
function matchIdByItemRef(
  db: Database,
  bundle: string | undefined,
  conceptId: string,
  stashDir?: string,
): number | undefined {
  const scope = stashDir ? "AND stash_dir = ?" : "";
  if (bundle !== undefined) {
    const itemRef = `${bundle}//${conceptId}`;
    const row = db
      .prepare(`SELECT id FROM entries WHERE item_ref = ? ${scope} LIMIT 1`)
      .get(itemRef, ...(stashDir ? [stashDir] : [])) as { id: number } | undefined;
    return row?.id;
  }
  const suffix = `//${conceptId}`;
  const row = db
    .prepare(
      `SELECT id FROM entries
       WHERE item_ref IS NOT NULL
         AND substr(item_ref, length(item_ref) - length(?) + 1) = ?
         ${scope}
       LIMIT 1`,
    )
    .get(suffix, suffix, ...(stashDir ? [stashDir] : [])) as { id: number } | undefined;
  return row?.id;
}

/** Legacy `entry_key`-suffix (`type:name`) id lookup — the pre-flip predicate. */
function matchIdByLegacyEntryKey(db: Database, type: string, name: string, stashDir?: string): number | undefined {
  const suffix = `${type}:${name}`;
  const row = db
    .prepare(
      `SELECT id FROM entries
       WHERE entry_type = ?
         AND substr(entry_key, length(entry_key) - length(?) + 1) = ?
         ${stashDir ? "AND stash_dir = ?" : ""}
       LIMIT 1`,
    )
    .get(type, suffix, suffix, ...(stashDir ? [stashDir] : [])) as { id: number } | undefined;
  return row?.id;
}

/**
 * F5: delete — legacy `[origin//]type:name` id lookup, extracted verbatim from
 * the pre-flip `findEntryIdByRef` so the old grammar keeps byte-identical
 * behavior during the additive F1 window.
 */
function findEntryIdByLegacyRef(db: Database, ref: string, stashDir?: string): number | undefined {
  const parsed = parseAssetRef(ref);
  for (const name of withMdVariants(parsed.name)) {
    const id = matchIdByLegacyEntryKey(db, parsed.type, name, stashDir);
    if (id !== undefined) return id;
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
): { filePath: string; stashDir: string; entry: IndexDocument } | undefined {
  const row = db.prepare("SELECT file_path, stash_dir, entry_json FROM entries WHERE id = ?").get(id) as
    | { file_path: string; stash_dir: string; entry_json: string }
    | undefined;
  if (!row) return undefined;
  // Guard against corrupt JSON
  let entry: IndexDocument;
  try {
    entry = JSON.parse(row.entry_json) as IndexDocument;
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
 * Look up an entry `id` by ref, dual-keyed on `item_ref` (Chunk-5 flip F1).
 *
 * Two shapes:
 *   - `getEntryByRef(db, ref)`         — a ref string in EITHER grammar.
 *   - `getEntryByRef(db, type, name)`  — a legacy `type`/`name` pair (kept for
 *                                        the pre-flip call convention).
 *
 * Both route through {@link findEntryIdByRef}, so a `bundle//conceptId` ref
 * resolves against `item_ref` and a legacy `type:name` ref against `entry_key`,
 * with the same NULL-`item_ref` legacy fallback. Returns `{ id }` or `null`.
 */
export function getEntryByRef(db: Database, ref: string): { id: number } | null;
export function getEntryByRef(db: Database, type: string, name: string): { id: number } | null;
export function getEntryByRef(db: Database, refOrType: string, name?: string): { id: number } | null {
  // F5: delete — the (type, name) overload; new callers pass a single ref.
  const ref = name === undefined ? refOrType : makeAssetRef(refOrType, name);
  const id = findEntryIdByRef(db, ref);
  return id === undefined ? null : { id };
}

/**
 * The fully-qualified `item_ref` (`<bundle>//<conceptId>`, the durable stored
 * spelling — spec §11.1 D-R3) for an entry `id`, or `null` when the row is gone
 * or its `item_ref` is still NULL (a write-back straggler, healed on the next
 * full index). The usage-event / salience / feedback writers derive the durable
 * key from this so a stored key is always the resolved entry's canonical ref,
 * never raw input (D-R3: durable keys are never derived from input).
 */
export function getItemRefById(db: Database, id: number): string | null {
  const row = db.prepare("SELECT item_ref FROM entries WHERE id = ?").get(id) as
    | { item_ref: string | null }
    | undefined;
  return row?.item_ref ?? null;
}

/**
 * Source mapping used to preserve qualified usage-event identity while relinking.
 *
 * Chunk-5 flip F4c: `usage_events.entry_ref` is now written in the fully-qualified
 * `bundle//conceptId` spelling (derived from the resolved entry's `item_ref`),
 * but historical rows carry the legacy `[origin//]type:name` spelling until the
 * §11.4 re-key migration ({@link rekeyUsageEventsToItemRef}) runs. This resolver
 * accepts BOTH: a new-grammar ref keys directly on the globally-unique `item_ref`
 * (no source scoping needed — the bundle is in the ref); the legacy arm keeps the
 * pre-flip origin→root scoping. `// F5: delete` the legacy arm.
 */
function resolveUsageEventEntryId(db: Database, ref: string, options: RelinkUsageEventsOptions): number | undefined {
  if (classifyRefGrammar(ref) === "bundle") {
    // Fully-qualified `bundle//conceptId` — item_ref is globally unique, so a
    // direct match needs no origin→root scope. A short conceptId (no bundle)
    // falls back to the default-stash scope, mirroring the legacy bare-ref arm.
    return findEntryIdByRef(db, ref, parseBundleRef(ref).bundle ? undefined : options.defaultStashDir);
  }
  // F5: delete — legacy `[origin//]type:name` resolution with origin→root scoping.
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
 * §11.4 one-time ref-migration of `usage_events.entry_ref` from the legacy
 * `[origin//]type:name` namespace onto the fully-qualified `bundle//conceptId`
 * `item_ref` spelling (Chunk-5 flip F4c). The mapping is computed by JOINING
 * AGAINST THE LAST-GOOD INDEX — each legacy ref is resolved to a live entry
 * (origin→root scoping via {@link resolveUsageEventEntryId}) and re-keyed to that
 * entry's `item_ref` — never by reconstructing paths from TYPE_DIRS heuristics
 * (§11.4). Runs at index FINALIZE, where `entries` is authoritative.
 *
 * Orphan taxonomy (§11.4):
 *   - EXPECTED ORPHANS — legacy refs that resolve to no live item (deleted-asset
 *     history; append-only usage rows outlive their asset). These are RECORDED in
 *     the `legacy_state` quarantine archive (auditable, purgeable, counts
 *     reported) and their usage_events rows are KEPT IN PLACE, legacy-spelled —
 *     never deleted; the dual-arm readers still see them. A literal zero-orphan
 *     requirement is unsatisfiable, so orphans MUST NOT abort the migration.
 *   - Rows under multiple legacy spellings of one logical ref (bare / origin// /
 *     .derived) are carried AS-IS under the new key — event rows need no merge.
 *
 * Idempotent: new-grammar rows (`classifyRefGrammar === "bundle"`) are skipped, so
 * a second run is a no-op; the `legacy_state` archive is refreshed in place.
 * Returns `{ rekeyed, quarantined }` distinct-ref counts for logging/tests.
 */
export function rekeyUsageEventsToItemRef(
  db: Database,
  options: RelinkUsageEventsOptions = {},
): { rekeyed: number; quarantined: number; deferred: number } {
  const result = { rekeyed: 0, quarantined: 0, deferred: 0 };
  bestEffort(() => {
    ensureLegacyStateTable(db);
    const rows = db.prepare("SELECT DISTINCT entry_ref AS ref FROM usage_events WHERE entry_ref IS NOT NULL").all() as {
      ref: string;
    }[];
    const legacyRefs = rows.map((r) => r.ref).filter((ref) => classifyRefGrammar(ref) === "legacy");
    if (legacyRefs.length === 0) return;

    const update = db.prepare("UPDATE usage_events SET entry_ref = ?, entry_id = ? WHERE entry_ref = ?");
    const countRows = db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE entry_ref = ?");
    const quarantine = db.prepare(
      `INSERT OR REPLACE INTO legacy_state (surface, old_ref, row_count, reason, quarantined_at)
       VALUES ('usage_events', ?, ?, 'orphan', datetime('now'))`,
    );
    const tx = db.transaction(() => {
      for (const oldRef of legacyRefs) {
        const resolution = classifyLegacyRefForRekey(db, oldRef, options);
        if (resolution.kind === "rekey") {
          update.run(resolution.itemRef, resolution.entryId, oldRef);
          result.rekeyed += 1;
        } else if (resolution.kind === "orphan") {
          // Expected orphan — no live item. Keep the row, archive for audit.
          const n = (countRows.get(oldRef) as { n: number }).n;
          quarantine.run(oldRef, n);
          result.quarantined += 1;
        } else {
          result.deferred += 1;
        }
      }
    });
    tx();
    if (result.quarantined > 0 || result.deferred > 0) {
      warn(
        `[akm] §11.4 usage-event re-key: ${result.rekeyed} ref(s) re-keyed to item_ref, ` +
          `${result.quarantined} orphan ref(s) quarantined in legacy_state (kept, not deleted), ` +
          `${result.deferred} named-origin ref(s) deferred to the Chunk-8 source→bundle identity.`,
      );
    }
  }, "usage_events / legacy_state may not exist yet during the §11.4 re-key");
  return result;
}

/**
 * The §11.4 re-key resolution for one legacy `usage_events.entry_ref`. Faithful
 * to origin identity — a re-key must never COLLAPSE two origins of the same
 * conceptId onto one key (durable feedback/usage keeps each origin distinct):
 *
 *   - `"rekey"`   — the ref resolves to a live entry (scoped to the source its
 *                   origin names — the primary for a bare/`local`/`stash` ref, or
 *                   the source whose `registryId` equals the origin) that carries
 *                   an item_ref. The origin's bundle identity is preserved, so two
 *                   origins of one conceptId never collapse onto a single key.
 *   - `"orphan"`  — the same scope resolves to no live item (deleted / deduped
 *                   away): an EXPECTED §11.4 orphan → quarantine, keep legacy.
 *   - `"defer"`   — an origin naming no configured source (a removed source) that
 *                   is not the primary sentinel — its source→bundle identity is a
 *                   Chunk-8 / D-R5 concern, so leave legacy-spelled (dual-arm
 *                   readers still see it; F5 forces it). Also the NULL-item_ref
 *                   write-back straggler (heals on the next full index).
 *
 * F5: delete — the whole legacy arm goes once the old grammar is removed.
 */
type RekeyResolution = { kind: "rekey"; entryId: number; itemRef: string } | { kind: "orphan" } | { kind: "defer" };

function classifyLegacyRefForRekey(db: Database, ref: string, options: RelinkUsageEventsOptions): RekeyResolution {
  let parsed: AssetRef;
  try {
    parsed = parseAssetRef(ref);
  } catch {
    return { kind: "defer" }; // unparseable — leave untouched
  }
  // Bare ref, or the `local`/`stash` primary sentinel with no matching named
  // source → resolve against the workspace primary (defaultStashDir).
  const named = parsed.origin !== undefined ? options.sources?.find((s) => s.registryId === parsed.origin) : undefined;
  if (
    parsed.origin === undefined ||
    (named === undefined && (parsed.origin === "local" || parsed.origin === "stash"))
  ) {
    const id = options.defaultStashDir ? findEntryIdByRef(db, ref, options.defaultStashDir) : undefined;
    return resolveEntryToItemRef(db, id, /* orphanWhenMissing */ options.defaultStashDir !== undefined);
  }
  // Origin names a configured source (registryId, incl. a filesystem source's
  // name) → resolve strictly within that source so the bundle stays faithful.
  if (named === undefined) return { kind: "defer" }; // removed source — Chunk-8 identity
  const id = findEntryIdByRef(db, ref, named.path);
  return resolveEntryToItemRef(db, id, /* orphanWhenMissing */ true);
}

/** Turn a resolved entry id into a re-key/orphan/defer decision by its item_ref. */
function resolveEntryToItemRef(db: Database, id: number | undefined, orphanWhenMissing: boolean): RekeyResolution {
  if (id === undefined) return orphanWhenMissing ? { kind: "orphan" } : { kind: "defer" };
  const itemRef = getItemRefById(db, id);
  return itemRef !== null ? { kind: "rekey", entryId: id, itemRef } : { kind: "defer" };
}

/**
 * Create the §11.4 orphan-quarantine archive if absent. `legacy_state` holds one
 * row per (surface, unmappable legacy ref): auditable and purgeable, it never
 * holds the live event rows themselves (those stay in `usage_events`).
 */
function ensureLegacyStateTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS legacy_state (
      surface        TEXT NOT NULL,
      old_ref        TEXT NOT NULL,
      row_count      INTEGER NOT NULL DEFAULT 0,
      reason         TEXT NOT NULL,
      quarantined_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (surface, old_ref)
    );
  `);
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
