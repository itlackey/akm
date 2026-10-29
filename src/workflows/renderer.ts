// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Show renderer for workflow sources. A `.md` source compiles through
 * `compileWorkflowSource` into a plan, which is projected down to the public
 * `ShowResponse` shape, including a compact per-step orchestration summary
 * (engine/model or an exec unit's argv, `map.over` reference) when the step
 * declares one.
 */

import { displayRef } from "../core/asset/resolve-ref";
import { isInstalledBundle, resolveRefOwner } from "../core/env-secret-ref";
import { UsageError } from "../core/errors";
import { substituteRefTokens } from "../core/ref-token";
import type { AssetRenderer, RenderContext } from "../indexer/walk/file-context";
import type {
  ShowResponse,
  WorkflowParameter,
  WorkflowStepDefinition,
  WorkflowStepOrchestrationSummary,
  WorkflowStepRef,
} from "../sources/types";
import { compileWorkflowSource, workflowStepInstructions } from "./compile";
import type { WorkflowExec, WorkflowPlan, WorkflowPlanStep } from "./plan";

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
  const result = compileWorkflowSource(ctx.content(), { path: ctx.relPath });
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
 * `engine` (the connection or harness a unit names), `model` and `timeoutMs` merge the run-level `defaults` exactly like the
 * compiler does (per-unit override wins), `fanOut.over` carries the raw
 * reference string.
 * Returns undefined when the step declares nothing worth summarizing.
 *
 * ## exec units
 *
 * An `exec` unit runs a shell command and names no connection or harness — the parser rejects
 * `connection`/`harness`/`model`/`llm` alongside `exec:`. Merging the run's default
 * into its summary would make `show` state something untrue about what will run, so the
 * two fields are suppressed and the argv is projected instead, under `exec`
 * (field presence carries the dispatch kind, exactly like `fanOut`
 * carries the step kind).
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
export function summarizeStepOrchestration(
  step: WorkflowPlanStep,
  defaults: WorkflowPlan["defaults"],
): WorkflowStepOrchestrationSummary | undefined {
  const spec = step.spec;
  const unit = spec?.unit;
  // A stored plan carries no authored spec: read the same fields off its frozen dispatch.
  const frozen = spec ? undefined : frozenDispatch(step);
  const exec = spec ? spec.exec : frozen?.exec;
  const env = unit?.env ?? frozen?.env;
  const workflow = spec ? spec.workflow : frozen?.workflow;
  const named = (settings: typeof unit | undefined): string | undefined =>
    settings?.connection ?? settings?.harness ?? settings?.engine;
  const engine = exec ? undefined : (named(unit) ?? named(defaults));
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
    ...(env !== undefined ? { env: [...env] } : {}),
    ...(workflow !== undefined ? { workflow } : {}),
  };

  return Object.keys(summary).length > 0 ? summary : undefined;
}

/** The exec argv, env refs and child workflow a frozen step dispatches. */
function frozenDispatch(step: WorkflowPlanStep): { exec?: WorkflowExec; env?: string[]; workflow?: string } {
  const root = step.root;
  const unit = root?.kind === "map" ? root.template : root;
  if (!unit) return {};
  const target = unit.frozenTarget;
  const env = unit.environment.flatMap((binding) => (binding.kind === "env-ref" ? [binding.ref] : []));
  return {
    ...(target.kind === "shell"
      ? {
          exec: {
            command: [...target.exec.command],
            ...(target.exec.cwd !== undefined ? { cwd: target.exec.cwd } : {}),
            ...(target.exec.passEnv ? { passEnv: [...target.exec.passEnv] } : {}),
          },
        }
      : {}),
    ...(env.length > 0 ? { env } : {}),
    ...(target.kind === "child-workflow" ? { workflow: target.ref } : {}),
  };
}

/**
 * Add the bundle-qualified ref every `${ref}` token in the argv or cwd, every
 * `env:` entry and the child `workflow:` resolves to right now, through the
 * one owner walk (`resolveRefOwner`). A ref no bundle owns lands in
 * `unresolved` instead; callers decide whether that is an error. No secret
 * is read and no path is returned.
 */
export function resolveOrchestrationRefs(summary: WorkflowStepOrchestrationSummary): WorkflowStepOrchestrationSummary {
  const refs: WorkflowStepRef[] = [];
  const unresolved: Array<Pick<WorkflowStepRef, "ref" | "in">> = [];
  const note = (ref: string, where: WorkflowStepRef["in"]): void => {
    let owner: ReturnType<typeof resolveRefOwner>;
    try {
      owner = resolveRefOwner(ref);
    } catch {
      owner = undefined;
    }
    if (owner) refs.push({ ref, resolved: owner.ref, in: where });
    else unresolved.push({ ref, in: where });
  };
  const tokens = (values: string[], where: "argv" | "cwd"): void => {
    const seen = new Set<string>();
    substituteRefTokens(
      Object.fromEntries(values.map((value, index) => [String(index), value])),
      (ref) => {
        if (!seen.has(ref)) {
          seen.add(ref);
          note(ref, where);
        }
        return { kind: "path", path: "" };
      },
      isInstalledBundle,
    );
  };
  if (summary.exec) {
    tokens(summary.exec.command, "argv");
    if (summary.exec.cwd !== undefined) tokens([summary.exec.cwd], "cwd");
  }
  for (const ref of summary.env ?? []) note(ref, "env");
  if (summary.workflow !== undefined) note(summary.workflow, "workflow");
  return { ...summary, refs, ...(unresolved.length > 0 ? { unresolved } : {}) };
}

function projectStepDefinitions(plan: WorkflowPlan): WorkflowStepDefinition[] {
  return plan.steps.map((step, sequenceIndex) => {
    const orchestration = summarizeStepOrchestration(step, plan.defaults);
    const instructions = workflowStepInstructions(step);
    return {
      id: step.stepId,
      title: step.stepId,
      instructions,
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
