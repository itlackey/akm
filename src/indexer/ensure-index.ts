// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `improve`'s pre-run index. Its planning logic needs a current `entries` table
 * in-process, so it runs an incremental build before selecting work, letting
 * the per-file fingerprints decide what changed (across every bundle, not just
 * the primary stash).
 *
 * It takes the rebuild lock in `"try"` mode: when another process is building,
 * improve does not wait for it or build beside it — it plans on the entries the
 * index has and says so. Reads never build (`index-readiness.ts`).
 */

import { warnVerbose } from "../core/warn";
import { buildIndex, type SkippedIndexBuild } from "./index-build";
import type { IndexResponse } from "./indexer";

export interface EnsureIndexOptions {
  signal?: AbortSignal;
  /**
   * R6: called with the run's timing when it actually builds, so improve can
   * surface the build's cost instead of it being silently discarded. Never
   * called when the build was skipped.
   */
  onReindexTiming?: (info: { durationMs: number; timing: IndexResponse["timing"] }) => void;
}

/**
 * Build the index for improve's planning. Returns the build's response, or
 * `{ skipped }` when a live process holds the rebuild lock. A build that fails
 * propagates its error to the caller rather than silently planning on a
 * stale or missing index.
 */
export async function ensureIndex(
  stashDir: string,
  options: EnsureIndexOptions = {},
): Promise<IndexResponse | SkippedIndexBuild> {
  const startedMs = Date.now();
  // A sanctioned materialization point: cache-backed sources hydrate as usual.
  const response = await buildIndex(
    { stashDir, implicit: true, ...(options.signal ? { signal: options.signal } : {}) },
    "try",
  );
  if ("skipped" in response) return response;
  // Fall back to a wall-clock measurement when the response carries no `timing` block.
  const durationMs = response.timing?.totalMs ?? Date.now() - startedMs;
  const timing = response.timing;
  warnVerbose(
    `[ensure-index] reindex completed in ${durationMs}ms` +
      (timing
        ? ` (walk=${timing.walkMs}ms llm=${timing.llmMs}ms embed=${timing.embedMs}ms finalize=${timing.finalizeMs}ms)`
        : ""),
  );
  options.onReindexTiming?.({ durationMs, timing });
  return response;
}
