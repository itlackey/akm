// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The single canonical contract for the derived `entries` generation.
 *
 * `index.db` is regenerable, so callers compare one normalized PRAGMA
 * fingerprint and discard any generation that differs. This module owns both
 * the DDL and its expected fingerprint so schema creation, writable opens,
 * serving preflights, and read-only evaluator tooling cannot drift into
 * separate definitions of "current".
 */

// v23 adds an isolated fragment FTS population. v22 is the last shipped
// generation and is intentionally rebuilt rather than migrated in place.
//
// v23→v24 (index-redesign B5c): `entries_fts` and `entry_fragments_fts` are
// dropped from the canonical shape. Lexical search runs entirely over
// `units_fts` now (index-redesign-contract.md B1/B3) — the card unit already
// carries name/description/tags/hints, so an entry-level lexical query is a
// units query grouped by entry, and a fragment-level lexical query is the
// same `units_fts` table filtered to fragment-kind units. `entry_fragments`
// (the safe-rendered Markdown source, NOT an FTS index) stays: it is what a
// matched fragment hit's display metadata is projected from, and what `akm
// show <ref>#<fragmentId>` resolves an opaque fragment selector through —
// both are consumers independent of which table search itself queries.
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

  -- The safe-rendered Markdown source a matched fragment hit's display
  -- metadata is projected from (index-fts-repository.ts's
  -- getIndexedMarkdownFragment(s)) and that akm show's opaque fragment
  -- selectors resolve through. Not a search index — units_fts is.
  CREATE TABLE IF NOT EXISTS entry_fragments (
    entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
    safe_markdown TEXT NOT NULL
  );
