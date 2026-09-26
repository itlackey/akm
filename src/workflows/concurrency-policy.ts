// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os from "node:os";
import { isLoopbackEndpoint } from "../core/loopback";
import { WORKFLOW_MAX_CONCURRENCY } from "./resource-limits";

/** Run-level ceiling on `workflow.maxConcurrency` (the same bound as `map.concurrency`). */
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

// ── Fan-out defaults ─────────────────────────────────────────────────────────
//
// A `map` step's real width is the minimum of its own `map.concurrency`, the
// run's frozen `execution.maxConcurrency`, the LLM engine's frozen
// concurrency, and the host CPU cap. The defaults are modest: map units call
// rate-limited providers and RAM-hungry agents.

/**
 * Default width of a `map` step with no `concurrency:` — a predictable number
 * rather than the host cap, so a plan behaves the same wherever it resumes.
 * Overridden per step (`map.concurrency`) or per install
 * (`workflow.defaultMapConcurrency`; `1` restores serial fan-out).
 */
export const DEFAULT_MAP_CONCURRENCY = 4;

/** Default concurrency for an LLM engine on a loopback endpoint: a local model server runs one inference. */
export const DEFAULT_LOCAL_LLM_ENGINE_CONCURRENCY = 1;

/** Default concurrency for a remote LLM engine: equal to {@link DEFAULT_MAP_CONCURRENCY}, so it never re-serializes a map. */
export const DEFAULT_REMOTE_LLM_ENGINE_CONCURRENCY = 4;

export { isLoopbackEndpoint, isLoopbackHost } from "../core/loopback";

/** Concurrency to freeze for an LLM engine: an explicit `engines.<name>.concurrency` (clamped), else by endpoint. */
export function defaultLlmEngineConcurrency(endpoint: string | undefined, configured?: number): number {
  if (typeof configured === "number" && Number.isFinite(configured)) return clampMaxConcurrency(configured);
  return isLoopbackEndpoint(endpoint) ? DEFAULT_LOCAL_LLM_ENGINE_CONCURRENCY : DEFAULT_REMOTE_LLM_ENGINE_CONCURRENCY;
}

/** Width to freeze for a `map` step with no `concurrency:` (`configured` is `workflow.defaultMapConcurrency`). */
export function defaultMapConcurrency(configured?: number): number {
  return configured === undefined || !Number.isFinite(configured)
    ? DEFAULT_MAP_CONCURRENCY
    : clampMaxConcurrency(configured);
}
