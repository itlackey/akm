// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The whole library as a graph: every indexed asset, every declared link between them, and how each is used. */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { loadConfig } from "../core/config/config";
import { ConfigError } from "../core/errors";
import { getDbPath } from "../core/paths";
import { applyEntryFilters } from "../indexer/search/db-search";
import { resolveSourceEntries } from "../indexer/search/search-source";
import { countFeedbackSignalsByRef, countUseByRef, usageRetentionSince } from "../indexer/usage/usage-events";
import { closeDatabase, openReadonlyExistingDatabase } from "../storage/repositories/index-connection";
import { getAllEntries } from "../storage/repositories/index-entries-repository";
import { listDeclaredLinks } from "../storage/repositories/index-links-repository";
import { getMeta } from "../storage/repositories/index-meta-repository";
import { listCurrentEmbeddings } from "../storage/repositories/index-vec-repository";
import { findTopics, type Topics } from "./graph-topics";
import { withReadonlyStateDb } from "./readers";

/** Types never drawn: protected files and session logs, as `assets.related` leaves them out. */
const HIDDEN_TYPES = ["secret", "env", "session"];

/**
 * Every asset of the enabled bundles and the declared links between them, in column form: node `i` is `nodes.ref[i]`,
 * and its type, bundle and belief state are indexes into `types`, `bundles` (largest first) and `beliefs` (-1: no state
 * recorded). `shows`, `searches`, `lastShownAt` and the feedback counts `positive` and `negative` are read live from the
 * user-attributed usage events within retention (`use`); `modifiedAt` is the file's modification time. A link joins two
 * nodes by index and names its kind by index into `kinds`. `topic` indexes `topics` (see {@link findTopics}), -1 for
 * an asset with no stored embedding, and `duplicates` pairs assets of one topic whose embeddings are nearly the same. `meaning` places each node with a stored embedding in three dimensions (see
 * {@link projectEmbeddings}); it is `null` when the index has no embeddings. Nothing is written. The projection yields
 * to the event loop as it goes, so a host serving other requests keeps answering them.
 */
export async function graph() {
  try {
    return await readGraph();
  } catch (error) {
    // A damaged or unreadable index file is "no usable index" to the map, not a raw SQLite error.
    if (error instanceof Error && error.name === "SQLiteError")
      return {
        available: false,
        note: `The index could not be read (${error.message}). Rebuild it with 'akm index --full'.`,
        ...emptyGraph(),
      };
    throw error;
  }
}

function emptyGraph() {
  return {
    types: [] as string[],
    bundles: [] as string[],
    beliefs: [] as string[],
    emptyBundles: [] as string[],
    /** Use figures count events from `source` at or after `since`. */
    use: null as { since: string; source: "user" } | null,
    /** Declared links that are not drawn: target missing, hidden, or in a bundle that is not enabled. */
    unresolvedLinks: 0,
    kinds: [] as string[],
    nodes: {
      ref: [] as string[],
      title: [] as string[],
      type: [] as number[],
      bundle: [] as number[],
      belief: [] as number[],
      shows: [] as number[],
      searches: [] as number[],
      lastShownAt: [] as Array<string | null>,
      modifiedAt: [] as Array<string | null>,
      positive: [] as number[],
      negative: [] as number[],
      topic: [] as number[],
    },
    links: { from: [] as number[], to: [] as number[], kind: [] as number[] },
    meaning: null as { embedded: number; xyz: Array<number | null> } | null,
    topics: [] as Topics["topics"],
    duplicates: null as Topics["duplicates"] | null,
  };
}

