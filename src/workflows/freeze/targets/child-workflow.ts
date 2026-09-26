// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The one child-workflow resolver. Both composition forms lower here: a direct
 * `uses: workflows/<ref>` step (`via: "direct"`) and a `uses: tasks/<ref>`
 * step whose task targets a workflow (`via: "task"`). It resolves the child,
 * refuses a composition cycle, freezes the child completely through the
 * injected `ResolutionContext.freezeChild`, binds the step's inputs against
 * the child's `params:`, and embeds the frozen child plan in the target.
 */

import { createHash } from "node:crypto";
import { parseBundleRef } from "../../../core/asset/asset-ref";
import { UsageError } from "../../../core/errors";
import { warn } from "../../../core/warn";
import type { TaskInputBinding } from "../../../execution/input-contract";
import { workflowParamContract } from "../../ir/params";
import { canonicalJson, canonicalPlanJson } from "../../ir/plan-hash";
import type { FrozenChildWorkflowTarget, WorkflowPlan } from "../../plan";
import { loadWorkflowAsset } from "../../runtime/workflow-asset-loader";
import { resolveOwnedAsset } from "../environment";
import {
  type BaseUnit,
  declaredParamNames,
  earlierStepIds,
  type FreezeStep,
  type ResolutionContext,
  type ResolvedDispatch,
} from "../step-values";
import { freezeTaskInputBindings, rebindTaskInputBindings } from "../task-bindings";

/**
 * What is bound against the child's `params:`: a direct step's authored `with:`
 * (normalized), or a composing task's already-classified effective inputs
 * (re-bound, never round-tripped through the `with:` grammar).
 */
export type AuthoredChildInputs =
  | Readonly<{ kind: "with"; value: Readonly<Record<string, unknown>> | undefined }>
  | Readonly<{ kind: "bindings"; value: readonly TaskInputBinding[] }>;

export interface ChildWorkflowDispatchInput {
  readonly source: FreezeStep;
  readonly baseUnit: BaseUnit;
  /** The child ref as the composing site names it; resolved and canonicalized here. */
  readonly childRefInput: string;
  readonly context: ResolutionContext;
  readonly via: "direct" | "task";
  /** Present only when via === "task": the composing task's OWN qualified ref. */
  readonly taskRef?: string;
  /** See {@link AuthoredChildInputs}. */
  readonly authoredInputs: AuthoredChildInputs;
}

/** The child target's own content identity: its ref, embedded plan hash, route, and bindings. */
function childWorkflowContentHash(fields: {
  readonly ref: string;
  readonly planHash: string;
  readonly via: "direct" | "task";
  readonly taskRef: string | undefined;
  readonly inputBindings: readonly TaskInputBinding[];
}): string {
  return createHash("sha256")
    .update("akm.workflow.child-workflow\0v1\0")
    .update(
      canonicalJson({
        ref: fields.ref,
        planHash: fields.planHash,
        via: fields.via,
        taskRef: fields.taskRef ?? null,
        inputBindings: fields.inputBindings.length > 0 ? fields.inputBindings : null,
      }),
    )
    .digest("hex");
}

/** A composing step's own `env:` (literal or `unit.env`) cannot reach the child run, so say so. */
function warnIfStepEnvironment(stepId: string, childRef: string, source: FreezeStep): void {
  const hasLiteralEnv = Object.keys(source.env ?? {}).length > 0;
  const hasEnvRefs = (source.unit?.env ?? []).length > 0;
  if (!hasLiteralEnv && !hasEnvRefs) return;
  warn(
    `Workflow step ${stepId} declares env: while composing ${childRef}: a child run carries its own frozen ` +
      `environment inside its own plan, so this composing step's env: (or unit: env:) is not delivered into it ` +
      `and has no effect. Set those variables inside ${childRef}'s own source instead.`,
  );
}

