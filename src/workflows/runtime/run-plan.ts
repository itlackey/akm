// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tolerant reads of a run row's frozen plan.
 *
 * `plan_json` is decoded as it is stored. `plan_ir_version` and `plan_hash`
 * are informational columns: neither gates execution (a plan frozen by an
 * older or newer akm that still decodes simply runs, with one warning). A plan
 * that genuinely cannot be decoded comes back as a `problem` sentence; the
 * caller decides the remedy (the engine abandons such a run instead of
 * throwing) — except for a plan a NEWER akm froze, which is `newer` and whose
 * problem names upgrading akm as the remedy.
 */

import { warnOnce } from "../../core/warn";
import type { WorkflowRunRow } from "../../storage/repositories/workflow-runs-repository";
import type { IrRouteSpec } from "../ir/schema";
import { decodeWorkflowPlanV4, WORKFLOW_IR_V5_VERSION, type WorkflowPlanGraphV4 } from "../ir/schema-v4";

export type RunPlanRead = { ok: true; plan: WorkflowPlanGraphV4 } | { ok: false; problem: string; newer: boolean };

export function readRunPlan(row: Pick<WorkflowRunRow, "id" | "plan_json" | "plan_ir_version">): RunPlanRead {
  if (!row.plan_json)
    return { ok: false, newer: false, problem: `Workflow run ${row.id} has no frozen workflow plan.` };
  const version = row.plan_ir_version ?? null;
  try {
    const plan = decodeWorkflowPlanV4(JSON.parse(row.plan_json));
    if (version !== null && version !== WORKFLOW_IR_V5_VERSION) {
      warnOnce(
        `workflow-plan-version:${row.id}`,
        `Workflow run ${row.id} was frozen as plan irVersion ${version}; running it with the current engine ` +
          `(irVersion ${WORKFLOW_IR_V5_VERSION}).`,
      );
    }
    return { ok: true, plan };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    if (version !== null && version > WORKFLOW_IR_V5_VERSION) {
      return {
        ok: false,
        newer: true,
        problem:
          `Workflow run ${row.id} was frozen by a newer akm (plan irVersion ${version}) and this akm cannot decode it: ` +
          `${detail}. Upgrade akm to continue this run.`,
      };
    }
    const frozenAs = version === null ? "" : ` (frozen as plan irVersion ${version})`;
    return {
      ok: false,
      newer: false,
      problem: `Workflow run ${row.id} has a frozen plan this akm cannot decode${frozenAs}: ${detail}.`,
    };
  }
}

export interface FrozenStepRowDefinition {
  stepId: string;
  stepTitle: string;
  instructions: string;
  completionJson: string | null;
  sequenceIndex: number;
}

/** Project persisted spine rows from the plan at publication time. */
export function frozenStepRows(plan: WorkflowPlanGraphV4): FrozenStepRowDefinition[] {
  return plan.steps.map((step) => ({
    stepId: step.stepId,
    stepTitle: step.title,
    instructions: step.root
      ? step.root.kind === "map"
        ? step.root.template.instructions
        : step.root.instructions
      : routeInstructions(step.route as NonNullable<typeof step.route>),
    completionJson: step.gate.criteria.length > 0 ? JSON.stringify(step.gate.criteria) : null,
    sequenceIndex: step.sequenceIndex,
  }));
}

function routeInstructions(route: IrRouteSpec): string {
  const branches = Object.entries(route.when)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([match, stepId]) => `"${match}" -> ${stepId}`);
  if (route.defaultStepId !== undefined) branches.push(`default -> ${route.defaultStepId}`);
  return `Route on ${route.input}: ${branches.join(", ")}.`;
}
