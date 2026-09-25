// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Run-parameter validation against the frozen plan's param schemas. A workflow
 * can declare `params.files: { type: array }`; supplying a non-array through
 * the exact-name `--files` flag must be rejected at start rather than silently
 * flowing into a unit prompt. The schemas are frozen into the plan, so
 * validation is a pure function of the frozen plan and supplied params.
 *
 * P2a (docs/plans/specs/p2a-task-source-v4.md §4.3, D3): this module is now a
 * THIN CONSUMER of the shared input contract, `src/execution/input-contract.ts`
 * (§4, D3, D3-N1/D3-N2/D3-N3). Every export below keeps its existing name,
 * signature, message, code, and hint byte-identically —
 * `tests/workflows/workflow-param-flags.test.ts` and
 * `tests/integration/workflows/params-validation.test.ts` pin that with zero
 * diff. `contractFromPlan` adapts a `WorkflowParameterPlan` into an
 * `InputContract` (every declared param, `required: false` — workflow params
 * declare nothing required). `WORKFLOW_PARAMETER_DIAGNOSTICS` reproduces
 * today's five workflow-parameter messages/codes for the shared
 * `materializeInputFlags` (D3-N3); its `contractViolation` formatter
 * re-roots each `"$"`-prefixed error from the shared module's internal check
 * to `"params."`, matching what `validateWorkflowParams` (called directly,
 * already `"params."`-rooted) has always produced. No coercion or validation
 * logic lives in this file — it lives once, in the shared module.
 *
 * Pure module: no IO, no engine imports.
 */

import { UsageError } from "../../core/errors";
import {
  type InputContract,
  type InputDeclaration,
  type InputFlag,
  type InputFlagDiagnostics,
  materializeInputFlags,
  validateInputs,
} from "../../execution/input-contract";

export interface WorkflowParameterPlan {
  readonly params?: readonly string[];
  readonly paramSchemas?: Readonly<Record<string, Record<string, unknown>>>;
}

/** Alias of the shared `InputFlag` shape, kept under its established name — src/commands/workflow-cli.ts imports it by this name. */
export type WorkflowParameterFlag = InputFlag;

/** Every declared workflow param as an `InputDeclaration`, `required: false` — workflow params declare nothing required (§4.3). */
function contractFromPlan(plan: WorkflowParameterPlan): InputContract {
  const names = plan.params ?? Object.keys(plan.paramSchemas ?? {});
  const contract: Record<string, InputDeclaration> = {};
  for (const name of names) {
    contract[name] = { schema: plan.paramSchemas?.[name] ?? {}, required: false };
  }
  return contract;
}

/**
 * `contractFromPlan`, exported under its P3a-facing name (spec
 * docs/plans/specs/p3a-plan-v5-child-freeze.md A-N8): a child workflow has no
 * `inputs:` contract of its own (that is task source v4's vocabulary) — it
 * declares `params:`, and this is the SAME adapter this file already uses
 * for run-parameter validation, reused so `freezeTaskInputBindings`
 * (`src/workflows/freeze/task-bindings.ts`, generic over `InputContract`) has
 * exactly one normalizer for every binding surface. Additive; no behavior
 * change to this file's own exports.
 */
export { contractFromPlan as workflowParamContract };

function invalidParameter(name: string, message: string): UsageError {
  return new UsageError(`Workflow parameter "--${name}" ${message}.`, "INVALID_FLAG_VALUE");
}

/** The workflow-parameter message/code vocabulary for `materializeInputFlags` (D3-N3) — today's five strings, unchanged. */
const WORKFLOW_PARAMETER_DIAGNOSTICS: InputFlagDiagnostics = {
  unknownFlag: (name, declared) => {
    const available = declared.map((n) => `--${n}`).join(", ");
    return new UsageError(
      `Unknown workflow parameter "--${name}". Parameter flags must exactly match a declared workflow parameter.`,
      "UNKNOWN_FLAG",
      available ? `Declared parameters: ${available}.` : "This workflow declares no parameters.",
    );
  },
  invalidValue: (name, detail) => invalidParameter(name, detail),
  contractViolation: (errors) =>
    new UsageError(
      `Workflow parameter flags do not satisfy the workflow's declared schemas:\n${errors
        .map((error) => `  - ${error.replace(/^\$/, "params")}`)
        .join("\n")}`,
      "INVALID_FLAG_VALUE",
    ),
  duplicateNonArray: (name) => invalidParameter(name, "was provided more than once but is not declared as an array"),
  malformedJson: (name) => invalidParameter(name, "must contain valid JSON"),
};

/**
 * Materialize exact-name CLI parameter flags against the plan being frozen for
 * the run. The CLI deliberately carries raw values to this boundary so type
 * coercion cannot race or drift from the persisted plan's schemas.
 */
export function materializeWorkflowParameterFlags(
  plan: WorkflowParameterPlan,
  flags: readonly WorkflowParameterFlag[],
): Record<string, unknown> {
  if (flags.length === 0) return {};
  return materializeInputFlags(contractFromPlan(plan), flags, WORKFLOW_PARAMETER_DIAGNOSTICS);
}

/**
 * Validate a run's supplied params against the plan's frozen param schemas.
 * Returns a flat list of human-readable, path-prefixed error strings (empty =
 * valid). Params the plan does not declare a schema for are not constrained.
 */
export function validateWorkflowParams(plan: WorkflowParameterPlan, params: Record<string, unknown>): string[] {
  // A plan with no schemas must not start emitting `properties: {}` noise —
  // preserved as an explicit early return (§4.3 binding constraint), even
  // though an empty contract would validate to `[]` regardless.
  if (!plan.paramSchemas || Object.keys(plan.paramSchemas).length === 0) return [];
  return validateInputs(contractFromPlan(plan), params, { pathRoot: "params" });
}

/**
 * Run-integrity assert (reviewer #12): the journaled `params_json`
 * row must STILL satisfy the frozen param schemas. `startWorkflowRun` already
 * validated the params it stored, so a violation here means the row was edited
 * after the run started. Refuse to drive the run rather than resolve prompts
 * from schema-violating params.
 */
export function assertRunParamsSatisfyPlan(
  runId: string,
  plan: WorkflowParameterPlan,
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
