// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Read-only projections of a parsed YAML workflow *program* (redesign
 * addendum, R1) into the flat public shapes the rest of akm already speaks:
 * `WorkflowStepDefinition` rows for the run spine and `show` output, the
 * `WorkflowParameter` list, and the compact `WorkflowStepOrchestrationSummary`.
 *
 * Shared by the runtime asset loader (`runtime/workflow-asset-loader.ts`) and
 * the indexer renderer (`../renderer.ts`) so the two surfaces cannot drift.
 * Projections never resolve `${{ … }}` templates — instructions are carried
 * as the RAW template text (resolution belongs to the engine, against the
 * frozen plan).
 */

import type {
  WorkflowParameter,
  WorkflowStepDefinition,
  WorkflowStepOrchestrationSummary,
} from "../../sources/types";
import type { ProgramStep, WorkflowProgram } from "./schema";

/**
 * Renderer name for YAML workflow programs. Lives in this leaf module (not
 * `../renderer.ts`) so the indexer matcher can name it without importing the
 * renderer module and its registration side effects.
 */
export const WORKFLOW_PROGRAM_RENDERER_NAME = "workflow-program-yaml";

/** File extensions that mark a workflow asset as a YAML program. */
const WORKFLOW_PROGRAM_PATH_RE = /\.ya?ml$/i;

/** True when a workflow asset path holds a YAML program (vs. markdown). */
export function isWorkflowProgramPath(filePath: string): boolean {
  return WORKFLOW_PROGRAM_PATH_RE.test(filePath);
}

/**
 * The instruction text a step contributes to the flat step projection.
 * Unit and map steps carry their unit's RAW instruction template; route
 * steps have no unit, so a deterministic description of the routing table
 * stands in (the spine still needs a non-empty instructions string).
 */
export function programStepInstructions(step: ProgramStep): string {
  if (step.unit) return step.unit.instructions;
  if (step.map) return step.map.unit.instructions;
  if (step.route) {
    const branches = step.route.branches.map((b) => `"${b.match}" -> ${b.stepId}`);
    if (step.route.defaultStepId !== undefined) branches.push(`default -> ${step.route.defaultStepId}`);
    return `Route on ${step.route.input}: ${branches.join(", ")}.`;
  }
  return "";
}

/** Project the program's steps into flat `WorkflowStepDefinition`s. */
export function projectProgramStepDefinitions(program: WorkflowProgram): WorkflowStepDefinition[] {
  return program.steps.map((step, index) => ({
    id: step.id,
    title: step.title ?? step.id,
    instructions: programStepInstructions(step),
    sequenceIndex: index,
  }));
}

/** Project the `params` block into the flat `WorkflowParameter` list. */
export function projectProgramParameters(program: WorkflowProgram): WorkflowParameter[] | undefined {
  if (!program.params) return undefined;
  const parameters = Object.entries(program.params).map(([name, schema]) => {
    const description = schema.description;
    return {
      name,
      ...(typeof description === "string" && description !== "" ? { description } : {}),
    };
  });
  return parameters.length > 0 ? parameters : undefined;
}

/**
 * Compact, show-facing orchestration summary for one program step, reusing
 * the existing `WorkflowStepOrchestrationSummary` shape. Field mapping:
 * `runner`/`model`/`timeoutMs` merge the run-level `defaults` exactly like
 * the compiler does (per-unit wins), `fanOut.over` carries the raw `${{ … }}`
 * expression, and `route` carries the explicit input + branch table.
 * Returns undefined when the step declares nothing worth summarizing.
 */
export function summarizeProgramStepOrchestration(
  step: ProgramStep,
  defaults: WorkflowProgram["defaults"],
): WorkflowStepOrchestrationSummary | undefined {
  const unit = step.unit ?? step.map?.unit;
  const runner = unit?.runner ?? defaults?.runner;
  const model = unit?.model ?? defaults?.model;
  const timeoutMs = unit?.timeoutMs !== undefined ? unit.timeoutMs : defaults?.timeoutMs;

  const summary: WorkflowStepOrchestrationSummary = {
    ...(runner !== undefined ? { runner } : {}),
    ...(unit?.profile !== undefined ? { profile: unit.profile } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
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
