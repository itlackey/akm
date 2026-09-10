// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index.db` safe-Markdown-fragment repository.
 *
 * index-redesign B5c: `entries_fts`, `entry_fragments_fts` and the lexical
 * query paths that fed them (`searchFts`, `rebuildFts`) are deleted — lexical
 * search runs entirely over `units_fts` now (`db-search.ts`'s
 * `searchUnitsLexical`, seeded by `deriveUnits`/`reconcile.ts` from the same
 * entry). What remains here is `entry_fragments`: the safe-rendered Markdown
 * source a matched fragment hit's display metadata (content, ordinal, count,
 * line range, prev/next) is projected from, and that `akm show <ref>#<id>`
 * resolves an opaque fragment selector through. Both search paths (today,
 * only the units path) and `show` (`src/commands/read/show.ts`) read it via
 * `getIndexedMarkdownFragment(s)`.
 */

import { splitMarkdownFragments } from "../../core/asset/markdown-fragments";
import type { Database } from "../database";
import { SQLITE_CHUNK_SIZE } from "./index-sql";

interface FragmentSourceStatements {
  upsertFragmentSource: ReturnType<Database["prepare"]>;
  deleteFragmentSource: ReturnType<Database["prepare"]>;
}

const fragmentSourceStatementsByDb = new WeakMap<Database, FragmentSourceStatements>();

function getFragmentSourceStatements(db: Database): FragmentSourceStatements {
  const existing = fragmentSourceStatementsByDb.get(db);
  if (existing) return existing;
  const statements = {
    upsertFragmentSource: db.prepare(
      "INSERT INTO entry_fragments (entry_id, safe_markdown) VALUES (?, ?) ON CONFLICT(entry_id) DO UPDATE SET safe_markdown = excluded.safe_markdown",
    ),
    deleteFragmentSource: db.prepare("DELETE FROM entry_fragments WHERE entry_id = ?"),
  };
  fragmentSourceStatementsByDb.set(db, statements);
  return statements;
}

/**
 * Replace one entry's safe-Markdown fragment source inside the caller's
 * transaction. `fragmentContent === undefined` means a metadata-only
 * re-upsert or re-key that did not re-scan Markdown — the persisted source
 * is left untouched. An empty/null value is an explicit clear (the entry no
 * longer has Markdown content to project fragments from).
 */
export function replaceFragmentSource(db: Database, entryId: number, fragmentContent?: string | null): void {
  if (fragmentContent === undefined) return;
  const statements = getFragmentSourceStatements(db);
  statements.deleteFragmentSource.run(entryId);
  if (fragmentContent) statements.upsertFragmentSource.run(entryId, fragmentContent);
}

/** Delete the safe-Markdown fragment source for entries being removed. */
export function deleteFragmentSource(db: Database, entryIds: readonly number[]): void {
  for (let i = 0; i < entryIds.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = entryIds.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    db.prepare(`DELETE FROM entry_fragments WHERE entry_id IN (${placeholders})`).run(...chunk);
  }
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
