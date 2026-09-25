// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * index.db schema, kept in the storage layer so schema evolution stays apart
 * from the CRUD/FTS/vector queries.
 *
 * `ensureSchema` runs on every writable open. It is additive: `CREATE ... IF
 * NOT EXISTS`, `ALTER TABLE ... ADD COLUMN` for columns added after a table
 * first shipped, and one in-place rebuild of the (derived, cheap) FTS tables
 * when their layout is older than this release's. It never drops `entries`,
 * `embeddings`, `utility_scores*`, `graph_*`, or `llm_enrichment_cache` to
 * cross a version boundary; the only from-scratch rebuild is the
 * SQLITE_CORRUPT path in `index-connection.ts`.
 */

import { ConfigError } from "../../core/errors";
import { warn, warnOnce } from "../../core/warn";
import type { Database } from "../database";
import {
  CANONICAL_ENTRY_SCHEMA_SQL,
  CANONICAL_INDEX_DB_VERSION,
  entriesFtsDdl,
  fragmentsFtsDdl,
  isContentlessFtsDdl,
  missingEntryColumns,
  readTableSql,
  supportsContentlessDelete,
  tableExists,
} from "./index-entry-schema";
import { rebuildFts } from "./index-fts-repository";
import { getMeta, setMeta } from "./index-meta-repository";
import { ensureVecTableWidth, isVecAvailable } from "./index-vec-repository";

// ── Constants ───────────────────────────────────────────────────────────────

