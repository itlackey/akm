// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Auto-index: silently run an incremental `akm index` when the local index
 * is stale or absent, so that `search`, `show`, and `feedback` always operate
 * against current on-disk state without requiring the user to manually run
 * `akm index` first.
 *
 * This replaces the old filesystem fallbacks that were scattered across
 * `searchLocal()` and `show.ts`, centralizing the "indexed yet?" gap handling
 * behind a single entry point.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ASSET_SPECS, type AssetSpec, TYPE_DIRS } from "../core/asset/asset-spec";
import { getDataDir, getDbPath } from "../core/paths";
import { warn } from "../core/warn";
import { closeDatabase, getEntryCount, getIndexedFilePaths, getMeta, openExistingDatabase } from "./db/db";
import { acquireIndexWriterLease, handoffIndexWriterLeaseToPid } from "./index-writer-lock";

export interface EnsureIndexOptions {
  mode?: "background" | "blocking";
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

  for (const [type, spec] of Object.entries(ASSET_SPECS)) {
    const typeRoot = path.join(stashDir, TYPE_DIRS[type] ?? spec.stashDir);
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
 * content-stale, so the `#607` background-reindex optimization is safe: the
 * caller gets slightly-stale-but-relevant results immediately. When it is
 * false the existing index has nothing relevant to return (no DB, no `entries`
 * table, zero rows, or built for a different stash), so a background reindex
 * would leave the caller empty until the next read — those cases must rebuild
 * inline.
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

/**
 * Spawn a background `akm index` process. Non-blocking — returns immediately.
 * Background callers share the same global index-writer lease as foreground
 * writers, so stale-read-triggered auto-index attempts coalesce safely.
 */
async function spawnBackgroundReindex(_stashDir: string): Promise<void> {
  const dataDir = getDataDir();
  const logFile = path.join(dataDir, "logs", "index-background.log");

  fs.mkdirSync(path.dirname(logFile), { recursive: true });

  const lease = await acquireIndexWriterLease({ mode: "try", purpose: "background-reindex-spawn" });
  if (!lease) return;

  const akmBin = process.argv[0];
  const akmScript = process.argv[1];
  try {
    const child = spawn(akmBin, [akmScript, "index", "--background"], {
      detached: true,
      stdio: ["ignore", fs.openSync(logFile, "a"), fs.openSync(logFile, "a")],
      env: { ...process.env },
    });

    if (!child.pid) {
      lease.release();
      return;
    }

    handoffIndexWriterLeaseToPid(lease, child.pid, "background-reindex");
    try {
      child.unref();
    } catch {
      // ignore
    }
  } catch (error) {
    lease.release();
    throw error;
  }
}

async function runInlineReindex(stashDir: string): Promise<boolean> {
  try {
    const { akmIndex } = await import("./indexer.js");
    await akmIndex({ stashDir });
    return true;
  } catch (error) {
    warn("Auto-index failed, proceeding with existing index:", error instanceof Error ? error.message : String(error));
    return true;
  }
}

/**
 * Ensure the local index exists and is fresh enough for the caller's needs.
 *
 * Default mode is `background`, which preserves the low-latency behavior used
 * by read paths (`search`, `show`, `feedback`): when a populated index is
 * merely stale, spawn a detached reindex and proceed against the existing
 * index. When the index is entirely absent (no DB / no `entries` table / zero
 * rows) the rebuild runs inline regardless of mode, since there is nothing to
 * proceed against.
 *
 * `mode: "blocking"` waits for the rebuild to finish before returning. Use
 * this for callers like `improve` whose planning logic depends on a populated
 * `entries` table in the same process.
 *
 * Returns `true` if an index run was attempted.
 */
export async function ensureIndex(stashDir: string, options: EnsureIndexOptions = {}): Promise<boolean> {
  if (!isIndexStale(stashDir)) return false;

  // Blocking when explicitly requested, or whenever the existing index cannot
  // serve this stash (absent DB, no `entries` table, zero rows, or built for a
  // different stash): a background reindex returns immediately and would leave
  // a first-time caller (search, curate, wiki, show, feedback) with empty
  // results. Building inline is a one-off cost; a populated index for this
  // stash that is merely content-stale still refreshes in the background.
  if (options.mode === "blocking" || !indexCanServeStash(stashDir)) {
    return runInlineReindex(stashDir);
  }

  // The background path re-invokes the akm CLI as a detached child via
  // `process.argv[1]`. That is only the akm entrypoint when THIS process is the
  // akm CLI itself — which the CLI startup block signals with AKM_CLI_ENTRY=1.
  // In any other host (the in-process test runner, a library embedding akm),
  // argv[1] points at the host (e.g. the test runner), so spawning it would
  // launch the wrong program and orphan it. Build inline there instead — same
  // resulting index, no detached process.
  if (process.env.AKM_CLI_ENTRY !== "1") {
    return runInlineReindex(stashDir);
  }

  try {
    await spawnBackgroundReindex(stashDir);
    return true;
  } catch (error) {
    warn(
      "Background reindex spawn failed, proceeding with existing index:",
      error instanceof Error ? error.message : String(error),
    );
    return true;
  }
}
