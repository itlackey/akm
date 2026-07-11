// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { UsageError } from "../../core/errors";
import { decodeCanonicalPlan } from "../ir/plan-hash";
import type { WorkflowPlanGraph } from "../ir/schema";

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
  if (!row.plan_json)
    return {
      support: "missing-plan",
      irVersion: row.plan_ir_version ?? null,
      error: `Workflow run ${runId} has no frozen v3 plan.`,
    };
  let raw: unknown;
  try {
    raw = JSON.parse(row.plan_json);
  } catch {
    return {
      support: "corrupt-plan",
      irVersion: row.plan_ir_version ?? null,
      error: `Workflow run ${runId} has corrupt frozen plan JSON.`,
    };
  }
  const decodedVersion = typeof raw === "object" && raw !== null ? (raw as { irVersion?: unknown }).irVersion : null;
  if (decodedVersion !== 3) {
    return {
      support: "unsupported-version",
      irVersion: typeof decodedVersion === "number" ? decodedVersion : (row.plan_ir_version ?? null),
      error: `Workflow run ${runId} uses unsupported workflow IR version ${String(decodedVersion)}.`,
    };
  }
  if (row.plan_ir_version !== 3) {
    return {
      support: "corrupt-plan",
      irVersion: row.plan_ir_version ?? null,
      error: `Workflow run ${runId} has mismatched stored plan IR version.`,
    };
  }
  try {
    return { support: "supported", irVersion: 3, plan: decodeCanonicalPlan(runId, row.plan_json, row.plan_hash) };
  } catch (cause) {
    return { support: "corrupt-plan", irVersion: 3, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Reject an execution mutation while preserving inspection and abandon access. */
export function requireExecutableWorkflowPlan(row: Parameters<typeof classifyWorkflowRunPlan>[0]): WorkflowPlanGraph {
  const classified = classifyWorkflowRunPlan(row);
  if (classified.support === "supported") return classified.plan;
  throw new UsageError(
    `${classified.error} This run is inspection-only in AKM 0.9; abandon it with \`akm workflow abandon ${row.id ?? "<run>"}\` and start a new run.`,
  );
}
