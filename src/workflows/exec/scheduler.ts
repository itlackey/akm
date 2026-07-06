// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit scheduler for the native workflow executor (orchestration plan P1).
 *
 * A thin policy layer over `core/concurrent.ts` (`concurrentMap`) — the
 * existing semaphore-bounded pool is generalized, not forked. The scheduler
 * owns the engine-wide limits the plan requires:
 *
 *   - Concurrency cap `min(16, cores − 2)` (matching Claude Code), applied on
 *     top of whatever per-step concurrency the workflow declares.
 *   - A lifetime unit cap per run as a runaway backstop.
 *   - Cooperative cancellation via AbortSignal (workers stop claiming items;
 *     the same signal is passed into each dispatch so in-flight units can be
 *     preempted too).
 */

import os from "node:os";
import { concurrentMap } from "../../core/concurrent";

/** Engine-wide ceiling on concurrent units, matching Claude Code's cap. */
export function maxUnitConcurrency(cpuCount = os.cpus()?.length ?? 4): number {
  return Math.min(16, Math.max(1, cpuCount - 2));
}

/** Lifetime unit cap per run — a runaway-loop backstop, far above real use. */
export const LIFETIME_UNIT_CAP = 1000;

export class UnitCapExceededError extends Error {
  constructor(cap: number) {
    super(`workflow run exceeded the lifetime unit cap (${cap}). Aborting dispatch — check for a runaway fan-out.`);
    this.name = "UnitCapExceededError";
  }
}

export interface ScheduleOptions {
  /**
   * Requested per-step concurrency; clamped to {@link maxUnitConcurrency}.
   * DEFAULTS TO 1 (not the cap): the repo's LLM-defaults rule is "works
   * correctly for the lowest common denominator — a slow local model on a
   * single-threaded server" (AGENTS.md). A fan-out that wants parallelism
   * declares `concurrency:` explicitly; the engine cap only ever clamps.
   */
  concurrency?: number;
  signal?: AbortSignal;
  /** Units already dispatched in this run, counted toward the lifetime cap. */
  unitsDispatched?: number;
  /** Test seam for the CPU-derived cap. */
  maxConcurrency?: number;
}

/**
 * Run `dispatch` over `items` under the engine caps. Individual failures do
 * not cancel siblings (allSettled semantics from `concurrentMap`); a slot
 * whose dispatch threw or that was never claimed after an abort stays
 * `undefined` in the result array.
 *
 * @throws UnitCapExceededError before dispatching anything when items would
 *         push the run past {@link LIFETIME_UNIT_CAP}.
 */
export async function scheduleUnits<T, R>(
  items: T[],
  dispatch: (item: T, index: number) => Promise<R>,
  options: ScheduleOptions = {},
): Promise<Array<R | undefined>> {
  const already = options.unitsDispatched ?? 0;
  if (already + items.length > LIFETIME_UNIT_CAP) {
    throw new UnitCapExceededError(LIFETIME_UNIT_CAP);
  }
  const cap = options.maxConcurrency ?? maxUnitConcurrency();
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 1, cap));
  return concurrentMap(items, dispatch, concurrency, { signal: options.signal });
}
