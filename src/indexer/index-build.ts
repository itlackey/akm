// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The one way to build the live index. Every build path (`akm index`, `setup`,
 * bundle add / update / remove, improve) comes through {@link buildIndex}, which
 * takes the rebuild lock, so at most one build runs at a time on a host and
 * readers can tell a build is running. Reads never build (see
 * `index-readiness.ts`): they serve what is persisted and say so.
 *
 *  When a live process holds the lock, a build does not wait and does not fail: it
 *  warns, returns {@link SkippedIndexBuild}, and the caller carries on with the
 *  index as it is. The next build indexes whatever changed.
 *
 * Not re-entrant: no build path calls another from inside its own build. A caller
 * that must hold the lock around more than the build (`bundle update` publishes
 * and indexes under the asset mutation lease) takes it with
 * {@link withIndexBuildLock}, which hands it a `build` that runs under the lock
 * it already holds, or skips when another process holds it. Lock order is always
 * the rebuild lock first, then the asset mutation lease.
 */

import type { LockOwnership } from "../core/file-lock";
import type { RunLockHolder } from "../core/run-lock";
import { warn } from "../core/warn";
import { warnOnBundleRenameDrift } from "./bundle-identity-guard";
import { describeLockHolder, releaseIndexRebuildLock, tryAcquireIndexRebuildLock } from "./index-rebuild-lock";
import { akmIndex, type IndexOptions, type IndexResponse } from "./indexer";

/** A live process held the rebuild lock, so no build ran. */
export interface SkippedIndexBuild {
  skipped: RunLockHolder;
}

/** Whether a build outcome says it was skipped. Takes `unknown` so improve's loosely typed `reindexFn` test stubs can be passed straight in. */
export function isSkippedIndexBuild(result: unknown): result is SkippedIndexBuild {
  return typeof result === "object" && result !== null && "skipped" in result;
}

/** What a skipped build reports: why nothing was built and who held the lock. */
export interface SkippedIndexReport {
  reason: "lock-held";
  pid: number | null;
  /** The launcher pid is what process listings and task logs show, not the bun/node child's. */
  launcherPid: number | null;
  startedAt: string | null;
}

export function skippedIndexReport(result: SkippedIndexBuild): SkippedIndexReport {
  return {
    reason: "lock-held",
    pid: result.skipped.pid,
    launcherPid: result.skipped.launcherPid,
    startedAt: result.skipped.startedAt,
  };
}

export async function buildIndex(options: IndexOptions): Promise<IndexResponse | SkippedIndexBuild> {
  const lock = acquireBuildLock();
  if ("skipped" in lock) return lock;
  try {
    return await buildUnderLock(options);
  } finally {
    releaseIndexRebuildLock(lock.ownership);
  }
}

/**
 * Take the rebuild lock, then run `run` with a `build` that builds under that lock; release it when `run` settles.
 * `build` must not be called after `run` returns. When a live process holds the lock `run` still runs, and its
 * `build` skips instead of building, so what `run` publishes is indexed by the next build.
 */
export async function withIndexBuildLock<T>(
  run: (build: (options: IndexOptions) => Promise<IndexResponse | SkippedIndexBuild>) => Promise<T>,
): Promise<T> {
  const lock = acquireBuildLock();
  if ("skipped" in lock) return run(async () => lock);
  try {
    return await run(buildUnderLock);
  } finally {
    releaseIndexRebuildLock(lock.ownership);
  }
}

function buildUnderLock(options: IndexOptions): Promise<IndexResponse> {
  // §11.5: warn (once) if the configured bundle ids drifted from the persisted
  // index prefixes (hand-renamed bundle key) BEFORE the build could re-mint.
  warnOnBundleRenameDrift();
  return akmIndex(options);
}

function acquireBuildLock(): { ownership: LockOwnership } | SkippedIndexBuild {
  const lock = tryAcquireIndexRebuildLock();
  if (lock.state === "held") {
    warn(`[index] another index run holds the lock (${describeLockHolder(lock.holder)}); not building.`);
    return { skipped: lock.holder };
  }
  return { ownership: lock.ownership };
}
