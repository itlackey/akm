/**
 * The one child-workflow resolver (`unit: { workflow: <ref> }`, Experimental).
 * It resolves the child, refuses a composition cycle, freezes the child
 * completely through the injected `ResolutionContext.freezeChild`, binds the
 * step's `with:` against the child's `params:`, and embeds the frozen child
 * plan in the target.
 */

import { createHash } from "node:crypto";
import { parseBundleRef } from "../../../core/asset/asset-ref";
import { UsageError } from "../../../core/errors";
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
import { freezeTaskInputBindings } from "../task-bindings";

export interface ChildWorkflowDispatchInput {
  readonly source: FreezeStep;
  readonly baseUnit: BaseUnit;
  /** The child ref as the composing site names it; resolved and canonicalized here. */
  readonly childRefInput: string;
  readonly context: ResolutionContext;
}

/** The child target's own content identity: its ref, embedded plan hash, and bindings. */
function childWorkflowContentHash(fields: {
  readonly ref: string;
  readonly planHash: string;
  readonly inputBindings: readonly TaskInputBinding[];
}): string {
  return createHash("sha256")
    .update("akm.workflow.child-workflow\0v2\0")
    .update(
      canonicalJson({
        ref: fields.ref,
        planHash: fields.planHash,
        inputBindings: fields.inputBindings.length > 0 ? fields.inputBindings : null,
      }),
    )
    .digest("hex");
}

/** A workflow entry of a composition `refPath`. */
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
  const { source, baseUnit, childRefInput, context } = input;

  // Resolution failures propagate unchanged, in code and shape — the same
  // authority every other asset reference resolves through.
  const owned = await resolveOwnedAsset(childRefInput, "workflow", context);
  const childAsset = await loadWorkflowAsset(owned.ref);
  const childRef = childAsset.ref;

  // The composition cycle check, before any child compilation.
  assertNoCompositionCycle(source.id, childRef, context.refPath);

  // Freeze the child completely; its plan is a pure function of its own source.
  const child = await context.freezeChild(childAsset, [...context.refPath, childRef]);

  // Embed the child plan as plain canonical JSON, exactly as `plan_json` stores it.
  const embeddedPlanJson = canonicalPlanJson(child.plan);
  const frozenPlan = JSON.parse(embeddedPlanJson) as WorkflowPlan;

  // Bind the step's `with:` against the child's declared params.
  const inputBindings = freezeTaskInputBindings({
    stepId: source.id,
    targetRef: childRef,
    with: source.with,
    contract: workflowParamContract(frozenPlan),
    earlierStepIds: earlierStepIds(context.plan, source.id),
    declaredParamNames: declaredParamNames(context.plan),
  });

  const planHash = createHash("sha256").update(embeddedPlanJson).digest("hex");
  const target: FrozenChildWorkflowTarget = Object.freeze({
    kind: "child-workflow",
    ref: childRef,
    planHash,
    frozenPlan,
    contentHash: childWorkflowContentHash({ ref: childRef, planHash, inputBindings }),
    ...(inputBindings.length > 0 ? { inputBindings } : {}),
  });

  return {
    target,
    // A child run carries its own frozen environment inside its own plan; the
    // parser rejects an `env` beside `workflow`, so there is nothing to deliver.
    environment: [],
    unit: baseUnit,
    instructions: source.instructions ?? `Run workflow ${childRef}.`,
  };
}
