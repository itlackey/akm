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

import fs from "node:fs";
import path from "node:path";
import { parseBundleRef } from "../../core/asset/asset-ref";
import { conceptIdFromTypeName } from "../../core/asset/resolve-ref";
import { bestEffort } from "../../core/best-effort";
import { getStateDbPath, withStateDb } from "../../core/state-db";
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

// The ON CONFLICT DO UPDATE column assignments — factored out so the two
// conflict targets below stay byte-identical. `entry_key` is deliberately NOT
// updated (it is an identity column; renames go through `rekeyEntryInPlace`).
// `content_hash` COALESCEs so a NULL passed by the LLM-enhance re-upsert cannot
// wipe a previously-persisted hash.
const UPSERT_SET_CLAUSE = `SET
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
        content_hash = COALESCE(excluded.content_hash, content_hash)`;

/**
 * Whether `entries.item_ref` currently carries its UNIQUE index (the v19
 * `idx_entries_item_ref`, built by `ensureUniqueItemRefIndex`). On a
 * partially-migrated DB with a duplicate non-NULL item_ref, that build falls
 * back to a NON-unique index — and `ON CONFLICT(item_ref)` is only a legal
 * conflict target when a UNIQUE index/constraint backs the column (otherwise
 * the upsert throws AT PREPARE TIME). This gate lets {@link getUpsertStmts}
 * degrade to the always-present `entry_key` target until a rebuild restores
 * uniqueness. Best-effort: any probe failure treats item_ref as non-unique.
 */
function itemRefHasUniqueIndex(db: Database): boolean {
  try {
    const indexes = db.prepare("PRAGMA index_list(entries)").all() as Array<{ name: string; unique: number | bigint }>;
    return indexes.some((idx) => idx.name === "idx_entries_item_ref" && Number(idx.unique) === 1);
  } catch {
    return false;
  }
}

