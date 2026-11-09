// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The derived `entries` layout: DDL plus the layout marker.
 *
 * `index_meta.version` is a layout marker. There is no in-place upgrade: an
 * index below {@link MIN_INDEX_LAYOUT} is deleted and rebuilt by the writable
 * opener (`openIndexDatabase`), and readers treat it as unservable
 * ({@link hasCurrentEntriesTable}). A newer layout is refused, naming the
 * upgrade.
 */

// 26: declared links (#935) live in `asset_links`, one row per link, owned by
// the entry that declares it; vectors live only in `embeddings`; `entries`
// keeps a hash of each entry's embedding input (`embed_hash`); the FTS5 table
// is contentless (`content=''`) where the linked SQLite supports it.
export const CANONICAL_INDEX_DB_VERSION = 26;

/** The oldest layout a writable open accepts; anything older is rebuilt from the sources. */
export const MIN_INDEX_LAYOUT = 26;

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
    derived_from  TEXT,
    embed_hash    TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_entries_bundle ON entries(bundle_id);
  CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(type);
  CREATE INDEX IF NOT EXISTS idx_entries_file_path ON entries(file_path);
  CREATE INDEX IF NOT EXISTS idx_entries_derived_from ON entries(derived_from);

  CREATE TABLE IF NOT EXISTS entry_fragments (
    entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
    safe_markdown TEXT NOT NULL
  );

  -- Declared links (#935). dst_bundle NULL: the declaring entry's own bundle.
  CREATE TABLE IF NOT EXISTS asset_links (
    entry_id    INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    ord         INTEGER NOT NULL,
    kind        TEXT NOT NULL,
    raw         TEXT NOT NULL,
    dst_bundle  TEXT,
    dst_concept TEXT NOT NULL,
    PRIMARY KEY (entry_id, ord)
  ) WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS idx_asset_links_dst ON asset_links(dst_concept);
`;

// The FTS table is contentless: FTS5 keeps only the inverted index, and a row
// is addressed by its rowid (`entries_fts.rowid = entries.id`, see
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
const CONTENTLESS_OPTIONS = "content='', contentless_delete=1,";

export function entriesFtsDdl(contentless: boolean): string {
  return `
  CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
    entry_id UNINDEXED, name, description, tags, hints, content,
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

/**
 * Whether an index database has an `entries` table this release can read: one
 * written at {@link MIN_INDEX_LAYOUT} or later. A fresh or empty file, or an
 * older layout, serves nothing until the next `akm index` rebuilds it.
 */
export function hasCurrentEntriesTable(db: EntrySchemaInspectionDatabase): boolean {
  try {
    const row = db.prepare("SELECT value FROM index_meta WHERE key = 'version'").get() as { value: string } | undefined;
    return tableExists(db, "entries") && Number(row?.value) >= MIN_INDEX_LAYOUT;
  } catch {
    return false;
  }
}

/** True when an FTS5 table's DDL declares the contentless layout this release writes. */
export function isContentlessFtsDdl(sql: string | null): boolean {
  return sql !== null && /content\s*=\s*''/.test(sql);
}
