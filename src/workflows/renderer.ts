// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Show renderer for peer workflow sources. `.md` and `.yml` both compile
 * through `compileWorkflowSource` into a plan, which is projected down to the
 * public `ShowResponse` shape, including a compact per-step orchestration
 * summary (engine/model or an exec unit's argv, `map.over` reference, route
 * table) when the step declares one.
 */

import { displayRef } from "../core/asset/resolve-ref";
import { UsageError } from "../core/errors";
import type { AssetRenderer, RenderContext } from "../indexer/walk/file-context";
import type {
  ShowResponse,
  WorkflowParameter,
  WorkflowStepDefinition,
  WorkflowStepOrchestrationSummary,
} from "../sources/types";
import { compileWorkflowSource, routeDescription, workflowStepInstructions } from "./compile";
import type { WorkflowPlan, WorkflowPlanStep } from "./plan";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildWorkflowAction(ref: string): string {
  return `Start or resume execution with \`akm workflow run ${shellQuote(ref)}\`.`;
}

function deriveName(ctx: RenderContext): string {
  const metaName = ctx.matchResult.meta?.name;
  if (typeof metaName === "string" && metaName) return metaName;
  const ext = ctx.relPath.lastIndexOf(".");
  return ext > 0 ? ctx.relPath.slice(0, ext) : ctx.relPath;
}

function loadPlan(ctx: RenderContext): WorkflowPlan {
  const result = compileWorkflowSource(ctx.content(), { path: ctx.relPath, workspaceRoot: ctx.stashRoot });
  if (result.ok) return result.plan;
  const summary = result.errors.map((e) => `${e.path}:${e.line} — ${e.message}`).join("\n");
  throw new UsageError(`Workflow has errors:\n${summary}`);
}

/** Project the `params` block into the flat `WorkflowParameter` list. */
function projectParameters(plan: WorkflowPlan): WorkflowParameter[] | undefined {
  if (!plan.paramSchemas) return undefined;
  const parameters = Object.entries(plan.paramSchemas).map(([name, schema]) => {
    const description = schema.description;
    return { name, ...(typeof description === "string" && description !== "" ? { description } : {}) };
  });
  return parameters.length > 0 ? parameters : undefined;
}

/**
 * Compact, show-facing orchestration summary for one step. Field mapping:
 * `engine`/`model`/`timeoutMs` merge the run-level `defaults` exactly like the
 * compiler does (per-unit override wins), `fanOut.over` carries the raw
 * reference string, and `route` carries the explicit input + branch table.
 * Returns undefined when the step declares nothing worth summarizing.
 *
 * ## exec units
 *
 * An `exec` unit runs a shell command and names NO engine — the parser rejects
 * `engine`/`model`/`llm` alongside `exec:`. Merging `defaults.engine` into its
 * summary would make `show` state something untrue about what will run, so the
 * two fields are suppressed and the argv is projected instead, under `exec`
 * (field presence carries the dispatch kind, exactly like `fanOut`/`route`
 * carry the step kind).
 *
 * `timeoutMs` still merges the defaults: an exec unit really does inherit
 * `defaults.timeout`, so that number stays true for it.
 *
 * The argv is shown IN FULL, never clipped. It is authored literally in the
 * asset — the `${{ … }}` interpolation language is gone, so nothing in it is
 * resolved from the environment, from a secret ref, or from a prior step's
 * output — which makes it (a) safe to display, since every byte is already
 * visible in the workflow file `show` is rendering, and (b) pointless to clip:
 * the whole finding this projection answers is `show` describing something
 * other than what runs, and a truncated argv is that same bug in miniature.
 * It is far smaller than the step `instructions` this same projection
 * already carries whole.
 */
function summarizeStepOrchestration(
  step: WorkflowPlanStep,
  defaults: WorkflowPlan["defaults"],
): WorkflowStepOrchestrationSummary | undefined {
  const spec = step.spec;
  const unit = spec?.unit;
  const exec = spec?.exec;
  const engine = exec ? undefined : (unit?.engine ?? defaults?.engine);
  const model = exec ? undefined : (unit?.model ?? defaults?.model);
  const timeoutMs = unit?.timeoutMs !== undefined ? unit.timeoutMs : defaults?.timeoutMs;

  const summary: WorkflowStepOrchestrationSummary = {
    ...(engine !== undefined ? { engine } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    // Same projection the frozen plan uses, so what `show` prints cannot drift from what runs.
    ...(exec ? { exec: { ...exec } } : {}),
    ...(spec?.map
      ? {
          fanOut: {
            over: spec.map.over,
            ...(spec.map.concurrency !== undefined ? { concurrency: spec.map.concurrency } : {}),
            reducer: spec.map.reducer ?? "collect",
          },
        }
      : {}),
    ...(unit?.output !== undefined || step.outputSchema !== undefined ? { hasSchema: true } : {}),
    ...(unit?.env !== undefined ? { env: [...unit.env] } : {}),
    ...(step.route
      ? {
          route: {
            input: step.route.input,
            branches: Object.entries(step.route.when).map(([match, stepId]) => ({ match, stepId })),
            ...(step.route.defaultStepId !== undefined ? { defaultStepId: step.route.defaultStepId } : {}),
          },
        }
      : {}),
  };

  return Object.keys(summary).length > 0 ? summary : undefined;
}

function projectStepDefinitions(plan: WorkflowPlan): WorkflowStepDefinition[] {
  return plan.steps.map((step, sequenceIndex) => {
    const orchestration = summarizeStepOrchestration(step, plan.defaults);
    const instructions = workflowStepInstructions(step);
    return {
      id: step.stepId,
      title: step.stepId,
      instructions: instructions || (step.route ? routeDescription(step.route) : ""),
      ...(step.gate.criteria.length > 0 ? { completionCriteria: [...step.gate.criteria] } : {}),
      sequenceIndex,
      ...(orchestration ? { orchestration } : {}),
    };
  });
}

export const workflowMdRenderer: AssetRenderer = {
  name: "workflow-md",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx);
    const plan = loadPlan(ctx);
    // WI-8.5b (display flip): the `akm workflow run <ref>` action is DISPLAY
    // output — its spelling follows the D-R5 display rule (`displayRef`). A
    // primary/default-bundle workflow renders the SHORT conceptId
    // (`workflows/<name>`); a named source qualifies it as
    // (`<bundle>//workflows/<name>`).
    const ref = displayRef({ type: "workflow", name, bundleId: ctx.origin }, ctx.defaultBundle);
    const parameters = projectParameters(plan);
    return {
      type: "workflow",
      name,
      path: ctx.absPath,
      action: buildWorkflowAction(ref),
      ...(plan.preamble ? { content: plan.preamble } : {}),
      description: plan.description,
      // No authored title — the asset's human name is its `description`/H1; this is its canonical name.
      workflowTitle: name,
      ...(parameters ? { parameters: parameters.map((p) => p.name), workflowParameters: parameters } : {}),
      steps: projectStepDefinitions(plan),
    };
  },
};