function getUpsertStmts(db: Database): UpsertStmts {
  const existing = upsertStmtsByDb.get(db);
  if (existing) return existing;
  // Conflict target (spec §3.3): the UNIQUE `item_ref` is THE intended clean
  // dedupe key, so it is the PRIMARY target — a row carrying its durable
  // identity dedupes on `item_ref`. `entry_key` is retained as a SECOND,
  // NULL-safe fallback target because a legacy write path can still upsert an
  // EXISTING row with a NULL `item_ref` (SQLite treats NULLs as distinct in a
  // UNIQUE index, so an item_ref-only target would miss the row, fall through
  // to a plain INSERT, and ABORT on the `entry_key NOT NULL UNIQUE` constraint).
  // Concretely, the out-of-scope LLM metadata-enhance re-upsert (indexer.ts
  // `enhanceDirsWithLlm`) re-writes already-indexed rows without provenance →
  // NULL item_ref; the `entry_key` arm keeps that re-upsert an UPDATE, not a
  // crash. Both arms run the IDENTICAL assignment block, so the outcome is the
  // same regardless of which constraint matches. The `entry_key` fallback is
  // deletable once every write path sets `item_ref`.
  //
  // When item_ref lacks its UNIQUE index (the ensureUniqueItemRefIndex fallback
  // on a partially-migrated DB), `ON CONFLICT(item_ref)` is not a legal target
  // and would fail at prepare time — so we degrade to the entry_key-only upsert
  // (behaviour-identical to the pre-repoint key) until the next rebuild restores
  // uniqueness; without this the very rebuild meant to heal the duplicate could
  // not run.
  const conflictClause = itemRefHasUniqueIndex(db)
    ? `ON CONFLICT(item_ref) DO UPDATE ${UPSERT_SET_CLAUSE}
      ON CONFLICT(entry_key) DO UPDATE ${UPSERT_SET_CLAUSE}`
    : `ON CONFLICT(entry_key) DO UPDATE ${UPSERT_SET_CLAUSE}`;
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
      ${conflictClause}
      RETURNING id
    `),
    markDirty: db.prepare("INSERT OR IGNORE INTO entries_fts_dirty (entry_id) VALUES (?)"),
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
export function getDerivedForParent(db: Database, parentRef: string, stashDir?: string): DbIndexedEntry | null {
  if (!parentRef) return null;
  try {
    const sourceScope = stashDir ? "AND stash_dir = ?" : "";
    const row = db
      .prepare(
        `SELECT ${ENTRY_COLUMNS}
         FROM entries
         WHERE derived_from = ?
         ${sourceScope}
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(parentRef, ...(stashDir ? [stashDir] : [])) as EntryRow | undefined;
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
  // Chunk-8: the row is located by its legacy `entry_key`; the caller (mv)
  // always has it and it is the UNIQUE identity column until the re-key.
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
    newConceptId = conceptIdFromTypeName(row.entry_type, opts.newName);
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
    db.prepare("INSERT OR IGNORE INTO entries_fts_dirty (entry_id) VALUES (?)").run(row.id);
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
 * state.db (both the bare `type:name` and the origin-qualified `origin//type:name`
 * spellings). DETACHED orphan events (entry_id NULL) already sitting AT the new
 * ref are evicted first so the moved asset never adopts a deleted stranger's
 * history (live-asset-wins). Best-effort + guarded on state.db's existence; a
 * legacy state.db predating usage_events is tolerated.
 */
/** The conceptId for a legacy `type:name` ref (`memory:foo` → `memories/foo`), or undefined. */
function conceptIdFromTypeNameRef(ref: string): string | undefined {
  const colon = ref.indexOf(":");
  if (colon <= 0) return undefined;
  return conceptIdFromTypeName(ref.slice(0, colon), ref.slice(colon + 1));
}

function rewriteUsageEventRefForMove(opts: RekeyEntryOptions): void {
  if (!fs.existsSync(getStateDbPath())) return;
  // Post-cutover, `usage_events.entry_ref` is the fully-qualified item_ref
  // (`<bundle>//<conceptId>`); the pre-flip legacy `type:name` spellings survive
  // only on rows written before the cutover. Rewrite BOTH: `opts.oldRef`/`newRef`
  // are the legacy `type:name` forms, so the conceptId siblings are derived here.
  const oldConcept = conceptIdFromTypeNameRef(opts.oldRef);
  const newConcept = conceptIdFromTypeNameRef(opts.newRef);
  const rename = (stateDb: Database, oldR: string, newR: string): void => {
    stateDb.prepare("DELETE FROM usage_events WHERE entry_id IS NULL AND entry_ref = ?").run(newR);
    stateDb.prepare("UPDATE usage_events SET entry_ref = ? WHERE entry_ref = ?").run(newR, oldR);
  };
  try {
    withStateDb((stateDb) => {
      stateDb.transaction(() => {
        if (opts.sourceName) {
          const origins = new Set([opts.sourceName]);
          if (opts.sourceName === "stash" && opts.includeLegacyBare) origins.add("local");
          for (const origin of origins) {
            rename(stateDb, `${origin}//${opts.oldRef}`, `${origin}//${opts.newRef}`);
            // The item_ref spelling (`<bundle>//<conceptId>`) — the durable
            // post-cutover key. Origins double as the bundle id for the stash.
            if (oldConcept !== undefined && newConcept !== undefined)
              rename(stateDb, `${origin}//${oldConcept}`, `${origin}//${newConcept}`);
          }
        }
        if (opts.includeLegacyBare || !opts.sourceName) {
          rename(stateDb, opts.oldRef, opts.newRef);
          if (oldConcept !== undefined && newConcept !== undefined) rename(stateDb, oldConcept, newConcept);
        }
      })();
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missingLegacyUsageSchema =
      /no such table:\s*(?:main\.)?usage_events\b/i.test(message) ||
      /no such column:\s*(?:usage_events\.)?(?:entry_id|entry_ref)\b/i.test(message) ||
      /table\s+usage_events\s+has no column named\s+(?:entry_id|entry_ref)\b/i.test(message);
    if (!missingLegacyUsageSchema) throw error;
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
  }, "usage_events table may be missing on legacy state.db — treat as zero counts");
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
  }

  // Clean up usage events for the deleted entries. Chunk-8 WI-8.3: usage_events
  // lives in state.db now, so this is a SEPARATE cross-DB delete (guarded on
  // state.db's existence; only runs when there ARE deletions, so the extra open
  // is bounded). Live-asset-wins collision eviction (the moved asset must not
  // adopt a deleted stranger's id-linked history) depends on this delete.
  if (fs.existsSync(getStateDbPath())) {
    bestEffort(() => {
      withStateDb((stateDb) => {
        for (let i = 0; i < numericIds.length; i += SQLITE_CHUNK_SIZE) {
          const chunk = numericIds.slice(i, i + SQLITE_CHUNK_SIZE);
          const placeholders = chunk.map(() => "?").join(",");
          stateDb.prepare(`DELETE FROM usage_events WHERE entry_id IN (${placeholders})`).run(...chunk);
        }
      });
    }, "delete usage_events (state.db) for entries");
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
 * Resolve a single `entries.id` from a new-grammar `[bundle//]conceptId` ref,
 * keying on the canonical stored `item_ref` (ref-grammar decision D-R1/D-R4).
 * All refs are the new grammar post-Chunk-8. The optional `stashDir` scopes the
 * match to one source root.
 */
export function findEntryIdByRef(db: Database, ref: string, stashDir?: string): number | undefined {
  return findEntryIdByBundleRef(db, ref, stashDir);
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

  // item_ref is the canonical stored spelling post-flip.
  for (const conceptId of conceptVariants) {
    const id = matchIdByItemRef(db, parsed.bundle, conceptId, stashDir);
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
 * arm is single-row under the UNIQUE `item_ref` index; `ORDER BY id ASC` there
 * keeps it deterministic on a partially-migrated DB whose fallback index is
 * non-unique.
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
      .prepare(`SELECT id FROM entries WHERE item_ref = ? ${scope} ORDER BY id ASC LIMIT 1`)
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
       ORDER BY id ASC
       LIMIT 1`,
    )
    .get(suffix, suffix, ...(stashDir ? [stashDir] : [])) as { id: number } | undefined;
  return row?.id;
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
): { filePath: string; stashDir: string; entry: IndexDocument; itemRef?: string | null } | undefined {
  const row = db.prepare("SELECT file_path, stash_dir, entry_json, item_ref FROM entries WHERE id = ?").get(id) as
    | { file_path: string; stash_dir: string; entry_json: string; item_ref: string | null }
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
  return { filePath: row.file_path, stashDir: row.stash_dir, entry, itemRef: row.item_ref };
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
    hash ^= content[i]!;
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
 * Resolve a `usage_events.entry_ref` to its live `entries.id`. Post-Chunk-8 every
 * `entry_ref` is the fully-qualified `bundle//conceptId` `item_ref` spelling
 * (the one-time state.db cutover re-keyed the historical legacy rows), so this
 * keys directly on the globally-unique `item_ref` — no origin→root scoping. A
 * short conceptId (no bundle) falls back to the default-stash scope.
 */
function resolveUsageEventEntryId(db: Database, ref: string, options: RelinkUsageEventsOptions): number | undefined {
  return findEntryIdByRef(db, ref, parseBundleRef(ref).bundle ? undefined : options.defaultStashDir);
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
export function relinkUsageEvents(indexDb: Database, stateDb: Database, options: RelinkUsageEventsOptions = {}): void {
  bestEffort(() => {
    // Step 1: null out stale entry_ids (entry was deleted, re-keyed, etc).
    // Leaving them in place would let `recomputeUtilityScores` aggregate by an
    // entry_id that no longer exists in `entries`, then trip the FK constraint
    // on the utility_scores INSERT and roll back the entire finalize
    // transaction. Nulled rows can be re-resolved by step 2 below; events whose
    // entry is permanently gone simply stay null and age out via retention.
    const linkedIds = (
      stateDb.prepare("SELECT DISTINCT entry_id AS id FROM usage_events WHERE entry_id IS NOT NULL").all() as Array<{
        id: number;
      }>
    ).map((r) => r.id);
    const entryExists = indexDb.prepare("SELECT 1 FROM entries WHERE id = ?");
    const staleIds = linkedIds.filter((id) => entryExists.get(id) == null);
    if (staleIds.length > 0) {
      const nullOut = stateDb.prepare("UPDATE usage_events SET entry_id = NULL WHERE entry_id = ?");
      const nullTx = stateDb.transaction(() => {
        for (const id of staleIds) nullOut.run(id);
      });
      nullTx();
    }

    // Step 2: re-resolve each distinct ref inside its source boundary. Qualified
    // refs require an origin→root mapping; bare legacy refs require the explicit
    // historical/default root. This keeps duplicate refs from adopting whichever
    // entries row SQLite happens to return first while retaining indexed lookups.
    const refs = stateDb
      .prepare("SELECT DISTINCT entry_ref AS ref FROM usage_events WHERE entry_id IS NULL AND entry_ref IS NOT NULL")
      .all() as { ref: string }[];

    const update = stateDb.prepare("UPDATE usage_events SET entry_id = ? WHERE entry_ref = ? AND entry_id IS NULL");
    const relinkTx = stateDb.transaction(() => {
      for (const { ref } of refs) {
        let id: number | undefined;
        try {
          id = resolveUsageEventEntryId(indexDb, ref, options);
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
