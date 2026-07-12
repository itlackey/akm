// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Frontends -> unresolved workflow plan compilers.
 *
 * Two frontends, one source-plan shape. Engine resolution in `freeze.ts`
 * lowers this shape into the only executable format, workflow IR v3.
 *
 *   - {@link compileWorkflowProgram} — YAML orchestration programs
 *     (`program/parser.ts`). Pure and deterministic; performs FULL expression
 *     validation (closed `${{ … }}` grammar, earlier-step references,
 *     whole-value contexts, `item`/`item_index` scoping) and MERGES the
 *     Returns accumulated `WorkflowError`s rather than throwing.
 *   - {@link compileWorkflowPlan} — classic LINEAR markdown workflows
 *     (`parser.ts`), the stable CLI contract: one unit node per step with the
 *     fail-fast default. The P1
 *     markdown orchestration grammar is gone — this path is linear-only.
 *
 * Node-id convention (stable, unique within a plan):
 *   step root  → `<stepId>`          (agent) or `<stepId>.map` (map)
 *   map unit   → `<stepId>.unit`     (template instantiated per item)
 *   gate       → `<stepId>.gate`
 */

import { type ExpressionAst, formatReference, listReferences, parseTemplate } from "../program/expressions";
import type { ProgramDefaults, ProgramStep, ProgramUnit, WorkflowProgram } from "../program/schema";
import type { WorkflowDocument, WorkflowError, WorkflowStep } from "../schema";
import type { IrIsolation, IrMapReducer, IrOnError, IrRetry, IrRouteSpec } from "./schema";

export interface WorkflowUnitDraft {
  kind: "unit";
  id: string;
  instructions: string;
  templating: "expressions" | "verbatim";
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
  required?: boolean;
}

export interface WorkflowStepDraft {
  stepId: string;
  title: string;
  sequenceIndex: number;
  root?: WorkflowUnitDraft | WorkflowMapDraft;
  route?: IrRouteSpec;
  outputSchema?: Record<string, unknown>;
  gate: WorkflowGateDraft;
}

