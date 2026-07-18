// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * index.db schema, version stamps, and targeted migrations — relocated from
 * `src/indexer/db/schema.ts` (WI-5a) into the storage layer. This isolates the
 * one genuinely risky area (schema evolution) from the CRUD/FTS/vector queries.
 *
 * The meta accessors, embedding purge, and vec-availability probe that
 * `ensureSchema` leans on now live in the sibling `index-meta-repository` /
 * `index-vec-repository` modules; importing them from there (rather than from
 * the old `db.ts` hub) is what lets this module leave the import cycle.
 */

import { bestEffort } from "../../core/best-effort";
import { warn } from "../../core/warn";
import { ensureUsageEventsSchema } from "../../indexer/usage/usage-events";
import type { Database } from "../database";
import { getMeta, setMeta } from "./index-meta-repository";
import { isVecAvailable, purgeEmbeddings } from "./index-vec-repository";

// ── Constants ───────────────────────────────────────────────────────────────

// NOTE: schema changes are additive. DB_VERSION is a forensic stamp only — it
// no longer gates any destructive path (the old nuclear drop-and-rebuild was
// removed; index.db's idempotent CREATE … IF NOT EXISTS schema converges any
// older/partial DB forward without dropping data). Graph re-keying uses a
// TARGETED, graph-only migration (migrateGraphFilesSchema) — the model for any
// incompatible change: migrate in place, never wipe the whole index.
//
// v17→v18 (Chunk-5 Step 2, spec §14.4): the `entries` table gains the durable
// bundle-adapter identity/provenance columns — `item_ref` (`<bundle>//<concept
// -id>` canonical stored spelling), `bundle_id`/`component_id`/`concept_id`/
// `adapter_id` provenance, `type` (open token), and `content_hash`/`document
// _json`. They land ADDITIVELY ALONGSIDE the legacy `entry_key`/`dir_path`/
// `stash_dir`/`entry_json`/`entry_type` columns (dev-time transitional shape):
// the writer populates the identity/provenance columns while every reader still
// keys on the legacy columns, so the battery stays green while the reader
// repoint + ref-grammar flip land incrementally. The legacy columns + this
// coexistence are removed once every reader is repointed onto `item_ref`
// (spec §3.3 — single clean shape, no dual read-path). The index is a
// regenerable derived cache, so an `akm index` rebuild repopulates the new
// columns on any DB opened at an older version.
export const DB_VERSION = 18;
export const EMBEDDING_DIM = 384;
// #624-P1: graph_files re-keyed to (stash_root, file_path, body_hash). Bumped 3→4
// as a marker; the actual migration is the targeted drop in migrateGraphFilesSchema.
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

