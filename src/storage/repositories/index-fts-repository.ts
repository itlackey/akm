// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index.db` FTS5 search + materialization repository.
 *
 * Owns the `entries_fts` full-text query path, per-entry projections, and the
 * explicit full recovery rebuild.
 */

import { splitMarkdownFragments } from "../../core/asset/markdown-fragments";
import { stableFtsScore } from "../../core/lexical-score";
import { warn } from "../../core/warn";
import type { IndexDocument } from "../../indexer/passes/metadata";
import { buildLexicalQueryPlan, type LexicalQueryExecution } from "../../indexer/search/fts-query";
import { buildSearchFields } from "../../indexer/search/search-fields";
import type { Database, SqlValue } from "../database";
import type { DbSearchResult } from "./index-entry-types";
import { SQLITE_CHUNK_SIZE } from "./index-sql";

const INSERT_FTS_SQL =
  "INSERT INTO entries_fts (entry_id, name, description, tags, hints, content) VALUES (?, ?, ?, ?, ?, ?)";
const INSERT_FRAGMENT_SQL =
  "INSERT INTO entry_fragments_fts (entry_id, fragment_id, fragment_ordinal, content) VALUES (?, ?, ?, ?)";

interface FtsMutationStatements {
  deleteOne: ReturnType<Database["prepare"]>;
  insert: ReturnType<Database["prepare"]>;
  deleteFragments: ReturnType<Database["prepare"]>;
  upsertFragmentSource: ReturnType<Database["prepare"]>;
  deleteFragmentSource: ReturnType<Database["prepare"]>;
  insertFragment: ReturnType<Database["prepare"]>;
}

const ftsMutationStatementsByDb = new WeakMap<Database, FtsMutationStatements>();

function getFtsMutationStatements(db: Database): FtsMutationStatements {
  const existing = ftsMutationStatementsByDb.get(db);
  if (existing) return existing;
  const statements = {
    deleteOne: db.prepare("DELETE FROM entries_fts WHERE entry_id = ?"),
    insert: db.prepare(INSERT_FTS_SQL),
    deleteFragments: db.prepare("DELETE FROM entry_fragments_fts WHERE entry_id = ?"),
    upsertFragmentSource: db.prepare(
      "INSERT INTO entry_fragments (entry_id, safe_markdown) VALUES (?, ?) ON CONFLICT(entry_id) DO UPDATE SET safe_markdown = excluded.safe_markdown",
    ),
    deleteFragmentSource: db.prepare("DELETE FROM entry_fragments WHERE entry_id = ?"),
    insertFragment: db.prepare(INSERT_FRAGMENT_SQL),
  };
  ftsMutationStatementsByDb.set(db, statements);
  return statements;
}

/** Replace one entry's derived FTS projection inside the caller's transaction. */
export function replaceFtsEntry(
  db: Database,
  entryId: number,
  entry: IndexDocument,
  fragmentContent?: string | null,
): void {
  const fields = buildSearchFields(entry);
  const statements = getFtsMutationStatements(db);
  statements.deleteOne.run(entryId);
  statements.insert.run(entryId, fields.name, fields.description, fields.tags, fields.hints, fields.content);
  if (fragmentContent === undefined) {
    // Metadata-only re-upserts and re-keys deserialize the public document
    // without the internal substrate. Leave the persisted source untouched.
    // A scan that did read Markdown always supplies a value below.
    return;
  }
  statements.deleteFragments.run(entryId);
  statements.deleteFragmentSource.run(entryId);
  if (!fragmentContent) return;
  statements.upsertFragmentSource.run(entryId, fragmentContent);
  for (const fragment of splitMarkdownFragments(fragmentContent)) {
    statements.insertFragment.run(entryId, fragment.fragmentId, fragment.ordinal, fragment.text.toLowerCase());
  }
}

/** Delete derived FTS projections for canonical entries that are being removed. */
export function deleteFtsEntries(db: Database, entryIds: readonly number[]): void {
  for (let i = 0; i < entryIds.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = entryIds.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    db.prepare(`DELETE FROM entries_fts WHERE entry_id IN (${placeholders})`).run(...chunk);
    db.prepare(`DELETE FROM entry_fragments_fts WHERE entry_id IN (${placeholders})`).run(...chunk);
    db.prepare(`DELETE FROM entry_fragments WHERE entry_id IN (${placeholders})`).run(...chunk);
  }
}

