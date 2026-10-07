// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * index.db schema, kept in the storage layer so schema evolution stays apart
 * from the CRUD/FTS/vector queries.
 *
 * `ensureSchema` runs on every writable open and brings an older layout up
 * to date in place: `CREATE ... IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN`
 * for columns added after a table first shipped, drops of retired derived
 * tables and columns, and one in-place rebuild of the (derived, cheap) FTS
 * table when its layout is older than this release's. It never drops
 * `entries`, `embeddings`, `utility_scores`, or `llm_enrichment_cache` to
 * cross a version boundary; the only from-scratch rebuild is the
 * SQLITE_CORRUPT path in `index-connection.ts`. A layout newer than this
 * release's is refused, naming the upgrade ({@link newerIndexLayoutError}).
 * The one exception is the LLM entity graph (`graph_meta`, `graph_files`,
 * `graph_file_*`), retired in 0.9.17-alpha.9: those tables are dropped
 * unconditionally below (index.db is a regenerable cache, and declared links
 * — `asset_links` — now back `akm show`'s `links` field, which replaced the
 * graph's `related` list).
 */

import { createRequire } from "node:module";
import path from "node:path";
import { ConfigError } from "../../core/errors";
import { warn } from "../../core/warn";
import { sha256Hex } from "../../runtime";
import type { Database } from "../database";
import {
  CANONICAL_ENTRY_SCHEMA_SQL,
  CANONICAL_INDEX_DB_VERSION,
  entriesFtsDdl,
  isContentlessFtsDdl,
  missingEntryColumns,
  readTableSql,
  retiredEntryColumns,
  supportsContentlessDelete,
  tableExists,
} from "./index-entry-schema";
import { rebuildFts } from "./index-fts-repository";
import { rebuildAllEntryLinks } from "./index-links-repository";
import { getMeta, setMeta } from "./index-meta-repository";

// ── Constants ───────────────────────────────────────────────────────────────

export const DB_VERSION = CANONICAL_INDEX_DB_VERSION;
/** `index_meta` key set when the writable opener migrated the layout; cleared once `akm index` VACUUMs. */
export const VACUUM_PENDING_META = "vacuumPending";

/** The layout that added declared links (`asset_links`, #935). */
const DECLARED_LINKS_LAYOUT = 26;

/**
 * The refusal for an index a newer akm wrote. Readers and the writable opener
 * both raise it: a newer layout may lack tables or columns this release reads
 * (layout 25 dropped `entries.search_text`), and writing it back at this
 * layout would undo the newer release's migration.
 */
export function newerIndexLayoutError(storedVersion: number, dbPath?: string): ConfigError {
  return new ConfigError(
    `Index database${dbPath ? ` at ${dbPath}` : ""} was written by a newer akm (layout ${storedVersion}; this akm ` +
      `understands ${DB_VERSION}). Upgrade akm to use this index.`,
    "INDEX_SCHEMA_INCOMPATIBLE",
    "Upgrade akm to a version that understands this index layout.",
  );
}

// ── Schema ──────────────────────────────────────────────────────────────────

/**
 * DDL for the `registry_index_cache` table. This table lives in index.db
 * (managed by this module), so its DDL belongs here next to the `ensureSchema`
 * that applies it — not in state-db.ts.
 *
 * Caches the result of resolving and fetching remote registry stash indexes so
 * `akm search` does not hit the network on every invocation.
 */
const REGISTRY_INDEX_CACHE_DDL = `
  CREATE TABLE IF NOT EXISTS registry_index_cache (
    registry_url  TEXT    PRIMARY KEY,
    fetched_at    TEXT    NOT NULL,
    etag          TEXT,
    last_modified TEXT,
    index_json    TEXT    NOT NULL DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS idx_registry_cache_fetched
    ON registry_index_cache(fetched_at);
`;

/**
 * An `entries` table missing a required column, or still carrying a retired
 * one, cannot be read or written by this release (the last such change was
 * v20→v21, which removed the transitional `entry_key`/`dir_path`/... columns
 * and made `item_ref` the key). Layouts 18–20 carried the current columns
 * beside the retired ones, so only the retired ones give them away.
 * Recreate only the tables keyed by `entries.id` — their ids are about to be
 * re-minted, so the rows would dangle anyway. The LLM enrichment cache
 * (keyed by ref) is kept. The LLM entity-graph tables are unconditionally
 * dropped elsewhere in this file regardless of this recreation (retired
 * 0.9.17-alpha.9), not kept. The next index run re-walks every source.
 */
function ensureEntriesLayout(db: Database): void {
  if (!tableExists(db, "entries")) return;
  const missing = missingEntryColumns(db);
  const retired = retiredEntryColumns(db);
  if (missing.length === 0 && retired.length === 0) return;
  const why =
    missing.length > 0
      ? `predates the ${missing.join(", ")} column${missing.length === 1 ? "" : "s"}`
      : `still has the retired ${retired.join(", ")} column${retired.length === 1 ? "" : "s"}`;
  warn(
    `Index database entries table ${why} — ` +
      "recreating the entries-keyed tables (entries, full-text, embeddings, utility scores); the " +
      "LLM enrichment cache is kept. The next index run re-walks every source.",
  );
  db.transaction(() => {
    for (const table of [
      "entries_fts",
      "entry_fragments",
      "asset_links",
      "embeddings",
      "utility_scores_scoped",
      "utility_scores",
      "index_dir_state",
      "entries",
    ]) {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    db.exec("DELETE FROM index_meta WHERE key IN ('builtAt', 'hasEmbeddings')");
  })();
}

/**
 * Drop the sqlite-vec mirror of `embeddings` (`entries_vec`, layout 24 and
 * earlier); vectors are searched from `embeddings` alone. Dropping a vec0
 * table needs its module, so an install without sqlite-vec leaves the table
 * in place, unread, and the next writable open that can load it drops it.
 */
function dropVecMirror(db: Database): void {
  if (!tableExists(db, "entries_vec")) return;
  try {
    createRequire(import.meta.url)("sqlite-vec").load(db);
    db.exec("DROP TABLE entries_vec");
  } catch {
    // sqlite-vec is not loadable here.
  }
}

/**
 * Layout 25 keeps a hash of each entry's embedding input (`embed_hash`)
 * instead of the text (`search_text`, layout 24 and earlier); the text is
 * derived from `document_json` when the entry is embedded. The hash is taken
 * from the stored text, so every vector stays valid until its entry's text
 * changes. One transaction: a crash leaves `search_text` for the next
 * writable open.
 */
function replaceSearchTextWithHash(db: Database): void {
  if (!tableHasColumn(db, "entries", "search_text")) return;
  db.transaction(() => {
    ensureColumn(db, "entries", "embed_hash", "TEXT");
    const page = db.prepare("SELECT id, search_text FROM entries WHERE id > ? ORDER BY id LIMIT 500");
    const update = db.prepare("UPDATE entries SET embed_hash = ? WHERE id = ?");
    let afterId = -1;
    for (;;) {
      const rows = page.all(afterId) as Array<{ id: number; search_text: string }>;
      if (rows.length === 0) break;
      afterId = rows[rows.length - 1]!.id;
      for (const row of rows) update.run(sha256Hex(row.search_text), row.id);
    }
    db.exec("ALTER TABLE entries DROP COLUMN search_text");
  })();
}

/**
 * Bring `entries_fts` to the contentless layout, rebuilding it from `entries`
 * when it is missing or still carries the content-bearing layout older
 * releases wrote (the one-time v23→v24 migration). One transaction: a crash
 * mid-rebuild leaves the old table in place and the next writable open
 * retries. A SQLite without `contentless_delete` keeps (or gets) the
 * content-bearing layout instead.
 */
function ensureFtsLayout(db: Database): void {
  const contentless = supportsContentlessDelete(db);
  const sql = readTableSql(db, "entries_fts");
  if (sql !== null && isContentlessFtsDdl(sql) === contentless) return;
  const entryCount = Number((db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n);
  if (entryCount > 0) {
    warn(
      `Rebuilding the full-text index for ${entryCount} entr${entryCount === 1 ? "y" : "ies"} ` +
        "(embeddings, utility scores, and the LLM enrichment cache are kept).",
    );
  }
  db.transaction(() => {
    db.exec("DROP TABLE IF EXISTS entries_fts");
    db.exec(entriesFtsDdl(contentless));
    rebuildFts(db);
  })();
}

/**
 * Layout 26 stores declared links (#935). Every relation an older layout
 * indexed already sits in `document_json`, so the links are derived from there
 * in place, with no file read. The exception is a workflow's step targets and
 * a task's target, which no earlier layout stored: the directories holding
 * workflows and tasks lose their incremental cursor, so the next `akm index`
 * re-reads those and nothing else. One transaction.
 */
function migrateToDeclaredLinks(db: Database): void {
  db.transaction(() => {
    rebuildAllEntryLinks(db);
    const rows = db
      .prepare("SELECT DISTINCT file_path FROM entries WHERE type IN ('workflow', 'task')")
      .all() as Array<{
      file_path: string;
    }>;
    const forget = db.prepare("DELETE FROM index_dir_state WHERE dir_path = ?");
    for (const dir of new Set(rows.map((row) => path.dirname(row.file_path)))) forget.run(dir);
  })();
}

function tableHasColumn(db: Database, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((existing) => existing.name === column);
}

/** `ALTER TABLE ... ADD COLUMN` for a column added after the table first shipped. Idempotent. */
function ensureColumn(db: Database, table: string, column: string, type: string): boolean {
  if (tableHasColumn(db, table, column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  return true;
}

export function ensureSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const storedVersion = Number(getMeta(db, "version") ?? 0);
  if (storedVersion > DB_VERSION) throw newerIndexLayoutError(storedVersion);

  ensureEntriesLayout(db);

  const hadFragmentSource = tableExists(db, "entry_fragments");
  db.exec(CANONICAL_ENTRY_SCHEMA_SQL);
  replaceSearchTextWithHash(db);

  // Retired derived tables: the workflow IR cache, the pre-v22 FTS dirty
  // queue, the #955 embedding salvage staging table (embeddings now carry
  // their model per row, so nothing is copied aside and reused), the
  // fragment FTS table search stopped reading (layout 24 and earlier), the
  // per-project scoped utility table (IR-7a: it shipped, but no code ever read
  // or wrote a row), and the lazy graph-extraction queue (extraction runs only
  // in improve).
  db.exec("DROP TABLE IF EXISTS workflow_documents");
  db.exec("DROP TABLE IF EXISTS entries_fts_dirty");
  db.exec("DROP TABLE IF EXISTS embedding_salvage");
  db.exec("DROP TABLE IF EXISTS entry_fragments_fts");
  db.exec("DROP TABLE IF EXISTS utility_scores_scoped");
  db.exec("DROP TABLE IF EXISTS graph_extraction_queue");

  // The LLM entity graph, retired in 0.9.17-alpha.9: declared links
  // (`asset_links`) now back `akm show`'s `links` field (which replaced the
  // graph's `related` list) and curate's support refs (#935), and the
  // navigation eval measured vector kNN beating the graph's `related` list
  // by 0.157 P@5. `graph_files` stands in for the whole set — all four
  // tables are only ever created and dropped together. Gated on it (rather
  // than the unconditional `DROP TABLE IF EXISTS` pattern used above) so
  // this reclaim runs once: after the first writable open drops these
  // tables, every later open finds `graph_files` already gone and skips the
  // no-op DROPs and the repeat VACUUM flag below. An older release's
  // `CREATE TABLE IF NOT EXISTS` still recreates them (empty) if it ever
  // opens this index again — a later open here would then drop them again.
  const hadGraphTables = tableExists(db, "graph_files");
  if (hadGraphTables) {
    db.exec("DROP TABLE IF EXISTS graph_meta");
    db.exec("DROP TABLE IF EXISTS graph_files");
    db.exec("DROP TABLE IF EXISTS graph_file_entities");
    db.exec("DROP TABLE IF EXISTS graph_file_relations");
  }

  // One float32 BLOB per entry, searched by an exact scan
  // (index-vec-repository.ts). `model` is the provider fingerprint the vector was generated under
  // (`deriveSemanticProviderFingerprint`); the embedding pass re-embeds only
  // rows whose model differs from the configured one. NULL means the row
  // predates model tracking and is trusted as the current model.
  db.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      id        INTEGER PRIMARY KEY,
      embedding BLOB NOT NULL,
      model     TEXT,
      FOREIGN KEY (id) REFERENCES entries(id)
    );
  `);
  if (ensureColumn(db, "embeddings", "model", "TEXT")) {
    // Rows written before model tracking were generated under the fingerprint
    // the last pass recorded; label them so a later model change re-embeds
    // them instead of trusting them forever.
    const fingerprint = getMeta(db, "embeddingFingerprint");
    if (fingerprint) db.prepare("UPDATE embeddings SET model = ? WHERE model IS NULL").run(fingerprint);
  }

  // Utility scores (aggregated per-entry utility metrics) — a regenerable
  // cache recomputed from state.db's usage_events on every index run.
  db.exec(`
    CREATE TABLE IF NOT EXISTS utility_scores (
      entry_id     INTEGER PRIMARY KEY,
      utility      REAL NOT NULL DEFAULT 0,
      show_count   INTEGER NOT NULL DEFAULT 0,
      search_count INTEGER NOT NULL DEFAULT 0,
      select_rate  REAL NOT NULL DEFAULT 0,
      last_used_at TEXT,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS index_dir_state (
      dir_path          TEXT PRIMARY KEY,
      file_set_hash     TEXT NOT NULL,
      file_mtime_max_ms REAL NOT NULL,
      reason            TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      row_count         INTEGER,
      index_variant     TEXT
    );
  `);
  // #900 (`row_count`) and the adapter variant were added after the table's
  // first release. Pre-existing rows keep NULL until their directory is next
  // drained.
  ensureColumn(db, "index_dir_state", "row_count", "INTEGER");
  ensureColumn(db, "index_dir_state", "index_variant", "TEXT");

  // LLM enrichment result cache, keyed by a stable asset_ref string (the
  // absolute file path of the memory-inference pass) plus the body hash the
  // result was produced for.
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_enrichment_cache (
      asset_ref     TEXT NOT NULL,
      cache_variant TEXT NOT NULL,
      body_hash     TEXT NOT NULL,
      result_json   TEXT NOT NULL,
      updated_at    INTEGER NOT NULL,
      PRIMARY KEY (asset_ref, cache_variant)
    );

     CREATE INDEX IF NOT EXISTS idx_llm_cache_updated
       ON llm_enrichment_cache(updated_at);
  `);
  // Metadata-enhance retired (RS-D, 0.9.17-alpha.9): its rows were the only
  // ones keyed by the default empty cache_variant (memory inference writes
  // `memory-inference-v2`), so this is safe to run unconditionally on every
  // writable open. The table
  // itself stays — memory inference still reads it.
  db.exec("DELETE FROM llm_enrichment_cache WHERE cache_variant = ''");

  // The graph-extraction cache variant is retired along with the tables
  // above; its rows would otherwise sit unread forever. Gated the same way,
  // on the same one-time flag, so a rerun does not re-scan the cache table
  // for rows that are already gone.
  if (hadGraphTables) {
    db.exec("DELETE FROM llm_enrichment_cache WHERE cache_variant LIKE 'graph-extraction:%'");
    // The drops and delete above freed real space (measured ~68MB on a
    // representative index): flag it the same way a version-gated layout
    // migration does, since this reclaim is unconditional-on-version but
    // still one-time-per-index (guarded by hadGraphTables above).
    setMeta(db, VACUUM_PENDING_META, "1");
  }

  dropVecMirror(db);
  // Meta keys only the sqlite-vec mirror read.
  db.exec("DELETE FROM index_meta WHERE key IN ('embeddingDim', 'vecFastPathReady')");

  db.exec(REGISTRY_INDEX_CACHE_DDL);

  ensureFtsLayout(db);

  // An index that had no fragment source table (v22 and earlier) has no safe
  // Markdown for `akm show` to resolve fragment selectors from until each
  // directory is drained again. Clearing the per-directory cursor makes the
  // next run re-read every source; entry ids, embeddings and utility rows
  // stay put.
  if (!hadFragmentSource && tableExists(db, "entries")) {
    db.exec("DELETE FROM index_dir_state");
  }

  if (storedVersion > 0 && storedVersion < DECLARED_LINKS_LAYOUT && tableExists(db, "entries")) {
    migrateToDeclaredLinks(db);
  }

  // Migrating an existing layout drops tables and columns; the next `akm index`
  // VACUUMs the pages they leave free (`vacuumIndexDb`, indexer.ts), since a
  // writable open may run inside a caller's transaction, where VACUUM cannot.
  if (storedVersion > 0 && storedVersion < DB_VERSION) setMeta(db, VACUUM_PENDING_META, "1");
  setMeta(db, "version", String(DB_VERSION));
}
