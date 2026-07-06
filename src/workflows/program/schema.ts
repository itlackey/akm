// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Parsed shape of a YAML workflow *program* (redesign addendum, R1).
 *
 * `parseWorkflowProgram` (parser.ts) converts a YAML program file under
 * `workflows/` into a `WorkflowProgram` plus accumulated `WorkflowError`s.
 * The types mirror the YAML surface pinned by the addendum and the published
 * JSON Schema (`schemas/akm-workflow.json`); the compiler lowers this shape
 * into the plan-graph IR. Enum vocabularies here are the single TypeScript
 * source of truth — `tests/workflows/program-parser.test.ts` pins the JSON
 * Schema's enums against these constants so the two cannot drift.
 *
 * Naming: YAML keys are snake_case (`on_error`, `max_loops`); the parsed
 * document uses the repo's camelCase convention (`onError`, `maxLoops`).
 * `timeout` strings ("10m", "30s", "500ms", "none") are parsed into
 * `timeoutMs` (`null` = explicitly no timeout) — the same representation the
 * existing IR uses.
 */

import type { AgentFailureReason } from "../../integrations/agent/spawn";
import type { SourceRef, WorkflowError } from "../schema";

export const WORKFLOW_PROGRAM_VERSION = 1;

/** Execution backend for a unit. `inherit` defers to the run-level default. */
export const PROGRAM_RUNNER_KINDS = ["llm", "agent", "sdk", "inherit"] as const;
export type ProgramRunnerKind = (typeof PROGRAM_RUNNER_KINDS)[number];

/** How a map step folds its per-item unit results into the step artifact. */
export const PROGRAM_REDUCERS = ["collect", "vote"] as const;
export type ProgramReducer = (typeof PROGRAM_REDUCERS)[number];

/** Failure policy: fail the step on first unit failure, or record and go on. */
export const PROGRAM_ON_ERROR = ["fail", "continue"] as const;
export type ProgramOnError = (typeof PROGRAM_ON_ERROR)[number];

/** Filesystem isolation for file-mutating units (enforcement is R2). */
export const PROGRAM_ISOLATION_KINDS = ["none", "worktree"] as const;
export type ProgramIsolation = (typeof PROGRAM_ISOLATION_KINDS)[number];

/**
 * `retry.on` vocabulary — exactly the persisted `AgentFailureReason` taxonomy
 * from `src/integrations/agent/spawn.ts`. The `satisfies` clause fails the
 * typecheck if spawn.ts adds/renames a reason without this list (and the JSON
 * Schema, via the drift test) being updated.
 */
const RETRY_REASON_SET = {
  timeout: true,
  spawn_failed: true,
  non_zero_exit: true,
  parse_error: true,
  cooldown: true,
  llm_rate_limit: true,
  llm_content_filter: true,
  llm_invalid_json: true,
  content_policy_reject: true,
  unsupported_type: true,
  no_change: true,
  aborted: true,
} as const satisfies Record<AgentFailureReason, true>;

export const PROGRAM_RETRY_REASONS = Object.keys(RETRY_REASON_SET) as readonly AgentFailureReason[];

/** Step ids: `[A-Za-z0-9][A-Za-z0-9._-]*` (also pinned in the JSON Schema). */
export const PROGRAM_STEP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Param names must be `${{ params.<ident> }}`-addressable, so they are plain
 * identifiers (no dots/dashes).
 */
export const PROGRAM_PARAM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Bounded retry on transient failures, keyed on the persisted taxonomy. */
export interface ProgramRetry {
  max: number;
  on: AgentFailureReason[];
}

/** A single dispatchable unit: instructions plus dispatch overrides. */
export interface ProgramUnit {
  /** Execution backend override. Absent = run default (`defaults.runner`). */
  runner?: ProgramRunnerKind;
  /** Agent/LLM profile name. */
  profile?: string;
  /** Model alias (tier) or exact id; resolved per-harness at dispatch. */
  model?: string;
  /** Parsed per-unit timeout in ms; `null` = explicitly "none"; absent = default. */
  timeoutMs?: number | null;
  retry?: ProgramRetry;
  onError?: ProgramOnError;
  /** Instruction template. `${{ … }}` segments are parsed, never re-scanned. */
  instructions: string;
  /** JSON Schema the unit's structured result must validate against. */
  output?: Record<string, unknown>;
  /** Env asset refs injected into the dispatched unit env. */
  env?: string[];
  /** TODO(R2): carried through the IR; enforcement lands with the engine rework. */
  isolation?: ProgramIsolation;
  source: SourceRef;
}

/** Fan the unit template out over an expression-addressed list. */
export interface ProgramMap {
  /** `${{ … }}` expression naming the producer of the item list. */
  over: string;
  /** Max concurrent units for this step; capped by the engine's global limit. */
  concurrency?: number;
  /** Result reducer. Default: collect. */
  reducer?: ProgramReducer;
  unit: ProgramUnit;
}

/** One `when` branch: match value → target step id. */
export interface ProgramRouteBranch {
  match: string;
  stepId: string;
}

/** Route on an explicit `${{ … }}` input to a later step. */
export interface ProgramRoute {
  input: string;
  branches: ProgramRouteBranch[];
  defaultStepId?: string;
}

/**
 * Completion gate criteria. TODO(R2): artifact-judging gates and `max_loops`
 * execution land with the engine rework; the parser carries them through.
 */
export interface ProgramGate {
  criteria: string[];
  maxLoops?: number;
}

/** One step of the gated spine. Exactly one of unit | map | route is set. */
export interface ProgramStep {
  id: string;
  title?: string;
  unit?: ProgramUnit;
  map?: ProgramMap;
  route?: ProgramRoute;
  /**
   * Step artifact schema (JSON Schema). TODO(R2): validation of the reducer
   * result against this schema is engine-rework scope; carried through now.
   */
  output?: Record<string, unknown>;
  gate?: ProgramGate;
  source: SourceRef;
}

/** Run-level defaults, overridable per unit. */
export interface ProgramDefaults {
  runner?: ProgramRunnerKind;
  model?: string;
  /** Parsed default timeout in ms; `null` = explicitly "none". */
  timeoutMs?: number | null;
  onError?: ProgramOnError;
}

export interface WorkflowProgram {
  version: typeof WORKFLOW_PROGRAM_VERSION;
  name: string;
  description?: string;
  /** Param name → JSON-Schema-ish declaration (validated as a schema in R1 compile). */
  params?: Record<string, Record<string, unknown>>;
  defaults?: ProgramDefaults;
  steps: ProgramStep[];
  source: { path: string };
}

export type WorkflowProgramParseResult =
  | { ok: true; program: WorkflowProgram }
  | { ok: false; errors: WorkflowError[] };