export interface WorkflowPlanDraft {
  title: string;
  params?: string[];
  paramSchemas?: Record<string, Record<string, unknown>>;
  budget?: { maxTokens?: number; maxUnits?: number };
  steps: WorkflowStepDraft[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Frontend A — YAML workflow program
// ─────────────────────────────────────────────────────────────────────────────

export type WorkflowProgramCompileResult =
  | { ok: true; plan: WorkflowPlanDraft; warnings: WorkflowError[] }
  | { ok: false; errors: WorkflowError[] };

/**
 * Compile a parsed YAML program into a frozen-plan-ready graph. Assumes the
 * program came out of `parseWorkflowProgram` ok (structure already valid);
 * this pass owns the expression-language rules the parser deliberately does
 * not check:
 *
 *   - every `${{ … }}` in instructions / `map.over` / `route.input` parses
 *     against the CLOSED grammar;
 *   - `steps.<id>` references name an EARLIER step (a producer that has
 *     already run when the reference resolves);
 *   - `map.over` and `route.input` are single whole-value references — a bare
 *     `${{ … }}` with no surrounding text;
 *   - `item` / `item_index` appear only inside a map unit's instructions.
 */
export function compileWorkflowProgram(program: WorkflowProgram): WorkflowProgramCompileResult {
  const errors: WorkflowError[] = [];
  const allStepIds = new Set(program.steps.map((s) => s.id));
  const earlierStepIds = new Set<string>();
  const steps: WorkflowStepDraft[] = [];

  program.steps.forEach((step, index) => {
    const check = { allStepIds, earlierStepIds, errors };

    if (step.unit) {
      checkTemplateExpressions(step.unit.instructions, {
        ...check,
        line: step.unit.source.start,
        label: `Step "${step.id}" instructions`,
        inMapUnit: false,
      });
    }
    if (step.map) {
      checkWholeValueExpression(step.map.over, {
        ...check,
        line: step.source.start,
        label: `Step "${step.id}" map.over`,
      });
      checkTemplateExpressions(step.map.unit.instructions, {
        ...check,
        line: step.map.unit.source.start,
        label: `Step "${step.id}" instructions`,
        inMapUnit: true,
      });
    }
    if (step.route) {
      checkWholeValueExpression(step.route.input, {
        ...check,
        line: step.source.start,
        label: `Step "${step.id}" route.input`,
      });
    }

    steps.push(compileProgramStep(step, index, program.defaults));
    earlierStepIds.add(step.id);
  });

  if (errors.length > 0) return { ok: false, errors };

  const paramNames = program.params ? Object.keys(program.params) : [];
  return {
    ok: true,
    // Non-fatal advisories (redesign addendum). Warnings NEVER change the plan
    // or its hash — they are computed alongside the frozen plan and surfaced by
    // `workflow validate` / `workflow start`, never persisted onto the run row.
    warnings: collectProgramWarnings(program),
    plan: {
      title: program.name,
      ...(paramNames.length > 0 ? { params: paramNames } : {}),
      // Reviewer #12: freeze the per-param schemas into the plan so `--params`
      // can be validated at start and re-asserted at brief/report against the
      // exact schemas the run was created with (the plan hash covers them).
      ...(program.params && paramNames.length > 0 ? { paramSchemas: program.params } : {}),
      // Budget ceilings (addendum R2): frozen onto the plan so enforcement is
      // a pure function of (frozen plan, journal) — never the live asset.
      ...(program.budget
        ? {
            budget: {
              ...(program.budget.maxTokens !== undefined ? { maxTokens: program.budget.maxTokens } : {}),
              ...(program.budget.maxUnits !== undefined ? { maxUnits: program.budget.maxUnits } : {}),
            },
          }
        : {}),
      steps,
    },
  };
}

function compileProgramStep(
  step: ProgramStep,
  index: number,
  defaults: ProgramDefaults | undefined,
): WorkflowStepDraft {
  const gate: WorkflowGateDraft = {
    kind: "gate",
    id: `${step.id}.gate`,
    stepId: step.id,
    criteria: step.gate?.criteria ?? [],
    // TODO(R2): maxLoops execution (bounded evaluator-optimizer) is engine
    // rework scope; carried through the frozen plan now.
    ...(step.gate?.maxLoops !== undefined ? { maxLoops: step.gate.maxLoops } : {}),
    // Reviewer #18: a required gate rides the frozen plan so BOTH surfaces
    // (engine + report) enforce it identically.
    ...(step.gate?.required !== undefined ? { required: step.gate.required } : {}),
  };

  let root: WorkflowUnitDraft | WorkflowMapDraft | undefined;
  if (step.unit) {
    root = compileProgramUnit(step.unit, step.id, defaults);
  } else if (step.map) {
    root = {
      kind: "map",
      id: `${step.id}.map`,
      over: step.map.over,
      template: compileProgramUnit(step.map.unit, `${step.id}.unit`, defaults),
      ...(step.map.concurrency !== undefined ? { concurrency: step.map.concurrency } : {}),
      reducer: step.map.reducer ?? "collect",
      source: step.source,
    };
  }

  return {
    stepId: step.id,
    title: step.title ?? step.id,
    sequenceIndex: index,
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
    // TODO(R2): validating the reducer result against this schema (typed step
    // artifacts) is engine-rework scope; the frozen plan carries it now.
    ...(step.output !== undefined ? { outputSchema: step.output } : {}),
    gate,
  };
}

/**
 * Lower one source unit into the unresolved structural plan. Engine/model/time
 * settings remain on the parsed source until the single freeze boundary.
 */
function compileProgramUnit(unit: ProgramUnit, id: string, defaults: ProgramDefaults | undefined): WorkflowUnitDraft {
  return {
    kind: "unit",
    id,
    instructions: unit.instructions,
    // YAML program instructions are `${{ … }}` templates (validated above);
    // the executor resolves them per unit.
    templating: "expressions",
    ...(unit.output !== undefined ? { schema: unit.output } : {}),
    // TODO(R2): retry dispatch is engine-rework scope; carried through now.
    ...(unit.retry ? { retry: { max: unit.retry.max, on: [...unit.retry.on] } } : {}),
    onError: unit.onError ?? defaults?.onError ?? "fail",
    ...(unit.env ? { env: [...unit.env] } : {}),
    ...(unit.isolation !== undefined ? { isolation: unit.isolation } : {}),
    source: unit.source,
  };
}

// ── Expression validation ────────────────────────────────────────────────────

interface ExpressionCheck {
  errors: WorkflowError[];
  /** Every step id in the program (to tell "later step" from "no such step"). */
  allStepIds: Set<string>;
  /** Ids of steps declared BEFORE the one being checked. */
  earlierStepIds: Set<string>;
  line: number;
  label: string;
}

/** Validate every `${{ … }}` in a free-text template (instructions). */
function checkTemplateExpressions(text: string, check: ExpressionCheck & { inMapUnit: boolean }): void {
  const parsed = parseTemplate(text);
  if (!parsed.ok) {
    for (const err of parsed.errors) {
      check.errors.push({ line: check.line, message: `${check.label}: ${err.message}` });
    }
    return;
  }
  for (const ref of listReferences(parsed.segments)) {
    checkReference(ref, check, check.inMapUnit);
  }
}

/**
 * Validate a whole-value field (`map.over`, `route.input`): the text must be
 * exactly one `${{ … }}` reference with no surrounding literal text, so the
 * engine can resolve it to a RAW value (array/object), never a string splice.
 */
function checkWholeValueExpression(text: string, check: ExpressionCheck): void {
  const parsed = parseTemplate(text);
  if (!parsed.ok) {
    for (const err of parsed.errors) {
      check.errors.push({ line: check.line, message: `${check.label}: ${err.message}` });
    }
    return;
  }
  const [first] = parsed.segments;
  if (parsed.segments.length !== 1 || first?.kind !== "reference") {
    check.errors.push({
      line: check.line,
      message:
        `${check.label} must be a single whole-value \${{ … }} reference with no surrounding text ` +
        `(e.g. "\${{ steps.discover.output.files }}"), got ${JSON.stringify(text)}.`,
    });
    return;
  }
  // `item`/`item_index` never exist where a whole-value field resolves (the
  // item list itself, or a spine route input), so inMapUnit is always false.
  checkReference(first.expr, check, false);
}

function checkReference(ref: ExpressionAst, check: ExpressionCheck, inMapUnit: boolean): void {
  switch (ref.kind) {
    case "item":
    case "itemIndex": {
      if (!inMapUnit) {
        check.errors.push({
          line: check.line,
          message: `${check.label}: "\${{ ${formatReference(ref)} }}" is only valid inside a map unit's instructions.`,
        });
      }
      return;
    }
    case "stepOutput": {
      if (!check.earlierStepIds.has(ref.stepId)) {
        const why = check.allStepIds.has(ref.stepId)
          ? `step "${ref.stepId}" does not come before this step — references must name an earlier step (a producer that has already run)`
          : `"${ref.stepId}" is not a step in this workflow`;
        check.errors.push({
          line: check.line,
          message: `${check.label}: "\${{ ${formatReference(ref)} }}" cannot be resolved — ${why}.`,
        });
      }
      return;
    }
    case "param": {
      // Param presence is a RUN-SCOPE concern, never a compile-time one. A
      // declared `params:` block is NOT a closed set of legal references: the
      // runtime resolves any param SUPPLIED at start (`resolveReference`), and
      // `validateWorkflowParams` documents that undeclared params are permitted
      // — so `${{ params.mode }}` with `mode` passed via `--params` runs fine
      // even when only `files` is declared. At compile time an undeclared
      // reference is indistinguishable from that legitimate start-supplied
      // extra, so treating the block as closed would reject a runtime-supported
      // authoring pattern and put the two layers in disagreement. A genuine typo
      // (`params.changed_file` for `changed_files`) surfaces at run time with a
      // precise "is not defined in the run's params" error instead. As a lint-time
      // heads-up short of rejection, `collectProgramWarnings` (below) emits a
      // non-fatal WARNING for an undeclared reference when a `params:` block is
      // declared — never an error, so the runtime-supported pattern still compiles.
      return;
    }
  }
}

// ── Non-fatal warnings ───────────────────────────────────────────────────────

/**
 * Collect the program's non-fatal WARNINGS — advisories that never fail
 * compilation, never change the frozen plan or its hash, and are surfaced by
 * `workflow validate` (human + JSON) and as `warn()` lines at `workflow start`.
 *
 * Two promised-but-previously-missing warnings (redesign addendum):
 *
 *   A. A unit/map step with NO step-level `output:` schema carries its units'
 *      raw results as an untyped artifact — permitted, but the addendum says
 *      "the validator warns". Anchored on the STEP's `output` (the reducer /
 *      step-artifact schema); a per-unit `output:` types the unit result but
 *      leaves the step artifact untyped.
 *   B. A `${{ params.<name> }}` reference to an UNDECLARED param, but ONLY when
 *      the program declares a `params:` block. Compile-time REJECTION was tried
 *      and reverted (see the `case "param"` note above): the runtime legitimately
 *      resolves any param supplied at start, declared or not. The agreed middle
 *      ground is a warning — a likely typo (`changed_file` for `changed_files`)
 *      surfaces at lint time, while a genuinely start-supplied extra still runs.
 *      With no `params:` block there is nothing to compare against, so B is silent.
 *
 * Pure and deterministic; the returned order is document order per step
 * (warning A, then each undeclared-param reference in field/document order).
 * Only called on an OK compile, so every template here already parsed cleanly.
 */
export function collectProgramWarnings(program: WorkflowProgram): WorkflowError[] {
  const warnings: WorkflowError[] = [];
  const declaredParams = program.params ? new Set(Object.keys(program.params)) : undefined;

  for (const step of program.steps) {
    // Warning A — a unit/map step with no step-level output schema.
    if ((step.unit || step.map) && step.output === undefined) {
      warnings.push({
        line: step.source.start,
        message:
          `Step "${step.id}" declares no \`output:\` schema — its unit results are carried as an untyped ` +
          `artifact (permitted). Add an \`output:\` JSON Schema to type and validate the step artifact.`,
      });
    }

    // Warning B — references to a param the declared `params:` block omits.
    if (declaredParams) collectUndeclaredParamWarnings(step, declaredParams, warnings);
  }

  return warnings;
}

/**
 * Push a warning for every `${{ params.<name> }}` reference in `step` whose
 * name is not in the declared param set. Walks the same template-bearing
 * fields the compiler validates (unit / map.over + map unit / route.input) so
 * the step + field context in the message matches the error labels.
 */
function collectUndeclaredParamWarnings(step: ProgramStep, declared: Set<string>, warnings: WorkflowError[]): void {
  const declaredList = [...declared].join(", ");
  const scan = (text: string, line: number, label: string): void => {
    const parsed = parseTemplate(text);
    if (!parsed.ok) return; // OK compile guarantees this parses; defensive only.
    for (const ref of listReferences(parsed.segments)) {
      if (ref.kind !== "param" || declared.has(ref.name)) continue;
      warnings.push({
        line,
        message:
          `${label}: "\${{ ${formatReference(ref)} }}" references a param not declared in \`params:\` ` +
          `(declared: ${declaredList || "none"}) — likely a typo. An undeclared param supplied at start still ` +
          `resolves at run time.`,
      });
    }
  };

  if (step.unit) scan(step.unit.instructions, step.unit.source.start, `Step "${step.id}" instructions`);
  if (step.map) {
    scan(step.map.over, step.source.start, `Step "${step.id}" map.over`);
    scan(step.map.unit.instructions, step.map.unit.source.start, `Step "${step.id}" instructions`);
  }
  if (step.route) scan(step.route.input, step.source.start, `Step "${step.id}" route.input`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Frontend B — classic markdown workflow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compile a markdown `WorkflowDocument` to an unresolved structural plan. Pure
 * and deterministic: the same document always compiles to the same plan.
 * Linear workflows produce one fail-fast unit per step guarded by its gate.
 */
export function compileWorkflowPlan(document: WorkflowDocument): WorkflowPlanDraft {
  const params = document.parameters?.map((p) => p.name);
  return {
    title: document.title,
    ...(params && params.length > 0 ? { params } : {}),
    steps: document.steps.map(compileMarkdownStep),
  };
}

function compileMarkdownStep(step: WorkflowStep): WorkflowStepDraft {
  const gate: WorkflowGateDraft = {
    kind: "gate",
    id: `${step.id}.gate`,
    stepId: step.id,
    criteria: step.completionCriteria?.map((c) => c.text) ?? [],
  };

  return {
    stepId: step.id,
    title: step.title,
    sequenceIndex: step.sequenceIndex,
    root: {
      kind: "unit",
      id: step.id,
      instructions: step.instructions.text,
      // Stable contract: markdown instructions are opaque data, passed to the
      // agent byte-exact. A literal `${{ … }}` (GitHub Actions syntax, docs of
      // the YAML format) is content here, never expression grammar.
      templating: "verbatim",
      // Markdown has no failure-policy surface; the fail-fast default applies.
      onError: "fail",
      source: step.instructions.source,
    },
    gate,
  };
}
