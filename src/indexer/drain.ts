// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * stage-2 stub, superseded at merge.
 *
 * Owner: module B4, docs/plans/index-redesign-contract.md. This file exists
 * only so module B2 (`index-written-assets.ts`) can be written and tested
 * against B4's real function signature before B4 lands. It does NONE of
 * B4's actual job — no provider batching, no `units_vec` writes, no identity
 * learning, no retry/back-off/circuit breaker. It records exactly which unit
 * hashes it was asked to drain, so B2's test suite can prove
 * `indexWrittenAssets` asked for exactly the units its write produced. The
 * integrator deletes this file and takes B4's `src/indexer/drain.ts`
 * instead.
 */

import type { AkmConfig } from "../core/config/config";
import type { Database } from "../storage/database";

export interface DrainCounts {
  pending: number;
  embedded: number;
  failed: number;
  skipped: number;
  identity: string | null;
}

export interface DrainRecord {
  onlyHashes: readonly string[];
}

/** Stage-2 stub glue: every `drainEmbeddingQueue` call this process made, in order — for tests to assert against. */
const calls: DrainRecord[] = [];

/** Stage-2 stub glue: read back what {@link drainEmbeddingQueue} was asked to drain, most recent last. */
export function _drainCallsForTests(): readonly DrainRecord[] {
  return calls;
}

/** Stage-2 stub glue: clear recorded calls between tests. */
export function _resetDrainCallsForTests(): void {
  calls.length = 0;
}

/**
 * Stage-2 stub: records `opts.onlyHashes` (defaulting to none requested) and
 * reports them all as `skipped` — no provider is called, no `units_vec` row
 * is written. A real drain (B4) embeds them for real; this stub only proves
 * that `indexWrittenAssets` (B2) asked for the right set.
 */
export async function drainEmbeddingQueue(
  _db: Database,
  _config: AkmConfig,
  opts: {
    signal?: AbortSignal;
    onProgress?: (line: string) => void;
    limit?: number;
    onlyHashes?: readonly string[];
  } = {},
): Promise<DrainCounts> {
  const onlyHashes = opts.onlyHashes ?? [];
  calls.push({ onlyHashes });
  opts.onProgress?.(`drain (stage-2 stub): recorded ${onlyHashes.length} unit hash(es), embedded none`);
  return { pending: onlyHashes.length, embedded: 0, failed: 0, skipped: onlyHashes.length, identity: null };
}
