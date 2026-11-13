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
 * Not re-entrant: no build path calls another from inside its own build, and a
 * caller that ever needs to must pass its lock down rather than take it twice.
 */

import { TransientError } from "../core/errors";
import { formatLockHolderPid, type RunLockHolder } from "../core/run-lock";
import { warn } from "../core/warn";
import { warnOnBundleRenameDrift } from "./bundle-identity-guard";
import { releaseIndexRebuildLock, tryAcquireIndexRebuildLock } from "./index-rebuild-lock";
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

function holderLabel(holder: RunLockHolder): string {
  return `pid ${formatLockHolderPid(holder)}, started ${holder.startedAt ?? "unknown"}`;
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
  const startedAt = Date.now();
  const maxWaitMs = waitTimingForTests?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const noticeIntervalMs = waitTimingForTests?.noticeIntervalMs ?? WAIT_NOTICE_INTERVAL_MS;
  let lastNoticeMs: number | undefined;

  let lock = tryAcquireIndexRebuildLock();
  while (lock.state === "held") {
    if (mode === "try") {
      warn(`[index] another index run holds the lock (${holderLabel(lock.holder)}); not building.`);
      return { skipped: lock.holder };
    }
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("index interrupted");
    const waitedMs = Date.now() - startedAt;
    // Time out only after a real attempt at a free lock, so a bound of 0 still gets one try.
    if (waitedMs >= maxWaitMs) {
      throw new TransientError(
        `Another akm process is still building the index (${holderLabel(lock.holder)}); gave up waiting after ` +
          `${Math.round(waitedMs / 1000)}s. Retry shortly.`,
        "INDEX_DB_CONTENDED",
      );
    }
    if (lastNoticeMs === undefined || waitedMs - lastNoticeMs >= noticeIntervalMs) {
      warn(`[index] waiting for another index run (${holderLabel(lock.holder)}) — ${Math.round(waitedMs / 1000)}s`);
      lastNoticeMs = waitedMs;
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
    lock = tryAcquireIndexRebuildLock();
  }

  try {
    // §11.5: warn (once) if the configured bundle ids drifted from the persisted
    // index prefixes (hand-renamed bundle key) BEFORE the build could re-mint.
    warnOnBundleRenameDrift();
    return await akmIndex(options);
  } finally {
    releaseIndexRebuildLock(lock.ownership);
  }
}