`;

interface ColumnFingerprint {
  cid: number;
  name: string;
  type: string;
  notNull: number;
  defaultValue: string | null;
  primaryKeyPosition: number;
  hidden: number;
}

interface IndexColumnFingerprint {
  sequence: number;
  cid: number;
  name: string | null;
  descending: number;
  collation: string | null;
  key: number;
}

interface IndexFingerprint {
  name: string;
  unique: number;
  origin: string;
  partial: number;
  columns: IndexColumnFingerprint[];
}

interface EntrySchemaFingerprint {
  tableSql: string | null;
  sqliteSequenceTable: boolean;
  sqliteSequenceValid: boolean;
  columns: ColumnFingerprint[];
  indexes: IndexFingerprint[];
  searchSurfaces: SearchSurfaceFingerprint;
}

/**
 * The logical non-`entries` search-adjacent surface that belongs to this
 * derived generation: `entry_fragments`, the plain table holding the
 * safe-rendered Markdown source a fragment hit's display metadata and `akm
 * show`'s opaque-selector resolution read from. `entries_fts` and
 * `entry_fragments_fts` (FTS5 virtual tables) were dropped in v24
 * (index-redesign B5c) — lexical search is `units_fts` now, fingerprinted by
 * `files-repository.ts`'s own schema ensure, not here.
 */
interface SearchSurfaceFingerprint {
  fragmentSourceSql: string | null;
}

/** Minimal read-only statement surface shared by bun:sqlite and AKM's runtime-neutral handle. */
export interface EntrySchemaInspectionDatabase {
  prepare(sql: string): {
    all(): unknown[];
    get(): unknown;
  };
}

const CANONICAL_ENTRY_SCHEMA_FINGERPRINT: EntrySchemaFingerprint = {
  tableSql:
    "CREATE TABLE entries ( id INTEGER PRIMARY KEY AUTOINCREMENT, item_ref TEXT NOT NULL UNIQUE, bundle_id TEXT NOT NULL, component_id TEXT NOT NULL, concept_id TEXT NOT NULL, adapter_id TEXT NOT NULL, type TEXT NOT NULL, file_path TEXT NOT NULL, content_hash TEXT, document_json TEXT NOT NULL, search_text TEXT NOT NULL, derived_from TEXT )",
  sqliteSequenceTable: true,
  sqliteSequenceValid: true,
  columns: [
    { cid: 0, name: "id", type: "INTEGER", notNull: 0, defaultValue: null, primaryKeyPosition: 1, hidden: 0 },
    {
      cid: 1,
      name: "item_ref",
      type: "TEXT",
      notNull: 1,
      defaultValue: null,
      primaryKeyPosition: 0,
      hidden: 0,
    },
    {
      cid: 2,
      name: "bundle_id",
      type: "TEXT",
      notNull: 1,
      defaultValue: null,
      primaryKeyPosition: 0,
      hidden: 0,
    },
    {
      cid: 3,
      name: "component_id",
      type: "TEXT",
      notNull: 1,
      defaultValue: null,
      primaryKeyPosition: 0,
      hidden: 0,
    },
    {
      cid: 4,
      name: "concept_id",
      type: "TEXT",
      notNull: 1,
      defaultValue: null,
      primaryKeyPosition: 0,
      hidden: 0,
    },
    {
      cid: 5,
      name: "adapter_id",
      type: "TEXT",
      notNull: 1,
      defaultValue: null,
      primaryKeyPosition: 0,
      hidden: 0,
    },
    { cid: 6, name: "type", type: "TEXT", notNull: 1, defaultValue: null, primaryKeyPosition: 0, hidden: 0 },
    {
      cid: 7,
      name: "file_path",
      type: "TEXT",
      notNull: 1,
      defaultValue: null,
      primaryKeyPosition: 0,
      hidden: 0,
    },
    {
      cid: 8,
      name: "content_hash",
      type: "TEXT",
      notNull: 0,
      defaultValue: null,
      primaryKeyPosition: 0,
      hidden: 0,
    },
    {
      cid: 9,
      name: "document_json",
      type: "TEXT",
      notNull: 1,
      defaultValue: null,
      primaryKeyPosition: 0,
      hidden: 0,
    },
    {
      cid: 10,
      name: "search_text",
      type: "TEXT",
      notNull: 1,
      defaultValue: null,
      primaryKeyPosition: 0,
      hidden: 0,
    },
    {
      cid: 11,
      name: "derived_from",
      type: "TEXT",
      notNull: 0,
      defaultValue: null,
      primaryKeyPosition: 0,
      hidden: 0,
    },
  ],
  indexes: [
    {
      name: "idx_entries_bundle",
      unique: 0,
      origin: "c",
      partial: 0,
      columns: [
        { sequence: 0, cid: 2, name: "bundle_id", descending: 0, collation: "BINARY", key: 1 },
        { sequence: 1, cid: -1, name: null, descending: 0, collation: "BINARY", key: 0 },
      ],
    },
    {
      name: "idx_entries_derived_from",
      unique: 0,
      origin: "c",
      partial: 0,
      columns: [
        { sequence: 0, cid: 11, name: "derived_from", descending: 0, collation: "BINARY", key: 1 },
        { sequence: 1, cid: -1, name: null, descending: 0, collation: "BINARY", key: 0 },
      ],
    },
    {
      name: "idx_entries_file_path",
      unique: 0,
      origin: "c",
      partial: 0,
      columns: [
        { sequence: 0, cid: 7, name: "file_path", descending: 0, collation: "BINARY", key: 1 },
        { sequence: 1, cid: -1, name: null, descending: 0, collation: "BINARY", key: 0 },
      ],
    },
    {
      name: "idx_entries_type",
      unique: 0,
      origin: "c",
      partial: 0,
      columns: [
        { sequence: 0, cid: 6, name: "type", descending: 0, collation: "BINARY", key: 1 },
        { sequence: 1, cid: -1, name: null, descending: 0, collation: "BINARY", key: 0 },
      ],
    },
    {
      name: "sqlite_autoindex_entries_1",
      unique: 1,
      origin: "u",
      partial: 0,
      columns: [
        { sequence: 0, cid: 1, name: "item_ref", descending: 0, collation: "BINARY", key: 1 },
        { sequence: 1, cid: -1, name: null, descending: 0, collation: "BINARY", key: 0 },
      ],
    },
  ],
  searchSurfaces: {
    fragmentSourceSql:
      "CREATE TABLE entry_fragments ( entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE, safe_markdown TEXT NOT NULL )",
  },
};

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function normalizeSchemaSql(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value.replace(/\s+/g, " ").trim();
}

function readNamedTableSql(db: EntrySchemaInspectionDatabase, name: string): string | null {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${sqlString(name)}`).get() as
    | { sql: string | null }
    | null
    | undefined;
  return normalizeSchemaSql(row?.sql);
}

