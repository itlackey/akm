// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { UsageError } from "../../core/errors";
import type { WorkflowRunRow, WorkflowRunStepRow } from "../../storage/repositories/workflow-runs-repository";
import { decodeCanonicalPlan } from "../ir/plan-hash";
import { WORKFLOW_IR_VERSION, type WorkflowPlanGraph } from "../ir/schema";

export type WorkflowExecutionSupport = "supported" | "unsupported-version" | "missing-plan" | "corrupt-plan";

export type ClassifiedWorkflowPlan =
  | { support: "supported"; plan: WorkflowPlanGraph; irVersion: 3 }
  | { support: Exclude<WorkflowExecutionSupport, "supported">; irVersion: number | null; error: string };

/** One policy authority for executable versus inspection-only historical runs. */
export function classifyWorkflowRunPlan(row: {
  plan_json: string | null;
  plan_hash: string | null;
  plan_ir_version?: number | null;
  id?: string;
}): ClassifiedWorkflowPlan {
  const runId = row.id ?? "(unknown)";
  if (!row.plan_json) {
    if (row.plan_ir_version === WORKFLOW_IR_VERSION) {
      return {
        support: "corrupt-plan",
        irVersion: row.plan_ir_version,
        error: `Workflow run ${runId} declares workflow IR version ${row.plan_ir_version} but has no frozen plan.`,
      };
    }
    return {
      support:
        row.plan_ir_version === null || row.plan_ir_version === undefined ? "missing-plan" : "unsupported-version",
      irVersion: row.plan_ir_version ?? null,
      error:
        row.plan_ir_version === null || row.plan_ir_version === undefined
          ? `Workflow run ${runId} has no executable workflow IR plan.`
          : `Workflow run ${runId} uses unsupported workflow IR version ${String(row.plan_ir_version)} and has no frozen plan.`,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(row.plan_json);
  } catch {
    if (row.plan_ir_version !== WORKFLOW_IR_VERSION) {
      return {
        support:
          row.plan_ir_version === null || row.plan_ir_version === undefined ? "missing-plan" : "unsupported-version",
        irVersion: row.plan_ir_version ?? null,
        error: `Workflow run ${runId} has malformed historical frozen plan JSON that cannot be executed.`,
      };
    }
    return {
      support: "corrupt-plan",
      irVersion: row.plan_ir_version ?? null,
      error: `Workflow run ${runId} has corrupt frozen plan JSON.`,
    };
  }
  const decodedVersion = typeof raw === "object" && raw !== null ? (raw as { irVersion?: unknown }).irVersion : null;
  if (!Number.isSafeInteger(decodedVersion) || (decodedVersion as number) < 1) {
    if (row.plan_ir_version !== WORKFLOW_IR_VERSION) {
      return {
        support:
          row.plan_ir_version === null || row.plan_ir_version === undefined ? "missing-plan" : "unsupported-version",
        irVersion: row.plan_ir_version ?? null,
        error: `Workflow run ${runId} has historical frozen plan data with no supported IR version.`,
      };
    }
    return {
      support: "corrupt-plan",
      irVersion: row.plan_ir_version ?? null,
      error: `Workflow run ${runId} has a missing or invalid frozen plan IR version.`,
    };
  }
  if (row.plan_ir_version !== null && row.plan_ir_version !== undefined && row.plan_ir_version !== decodedVersion) {
    if (row.plan_ir_version !== WORKFLOW_IR_VERSION && decodedVersion !== WORKFLOW_IR_VERSION) {
      return {
        support: "unsupported-version",
        irVersion: decodedVersion as number,
        error: `Workflow run ${runId} uses unsupported workflow IR version ${String(decodedVersion)} with mismatched historical metadata.`,
      };
    }
    return {
      support: "corrupt-plan",
      irVersion: decodedVersion as number,
      error: `Workflow run ${runId} has mismatched stored plan IR version (${String(row.plan_ir_version)} != ${String(decodedVersion)}).`,
    };
  }
  if (decodedVersion !== WORKFLOW_IR_VERSION) {
    return {
      support: "unsupported-version",
      irVersion: decodedVersion as number,
      error: `Workflow run ${runId} uses unsupported workflow IR version ${String(decodedVersion)}.`,
    };
  }
  if (row.plan_ir_version !== WORKFLOW_IR_VERSION) {
    return {
      support: "corrupt-plan",
      irVersion: row.plan_ir_version ?? null,
      error: `Workflow run ${runId} has no stored plan IR version.`,
    };
  }
  try {
    return {
      support: "supported",
      irVersion: WORKFLOW_IR_VERSION,
      plan: decodeCanonicalPlan(runId, row.plan_json, row.plan_hash),
    };
  } catch (cause) {
    return { support: "corrupt-plan", irVersion: 3, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Reject an execution mutation while preserving inspection and abandon access. */
export function requireExecutableWorkflowPlan(row: Parameters<typeof classifyWorkflowRunPlan>[0]): WorkflowPlanGraph {
  const classified = classifyWorkflowRunPlan(row);
  if (classified.support === "supported") return classified.plan;
  if (classified.support === "missing-plan" || classified.support === "unsupported-version") {
    throw new UsageError(
      `${classified.error} This historical run is inspection-only; abandon it with \`akm workflow abandon ${row.id ?? "<run>"}\` and start a new run.`,
      "WORKFLOW_IR_VERSION_UNSUPPORTED",
    );
  }
  throw new UsageError(classified.error, "INVALID_JSON_ARGUMENT");
}

/** Abandon is the sole mutation allowed for a historical run; corrupt v3 data is never mutated. */
export function requireAbandonableWorkflowPlan(row: Parameters<typeof classifyWorkflowRunPlan>[0]): void {
  const classified = classifyWorkflowRunPlan(row);
  if (classified.support === "corrupt-plan") throw new UsageError(classified.error, "INVALID_JSON_ARGUMENT");
}

export interface FrozenStepRowDefinition {
  stepId: string;
  stepTitle: string;
  instructions: string;
  completionJson: string | null;
  sequenceIndex: number;
}

/** Project persisted spine rows from the decoded plan, never from the mutable source asset. */
export function frozenStepRows(plan: WorkflowPlanGraph): FrozenStepRowDefinition[] {
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

/** Verify the durable spine still agrees with the decoded/hash-verified plan before any mutation. */
export function assertWorkflowSpineMatchesPlan(
  plan: WorkflowPlanGraph,
  run: WorkflowRunRow,
  rows: WorkflowRunStepRow[],
): void {
  const expected = frozenStepRows(plan);
  if (rows.length !== expected.length) corruptSpine(run.id, "step count differs from the frozen plan");
  for (let index = 0; index < expected.length; index++) {
    const actual = rows[index];
    const planned = expected[index];
    if (
      !actual ||
      !planned ||
      actual.step_id !== planned.stepId ||
      actual.step_title !== planned.stepTitle ||
      actual.instructions !== planned.instructions ||
      actual.completion_json !== planned.completionJson ||
      actual.sequence_index !== planned.sequenceIndex
    ) {
      const fields = [
        actual.step_id !== planned.stepId ? "step_id" : "",
        actual.step_title !== planned.stepTitle ? "step_title" : "",
        actual.instructions !== planned.instructions ? "instructions" : "",
        actual.completion_json !== planned.completionJson ? "completion_json" : "",
        actual.sequence_index !== planned.sequenceIndex ? "sequence_index" : "",
      ].filter(Boolean);
      corruptSpine(run.id, `step row ${index} differs from the frozen plan (${fields.join(", ") || "missing row"})`);
    }
  }
  if (run.current_step_id !== null && !expected.some((step) => step.stepId === run.current_step_id))
    corruptSpine(run.id, `current step ${run.current_step_id} is not in the frozen plan`);

  const current = run.current_step_id ? rows.find((row) => row.step_id === run.current_step_id) : undefined;
  if (run.status === "active") {
    const firstPending = rows.find((row) => row.status === "pending");
    if (!current || current.status !== "pending" || firstPending?.step_id !== current.step_id)
      corruptSpine(run.id, "active status/current step does not match the first pending plan step");
  } else if (run.status === "blocked") {
    if (!current || current.status !== "blocked")
      corruptSpine(run.id, `${run.status} status does not match the current plan step`);
  } else if (run.status === "failed") {
    // `workflow abandon` marks the run failed while intentionally leaving its
    // current step pending so `resume` can reopen the same work.
    if (!current || (current.status !== "failed" && current.status !== "pending"))
      corruptSpine(run.id, `${run.status} status does not match the current plan step`);
  } else if (run.status === "completed") {
    if (
      run.current_step_id !== null ||
      rows.some((row) => row.status === "pending" || row.status === "blocked" || row.status === "failed")
    )
      corruptSpine(run.id, "completed status disagrees with the plan spine");
  }
}

function routeInstructions(route: NonNullable<WorkflowPlanGraph["steps"][number]["route"]>): string {
  const branches = Object.entries(route.when)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([match, stepId]) => `"${match}" -> ${stepId}`);
  if (route.defaultStepId !== undefined) branches.push(`default -> ${route.defaultStepId}`);
  return `Route on ${route.input}: ${branches.join(", ")}.`;
}

function corruptSpine(runId: string, detail: string): never {
  throw new UsageError(
    `Workflow run ${runId} has a corrupt durable step spine: ${detail}. Refusing to mutate state that disagrees with its frozen plan.`,
    "INVALID_JSON_ARGUMENT",
  );
}
