// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Run-parameter validation against the frozen plan's param schemas, a thin
 * consumer of the shared input contract (`src/execution/input-contract.ts`):
 * every declared param is optional, and the messages are the workflow ones.
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

/** Every declared workflow param as an `InputDeclaration`, `required: false` — workflow params declare nothing required. */
function contractFromPlan(plan: WorkflowParameterPlan): InputContract {
  const names = plan.params ?? Object.keys(plan.paramSchemas ?? {});
  const contract: Record<string, InputDeclaration> = {};
  for (const name of names) {
    contract[name] = { schema: plan.paramSchemas?.[name] ?? {}, required: false };
  }
  return contract;
}

/** A child workflow's `params:` as an input contract, so one normalizer binds every composition surface. */
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
  // preserved as an explicit early return, even
  // though an empty contract would validate to `[]` regardless.
  if (!plan.paramSchemas || Object.keys(plan.paramSchemas).length === 0) return [];
  return validateInputs(contractFromPlan(plan), params, { pathRoot: "params" });
}