export function readEntrySchemaFingerprint(db: EntrySchemaInspectionDatabase): EntrySchemaFingerprint {
  const sqliteSequenceTable =
    db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get() !=
    null;
  const maxId = Number(
    (db.prepare("SELECT COALESCE(MAX(id), 0) AS maxId FROM entries").get() as { maxId: number }).maxId,
  );
  const sequenceRow = sqliteSequenceTable
    ? (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'entries'").get() as { seq: number } | null | undefined)
    : undefined;
  const sqliteSequenceValid =
    sqliteSequenceTable &&
    (maxId === 0 ? sequenceRow == null || Number(sequenceRow.seq) >= 0 : Number(sequenceRow?.seq) >= maxId);
  const columns = (
    db.prepare("PRAGMA table_xinfo(entries)").all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
      hidden: number;
    }>
  ).map((column) => ({
    cid: Number(column.cid),
    name: column.name,
    type: column.type.trim().toUpperCase(),
    notNull: Number(column.notnull),
    defaultValue: column.dflt_value === null ? null : String(column.dflt_value),
    primaryKeyPosition: Number(column.pk),
    hidden: Number(column.hidden),
  }));

  const indexes = (
    db.prepare("PRAGMA index_list(entries)").all() as Array<{
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }>
  )
    .map((index) => ({
      name: index.name,
      unique: Number(index.unique),
      origin: index.origin,
      partial: Number(index.partial),
      columns: (
        db.prepare(`PRAGMA index_xinfo(${sqlString(index.name)})`).all() as Array<{
          seqno: number;
          cid: number;
          name: string | null;
          desc: number;
          coll: string | null;
          key: number;
        }>
      )
        .sort((left, right) => Number(left.seqno) - Number(right.seqno))
        .map((column) => ({
          sequence: Number(column.seqno),
          cid: Number(column.cid),
          name: column.name,
          descending: Number(column.desc),
          collation: column.coll,
          key: Number(column.key),
        })),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    tableSql: readNamedTableSql(db, "entries"),
    sqliteSequenceTable,
    sqliteSequenceValid,
    columns,
    indexes,
    searchSurfaces: {
      fragmentSourceSql: readNamedTableSql(db, "entry_fragments"),
    },
  };
}

export function hasCanonicalEntrySchema(db: EntrySchemaInspectionDatabase): boolean {
  try {
    return JSON.stringify(readEntrySchemaFingerprint(db)) === JSON.stringify(CANONICAL_ENTRY_SCHEMA_FINGERPRINT);
  } catch {
    return false;
  }
}

export type IndexGenerationStatus = "canonical" | "older" | "newer";

export interface IndexGenerationClassification {
  status: IndexGenerationStatus;
  storedVersion: string | undefined;
}

export function classifyIndexGeneration(db: EntrySchemaInspectionDatabase): IndexGenerationClassification {
  let storedVersion: string | undefined;
  try {
    const row = db.prepare("SELECT value FROM index_meta WHERE key = 'version'").get() as { value: string } | undefined;
    storedVersion = row?.value;
  } catch {
    storedVersion = undefined;
  }

  if (storedVersion === String(CANONICAL_INDEX_DB_VERSION) && hasCanonicalEntrySchema(db)) {
    return { status: "canonical", storedVersion };
  }

  const storedNumeric = storedVersion === undefined ? undefined : Number(storedVersion);
  if (storedNumeric !== undefined && Number.isFinite(storedNumeric) && storedNumeric > CANONICAL_INDEX_DB_VERSION) {
    return { status: "newer", storedVersion };
  }
  return { status: "older", storedVersion };
}

export function isCanonicalIndexGeneration(db: EntrySchemaInspectionDatabase): boolean {
  try {
    return classifyIndexGeneration(db).status === "canonical";
  } catch {
    return false;
  }
}
