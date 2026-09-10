// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * index.db schema and version stamps, kept in the
 * storage layer. This isolates the one genuinely risky area (schema
 * evolution) from the CRUD/FTS/vector queries.
 *
 * The meta accessors and vec-availability probe that `ensureSchema` leans on
 * live in the sibling `index-meta-repository` / `index-vec-repository`
 * modules.
 */

import { ConfigError } from "../../core/errors";
import { withImmediateTransaction } from "../../core/state-db";
import { warn } from "../../core/warn";
import type { Database } from "../database";
import { ensureFileAndUnitTextTables } from "./files-repository";
import {
  CANONICAL_ENTRY_SCHEMA_SQL,
  CANONICAL_INDEX_DB_VERSION,
  classifyIndexGeneration,
  isCanonicalIndexGeneration,
} from "./index-entry-schema";
import { getMeta, setMeta } from "./index-meta-repository";
import { isVecAvailable } from "./index-vec-repository";
import { ensureUnitTables } from "./units-repository";

// ── Constants ───────────────────────────────────────────────────────────────

// index.db is a regenerable cache. Incompatible entry-schema changes advance
// this generation and discard only derived index tables; durable state remains
// in state.db. Current readers and writers therefore target exactly one schema
// and never carry live compatibility SQL for previous generations.
//
// v20→v21: remove the transitional entry_key/dir_path/stash_dir/entry_json/
// entry_type columns. item_ref is the sole conflict key; document_json is the
// sole stored document projection; bundle provenance and file_path provide the
// current identity and materialized read path.
//
// v21→v22: entry mutations publish FTS synchronously and no dirty queue exists.
// Discard the old derived generation so stale FTS rows and caller-managed dirty
// state cannot cross the mutation-authority boundary.
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
 * Created with CREATE TABLE IF NOT EXISTS so it is safe to call inside
 * `ensureSchema()`. Caches the result of resolving and fetching remote registry
 * stash indexes so `akm search` does not hit the network on every invocation.
 *
 * Indexed (query) columns:
 *   registry_url  TEXT PK   — canonical URL of the registry; cache key.
 *   fetched_at    TEXT      — ISO-8601; used to detect stale entries (TTL).
 *   etag          TEXT      — HTTP ETag for conditional GET (If-None-Match).
 *   last_modified TEXT      — HTTP Last-Modified for conditional GET.
 *
 * Non-indexed payload:
 *   index_json    TEXT      — JSON blob of the fetched registry index document.
 *
 * ADD COLUMN extension points (future migrations):
 *   ALTER TABLE registry_index_cache ADD COLUMN schema_version INTEGER DEFAULT 1;
 *   ALTER TABLE registry_index_cache ADD COLUMN kit_count INTEGER DEFAULT NULL;
 *   ALTER TABLE registry_index_cache ADD COLUMN error_message TEXT DEFAULT NULL;
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
    -- CREATE TABLE IF NOT EXISTS is the forward migration (no DB_VERSION bump).
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
 * Cross the incompatible entry-schema boundary by discarding the derived index
 * generation. No row conversion or dual-schema compatibility is attempted:
 * the next index run rebuilds entries, FTS, utility aggregates, graph
 * extraction, and enrichment caches from current sources/state. Vectors are
 * content-addressed (`units`/`units_vec`) and are never part of this
 * discard — see `ensureUnitTables`.
 */
