// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Markdown frontend → Workflow Plan Graph compiler (P0).
 *
 * Pure and deterministic: the same {@link WorkflowDocument} always compiles
 * to the same {@link WorkflowPlanGraph}. A linear workflow (no orchestration
 * subsections) compiles to one `agent` node per step, each guarded by its
 * `gate` — the exact behavior of today's step loop, so P0 is a refactor with
 * no behavior change. A step with a `### Fan-out` compiles to a `map` node
 * wrapping the agent template.
 *
 * Node-id convention (stable, unique within a plan):
 *   step root  → `<stepId>`          (agent) or `<stepId>.map` (map)
 *   map unit   → `<stepId>.unit`     (template instantiated per item)
 *   gate       → `<stepId>.gate`
 */

import type { WorkflowDocument, WorkflowStep } from "../schema";
import {
  type IrAgentNode,
  type IrExecNode,
  type IrGateNode,
  type IrStepPlan,
  WORKFLOW_IR_VERSION,
  type WorkflowPlanGraph,
} from "./schema";

export function compileWorkflowPlan(document: WorkflowDocument): WorkflowPlanGraph {
  const params = document.parameters?.map((p) => p.name);
  return {
    irVersion: WORKFLOW_IR_VERSION,
    title: document.title,
    ...(params && params.length > 0 ? { params } : {}),
    steps: document.steps.map(compileStep),
  };
}

function compileStep(step: WorkflowStep): IrStepPlan {
  const gate: IrGateNode = {
    kind: "gate",
    id: `${step.id}.gate`,
    stepId: step.id,
    criteria: step.completionCriteria?.map((c) => c.text) ?? [],
  };

  const route = step.orchestration?.route;
  return {
    stepId: step.id,
    title: step.title,
    sequenceIndex: step.sequenceIndex,
    ...(step.orchestration?.dependsOn ? { dependsOn: [...step.orchestration.dependsOn] } : {}),
    root: compileRoot(step),
    gate,
    ...(route
      ? {
          route: {
            input: route.input,
            branches: route.branches.map((b) => ({ ...b })),
            ...(route.defaultStepId ? { defaultStepId: route.defaultStepId } : {}),
          },
        }
      : {}),
  };
}

function compileRoot(step: WorkflowStep): IrExecNode {
  const orch = step.orchestration;
  const fanOut = orch?.fanOut;

  const agent: IrAgentNode = {
    kind: "agent",
    id: fanOut ? `${step.id}.unit` : step.id,
    instructions: step.instructions.text,
    runner: orch?.runner ?? "inherit",
    ...(orch?.profile ? { profile: orch.profile } : {}),
    ...(orch?.model ? { model: orch.model } : {}),
    ...(orch?.schema ? { schema: orch.schema } : {}),
    ...(orch?.timeoutMs !== undefined ? { timeoutMs: orch.timeoutMs } : {}),
    ...(orch?.env ? { env: [...orch.env] } : {}),
    source: step.instructions.source,
  };

  if (!fanOut) return agent;

  return {
    kind: "map",
    id: `${step.id}.map`,
    over: fanOut.over,
    template: agent,
    ...(fanOut.concurrency !== undefined ? { concurrency: fanOut.concurrency } : {}),
    reducer: fanOut.reducer ?? "collect",
    ...(orch?.source ? { source: orch.source } : {}),
  };
}
