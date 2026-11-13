// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Auto-index bootstrap: silently build the local index inline when it cannot
 * serve the caller's stash at all (missing DB, no `entries` table, never
 * completed a build, or built for a different stash), so `search`, `show`, and
 * `feedback` work on first use without a manual `akm index`.
 *
 * Content FRESHNESS is intentionally not this module's job on the read path.
 * Writers maintain the index (`indexWrittenAssets` for `remember`/extract
 * session assets; the mutation commands run `akmIndex()` themselves), and the
 * improve cron / explicit `akm index` do full refreshes. Reads serve whatever
 * index has completed a build. The previous design — a staleness walk plus a
 * detached background reindex per read — made every read on an actively
 * written stash spawn a writer that the read's own telemetry then queued
 * behind (the 2026-07 read-path reindex-contention findings).
 *
 * `mode: "blocking"` (improve) runs an incremental index inline, because its
 * planning logic needs a current `entries` table in-process.
 */

import { ConfigError, TransientError } from "../core/errors";
import { classifyPathAccess } from "../core/path-access";
import { getDbPath } from "../core/paths";
import { tryAcquireRunLock } from "../core/run-lock";
import { warnVerbose } from "../core/warn";
import { assertIndexPathReadable, closeDatabase, openExistingDatabase } from "../storage/repositories/index-connection";
import { hasCurrentEntriesTable } from "../storage/repositories/index-entry-schema";
import { getMeta } from "../storage/repositories/index-meta-repository";
import { SQLITE_BUSY_TIMEOUT_MS } from "../storage/sqlite-pragmas";
import { warnOnBundleRenameDrift } from "./bundle-identity-guard";
import { indexRebuildLockPath, releaseIndexRebuildLock } from "./index-rebuild-lock";
import type { IndexResponse } from "./indexer";

export interface EnsureIndexOptions {
  mode?: "background" | "blocking";
  signal?: AbortSignal;
  /**
   * R6: called with the inline reindex's timing when `ensureIndex` actually
   * runs one, so a blocking caller (improve) can surface the implicit
   * reindex's cost instead of it being silently discarded. Never called when
   * no rebuild was needed.
   */
  /** Test seam: how long (ms) a cold read waits for another process's build, and how often (ms) it re-checks. */
  buildWait?: { timeoutMs?: number; pollMs?: number };
  onReindexTiming?: (info: { durationMs: number; timing: IndexResponse["timing"] }) => void;
}

/**
 * Whether the existing index can serve queries for `stashDir` *right now* —
 * i.e. the DB file exists, has a current `entries` table, a complete build
 * finished (`builtAt` is written only after a full scan, so an empty stash that
 * was indexed still counts as built), and it was built for this stash (the
 * stored primary stash or one of the stored `stashDirs`). When this is true the
 * index is at worst content-stale, so read paths serve it as-is.
 */
function indexCanServeStash(stashDir: string): boolean {
  const dbPath = getDbPath();
  // Raises on an index we cannot READ rather than calling it unusable — that
  // sends us into an inline reindex that will fail anyway, and whose failure
  // is reported as the misleading "proceeding with existing index" (#791).
  assertIndexPathReadable(dbPath);
  if (classifyPathAccess(dbPath).access === "absent") return false;

  let db: ReturnType<typeof openExistingDatabase> | undefined;
  try {
    db = openExistingDatabase(dbPath);
    if (!hasCurrentEntriesTable(db)) return false;
    if (!getMeta(db, "builtAt")) return false;

    const storedStashDir = getMeta(db, "stashDir");
    if (storedStashDir === stashDir) return true;
    try {
      const storedDirs = JSON.parse(getMeta(db, "stashDirs") ?? "[]") as string[];
      return storedDirs.includes(stashDir);
    } catch {
      return false;
    }
  } catch (error) {
    // A newer layout's refusal names the remedy; a rebuild would refuse too.
    if (error instanceof ConfigError) throw error;
    // No `entries` table (or otherwise unreadable) — cannot serve.
    return false;
  } finally {
    if (db) closeDatabase(db);
  }
}

/**
 * How long a cold read waits for another process's index build. Reuses the
 * SQLite busy timeout (30 s): the same bound a write waits on index.db, so a
 * read is never kept longer than a writer would be.
 */
const BUILD_WAIT_TIMEOUT_MS = SQLITE_BUSY_TIMEOUT_MS;
const BUILD_WAIT_POLL_MS = 100;

