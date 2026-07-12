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
 *   - Engine-wide concurrency cap, applied on top of whatever per-step
 *     concurrency the workflow declares. The cap is the `workflow.maxConcurrency`
 *     akm config setting when set (clamped to
 *     `[1, WORKFLOW_MAX_CONCURRENCY_CEILING]`), else the CPU-derived default
 *     `min(16, cores − 2)` (the original Claude-Code-matching formula).
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

import os from "node:os";
import { concurrentMap } from "../../core/concurrent";
import { WORKFLOW_MAX_MAP_EXPANSION } from "../resource-limits";

/**
 * Hard ceiling on an EXPLICIT `workflow.maxConcurrency`. A user value above
 * this is clamped down (not rejected) so a config shared across machines with
 * very different core counts never hard-fails; a value below 1 is floored to 1.
 * 64 is deliberately far above any sane fan-out width — it exists only to keep
 * a fat-fingered `100000` from spawning a runaway pool.
 */
export const WORKFLOW_MAX_CONCURRENCY_CEILING = 64;

/**
 * CPU-derived engine cap used when `workflow.maxConcurrency` is unset — the
 * original `min(16, cores−2)` formula (matching Claude Code), floored at 1.
 */
export function cpuDerivedUnitConcurrency(cpuCount = os.cpus()?.length ?? 4): number {
  return Math.min(16, Math.max(1, cpuCount - 2));
}

/** Clamp an explicit configured value into `[1, WORKFLOW_MAX_CONCURRENCY_CEILING]`. */
export function clampMaxConcurrency(value: number): number {
  return Math.min(WORKFLOW_MAX_CONCURRENCY_CEILING, Math.max(1, Math.floor(value)));
}

/**
 * Read `workflow.maxConcurrency` from config, fail-open to `undefined` (use the
 * CPU default) on any load error or a non-numeric value. Kept side-effect-free
 * and defensive: the scheduler must never fail a run because config is unwell.
 */
function configuredMaxConcurrency(): number | undefined {
  // Execution receives the frozen per-run policy through ScheduleOptions. This
  // fallback deliberately never reads live config, which could otherwise alter
  // a resumed run's dispatch width.
  return undefined;
}

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
export function maxUnitConcurrency(cpuCount = os.cpus()?.length ?? 4, configured = configuredMaxConcurrency()): number {
  if (configured !== undefined) return clampMaxConcurrency(configured);
  return cpuDerivedUnitConcurrency(cpuCount);
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
  const cap = options.maxConcurrency ?? maxUnitConcurrency();
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 1, cap));
  return concurrentMap(items, dispatch, concurrency, { signal: options.signal });
}
