// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Workflow Plan Graph — the backend-agnostic orchestration IR, version 2
 * (docs/technical/akm-workflows-orchestration-plan.md, Redesign addendum R1).
 *
 * Two frontends compile to this structure (`ir/compile.ts`):
 *
 *   - YAML workflow programs (`program/parser.ts` → `compileWorkflowProgram`)
 *     — the deterministic orchestration program format. Run-level `defaults`
 *     are MERGED into every unit node at compile time (frozen resolution), so
 *     a serialized plan is fully self-contained.
 *   - Classic linear markdown workflows (`parser.ts` → `compileWorkflowPlan`)
 *     — the stable CLI contract: one `agent` node per step, runner inherited.
 *
 * The plan is FROZEN per run: `workflow start` persists the canonical plan
 * JSON plus its hash (`computePlanHash`) on the run row (migration 006), and
 * every subsequent invocation executes that snapshot. The structure must
 * therefore round-trip through plain JSON — templates stay RAW STRINGS here
 * (`${{ … }}` expressions are re-parsed deterministically at execution by
 * `program/expressions.ts`), never pre-parsed ASTs.
 *
 * v2 removes the v1 `parallel`/`pipeline`/`router`/`subworkflow` node kinds:
 * no frontend or backend ever emitted or consumed them, and the YAML program
 * surface has no grammar for them. They can return in a later IR version if a
 * frontend grows a surface that needs them.
 *
 * The organizing principle is unchanged: **steps remain the durable, gated,
 * sequential spine; execution *within* a step fans out.** A
 * {@link WorkflowPlanGraph} is a list of {@link IrStepPlan}s — one per step —
 * each holding an execution subgraph (`root`) or a spine-level `route`, plus
 * the completion `gate` that guards advancement through
 * `completeWorkflowStep`.
 *
 * This module is pure data (no IO, no engine imports) — the DOMAIN layer of
 * the plan's layering diagram.
 */

import type { SourceRef } from "../schema";

export const WORKFLOW_IR_VERSION = 2;

/** Execution backend for a unit. `inherit` = the run-level default runner. */
export type IrRunnerKind = "llm" | "agent" | "sdk" | "inherit";

/** Filesystem isolation for parallel file-mutating units. TODO(R2): enforcement. */
export type IrIsolation = "none" | "worktree";

/** How a `map` node folds its per-item results into one step result. */
export type IrMapReducer = "collect" | "vote";

/** Failure policy for a unit: fail the step on first failure, or record and go on. */
export type IrOnError = "fail" | "continue";

/**
 * Bounded retry on transient failures, keyed on the persisted
 * `failure_reason` taxonomy (`AgentFailureReason` in agent/spawn.ts).
 * TODO(R2): enforcement lands with the engine rework.
 */
export interface IrRetry {
  max: number;
  on: string[];
}

/** Run one unit: instructions + runner + model + optional schema. */
export interface IrAgentNode {
  kind: "agent";
  id: string;
  /**
   * RAW instruction template. `${{ … }}` references are re-parsed
   * deterministically at execution time (program/expressions.ts) — the plan
   * must serialize as plain JSON, so no parsed AST lives here. Classic
   * markdown instructions carry no expressions and pass through verbatim.
   */
  instructions: string;
  runner: IrRunnerKind;
  /** Agent/LLM profile name overriding the run default. */
  profile?: string;
  /** Model alias (tier) or exact id; resolved per-harness at dispatch time. */
  model?: string;
  /** JSON Schema the unit's output must validate against. */
  schema?: Record<string, unknown>;
  /** Per-unit timeout in ms; null = explicitly no timeout; absent = engine default. */
  timeoutMs?: number | null;
  /** TODO(R2): retry dispatch is engine-rework scope; carried through the IR now. */
  retry?: IrRetry;
  /** Failure policy; compile merges the program default (fail-fast) in. */
  onError: IrOnError;
  /** Env asset refs resolved into the child env at dispatch. */
  env?: string[];
  /** TODO(R2): worktree isolation is engine-rework scope; carried through now. */
  isolation?: IrIsolation;
  source?: SourceRef;
}

/**
 * Fan one agent template out over an item list, with an optional reducer.
 * `over` is the RAW whole-value `${{ … }}` expression string naming the
 * producer of the list (a run param or an earlier step's output) — resolved
 * at execution, never at compile.
 */
export interface IrMapNode {
  kind: "map";
  id: string;
  /** Raw whole-value `${{ … }}` expression string addressing the item list. */
  over: string;
  template: IrAgentNode;
  /** Per-step concurrency; capped by the engine's global limit. */
  concurrency?: number;
  reducer: IrMapReducer;
  source?: SourceRef;
}

/** Every executable node kind (closed set for IR v2). */
export type IrExecNode = IrAgentNode | IrMapNode;

/**
 * Human-review / completion-criteria approval between steps — akm's
 * differentiator, never bypassed by any backend. `maxLoops > 1` expresses
 * the evaluator-optimizer pattern (feedback re-runs the step subgraph).
 * TODO(R2): maxLoops execution is engine-rework scope; carried through now.
 */
export interface IrGateNode {
  kind: "gate";
  id: string;
  stepId: string;
  criteria: string[];
  /** Evaluator-feedback loop bound; absent/1 = one-shot gate. */
  maxLoops?: number;
}

/**
 * Spine-level routing on an EXPLICIT input. The engine resolves `input` (a
 * raw whole-value `${{ … }}` expression string), selects `when[value]` (or
 * `defaultStepId`), and skips the unselected targets as the sequential spine
 * reaches them.
 */
export interface IrRouteSpec {
  /** Raw whole-value `${{ … }}` expression string naming the value to route on. */
  input: string;
  /** Match value → target step id. */
  when: Record<string, string>;
  defaultStepId?: string;
}

/**
 * One step of the gated spine. Exactly one of `root` (execution subgraph)
 * or `route` (spine-level routing) is present: YAML `route` steps dispatch
 * no units of their own.
 */
export interface IrStepPlan {
  stepId: string;
  title: string;
  sequenceIndex: number;
  /**
   * Reserved: non-linear ordering edges. No current frontend emits them (the
   * P1 markdown `### Depends On` grammar is removed by the R1 cutover; the
   * YAML program has no equivalent yet) but the engine still honors them.
   */
  dependsOn?: string[];
  /** Execution subgraph; absent exactly when this is a `route` step. */
  root?: IrExecNode;
  /** Spine-level routing evaluated when the spine reaches this step. */
  route?: IrRouteSpec;
  /**
   * Step artifact schema (JSON Schema) the reducer result must validate
   * against. TODO(R2): validation is engine-rework scope; carried through now.
   */
  outputSchema?: Record<string, unknown>;
  gate: IrGateNode;
}

/** Run-level budget ceilings. TODO(R2): enforcement is engine-rework scope. */
export interface IrBudget {
  maxTokens?: number;
  maxUnits?: number;
}

export interface WorkflowPlanGraph {
  irVersion: typeof WORKFLOW_IR_VERSION;
  title: string;
  /** Declared run parameter names, when the workflow declares any. */
  params?: string[];
  budget?: IrBudget;
  steps: IrStepPlan[];
}
