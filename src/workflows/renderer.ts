// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Show + indexing renderer for the unified workflow asset (workflow-format-
 * unification). One format now: reads the frontmatter+body document via
 * `parseWorkflow` and projects the validated `WorkflowDocument` down to the
 * public `ShowResponse` shape and into search hints for the indexer,
 * including a compact per-step orchestration summary (engine/model or an exec
 * unit's argv, `map.over` reference, route table) when the step declares one.
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
import { parseWorkflow } from "./parser";
import type { ProgramDefaults } from "./program/schema";
import type { WorkflowDocument, WorkflowStep } from "./schema";

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

function loadDocument(ctx: RenderContext): WorkflowDocument {
  const result = parseWorkflow(ctx.content(), { path: ctx.relPath });
  if (result.ok) return result.document;
  const summary = result.errors.map((e) => `${ctx.relPath}:${e.line} — ${e.message}`).join("\n");
  throw new UsageError(`Workflow has errors:\n${summary}`);
}

/**
 * The instruction text a step contributes to the flat step projection. A
 * route step has no body requirement, so a deterministic description of the
 * routing table stands in when it declares no section (the spine still needs
 * a non-empty instructions string).
 */
function stepInstructions(step: WorkflowStep): string {
  if (step.instructions) return step.instructions.text;
  if (step.route) {
    const branches = step.route.branches.map((b) => `"${b.match}" -> ${b.stepId}`);
    if (step.route.defaultStepId !== undefined) branches.push(`default -> ${step.route.defaultStepId}`);
    return `Route on ${step.route.input}: ${branches.join(", ")}.`;
  }
  return "";
}

/** Project the `params` block into the flat `WorkflowParameter` list. */
function projectParameters(document: WorkflowDocument): WorkflowParameter[] | undefined {
  if (!document.params) return undefined;
  const parameters = Object.entries(document.params).map(([name, schema]) => {
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
 * The parser bounds it anyway (`WORKFLOW_MAX_EXEC_ARGV` entries of
 * `WORKFLOW_MAX_EXEC_ARG_BYTES`), and it is far smaller than the step
 * `instructions` this same projection already carries whole.
 */
function summarizeStepOrchestration(
  step: WorkflowStep,
  defaults: ProgramDefaults | undefined,
): WorkflowStepOrchestrationSummary | undefined {
  const unit = step.unit ?? step.map?.unit;
  const exec = unit?.exec;
  const engine = exec ? undefined : (unit?.engine ?? defaults?.engine);
  const model = exec ? undefined : (unit?.model ?? defaults?.model);
  const timeoutMs = unit?.timeoutMs !== undefined ? unit.timeoutMs : defaults?.timeoutMs;

  const summary: WorkflowStepOrchestrationSummary = {
    ...(engine !== undefined ? { engine } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(exec
      ? {
          exec: {
            command: [...exec.command],
            ...(exec.cwd !== undefined ? { cwd: exec.cwd } : {}),
            ...(exec.passEnv !== undefined ? { passEnv: [...exec.passEnv] } : {}),
            ...(exec.inheritEnv === true ? { inheritEnv: true as const } : {}),
          },
        }
      : {}),
    ...(step.map
      ? {
          fanOut: {
            over: step.map.over,
            ...(step.map.concurrency !== undefined ? { concurrency: step.map.concurrency } : {}),
            reducer: step.map.reducer ?? "collect",
          },
        }
      : {}),
    ...(unit?.output !== undefined || step.output !== undefined ? { hasSchema: true } : {}),
    ...(unit?.env !== undefined ? { env: [...unit.env] } : {}),
    ...(step.route
      ? {
          route: {
            input: step.route.input,
            branches: step.route.branches.map((b) => ({ match: b.match, stepId: b.stepId })),
            ...(step.route.defaultStepId !== undefined ? { defaultStepId: step.route.defaultStepId } : {}),
          },
        }
      : {}),
  };

  return Object.keys(summary).length > 0 ? summary : undefined;
}

function projectStepDefinitions(document: WorkflowDocument): WorkflowStepDefinition[] {
  return document.steps.map((step) => {
    const orchestration = summarizeStepOrchestration(step, document.defaults);
    return {
      id: step.id,
      // No titles anywhere in the unified format — a step IS its id.
      title: step.id,
      instructions: stepInstructions(step),
      ...(step.gateRubric?.text.trim() ? { completionCriteria: [step.gateRubric.text] } : {}),
      sequenceIndex: step.sequenceIndex,
      ...(orchestration ? { orchestration } : {}),
    };
  });
}

export const workflowMdRenderer: AssetRenderer = {
  name: "workflow-md",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx);
    const doc = loadDocument(ctx);
    // WI-8.5b (display flip): the `akm workflow run <ref>` action is DISPLAY
    // output — its spelling follows the D-R5 display rule (`displayRef`). A
    // primary/default-bundle workflow renders the SHORT conceptId
    // (`workflows/<name>`); a named source qualifies it as
    // (`<bundle>//workflows/<name>`).
    const ref = displayRef({ type: "workflow", name, bundleId: ctx.origin }, ctx.defaultBundle);
    const parameters = projectParameters(doc);
    return {
      type: "workflow",
      name,
      path: ctx.absPath,
      action: buildWorkflowAction(ref),
      ...(doc.preamble ? { content: doc.preamble } : {}),
      description: doc.description,
      // No authored title in the unified format — the asset's human name is
      // its `description`/H1 like any other asset; this is its canonical name.
      workflowTitle: name,
      ...(parameters ? { parameters: parameters.map((p) => p.name), workflowParameters: parameters } : {}),
      steps: projectStepDefinitions(doc),
    };
  },
};
