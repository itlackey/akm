// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The derived `entries` layout: DDL plus the layout marker.
 *
 * `index_meta.version` is a layout marker, not a compatibility gate. Nothing
 * refuses an index over it: readers serve what is there, and the writable
 * opener (`ensureSchema`, `index-schema.ts`) brings an older layout up to date
 * in place — additive columns and a one-time full-text rebuild — without
 * touching embeddings, utility scores, graph rows, or the LLM enrichment cache.
 */

// 24: the FTS5 tables are contentless (`content=''`) — the indexed text lives
// once, in `entries` / `entry_fragments`, and FTS rows are keyed by rowid only.
// 23 and earlier stored a second copy of every indexed field in FTS5's own
// content shadow tables. `ensureFtsLayout` (index-schema.ts) rebuilds the FTS
// tables from the stored entries when it finds the older layout.
export const CANONICAL_INDEX_DB_VERSION = 24;

export const CANONICAL_ENTRY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS entries (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    item_ref      TEXT NOT NULL UNIQUE,
    bundle_id     TEXT NOT NULL,
    component_id  TEXT NOT NULL,
    concept_id    TEXT NOT NULL,
    adapter_id    TEXT NOT NULL,
    type          TEXT NOT NULL,
    file_path     TEXT NOT NULL,
    content_hash  TEXT,
    document_json TEXT NOT NULL,
    search_text   TEXT NOT NULL,
    derived_from  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_entries_bundle ON entries(bundle_id);
  CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(type);
  CREATE INDEX IF NOT EXISTS idx_entries_file_path ON entries(file_path);
  CREATE INDEX IF NOT EXISTS idx_entries_derived_from ON entries(derived_from);

  CREATE TABLE IF NOT EXISTS entry_fragments (
    entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
    safe_markdown TEXT NOT NULL
  );
`;

// Both FTS tables are contentless: FTS5 keeps only the inverted index, and a
// row is addressed by its rowid (`entries_fts.rowid = entries.id`;
// `entry_fragments_fts.rowid = entries.id * 2^20 + fragment ordinal`, see
// index-fts-repository.ts). `contentless_delete=1` lets a row be deleted by
// rowid alone — an external-content table would instead need the exact text
// originally indexed, which is derived in JS from `document_json`
// (`buildSearchFields`) and would corrupt the index the first time that
// derivation changed. The UNINDEXED columns store nothing and read back NULL;
// they stay declared so the insert statements and the readers'
// `COALESCE(f.entry_id, f.rowid)` joins are valid against both this layout
// and the content-bearing one older releases wrote — which is also the
// layout written when the linked SQLite predates `contentless_delete` (3.43,
// e.g. the macOS 13 system library Bun links there).
//
// Parent metadata and body fragments are separate FTS populations on purpose:
// combining them changes parent-document IDF and conjunction semantics.
const CONTENTLESS_OPTIONS = "content='', contentless_delete=1,";

export function entriesFtsDdl(contentless: boolean): string {
  return `
  CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
    entry_id UNINDEXED, name, description, tags, hints, content,
    ${contentless ? CONTENTLESS_OPTIONS : ""} tokenize='porter unicode61'
  );`;
}

export function fragmentsFtsDdl(contentless: boolean): string {
  return `
  CREATE VIRTUAL TABLE IF NOT EXISTS entry_fragments_fts USING fts5(
    entry_id UNINDEXED, fragment_id UNINDEXED, fragment_ordinal UNINDEXED, content,
    ${contentless ? CONTENTLESS_OPTIONS : ""} tokenize='porter unicode61'
  );`;
}

/** Whether the linked SQLite's FTS5 supports `contentless_delete` (3.43.0+). */
export function supportsContentlessDelete(db: EntrySchemaInspectionDatabase): boolean {
  const version = (db.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version;
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 3 || (major === 3 && minor >= 43);
}

/** Minimal read-only statement surface shared by bun:sqlite and AKM's runtime-neutral handle. */
export interface EntrySchemaInspectionDatabase {
  prepare(sql: string): {
    all(): unknown[];
    get(): unknown;
  };
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function readTableSql(db: EntrySchemaInspectionDatabase, name: string): string | null {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${sqlString(name)}`).get() as
    | { sql: string | null }
    | null
    | undefined;
  return row?.sql ?? null;
}

export function tableExists(db: EntrySchemaInspectionDatabase, name: string): boolean {
  return readTableSql(db, name) !== null;
}

/** Columns every `entries` row carries for this release's readers and writers (layout 21+). */
const REQUIRED_ENTRY_COLUMNS = [
  "id",
  "item_ref",
  "bundle_id",
  "component_id",
  "concept_id",
  "adapter_id",
  "type",
  "file_path",
  "content_hash",
  "document_json",
  "search_text",
  "derived_from",
] as const;

/** Required `entries` columns the table lacks; every column when there is no `entries` table. */
export function missingEntryColumns(db: EntrySchemaInspectionDatabase): string[] {
  const present = new Set(
    (db.prepare("PRAGMA table_info(entries)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  return REQUIRED_ENTRY_COLUMNS.filter((column) => !present.has(column));
}

/**
 * Whether an index database has an `entries` table this release can read. A
 * fresh or empty file has none; an index older than layout 21 has one keyed
 * by columns this release no longer reads, and serves nothing until the next
 * `akm index` recreates it.
 */
export function hasCurrentEntriesTable(db: EntrySchemaInspectionDatabase): boolean {
  try {
    return missingEntryColumns(db).length === 0;
  } catch {
    return false;
  }
}

/** True when an FTS5 table's DDL declares the contentless layout this release writes. */
export function isContentlessFtsDdl(sql: string | null): boolean {
  return sql !== null && /content\s*=\s*''/.test(sql);
}