/** A workflow entry of a composition `refPath` — the only entries a cycle can close through. */
function isWorkflowRef(ref: string): boolean {
  try {
    return parseBundleRef(ref).conceptId.startsWith("workflows/");
  } catch {
    return false;
  }
}

function compositionPath(refPath: readonly string[], childRef: string): string {
  return [...refPath, childRef].join(" -> ");
}

function assertNoCompositionCycle(stepId: string, childRef: string, refPath: readonly string[]): void {
  if (!refPath.filter(isWorkflowRef).includes(childRef)) return;
  throw new UsageError(
    `Workflow step ${stepId} cannot compose ${childRef}: that would create a composition cycle. ` +
      `Path: ${compositionPath(refPath, childRef)}.`,
    "COMPOSITION_INVALID",
    "Break the cycle: remove or redirect one of the compositions in the path above so no workflow ends up " +
      "composing itself, directly or through intermediates.",
  );
}

export async function childWorkflowDispatch(input: ChildWorkflowDispatchInput): Promise<ResolvedDispatch> {
  const { source, baseUnit, childRefInput, context, via, taskRef, authoredInputs } = input;

  // resolve + qualify. Resolution failures propagate unchanged,
  // in code and shape — the same authority every other
  // composition target (command/script/task) already resolves through.
  const owned = await resolveOwnedAsset(childRefInput, "workflow", context);
  const childAsset = await loadWorkflowAsset(owned.ref);
  const childRef = childAsset.ref;

  // Issue 10: an authored env: on the composing step has no path to reach
  // the child run — warn rather than vanish silently (see
  // warnIfStepEnvironment's doc comment).
  warnIfStepEnvironment(source.id, childRef, source);

  // the composition cycle check, before any child compilation.
  assertNoCompositionCycle(source.id, childRef, context.refPath);

  // Freeze the child completely; its plan is a pure function of its own source.
  const childRefPath =
    via === "task" && taskRef !== undefined ? [...context.refPath, taskRef, childRef] : [...context.refPath, childRef];
  const child = await context.freezeChild(childAsset, childRefPath);

  // Embed the child plan as plain canonical JSON, exactly as `plan_json` stores it.
  const embeddedPlanJson = canonicalPlanJson(child.plan);
  const frozenPlan = JSON.parse(embeddedPlanJson) as WorkflowPlan;

  // Bind the step's effective inputs against the child's declared params.
  const inputBindings =
    authoredInputs.kind === "bindings"
      ? rebindTaskInputBindings({
          stepId: source.id,
          targetRef: childRef,
          bindings: authoredInputs.value,
          contract: workflowParamContract(frozenPlan),
        })
      : freezeTaskInputBindings({
          stepId: source.id,
          targetRef: childRef,
          with: authoredInputs.value,
          contract: workflowParamContract(frozenPlan),
          earlierStepIds: earlierStepIds(context.plan, source.id),
          declaredParamNames: declaredParamNames(context.plan),
        });

  // build the frozen target.
  const planHash = createHash("sha256").update(embeddedPlanJson).digest("hex");
  const contentHash = childWorkflowContentHash({ ref: childRef, planHash, via, taskRef, inputBindings });
  const target: FrozenChildWorkflowTarget = Object.freeze({
    kind: "child-workflow",
    ref: childRef,
    planHash,
    frozenPlan,
    contentHash,
    via,
    ...(taskRef !== undefined ? { taskRef } : {}),
    ...(inputBindings.length > 0 ? { inputBindings } : {}),
  });

  return {
    target,
    // A child run carries its own frozen environment inside its own plan.
    // A composing step's own env: cannot reach it, so assertNoStepEnvironment
    // above rejects one instead of it silently vanishing here.
    environment: [],
    unit: baseUnit,
    instructions:
      source.instructions ??
      (via === "task" && taskRef !== undefined ? `Run task ${taskRef}.` : `Run workflow ${childRef}.`),
  };
}
