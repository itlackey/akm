// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Run-parameter validation against the frozen plan's param schemas (reviewer
 * #12). A program can declare `params.files: { type: array }`; supplying
 * `--params '{"files":"not-an-array"}'` must be rejected at start rather than
 * silently flowing into a unit prompt. The schemas are frozen into the plan
 * ({@link WorkflowPlanGraph.paramSchemas}, program path only) so validation is
 * a pure function of the frozen plan and the supplied params — no live-asset
 * re-read.
 *
 * Uses the same bounded {@link validateJsonSchemaSubset} the engine applies to
 * unit output: undeclared params are permitted (the schema map only constrains
 * the params it names), and a workflow with no declared schemas (every Markdown
 * workflow, and programs without a `params:` block) validates trivially.
 *
 * Pure module: no IO, no engine imports.
 */

import { UsageError } from "../../core/errors";
import { validateJsonSchemaSubset } from "../../core/json-schema";
import type { WorkflowPlanGraph } from "./schema";

/**
 * Validate a run's supplied params against the plan's frozen param schemas.
 * Returns a flat list of human-readable, path-prefixed error strings (empty =
 * valid). Params the plan does not declare a schema for are not constrained.
 */
export function validateWorkflowParams(plan: WorkflowPlanGraph, params: Record<string, unknown>): string[] {
  const schemas = plan.paramSchemas;
  if (!schemas || Object.keys(schemas).length === 0) return [];
  // Validate the params object as a whole against a synthetic object schema
  // whose `properties` are the declared param schemas. Missing declared params
  // are NOT required (params may be optional / defaulted downstream); only a
  // PRESENT param that violates its declared schema is an error.
  // Re-root the validator's `$` JSON-pointer prefix to `params` for messages
  // that read naturally in a start/CLI error (e.g. `params.files: expected …`).
  return validateJsonSchemaSubset(params, { type: "object", properties: schemas }).map((e) =>
    e.replace(/^\$/, "params"),
  );
}

/**
 * Brief/report integrity assert (reviewer #12): the journaled `params_json`
 * row must STILL satisfy the frozen param schemas. `startWorkflowRun` already
 * validated the params it stored, so a violation here means the row was edited
 * after the run started — loud corruption, exactly like the frozen-plan hash
 * mismatch and the tampered-params replay-divergence path. Refuse to describe
 * or drive the run rather than resolve prompts from schema-violating params.
 */
export function assertRunParamsSatisfyPlan(
  runId: string,
  plan: WorkflowPlanGraph,
  params: Record<string, unknown>,
): void {
  const errors = validateWorkflowParams(plan, params);
  if (errors.length === 0) return;
  throw new UsageError(
    `Workflow run ${runId} failed the frozen param-schema integrity check: the journaled params row no longer ` +
      `satisfies the workflow's declared parameter schemas (edited after the run started). Refusing to execute it. ` +
      `Start a new run.\n${errors.map((e) => `  - ${e}`).join("\n")}`,
  );
}