/**
 * Single flight for the cold-index build. Two inline builds of the same fresh
 * index race on their first write (a deferred transaction that read first gets
 * an immediate SQLITE_BUSY, the busy timeout never applies), so only the lock
 * holder builds. Returns the held lock, or `undefined` when another process's
 * build left a usable index. A dead holder's lock is reclaimed by
 * `tryAcquireRunLock`; a live one is waited for, never raced.
 */
async function acquireBuildLock(stashDir: string, wait: EnsureIndexOptions["buildWait"]) {
  const timeoutMs = wait?.timeoutMs ?? BUILD_WAIT_TIMEOUT_MS;
  const pollMs = wait?.pollMs ?? BUILD_WAIT_POLL_MS;
  const startedMs = Date.now();
  for (;;) {
    const result = tryAcquireRunLock(indexRebuildLockPath(), { label: "index rebuild" });
    if (result.state === "acquired") {
      // The previous holder may have finished while we waited: re-check, never assume.
      if (!indexCanServeStash(stashDir)) return result.ownership;
      releaseIndexRebuildLock(result.ownership);
      return undefined;
    }
    if (Date.now() - startedMs >= timeoutMs) {
      throw new TransientError(
        `akm's index database is busy (another akm process is writing it); retry shortly. ` +
          `Waited ${Math.round(timeoutMs / 1000)}s for its index build to finish.`,
        "INDEX_DB_CONTENDED",
      );
    }
    warnVerbose("[ensure-index] another process is building the index; waiting for it");
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Ensure the local index exists and can serve the caller.
 *
 * Default mode is `background` — the read-path contract (`search`, `show`,
 * `feedback`): an index that completed a build for this stash is served as-is (its
 * freshness is the writers' job, see module doc); an unusable index rebuilds
 * inline, since there is nothing to proceed against.
 *
 * `mode: "blocking"` always runs an incremental `akmIndex` and waits for it,
 * letting its per-file fingerprints decide what changed (across every bundle,
 * not just the primary stash). Use this for callers like `improve` whose
 * planning logic depends on a current `entries` table in the same process.
 *
 * Returns `true` when an inline index run succeeds; `false` when no
 * rebuild was needed. A rebuild attempt that fails propagates its error to
 * the caller rather than silently proceeding with a stale/missing index.
 */
export async function ensureIndex(stashDir: string, options: EnsureIndexOptions = {}): Promise<boolean> {
  // §11.5: warn (once) if the configured bundle ids drifted from the persisted
  // index prefixes (hand-renamed bundle key) BEFORE any rebuild could re-mint.
  warnOnBundleRenameDrift();
  const blocking = options.mode === "blocking";
  if (!blocking && indexCanServeStash(stashDir)) return false;

  // Blocking callers (improve) keep today's unlocked incremental run.
  const lock = blocking ? undefined : await acquireBuildLock(stashDir, options.buildWait);
  if (!blocking && !lock) return false;
  try {
    return await buildIndex(stashDir, options, blocking);
  } finally {
    if (lock) releaseIndexRebuildLock(lock);
  }
}

async function buildIndex(stashDir: string, options: EnsureIndexOptions, blocking: boolean): Promise<boolean> {
  const { akmIndex } = await import("./indexer.js");
  const startedMs = Date.now();
  const response = await akmIndex({
    stashDir,
    implicit: true,
    ...(options.signal ? { signal: options.signal } : {}),
    // Blocking callers (improve's planning preflight) are a sanctioned
    // materialization point and hydrate cache-backed sources as usual. The
    // background READ path (`show` auto-index) must never clone/pull/fetch at
    // query time: it builds from already-materialized
    // content, and absent source caches are skipped with a warning.
    ...(blocking ? {} : { hydrateSources: false }),
  });
  // R6: the implicit reindex's cost was previously discarded entirely
  // (`await akmIndex(...)` and nothing else), making a 27-minute blocking
  // rebuild invisible to both the operator and the improve result. Fall back
  // to a wall-clock measurement when the response carries no `timing` block.
  const durationMs = response.timing?.totalMs ?? Date.now() - startedMs;
  const timing = response.timing;
  warnVerbose(
    `[ensure-index] implicit reindex completed in ${durationMs}ms` +
      (timing
        ? ` (walk=${timing.walkMs}ms llm=${timing.llmMs}ms embed=${timing.embedMs}ms finalize=${timing.finalizeMs}ms)`
        : ""),
  );
  options.onReindexTiming?.({ durationMs, timing });
  return true;
}
