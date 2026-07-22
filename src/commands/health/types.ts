// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared type surface + constants for the `akm health` command modules.
 * These interfaces are consumed across health/{improve-metrics,task-runs,
 * windows,llm-usage,metrics,advisories}.ts, the report renderers, and the
 * check registry.
 *
 * Chunk-9 WI-9.5d: this used to be one 690-line type dump. It is now a
 * re-export barrel over cohesive per-domain modules (pure type move — zero
 * runtime change, every existing `from "./types"` / `from "../health/types"`
 * import site keeps working unchanged):
 *   - `./types-checks` — {@link HealthCheckResult}.
 *   - `./types-metrics` — {@link HealthMetrics} + the LLM usage aggregates.
 *   - `./types-improve` — the {@link ImproveHealthMetrics} accumulator and its
 *     WS-5 sub-rollups (coverage, perf telemetry, degradation, enrichment
 *     minting).
 *   - `./types-session-log` — {@link SessionLogAdvisory}.
 *   - `./types-runs` — {@link ImproveRunSummary} (`--group-by run`).
 *   - `./types-windows` — {@link WindowSpec}/{@link WindowResult}/{@link DeltaEntry}
 *     (`--window-compare`/`--windows`).
 *   - `./types-result` — {@link AkmHealthResult}, the `akmHealth()` return type.
 */

export * from "./types-checks";
export * from "./types-improve";
export * from "./types-metrics";
export * from "./types-result";
export * from "./types-runs";
export * from "./types-session-log";
export * from "./types-windows";
