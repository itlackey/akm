// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index.db` FTS5 search + materialization repository.
 *
 * Owns the `entries_fts` full-text query path, per-entry projections (the FTS
 * row and the `entry_fragments` safe Markdown `akm show` resolves fragment
 * selectors from), and the explicit full recovery rebuild.
 *
 * `entries_fts` is contentless (`content=''`, see index-entry-schema.ts): the
 * text lives once in `entries`, and an FTS row is addressed only by its rowid
 * (`entries.id`). The `COALESCE(f.entry_id, f.rowid)` join below also reads
 * the content-bearing table older releases wrote (where the UNINDEXED column
 * is populated), so a read-only open of a not-yet-migrated index still
 * answers correctly.
 */

import { splitMarkdownFragments } from "../../core/asset/markdown-fragments";
import { warn } from "../../core/warn";
import type { IndexDocument } from "../../indexer/passes/metadata";
import { ftsOrMatch, ftsQueryTokens } from "../../indexer/search/fts-query";
import { buildSearchFields } from "../../indexer/search/search-fields";
import type { Database, SqlValue } from "../database";
import { SQLITE_CHUNK_SIZE } from "./index-sql";

// `entries_fts.rowid = entries.id`, so a per-entry delete is a rowid lookup.
const INSERT_FTS_SQL =
  "INSERT INTO entries_fts (rowid, entry_id, name, description, tags, hints, content) VALUES (?, ?, ?, ?, ?, ?, ?)";

interface FtsMutationStatements {
  deleteOne: ReturnType<Database["prepare"]>;
  insert: ReturnType<Database["prepare"]>;
  upsertFragmentSource: ReturnType<Database["prepare"]>;
  deleteFragmentSource: ReturnType<Database["prepare"]>;
}

const ftsMutationStatementsByDb = new WeakMap<Database, FtsMutationStatements>();

function getFtsMutationStatements(db: Database): FtsMutationStatements {
  const existing = ftsMutationStatementsByDb.get(db);
  if (existing) return existing;
  const statements = {
    deleteOne: db.prepare("DELETE FROM entries_fts WHERE rowid = ?"),
    insert: db.prepare(INSERT_FTS_SQL),
    upsertFragmentSource: db.prepare(
      "INSERT INTO entry_fragments (entry_id, safe_markdown) VALUES (?, ?) ON CONFLICT(entry_id) DO UPDATE SET safe_markdown = excluded.safe_markdown",
    ),
    deleteFragmentSource: db.prepare("DELETE FROM entry_fragments WHERE entry_id = ?"),
  };
  ftsMutationStatementsByDb.set(db, statements);
  return statements;
}

/**
 * Replace one entry's derived FTS row, and its fragment source when the scan
 * read Markdown, inside the caller's transaction.
 */
export function replaceFtsEntry(
  db: Database,
  entryId: number,
  entry: IndexDocument,
  fragmentContent?: string | null,
): void {
  const fields = buildSearchFields(entry);
  const statements = getFtsMutationStatements(db);
  statements.deleteOne.run(entryId);
  statements.insert.run(entryId, entryId, fields.name, fields.description, fields.tags, fields.hints, fields.content);
  if (fragmentContent === undefined) {
    // Metadata-only re-upserts and re-keys deserialize the public document
    // without the internal substrate. Leave the persisted source untouched.
    // A scan that did read Markdown always supplies a value below.
    return;
  }
  if (fragmentContent) statements.upsertFragmentSource.run(entryId, fragmentContent);
  else statements.deleteFragmentSource.run(entryId);
}

/** Delete the FTS rows and fragment sources of canonical entries that are being removed. */
export function deleteFtsEntries(db: Database, entryIds: readonly number[]): void {
  for (let i = 0; i < entryIds.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = entryIds.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    db.prepare(`DELETE FROM entries_fts WHERE rowid IN (${placeholders})`).run(...chunk);
    db.prepare(`DELETE FROM entry_fragments WHERE entry_id IN (${placeholders})`).run(...chunk);
  }
}

/** One lexical candidate: the entry id and its durable `item_ref`. */
export interface FtsCandidate {
  id: number;
  itemRef: string;
}

/**
 * BM25 per-column weights for `entries_fts(entry_id, name, description, tags,
 * hints, content)`. `entry_id` is UNINDEXED and carries no weight.
 */
const BM25_COLUMN_WEIGHTS = "0, 1.0, 1.0, 1.0, 1.0, 1.0";

/**
 * The top `limit` entries matching ANY of the query's tokens
 * (`ftsQueryTokens`), best whole-document BM25 first; equal scores are
 * ordered by `item_ref` so the ranking is deterministic. Fragments play no
 * part: whole-document BM25 beat the fragment population by 0.059 nDCG@10 on
 * the retrieval suite.
 *
 * `entryType` narrows to one type; otherwise `excludeTypes` (#627, the
 * default-hidden types such as `session`) are left out.
 */
