// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Freeze-time check of references into a child-workflow step's output: the
 * first path segment after `steps.<child>.output` must name one of the child's
 * declared `outputs:` (or `runId`/`status` when it declares none). Deeper
 * segments resolve at run time.
 */

import { UsageError } from "../../core/errors";
import type { TaskInputBinding } from "../../execution/input-contract";
import type { FrozenWorkflowTarget, WorkflowPlanStep, WorkflowUnitNode } from "../plan";
import { formatReference, parseReference } from "../program/expressions";

/** A single reference-bearing string, tagged with the step that authored it. */
interface ReferenceSite {
  readonly stepId: string;
  readonly reference: string;
}

/** The frozen target a step's root unit (or map template) dispatches, if any. */
function stepFrozenTarget(step: WorkflowPlanStep | undefined): FrozenWorkflowTarget | undefined {
  const root = step?.root;
  if (!root) return undefined;
  const unit: WorkflowUnitNode = root.kind === "map" ? root.template : root;
  return unit.frozenTarget;
}

/** Every reference string a step's `inputs[]`, `map.over`, `route.input`, and reference-kind `inputBindings[].from` carry. */
function collectReferenceSites(step: WorkflowPlanStep): ReferenceSite[] {
  const sites: ReferenceSite[] = [];
  const push = (reference: string): void => {
    sites.push({ stepId: step.stepId, reference });
  };
  if (step.route) push(step.route.input);
  const root = step.root;
  if (root) {
    const unit: WorkflowUnitNode = root.kind === "map" ? root.template : root;
    if (root.kind === "map") push(root.over);
    for (const reference of unit.inputs ?? []) push(reference);
    const bindings = (unit.frozenTarget as { inputBindings?: readonly TaskInputBinding[] }).inputBindings ?? [];
    for (const binding of bindings) {
      if (binding.kind === "reference") push(binding.from);
    }
  }
  return sites;
}

/** The names a `child-workflow` target's own exported result carries at its first segment. */
function acceptedFirstSegments(target: Extract<FrozenWorkflowTarget, { kind: "child-workflow" }>): readonly string[] {
  const declared = target.frozenPlan.outputs;
  return declared ? Object.keys(declared) : ["runId", "status"];
}

function exportsDescription(target: Extract<FrozenWorkflowTarget, { kind: "child-workflow" }>): string {
  const declared = target.frozenPlan.outputs;
  return declared ? `outputs: ${Object.keys(declared).join(", ")}` : "only {runId, status} — it declares no `outputs:`";
}

function checkSite(site: ReferenceSite, stepsById: ReadonlyMap<string, WorkflowPlanStep>): void {
  const parsed = parseReference(site.reference);
  if (!parsed.ok || parsed.expr.kind !== "stepOutput") return;
  const targetStep = stepsById.get(parsed.expr.stepId);
  const frozenTarget = stepFrozenTarget(targetStep);
  if (!frozenTarget || frozenTarget.kind !== "child-workflow") return;
  const first = parsed.expr.path[0];
  if (first === undefined) return; // bare steps.<child>.output — the whole exported object, always accepted.
  const accepted = acceptedFirstSegments(frozenTarget);
  if (typeof first === "string" && accepted.includes(first)) return;
  throw new UsageError(
    `Workflow step ${site.stepId} reads "${formatReference(parsed.expr)}", but child workflow ${frozenTarget.ref} ` +
      `exports ${exportsDescription(frozenTarget)}. Declare the output in the child's \`outputs:\` frontmatter, or ` +
      `reference one of the names above.`,
    "COMPOSITION_INVALID",
    `Fix the reference to name one of: ${accepted.join(", ")} — or add the missing name to ${frozenTarget.ref}'s ` +
      "own `outputs:` frontmatter.",
  );
}

/**
 * Assert every reference into a `child-workflow`-targeted step's output
 * names an output the child actually exports. Throws `UsageError`
 * (`COMPOSITION_INVALID`) on the first violation found.
 */
export function assertChildOutputReferences(steps: readonly WorkflowPlanStep[]): void {
  const stepsById = new Map(steps.map((step) => [step.stepId, step] as const));
  for (const step of steps) {
    for (const site of collectReferenceSites(step)) {
      checkSite(site, stepsById);
    }
  }
}
