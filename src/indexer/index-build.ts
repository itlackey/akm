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
 *  - `"wait"` — explicit and mutating commands. Waits for a running build, with a
 *    notice while waiting, then builds.
 *  - `"try"` — opportunistic callers (`--skip-if-locked`, improve's pre-run
 *    index). When a live process holds the lock they do not build and carry on
 *    with the index as it is.
 *
 * Not re-entrant: no build path calls another from inside its own build. A caller
 * that must hold the lock around more than the build (`bundle update` publishes
 * and indexes under the asset mutation lease) takes it with
 * {@link withIndexBuildLock}, which hands it a `build` that runs under the lock
 * it already holds. Lock order is always the rebuild lock first, then the asset
 * mutation lease, so nothing waits for the rebuild lock while holding the lease.
 */

import { TransientError } from "../core/errors";
import type { LockOwnership } from "../core/file-lock";
import type { RunLockHolder } from "../core/run-lock";
import { warn } from "../core/warn";
import { warnOnBundleRenameDrift } from "./bundle-identity-guard";
import { describeLockHolder, releaseIndexRebuildLock, tryAcquireIndexRebuildLock } from "./index-rebuild-lock";
import { akmIndex, type IndexOptions, type IndexResponse } from "./indexer";

// Same shape as the asset mutation lease (`index-writer-lock.ts`): a 100 ms poll, a
// notice every 15 s, and a 10 minute bound.
const WAIT_POLL_MS = 100;
const WAIT_NOTICE_INTERVAL_MS = 15_000;
const DEFAULT_MAX_WAIT_MS = 10 * 60 * 1000;

let waitTimingForTests: { maxWaitMs?: number; noticeIntervalMs?: number } | undefined;
/** TEST-ONLY. Shrinks the wait bound and notice cadence so a test does not block for real minutes. */
export function _setIndexBuildWaitTimingForTests(overrides?: { maxWaitMs?: number; noticeIntervalMs?: number }): void {
  waitTimingForTests = overrides;
}

/** `"try"` found a live holder and did not build. */
export interface SkippedIndexBuild {
  skipped: RunLockHolder;
}

/** Whether a build outcome says it was skipped. Takes `unknown` so improve's loosely typed `reindexFn` test stubs can be passed straight in. */
export function isSkippedIndexBuild(result: unknown): result is SkippedIndexBuild {
  return typeof result === "object" && result !== null && "skipped" in result;
}

export async function buildIndex(options: IndexOptions, mode: "wait"): Promise<IndexResponse>;
export async function buildIndex(options: IndexOptions, mode: "try"): Promise<IndexResponse | SkippedIndexBuild>;
export async function buildIndex(
  options: IndexOptions,
  mode: "wait" | "try",
): Promise<IndexResponse | SkippedIndexBuild>;
export async function buildIndex(
  options: IndexOptions,
  mode: "wait" | "try",
): Promise<IndexResponse | SkippedIndexBuild> {
  const lock = await acquireBuildLock(mode, options.signal);
  if ("skipped" in lock) return lock;
  try {
    return await buildUnderLock(options);
  } finally {
    releaseIndexRebuildLock(lock.ownership);
  }
}

/**
 * Take the rebuild lock (waiting for a running build, as `"wait"`), then run `run` with a `build` that builds under
 * that lock; release it when `run` settles. A build cannot start without the lock, and `build` must not be called
 * after `run` returns.
 */
export async function withIndexBuildLock<T>(
  signal: AbortSignal | undefined,
  run: (build: (options: IndexOptions) => Promise<IndexResponse>) => Promise<T>,
): Promise<T> {
  const lock = await acquireBuildLock("wait", signal);
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

async function acquireBuildLock(mode: "wait", signal: AbortSignal | undefined): Promise<{ ownership: LockOwnership }>;
async function acquireBuildLock(
  mode: "wait" | "try",
  signal: AbortSignal | undefined,
): Promise<{ ownership: LockOwnership } | SkippedIndexBuild>;
async function acquireBuildLock(
  mode: "wait" | "try",
  signal: AbortSignal | undefined,
): Promise<{ ownership: LockOwnership } | SkippedIndexBuild> {
  const startedAt = Date.now();
  const maxWaitMs = waitTimingForTests?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const noticeIntervalMs = waitTimingForTests?.noticeIntervalMs ?? WAIT_NOTICE_INTERVAL_MS;
  let lastNoticeMs: number | undefined;

  let lock = tryAcquireIndexRebuildLock();
  while (lock.state === "held") {
    if (mode === "try") {
      warn(`[index] another index run holds the lock (${describeLockHolder(lock.holder)}); not building.`);
      return { skipped: lock.holder };
    }
    if (signal?.aborted) throw signal.reason ?? new Error("index interrupted");
    const waitedMs = Date.now() - startedAt;
    // Time out only after a real attempt at a free lock, so a bound of 0 still gets one try.
    if (waitedMs >= maxWaitMs) {
      throw new TransientError(
        `Another akm process is still building the index (${describeLockHolder(lock.holder)}); gave up waiting after ` +
          `${Math.round(waitedMs / 1000)}s. Retry shortly.`,
        "INDEX_DB_CONTENDED",
      );
    }
    if (lastNoticeMs === undefined || waitedMs - lastNoticeMs >= noticeIntervalMs) {
      warn(
        `[index] waiting for another index run (${describeLockHolder(lock.holder)}) — ${Math.round(waitedMs / 1000)}s`,
      );
      lastNoticeMs = waitedMs;
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
    lock = tryAcquireIndexRebuildLock();
  }
  return { ownership: lock.ownership };
}
