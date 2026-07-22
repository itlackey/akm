// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Auto-index bootstrap: silently build the local index inline when it cannot
 * serve the caller's stash at all (missing DB, no `entries` table, zero rows,
 * or built for a different stash), so `search`, `show`, and `feedback` work
 * on first use without a manual `akm index`.
 *
 * Content FRESHNESS is intentionally not this module's job on the read path.
 * Writers maintain the index (`indexWrittenAssets` for `remember`/extract
 * session assets; the mutation commands run `akmIndex()` themselves), and the
 * improve cron / explicit `akm index` do full refreshes. Reads serve whatever
 * populated index exists. The previous design — a staleness walk plus a
 * detached background reindex per read — made every read on an actively
 * written stash spawn a writer that the read's own telemetry then queued
 * behind (see docs/design/read-path-reindex-contention-findings.md).
 *
 * `mode: "blocking"` (improve) still checks staleness and rebuilds inline,
 * because its planning logic needs a current `entries` table in-process.
 */

import fs from "node:fs";
import path from "node:path";
import { type AssetSpec, placementSpecList } from "../core/asset/asset-placement";
import { getDbPath } from "../core/paths";
import { warn } from "../core/warn";
import { closeDatabase, openExistingDatabase } from "../storage/repositories/index-connection";
import { getEntryCount, getIndexedFilePaths } from "../storage/repositories/index-entries-repository";
import { getMeta } from "../storage/repositories/index-meta-repository";
import { warnOnBundleRenameDrift } from "./bundle-identity-guard";

export interface EnsureIndexOptions {
  mode?: "background" | "blocking";
  signal?: AbortSignal;
}

function getIndexableFiles(root: string, spec: AssetSpec): string[] {
  if (!fs.existsSync(root)) return [];

  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".stash.json") continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) continue;
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && spec.isRelevantFile(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

/**
 * Whether any indexable file under `stashDir` is newer than the last build, or
 * has never been indexed at all.
 *
 * Two independent signals, because neither alone is sufficient:
 *   1. **mtime > builtAt** — catches in-place *edits* of already-indexed files.
 *   2. **path not in `indexedPaths`** — catches *newly added* files. This is
 *      clock-independent on purpose: a freshly-written file can have a
 *      filesystem mtime that compares as *older* than the wall-clock `builtAt`
 *      (the two clocks are not perfectly synchronized and `builtAt` is
 *      millisecond-truncated), so the mtime test alone silently misses
 *      additions made within ~a millisecond of the previous build.
 *
 * `getIndexableFiles` applies each asset type's own relevance filter, so
 * non-indexed companion files (e.g. `package.json` next to a knowledge doc) are
 * never considered and do not produce false "new file" positives.
 */
function hasNewerIndexableFiles(stashDir: string, builtAt: string | undefined, indexedPaths: Set<string>): boolean {
  const builtAtMs = builtAt ? new Date(builtAt).getTime() : Number.NaN;
  const builtAtUsable = Number.isFinite(builtAtMs);

  for (const spec of placementSpecList()) {
    const typeRoot = path.join(stashDir, spec.stashDir);
    const files = getIndexableFiles(typeRoot, spec);
    for (const file of files) {
      if (!indexedPaths.has(file)) return true;
      if (!builtAtUsable) return true;
      try {
        if (fs.statSync(file).mtimeMs > builtAtMs) return true;
      } catch {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check whether the local index is stale relative to the given stash directory.
 * Returns `true` when the index is missing, empty, or was built against a
 * different primary stash dir.
 */
export function isIndexStale(stashDir: string): boolean {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) return true;

  let db: ReturnType<typeof openExistingDatabase> | undefined;
  try {
    db = openExistingDatabase(dbPath);
    const entryCount = getEntryCount(db);
    if (entryCount === 0) return true;

    const builtAt = getMeta(db, "builtAt");
    if (hasNewerIndexableFiles(stashDir, builtAt, getIndexedFilePaths(db))) return true;

    const storedStashDir = getMeta(db, "stashDir");
    if (storedStashDir !== stashDir) {
      // Check if the incoming stashDir appears in the stored stashDirs array
      try {
        const storedDirs = JSON.parse(getMeta(db, "stashDirs") ?? "[]") as string[];
        if (!storedDirs.includes(stashDir)) return true;
      } catch {
        return true;
      }
    }
    return false;
  } catch {
    return true;
  } finally {
    if (db) closeDatabase(db);
  }
}

/**
 * Whether the existing index can serve queries for `stashDir` *right now* —
 * i.e. the DB file exists, the `entries` table holds rows, and those rows were
 * built for this stash (it is the stored primary stash or appears in the
 * stored `stashDirs` set). When this is true the index is at worst
 * content-stale, so read paths serve it as-is. When it is false the existing
 * index has nothing relevant to return (no DB, no `entries` table, zero rows,
 * or built for a different stash), so those cases must rebuild inline.
 */
function indexCanServeStash(stashDir: string): boolean {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) return false;

  let db: ReturnType<typeof openExistingDatabase> | undefined;
  try {
    db = openExistingDatabase(dbPath);
    if (getEntryCount(db) === 0) return false;

    const storedStashDir = getMeta(db, "stashDir");
    if (storedStashDir === stashDir) return true;
    try {
      const storedDirs = JSON.parse(getMeta(db, "stashDirs") ?? "[]") as string[];
      return storedDirs.includes(stashDir);
    } catch {
      return false;
    }
  } catch {
    // No `entries` table (or otherwise unreadable) — cannot serve.
    return false;
  } finally {
    if (db) closeDatabase(db);
  }
}

async function runInlineReindex(
  stashDir: string,
  options: { signal?: AbortSignal; hydrateSources?: boolean } = {},
): Promise<boolean> {
  try {
    const { akmIndex } = await import("./indexer.js");
    await akmIndex({
      stashDir,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.hydrateSources === false ? { hydrateSources: false } : {}),
    });
    return true;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    warn("Auto-index failed, proceeding with existing index:", error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * Ensure the local index exists and can serve the caller.
 *
 * Default mode is `background` — the read-path contract (`search`, `show`,
 * `feedback`): a populated index built for this stash is served as-is (its
 * freshness is the writers' job, see module doc); an unusable index rebuilds
 * inline, since there is nothing to proceed against.
 *
 * `mode: "blocking"` additionally treats content-staleness as a rebuild
 * trigger and waits for it. Use this for callers like `improve` whose
 * planning logic depends on a current `entries` table in the same process.
 *
 * Returns `true` only when an inline index run succeeds.
 * A rebuild attempt that fails (throws) resolves to `false`.
 */
export async function ensureIndex(stashDir: string, options: EnsureIndexOptions = {}): Promise<boolean> {
  // §11.5: warn (once) if the configured bundle ids drifted from the persisted
  // index prefixes (hand-renamed bundle key) BEFORE any rebuild could re-mint.
  warnOnBundleRenameDrift();
  if (options.mode === "blocking") {
    // Blocking callers (improve's planning preflight) are a sanctioned
    // materialization point — hydrate cache-backed sources as usual.
    if (!isIndexStale(stashDir)) return false;
    return runInlineReindex(stashDir, { ...(options.signal ? { signal: options.signal } : {}) });
  }
  // Background = the READ path (`show` auto-index): query time must never clone/
  // pull/fetch (spec §14.3 / D11). Build from already-materialized content only;
  // absent source caches are skipped with a warning, not fetched.
  if (indexCanServeStash(stashDir)) return false;
  return runInlineReindex(stashDir, {
    ...(options.signal ? { signal: options.signal } : {}),
    hydrateSources: false,
  });
}