async function readGraph() {
  const empty = emptyGraph();
  const db = openReadonlyExistingDatabase();
  if (!db) return { available: false, note: "No index is available. Build the AKM index first.", ...empty };
  let closed = false;
  try {
    // An index still being built for the first time has its meta table but not yet its entries.
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entries'").get())
      return { available: false, note: "The index is still being built. Try again when it finishes.", ...empty };
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
    const beliefCode = code(result.beliefs);
    const kindCode = code(result.kinds);
    // Largest bundle first, so colour slots follow size; ties keep first-appearance order.
    const perBundle = new Map<string, number>();
    for (const row of rows) perBundle.set(row.bundleId, (perBundle.get(row.bundleId) ?? 0) + 1);
    result.bundles.push(...[...perBundle.keys()].sort((x, y) => perBundle.get(y)! - perBundle.get(x)!));
    const bundleAt = new Map(result.bundles.map((bundle, i) => [bundle, i]));
    result.emptyBundles = sources.flatMap((source) =>
      source.registryId && !perBundle.has(source.registryId) ? [source.registryId] : [],
    );
    const since = usageRetentionSince();
    const use = withReadonlyStateDb((state) => countUseByRef(state, since), null);
    const feedback = withReadonlyStateDb(
      (state) =>
        countFeedbackSignalsByRef(
          state,
          rows.map((row) => row.itemRef),
        ),
      null,
    );
    result.use = { since, source: "user" };
    for (const row of rows) {
      const counts = use?.get(row.itemRef);
      result.nodes.ref.push(row.itemRef);
      result.nodes.title.push(row.entry.toc?.find((heading) => heading.level === 1)?.text || row.entry.name);
      result.nodes.type.push(typeCode(row.entry.type));
      result.nodes.bundle.push(bundleAt.get(row.bundleId)!);
      result.nodes.belief.push(row.entry.beliefState ? beliefCode(row.entry.beliefState) : -1);
      result.nodes.shows.push(counts?.shows ?? 0);
      result.nodes.searches.push(counts?.searches ?? 0);
      result.nodes.lastShownAt.push(counts?.lastShownAt ?? null);
      result.nodes.modifiedAt.push(modifiedAt(row.filePath));
      const signals = feedback?.get(row.itemRef);
      result.nodes.positive.push(signals?.pos ?? 0);
      result.nodes.negative.push(signals?.neg ?? 0);
    }
    for (const link of listDeclaredLinks(db)) {
      const from = index.get(link.from);
      if (from === undefined) continue;
      const to = link.to === null ? undefined : index.get(link.to);
      if (to === undefined) result.unresolvedLinks++;
      if (to === undefined || from === to) continue;
      result.links.from.push(from);
      result.links.to.push(to);
      result.links.kind.push(kindCode(link.kind));
    }
    const vectors = listCurrentEmbeddings(db);
    const build = `${getDbPath()}|${getMeta(db, "embeddingFingerprint") ?? ""}|${getMeta(db, "builtAt") ?? ""}`;
    closeDatabase(db);
    closed = true;
    const placed = await projectEmbeddings(
      rows.map((row) => vectors.get(row.id)),
      build,
    );
    result.meaning = placed.embedded ? placed : null;
    const libraryKey = createHash("sha1")
      .update(rows.map((row) => row.id).join(","))
      .digest("hex");
    const found = await findTopics(
      rows.map((row) => vectors.get(row.id)),
      rows.map((row, i) => `${row.conceptId} ${result.nodes.title[i]}`),
      // Topics are per asset: the same build read through a different set of enabled bundles is a different library.
      `${build}|${libraryKey}`,
    );
    result.topics = found.topics;
    result.nodes.topic = found.topic;
    result.duplicates = found.topics.length ? found.duplicates : null;
    const noted = [`${rows.length} assets and ${result.links.from.length} links of the enabled bundles.`];
    if (result.unresolvedLinks)
      noted.push(
        `${result.unresolvedLinks} declared links are not drawn (target missing, hidden or in a bundle that is not enabled).`,
      );
    if (result.emptyBundles.length) noted.push(`No assets in: ${result.emptyBundles.join(", ")}.`);
    const embedded = rows.filter((row) => vectors.has(row.id)).length;
    noted.push(embeddingNote(embedded, rows.length));
    if (!use) noted.push("Use counts are zero: no usage history is available.");
    return {
      available: true,
      note: noted.join(" "),
      ...result,
    };
  } catch (error) {
    // A query that fails on a damaged index is no index; permission and newer-layout errors still raise.
    if (closed || error instanceof ConfigError) throw error;
    return { available: false, note: "The index could not be read. Rebuild it with `akm index`.", ...empty };
  } finally {
    if (!closed) closeDatabase(db);
  }
}

/** A file's modification time as an ISO timestamp, or null when it cannot be read. */
function modifiedAt(file: string): string | null {
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}

/** Fewest vectors the principal components can be found from. */
const MIN_VECTORS = 4;