function rebuildIncompatibleIndexGeneration(db: Database): void {
  const version = getMeta(db, "version");
  const hasEntries = tableExists(db, "entries");
  if (!hasEntries && version === undefined) return;
  if (isCanonicalIndexGeneration(db)) return;

  const classification = classifyIndexGeneration(db);
  if (classification.status === "newer") {
    throw new ConfigError(
      `Index database was built by a newer akm (stored generation ${classification.storedVersion ?? "unknown"}; ` +
        `this binary understands generation ${CANONICAL_INDEX_DB_VERSION}). Refusing to modify it — upgrade akm ` +
        "to use this index.",
      "INDEX_SCHEMA_INCOMPATIBLE",
      "Upgrade akm to a version that understands this index generation.",
    );
  }

  warn(
    `Index database generation ${classification.storedVersion ?? "unknown"} is older than this akm's generation ` +
      `${CANONICAL_INDEX_DB_VERSION} — rebuilding the derived index (entries, FTS, graph tables, utility scores, ` +
      "and the LLM enrichment cache). This re-walks and re-indexes every source on the next run.",
  );

  // A pre-redesign (v23 or older) index can still carry the legacy
  // `embeddings` table, declared `FOREIGN KEY (id) REFERENCES entries(id)`
  // with no cascade. Under `foreign_keys=ON`, `DROP TABLE entries` below
  // fails with "FOREIGN KEY constraint failed" unless `embeddings` (and its
  // vec0 mirror `entries_vec`, dropped alongside it for symmetry) is gone
  // first — so both must be dropped here, inside this transaction, BEFORE
  // `entries`. `ensureSchema` also drops them unconditionally on every open
  // (it is what cleans up a v24 index built before the tables were retired,
  // and clears `entries_vec` when sqlite-vec was unavailable here), but it
  // runs AFTER this rebuild, so it cannot be the only place the drop
  // happens. Vectors themselves live only in the content-addressed
  // `units`/`units_vec` store, which a generation rebuild never drops
  // (ensureUnitTables' contract).
  withImmediateTransaction(
    db,
    () => {
      db.exec("DROP TABLE IF EXISTS graph_file_relations");
      db.exec("DROP TABLE IF EXISTS graph_file_entities");
      db.exec("DROP TABLE IF EXISTS graph_files");
      db.exec("DROP TABLE IF EXISTS graph_extraction_queue");
      db.exec("DROP TABLE IF EXISTS graph_meta");
      db.exec("DROP TABLE IF EXISTS entries_fts_dirty");
      db.exec("DROP TABLE IF EXISTS entry_fragments_fts");
      db.exec("DROP TABLE IF EXISTS entry_fragments");
      db.exec("DROP TABLE IF EXISTS entries_fts");
      db.exec("DROP TABLE IF EXISTS embeddings");
      if (isVecAvailable(db)) db.exec("DROP TABLE IF EXISTS entries_vec");
      db.exec("DROP TABLE IF EXISTS utility_scores_scoped");
      db.exec("DROP TABLE IF EXISTS utility_scores");
      db.exec("DROP TABLE IF EXISTS llm_enrichment_cache");
      db.exec("DROP TABLE IF EXISTS index_dir_state");
      db.exec("DROP TABLE IF EXISTS entries");
      db.exec("DELETE FROM index_meta");
    },
    "index",
  );
}

