// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os from "node:os";
import { WORKFLOW_MAX_CONCURRENCY } from "./resource-limits";

/**
 * Run-level ceiling on `workflow.maxConcurrency`. It is deliberately the SAME
 * value the frozen-plan decoder enforces on `execution.maxConcurrency` and on
 * per-step `map.concurrency` — a clamp above the decoder's bound would freeze
 * plans the decoder then rejects — so it reads the single shared constant
 * (`./resource-limits`) rather than repeating the literal.
 */
export const WORKFLOW_MAX_CONCURRENCY_CEILING = WORKFLOW_MAX_CONCURRENCY;

export function cpuDerivedUnitConcurrency(cpuCount = os.cpus()?.length ?? 4): number {
  return Math.min(16, Math.max(1, cpuCount - 2));
}

export function clampMaxConcurrency(value: number): number {
  return Math.min(WORKFLOW_MAX_CONCURRENCY_CEILING, Math.max(1, Math.floor(value)));
}

/** Resolve and freeze the engine-wide cap once when a workflow run starts. */
export function workflowMaxConcurrency(configured?: number, cpuCount = os.cpus()?.length ?? 4): number {
  return configured === undefined ? cpuDerivedUnitConcurrency(cpuCount) : clampMaxConcurrency(configured);
}
