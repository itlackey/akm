// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Graph navigation for `akm show`'s `related` list (and, through it, curate's
 * support refs): the files that share extracted entities with a given file.
 * The graph plays no part in search ranking.
 */

import type { Database } from "../../storage/database";

/**
 * Find graph files that share entities with the given file.
 *
 * Implementation: SQL self-join on graph_file_entities, scoped by stash_root,
 * grouped by file_path, ordered by shared-entity count desc. Touches ~50-200
 * rows instead of loading the entire snapshot into memory. Cold-call latency
 * drops from ~30-60ms (full snapshot parse) to ~2-5ms on typical stashes.
 *
 * #624-P1: the graph tables are keyed on (stash_root, file_path, body_hash) —
 * NOT entries.id — so candidates are identified by file_path (the unique index
 * idx_graph_files_path guarantees one graph_files row per path).
 *
 * The returned `ref` field carries the canonical indexed `concept_id`, never a
 * value re-derived from presentation fields. It is undefined
 * when the graph row has no matching entry with current indexed provenance.
 */
export function listRelatedPathsForFile(
  stashRoot: string,
  filePath: string,
  limit = 5,
  db?: Database,
): Array<{
  ref?: string;
  path: string;
  type: string;
  sharedEntities: string[];
  relationCount: number;
}> {
  if (!db) {
    // Fallback: opening a transient DB here is not currently a use case (all
    // callers pass a handle), so degrade to empty rather than reopening.
    return [];
  }

  // Confirm the target file has a graph row; without it there is nothing to
  // relate. (Identity is file_path within the stash — one row per path.)
  const row = db
    .prepare("SELECT 1 AS present FROM graph_files WHERE stash_root = ? AND file_path = ? LIMIT 1")
    .get(stashRoot, filePath) as { present: number } | undefined;
  if (row === undefined) return [];

  const effectiveLimit = Math.max(1, limit);

  // Shared-entity count per candidate file_path. The target's entities are the
  // rows for `filePath`; candidates are any OTHER file_path in the stash that
  // shares a normalized entity.
  const candidateRows = db
    .prepare(
      `SELECT gf.file_path   AS file_path,
              gf.file_type   AS file_type,
              COUNT(*)       AS shared
          FROM graph_file_entities target
          JOIN graph_file_entities e
            ON e.stash_root = target.stash_root
           AND e.entity_norm = target.entity_norm
           AND e.file_path  != target.file_path
          JOIN graph_files gf
            ON gf.stash_root = e.stash_root
           AND gf.file_path = e.file_path
           AND gf.body_hash = e.body_hash
        WHERE target.file_path  = ?
          AND target.stash_root = ?
        GROUP BY gf.file_path
        ORDER BY shared DESC, gf.file_path ASC
        LIMIT ?`,
    )
    .all(filePath, stashRoot, effectiveLimit) as Array<{
    file_path: string;
    file_type: string;
    shared: number;
  }>;

  if (candidateRows.length === 0) return [];

  const candidatePaths = candidateRows.map((r) => r.file_path);
  const placeholders = candidatePaths.map(() => "?").join(",");

  // Pull the shared entity names (joined by normalized casing) for display.
  const sharedRows = db
    .prepare(
      `SELECT e.file_path AS file_path, e.entity AS entity
         FROM graph_file_entities e
         JOIN graph_file_entities target
           ON target.stash_root = e.stash_root
           AND target.entity_norm = e.entity_norm
         WHERE e.file_path IN (${placeholders})
           AND e.stash_root = ?
           AND target.file_path = ?
           AND target.stash_root = ?`,
    )
    .all(...candidatePaths, stashRoot, filePath, stashRoot) as Array<{ file_path: string; entity: string }>;

  const sharedByPath = new Map<string, Set<string>>();
  for (const row of sharedRows) {
    let bucket = sharedByPath.get(row.file_path);
    if (!bucket) {
      bucket = new Set<string>();
      sharedByPath.set(row.file_path, bucket);
    }
    bucket.add(row.entity);
  }

  // Relation count for each candidate (relations where either endpoint
  // matches one of the shared entities).
  const relationCountByPath = new Map<string, number>();
  const relationRows = db
    .prepare(
      `SELECT file_path, from_entity, to_entity
         FROM graph_file_relations
        WHERE file_path IN (${placeholders})
          AND stash_root = ?`,
    )
    .all(...candidatePaths, stashRoot) as Array<{ file_path: string; from_entity: string; to_entity: string }>;
  for (const row of relationRows) {
    const shared = sharedByPath.get(row.file_path);
    if (!shared) continue;
    if (shared.has(row.from_entity) || shared.has(row.to_entity)) {
      relationCountByPath.set(row.file_path, (relationCountByPath.get(row.file_path) ?? 0) + 1);
    }
  }

  // This related list is scoped to one source root, so the user-facing ref is
  // the indexed bundle-less conceptId.
  const refByPath = new Map<string, string>();
  try {
    const entryRows = db
      .prepare(
        `SELECT file_path, concept_id FROM entries
          WHERE file_path IN (${placeholders})`,
      )
      .all(...candidatePaths) as Array<{
      file_path: string;
      concept_id: string;
    }>;
    for (const row of entryRows) {
      refByPath.set(row.file_path, row.concept_id);
    }
  } catch {
    /* ignore — refs are best-effort */
  }

  return candidateRows.map((row) => {
    const sharedSet = sharedByPath.get(row.file_path) ?? new Set<string>();
    const sharedEntities = [...sharedSet].sort((a, b) => a.localeCompare(b));
    const ref = refByPath.get(row.file_path);
    return {
      ...(ref ? { ref } : {}),
      path: row.file_path,
      type: row.file_type,
      sharedEntities,
      relationCount: relationCountByPath.get(row.file_path) ?? 0,
    };
  });
}
