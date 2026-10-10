// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The ONE workflow plan type.
 *
 * The Markdown grammar (`parser.ts`) compiles straight to a
 * {@link WorkflowPlan}. A compiled
 * plan carries what the author wrote — each step's {@link WorkflowStepSpec},
 * the document `defaults`, display prose — and no execution
 * decisions. Freeze (`freeze/freeze.ts`) resolves every spec into a frozen
 * `root` (engine, model, concurrency, dispatch target), fills gate judges,
 * drops the compile-only fields, and records the source file's sha256. The
 * frozen plan is what `workflow_runs.plan_json` stores.
 *
 * `decodeWorkflowPlan` (`runtime/run-plan.ts`) is the one decoder that reads
 * a stored plan back into this type, from this release or an earlier one.
 */

import type { FrozenDirectoryIdentity } from "../execution/directory-identity";
import type { TaskInputBinding } from "../execution/input-contract";
import type { ResolvedExecutionRequestV1 } from "../execution/resolved-request";
import type { LlmInvocationOverrides } from "../integrations/agent/engine-resolution";
import type { RunnerSpec } from "../integrations/agent/runner";

/** Stored plans record this; 0.9.15 and 0.9.16 wrote 5, which still decodes (the 0.9.15 floor, #1091). */
export const WORKFLOW_PLAN_VERSION = 6 as const;

/** A 1-indexed inclusive line span in a workflow source file. */
export interface SourceRef {
  path: string;
  start: number;
  end: number;
}

/** One authoring problem, formatted by callers as `path:line — message`. */
export interface WorkflowError {
  /** Optional stable code supplied by a format's semantic boundary. */
  code?: string;
  line: number;
  message: string;
}

export type WorkflowOnError = "fail" | "continue";
export type WorkflowReducer = "collect" | "vote";
export type WorkflowRuntimeKind = "llm" | "agent" | "sdk" | "exec";

export interface WorkflowRetry {
  max: number;
  on: string[];
}

export interface WorkflowBudget {
  maxTokens?: number;
  maxUnits?: number;
}

/** Authored engine/timeout settings shared by a step's unit and the document `defaults`. */
export interface WorkflowUnitSettings {
  engine?: string;
  model?: string;
  llm?: LlmInvocationOverrides;
  /** `null` = explicitly no timeout; absent = inherit. */
  timeoutMs?: number | null;
  onError?: WorkflowOnError;
  retry?: WorkflowRetry;
  /** JSON Schema the unit's structured result must satisfy. */
  output?: Record<string, unknown>;
  /** Env asset refs whose values reach the unit's child environment. */
  env?: string[];
}

/** An authored argv; never shell-parsed. */
export interface WorkflowExec {
  command: string[];
  cwd?: string;
  passEnv?: string[];
}

/**
 * What the author wrote for one step, as compiled. Exactly one of `exec` and
 * `uses` on a unit/map step (a Markdown prose step is `uses: akm/command`
 * with its body as literal content). Compile-only:
 * freeze consumes it and a stored plan never carries it.
 */
export interface WorkflowStepSpec {
  uses?: string;
  /** Child workflow ref (Experimental): the step starts and drives that workflow as a child run, with `with:` as its params. */
  workflow?: string;
  with?: Record<string, unknown>;
  exec?: WorkflowExec;
  unit?: WorkflowUnitSettings;
  map?: { over: string; concurrency?: number; reducer?: WorkflowReducer };
  inputs?: string[];
  /** Authored prose: the Markdown section of an exec step. */
  instructions?: string;
  source: SourceRef;
}

/** A frozen argv with its resolved wall-clock budget (`null` = none). */
export interface WorkflowExecSpec {
  command: [string, ...string[]];
  cwd?: string;
  passEnv?: string[];
  timeoutMs: number | null;
}

export type FrozenWorkflowDirectoryIdentity = FrozenDirectoryIdentity;

/** Where a frozen env ref is read from at dispatch. Older plans carry extra physical-identity fields. */
export interface FrozenWorkflowEnvironmentOwner {
  readonly bundle: string;
  readonly adapter: string;
  readonly requestedRoot: string;
  readonly requestedPath: string;
  readonly relativePath: string;
  readonly realRoot?: string;
  readonly realPath?: string;
  readonly rootPhysicalIdentity?: string;
}

export type FrozenWorkflowEnvironmentBinding =
  | { readonly kind: "literal"; readonly name: string; readonly value: string }
  | { readonly kind: "pass-through"; readonly name: string }
  | {
      readonly kind: "env-ref";
      readonly ref: string;
      readonly owner: FrozenWorkflowEnvironmentOwner;
      readonly keys: readonly string[];
      readonly secretNames: readonly string[];
      readonly precedence: number;
    };

