// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index.db` declared-links repository (#935): owns every SQL statement
 * against `asset_links`.
 *
 * A row belongs to the entry that declares the link and is written, replaced
 * and deleted with that entry (`upsertEntry`, `deleteRelatedRows`). A target
 * is stored as `dst_bundle` (NULL for a short ref, meaning the declaring
 * entry's own bundle) plus `dst_concept`; whether it exists is a join on
 * `entries.item_ref` at read time, so a target indexed later resolves with
 * no rewrite of its citer and a bundle rename carries short refs along.
 *
 * A memory target whose own file is gone resolves to its `.derived` child, the
 * reachability rule lint applies (#882): consolidation keeps the distilled
 * child after the parent is pruned.
 */

import { type DeclaredLink, declaredLinks } from "../../indexer/links/declared-links";
import type { IndexDocument } from "../../indexer/passes/metadata";
import type { Database } from "../database";
import { tableExists } from "./index-entry-schema";
import { SQLITE_CHUNK_SIZE } from "./index-sql";

interface LinkStatements {
  deleteForEntry: ReturnType<Database["prepare"]>;
  insert: ReturnType<Database["prepare"]>;
}

const statementsByDb = new WeakMap<Database, LinkStatements>();

function statements(db: Database): LinkStatements {
  const existing = statementsByDb.get(db);
  if (existing) return existing;
  const created = {
    deleteForEntry: db.prepare("DELETE FROM asset_links WHERE entry_id = ?"),
    insert: db.prepare(
      "INSERT INTO asset_links (entry_id, ord, kind, raw, dst_bundle, dst_concept) VALUES (?, ?, ?, ?, ?, ?)",
    ),
  };
  statementsByDb.set(db, created);
  return created;
}

/** Replace one entry's declared links with the ones its document names, inside the caller's transaction. */
export function replaceEntryLinks(
  db: Database,
  entryId: number,
  document: IndexDocument,
  owner: { bundleId: string; conceptId: string },
): void {
  const { deleteForEntry, insert } = statements(db);
  deleteForEntry.run(entryId);
  declaredLinks(document, owner).forEach((link: DeclaredLink, ord) => {
    insert.run(entryId, ord, link.kind, link.raw, link.bundle ?? null, link.conceptId);
  });
}

/** Delete the declared links of entries that are being removed. */
export function deleteEntryLinks(db: Database, entryIds: readonly number[]): void {
  for (let i = 0; i < entryIds.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = entryIds.slice(i, i + SQLITE_CHUNK_SIZE);
    db.prepare(`DELETE FROM asset_links WHERE entry_id IN (${chunk.map(() => "?").join(",")})`).run(...chunk);
  }
}

/**
 * Derive every entry's links from its stored `document_json`, replacing
 * whatever the table held — the in-place migration to layout 26, which needs
 * no file read. An entry whose JSON does not parse keeps no links until it is
 * next indexed.
 */
export function rebuildAllEntryLinks(db: Database): void {
  db.exec("DELETE FROM asset_links");
  const page = db.prepare(
    "SELECT id, bundle_id, concept_id, document_json FROM entries WHERE id > ? ORDER BY id LIMIT 500",
  );
  let afterId = -1;
  for (;;) {
    const rows = page.all(afterId) as Array<{
      id: number;
      bundle_id: string;
      concept_id: string;
      document_json: string;
    }>;
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1]!.id;
    for (const row of rows) {
      let document: IndexDocument;
      try {
        document = JSON.parse(row.document_json) as IndexDocument;
      } catch {
        continue;
      }
      replaceEntryLinks(db, row.id, document, { bundleId: row.bundle_id, conceptId: row.concept_id });
    }
  }
}

/**
 * The id of the entry a link row resolves to, or NULL: the exact target, else
 * (for a memory) its `.derived` child, never the declaring entry itself.
 * Expects `l` (the link) and `o` (its owner) in scope.
 */
const TARGET_ID_SQL = `COALESCE(
    (SELECT id FROM entries WHERE item_ref = COALESCE(l.dst_bundle, o.bundle_id) || '//' || l.dst_concept),
    (SELECT id FROM entries
      WHERE item_ref = COALESCE(l.dst_bundle, o.bundle_id) || '//' || l.dst_concept || '.derived'
        AND substr(l.dst_concept, 1, 9) = 'memories/' AND id <> o.id))`;

/** One link read back for an entry: the other end's identity, or the authored token when it does not resolve. */
export interface EntryLinkRow {
  kind: string;
  /** Present when the other end is indexed. */
  bundleId?: string;
  conceptId?: string;
  type?: string;
  /** The token as authored (outgoing links only). */
  raw?: string;
}

/**
 * The declared links of the entry `itemRef`, both ways: `outgoing` in stored
 * order (unresolved targets carry only `raw`), `incoming` from every other
 * entry that names it, ordered by kind then source. An index that predates
 * the table (an older layout served as-is) has none.
 */
export function readEntryLinks(db: Database, itemRef: string): { outgoing: EntryLinkRow[]; incoming: EntryLinkRow[] } {
  if (!tableExists(db, "asset_links")) return { outgoing: [], incoming: [] };
  const owner = db.prepare("SELECT id, bundle_id, concept_id FROM entries WHERE item_ref = ?").get(itemRef) as
    | { id: number; bundle_id: string; concept_id: string }
    | undefined
    | null;
  if (!owner) return { outgoing: [], incoming: [] };
  const outgoing = db
    .prepare(
      `SELECT l.kind AS kind, l.raw AS raw, t.bundle_id AS bundleId, t.concept_id AS conceptId, t.type AS type
         FROM asset_links l
         JOIN entries o ON o.id = l.entry_id
         LEFT JOIN entries t ON t.id = ${TARGET_ID_SQL}
        WHERE l.entry_id = ?
        ORDER BY l.ord`,
    )
    .all(owner.id) as Array<{
    kind: string;
    raw: string;
    bundleId: string | null;
    conceptId: string | null;
    type: string | null;
  }>;
  // A `.derived` memory also receives the links that name its parent when the
  // parent is not indexed (the resolution rule above).
  const parentConcept =
    owner.concept_id.startsWith("memories/") && owner.concept_id.endsWith(".derived")
      ? owner.concept_id.slice(0, -".derived".length)
      : owner.concept_id;
  const incoming = db
    .prepare(
      `SELECT l.kind AS kind, o.bundle_id AS bundleId, o.concept_id AS conceptId, o.type AS type
         FROM asset_links l
         JOIN entries o ON o.id = l.entry_id
        WHERE l.dst_concept IN (?, ?) AND COALESCE(l.dst_bundle, o.bundle_id) = ? AND o.id <> ?
          AND ${TARGET_ID_SQL} = ?
        ORDER BY l.kind, o.item_ref`,
    )
    .all(owner.concept_id, parentConcept, owner.bundle_id, owner.id, owner.id) as Array<{
    kind: string;
    bundleId: string;
    conceptId: string;
    type: string;
  }>;
  return {
    outgoing: outgoing.map((row) =>
      row.conceptId === null
        ? { kind: row.kind, raw: row.raw }
        : {
            kind: row.kind,
            bundleId: row.bundleId ?? undefined,
            conceptId: row.conceptId,
            type: row.type ?? undefined,
          },
    ),
    incoming,
  };
}

/** Stored links per kind with how many name a target that is not indexed; empty when the index has none. */
export function countLinksByKind(db: Database): Record<string, { total: number; unresolved: number }> {
  if (!tableExists(db, "asset_links")) return {};
  const rows = db
    .prepare(
      `SELECT l.kind AS kind, COUNT(*) AS total, SUM(${TARGET_ID_SQL} IS NULL) AS unresolved
         FROM asset_links l
         JOIN entries o ON o.id = l.entry_id
        GROUP BY l.kind
        ORDER BY l.kind`,
    )
    .all() as Array<{ kind: string; total: number; unresolved: number }>;
  return Object.fromEntries(rows.map((row) => [row.kind, { total: row.total, unresolved: row.unresolved }]));
}