export function searchFts(
  db: Database,
  query: string,
  limit: number,
  entryType?: string,
  excludeTypes?: string[],
): DbSearchResult[] {
  const plan = buildLexicalQueryPlan(query);
  if (!plan.exact) return [];

  // Try the exact AND query first
  const exactResults = runFtsQuery(db, plan.exact, "exact", limit, entryType, excludeTypes);
  if (exactResults.length > 0) return exactResults;

  if (plan.exactPrefix) {
    const prefixResults = runFtsQuery(db, plan.exactPrefix, "prefix", limit, entryType, excludeTypes);
    if (prefixResults.length > 0) return prefixResults;
  }

  // One measured relaxation only after both conjunctive forms miss. This is
  // still the same FTS table, BM25 weights, candidate collection, and
  // downstream ranker — merely an OR candidate query for sentence-shaped
  // input whose filler terms prevented a strict hit.
  return plan.relaxed ? runFtsQuery(db, plan.relaxed, "relaxed", limit, entryType, excludeTypes) : [];
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
  return getIndexedMarkdownFragments(db, [{ itemRef, fragmentId }])[0];
}

/**
 * Batch the selected-hit projection read. Search commonly enriches several
 * fragment hits at once; reading all indexed-safe parents in chunks avoids an
 * N-query loop, while grouping selectors by parent ensures each safe revision
 * is split at most once.
 */
