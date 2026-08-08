// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Frontend -> unresolved workflow plan compiler (workflow-format-unification).
 *
 * ONE frontend now: {@link compileWorkflowPlan} lowers a parsed unified
 * `WorkflowDocument` (`../parser.ts`) into the same `WorkflowPlanDraft` shape
 * IR v3 has always consumed — the pre-unification split between a linear
 * markdown compiler and a YAML-program compiler is gone. This pass owns the
 * semantic rules the parser deliberately does not check:
 *
 *   - every reference string (`map.over` / `route.input` / `inputs[]`) parses
 *     against the CLOSED two-root grammar (`program/expressions.ts`);
 *   - `steps.<id>` references name an EARLIER step (a producer that has
 *     already run when the reference resolves);
 *   - `inputs:` entries must reference a STEP OUTPUT, never `params.*` — params
 *     are already attached to every unit unconditionally, so naming one as a
 *     declared input would be redundant.
 *
 * Node-id convention (stable, unique within a plan):
 *   step root  → `<stepId>`          (unit) or `<stepId>.map` (map)
 *   map unit   → `<stepId>.unit`     (template instantiated per item)
 *   gate       → `<stepId>.gate`
 *
 * Returns accumulated `WorkflowError`s rather than throwing. Pure and
 * deterministic: the same document always compiles to the same plan.
 */

import { formatReference, parseReference } from "../program/expressions";
import type { ProgramDefaults, ProgramUnit } from "../program/schema";
import type { WorkflowDocument, WorkflowError } from "../schema";
import type { IrIsolation, IrMapReducer, IrOnError, IrRetry, IrRouteSpec } from "./schema";

export interface WorkflowUnitDraft {
  kind: "unit";
  id: string;
  instructions: string;
  templating: "verbatim";
  /** Prior-step artifacts this unit consumes, as reference strings (compile-time validated). */
  inputs?: string[];
  schema?: Record<string, unknown>;
  retry?: IrRetry;
  onError: IrOnError;
  env?: string[];
  isolation?: IrIsolation;
  source?: import("../schema").SourceRef;
}

export interface WorkflowMapDraft {
  kind: "map";
  id: string;
  over: string;
  template: WorkflowUnitDraft;
  concurrency?: number;
  reducer: IrMapReducer;
  source?: import("../schema").SourceRef;
}

export interface WorkflowGateDraft {
  kind: "gate";
  id: string;
  stepId: string;
  criteria: string[];
  maxLoops?: number;
}

export interface WorkflowStepDraft {
  stepId: string;
  /** Always the step id — the unified format has no titles anywhere (a step IS its id). */
  title: string;
  sequenceIndex: number;
  root?: WorkflowUnitDraft | WorkflowMapDraft;
  route?: IrRouteSpec;
  outputSchema?: Record<string, unknown>;
  gate: WorkflowGateDraft;
}

export interface WorkflowPlanDraft {
  /** Run-level display title. Derived from the asset's canonical name — never authored. */
  title: string;
  params?: string[];
  paramSchemas?: Record<string, Record<string, unknown>>;
  budget?: { maxTokens?: number; maxUnits?: number };
  steps: WorkflowStepDraft[];
}

export type WorkflowPlanCompileResult =
  | { ok: true; plan: WorkflowPlanDraft; warnings: WorkflowError[] }
  | { ok: false; errors: WorkflowError[] };

/**
 * Compile a parsed unified workflow document into a frozen-plan-ready graph.
 * `title` is the run-level display title (the asset's canonical name — the
 * format carries no authored title). Assumes the document came out of
 * `parseWorkflow` ok (structure already valid).
 */
