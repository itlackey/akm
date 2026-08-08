// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

export const WORKFLOW_MAX_PLAN_BYTES = 2 * 1024 * 1024;
export const WORKFLOW_MAX_SOURCE_BYTES = 1024 * 1024;
export const WORKFLOW_MAX_STEPS = 256;
export const WORKFLOW_MAX_ENGINES = 64;
export const WORKFLOW_MAX_PARAMS = 128;
export const WORKFLOW_MAX_ROUTE_BRANCHES = 256;
export const WORKFLOW_MAX_INSTRUCTION_BYTES = 256 * 1024;
export const WORKFLOW_MAX_SCHEMA_BYTES = 256 * 1024;
export const WORKFLOW_MAX_EXTRA_PARAMS_BYTES = 64 * 1024;
export const WORKFLOW_MAX_JSON_DEPTH = 64;
export const WORKFLOW_MAX_MAP_EXPANSION = 10_000;
/** Max declared `inputs:` reference strings on one unit/map step. */
export const WORKFLOW_MAX_INPUTS = 64;

// ── Dispatch-significant bounds shared across validation layers ──────────────
//
// Defined ONCE here so the three enforcement layers cannot drift:
//   1. the parser (`../parser.ts`) — line-anchored authoring-time errors,
//   2. the published JSON Schema (`schemas/akm-workflow.json`) — mirrored
//      `maximum`/`pattern`/`maxLength` values, pinned against these constants
//      by `tests/integration/workflows/schema-drift.test.ts`,
//   3. the strict frozen-plan decoder (`./ir/schema.ts`) — the corruption
//      gate for persisted plans.
// A bound enforced only by the decoder surfaces as a terse, unlocated
// "Invalid frozen workflow plan" at `workflow run` — after lint and
// `workflow create` already said the document was fine.

/** Max per-step map fan-out concurrency (also the run-level concurrency ceiling). */
export const WORKFLOW_MAX_CONCURRENCY = 64;
/** Max evaluator-optimizer gate loops per step. */
export const WORKFLOW_MAX_GATE_LOOPS = 100;
/** Max retry attempts per unit. */
export const WORKFLOW_MAX_RETRIES = 100;
/** Max timeout in milliseconds (setTimeout's 32-bit signed ceiling: 2^31-1, ~24.8 days). */
export const WORKFLOW_MAX_TIMEOUT_MS = 2 ** 31 - 1;
/** Engine names: lowercase dash-separated runs of letters/digits, starting with a letter. */
export const WORKFLOW_ENGINE_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const WORKFLOW_MAX_ENGINE_NAME_LENGTH = 63;

// ── Persistence bounds ───────────────────────────────────────────────────────

/**
 * Max serialized size of one `workflow_run_steps.evidence_json` row value.
 *
 * The promoted step artifact (`evidence.output`) is deliberately NOT clipped
 * when it is built — gates judge the full artifact and downstream
 * `steps.<id>.output` references need it intact — but a `collect`
 * reducer over a fan-out bounded only by {@link WORKFLOW_MAX_MAP_EXPANSION}
 * (10 000 units, each contributing up to a full unit result) would otherwise
 * write an unbounded blob into a single SQLite row. Persistence is therefore
 * bounded here, at the write boundary, by
 * `clipStepEvidenceForPersistence` (`runtime/runs.ts`), which replaces
 * oversized values with an explicitly-marked truncation envelope rather than
 * silently shortening them.
 *
 * 1 MiB is deliberately generous: it is 4× the per-instruction cap and half the
 * whole-plan cap, so no realistic authored workflow reaches it, while a runaway
 * fan-out is still bounded to something SQLite and `akm workflow status` can
 * handle.
 */
export const WORKFLOW_MAX_EVIDENCE_JSON_BYTES = 1024 * 1024;

/** Chars of the original value retained (as a marked preview) in a truncation envelope. */
export const WORKFLOW_EVIDENCE_TRUNCATION_PREVIEW_CHARS = 1000;

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function jsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value));
}