export interface FrozenWorkflowCommandTarget {
  readonly kind: "command";
  readonly ref: string | null;
  readonly contentHash: string;
  readonly request: ResolvedExecutionRequestV1;
  readonly runner: RunnerSpec;
  /** Frozen provider concurrency cap for this resolved target, when applicable. */
  readonly concurrency?: number;
  readonly cwdIdentity?: FrozenWorkflowDirectoryIdentity;
  /** A composing step's frozen `with:` bindings. Absent, never `[]`, when empty. */
  readonly inputBindings?: readonly TaskInputBinding[];
}

export interface FrozenWorkflowShellTarget {
  readonly kind: "shell";
  readonly contentHash: string;
  readonly exec: WorkflowExecSpec;
  readonly cwdIdentity: FrozenWorkflowDirectoryIdentity;
  readonly inputBindings?: readonly TaskInputBinding[];
}

/** A composed child workflow, frozen with its complete plan embedded. */
export interface FrozenChildWorkflowTarget {
  readonly kind: "child-workflow";
  readonly ref: string;
  /** sha256 of the canonical JSON of `frozenPlan`. */
  readonly planHash: string;
  readonly frozenPlan: WorkflowPlan;
  readonly contentHash: string;
  /** Written by releases before 0.10 (`"direct" | "task"`); never written now, kept so a stored plan decodes unchanged. */
  readonly via?: "direct" | "task";
  readonly taskRef?: string;
  readonly inputBindings?: readonly TaskInputBinding[];
}

export type FrozenWorkflowTarget = FrozenWorkflowCommandTarget | FrozenWorkflowShellTarget | FrozenChildWorkflowTarget;

export interface WorkflowUnitNode {
  readonly kind: "unit";
  readonly id: string;
  readonly instructions: string;
  /** Prior-step artifacts attached to this unit as structured context (reference strings). */
  readonly inputs?: string[];
  readonly schema?: Record<string, unknown>;
  readonly retry?: WorkflowRetry;
  readonly onError: WorkflowOnError;
  readonly env?: string[];
  readonly source?: SourceRef;
  readonly frozenTarget: FrozenWorkflowTarget;
  readonly environment: readonly FrozenWorkflowEnvironmentBinding[];
}

export interface WorkflowMapNode {
  readonly kind: "map";
  readonly id: string;
  readonly over: string;
  readonly template: WorkflowUnitNode;
  readonly concurrency: number;
  readonly reducer: WorkflowReducer;
  readonly source?: SourceRef;
}

export type WorkflowExecNode = WorkflowUnitNode | WorkflowMapNode;

export interface WorkflowGateNode {
  readonly kind: "gate";
  readonly id: string;
  readonly stepId: string;
  /** The `### gate` rubric, whole, as the one criterion; `[]` = no verification. */
  readonly criteria: string[];
  readonly maxLoops: number;
  /** Filled at freeze; `null` when there are no criteria or no judge engine. */
  readonly frozenJudge: FrozenWorkflowCommandTarget | null;
}

export interface WorkflowPlanStep {
  readonly stepId: string;
  /** Always the step id — a step has no separate title. */
  readonly title: string;
  readonly sequenceIndex: number;
  /** Compile-only: the authored step. */
  readonly spec?: WorkflowStepSpec;
  /** Frozen dispatch subgraph; absent on a not-yet-frozen plan. */
  readonly root?: WorkflowExecNode;
  /** JSON Schema the promoted step artifact must satisfy. */
  readonly outputSchema?: Record<string, unknown>;
  readonly gate: WorkflowGateNode;
}

export interface WorkflowPlan {
  readonly irVersion: number;
  readonly title: string;
  readonly params?: string[];
  readonly paramSchemas?: Record<string, Record<string, unknown>>;
  readonly budget?: WorkflowBudget;
  /** Filled at freeze. */
  readonly execution?: { readonly maxConcurrency: number };
  /** sha256 of the workflow source file, recorded at freeze for the resume "source changed" warning. */
  readonly sourceHash?: string;
  readonly steps: WorkflowPlanStep[];
  // ── compile-only (never stored) ──
  readonly defaults?: Omit<WorkflowUnitSettings, "retry" | "output" | "env">;
  readonly description?: string;
  /** Markdown prose before the first step section. */
  readonly preamble?: string;
}
