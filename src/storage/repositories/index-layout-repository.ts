// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index.db` layout repository: the library's shape by meaning, as `akm index` last computed it from the stored
 * vectors (see `findSimilarity`). `entry_layout` holds each embedded entry's group and place in 3D; `duplicate_pairs`
 * the near-duplicate pairs, most alike first. Both are derived and rewritten whole; `index_meta.layoutKey` is the hash
 * of the vectors they were computed from, so a build whose vectors did not change skips the work.
 */

import { createHash } from "node:crypto";
import { findSimilarity } from "../../core/graph-duplicates";
import type { Database } from "../database";
import { getMeta, setMeta } from "./index-meta-repository";
import { listCurrentEmbeddings } from "./index-vec-repository";

/** The hash of the vectors and the entries they belong to, in id order. */
function vectorsKey(ids: number[], vectors: Float32Array[]): string {
  const hash = createHash("sha1");
  ids.forEach((id, k) => {
    hash.update(String(id));
    const v = vectors[k]!;
    hash.update(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  });
  return hash.digest("hex");
}

/**
 * Recompute and store the layout when the vectors changed since it was last stored; returns whether it ran. With too
 * few embedded entries the tables are emptied.
 */
export async function storeLayout(db: Database): Promise<boolean> {
  const stored = listCurrentEmbeddings(db);
  const ids = [...stored.keys()].sort((a, b) => a - b);
  const vectors = ids.map((id) => stored.get(id)!);
  const key = vectorsKey(ids, vectors);
  if (getMeta(db, "layoutKey") === key) return false;
  const found = await findSimilarity(vectors);
  const own = !db.inTransaction;
  if (own) db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM entry_layout; DELETE FROM duplicate_pairs;");
    if (found) {
      const place = db.prepare("INSERT INTO entry_layout (entry_id, grp, x, y, z) VALUES (?, ?, ?, ?, ?)");
      const g = found.groups;
      ids.forEach((id, k) => {
        if (g.group[k]! >= 0) place.run(id, g.group[k]!, g.x[k]!, g.y[k]!, g.z[k]!);
      });
      const pair = db.prepare("INSERT INTO duplicate_pairs (rank, a, b, cosine) VALUES (?, ?, ?, ?)");
      const d = found.duplicates;
      for (let k = 0; k < d.a.length; k++) pair.run(k, ids[d.a[k]!]!, ids[d.b[k]!]!, d.cosine[k]!);
    }
    setMeta(db, "layoutGroups", String(found?.groups.count ?? 0));
    setMeta(db, "duplicateThreshold", String(found?.duplicates.threshold ?? 0));
    setMeta(db, "duplicatesTruncated", found?.duplicates.truncated ? "1" : "0");
    setMeta(db, "layoutKey", key);
    if (own) db.exec("COMMIT");
  } catch (error) {
    if (own && db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
  return true;
}

/** The stored layout: each placed entry's group and place, and the near-duplicate pairs, by entry id. */
export function readLayout(db: Database) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('entry_layout', 'duplicate_pairs')")
    .all() as Array<{ name: string }>;
  if (tables.length < 2) return null;
  return {
    groups: Number(getMeta(db, "layoutGroups") ?? 0),
    threshold: Number(getMeta(db, "duplicateThreshold") ?? 0),
    truncated: getMeta(db, "duplicatesTruncated") === "1",
    places: db.prepare("SELECT entry_id AS id, grp, x, y, z FROM entry_layout").all() as Array<{
      id: number;
      grp: number;
      x: number;
      y: number;
      z: number;
    }>,
    pairs: db.prepare("SELECT a, b, cosine FROM duplicate_pairs ORDER BY rank").all() as Array<{
      a: number;
      b: number;
      cosine: number;
    }>,
  };
}