export function ensureSchema(db: Database, embeddingDim: number | undefined): void {
  // Create meta table first so we can check version
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  rebuildIncompatibleIndexGeneration(db);

  db.exec(CANONICAL_ENTRY_SCHEMA_SQL);

  // Workflow source is compiled directly into source IR at each command
  // boundary. The former workflow_documents cache duplicated that IR in a
  // second persisted representation and was never used by current execution.
  // index.db is derived state, so remove the obsolete table on every open.
  db.exec("DROP TABLE IF EXISTS workflow_documents");

  // #955's embedding-salvage cache (`embedding-salvage-repository.ts`) is
  // retired (index redesign, B5) — units are content-addressed, so a
  // generation bump keeps whatever vectors are still keyed by an
  // unchanged unit hash instead of needing a copy-aside step. Drop the
  // table on every open so an install upgrading past this release does not
  // carry the now-unreferenced rows forever.
  db.exec("DROP TABLE IF EXISTS embedding_salvage");

  // The legacy per-entry vector tables (`embeddings`, a plain BLOB table, and
  // `entries_vec`, its vec0 mirror) are retired (index redesign, B5h) —
  // vectors live only in the content-addressed `units`/`units_vec` store
  // now. Drop both unconditionally on every open, not gated on a generation
  // bump: a v24 index built before this change may still carry them, and v24
  // tolerates either shape. `embeddings` is a plain table, always safe to
  // drop; `entries_vec` is a vec0 virtual table that can only be dropped
  // while the extension is loaded, so a drop that cannot run yet is deferred
  // the same way a generation rebuild used to defer it — a `vecResetPending`
  // marker, finished the first later open where sqlite-vec is available.
  db.exec("DROP TABLE IF EXISTS embeddings");
  if (isVecAvailable(db)) {
    db.exec("DROP TABLE IF EXISTS entries_vec");
    if (getMeta(db, "vecResetPending") === "1") setMeta(db, "vecResetPending", "0");
  } else if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entries_vec'").get()) {
    setMeta(db, "vecResetPending", "1");
  }

  // usage_events lives in state.db. utility_scores remains a regenerable
  // index.db cache.

  // Utility scores table (aggregated per-entry utility metrics)
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
  // The global utility_scores table is preserved as a fallback / cold-start aid.
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

  // LLM enrichment result cache. Stores a SHA-256 body hash and the JSON
  // result for each asset so that subsequent `akm index --enrich` runs can
  // skip the LLM call when the body hasn't changed. The cache is keyed by
  // a stable asset_ref string (e.g. the absolute file path for graph/memory
  // passes, or `itemRef:passId` for the metadata-enhance pass).
  // Entries are cleaned up when assets are removed or --re-enrich is used.
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

  // Graph extraction tables — schema v4 ((stash_root, file_path, body_hash) PK).
  //
  // graph_files is self-keyed on (stash_root, file_path, body_hash) and is NO
  // LONGER tied to entries.id. This is the #624-P1 win: deleting and
  // re-inserting an entries row during a reindex no longer cascade-wipes the
  // extracted graph — as long as the file's body_hash is unchanged, the graph
  // data survives. body_hash is part of the PK so a content change yields a
  // distinct key; a UNIQUE index on (stash_root, file_path) still enforces
  // exactly one graph_files row per path (delete-then-insert on a hash change).
  //
  // graph_file_entities and graph_file_relations carry (stash_root, file_path,
  // body_hash) and declare a composite FK -> graph_files ON DELETE CASCADE so
  // child rows are removed when a graph_files row is replaced.
  //
  ensureGraphTables(db);

  // Effective embedding vector width for `units_vec` (docs/plans/index-fragment-vectors.md).
  //
  // Dimension contract:
  //   - When `embeddingDim` is `undefined`, the caller did NOT request a
  //     specific dim. Do not touch `index_meta.embeddingDim` — fall back to
  //     the stored dim (or the static default). Without this guard,
  //     registry-side and other dim-unaware `openDatabase()` callers would
  //     silently overwrite the dim-aware improve/index value and oscillate
  //     the stored dim.
  //   - When `embeddingDim` is a number, the caller explicitly asked for
  //     that dim; it is stamped into `index_meta.embeddingDim`.
  //
  // A genuine dimension change (a real model swap) is NOT handled here: it
  // surfaces as a different observed embedding identity
  // (`deriveObservedEmbeddingIdentity` folds the observed vector width into
  // the identity string), and `dropOtherIdentities` — called from the
  // embedding loop when the active identity changes — recreates `units_vec`
  // at the new width then. `units_vec` itself is never dropped or purged
  // here; ensureUnitTables only creates it if missing, at whatever width is
  // effective the first time that happens.
  const dimExplicit = embeddingDim !== undefined;
  const requestedDim = embeddingDim ?? (Number(getMeta(db, "embeddingDim")) || EMBEDDING_DIM);
  const effectiveDim = Number.isInteger(requestedDim) && requestedDim > 0 ? requestedDim : EMBEDDING_DIM;
  if (effectiveDim !== requestedDim) {
    warn(`Invalid embedding dimension ${requestedDim} — falling back to the default (${EMBEDDING_DIM}).`);
  }
  if (dimExplicit) {
    setMeta(db, "embeddingDim", String(effectiveDim));
  }

  // units / units_vec / entry_units (docs/plans/index-fragment-vectors.md):
  // created if missing, and NEVER dropped by the generation rebuild above or
  // by any purge — only dropOtherIdentities (called from the embedding loop
  // on a real identity change) removes rows. ensureUnitTables is idempotent,
  // so this runs on every ensureSchema call, not just the first.
  ensureUnitTables(db, effectiveDim);

  // files / unit_texts / units_fts (docs/plans/index-redesign-contract.md, B1):
  // the reconcile engine's stat cache and content-addressed unit text store.
  // Created if missing; reconcile.ts and pruneOrphanUnitTexts own all row-level
  // writes and deletes, never this ensure path.
  ensureFileAndUnitTextTables(db);

  // Usage telemetry (usage_events) lives in state.db since Chunk-8 WI-8.3 —
  // no longer created here.

  // Registry index cache table — caches remote registry index documents so
  // `akm search` does not hit the network on every invocation.
  db.exec(REGISTRY_INDEX_CACHE_DDL);

  // Write the generation stamp only after every required DDL surface exists.
  // A crash before this point leaves an unversioned generation that the next
  // writable open safely rebuilds instead of admitting a partial v23 index.
  setMeta(db, "version", String(DB_VERSION));
}

/**
 * Returns true when a table exists in the current database.
 */
function tableExists(db: Database, name: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1").get(name);
  return row !== undefined && row !== null;
}
