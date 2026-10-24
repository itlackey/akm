// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure freeze-time binding of a composing step's inputs.
 * {@link freezeTaskInputBindings} classifies an authored `with:` against a
 * contract; {@link rebindTaskInputBindings} re-binds already-classified
 * bindings by name against another contract (a task's effective inputs
 * against a child workflow's `params:`) without re-deriving their kind. A
 * reference's resolved value is validated before each attempt (`exec/step-work.ts`).
 * See docs/architecture/decisions/0008-task-binding-normalization.md.
 */

import { isRecord } from "../../core/common";
import { UsageError } from "../../core/errors";
import { type InputContract, type TaskInputBinding, validateInputs } from "../../execution/input-contract";
import { parseReference } from "../program/expressions";

export interface FreezeTaskInputBindingsInput {
  /** The composing step's own id — for diagnostics only. */
  readonly stepId: string;
  /** The task's authored ref (e.g. "tasks/nightly-v4") — for diagnostics only. */
  readonly targetRef: string;
  /** The step's authored `with:` record, already decoded to arbitrary JSON values. */
  readonly with: Readonly<Record<string, unknown>> | undefined;
  /** The composed task's OWN declared `inputs:` contract — never a caller's. */
  readonly contract: InputContract;
  /** Step ids that appear BEFORE this step in the frozen step order. */
  readonly earlierStepIds: ReadonlySet<string>;
  /** THIS workflow's own declared param names — never an outer composing task's. */
  readonly declaredParamNames: ReadonlySet<string>;
}

export interface RebindTaskInputBindingsInput {
  /** The composing step's own id — for diagnostics only. */
  readonly stepId: string;
  /** The child's authored ref (e.g. "workflows/inner") — for diagnostics only. */
  readonly targetRef: string;
  /** An ALREADY-NORMALIZED binding set — a v4 task's own effective inputs, classified once against the TASK's own `inputs:` contract. */
  readonly bindings: readonly TaskInputBinding[] | undefined;
  /** The NEW contract to re-bind `bindings` against by name — the child workflow's declared `params:`, never the task's own. */
  readonly contract: InputContract;
}

function inputBindingInvalid(message: string): UsageError {
  return new UsageError(message, "INPUT_BINDING_INVALID");
}

function unknownBindingNameError(
  stepId: string,
  targetRef: string,
  name: string,
  declaredNames: readonly string[],
): UsageError {
  return inputBindingInvalid(
    `Workflow step ${stepId} targets ${targetRef} with.${name}, which is not a declared input. ` +
      `Declared inputs: ${declaredNames.length > 0 ? declaredNames.join(", ") : "(none)"}.`,
  );
}

/**
 * Normalize an authored `with:` into the sorted `TaskInputBinding[]` a frozen
 * target carries: one entry per declared input with an effective value
 * (literal, reference, or default). Throws `INPUT_BINDING_INVALID` on the first violation.
 */
export function freezeTaskInputBindings(input: FreezeTaskInputBindingsInput): readonly TaskInputBinding[] {
  const { stepId, targetRef, contract, earlierStepIds, declaredParamNames } = input;
  const authored = input.with ?? {};
  const declaredNames = Object.keys(contract).sort();

  const byName = new Map<string, TaskInputBinding>();
  for (const [name, value] of Object.entries(authored)) {
    if (!Object.hasOwn(contract, name)) throw unknownBindingNameError(stepId, targetRef, name, declaredNames);
    const declaration = contract[name];
    if (!declaration)
      throw inputBindingInvalid(`Workflow step ${stepId} targets ${targetRef} with.${name} is invalid.`);
    byName.set(
      name,
      normalizeOneEntry(stepId, targetRef, name, value, declaration.schema, earlierStepIds, declaredParamNames),
    );
  }

  return finalizeBindings(stepId, targetRef, contract, byName);
}

/**
 * Re-bind already-normalized bindings by name against a different contract,
 * keeping each entry's kind (a literal shaped like `{from}` stays a literal).
 * A literal is validated against the new contract; a reference keeps its
 * `from` and takes the new contract's schema; undeclared names are
 * `INPUT_BINDING_INVALID`; missing keys are defaulted or required as usual.
 */
export function rebindTaskInputBindings(input: RebindTaskInputBindingsInput): readonly TaskInputBinding[] {
  const { stepId, targetRef, contract } = input;
  const declaredNames = Object.keys(contract).sort();

  const byName = new Map<string, TaskInputBinding>();
  for (const binding of input.bindings ?? []) {
    if (!Object.hasOwn(contract, binding.name)) {
      throw unknownBindingNameError(stepId, targetRef, binding.name, declaredNames);
    }
    const declaration = contract[binding.name];
    if (!declaration)
      throw inputBindingInvalid(`Workflow step ${stepId} targets ${targetRef} with.${binding.name} is invalid.`);
    byName.set(
      binding.name,
      binding.kind === "literal"
        ? binding
        : Object.freeze({ kind: "reference", name: binding.name, from: binding.from, schema: declaration.schema }),
    );
  }

  return finalizeBindings(stepId, targetRef, contract, byName);
}

/** Shared tail: apply defaults (or require), schema-validate every literal, and sort by name. */
function finalizeBindings(
  stepId: string,
  targetRef: string,
  contract: InputContract,
  byName: Map<string, TaskInputBinding>,
): readonly TaskInputBinding[] {
  for (const [name, declaration] of Object.entries(contract)) {
    if (byName.has(name)) continue;
    if (Object.hasOwn(declaration, "default")) {
      byName.set(name, Object.freeze({ kind: "literal", name, value: declaration.default }));
      continue;
    }
    if (declaration.required) {
      throw inputBindingInvalid(
        `Workflow step ${stepId} targets ${targetRef}, which declares required input "${name}" with no default; ` +
          `supply it with with.${name}.`,
      );
    }
  }

  // Validate literals only: a reference's value is not known until the attempt.
  const literalContract: Record<string, InputContract[string]> = {};
  const literalValues: Record<string, unknown> = {};
  for (const binding of byName.values()) {
    if (binding.kind !== "literal") continue;
    const declaration = contract[binding.name];
    if (declaration) literalContract[binding.name] = declaration;
    literalValues[binding.name] = binding.value;
  }
  const schemaErrors = validateInputs(literalContract, literalValues, { pathRoot: "with" });
  if (schemaErrors.length > 0) {
    throw inputBindingInvalid(`Workflow step ${stepId} targets ${targetRef}: ${schemaErrors.join("; ")}`);
  }

  const sorted = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return Object.freeze(sorted);
}

/**
 * Classify one authored `with:` entry: exactly `{ from: <valid reference> }`
 * is a reference; any other object with an own `from` key is
 * `INPUT_BINDING_INVALID`, never a literal.
 */
function normalizeOneEntry(
  stepId: string,
  targetRef: string,
  name: string,
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
  earlierStepIds: ReadonlySet<string>,
  declaredParamNames: ReadonlySet<string>,
): TaskInputBinding {
  if (!isRecord(value) || !Object.hasOwn(value, "from")) {
    return Object.freeze({ kind: "literal", name, value });
  }

  const keys = Object.keys(value);
  if (keys.length !== 1 || typeof value.from !== "string") {
    throw inputBindingInvalid(
      `Workflow step ${stepId} targets ${targetRef} with.${name} looks like a reference binding ({from: ...}) ` +
        `but is not one: it must have exactly one key, "from", whose value is a reference string.`,
    );
  }
  const parsed = parseReference(value.from);
  if (!parsed.ok) {
    throw inputBindingInvalid(
      `Workflow step ${stepId} targets ${targetRef} with.${name} reference ${JSON.stringify(value.from)} is ` +
        `invalid: ${parsed.message}`,
    );
  }
  if (parsed.expr.kind === "stepOutput") {
    if (!earlierStepIds.has(parsed.expr.stepId)) {
      throw inputBindingInvalid(
        `Workflow step ${stepId} targets ${targetRef} with.${name} reference ${value.from} does not name an ` +
          `earlier step of this workflow.`,
      );
    }
  } else if (!declaredParamNames.has(parsed.expr.name)) {
    const sortedParams = [...declaredParamNames].sort();
    throw inputBindingInvalid(
      `Workflow step ${stepId} targets ${targetRef} with.${name} reference ${value.from} does not name a ` +
        `declared workflow param; declared params: ${sortedParams.length > 0 ? sortedParams.join(", ") : "(none)"}.`,
    );
  }
  return Object.freeze({ kind: "reference", name, from: value.from, schema });
}
