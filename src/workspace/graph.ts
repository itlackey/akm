// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The whole library as a graph: every indexed asset, every declared link between them, and how each is used. */

import fs from "node:fs";
import { loadConfig } from "../core/config/config";
import { ConfigError } from "../core/errors";
import { applyEntryFilters } from "../indexer/search/db-search";
import { resolveSourceEntries } from "../indexer/search/search-source";
import { countFeedbackSignalsByRef, countUseByRef, usageRetentionSince } from "../indexer/usage/usage-events";
import { closeDatabase, openReadonlyExistingDatabase } from "../storage/repositories/index-connection";
import { getAllEntries } from "../storage/repositories/index-entries-repository";
import { readLayout } from "../storage/repositories/index-layout-repository";
import { listDeclaredLinks } from "../storage/repositories/index-links-repository";
import type { Duplicates, Groups } from "./graph-duplicates";
import { withReadonlyStateDb } from "./readers";

/** Types never drawn: protected files and session logs, as `assets.related` leaves them out. */
const HIDDEN_TYPES = ["secret", "env", "session"];

/**
 * Every asset of the enabled bundles and the declared links between them, in column form: node `i` is `nodes.ref[i]`,
 * and its type, bundle and belief state are indexes into `types`, `bundles` (largest first) and `beliefs` (-1: no state
 * recorded). `shows`, `lastShownAt` and the feedback counts `positive` and `negative` are read live from the
 * user-attributed usage events within retention (`use`); `modifiedAt` is the file's modification time. A link joins two
 * nodes by index and names its kind by index into `kinds`. `nodes.tags[i]` indexes `tags`, the asset's own frontmatter
 * tags. `duplicates` pairs assets whose stored embeddings are nearly the same, and `groups` gives each asset its group by
 * meaning and a place in 3D where alike assets sit close, as the last `akm index` stored them (index-layout-repository.ts);
 * both are `null` when too few assets are embedded. An asset embedded since then has no group (-1) until the next
 * build. Nothing is written.
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
    /** Use figures count events from `source` at or after `since`. */
    use: null as { since: string; source: "user" } | null,
    kinds: [] as string[],
    /** Every tag the assets carry, lower case; `nodes.tags[i]` indexes it. */
    tags: [] as string[],
    nodes: {
      ref: [] as string[],
      type: [] as number[],
      bundle: [] as number[],
      belief: [] as number[],
      shows: [] as number[],
      lastShownAt: [] as Array<string | null>,
      modifiedAt: [] as Array<string | null>,
      positive: [] as number[],
      negative: [] as number[],
      tags: [] as number[][],
    },
    links: { from: [] as number[], to: [] as number[], kind: [] as number[] },
    duplicates: null as Duplicates | null,
    groups: null as Groups | null,
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
    const tagCode = code(result.tags);
    // Largest bundle first, so colour slots follow size; ties keep first-appearance order.
    const perBundle = new Map<string, number>();
    for (const row of rows) perBundle.set(row.bundleId, (perBundle.get(row.bundleId) ?? 0) + 1);
    result.bundles.push(...[...perBundle.keys()].sort((x, y) => perBundle.get(y)! - perBundle.get(x)!));
    const bundleAt = new Map(result.bundles.map((bundle, i) => [bundle, i]));
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
      result.nodes.type.push(typeCode(row.entry.type));
      result.nodes.bundle.push(bundleAt.get(row.bundleId)!);
      result.nodes.belief.push(row.entry.beliefState ? beliefCode(row.entry.beliefState) : -1);
      result.nodes.shows.push(counts?.shows ?? 0);
      result.nodes.lastShownAt.push(counts?.lastShownAt ?? null);
      result.nodes.modifiedAt.push(modifiedAt(row.filePath));
      const signals = feedback?.get(row.itemRef);
      result.nodes.positive.push(signals?.pos ?? 0);
      result.nodes.negative.push(signals?.neg ?? 0);
      result.nodes.tags.push(
        [...new Set((row.entry.tags ?? []).map((tag) => tag.trim().toLowerCase()))].filter(Boolean).map(tagCode),
      );
    }
    for (const link of listDeclaredLinks(db)) {
      const from = index.get(link.from);
      if (from === undefined) continue;
      const to = link.to === null ? undefined : index.get(link.to);
      if (to === undefined || from === to) continue;
      result.links.from.push(from);
      result.links.to.push(to);
      result.links.kind.push(kindCode(link.kind));
    }
    const layout = readLayout(db);
    closeDatabase(db);
    closed = true;
    if (layout?.groups) {
      const n = rows.length;
      const groups: Groups = {
        count: layout.groups,
        group: new Array<number>(n).fill(-1),
        x: new Array<number>(n).fill(0),
        y: new Array<number>(n).fill(0),
        z: new Array<number>(n).fill(0),
      };
      for (const p of layout.places) {
        const i = index.get(p.id);
        if (i === undefined) continue;
        groups.group[i] = p.grp;
        groups.x[i] = p.x;
        groups.y[i] = p.y;
        groups.z[i] = p.z;
      }
      const pairs = layout.pairs.flatMap((p) => {
        const a = index.get(p.a);
        const b = index.get(p.b);
        return a === undefined || b === undefined ? [] : [[a, b, p.cosine] as const];
      });
      result.groups = groups;
      result.duplicates = {
        threshold: layout.threshold,
        a: pairs.map((p) => p[0]),
        b: pairs.map((p) => p[1]),
        cosine: pairs.map((p) => p[2]),
        truncated: layout.truncated,
      };
    }
    const noted = [`${rows.length} assets and ${result.links.from.length} links of the enabled bundles.`];
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
