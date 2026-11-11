// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The whole library as a graph: every indexed asset, every declared link between them, and how each is used. */

import { loadConfig } from "../core/config/config";
import { applyEntryFilters } from "../indexer/search/db-search";
import { resolveSourceEntries } from "../indexer/search/search-source";
import { closeDatabase, openReadonlyExistingDatabase } from "../storage/repositories/index-connection";
import { getAllEntries } from "../storage/repositories/index-entries-repository";
import { listResolvedLinks } from "../storage/repositories/index-links-repository";
import { getUtilityScoresByIds } from "../storage/repositories/index-utility-repository";
import { listCurrentEmbeddings } from "../storage/repositories/index-vec-repository";

/** Types never drawn: protected files and session logs, as `assets.related` leaves them out. */
const HIDDEN_TYPES = ["secret", "env", "session"];

/**
 * Every asset of the enabled bundles and the declared links between them, in column form: node `i` is `nodes.ref[i]`,
 * and its type and bundle are indexes into `types` and `bundles`. A link joins two nodes by index and names its kind
 * by index into `kinds`. `meaning` places each node with a stored embedding in three dimensions (see
 * {@link projectEmbeddings}); it is `null` when the index has no embeddings. Nothing is written.
 */
export function graph() {
  const empty = {
    types: [] as string[],
    bundles: [] as string[],
    kinds: [] as string[],
    nodes: {
      ref: [] as string[],
      title: [] as string[],
      type: [] as number[],
      bundle: [] as number[],
      shows: [] as number[],
      searches: [] as number[],
      lastUsedAt: [] as Array<string | null>,
    },
    links: { from: [] as number[], to: [] as number[], kind: [] as number[] },
    meaning: null as { embedded: number; xyz: Array<number | null> } | null,
  };
  const db = openReadonlyExistingDatabase();
  if (!db) return { available: false, note: "No index is available. Build the AKM index first.", ...empty };
  try {
    const sources = resolveSourceEntries(undefined, loadConfig()).filter((source) => !source.unresolved);
    const rows = applyEntryFilters(getAllEntries(db, undefined, HIDDEN_TYPES), {
      db,
      sources,
      restrictToSources: true,
      includeProposed: false,
      beliefFilter: "all",
    }).filter((row) => row.itemRef);
    const index = new Map(rows.map((row, i) => [row.id, i]));
    const code = (list: string[]) => {
      const seen = new Map<string, number>();
      return (value: string) => {
        let at = seen.get(value);
        if (at === undefined) {
          at = list.push(value) - 1;
          seen.set(value, at);
        }
        return at;
      };
    };
    const result = { ...empty, nodes: { ...empty.nodes }, links: { from: [], to: [], kind: [] } as typeof empty.links };
    const typeCode = code(result.types);
    const bundleCode = code(result.bundles);
    const kindCode = code(result.kinds);
    const use = getUtilityScoresByIds(
      db,
      rows.map((row) => row.id),
    );
    for (const row of rows) {
      const score = use.get(row.id);
      result.nodes.ref.push(row.itemRef);
      result.nodes.title.push(row.entry.toc?.find((heading) => heading.level === 1)?.text || row.entry.name);
      result.nodes.type.push(typeCode(row.entry.type));
      result.nodes.bundle.push(bundleCode(row.bundleId));
      result.nodes.shows.push(score?.showCount ?? 0);
      result.nodes.searches.push(score?.searchCount ?? 0);
      result.nodes.lastUsedAt.push(score?.lastUsedAt ?? null);
    }
    for (const link of listResolvedLinks(db)) {
      const from = index.get(link.from);
      const to = index.get(link.to);
      if (from === undefined || to === undefined || from === to) continue;
      result.links.from.push(from);
      result.links.to.push(to);
      result.links.kind.push(kindCode(link.kind));
    }
    const vectors = listCurrentEmbeddings(db);
    const placed = projectEmbeddings(rows.map((row) => vectors.get(row.id)));
    result.meaning = placed.embedded ? placed : null;
    return {
      available: true,
      note: `${rows.length} assets and ${result.links.from.length} links of the enabled bundles. Positions by meaning come from the stored embeddings${placed.embedded ? "" : ", and this index has none"}.`,
      ...result,
    };
  } finally {
    closeDatabase(db);
  }
}

/**
 * Three coordinates per vector: its projection on the three principal components of all the vectors (power iteration
 * with deflation, a fixed start, so the same index gives the same layout), scaled so the first component's standard
 * deviation is 400. Assets with similar embeddings land near each other. A missing vector gives three nulls.
 */
export function projectEmbeddings(vectors: Array<Float32Array | undefined>): {
  embedded: number;
  xyz: Array<number | null>;
} {
  const present = vectors.filter((vector): vector is Float32Array => vector !== undefined);
  const dims = present[0]?.length ?? 0;
  const usable = present.filter((vector) => vector.length === dims);
  if (!dims || usable.length < 4) return { embedded: 0, xyz: vectors.flatMap(() => [null, null, null]) };
  const mean = new Float64Array(dims);
  for (const vector of usable) for (let d = 0; d < dims; d++) mean[d]! += vector[d]! / usable.length;
  const components: Float64Array[] = [];
  const project = (vector: Float32Array, axis: Float64Array) => {
    let sum = 0;
    for (let d = 0; d < dims; d++) sum += (vector[d]! - mean[d]!) * axis[d]!;
    return sum;
  };
  for (let c = 0; c < 3; c++) {
    let axis: Float64Array = new Float64Array(dims).map((_, d) => 1 + ((d * 7 + c * 13) % 5));
    for (let step = 0; step < 24; step++) {
      const next = new Float64Array(dims);
      for (const vector of usable) {
        const weight = project(vector, axis);
        for (let d = 0; d < dims; d++) next[d]! += weight * (vector[d]! - mean[d]!);
      }
      // Keep the axis orthogonal to the components already found.
      for (const found of components) {
        let dot = 0;
        for (let d = 0; d < dims; d++) dot += next[d]! * found[d]!;
        for (let d = 0; d < dims; d++) next[d]! -= dot * found[d]!;
      }
      const norm = Math.hypot(...next) || 1;
      axis = next.map((value) => value / norm);
    }
    components.push(axis);
  }
  const spread = Math.sqrt(
    usable.reduce((sum, vector) => sum + project(vector, components[0]!) ** 2, 0) / usable.length,
  );
  const scale = spread > 0 ? 400 / spread : 1;
  return {
    embedded: usable.length,
    xyz: vectors.flatMap((vector) =>
      vector && vector.length === dims
        ? components.map((axis) => Math.round(project(vector, axis) * scale * 10) / 10)
        : [null, null, null],
    ),
  };
}
