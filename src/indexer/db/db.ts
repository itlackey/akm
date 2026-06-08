// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseAssetRef } from "../../core/asset/asset-ref";
import { bestEffort } from "../../core/best-effort";
import { getDbPath } from "../../core/paths";
import { REGISTRY_INDEX_CACHE_DDL } from "../../core/state-db";
import { warn } from "../../core/warn";
import { cosineSimilarity, type EmbeddingVector } from "../../llm/embedders/types";
import { type Database, openDatabase as openSqlite, type SqlValue } from "../../storage/database";
import type { StashEntry } from "../passes/metadata";
import { buildSearchFields } from "../search/search-fields";
import { ensureUsageEventsSchema } from "../usage/usage-events";
import { backupDataDir, EMBEDDING_DIM_CHANGE_REASON } from "./db-backup";

// ── Types ───────────────────────────────────────────────────────────────────

export interface DbIndexedEntry {
  id: number;
  entryKey: string;
  dirPath: string;
  filePath: string;
  stashDir: string;
  entry: StashEntry;
  searchText: string;
}

export interface DbSearchResult {
  id: number;
  filePath: string;
  entry: StashEntry;
  searchText: string;
  bm25Score: number;
}

export interface DbVecResult {
  id: number;
  distance: number;
}

export interface IndexDirState {
  dirPath: string;
  fileSetHash: string;
  fileMtimeMaxMs: number;
  reason: string;
  updatedAt: string;
}

// ── Constants ───────────────────────────────────────────────────────────────

export const DB_VERSION = 17;
export const EMBEDDING_DIM = 384;
export const GRAPH_SCHEMA_VERSION = 3;

// ── Database lifecycle ──────────────────────────────────────────────────────