export function searchFts(
  db: Database,
  query: string,
  limit: number,
  entryType?: string,
  excludeTypes: readonly string[] = [],
): FtsCandidate[] {
  const tokens = ftsQueryTokens(query);
  if (limit <= 0 || tokens.length === 0) return [];
  const typed = entryType !== undefined && entryType !== "any";
  const filter = typed
    ? "AND e.type = ?"
    : excludeTypes.length > 0
      ? `AND e.type NOT IN (${excludeTypes.map(() => "?").join(", ")})`
      : "";
  const params: SqlValue[] = [ftsOrMatch(tokens), ...(typed ? [entryType] : excludeTypes), limit];
  // Contentless FTS rows address their entry by rowid; the COALESCE also reads
  // the content-bearing layout older releases wrote.
  return db
    .prepare(
      `SELECT e.id AS id, e.item_ref AS itemRef
         FROM entries_fts f
         JOIN entries e ON e.id = COALESCE(f.entry_id, f.rowid)
        WHERE entries_fts MATCH ? ${filter}
        ORDER BY bm25(entries_fts, ${BM25_COLUMN_WEIGHTS}), e.item_ref
        LIMIT ?`,
    )
    .all(...params) as FtsCandidate[];
}

/**
 * Resolve an opaque fragment selector from the indexed safe projection, not
 * from current disk. A search result remains self-consistent across a later
 * file edit; the next index refresh atomically publishes the new revision.
 */
export function getIndexedMarkdownFragment(
  db: Database,
  itemRef: string,
  fragmentId: string,
): IndexedMarkdownFragment | undefined {
  const row = db
    .prepare("SELECT s.safe_markdown FROM entry_fragments s JOIN entries e ON e.id = s.entry_id WHERE e.item_ref = ?")
    .get(itemRef) as { safe_markdown: string } | undefined;
  if (row === undefined) return undefined;
  const fragments = splitMarkdownFragments(row.safe_markdown);
  const fragment = fragments.find(
    (candidate) => candidate.fragmentId === fragmentId || candidate.headingSlug === fragmentId,
  );
  return fragment ? materializeIndexedMarkdownFragment(fragment, fragments, row.safe_markdown.length) : undefined;
}

function materializeIndexedMarkdownFragment(
  fragment: ReturnType<typeof splitMarkdownFragments>[number],
  fragments: ReturnType<typeof splitMarkdownFragments>,
  parentChars: number,
): IndexedMarkdownFragment {
  return {
    content: fragment.text,
    ordinal: fragment.ordinal,
    count: fragments.length,
    startLine: fragment.startLine,
    endLine: fragment.endLine,
    previousFragmentId: fragments[fragment.ordinal - 1]?.fragmentId,
    nextFragmentId: fragments[fragment.ordinal + 1]?.fragmentId,
    fragmentChars: fragment.text.length,
    parentChars,
    fragments,
  };
}

/** Indexed-safe fragment data used by show context assembly. */
export interface IndexedMarkdownFragment {
  content: string;
  /** Internal zero-based position. Public output converts this to one-based. */
  ordinal: number;
  count: number;
  startLine: number;
  endLine: number;
  previousFragmentId?: string;
  nextFragmentId?: string;
  fragmentChars: number;
  parentChars: number;
  /** Complete indexed revision; never surfaced directly in JSON. */
  fragments: ReturnType<typeof splitMarkdownFragments>;
}

/**
 * Explicitly rebuild `entries_fts` from canonical entries.
 * Ordinary entry mutations do not call this: `upsertEntry` and the delete
 * operations publish their FTS state in the same transaction as `entries`.
 * This remains a recovery/schema-verification primitive for regenerable
 * `index.db` state.
 *
 * Skipped corrupt-JSON rows are aggregated into one warning instead of
 * spamming stderr per-entry.
 */
export function rebuildFts(db: Database): void {
  db.transaction(() => {
    db.exec("DELETE FROM entries_fts");
    // Keyset pages, so a large index is never held in memory at once.
    const page = db.prepare("SELECT id, document_json FROM entries WHERE id > ? ORDER BY id LIMIT 500");
    const insertStmt = db.prepare(INSERT_FTS_SQL);

    let skipped = 0;
    let afterId = -1;
    for (;;) {
      const rows = page.all(afterId) as Array<{ id: number; document_json: string }>;
      if (rows.length === 0) break;
      afterId = rows[rows.length - 1]!.id;
      for (const row of rows) {
        let fields: ReturnType<typeof buildSearchFields>;
        try {
          fields = buildSearchFields(JSON.parse(row.document_json) as IndexDocument);
        } catch {
          skipped++;
          continue;
        }
        insertStmt.run(row.id, row.id, fields.name, fields.description, fields.tags, fields.hints, fields.content);
      }
    }

    if (skipped > 0) {
      warn(`[db] rebuildFts: skipped ${skipped} entr${skipped === 1 ? "y" : "ies"} with invalid document_json`);
    }
  })();
}
