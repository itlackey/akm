// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit scheduler: a policy layer over `concurrentMap`. The effective width is
 * the minimum of the map request, the frozen workflow cap, the LLM engine's
 * frozen cap, and the current host's CPU cap (reapplied, since a run may
 * resume on a smaller machine). Cancellation is cooperative via AbortSignal.
 */

import { concurrentMap } from "../../core/concurrent";
import { cpuDerivedUnitConcurrency, workflowMaxConcurrency } from "../concurrency-policy";

export {
  clampMaxConcurrency,
  cpuDerivedUnitConcurrency,
  WORKFLOW_MAX_CONCURRENCY_CEILING,
} from "../concurrency-policy";

/**
 * Engine-wide ceiling on concurrent units: an explicit `workflow.maxConcurrency`
 * clamped to `[1, 64]`, else `min(16, max(1, cores − 2))`.
 */
export function maxUnitConcurrency(cpuCount?: number, configured?: number): number {
  return workflowMaxConcurrency(configured, cpuCount);
}

export interface ScheduleOptions {
  /** Requested per-step width (frozen into the plan); unspecified runs serially. */
  concurrency?: number;
  signal?: AbortSignal;
  /** Engine cap override (tests, and a run's frozen `execution.maxConcurrency`). */
  maxConcurrency?: number;
  /** Frozen concurrency limit of the selected LLM engine, when one is used. */
  llmConcurrency?: number;
  /** Test seam for the current host's CPU-derived safety limit. */
  hostConcurrency?: number;
}

/**
 * Run `dispatch` over `items` under the concurrency caps. Failures do not
 * cancel siblings; a slot that threw or was never claimed after an abort
 * stays `undefined`.
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