export function ensureSchema(db: Database, embeddingDim: number | undefined): void {
  // Create meta table first so we can check version
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // index.db is a fully regenerable derived cache, so its schema is built
  // idempotently below: every table is CREATE … IF NOT EXISTS and column
  // additions go through guarded ALTERs (ensureDerivedFromColumn) and targeted
  // migrations (migrateGraphFilesSchema / migrateGraphDataFromLegacy). Opening a
  // database with an older or partial schema converges it forward WITHOUT ever
  // dropping data — there is intentionally no "nuclear drop the whole index on a
  // DB_VERSION mismatch" path (a destructive design the regenerable index never
  // needed, and whose pre-drop data-dir backup it required). A genuinely
  // incompatible change is handled by an additive/targeted migration; the few
  // derived tables that ever must be rebuilt are regenerated by `akm index`.

  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_key   TEXT NOT NULL UNIQUE,
      dir_path    TEXT NOT NULL,
      file_path   TEXT NOT NULL,
      stash_dir   TEXT NOT NULL,
      entry_json  TEXT NOT NULL,
      search_text TEXT NOT NULL,
      entry_type  TEXT NOT NULL,
      derived_from TEXT,
      -- Chunk-5 Step 2 / DB v18 (spec 14.4): bundle-adapter identity + provenance,
      -- ADDITIVE alongside the legacy columns above. item_ref is the durable
      -- <bundle>//<concept-id> spelling; nullable during the transition so a
      -- pre-repoint reader path never trips a NOT NULL on a partially-migrated row.
      item_ref     TEXT,
      bundle_id    TEXT,
      component_id TEXT,
      concept_id   TEXT,
      adapter_id   TEXT,
      type         TEXT,
      content_hash TEXT,
      document_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_entries_dir ON entries(dir_path);
    CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(entry_type);
    CREATE INDEX IF NOT EXISTS idx_entries_file_path ON entries(file_path);
  `);

  // v18: backfill the bundle-adapter identity/provenance columns on databases
  // created against a pre-v18 binary (partial schema) — same PRAGMA-then-ALTER
  // guard pattern as `ensureDerivedFromColumn`. Runs BEFORE the item_ref index
  // so the CREATE INDEX below never references a not-yet-added column.
  ensureBundleRefColumns(db);
  // Non-unique lookup index for item_ref (the UNIQUE identity constraint lands
  // with the reader repoint, once every writer emits item_ref for every row).
  bestEffort(
    () => db.exec("CREATE INDEX IF NOT EXISTS idx_entries_item_ref ON entries(item_ref)"),
    "entries.item_ref index — column added by ensureBundleRefColumns above",
  );

  // Phase 5A / DB v17: backfill `derived_from` column + index on databases
  // that were created at v17 fresh OR carry a partial v17 schema (a DB whose
  // `index_meta.version` was bumped to 17 but whose `entries` table still
  // lacks the column — this happens when a previous v17 binary opened a
  // pre-v17 DB without taking the upgrade path because no version mismatch
  // was seen at boot). The PRAGMA-then-ALTER guard runs unconditionally so
  // both fresh and partial schemas converge. The CREATE INDEX for
  // `derived_from` MUST run after this helper so we never reference a
  // column that has not yet been added on partial schemas.
  ensureDerivedFromColumn(db);

  // Validated WorkflowDocument JSON, one row per indexed workflow entry.
  // Pure index data — fully rebuilt on each `akm index`. ON DELETE CASCADE
  // means clearing entries (full rebuild or per-dir delete) drops these too.
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_documents (
      entry_id        INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
      schema_version  INTEGER NOT NULL,
      document_json   TEXT NOT NULL,
      source_path     TEXT NOT NULL,
      source_hash     TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_documents_source_path
      ON workflow_documents(source_path);
  `);

  // Set version immediately after table creation so a crash before the end of
  // ensureSchema() does not leave the database in a versionless state on next open.
  const versionAfterCreate = getMeta(db, "version");
  if (!versionAfterCreate) {
    setMeta(db, "version", String(DB_VERSION));
  }

  // BLOB-based embedding storage (always available, no sqlite-vec needed)
  db.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      id        INTEGER PRIMARY KEY,
      embedding BLOB NOT NULL,
      FOREIGN KEY (id) REFERENCES entries(id)
    );
  `);

  // FTS5 table — multi-column with per-field weighting via bm25()
  const ftsExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entries_fts'").get();
  if (!ftsExists) {
    db.exec(`
      CREATE VIRTUAL TABLE entries_fts USING fts5(
        entry_id UNINDEXED,
        name,
        description,
        tags,
        hints,
        content,
        tokenize='porter unicode61'
      );
    `);
  }

  // Usage events table — created by ensureUsageEventsSchema() at runtime.

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS index_dir_state (
      dir_path          TEXT PRIMARY KEY,
      file_set_hash     TEXT NOT NULL,
      file_mtime_max_ms REAL NOT NULL,
      reason            TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );
  `);

  // LLM enrichment result cache. Stores a SHA-256 body hash and the JSON
  // result for each asset so that subsequent `akm index --enrich` runs can
  // skip the LLM call when the body hasn't changed. The cache is keyed by
  // a stable asset_ref string (e.g. the absolute file path for graph/memory
  // passes, or `entryKey:passId` for the metadata-enhance pass).
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
  // #624-P1 targeted migration: an existing DB may still hold the OLD graph_files
  // (entry_id PK). SQLite can't ALTER a primary key, so we RENAME the 3 graph
  // tables aside (→ *_legacy) here — ONLY the graph tables, never the index/
  // embeddings — then the CREATE block below builds the new shape, then
  // migrateGraphDataFromLegacy() copies the data across so the graph is PRESERVED
  // (not re-extracted).
  migrateGraphFilesSchema(db);

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

  // #624-P1 migration step 2: copy any renamed-aside legacy graph data into the
  // new-shape tables (just created above), then drop the legacy tables. No-op
  // unless migrateGraphFilesSchema renamed a legacy graph_files this open.
  migrateGraphDataFromLegacy(db);

  // FTS-dirty queue. Created here (not lazily on first upsert) so the
  // per-entry write path doesn't issue a CREATE TABLE IF NOT EXISTS on
  // every call — that DDL would fire thousands of times during a full
  // index. See `markFtsDirty` and `rebuildFts({ incremental: true })`.
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries_fts_dirty (
      entry_id INTEGER PRIMARY KEY
    );
  `);

  // sqlite-vec table
  //
  // Dimension contract:
  //   - When `embeddingDim` is `undefined`, the caller did NOT request a
  //     specific dim. Do not touch `index_meta.embeddingDim` and do not run
  //     the dim-change wipe — fall back to the stored dim (or the static
  //     default) only when we have to materialise the vec table for the
  //     first time. Without this guard, registry-side and other dim-unaware
  //     `openDatabase()` callers would silently overwrite the dim-aware
  //     improve/index value and oscillate the stored dim.
  //   - When `embeddingDim` is a number, the caller explicitly asked for
  //     that dim and owns the dim-change/backup/wipe semantics.
  const dimExplicit = embeddingDim !== undefined;
  const effectiveDim = embeddingDim ?? (Number(getMeta(db, "embeddingDim")) || EMBEDDING_DIM);
  if (isVecAvailable(db)) {
    // Check if stored embedding dimension differs from configured one
    if (dimExplicit) {
      const storedDim = getMeta(db, "embeddingDim");
      if (storedDim && storedDim !== String(embeddingDim)) {
        // Stored vectors are incompatible with the new dimension. Drop the vec
        // table so the block below recreates it at the new width; the BLOB rows
        // go too. Regenerable from markdown — re-embedded by the next index.
        purgeEmbeddings(db, { dropVecTable: true });
      }
    }

    const vecExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entries_vec'").get();
    if (!vecExists) {
      if (!Number.isInteger(effectiveDim) || effectiveDim <= 0 || effectiveDim > 4096) {
        throw new Error(`Invalid embedding dimension: ${effectiveDim}`);
      }
      db.exec(`
        CREATE VIRTUAL TABLE entries_vec USING vec0(
          id       INTEGER PRIMARY KEY,
          embedding FLOAT[${effectiveDim}]
        );
      `);
    }
    if (dimExplicit) {
      setMeta(db, "embeddingDim", String(embeddingDim));
    }
  } else {
    // Also purge BLOB embeddings on dimension change (JS fallback path).
    // When sqlite-vec is unavailable, entries_vec doesn't exist but the BLOB
    // embeddings table still stores vectors. If the configured dimension
    // changes, those stored BLOBs become silently incompatible.
    if (dimExplicit) {
      const storedDim = getMeta(db, "embeddingDim");
      if (storedDim && storedDim !== String(embeddingDim)) {
        // JS-fallback path: no vec table, just clear the stale BLOB vectors.
        purgeEmbeddings(db);
      }
      setMeta(db, "embeddingDim", String(embeddingDim));
    }
  }

  // Usage telemetry table
  ensureUsageEventsSchema(db);

  // Registry index cache table — caches remote registry index documents so
  // `akm search` does not hit the network on every invocation.
  db.exec(REGISTRY_INDEX_CACHE_DDL);
}

/**
 * Phase 5A / DB v17 schema guard.
 *
 * Ensures the `entries.derived_from` column + index exist on the open
 * connection. Called from `ensureSchema()` after the entries CREATE so that
 * legacy databases (created against a pre-v17 binary) still gain the new column
 * without data loss. Idempotent: a `PRAGMA table_info` lookup gates the ALTER.
 */
function ensureDerivedFromColumn(db: Database): void {
  bestEffort(() => {
    const cols = db.prepare("PRAGMA table_info(entries)").all() as Array<{ name: string }>;
    const hasColumn = cols.some((c) => c.name === "derived_from");
    if (!hasColumn) {
      db.exec("ALTER TABLE entries ADD COLUMN derived_from TEXT");
    }
    // Index creation is idempotent on its own; safe to call unconditionally.
    db.exec("CREATE INDEX IF NOT EXISTS idx_entries_derived_from ON entries(derived_from)");
  }, "entries table may not exist on a brand-new DB before CREATE — caller is responsible");
}

/**
 * Chunk-5 Step 2 / DB v18 schema guard.
 *
 * Ensures the bundle-adapter identity/provenance columns exist on the open
 * `entries` table. Called from `ensureSchema()` after the entries CREATE so a
 * legacy database (created against a pre-v18 binary) gains the new columns
 * without a rebuild. All columns are nullable and added ADDITIVELY — the
 * writer populates `item_ref`/`bundle_id`/`component_id`/`concept_id`/
 * `adapter_id`/`type` while readers still key on the legacy columns. Idempotent:
 * a `PRAGMA table_info` lookup gates each ALTER.
 */
function ensureBundleRefColumns(db: Database): void {
  bestEffort(() => {
    const cols = db.prepare("PRAGMA table_info(entries)").all() as Array<{ name: string }>;
    const have = new Set(cols.map((c) => c.name));
    const additive: Array<[string, string]> = [
      ["item_ref", "TEXT"],
      ["bundle_id", "TEXT"],
      ["component_id", "TEXT"],
      ["concept_id", "TEXT"],
      ["adapter_id", "TEXT"],
      ["type", "TEXT"],
      ["content_hash", "TEXT"],
      ["document_json", "TEXT"],
    ];
    for (const [name, sqlType] of additive) {
      if (!have.has(name)) db.exec(`ALTER TABLE entries ADD COLUMN ${name} ${sqlType}`);
    }
  }, "entries table may not exist on a brand-new DB before CREATE — caller is responsible");
}

/**
 * Returns true when a table exists in the current database.
 */
function tableExists(db: Database, name: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1").get(name);
  return row !== undefined && row !== null;
}

/**
 * #624-P1 targeted graph-schema migration — STEP 1 of 2 (rename).
 *
 * graph_files was re-keyed from `entry_id INTEGER PRIMARY KEY REFERENCES
 * entries(id)` to a self-contained `(stash_root, file_path, body_hash)` PK.
 * SQLite cannot ALTER a primary key, so an existing DB carrying the OLD shape
 * has its 3 graph tables RENAMED to `*_legacy` here; ensureSchema's CREATE block
 * then builds the new-shape tables, and {@link migrateGraphDataFromLegacy} COPIES
 * the data across before dropping the legacy tables. The graph is preserved —
 * NOT re-extracted (re-extraction is ~19s/file of LLM work).
 *
 * Crucially this is GRAPH-SCOPED: it touches ONLY the graph tables, never the
 * index / embeddings / enrichment cache. So users keep their (expensive)
 * embeddings instead of being forced into a full re-embed by a DB_VERSION bump.
 *
 * Detection: the old schema has an `entry_id` column on graph_files. Fresh DBs
 * (no graph_files yet) and already-migrated DBs (no entry_id column) are no-ops.
 * Idempotent.
 */
function migrateGraphFilesSchema(db: Database): void {
  bestEffort(() => {
    const cols = db.prepare("PRAGMA table_info(graph_files)").all() as Array<{ name: string }>;
    const isLegacyShape = cols.some((c) => c.name === "entry_id");
    if (!isLegacyShape) return;
    // A previous interrupted migration may have left *_legacy behind — drop those
    // husks first so the rename below doesn't collide.
    db.exec("DROP TABLE IF EXISTS graph_file_relations_legacy");
    db.exec("DROP TABLE IF EXISTS graph_file_entities_legacy");
    db.exec("DROP TABLE IF EXISTS graph_files_legacy");
    // Rename the 3 entry_id-keyed tables aside. graph_meta is unchanged (stash_root
    // key) so it is left in place. ALTER … RENAME auto-updates child FK refs in
    // SQLite ≥3.25, which is fine — the legacy children are dropped after the copy.
    db.exec("ALTER TABLE graph_files RENAME TO graph_files_legacy");
    if (tableExists(db, "graph_file_entities")) {
      db.exec("ALTER TABLE graph_file_entities RENAME TO graph_file_entities_legacy");
    }
    if (tableExists(db, "graph_file_relations")) {
      db.exec("ALTER TABLE graph_file_relations RENAME TO graph_file_relations_legacy");
    }
  }, "graph_files may not exist on a brand-new DB before CREATE — caller is responsible");
}

/**
 * #624-P1 targeted graph-schema migration — STEP 2 of 2 (copy + drop legacy).
 *
 * Runs AFTER the graph CREATE TABLE block, so the new-shape tables exist. Copies
 * every legacy row into the re-keyed tables — the old tables already carry
 * (stash_root, file_path, body_hash) next to entry_id, so the projection is a
 * straight column copy (children JOIN back to graph_files_legacy to resolve the
 * composite key from their entry_id). Then drops the `*_legacy` tables.
 *
 * Best-effort: a copy failure (e.g. a pre-body_hash legacy schema) is tolerated,
 * and the legacy tables are dropped regardless so they never linger. Rows whose
 * body_hash is null/empty can't form the new PK and are skipped (they re-extract).
 */
function migrateGraphDataFromLegacy(db: Database): void {
  if (!tableExists(db, "graph_files_legacy")) return;
  let migratedFiles = 0;
  bestEffort(() => {
    db.transaction(() => {
      const res = db
        .prepare(
          `INSERT OR IGNORE INTO graph_files
             (stash_root, file_path, body_hash, file_order, file_type, confidence, status, reason, extraction_run_id)
           SELECT stash_root, file_path, body_hash, file_order, file_type, confidence, status, reason, extraction_run_id
             FROM graph_files_legacy
            WHERE body_hash IS NOT NULL AND body_hash != ''`,
        )
        .run();
      migratedFiles = Number(res.changes);
      if (tableExists(db, "graph_file_entities_legacy")) {
        db.exec(
          `INSERT OR IGNORE INTO graph_file_entities
             (stash_root, file_path, body_hash, entity_order, entity_norm, entity)
           SELECT gf.stash_root, gf.file_path, gf.body_hash, e.entity_order, e.entity_norm, e.entity
             FROM graph_file_entities_legacy e
             JOIN graph_files_legacy gf ON gf.entry_id = e.entry_id
            WHERE gf.body_hash IS NOT NULL AND gf.body_hash != ''`,
        );
      }
      if (tableExists(db, "graph_file_relations_legacy")) {
        db.exec(
          `INSERT OR IGNORE INTO graph_file_relations
             (stash_root, file_path, body_hash, relation_order, from_entity_norm, from_entity, to_entity_norm, to_entity, relation_type, confidence)
           SELECT gf.stash_root, gf.file_path, gf.body_hash, r.relation_order, r.from_entity_norm, r.from_entity, r.to_entity_norm, r.to_entity, r.relation_type, r.confidence
             FROM graph_file_relations_legacy r
             JOIN graph_files_legacy gf ON gf.entry_id = r.entry_id
            WHERE gf.body_hash IS NOT NULL AND gf.body_hash != ''`,
        );
      }
    })();
  }, "graph data migration is best-effort; legacy tables are dropped regardless below");
  // Always drop the legacy tables (children first), migrated or not.
  bestEffort(() => {
    db.exec("DROP TABLE IF EXISTS graph_file_relations_legacy");
    db.exec("DROP TABLE IF EXISTS graph_file_entities_legacy");
    db.exec("DROP TABLE IF EXISTS graph_files_legacy");
  }, "drop legacy graph tables after migration");
  if (migratedFiles > 0) {
    warn(
      `[akm] graph index re-keyed (#624): migrated ${migratedFiles} extracted file(s) to the new schema — no re-extraction needed. Index + embeddings untouched.`,
    );
  }
}