export function compileWorkflowPlan(document: WorkflowDocument, title: string): WorkflowPlanCompileResult {
  const errors: WorkflowError[] = [];
  const allStepIds = new Set(document.steps.map((s) => s.id));
  const earlierStepIds = new Set<string>();
  const steps: WorkflowStepDraft[] = [];

  document.steps.forEach((step) => {
    const check = { allStepIds, earlierStepIds, errors };

    if (step.map) {
      checkReferenceField(step.map.over, { ...check, line: step.source.start, label: `Step "${step.id}" map.over` });
    }
    if (step.route) {
      checkReferenceField(step.route.input, {
        ...check,
        line: step.source.start,
        label: `Step "${step.id}" route.input`,
      });
    }
    for (const [index, reference] of (step.inputs ?? []).entries()) {
      checkInputReference(reference, index, {
        ...check,
        line: step.source.start,
        label: `Step "${step.id}" inputs`,
      });
    }

    steps.push(compileStep(step, defaultsOf(document)));
    earlierStepIds.add(step.id);
  });

  if (errors.length > 0) return { ok: false, errors };

  const paramNames = document.params ? Object.keys(document.params) : [];
  return {
    ok: true,
    warnings: collectWorkflowWarnings(document),
    plan: {
      title,
      ...(paramNames.length > 0 ? { params: paramNames } : {}),
      ...(document.params && paramNames.length > 0 ? { paramSchemas: document.params } : {}),
      ...(document.budget
        ? {
            budget: {
              ...(document.budget.maxTokens !== undefined ? { maxTokens: document.budget.maxTokens } : {}),
              ...(document.budget.maxUnits !== undefined ? { maxUnits: document.budget.maxUnits } : {}),
            },
          }
        : {}),
      steps,
    },
  };
}

function defaultsOf(document: WorkflowDocument): ProgramDefaults | undefined {
  return document.defaults;
}

function compileStep(
  step: WorkflowDocument["steps"][number],
  defaults: ProgramDefaults | undefined,
): WorkflowStepDraft {
  const gate: WorkflowGateDraft = {
    kind: "gate",
    id: `${step.id}.gate`,
    stepId: step.id,
    // The body `### gate` rubric is carried through as the ONE criterion string
    // — the judge receives the whole section byte-exact (spec §2.4). A step
    // with no rubric needs no verification (criteria: []).
    criteria: step.gateRubric?.text.trim() ? [step.gateRubric.text] : [],
    ...(step.gate?.maxLoops !== undefined ? { maxLoops: step.gate.maxLoops } : {}),
  };

  let root: WorkflowUnitDraft | WorkflowMapDraft | undefined;
  if (step.route === undefined) {
    const instructionsText = step.instructions?.text ?? "";
    if (step.map) {
      root = {
        kind: "map",
        id: `${step.id}.map`,
        over: step.map.over,
        template: compileUnit(step.map.unit, `${step.id}.unit`, instructionsText, defaults, step.inputs, step.source),
        ...(step.map.concurrency !== undefined ? { concurrency: step.map.concurrency } : {}),
        reducer: step.map.reducer ?? "collect",
        source: step.source,
      };
    } else {
      root = compileUnit(step.unit, step.id, instructionsText, defaults, step.inputs, step.instructions?.source);
    }
  }

  return {
    stepId: step.id,
    title: step.id,
    sequenceIndex: step.sequenceIndex,
    ...(root ? { root } : {}),
    ...(step.route
      ? {
          route: {
            input: step.route.input,
            when: Object.fromEntries(step.route.branches.map((b) => [b.match, b.stepId])),
            ...(step.route.defaultStepId !== undefined ? { defaultStepId: step.route.defaultStepId } : {}),
          },
        }
      : {}),
    ...(step.output !== undefined ? { outputSchema: step.output } : {}),
    gate,
  };
}

/**
 * Lower one source unit into the unresolved structural plan. Instructions are
 * ALWAYS the step's body prose, byte-exact — never templated, never scanned
 * for reference syntax. Engine/model/timeout settings remain on the parsed
 * override bag until the single freeze boundary.
 */
function compileUnit(
  unit: ProgramUnit | undefined,
  id: string,
  instructions: string,
  defaults: ProgramDefaults | undefined,
  inputs: string[] | undefined,
  source: import("../schema").SourceRef | undefined,
): WorkflowUnitDraft {
  return {
    kind: "unit",
    id,
    instructions,
    templating: "verbatim",
    ...(inputs && inputs.length > 0 ? { inputs: [...inputs] } : {}),
    ...(unit?.output !== undefined ? { schema: unit.output } : {}),
    ...(unit?.retry ? { retry: { max: unit.retry.max, on: [...unit.retry.on] } } : {}),
    onError: unit?.onError ?? defaults?.onError ?? "fail",
    ...(unit?.env ? { env: [...unit.env] } : {}),
    ...(unit?.isolation !== undefined ? { isolation: unit.isolation } : {}),
    ...(source ? { source } : {}),
  };
}

// ── Reference validation ─────────────────────────────────────────────────────

interface ReferenceCheck {
  errors: WorkflowError[];
  /** Every step id in the document (to tell "later step" from "no such step"). */
  allStepIds: Set<string>;
  /** Ids of steps declared BEFORE the one being checked. */
  earlierStepIds: Set<string>;
  line: number;
  label: string;
}