export const DB_VERSION = CANONICAL_INDEX_DB_VERSION;
export const EMBEDDING_DIM = 384;
// #624-P1: graph_files is keyed to (stash_root, file_path, body_hash).
export const GRAPH_SCHEMA_VERSION = 4;

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
 * Create the graph-extraction tables (`graph_meta`/`graph_files`/`graph_file_entities`/
 * `graph_file_relations`/`graph_extraction_queue`).
 *
 * graph_files is self-keyed on (stash_root, file_path, body_hash) and is not
 * tied to entries.id (#624-P1): re-upserting an entries row never disturbs the
 * extracted graph, and a content change yields a distinct key. A UNIQUE index
 * on (stash_root, file_path) still enforces one graph_files row per path.
 */
function ensureGraphTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_meta (
      stash_root          TEXT PRIMARY KEY,
      schema_version      INTEGER NOT NULL,
      generated_at        TEXT NOT NULL,
      considered_files    INTEGER NOT NULL DEFAULT 0,
      extracted_files     INTEGER NOT NULL DEFAULT 0,
      entity_count        INTEGER NOT NULL DEFAULT 0,
      relation_count      INTEGER NOT NULL DEFAULT 0,
      extraction_coverage REAL NOT NULL DEFAULT 0,
      density             REAL NOT NULL DEFAULT 0,
      extractor_id        TEXT,
      extraction_run_id   TEXT,
      model               TEXT,
      prompt_version      TEXT,
      batch_size          INTEGER,
      cache_hits          INTEGER NOT NULL DEFAULT 0,
      cache_misses        INTEGER NOT NULL DEFAULT 0,
      truncation_count    INTEGER NOT NULL DEFAULT 0,
      failure_count       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS graph_files (
      stash_root        TEXT NOT NULL,
      file_path         TEXT NOT NULL,
      file_order        INTEGER NOT NULL,
      file_type         TEXT NOT NULL,
      body_hash         TEXT NOT NULL,
      confidence        REAL,
      status            TEXT NOT NULL DEFAULT 'extracted',
      reason            TEXT,
      extraction_run_id TEXT,
      PRIMARY KEY (stash_root, file_path, body_hash)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_files_path
      ON graph_files(stash_root, file_path);

    CREATE INDEX IF NOT EXISTS idx_graph_files_stash_order
      ON graph_files(stash_root, file_order);

    CREATE TABLE IF NOT EXISTS graph_file_entities (
      stash_root   TEXT NOT NULL,
      file_path    TEXT NOT NULL,
      body_hash    TEXT NOT NULL,
      entity_order INTEGER NOT NULL,
      entity_norm  TEXT NOT NULL,
      entity       TEXT NOT NULL,
      PRIMARY KEY (stash_root, file_path, body_hash, entity_order),
      FOREIGN KEY (stash_root, file_path, body_hash)
        REFERENCES graph_files(stash_root, file_path, body_hash) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_graph_file_entities_entity_norm
      ON graph_file_entities(stash_root, entity_norm);

    CREATE TABLE IF NOT EXISTS graph_file_relations (
      stash_root     TEXT NOT NULL,
      file_path      TEXT NOT NULL,
      body_hash      TEXT NOT NULL,
      relation_order INTEGER NOT NULL,
      from_entity_norm TEXT NOT NULL,
      from_entity    TEXT NOT NULL,
      to_entity_norm TEXT NOT NULL,
      to_entity      TEXT NOT NULL,
      relation_type  TEXT,
      confidence     REAL,
      PRIMARY KEY (stash_root, file_path, body_hash, relation_order),
      FOREIGN KEY (stash_root, file_path, body_hash)
        REFERENCES graph_files(stash_root, file_path, body_hash) ON DELETE CASCADE
    );

    -- #624-P3: lazy graph-extraction queue. Standalone table (NO FK to
    -- graph_files — a queued file by definition has no graph row yet).
    -- Idempotent on (stash_root, file_path); drained highest-priority-first.
    CREATE TABLE IF NOT EXISTS graph_extraction_queue (
      stash_root TEXT NOT NULL,
      file_path  TEXT NOT NULL,
      body_hash  TEXT NOT NULL,
      queued_at  TEXT NOT NULL DEFAULT (datetime('now')),
      priority   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (stash_root, file_path)
    );

    CREATE INDEX IF NOT EXISTS idx_graph_extraction_queue_drain
      ON graph_extraction_queue(stash_root, priority DESC, queued_at);
  `);
}

/**
 * An `entries` table missing a required column cannot be read or written by
 * this release (the last such change was v20→v21, which removed the
 * transitional `entry_key`/`dir_path`/... columns and made `item_ref` the
 * key). Recreate only the tables keyed by `entries.id` — their ids are about
 * to be re-minted, so the rows would dangle anyway. Graph rows (keyed by
 * path) and the LLM enrichment cache (keyed by ref) are kept. The next index
 * run re-walks every source. A newer release's table is never recreated:
 * writing to it is refused, naming the upgrade.
 */
function ensureEntriesLayout(db: Database, storedVersion: number): void {
  if (!tableExists(db, "entries")) return;
  const missing = missingEntryColumns(db);
  if (missing.length === 0) return;
  if (storedVersion > DB_VERSION) {
    throw new ConfigError(
      `Index database was written by a newer akm (layout ${storedVersion}) whose entries table this akm cannot write. ` +
        "Upgrade akm to use this index.",
      "INDEX_SCHEMA_INCOMPATIBLE",
      "Upgrade akm to a version that understands this index layout.",
    );
  }
  warn(
    `Index database entries table predates the ${missing.join(", ")} column${missing.length === 1 ? "" : "s"} — ` +
      "recreating the entries-keyed tables (entries, full-text, embeddings, utility scores); graph data and the " +
      "LLM enrichment cache are kept. The next index run re-walks every source.",
  );
  db.transaction(() => {
    for (const table of [
      "entries_fts",
      "entry_fragments_fts",
      "entry_fragments",
      "embeddings",
      "utility_scores_scoped",
      "utility_scores",
      "index_dir_state",
      "entries",
    ]) {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    db.exec("DELETE FROM index_meta WHERE key IN ('builtAt', 'hasEmbeddings', 'vecFastPathReady')");
  })();
  // A vec0 table cannot be dropped while sqlite-vec is unavailable; its rows
  // are orphans the next embedding pass's mirror repair removes.
  try {
    db.exec("DROP TABLE IF EXISTS entries_vec");
  } catch {
    // Left for repairVecFastPath.
  }
}

/**
 * Bring both FTS5 tables to the contentless layout, rebuilding them from
 * `entries` / `entry_fragments` when either is missing or still carries the
 * content-bearing layout older releases wrote (the one-time v23→v24
 * migration). One transaction: a crash mid-rebuild leaves the old tables in
 * place and the next writable open retries. A SQLite without
 * `contentless_delete` keeps (or gets) the content-bearing layout instead.
 */
function ensureFtsLayout(db: Database): void {
  const contentless = supportsContentlessDelete(db);
  const isCurrent = (table: string) => {
    const sql = readTableSql(db, table);
    return sql !== null && isContentlessFtsDdl(sql) === contentless;
  };
  const parentCurrent = isCurrent("entries_fts");
  const fragmentsCurrent = isCurrent("entry_fragments_fts");
  if (parentCurrent && fragmentsCurrent) return;
  const entryCount = Number((db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n);
  if (entryCount > 0) {
    warn(
      `Rebuilding the full-text index for ${entryCount} entr${entryCount === 1 ? "y" : "ies"} ` +
        "(embeddings, utility scores, graph data and the LLM enrichment cache are kept).",
    );
  }
  db.transaction(() => {
    if (!parentCurrent) db.exec("DROP TABLE IF EXISTS entries_fts");
    if (!fragmentsCurrent) db.exec("DROP TABLE IF EXISTS entry_fragments_fts");
    db.exec(entriesFtsDdl(contentless));
    db.exec(fragmentsFtsDdl(contentless));
    rebuildFts(db);
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

export function ensureSchema(db: Database, embeddingDim: number | undefined): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const storedVersion = Number(getMeta(db, "version") ?? 0);
  if (storedVersion > DB_VERSION) {
    warnOnce(
      "index-db-newer-generation",
      `Index database was last written by a newer akm (layout ${storedVersion}; this binary writes ${DB_VERSION}). ` +
        "Continuing with the layout this binary knows — upgrade akm to stop the two from alternating.",
    );
  }

  ensureEntriesLayout(db, storedVersion);

  const hadFragmentSource = tableExists(db, "entry_fragments");
  db.exec(CANONICAL_ENTRY_SCHEMA_SQL);

  // Retired derived tables: the workflow IR cache, the pre-v22 FTS dirty
  // queue, and the #955 embedding salvage staging table (embeddings now carry
  // their model per row, so nothing is copied aside and reused).
  db.exec("DROP TABLE IF EXISTS workflow_documents");
  db.exec("DROP TABLE IF EXISTS entries_fts_dirty");
  db.exec("DROP TABLE IF EXISTS embedding_salvage");

  // BLOB-based embedding storage (always available, no sqlite-vec needed).
  // `model` is the provider fingerprint the vector was generated under
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

  // Per-project scoped utility scores — tracks usage per (entry, cwd-anchor)
  // so assets useful in project A don't pollute rankings in project B.
  db.exec(`
    CREATE TABLE IF NOT EXISTS utility_scores_scoped (
      entry_id     INTEGER NOT NULL,
      scope_key    TEXT NOT NULL,
      utility      REAL NOT NULL DEFAULT 0,
      last_used_at INTEGER NOT NULL,
      PRIMARY KEY (entry_id, scope_key)
    );
    CREATE INDEX IF NOT EXISTS idx_utility_scores_scoped_entry_id
      ON utility_scores_scoped(entry_id);
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
  // absolute file path for graph/memory passes, `item_ref` for the
  // metadata-enhance pass) plus the body hash the result was produced for.
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

  ensureGraphTables(db);

  // sqlite-vec mirror of `embeddings` for the current model.
  //
  // Dimension contract:
  //   - `embeddingDim === undefined`: the caller did not request a specific
  //     dim (registry providers, graph helpers, ad-hoc subcommands). Do not
  //     touch `index_meta.embeddingDim`; fall back to the stored dim (or the
  //     default) only to create the table for the first time.
  //   - a number: the caller explicitly asked for that dim. The vec table is
  //     recreated at that width when its declared width differs; the BLOB
  //     rows are untouched (each carries its own model and byte length).
  const dimExplicit = embeddingDim !== undefined;
  const requestedDim = embeddingDim ?? (Number(getMeta(db, "embeddingDim")) || EMBEDDING_DIM);
  const effectiveDim = Number.isInteger(requestedDim) && requestedDim > 0 ? requestedDim : EMBEDDING_DIM;
  if (effectiveDim !== requestedDim) {
    warn(`Invalid embedding dimension ${requestedDim} — falling back to the default (${EMBEDDING_DIM}).`);
  }
  if (isVecAvailable(db)) ensureVecTableWidth(db, effectiveDim);
  if (dimExplicit) setMeta(db, "embeddingDim", String(effectiveDim));

  db.exec(REGISTRY_INDEX_CACHE_DDL);

  ensureFtsLayout(db);

  // An index that had no fragment source table (v22 and earlier) has parent
  // FTS rebuilt above but no body fragments to index until each directory is
  // drained again. Clearing the per-directory cursor makes the next run
  // re-read every source; entry ids, embeddings and utility rows stay put.
  if (!hadFragmentSource && tableExists(db, "entries")) {
    db.exec("DELETE FROM index_dir_state");
  }

  setMeta(db, "version", String(DB_VERSION));
}