export function getIndexedMarkdownFragments(
  db: Database,
  selections: readonly IndexedMarkdownFragmentSelection[],
): Array<IndexedMarkdownFragment | undefined> {
  if (selections.length === 0) return [];
  const itemRefs = [...new Set(selections.map((selection) => selection.itemRef))];
  const sourceByRef = new Map<string, string>();
  for (let offset = 0; offset < itemRefs.length; offset += SQLITE_CHUNK_SIZE) {
    const chunk = itemRefs.slice(offset, offset + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT e.item_ref, s.safe_markdown FROM entry_fragments s JOIN entries e ON e.id = s.entry_id WHERE e.item_ref IN (${placeholders})`,
      )
      .all(...chunk) as Array<{ item_ref: string; safe_markdown: string }>;
    for (const row of rows) sourceByRef.set(row.item_ref, row.safe_markdown);
  }

  const fragmentsByRef = new Map<string, ReturnType<typeof splitMarkdownFragments>>();
  for (const [itemRef, safeMarkdown] of sourceByRef) {
    fragmentsByRef.set(itemRef, splitMarkdownFragments(safeMarkdown));
  }
  return selections.map((selection) => {
    const safeMarkdown = sourceByRef.get(selection.itemRef);
    const fragments = fragmentsByRef.get(selection.itemRef);
    if (safeMarkdown === undefined || !fragments) return undefined;
    const fragment = fragments.find(
      (candidate) => candidate.fragmentId === selection.fragmentId || candidate.headingSlug === selection.fragmentId,
    );
    return fragment ? materializeIndexedMarkdownFragment(fragment, fragments, safeMarkdown.length) : undefined;
  });
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

export interface IndexedMarkdownFragmentSelection {
  itemRef: string;
  fragmentId: string;
}

/** Indexed-safe fragment data used by show context assembly and hit provenance. */
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

function runFtsQuery(
  db: Database,
  ftsQuery: string,
  lexicalMatch: LexicalQueryExecution,
  limit: number,
  entryType?: string,
  excludeTypes?: string[],
): DbSearchResult[] {
  // Preserve the repository's ordinary limit contract for direct callers.
  // The boundary-expansion rule applies only to a positive candidate pool.
  if (limit <= 0) return [];

  // #627 — exclude-type clause. Only applies on the untyped ('any') path; an
  // explicit include filter (entryType) already narrows to a single type, so
  // exclusion is redundant there. An empty list skips the clause entirely
  // (never emit `NOT IN ()`, which is a SQL error / always-false).
  const excludes = excludeTypes && excludeTypes.length > 0 ? excludeTypes : [];
  const candidateBoundaryOffset = Math.max(0, limit - 1);

  // The typed and untyped paths differ only by one `type` WHERE clause
  // equality vs. an optional NOT IN exclusion) and their parameter order.
  // Join on integer entry_id directly (no CAST; we store integer). bm25()
  // per-column weights:
  // entry_id(0), name(10), description(5), tags(3), hints(2), content(1).
  let filterClause: string;
  let params: unknown[];
  if (entryType && entryType !== "any") {
    filterClause = "AND e.type = ?";
    params = [ftsQuery, entryType, candidateBoundaryOffset];
  } else {
    filterClause = excludes.length > 0 ? `AND e.type NOT IN (${excludes.map(() => "?").join(", ")})` : "";
    // Param order: MATCH, then the NOT IN values, then the zero-based
    // candidate-boundary offset.
    params = [ftsQuery, ...excludes, candidateBoundaryOffset];
  }

  const sql = `
    -- Do not make a SQL-only relevance decision inside a tied BM25 boundary:
    -- the TypeScript ranker adds exact-name, type, and other contributors
    -- afterwards.  Materialize BM25 once, locate the Nth score, and admit
    -- every row tied with it.  This deliberately makes the result set
    -- data-bound for a pathological all-tied query; that is the only way to
    -- avoid silently dropping a legitimate later ranking winner.
    WITH scored AS MATERIALIZED (
      -- Keep this materialized set deliberately narrow. document_json can be
      -- large, and only rows admitted through the BM25 boundary need it.
      SELECT e.id, bm25(entries_fts, 0, 10.0, 5.0, 3.0, 2.0, 1.0) AS bm25Score
    FROM entries_fts f
    JOIN entries e ON e.id = f.entry_id
    WHERE entries_fts MATCH ?
      ${filterClause}
    ), boundary AS (
      SELECT bm25Score
      FROM scored
      ORDER BY bm25Score
      LIMIT 1 OFFSET ?
    )
    SELECT e.id, e.file_path AS filePath, e.document_json AS documentJson, e.search_text AS searchText,
           e.item_ref AS itemRef, e.bundle_id AS bundleId, e.concept_id AS conceptId, e.adapter_id AS adapterId,
           scored.bm25Score
    FROM scored
    JOIN entries e ON e.id = scored.id
    WHERE NOT EXISTS (SELECT 1 FROM boundary)
       OR scored.bm25Score <= (SELECT bm25Score FROM boundary)
    ORDER BY scored.bm25Score, e.id ASC
  `;

  const rows = db.prepare(sql).all(...(params as SqlValue[])) as Array<{
    id: number;
    filePath: string;
    documentJson: string;
    searchText: string;
    itemRef: string;
    bundleId: string;
    conceptId: string;
    adapterId: string;
    bm25Score: number;
  }>;

  const results = materializeRows(rows, lexicalMatch);
  // Fragments are a separate, intentionally calibrated evidence population:
  // parent FTS remains the sole implementation of metadata/body conjunction.
  // A selector is emitted only for one fragment that independently satisfies
  // this query. Raw BM25 values are never claimed comparable across tables;
  // each is passed through #933's stable mapping before merge.
  const fragmentResults = hasFragmentFts(db)
    ? runFragmentQuery(db, ftsQuery, lexicalMatch, limit, entryType, excludes)
    : [];
  return mergeParentAndFragmentResults(results, fragmentResults);
}

function hasFragmentFts(db: Database): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entry_fragments_fts'").get());
}

function materializeRows(
  rows: Array<{
    id: number;
    filePath: string;
    documentJson: string;
    searchText: string;
    itemRef: string;
    bundleId: string;
    conceptId: string;
    adapterId: string;
    bm25Score: number;
  }>,
  lexicalMatch: LexicalQueryExecution,
): DbSearchResult[] {
  const results: DbSearchResult[] = [];
  for (const row of rows) {
    let entry: IndexDocument;
    try {
      entry = JSON.parse(row.documentJson) as IndexDocument;
    } catch {
      warn(`[db] searchFts: skipping entry id=${row.id} — corrupt document_json`);
      continue;
    }
    results.push({
      id: row.id,
      filePath: row.filePath,
      entry,
      searchText: row.searchText,
      bm25Score: row.bm25Score,
      itemRef: row.itemRef,
      bundleId: row.bundleId,
      conceptId: row.conceptId,
      adapterId: row.adapterId,
      lexicalMatch,
    });
  }
  return results;
}

function runFragmentQuery(
  db: Database,
  ftsQuery: string,
  lexicalMatch: LexicalQueryExecution,
  limit: number,
  entryType: string | undefined,
  excludes: string[],
): DbSearchResult[] {
  const filter =
    entryType && entryType !== "any"
      ? "AND e.type = ?"
      : excludes.length
        ? `AND e.type NOT IN (${excludes.map(() => "?").join(",")})`
        : "";
  const filterParams = entryType && entryType !== "any" ? [entryType] : excludes;
  const candidateBoundaryOffset = Math.max(0, limit - 1);
  // Select the winning child per parent inside SQLite before finding the
  // candidate boundary. A document with many matching fragments therefore
  // occupies one parent slot, while a boundary tie retains every parent for
  // the TypeScript ranker to decide with its non-BM25 contributors. This has
  // one FTS query and no OFFSET walk; the returned boundary is intentionally
  // data-bound for a pathological all-tied query, just like parent FTS.
  const sql = `
    WITH matches AS MATERIALIZED (
      -- Keep repeated child rows as narrow as parent FTS's scored CTE. The
      -- document projection can be large; hydrate it only after the one-child
      -- per-parent collapse and BM25 boundary filtering below.
      SELECT e.id, f.fragment_id AS fragmentId, f.fragment_ordinal AS fragmentOrdinal,
             bm25(entry_fragments_fts) AS bm25Score
      FROM entry_fragments_fts f JOIN entries e ON e.id = f.entry_id
      WHERE entry_fragments_fts MATCH ? ${filter}
    ), ranked AS MATERIALIZED (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY id ORDER BY bm25Score ASC, fragmentOrdinal ASC, fragmentId ASC) AS parentRank
      FROM matches
    ), parents AS MATERIALIZED (
      SELECT * FROM ranked WHERE parentRank = 1
    ), boundary AS (
      SELECT bm25Score FROM parents ORDER BY bm25Score ASC LIMIT 1 OFFSET ?
    )
    SELECT e.id, e.file_path AS filePath, e.document_json AS documentJson, e.search_text AS searchText,
           e.item_ref AS itemRef, e.bundle_id AS bundleId, e.concept_id AS conceptId, e.adapter_id AS adapterId,
           parents.fragmentId, parents.bm25Score
    FROM parents JOIN entries e ON e.id = parents.id
    WHERE NOT EXISTS (SELECT 1 FROM boundary)
       OR parents.bm25Score <= (SELECT bm25Score FROM boundary)
    ORDER BY parents.bm25Score ASC, parents.id ASC`;
  const rows = db.prepare(sql).all(ftsQuery, ...filterParams, candidateBoundaryOffset) as Array<{
    id: number;
    filePath: string;
    documentJson: string;
    searchText: string;
    itemRef: string;
    bundleId: string;
    conceptId: string;
    adapterId: string;
    fragmentId: string;
    bm25Score: number;
  }>;
  const results: DbSearchResult[] = [];
  for (const row of rows) {
    const [result] = materializeRows([row], lexicalMatch);
    if (result) {
      results.push({
        ...result,
        fragmentId: row.fragmentId,
        lexicalScore: stableFtsScore(result.bm25Score, "fragment"),
      });
    }
  }
  return results;
}

function mergeParentAndFragmentResults(parents: DbSearchResult[], fragments: DbSearchResult[]): DbSearchResult[] {
  const winners = new Map<number, DbSearchResult>();
  for (const parent of parents) winners.set(parent.id, { ...parent, lexicalScore: stableFtsScore(parent.bm25Score) });
  for (const fragment of fragments) {
    const existing = winners.get(fragment.id);
    if (!existing || (fragment.lexicalScore ?? 0) > (existing.lexicalScore ?? 0)) winners.set(fragment.id, fragment);
  }
  return [...winners.values()].sort(
    (left, right) => (right.lexicalScore ?? 0) - (left.lexicalScore ?? 0) || left.id - right.id,
  );
}

/**
 * Explicitly rebuild the complete FTS5 projection from canonical entries.
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
    db.exec("DELETE FROM entry_fragments_fts");
    const rows = db
      .prepare(
        "SELECT e.id, e.document_json, f.safe_markdown FROM entries e LEFT JOIN entry_fragments f ON f.entry_id = e.id",
      )
      .all() as Array<{
      id: number;
      document_json: string;
      safe_markdown: string | null;
    }>;
    const insertStmt = db.prepare(INSERT_FTS_SQL);
    const fragmentStmt = db.prepare(INSERT_FRAGMENT_SQL);

    let skipped = 0;
    for (const row of rows) {
      let entry: IndexDocument;
      let fields: ReturnType<typeof buildSearchFields>;
      try {
        entry = JSON.parse(row.document_json) as IndexDocument;
        fields = buildSearchFields(entry);
      } catch {
        skipped++;
        continue;
      }
      insertStmt.run(row.id, fields.name, fields.description, fields.tags, fields.hints, fields.content);
      if (row.safe_markdown) {
        for (const fragment of splitMarkdownFragments(row.safe_markdown)) {
          fragmentStmt.run(row.id, fragment.fragmentId, fragment.ordinal, fragment.text.toLowerCase());
        }
      }
    }

    if (skipped > 0) {
      warn(`[db] rebuildFts: skipped ${skipped} entr${skipped === 1 ? "y" : "ies"} with invalid document_json`);
    }
  })();
}