/** The note's sentence on how many assets have a position by meaning. */
export function embeddingNote(embedded: number, total: number): string {
  if (embedded === 0) return "No assets are embedded, so there is no arrangement by meaning.";
  if (embedded < MIN_VECTORS)
    return `Only ${embedded} of ${total} assets are embedded; at least ${MIN_VECTORS} are needed to arrange by meaning.`;
  if (embedded === total) return `All ${total} assets are embedded.`;
  return `${embedded} of ${total} assets are embedded; the rest have no position by meaning.`;
}

/** Most vectors the principal components are found from; the rest are only projected onto them. */
const SAMPLE = 4000;
/** Vectors projected between yields to the event loop. */
const CHUNK = 2000;
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The axes of the last projection, reused while the index's embedding model and full build stay the same. */
let axesCache: { key: string; dims: number; mean: Float64Array; components: Float64Array[]; scale: number } | undefined;

/**
 * Three coordinates per vector: its projection on the three principal components of the vectors, so vectors that are
 * alike land near each other. The components come from an evenly spaced sample of at most 4,000 vectors (power
 * iteration with deflation from a fixed start, so the same vectors give the same layout), scaled so the first
 * component's standard deviation is 400. With a `key` (the index's embedding model and build), the components are
 * kept and reused until the key changes: an asset embedded since is projected onto them. A missing vector gives three
 * nulls. Work is done in slices with a yield to the event loop between them.
 */
export async function projectEmbeddings(
  vectors: Array<Float32Array | undefined>,
  key?: string,
): Promise<{ embedded: number; xyz: Array<number | null> }> {
  const present = vectors.filter((vector): vector is Float32Array => vector !== undefined);
  const dims = present[0]?.length ?? 0;
  const usable = present.filter((vector) => vector.length === dims);
  if (!dims || usable.length < MIN_VECTORS) return { embedded: 0, xyz: vectors.flatMap(() => [null, null, null]) };
  let axes = key !== undefined && axesCache?.key === key && axesCache.dims === dims ? axesCache : undefined;
  if (!axes) {
    const step = Math.max(1, usable.length / SAMPLE);
    const sample: Float32Array[] = [];
    for (let at = 0; at < usable.length && sample.length < SAMPLE; at += step) sample.push(usable[Math.floor(at)]!);
    const mean = new Float64Array(dims);
    for (const vector of sample) for (let d = 0; d < dims; d++) mean[d]! += vector[d]! / sample.length;
    const components: Float64Array[] = [];
    for (let c = 0; c < 3; c++) {
      let axis: Float64Array = new Float64Array(dims).map((_, d) => 1 + ((d * 7 + c * 13) % 5));
      for (let round = 0; round < 16; round++) {
        const next = new Float64Array(dims);
        for (const vector of sample) {
          const weight = projectOn(vector, mean, axis);
          for (let d = 0; d < dims; d++) next[d]! += weight * (vector[d]! - mean[d]!);
        }
        // Keep the axis orthogonal to the components already found.
        for (const found of components) {
          let dot = 0;
          for (let d = 0; d < dims; d++) dot += next[d]! * found[d]!;
          for (let d = 0; d < dims; d++) next[d]! -= dot * found[d]!;
        }
        let norm = 0;
        for (let d = 0; d < dims; d++) norm += next[d]! * next[d]!;
        norm = Math.sqrt(norm) || 1;
        axis = next.map((value) => value / norm);
        await yieldToLoop();
      }
      components.push(axis);
    }
    const spread = Math.sqrt(
      sample.reduce((sum, vector) => sum + projectOn(vector, mean, components[0]!) ** 2, 0) / sample.length,
    );
    axes = { key: key ?? "", dims, mean, components, scale: spread > 0 ? 400 / spread : 1 };
    if (key !== undefined) axesCache = axes;
  }
  const xyz: Array<number | null> = [];
  for (let at = 0; at < vectors.length; at += CHUNK) {
    for (const vector of vectors.slice(at, at + CHUNK)) {
      if (vector && vector.length === dims)
        for (const axis of axes.components)
          xyz.push(Math.round(projectOn(vector, axes.mean, axis) * axes.scale * 10) / 10);
      else xyz.push(null, null, null);
    }
    await yieldToLoop();
  }
  return { embedded: usable.length, xyz };
}

function projectOn(vector: Float32Array, mean: Float64Array, axis: Float64Array): number {
  let sum = 0;
  for (let d = 0; d < axis.length; d++) sum += (vector[d]! - mean[d]!) * axis[d]!;
  return sum;
}