/** Validate a whole-value reference field (`map.over`, `route.input`). */
function checkReferenceField(text: string, check: ReferenceCheck): void {
  const parsed = parseReference(text);
  if (!parsed.ok) {
    check.errors.push({ line: check.line, message: `${check.label}: ${parsed.message}` });
    return;
  }
  if (parsed.expr.kind === "stepOutput" && !check.earlierStepIds.has(parsed.expr.stepId)) {
    const why = check.allStepIds.has(parsed.expr.stepId)
      ? `step "${parsed.expr.stepId}" does not come before this step — references must name an earlier step (a producer that has already run)`
      : `"${parsed.expr.stepId}" is not a step in this workflow`;
    check.errors.push({
      line: check.line,
      message: `${check.label}: "${formatReference(parsed.expr)}" cannot be resolved — ${why}.`,
    });
  }
}

/** Validate one `inputs[]` entry: must be a step-output reference to an earlier step. */
function checkInputReference(text: string, index: number, check: ReferenceCheck): void {
  const parsed = parseReference(text);
  if (!parsed.ok) {
    check.errors.push({ line: check.line, message: `${check.label}[${index}]: ${parsed.message}` });
    return;
  }
  if (parsed.expr.kind === "param") {
    check.errors.push({
      line: check.line,
      message:
        `${check.label}[${index}]: "${formatReference(parsed.expr)}" names a param, not a step output — ` +
        `params are already attached to every unit, so declaring one as an input is redundant. "inputs:" only ` +
        `names step outputs (steps.<id>.output...).`,
    });
    return;
  }
  if (!check.earlierStepIds.has(parsed.expr.stepId)) {
    const why = check.allStepIds.has(parsed.expr.stepId)
      ? `step "${parsed.expr.stepId}" does not come before this step — references must name an earlier step (a producer that has already run)`
      : `"${parsed.expr.stepId}" is not a step in this workflow`;
    check.errors.push({
      line: check.line,
      message: `${check.label}[${index}]: "${formatReference(parsed.expr)}" cannot be resolved — ${why}.`,
    });
  }
}

// ── Non-fatal warnings ───────────────────────────────────────────────────────

/**
 * Collect the document's non-fatal WARNINGS — advisories that never fail
 * compilation, never change the frozen plan or its hash, and are surfaced as
 * `workflow-warning` entries in `akm lint`'s separate `warnings` channel
 * (human + JSON output, via `core/adapter/adapters/akm-lint.ts#
 * workflowCompileWarnings`) and as `warn()` lines at `workflow run`.
 *
 *   A. A unit/map step with NO step-level `output:` schema carries its units'
 *      raw results as an untyped artifact — permitted, but worth flagging.
 *   B. A `params.<name>` reference (in `map.over`/`route.input`) to an
 *      UNDECLARED param, but ONLY when the document declares a `params:`
 *      block — a likely typo. Prose can no longer carry param references at
 *      all (it is never scanned), so this warning's surface shrinks to the
 *      two whole-value fields that can legally contain one.
 */
export function collectWorkflowWarnings(document: WorkflowDocument): WorkflowError[] {
  const warnings: WorkflowError[] = [];
  const declaredParams = document.params ? new Set(Object.keys(document.params)) : undefined;

  for (const step of document.steps) {
    if ((step.map || step.route === undefined) && step.output === undefined) {
      warnings.push({
        line: step.source.start,
        message:
          `Step "${step.id}" declares no \`output:\` schema — its unit results are carried as an untyped ` +
          `artifact (permitted). Add an \`output:\` JSON Schema to type and validate the step artifact.`,
      });
    }

    if (declaredParams) {
      const declaredList = [...declaredParams].join(", ");
      const scan = (text: string | undefined, label: string): void => {
        if (!text) return;
        const parsed = parseReference(text);
        if (!parsed.ok || parsed.expr.kind !== "param" || declaredParams.has(parsed.expr.name)) return;
        warnings.push({
          line: step.source.start,
          message:
            `${label}: "${formatReference(parsed.expr)}" references a param not declared in \`params:\` ` +
            `(declared: ${declaredList || "none"}) — likely a typo. An undeclared param supplied at start still ` +
            `resolves at run time.`,
        });
      };
      if (step.map) scan(step.map.over, `Step "${step.id}" map.over`);
      if (step.route) scan(step.route.input, `Step "${step.id}" route.input`);
    }
  }

  return warnings;
}
