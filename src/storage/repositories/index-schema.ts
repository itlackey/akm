// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * index.db schema, kept in the storage layer so schema evolution stays apart
 * from the CRUD/FTS/vector queries.
 *
 * `ensureSchema` runs on every writable open: `CREATE ... IF NOT EXISTS`, plus
 * one in-place rebuild of the (derived, cheap) FTS table when its contentless
 * layout differs from what the linked SQLite supports. index.db is a derived
 * cache, so there is no in-place upgrade across layouts: an index below
 * {@link MIN_INDEX_LAYOUT} raises {@link IndexLayoutBelowFloorError}, and
 * `openIndexDatabase` deletes the file and rebuilds it, the same recovery as
 * `SQLITE_CORRUPT`. A layout newer than this release's is refused, naming the
 * upgrade ({@link newerIndexLayoutError}).
 */

import { ConfigError } from "../../core/errors";
import { warn } from "../../core/warn";
import type { Database } from "../database";
import {
  CANONICAL_ENTRY_SCHEMA_SQL,
  CANONICAL_INDEX_DB_VERSION,
  entriesFtsDdl,
  isContentlessFtsDdl,
  MIN_INDEX_LAYOUT,
  readTableSql,
  supportsContentlessDelete,
} from "./index-entry-schema";
import { rebuildFts } from "./index-fts-repository";
import { getMeta, setMeta } from "./index-meta-repository";

// ── Constants ───────────────────────────────────────────────────────────────

export const DB_VERSION = CANONICAL_INDEX_DB_VERSION;

/**
 * An index.db written at a layout below {@link MIN_INDEX_LAYOUT}. It is derived
 * data, so the opener rebuilds it from the sources instead of upgrading it.
 */
export class IndexLayoutBelowFloorError extends Error {
  constructor(readonly storedVersion: number) {
    super(`Index database layout ${storedVersion} is older than the oldest this akm upgrades (${MIN_INDEX_LAYOUT}).`);
    this.name = "IndexLayoutBelowFloorError";
  }
}

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
 * Bring `index.db` to the current layout in one transaction, so no reader or
 * crash can observe a half-migrated file (entries without their FTS table).
 * One `BEGIN IMMEDIATE`, waiting out the connection's busy timeout once: a
 * busy index surfaces to the caller (the build reports it as contention)
 * rather than being retried here. Joins a transaction the caller already holds.
 */
export function ensureSchema(db: Database): void {
  if (db.inTransaction) {
    applySchema(db);
    return;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    applySchema(db);
    db.exec("COMMIT");
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

function applySchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const storedVersion = Number(getMeta(db, "version") ?? 0);
  if (storedVersion > DB_VERSION) throw newerIndexLayoutError(storedVersion);
  if (storedVersion > 0 && storedVersion < MIN_INDEX_LAYOUT) throw new IndexLayoutBelowFloorError(storedVersion);

  db.exec(CANONICAL_ENTRY_SCHEMA_SQL);

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

  db.exec(REGISTRY_INDEX_CACHE_DDL);

  ensureFtsLayout(db);

  setMeta(db, "version", String(DB_VERSION));
}
