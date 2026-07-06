// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Workflow Plan Graph — the backend-agnostic orchestration IR
 * (docs/technical/akm-workflows-orchestration-plan.md, P0).
 *
 * The Markdown frontend compiles to this structure (`ir/compile.ts`); every
 * execution backend (native executor today; Claude Code delegation and cloud
 * delegate later) consumes it. The node vocabulary is the closed set of
 * orchestration patterns from the published literature (prompt chaining →
 * `pipeline`, routing → `router`, sectioning → `parallel`, voting → `map` +
 * reducer, orchestrator-workers → `map`/`subworkflow`, evaluator-optimizer →
 * looping `gate`), NOT "whatever one harness happens to expose".
 *
 * The organizing principle: **steps remain the durable, gated, sequential
 * spine; execution *within* a step fans out.** A {@link WorkflowPlanGraph} is
 * therefore a list of {@link IrStepPlan}s — one per step — each holding the
 * execution subgraph (`root`) plus the completion `gate` that guards
 * advancement through `completeWorkflowStep`.
 *
 * This module is pure data (no IO, no engine imports) — the DOMAIN layer of
 * the plan's layering diagram.
 */

import type { SourceRef } from "../schema";

export const WORKFLOW_IR_VERSION = 1;

/** Execution backend for a unit. `inherit` = the run-level default runner. */
export type IrRunnerKind = "llm" | "agent" | "sdk" | "inherit";

/** Filesystem isolation for parallel file-mutating units (P4). */
export type IrIsolation = "none" | "worktree";

/** How a `map` node folds its per-item results into one step result. */
export type IrMapReducer = "collect" | "vote" | "best-of-n";

/** Run one unit: instructions + runner + model + optional schema. */
export interface IrAgentNode {
  kind: "agent";
  id: string;
  /** Instruction template; `{{item}}` / `{{params.<name>}}` interpolate at dispatch. */
  instructions: string;
  runner: IrRunnerKind;
  /** Agent/LLM profile name overriding the run default. */
  profile?: string;
  /** Model alias (tier) or exact id; resolved per-harness at dispatch time. */
  model?: string;
  /** Reasoning-effort hint for harnesses that accept one. */
  effort?: string;
  /** JSON Schema the unit's output must validate against. */
  schema?: Record<string, unknown>;
  /** Per-unit timeout in ms; null = explicitly no timeout; absent = engine default. */
  timeoutMs?: number | null;
  /** Env asset refs resolved into the child env at dispatch. */
  env?: string[];
  isolation?: IrIsolation;
  source?: SourceRef;
}

/**
 * Fan one agent template out over an item list (a run param or a prior
 * step's evidence key), with an optional reducer. Expresses both static
 * sectioning and orchestrator-workers (when the list is produced at runtime
 * by an earlier step).
 */
export interface IrMapNode {
  kind: "map";
  id: string;
  /** Name of the run param or prior-step evidence key holding the item list. */
  over: string;
  template: IrAgentNode;
  /** Per-step concurrency; capped by the engine's global limit. */
  concurrency?: number;
  reducer: IrMapReducer;
  source?: SourceRef;
}

/** Run children concurrently with a barrier (parallelization / sectioning). */
export interface IrParallelNode {
  kind: "parallel";
  id: string;
  children: IrExecNode[];
  source?: SourceRef;
}

/** Run items through child stages with no barrier between stages (chaining). */
export interface IrPipelineNode {
  kind: "pipeline";
  id: string;
  stages: IrExecNode[];
  source?: SourceRef;
}

/** Classify an input and dispatch to one of N branches (routing). */
export interface IrRouterNode {
  kind: "router";
  id: string;
  /** Param or evidence key holding the value to classify. */
  input: string;
  branches: Array<{ match: string; node: IrExecNode }>;
  source?: SourceRef;
}

/** Inline another workflow (one level); may delegate to a peer agent/harness. */
export interface IrSubworkflowNode {
  kind: "subworkflow";
  id: string;
  /** Workflow ref (workflow:<name>). */
  ref: string;
  source?: SourceRef;
}

/**
 * Every executable node kind. The Markdown frontend currently emits
 * `agent` and `map`; `parallel`/`pipeline`/`router`/`subworkflow` complete
 * the research-grounded vocabulary for the imperative frontend and the
 * Claude Code emitter (P3+) so backends can be written against the full set.
 */
export type IrExecNode = IrAgentNode | IrMapNode | IrParallelNode | IrPipelineNode | IrRouterNode | IrSubworkflowNode;

/**
 * Human-review / completion-criteria approval between steps — akm's
 * differentiator, never bypassed by any backend. `maxLoops > 1` expresses
 * the evaluator-optimizer pattern (feedback re-runs the step subgraph).
 */
export interface IrGateNode {
  kind: "gate";
  id: string;
  stepId: string;
  criteria: string[];
  /** Evaluator-feedback loop bound; absent/1 = one-shot gate. */
  maxLoops?: number;
}

/** One `when` branch of a spine-level route. */
export interface IrRouteBranch {
  match: string;
  stepId: string;
}

/**
 * Spine-level routing (the *routing* pattern for the Markdown frontend).
 * Because gates live BETWEEN steps, the declarative frontend expresses
 * routing as a property of the step plan — evaluate the `input` value after
 * the step's subgraph completes, select one target step, and skip the other
 * targets as the sequential spine reaches them. {@link IrRouterNode} remains
 * the node-level form for the future imperative frontend.
 */
export interface IrRouteSpec {
  input: string;
  branches: IrRouteBranch[];
  defaultStepId?: string;
}

/** One step of the gated spine: an execution subgraph guarded by its gate. */
export interface IrStepPlan {
  stepId: string;
  title: string;
  sequenceIndex: number;
  /** Non-linear ordering edges (validated step ids). */
  dependsOn?: string[];
  root: IrExecNode;
  gate: IrGateNode;
  /** Branch routing evaluated after this step completes. */
  route?: IrRouteSpec;
}

/** Run-level budget ceilings (enforced by the scheduler as they land). */
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
  /** Resume mode: durable-row (default) or deterministic replay (P5). */
  resume?: "durable" | "replay";
  steps: IrStepPlan[];
}