export function openDatabase(dbPath?: string, options?: { embeddingDim?: number }): Database {
  const resolvedPath = dbPath ?? getDbPath();
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = openSqlite(resolvedPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");

  // Try to load sqlite-vec extension
  loadVecExtension(db);

  // Dim resolution: explicit option wins; otherwise consult the on-disk
  // config so unparameterised opens (registry providers, graph helpers,
  // ad-hoc CLI subcommands) honour the operator-declared dimension. Only if
  // both are absent do we fall through to the no-clobber path, which keeps
  // ensureSchema from touching `index_meta.embeddingDim` at all.
  const resolvedDim = options?.embeddingDim ?? resolveConfiguredEmbeddingDim();
  ensureSchema(db, resolvedDim, { dataDir: dir });

  // Warn once at init if using JS fallback with many entries
  warnIfVecMissing(db, { once: true });

  return db;
}

/**
 * Read the operator-configured embedding dimension from the on-disk config.
 * Returns `undefined` when no config file is present, when the config has
 * no `embedding.dimension` set, or when reading the config throws (e.g.
 * inside isolated test fixtures with no XDG home). Failure is silent on
 * purpose — every openDatabase() call would otherwise have to handle a
 * config-not-found error path, and the fallback (no-clobber semantics) is
 * already correct.
 */
function resolveConfiguredEmbeddingDim(): number | undefined {
  try {
    const { loadConfig } = require("../../core/config/config") as typeof import("../../core/config/config");
    const dim = loadConfig().embedding?.dimension;
    if (typeof dim === "number" && Number.isInteger(dim) && dim > 0 && dim <= 4096) {
      return dim;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function openExistingDatabase(dbPath?: string): Database {
  const resolvedPath = dbPath ?? getDbPath();
  const db = openSqlite(resolvedPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");

  // Existing-DB callers must not mutate schema or embedding metadata on open,
  // but some paths still need write access to usage_events and other tables.
  loadVecExtension(db);

  return db;
}

export function closeDatabase(db: Database): void {
  db.close();
}

// ── sqlite-vec extension ────────────────────────────────────────────────────

const vecStatus = new WeakMap<Database, boolean>();

function loadVecExtension(db: Database): void {
  try {
    const esmRequire = createRequire(import.meta.url);
    const sqliteVec = esmRequire("sqlite-vec");
    // `db` here is the genuine underlying driver handle returned by the storage
    // boundary (bun:sqlite on Bun, better-sqlite3 on Node) — only structurally
    // narrowed for callers. sqlite-vec's `load()` accepts either real handle,
    // so no raw-handle escape hatch is required.
    sqliteVec.load(db);
    vecStatus.set(db, true);
  } catch {
    vecStatus.set(db, false);
  }
}

export function isVecAvailable(db: Database): boolean {
  return vecStatus.get(db) ?? false;
}

const VEC_DOCS_URL = "https://github.com/itlackey/akm/blob/main/docs/configuration.md#sqlite-vec-extension";
const VEC_FALLBACK_THRESHOLD = 10_000;
// Per-database warning state: tracks which databases have already emitted the
// vec-missing warning so we don't spam on every openDatabase() call.
const vecInitWarnedDbs = new WeakSet<Database>();

/**
 * Warn if sqlite-vec is unavailable and embedding count exceeds threshold.
 * Called from openDatabase (once at init) and from indexer (each run).
 */
export function warnIfVecMissing(db: Database, { once }: { once: boolean } = { once: false }): void {
  if (isVecAvailable(db)) return;
  if (once && vecInitWarnedDbs.has(db)) return;

  bestEffort(() => {
    const row = db.prepare("SELECT COUNT(*) AS cnt FROM embeddings").get() as { cnt: number } | undefined;
    const count = row?.cnt ?? 0;
    if (count >= VEC_FALLBACK_THRESHOLD) {
      warn(
        "Semantic search is using JS fallback for %d entries. Install sqlite-vec for faster performance.\n  See: %s",
        count,
        VEC_DOCS_URL,
      );
      if (once) vecInitWarnedDbs.add(db);
    }
  }, "embeddings table may not exist yet during init");
}

// ── Schema ──────────────────────────────────────────────────────────────────

/** A row backed up out of the legacy `usage_events` table during a version upgrade. */
type UsageEventRow = Record<string, string | number | null>;

function ensureSchema(db: Database, embeddingDim: number | undefined, options?: { dataDir?: string }): void {
  // Create meta table first so we can check version
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // MVP DB-backup hook (0.8.x): when the stored DB version differs from the
  // running binary's DB_VERSION, snapshot the data directory BEFORE
  // `handleVersionUpgrade()` drops tables. This is best-effort —
  // `backupDataDir` returns null on opt-out, missing data dir, low free
  // space, or copy errors, and we proceed with the upgrade in all cases.
  // The proper migration framework lands in 0.9.0; until then this lets
  // operators recover with `scripts/migrations/restore-data-dir.sh`.
  if (options?.dataDir) {
    const storedVersionRaw = getMeta(db, "version");
    const storedVersion =
      storedVersionRaw !== undefined && storedVersionRaw !== "" ? Number.parseInt(storedVersionRaw, 10) : null;
    const willUpgrade =
      storedVersionRaw !== undefined && storedVersionRaw !== "" && storedVersionRaw !== String(DB_VERSION);
    if (willUpgrade) {
      try {
        // Pass env explicitly so tests can override AKM_DB_BACKUP / AKM_DB_BACKUP_RETAIN
        // without mutating process.env. Production callers default to process.env.
        const result = backupDataDir({
          dataDir: options.dataDir,
          sourceVersion: storedVersion !== null && !Number.isNaN(storedVersion) ? storedVersion : null,
          targetVersion: DB_VERSION,
          env: process.env,
        });
        if (result) {
          warn(
            "[akm] data directory backed up to %s before v%s→v%d upgrade",
            result.path,
            storedVersionRaw,
            DB_VERSION,
          );
        }
      } catch (err) {
        // Defensive — backupDataDir already swallows most errors, but if it
        // throws for an unexpected reason we must still proceed with the
        // upgrade so the user isn't locked out of their binary.
        warn(
          "[akm] pre-upgrade data dir backup raised an unexpected error — %s; upgrade will proceed without a snapshot",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  // Check stored version — if it differs from DB_VERSION, drop and recreate all tables.
  // Usage events are preserved across version upgrades so that utility score
  // history is not silently lost. The backup is captured here and threaded
  // explicitly to `restoreUsageEventsBackup` below — the previous version
  // attached `__usageBackup` to the Database instance via a typeless property
  // injection, which was a source of fragile coupling.
  const usageBackup: UsageEventRow[] = handleVersionUpgrade(db);

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
      derived_from TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_entries_dir ON entries(dir_path);
    CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(entry_type);
    CREATE INDEX IF NOT EXISTS idx_entries_file_path ON entries(file_path);
  `);

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

  // Graph extraction tables — schema v2 (entry_id PK).
  //
  // graph_files is keyed on entries.id so child tables cascade-delete cleanly
  // when an entry is removed, and so JOINs from graph rows to entries are a
  // direct PK lookup. (stash_root, file_path) is retained as UNIQUE so the
  // extractor's path-based upsert still works.
  //
  // graph_file_entities and graph_file_relations no longer duplicate file_path;
  // they reference entry_id and inherit stash scoping via graph_files.
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
      entry_id          INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
      stash_root        TEXT NOT NULL,
      file_path         TEXT NOT NULL,
      file_order        INTEGER NOT NULL,
      file_type         TEXT NOT NULL,
      body_hash         TEXT NOT NULL,
      confidence        REAL,
      status            TEXT NOT NULL DEFAULT 'extracted',
      reason            TEXT,
      extraction_run_id TEXT,
      UNIQUE(stash_root, file_path)
    );

    CREATE INDEX IF NOT EXISTS idx_graph_files_stash_order
      ON graph_files(stash_root, file_order);

    CREATE TABLE IF NOT EXISTS graph_file_entities (
      entry_id     INTEGER NOT NULL REFERENCES graph_files(entry_id) ON DELETE CASCADE,
      entity_order INTEGER NOT NULL,
      stash_root   TEXT NOT NULL,
      entity_norm  TEXT NOT NULL,
      entity       TEXT NOT NULL,
      PRIMARY KEY (entry_id, entity_order)
    );

    CREATE INDEX IF NOT EXISTS idx_graph_file_entities_entity_norm
      ON graph_file_entities(stash_root, entity_norm);

    CREATE TABLE IF NOT EXISTS graph_file_relations (
      entry_id       INTEGER NOT NULL REFERENCES graph_files(entry_id) ON DELETE CASCADE,
      relation_order INTEGER NOT NULL,
      from_entity_norm TEXT NOT NULL,
      from_entity    TEXT NOT NULL,
      to_entity_norm TEXT NOT NULL,
      to_entity      TEXT NOT NULL,
      relation_type  TEXT,
      confidence     REAL,
      PRIMARY KEY (entry_id, relation_order)
    );
  `);

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
        // Re-embedding the whole stash is expensive (LLM API calls + cache
        // misses), so snapshot the data dir before we drop the vec table and
        // wipe `embeddings`. This is the SAME hook the version-upgrade path
        // uses earlier in this function, just gated on embedding-dim mismatch
        // and tagged so operators can tell the two backup kinds apart.
        backupBeforeEmbeddingDimChange(options?.dataDir, storedDim, String(embeddingDim));
        bestEffort(() => db.exec("DROP TABLE IF EXISTS entries_vec"), "drop entries_vec on dim change");
        // Delete stale BLOB embeddings so they don't produce silently wrong
        // similarity scores against the new-dimension vec table.
        bestEffort(() => db.exec("DELETE FROM embeddings"), "delete stale embeddings on dim change");
        setMeta(db, "hasEmbeddings", "0");
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
        backupBeforeEmbeddingDimChange(options?.dataDir, storedDim, String(embeddingDim));
        bestEffort(() => db.exec("DELETE FROM embeddings"), "delete embeddings on explicit dim change");
        setMeta(db, "hasEmbeddings", "0");
      }
      setMeta(db, "embeddingDim", String(embeddingDim));
    }
  }

  // Usage telemetry table
  ensureUsageEventsSchema(db);

  // Registry index cache table — caches remote registry index documents so
  // `akm search` does not hit the network on every invocation. The DDL is
  // defined in state-db.ts and shared here to avoid duplication.
  db.exec(REGISTRY_INDEX_CACHE_DDL);

  // Restore usage_events backed up by the version-upgrade path above.
  restoreUsageEventsBackup(db, usageBackup);
}

/**
 * Detect a stored DB version that differs from {@link DB_VERSION}, drop the
 * old schema, and return a backup of the previous `usage_events` rows so the
 * rest of `ensureSchema()` can restore them once the new table exists.
 *
 * Returns an empty array when no upgrade is needed or when the previous
 * `usage_events` table is unreadable.
 */
function handleVersionUpgrade(db: Database): UsageEventRow[] {
  const storedVersion = getMeta(db, "version");
  // BUG-L4: distinguish "missing" (undefined) from "present but empty" — both
  // were previously coerced through `!storedVersion` and treated as "no
  // upgrade needed", which caused fresh databases (with no version row) to
  // skip the upgrade path correctly, but also caused the upgrade path to be
  // taken when a corrupted/empty version string was persisted. The current
  // tables get dropped only when the stored version exists AND differs from
  // DB_VERSION; missing or empty version means a fresh DB and no upgrade.
  if (storedVersion === undefined || storedVersion === "" || storedVersion === String(DB_VERSION)) return [];

  let usageBackup: UsageEventRow[] = [];
  bestEffort(() => {
    usageBackup = db.prepare("SELECT * FROM usage_events").all() as UsageEventRow[];
  }, "usage_events table may not exist in older versions");

  db.exec("DROP TABLE IF EXISTS utility_scores");
  db.exec("DROP TABLE IF EXISTS utility_scores_scoped");
  db.exec("DROP INDEX IF EXISTS idx_utility_scores_scoped_entry_id");
  db.exec("DROP TABLE IF EXISTS usage_events");
  db.exec("DROP TABLE IF EXISTS embeddings");
  db.exec("DROP TABLE IF EXISTS entries_vec");
  db.exec("DROP TABLE IF EXISTS entries_fts");
  db.exec("DROP TABLE IF EXISTS index_dir_state");
  db.exec("DROP TABLE IF EXISTS llm_enrichment_cache");
  db.exec("DROP INDEX IF EXISTS idx_llm_cache_updated");
  db.exec("DROP TABLE IF EXISTS graph_file_relations");
  db.exec("DROP TABLE IF EXISTS graph_file_entities");
  db.exec("DROP TABLE IF EXISTS graph_files");
  db.exec("DROP TABLE IF EXISTS graph_meta");
  db.exec("DROP TABLE IF EXISTS graph_relations");
  db.exec("DROP TABLE IF EXISTS graph_entities");
  db.exec("DROP TABLE IF EXISTS graph_nodes");
  db.exec("DROP TABLE IF EXISTS graph_stashes");
  db.exec("DROP INDEX IF EXISTS idx_entries_dir");
  db.exec("DROP INDEX IF EXISTS idx_entries_type");
  db.exec("DROP TABLE IF EXISTS entries");
  db.exec("DELETE FROM index_meta");

  warn("[akm] Index rebuilt due to version upgrade. Run 'akm index' to repopulate.");
  return usageBackup;
}

/**
 * Snapshot the data directory before the embedding-dimension drop path wipes
 * `embeddings` and recreates `entries_vec`. Re-embedding a real-world stash
 * is expensive (LLM calls + cache misses), so we capture the pre-drop state
 * here using the same MVP backup helper the version-upgrade hook uses
 * earlier in {@link ensureSchema}.
 *
 * The backup is tagged with the `embedding-dim-change` reason so it lands in
 * `<dataDir>/backups/<timestamp>-embedding-dim-change/` instead of the
 * version-upgrade-flavored `<timestamp>-pre-v<N>/` directory. Restoration
 * works identically via `scripts/migrations/restore-data-dir.sh`.
 *
 * Failures are non-fatal — they downgrade to a warning and the destructive
 * ops run anyway, matching the version-upgrade hook's behavior so a broken
 * backup cannot brick a binary that bumped the configured dim. Likewise,
 * `AKM_DB_BACKUP=0` opts out via the same path.
 */
function backupBeforeEmbeddingDimChange(dataDir: string | undefined, fromDim: string, toDim: string): void {
  if (!dataDir) return;
  try {
    const result = backupDataDir({
      dataDir,
      // The DB version isn't changing here — pass the current DB_VERSION for
      // both source and target so the metadata sidecar still records the
      // running binary's version for forensic context.
      sourceVersion: DB_VERSION,
      targetVersion: DB_VERSION,
      reason: EMBEDDING_DIM_CHANGE_REASON,
      env: process.env,
    });
    if (result) {
      warn(
        "[akm] embedding dimension changed %s→%s; data directory backed up to %s; embeddings will be regenerated",
        fromDim,
        toDim,
        result.path,
      );
    }
  } catch (err) {
    // Defensive — backupDataDir already swallows most errors, but if it
    // throws for an unexpected reason we must still proceed with the drop
    // so the user isn't locked out of their binary on a changed dim.
    warn(
      "[akm] pre-embedding-dim-change data dir backup raised an unexpected error — %s; embeddings will be regenerated without a snapshot",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Re-insert backed-up `usage_events` rows into the freshly-created table.
 *
 * Wrapped in an outer try/catch because schema changes across versions may
 * make the backup incompatible with the new table definition; in that case
 * the backup is discarded silently rather than blocking startup.
 */
function restoreUsageEventsBackup(db: Database, backup: UsageEventRow[]): void {
  if (backup.length === 0) return;
  try {
    // BUG-H4: introspect the *target* table's columns rather than relying on
    // `row[0]`'s keys. The backup may carry columns the new schema dropped,
    // and the new schema may have NOT-NULL columns without DEFAULT that the
    // old backup never carried. Project the backup onto the intersection so
    // we don't silently lose every row to per-row INSERT errors, and warn
    // once if any backup column was dropped from the new schema.
    const targetCols = (db.prepare("PRAGMA table_info(usage_events)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    if (targetCols.length === 0) {
      warn("[db] restoreUsageEventsBackup: usage_events table missing — discarding %d backup row(s)", backup.length);
      return;
    }
    const targetSet = new Set(targetCols);
    const backupCols = Object.keys(backup[0] ?? {});
    const projectedCols = backupCols.filter((c) => targetSet.has(c));
    const droppedCols = backupCols.filter((c) => !targetSet.has(c));
    if (projectedCols.length === 0) {
      warn(
        "[db] restoreUsageEventsBackup: no overlapping columns between backup and current schema — discarding %d row(s); dropped: %s",
        backup.length,
        droppedCols.join(", ") || "(none)",
      );
      return;
    }
    if (droppedCols.length > 0) {
      warn(
        "[db] restoreUsageEventsBackup: dropping columns no longer in usage_events schema: %s",
        droppedCols.join(", "),
      );
    }

    let restored = 0;
    let failed = 0;
    db.transaction(() => {
      const placeholders = projectedCols.map(() => "?").join(", ");
      const insert = db.prepare(`INSERT INTO usage_events (${projectedCols.join(", ")}) VALUES (${placeholders})`);
      for (const row of backup) {
        try {
          insert.run(...projectedCols.map((c) => row[c]));
          restored++;
        } catch {
          failed++;
        }
      }
    })();
    if (failed > 0) {
      warn("[db] restoreUsageEventsBackup: restored %d row(s); skipped %d incompatible row(s)", restored, failed);
    }
  } catch (err) {
    warn(
      "[db] restoreUsageEventsBackup: discarded %d backup row(s) — %s",
      backup.length,
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ── Meta helpers ────────────────────────────────────────────────────────────

export function getMeta(db: Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM index_meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)").run(key, value);
}

export function getIndexDirState(db: Database, dirPath: string): IndexDirState | undefined {
  const row = db
    .prepare(
      "SELECT dir_path, file_set_hash, file_mtime_max_ms, reason, updated_at FROM index_dir_state WHERE dir_path = ?",
    )
    .get(dirPath) as
    | {
        dir_path: string;
        file_set_hash: string;
        file_mtime_max_ms: number;
        reason: string;
        updated_at: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    dirPath: row.dir_path,
    fileSetHash: row.file_set_hash,
    fileMtimeMaxMs: row.file_mtime_max_ms,
    reason: row.reason,
    updatedAt: row.updated_at,
  };
}

export function upsertIndexDirState(
  db: Database,
  state: Pick<IndexDirState, "dirPath" | "fileSetHash" | "fileMtimeMaxMs" | "reason">,
): void {
  db.prepare(
    `INSERT INTO index_dir_state (dir_path, file_set_hash, file_mtime_max_ms, reason, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(dir_path) DO UPDATE SET
       file_set_hash = excluded.file_set_hash,
       file_mtime_max_ms = excluded.file_mtime_max_ms,
       reason = excluded.reason,
       updated_at = excluded.updated_at`,
  ).run(state.dirPath, state.fileSetHash, state.fileMtimeMaxMs, state.reason, new Date().toISOString());
}

export function deleteIndexDirState(db: Database, dirPath: string): void {
  db.prepare("DELETE FROM index_dir_state WHERE dir_path = ?").run(dirPath);
}

export function deleteIndexDirStatesByStashDir(db: Database, stashDir: string): void {
  db.prepare("DELETE FROM index_dir_state WHERE dir_path = ? OR dir_path LIKE ?").run(
    stashDir,
    `${stashDir}${path.sep}%`,
  );
}

// ── Entry operations ────────────────────────────────────────────────────────

/**
 * SQLite parameter chunk size — chosen well below SQLITE_MAX_VARIABLE_NUMBER
 * (default 999 on most builds) so multi-row `IN (?, ?, ...)` queries stay
 * within bounds. Shared by helpers below.
 */
const SQLITE_CHUNK_SIZE = 500;

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
  const result = stmts.upsert.get(
    entryKey,
    dirPath,
    filePath,
    stashDir,
    JSON.stringify(entry),
    searchText,
    entry.type,
    derivedFrom,
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
      INSERT INTO entries (entry_key, dir_path, file_path, stash_dir, entry_json, search_text, entry_type, derived_from)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entry_key) DO UPDATE SET
        dir_path = excluded.dir_path,
        file_path = excluded.file_path,
        stash_dir = excluded.stash_dir,
        entry_json = excluded.entry_json,
        search_text = excluded.search_text,
        entry_type = excluded.entry_type,
        derived_from = excluded.derived_from
      RETURNING id
    `),
    markDirty: db.prepare("INSERT OR IGNORE INTO entries_fts_dirty (entry_id) VALUES (?)"),
  };
  upsertStmtsByDb.set(db, stmts);
  return stmts;
}

/**
 * Phase 5A / DB v17 schema guard.
 *
 * Ensures the `entries.derived_from` column + index exist on the open
 * connection. Called from `ensureSchema()` after the entries CREATE so that
 * legacy databases (created against a pre-v17 binary but reopened without
 * triggering `handleVersionUpgrade()`) still gain the new column without
 * data loss. Idempotent: a `PRAGMA table_info` lookup gates the ALTER.
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
        `SELECT id, entry_key, dir_path, file_path, stash_dir, entry_json, search_text
         FROM entries
         WHERE derived_from = ?
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(parentRef) as
      | {
          id: number;
          entry_key: string;
          dir_path: string;
          file_path: string;
          stash_dir: string;
          entry_json: string;
          search_text: string;
        }
      | undefined;
    if (!row) return null;
    let entry: StashEntry;
    try {
      entry = JSON.parse(row.entry_json) as StashEntry;
    } catch {
      warn(`[db] getDerivedForParent: skipping entry id=${row.id} — corrupt entry_json`);
      return null;
    }
    return {
      id: row.id,
      entryKey: row.entry_key,
      dirPath: row.dir_path,
      filePath: row.file_path,
      stashDir: row.stash_dir,
      entry,
      searchText: row.search_text,
    };
  } catch {
    /* `derived_from` column may not exist on legacy DBs that haven't been
       rebuilt; treat as "no derived child". */
    return null;
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
      let entry: import("../passes/metadata").StashEntry;
      let fields: ReturnType<typeof buildSearchFields>;
      try {
        entry = JSON.parse(row.entry_json) as import("../passes/metadata").StashEntry;
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

// ── Vector operations ───────────────────────────────────────────────────────

export function upsertEmbedding(db: Database, entryId: number, embedding: EmbeddingVector): boolean {
  // Pre-flight FK guard: when an entry is deleted between when its id is queued
  // for embedding and when this INSERT runs (e.g. consolidation deletes during
  // a concurrent improve cycle), the INSERT throws "FOREIGN KEY constraint failed"
  // and rolls back the entire batch transaction in the caller, losing every
  // embedding for that run. A cheap SELECT here turns the race into a clean skip.
  const exists = db.prepare("SELECT 1 FROM entries WHERE id = ?").get(entryId);
  if (!exists) return false;

  const buf = float32Buffer(embedding);

  // Always write to BLOB table (works without sqlite-vec)
  db.prepare("INSERT OR REPLACE INTO embeddings (id, embedding) VALUES (?, ?)").run(entryId, buf);

  // Also write to sqlite-vec table when available (fast path).
  // Wrapped in a transaction so a crash between DELETE and INSERT does not
  // leave the entry missing from the vec table.
  if (isVecAvailable(db)) {
    bestEffort(() => {
      db.transaction(() => {
        db.prepare("DELETE FROM entries_vec WHERE id = ?").run(entryId);
        db.prepare("INSERT INTO entries_vec (id, embedding) VALUES (?, ?)").run(entryId, buf);
      })();
    }, "vec table unavailable or constraint failure");
  }
  return true;
}

export function searchVec(db: Database, queryEmbedding: EmbeddingVector, k: number): DbVecResult[] {
  // Fast path: use sqlite-vec when available
  if (isVecAvailable(db)) {
    const buf = float32Buffer(queryEmbedding);
    try {
      return db
        .prepare("SELECT id, distance FROM entries_vec WHERE embedding MATCH ? AND k = ?")
        .all(buf, k) as DbVecResult[];
    } catch (err) {
      // Log the failure so it's visible in diagnostics
      warn("[db] searchVec (sqlite-vec path) failed:", err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  // Fallback: JS-based cosine similarity over BLOB table
  return searchBlobVec(db, queryEmbedding, k);
}

/**
 * Return the k nearest neighbours of an already-indexed entry using its
 * persisted embedding — no re-embedding, no network. Decodes the stored BLOB by
 * byte length (dim = bytes / 4) and reuses searchVec (sqlite-vec fast path or
 * JS-cosine fallback). Returns [] when the entry has no stored embedding or the
 * BLOB is corrupt. The query entry itself is typically returned with distance
 * ~0 — callers should filter it out by id.
 */
export function getNeighborsByEntryId(db: Database, id: number, k: number): DbVecResult[] {
  const row = db.prepare("SELECT embedding FROM embeddings WHERE id = ?").get(id) as { embedding: Buffer } | undefined;
  if (!row) return [];
  const queryEmbedding = bufferToFloat32(row.embedding, Math.floor(row.embedding.byteLength / 4));
  if (!queryEmbedding) return [];
  return searchVec(db, queryEmbedding, k);
}

function float32Buffer(vec: number[]): Buffer {
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer);
}

/**
 * Decode a stored embedding BLOB into a Float32 array of `expectedDim`
 * dimensions. Returns `null` (and emits a warning) when the byte length does
 * not exactly match `expectedDim * 4`, including the legacy partial-trailing
 * float case the previous truncating-divide silently swallowed.
 *
 * BUG-M2: the previous `buf.byteLength / 4` divide would truncate any
 * trailing partial float and a misaligned `byteOffset` would throw — both
 * surfaced as opaque generic errors caught upstream.
 */
function bufferToFloat32(buf: Buffer, expectedDim: number): number[] | null {
  if (buf.byteLength !== expectedDim * 4) {
    warn(
      "[db] bufferToFloat32: skipping embedding row — expected %d bytes (%d dim x 4), got %d",
      expectedDim * 4,
      expectedDim,
      buf.byteLength,
    );
    return null;
  }
  // Copy into a fresh ArrayBuffer to sidestep any byteOffset alignment
  // requirements imposed by Float32Array's typed-array view contract.
  const aligned = new ArrayBuffer(buf.byteLength);
  new Uint8Array(aligned).set(buf);
  const f32 = new Float32Array(aligned);
  return Array.from(f32);
}

function searchBlobVec(db: Database, queryEmbedding: EmbeddingVector, k: number): DbVecResult[] {
  try {
    const rows = db.prepare("SELECT id, embedding FROM embeddings").all() as Array<{ id: number; embedding: Buffer }>;

    if (rows.length === 0) return [];

    const expectedDim = queryEmbedding.length;
    const scored: Array<{ id: number; similarity: number }> = [];
    for (const row of rows) {
      const embedding = bufferToFloat32(row.embedding, expectedDim);
      if (embedding === null) continue;
      const similarity = cosineSimilarity(queryEmbedding, embedding);
      scored.push({ id: row.id, similarity });
    }

    scored.sort((a, b) => b.similarity - a.similarity);

    // Convert cosine similarity to L2 distance for compatibility with sqlite-vec interface
    // For normalized vectors: L2² = 2(1 - cos_sim)
    return scored.slice(0, k).map(({ id, similarity }) => ({
      id,
      distance: Math.sqrt(2 * Math.max(0, 1 - similarity)),
    }));
  } catch (err) {
    // MD-5: Log the failure so it's visible in diagnostics
    warn("[db] searchBlobVec (JS fallback) failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

// ── FTS5 search ─────────────────────────────────────────────────────────────

export function searchFts(db: Database, query: string, limit: number, entryType?: string): DbSearchResult[] {
  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return [];

  // Try the exact AND query first
  const exactResults = runFtsQuery(db, ftsQuery, limit, entryType);
  if (exactResults.length > 0) return exactResults;

  // Exact match returned zero results — try prefix fallback.
  // Append FTS5 `*` suffix to each token that is >= 3 characters long.
  // Short tokens (1-2 chars) are excluded from prefix expansion because
  // they produce too many false positives.
  const prefixQuery = buildPrefixQuery(ftsQuery);
  if (!prefixQuery) return [];

  return runFtsQuery(db, prefixQuery, limit, entryType);
}

/**
 * Build a prefix query from an FTS5 query string by appending `*` to each
 * token that is 3+ characters long. Tokens shorter than 3 characters are
 * kept as-is (no prefix expansion) to avoid overly broad matches.
 *
 * Returns null if no tokens qualify for prefix expansion.
 */
function buildPrefixQuery(ftsQuery: string): string | null {
  const tokens = ftsQuery.split(/\s+/).filter(Boolean);
  let hasPrefix = false;

  const prefixTokens = tokens.map((t) => {
    if (t.length >= 3) {
      hasPrefix = true;
      return `${t}*`;
    }
    return t;
  });

  if (!hasPrefix) return null;

  return prefixTokens.join(" ");
}

function runFtsQuery(db: Database, ftsQuery: string, limit: number, entryType?: string): DbSearchResult[] {
  let sql: string;
  let params: unknown[];

  // Join on integer entry_id directly (no CAST needed; we store integer)
  // Use bm25() with per-column weights: entry_id(0), name(10), description(5), tags(3), hints(2), content(1)
  if (entryType && entryType !== "any") {
    sql = `
      SELECT e.id, e.file_path AS filePath, e.entry_json, e.search_text AS searchText,
             bm25(entries_fts, 0, 10.0, 5.0, 3.0, 2.0, 1.0) AS bm25Score
      FROM entries_fts f
      JOIN entries e ON e.id = f.entry_id
      WHERE entries_fts MATCH ?
        AND e.entry_type = ?
      ORDER BY bm25Score, e.id ASC
      LIMIT ?
    `;
    params = [ftsQuery, entryType, limit];
  } else {
    sql = `
      SELECT e.id, e.file_path AS filePath, e.entry_json, e.search_text AS searchText,
             bm25(entries_fts, 0, 10.0, 5.0, 3.0, 2.0, 1.0) AS bm25Score
      FROM entries_fts f
      JOIN entries e ON e.id = f.entry_id
      WHERE entries_fts MATCH ?
      ORDER BY bm25Score, e.id ASC
      LIMIT ?
    `;
    params = [ftsQuery, limit];
  }

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
  } catch {
    return [];
  }
}

export function sanitizeFtsQuery(query: string): string {
  // Allow only characters safe in FTS5 queries: letters, digits, underscores,
  // and whitespace. Everything else (hyphens, dots, quotes, parens, asterisks,
  // colons, carets, @, !, etc.) is replaced with a space so that compound
  // identifiers like "code-review" or "k8s.setup" become AND-joined tokens
  // ("code review", "k8s setup") rather than triggering FTS5 syntax errors.
  let sanitized = query.replace(/[^a-zA-Z0-9_\s]/g, " ");

  // Neutralize the NEAR operator (FTS5 proximity syntax)
  sanitized = sanitized.replace(/\bNEAR\b/g, " ");

  const tokens = sanitized.split(/\s+/).filter((t) => t.length >= 1);

  if (tokens.length === 0) return "";

  // Use implicit AND (space-separated tokens) for precision. FTS5 treats
  // space-separated tokens as an implicit AND, matching only rows that
  // contain ALL terms.
  return tokens.join(" ");
}

// ── All entries ─────────────────────────────────────────────────────────────

type EntryRow = {
  id: number;
  entry_key: string;
  dir_path: string;
  file_path: string;
  stash_dir: string;
  entry_json: string;
  search_text: string;
};

function parseEntryRows(rows: Array<Record<string, unknown>>, context: string): DbIndexedEntry[] {
  const entries: DbIndexedEntry[] = [];
  for (const row of rows as EntryRow[]) {
    let entry: StashEntry;
    try {
      entry = JSON.parse(row.entry_json) as StashEntry;
    } catch {
      warn(`[db] ${context}: skipping entry id=${row.id} — corrupt entry_json`);
      continue;
    }
    entries.push({
      id: row.id,
      entryKey: row.entry_key,
      dirPath: row.dir_path,
      filePath: row.file_path,
      stashDir: row.stash_dir,
      entry,
      searchText: row.search_text,
    });
  }
  return entries;
}

export function getAllEntries(db: Database, entryType?: string): DbIndexedEntry[] {
  let sql: string;
  let params: unknown[];

  if (entryType && entryType !== "any") {
    sql =
      "SELECT id, entry_key, dir_path, file_path, stash_dir, entry_json, search_text FROM entries WHERE entry_type = ?";
    params = [entryType];
  } else {
    sql = "SELECT id, entry_key, dir_path, file_path, stash_dir, entry_json, search_text FROM entries";
    params = [];
  }

  const rows = db.prepare(sql).all(...(params as SqlValue[])) as Array<Record<string, unknown>>;
  return parseEntryRows(rows, "getAllEntries");
}

export function findEntryIdByRef(db: Database, ref: string): number | undefined {
  const parsed = parseAssetRef(ref);
  const nameVariants = [parsed.name];
  if (parsed.name.endsWith(".md")) {
    nameVariants.push(parsed.name.slice(0, -3));
  } else {
    nameVariants.push(`${parsed.name}.md`);
  }

  const stmt = db.prepare(
    "SELECT id FROM entries WHERE entry_type = ? AND substr(entry_key, length(entry_key) - length(?) + 1) = ? LIMIT 1",
  );

  for (const name of nameVariants) {
    const suffix = `${parsed.type}:${name}`;
    const row = stmt.get(parsed.type, suffix, suffix) as { id: number } | undefined;
    if (row) return row.id;
  }

  return undefined;
}

export function getEntryCount(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM entries").get() as { cnt: number };
  return row.cnt;
}

export function getEmbeddableEntryCount(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM entries").get() as {
    cnt: number;
  };
  return row.cnt;
}

export function getEmbeddingCount(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM embeddings").get() as { cnt: number };
  return row.cnt;
}

export function getEntryById(db: Database, id: number): { filePath: string; entry: StashEntry } | undefined {
  const row = db.prepare("SELECT file_path, entry_json FROM entries WHERE id = ?").get(id) as
    | { file_path: string; entry_json: string }
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
  return { filePath: row.file_path, entry };
}

export function getEntriesByDir(db: Database, dirPath: string): DbIndexedEntry[] {
  const rows = db
    .prepare(
      "SELECT id, entry_key, dir_path, file_path, stash_dir, entry_json, search_text FROM entries WHERE dir_path = ?",
    )
    .all(dirPath) as Array<Record<string, unknown>>;
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

/** A raw `(file_path, entry_json)` pair from the `entries` table. */
export interface EntryRefRow {
  file_path: string;
  entry_json: string;
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

// ── Utility score operations ────────────────────────────────────────────────

export interface UtilityScoreData {
  utility: number;
  showCount: number;
  searchCount: number;
  selectRate: number;
  lastUsedAt?: string;
}

export interface UtilityScoreRow extends UtilityScoreData {
  entryId: number;
  updatedAt: string;
}

/**
 * Get the utility score for an entry, or undefined if none exists.
 */
export function getUtilityScore(db: Database, entryId: number): UtilityScoreRow | undefined {
  const row = db
    .prepare(
      "SELECT entry_id, utility, show_count, search_count, select_rate, last_used_at, updated_at FROM utility_scores WHERE entry_id = ?",
    )
    .get(entryId) as
    | {
        entry_id: number;
        utility: number;
        show_count: number;
        search_count: number;
        select_rate: number;
        last_used_at: string | null;
        updated_at: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    entryId: row.entry_id,
    utility: row.utility,
    showCount: row.show_count,
    searchCount: row.search_count,
    selectRate: row.select_rate,
    lastUsedAt: row.last_used_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

/**
 * A single row from `utility_scores_scoped`.
 */
export interface ScopedUtilityRow {
  entryId: number;
  scopeKey: string;
  utility: number;
  lastUsedAt: number;
}

/**
 * Batch-load utility scores for multiple entry IDs in a single query.
 * Returns a `{ global, scoped }` pair, both Maps keyed by entry_id.
 *
 * When `scopeKey` is provided a second query runs against
 * `utility_scores_scoped` and the result is returned as `scoped`.
 * Both maps are always present; `scoped` is empty when `scopeKey` is absent.
 */
export function getUtilityScoresByIds(
  db: Database,
  ids: number[],
  scopeKey?: string,
): { global: Map<number, UtilityScoreRow>; scoped: Map<number, ScopedUtilityRow> } {
  const global = new Map<number, UtilityScoreRow>();
  const scoped = new Map<number, ScopedUtilityRow>();
  if (ids.length === 0) return { global, scoped };
  // Process in chunks to stay within SQLITE_MAX_VARIABLE_NUMBER
  for (let i = 0; i < ids.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT entry_id, utility, show_count, search_count, select_rate, last_used_at, updated_at FROM utility_scores WHERE entry_id IN (${placeholders})`,
      )
      .all(...chunk) as Array<{
      entry_id: number;
      utility: number;
      show_count: number;
      search_count: number;
      select_rate: number;
      last_used_at: string | null;
      updated_at: string;
    }>;
    for (const row of rows) {
      global.set(row.entry_id, {
        entryId: row.entry_id,
        utility: row.utility,
        showCount: row.show_count,
        searchCount: row.search_count,
        selectRate: row.select_rate,
        lastUsedAt: row.last_used_at ?? undefined,
        updatedAt: row.updated_at,
      });
    }
    if (scopeKey) {
      const scopedRows = db
        .prepare(
          `SELECT entry_id, scope_key, utility, last_used_at FROM utility_scores_scoped WHERE scope_key = ? AND entry_id IN (${placeholders})`,
        )
        .all(scopeKey, ...chunk) as Array<{
        entry_id: number;
        scope_key: string;
        utility: number;
        last_used_at: number;
      }>;
      for (const row of scopedRows) {
        scoped.set(row.entry_id, {
          entryId: row.entry_id,
          scopeKey: row.scope_key,
          utility: row.utility,
          lastUsedAt: row.last_used_at,
        });
      }
    }
  }
  return { global, scoped };
}

/**
 * Insert or update a utility score for an entry.
 */
export function upsertUtilityScore(db: Database, entryId: number, data: UtilityScoreData): boolean {
  // Pre-flight FK guard (mirrors `upsertEmbedding`): when an entry is
  // deleted between when its id is aggregated from usage_events and when
  // this INSERT runs, the FK constraint fails and rolls back the entire
  // finalize transaction. A cheap SELECT here turns the race into a
  // clean skip. Returns false when the entry no longer exists.
  const exists = db.prepare("SELECT 1 FROM entries WHERE id = ?").get(entryId);
  if (!exists) return false;

  db.prepare(`
    INSERT INTO utility_scores (entry_id, utility, show_count, search_count, select_rate, last_used_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(entry_id) DO UPDATE SET
      utility = excluded.utility,
      show_count = excluded.show_count,
      search_count = excluded.search_count,
      select_rate = excluded.select_rate,
      last_used_at = excluded.last_used_at,
      updated_at = datetime('now')
  `).run(entryId, data.utility, data.showCount, data.searchCount, data.selectRate, data.lastUsedAt ?? null);
  return true;
}

// ── LLM enrichment cache ────────────────────────────────────────────────────

/**
 * A cached LLM enrichment result keyed by a stable asset_ref string.
 * The body_hash (SHA-256 hex) guards against stale results when the
 * underlying file changes between index runs.
 */
export interface LlmCacheEntry {
  assetRef: string;
  cacheVariant: string;
  bodyHash: string;
  resultJson: string;
  updatedAt: number;
}

/**
 * Look up a cached LLM result for the given asset_ref.
 *
 * Returns `undefined` when no entry exists OR when the stored body_hash
 * doesn't match `currentBodyHash` (body has changed since the result was
 * cached). In both cases the caller should invoke the LLM and write a new
 * cache entry.
 */
export function getLlmCacheEntry(
  db: Database,
  assetRef: string,
  currentBodyHash: string,
  cacheVariant = "",
): LlmCacheEntry | undefined {
  const row = db
    .prepare(
      "SELECT asset_ref, cache_variant, body_hash, result_json, updated_at FROM llm_enrichment_cache WHERE asset_ref = ? AND cache_variant = ?",
    )
    .get(assetRef, cacheVariant) as
    | { asset_ref: string; cache_variant: string; body_hash: string; result_json: string; updated_at: number }
    | undefined;
  if (!row) return undefined;
  // Hash mismatch → body changed, treat as cache miss.
  if (row.body_hash !== currentBodyHash) return undefined;
  return {
    assetRef: row.asset_ref,
    cacheVariant: row.cache_variant,
    bodyHash: row.body_hash,
    resultJson: row.result_json,
    updatedAt: row.updated_at,
  };
}

/**
 * Batched variant of {@link getLlmCacheEntry}. Fetches every cache row whose
 * `asset_ref` is in `refs` with a single `IN (...)` query (chunked to respect
 * SQLITE_MAX_VARIABLE_NUMBER), returning a `Map<assetRef, LlmCacheEntry>`.
 *
 * Unlike `getLlmCacheEntry`, this does NOT filter by body hash — callers must
 * compare `entry.bodyHash` against the current body hash themselves. This lets
 * the batch path issue one DB query per chunk instead of one per file.
 */
export function getLlmCacheEntriesByRefs(db: Database, refs: string[], cacheVariant = ""): Map<string, LlmCacheEntry> {
  const result = new Map<string, LlmCacheEntry>();
  if (refs.length === 0) return result;
  for (let i = 0; i < refs.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = refs.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT asset_ref, cache_variant, body_hash, result_json, updated_at FROM llm_enrichment_cache
         WHERE cache_variant = ? AND asset_ref IN (${placeholders})`,
      )
      .all(cacheVariant, ...(chunk as SqlValue[])) as Array<{
      asset_ref: string;
      cache_variant: string;
      body_hash: string;
      result_json: string;
      updated_at: number;
    }>;
    for (const row of rows) {
      result.set(row.asset_ref, {
        assetRef: row.asset_ref,
        cacheVariant: row.cache_variant,
        bodyHash: row.body_hash,
        resultJson: row.result_json,
        updatedAt: row.updated_at,
      });
    }
  }
  return result;
}

/**
 * Insert or update a cached LLM result for the given asset_ref.
 */
export function upsertLlmCacheEntry(
  db: Database,
  assetRef: string,
  bodyHash: string,
  resultJson: string,
  cacheVariant = "",
): void {
  db.prepare(
    `INSERT INTO llm_enrichment_cache (asset_ref, cache_variant, body_hash, result_json, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(asset_ref, cache_variant) DO UPDATE SET
        body_hash   = excluded.body_hash,
        result_json = excluded.result_json,
        updated_at  = excluded.updated_at`,
  ).run(assetRef, cacheVariant, bodyHash, resultJson, Date.now());
}

/**
 * Delete LLM cache entries whose asset_ref is no longer present in the
 * `entries` table. Should be called during the cleanup phase of each index
 * run to prevent the cache from growing unboundedly as assets are removed.
 *
 * The join uses a LIKE match against the entries `file_path` column because
 * graph/memory cache refs are absolute file paths, while enrichment cache
 * refs are entry_key strings — we preserve any entry that still has a
 * corresponding row in either the entries table (by entry_key) or that
 * matches a live file_path.
 */
export function clearStaleCacheEntries(db: Database): void {
  bestEffort(() => {
    db.exec(`
      DELETE FROM llm_enrichment_cache
      WHERE asset_ref NOT IN (SELECT file_path FROM entries)
        AND asset_ref NOT IN (SELECT entry_key FROM entries)
    `);
  }, "llm_enrichment_cache may not exist in very old DBs opened without ensureSchema");
}

/**
 * Compute a stable SHA-256 hex digest of a UTF-8 string using Bun's native
 * hashing. Used as the body_hash key in `llm_enrichment_cache`.
 *
 * Bun.CryptoHasher is synchronous and allocation-free compared to Web Crypto,
 * making it suitable for use inside tight per-asset loops.
 */
export function computeBodyHash(body: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(body);
  return hasher.digest("hex");
}

/**
 * Count search and show events for the given entry refs.
 * Returns a Map<ref, count> with only refs that have at least one event.
 * Used by the improve loop to find high-retrieval assets without feedback.
 */
export function getRetrievalCounts(db: Database, refs: string[]): Map<string, number> {
  if (refs.length === 0) return new Map();
  const result = new Map<string, number>();
  // Chunk to stay within SQLITE_MAX_VARIABLE_NUMBER (same pattern as getUtilityScoresByIds).
  for (let i = 0; i < refs.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = refs.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT entry_ref, COUNT(*) AS cnt FROM usage_events
         WHERE event_type IN ('search','show') AND entry_ref IN (${placeholders})
         GROUP BY entry_ref`,
      )
      .all(...(chunk as SqlValue[])) as Array<{ entry_ref: string; cnt: number }>;
    for (const r of rows) result.set(r.entry_ref, r.cnt);
  }
  return result;
}

/**
 * Apply a MemRL reward signal to a batch of entries via exponential moving
 * average (EMA): next = clamp(current + lr * (reward - current), 0, 1).
 *
 * Wrapped in a single transaction so all bumps succeed or fail together.
 * The indexer (`akm index`) will overwrite these values at next reindex run;
 * bumps are intentionally temporary hints between index runs, not permanent
 * overrides.
 *
 * When `scopeKey` is provided, also writes a scoped bump to
 * `utility_scores_scoped` so per-project usage signals accumulate alongside
 * the global ones. The global table is always updated regardless.
 */
export function bumpUtilityScoresBatch(
  db: Database,
  entryIds: number[],
  reward: number,
  lr = 0.1,
  scopeKey?: string,
): void {
  if (entryIds.length === 0) return;
  db.transaction(() => {
    const { global: scoreMap } = getUtilityScoresByIds(db, entryIds);
    const now = new Date().toISOString();
    const nowMs = Date.now();
    const stmt = db.prepare(
      `INSERT INTO utility_scores (entry_id, utility, show_count, search_count, select_rate, last_used_at, updated_at)
       VALUES (?, ?, 0, 0, 0, ?, ?)
       ON CONFLICT(entry_id) DO UPDATE SET
         utility = excluded.utility,
         updated_at = excluded.updated_at`,
    );
    // Prepare scoped upsert once outside the loop when scopeKey is present.
    const scopedStmt = scopeKey
      ? db.prepare(
          `INSERT INTO utility_scores_scoped (entry_id, scope_key, utility, last_used_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(entry_id, scope_key) DO UPDATE SET
             utility = excluded.utility,
             last_used_at = excluded.last_used_at`,
        )
      : null;
    for (const entryId of entryIds) {
      const existing = scoreMap.get(entryId);
      const current = existing?.utility ?? 0;
      const next = Math.max(0, Math.min(1, current + lr * (reward - current)));
      stmt.run(entryId, next, now, now);
      if (scopedStmt && scopeKey) {
        // Retrieve the current scoped utility so we can apply the same EMA.
        const scopedCurrent = getScopedUtility(db, entryId, scopeKey);
        const scopedNext = Math.max(0, Math.min(1, scopedCurrent + lr * (reward - scopedCurrent)));
        scopedStmt.run(entryId, scopeKey, scopedNext, nowMs);
      }
    }
  })();
}

/**
 * Return the current utility value for a single (entry_id, scope_key) pair.
 * Returns 0 when no row exists yet.
 */
function getScopedUtility(db: Database, entryId: number, scopeKey: string): number {
  const row = db
    .prepare("SELECT utility FROM utility_scores_scoped WHERE entry_id = ? AND scope_key = ?")
    .get(entryId, scopeKey) as { utility: number } | undefined;
  return row?.utility ?? 0;
}

// ── Indexer-phase helpers (moved from indexer.ts) ────────────────────────────

/**
 * Return all entries that do not yet have an embedding row.
 * Used by the embedding phase to determine which entries need vectors generated.
 */
export function getAllEntriesForEmbedding(
  db: Database,
): Array<{ id: number; searchText: string; entryKey: string; filePath: string }> {
  return db
    .prepare(`
      SELECT e.id, e.search_text AS searchText, e.entry_key AS entryKey, e.file_path AS filePath FROM entries e
      WHERE NOT EXISTS (SELECT 1 FROM embeddings b WHERE b.id = e.id)
    `)
    .all() as Array<{ id: number; searchText: string; entryKey: string; filePath: string }>;
}

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
 * MemRL learning rate for feedback-driven utility updates (F-5 / #386).
 *
 * Follows the bounded-step formula from MemRL (arXiv:2601.03192):
 *   next = clamp(current + lr × (reward − current), 0, 1)
 *
 * This replaces the unbounded `-0.03 × negativeCount` delta that could
 * silently remove high-utility assets from the improvement loop.
 */
const FEEDBACK_LR = 0.1;

/**
 * Positive reward signal for a single positive feedback event.
 * Reward 1.0 means "fully correct / helpful".
 */
const FEEDBACK_REWARD_POSITIVE = 1.0;

/**
 * Negative reward signal for a single negative feedback event.
 * Reward 0.0 means "not helpful" (lowest MemRL signal).
 */
const FEEDBACK_REWARD_NEGATIVE = 0.0;

/**
 * Maximum total negative utility delta allowed in a single
 * `applyFeedbackToUtilityScore` call regardless of negativeCount.
 *
 * This caps the per-day negative impact (the function is called once per
 * feedback event — spamming 10 negatives in one session can move utility
 * at most `MAX_NEG_DELTA_PER_CALL`). The cap prevents a noisy negative-
 * feedback stream from silently destroying a high-utility asset's ranking.
 */
const MAX_NEG_DELTA_PER_CALL = 0.15;

/**
 * Utility threshold below which a review-needed escalation is triggered.
 * When a previously high-utility asset (≥ HIGH_UTILITY_THRESHOLD) drops
 * below this value, the caller should create an escalation proposal.
 */
export const UTILITY_REVIEW_THRESHOLD = 0.5;

/**
 * Utility level considered "high" — assets above this are tracked for
 * threshold-crossing escalation.
 */
export const HIGH_UTILITY_THRESHOLD = 0.5;

/**
 * Result returned by {@link applyFeedbackToUtilityScore} (F-5 / #386).
 *
 * When `crossedReviewThreshold` is true the asset was previously at or above
 * {@link HIGH_UTILITY_THRESHOLD} and is now below {@link UTILITY_REVIEW_THRESHOLD}.
 * The caller should create a review-needed escalation proposal.
 */
export interface FeedbackUtilityResult {
  /** Utility value before the update. */
  previousUtility: number;
  /** Utility value after the update. */
  nextUtility: number;
  /** True when the update caused a high-utility asset to cross below the review threshold. */
  crossedReviewThreshold: boolean;
}

/**
 * Apply accumulated feedback counts to the utility score of an entry using the
 * MemRL bounded-step EMA formula (F-5 / #386, arXiv:2601.03192).
 *
 * Replaces the previous unbounded `-0.03 × negativeCount` formula with:
 *
 *   reward   = weighted average of positive and negative signals
 *   nextUtil = clamp(currentUtil + lr × (reward − currentUtil), 0, 1)
 *
 * The negative impact is additionally capped at {@link MAX_NEG_DELTA_PER_CALL}
 * to prevent a noisy feedback stream from silently erasing a high-utility asset.
 *
 * A new entry starts at 0.5 (neutral midpoint) before the EMA step is applied.
 *
 * Returns a {@link FeedbackUtilityResult} so the caller can detect when a
 * previously high-utility asset crosses below the review threshold and create
 * an escalation proposal.
 */
export function applyFeedbackToUtilityScore(
  db: Database,
  entryId: number,
  positiveCount: number,
  negativeCount: number,
): FeedbackUtilityResult {
  const existing = getUtilityScore(db, entryId);
  const previousUtility = existing?.utility ?? 0.5;

  if (positiveCount === 0 && negativeCount === 0) {
    return { previousUtility, nextUtility: previousUtility, crossedReviewThreshold: false };
  }

  const total = positiveCount + negativeCount;
  // Weighted reward: proportion of positive signals.
  const reward =
    positiveCount > 0 && negativeCount === 0
      ? FEEDBACK_REWARD_POSITIVE
      : negativeCount > 0 && positiveCount === 0
        ? FEEDBACK_REWARD_NEGATIVE
        : (positiveCount * FEEDBACK_REWARD_POSITIVE + negativeCount * FEEDBACK_REWARD_NEGATIVE) / total;

  // MemRL bounded-step EMA: lr × (reward − current)
  let delta = FEEDBACK_LR * (reward - previousUtility);

  // Per-call negative cap: if delta is negative (net negative feedback), cap it.
  if (delta < 0) {
    delta = Math.max(delta, -MAX_NEG_DELTA_PER_CALL);
  }

  const nextUtility = Math.max(0, Math.min(1, previousUtility + delta));

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO utility_scores (entry_id, utility, show_count, search_count, select_rate, last_used_at, updated_at)
    VALUES (?, ?, 0, 0, 0, ?, ?)
    ON CONFLICT(entry_id) DO UPDATE SET
      utility    = ?,
      updated_at = ?
  `).run(entryId, nextUtility, now, now, nextUtility, now);

  const crossedReviewThreshold = previousUtility >= HIGH_UTILITY_THRESHOLD && nextUtility < UTILITY_REVIEW_THRESHOLD;
  return { previousUtility, nextUtility, crossedReviewThreshold };
}

/**
 * Re-link detached usage_events to their current entry_ids via entry_ref.
 *
 * After a full rebuild, entry IDs change. This query matches events to their
 * new entry rows using the stable `entry_ref` ("type:name") column so usage
 * history survives a full reindex.
 */
export function relinkUsageEvents(db: Database): void {
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

    // Step 2: re-resolve any null entry_id from entry_ref against the
    // current entries table. Picks up entries that were re-created with
    // the same ref (e.g. an asset moved between sources).
    db.exec(`
      UPDATE usage_events SET entry_id = (
        SELECT e.id FROM entries e
        WHERE substr(e.entry_key, length(e.entry_key) - length(usage_events.entry_ref)) = ':' || usage_events.entry_ref
        LIMIT 1
      )
      WHERE entry_id IS NULL AND entry_ref IS NOT NULL
    `);
  }, "usage_events table may not exist yet during entry_id re-resolution");
}

// ── registry_index_cache helpers ─────────────────────────────────────────────

/**
 * Upsert a registry index cache entry in index.db.
 *
 * @param db          - Open index.db connection (from openDatabase / openExistingDatabase).
 * @param registryUrl - Canonical URL of the registry (used as primary key).
 * @param indexJson   - Serialised registry index document (JSON string).
 * @param opts.etag        - HTTP ETag from the response (optional).
 * @param opts.lastModified - HTTP Last-Modified from the response (optional).
 */
export function upsertRegistryIndexCache(
  db: Database,
  registryUrl: string,
  indexJson: string,
  opts?: { etag?: string; lastModified?: string },
): void {
  db.prepare(`
    INSERT INTO registry_index_cache (registry_url, fetched_at, etag, last_modified, index_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(registry_url) DO UPDATE SET
      fetched_at    = excluded.fetched_at,
      etag          = excluded.etag,
      last_modified = excluded.last_modified,
      index_json    = excluded.index_json
  `).run(registryUrl, new Date().toISOString(), opts?.etag ?? null, opts?.lastModified ?? null, indexJson);
}

/**
 * Look up a cached registry index entry from index.db.
 * Returns undefined when not found or when the entry is older than `maxAgeMs`.
 *
 * TTL check: if `Date.now() - new Date(fetched_at).getTime() > maxAgeMs` the
 * entry is considered a cache miss and undefined is returned.
 *
 * @param db          - Open index.db connection.
 * @param registryUrl - Canonical URL of the registry (primary key).
 * @param maxAgeMs    - Maximum age in milliseconds before the entry is stale (default: 1 hour).
 */
export function getRegistryIndexCache(
  db: Database,
  registryUrl: string,
  maxAgeMs = 3_600_000 /* 1 hour */,
): { indexJson: string; etag: string | null; lastModified: string | null } | undefined {
  const row = db
    .prepare(
      `SELECT fetched_at, etag, last_modified, index_json
       FROM registry_index_cache WHERE registry_url = ?`,
    )
    .get(registryUrl) as
    | { fetched_at: string; etag: string | null; last_modified: string | null; index_json: string }
    | undefined;

  if (!row) return undefined;

  const fetchedAt = Date.parse(row.fetched_at);
  if (Number.isNaN(fetchedAt) || Date.now() - fetchedAt > maxAgeMs) return undefined;

  return { indexJson: row.index_json, etag: row.etag, lastModified: row.last_modified };
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
