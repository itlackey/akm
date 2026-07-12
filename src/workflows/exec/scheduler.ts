// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit scheduler for the native workflow executor (orchestration plan P1).
 *
 * A thin policy layer over `core/concurrent.ts` (`concurrentMap`) — the
 * existing semaphore-bounded pool is generalized, not forked. The scheduler
 * owns the limits the plan requires:
 *
 *   - The effective width is the minimum of the map request, the frozen
 *     workflow cap, the selected LLM engine's frozen cap (when applicable),
 *     and the current host's CPU-derived safety cap. Reapplying host safety at
 *     dispatch matters when a frozen run resumes on a smaller machine.
 *   - Cooperative cancellation via AbortSignal (workers stop claiming items;
 *     the same signal is passed into each dispatch so in-flight units can be
 *     preempted too).
 *
 * The lifetime unit cap ({@link LIFETIME_UNIT_CAP}) is DECLARED here but
 * enforced per actual dispatch by the native executor: a pre-batch check
 * (`journaled + items.length`) counted durable-row REUSES as new dispatches,
 * which made any partially-completed fan-out with more than ~cap/2 journaled
 * units impossible to resume (peer review R1). Only work that really
 * dispatches consumes the cap.
 */

import { concurrentMap } from "../../core/concurrent";
import { cpuDerivedUnitConcurrency, workflowMaxConcurrency } from "../concurrency-policy";
import { WORKFLOW_MAX_MAP_EXPANSION } from "../resource-limits";

export {
  clampMaxConcurrency,
  cpuDerivedUnitConcurrency,
  WORKFLOW_MAX_CONCURRENCY_CEILING,
} from "../concurrency-policy";

/**
 * Hard ceiling on an EXPLICIT `workflow.maxConcurrency`. A user value above
 * this is clamped down (not rejected) so a config shared across machines with
 * very different core counts never hard-fails; a value below 1 is floored to 1.
 * 64 is deliberately far above any sane fan-out width — it exists only to keep
 * a fat-fingered `100000` from spawning a runaway pool.
 */
/**
 * Engine-wide ceiling on concurrent units. Precedence:
 *   1. An explicit `workflow.maxConcurrency` config value, clamped to
 *      `[1, WORKFLOW_MAX_CONCURRENCY_CEILING]`.
 *   2. Otherwise the CPU-derived default `min(16, max(1, cores−2))`.
 * The per-run test seam (`ScheduleOptions.maxConcurrency`) is applied ABOVE
 * this in {@link scheduleUnits}, so it always wins for tests.
 *
 * @param cpuCount   CPU count for the fallback formula (injected by tests).
 * @param configured Explicit config value seam (defaults to reading config);
 *                   pass `undefined` explicitly to force the CPU path in a test.
 */
export function maxUnitConcurrency(cpuCount?: number, configured?: number): number {
  return workflowMaxConcurrency(configured, cpuCount);
}

/** Lifetime unit cap per run — a runaway-loop backstop, far above real use. */
export const LIFETIME_UNIT_CAP = WORKFLOW_MAX_MAP_EXPANSION;

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
  /**
   * Test seam for the engine cap. When set it OVERRIDES both the
   * `workflow.maxConcurrency` config value and the CPU-derived default —
   * tests pin an exact cap without depending on the host's core count or a
   * config file. Production callers leave it unset so {@link maxUnitConcurrency}
   * (config → CPU default) decides.
   */
  maxConcurrency?: number;
  /** Frozen concurrency limit of the selected LLM engine, when one is used. */
  llmConcurrency?: number;
  /** Test seam for the current host's CPU-derived safety limit. */
  hostConcurrency?: number;
}

/**
 * Run `dispatch` over `items` under the engine concurrency caps. Individual
 * failures do not cancel siblings (allSettled semantics from `concurrentMap`);
 * a slot whose dispatch threw or that was never claimed after an abort stays
 * `undefined` in the result array. The lifetime unit cap is NOT checked here
 * — the executor consumes it per actual dispatch, so durable-row reuses on
 * resume stay free.
 */
export async function scheduleUnits<T, R>(
  items: T[],
  dispatch: (item: T, index: number) => Promise<R>,
  options: ScheduleOptions = {},
): Promise<Array<R | undefined>> {
  const concurrency = Math.max(
    1,
    Math.min(
      options.concurrency ?? 1,
      options.maxConcurrency ?? Number.POSITIVE_INFINITY,
      options.llmConcurrency ?? Number.POSITIVE_INFINITY,
      options.hostConcurrency ?? cpuDerivedUnitConcurrency(),
    ),
  );
  return concurrentMap(items, dispatch, concurrency, { signal: options.signal });
}
