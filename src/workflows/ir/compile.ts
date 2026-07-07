// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Frontends → Workflow Plan Graph (IR v2) compilers.
 *
 * Two frontends, one IR (redesign addendum, R1):
 *
 *   - {@link compileWorkflowProgram} — YAML orchestration programs
 *     (`program/parser.ts`). Pure and deterministic; performs FULL expression
 *     validation (closed `${{ … }}` grammar, earlier-step references,
 *     whole-value contexts, `item`/`item_index` scoping) and MERGES the
 *     program's `defaults` block into every unit node so the frozen plan is
 *     self-contained. Returns accumulated `WorkflowError`s rather than
 *     throwing.
 *   - {@link compileWorkflowPlan} — classic LINEAR markdown workflows
 *     (`parser.ts`), the stable CLI contract: one `agent` node per step with
 *     `runner: inherit` and the fail-fast default, exactly as today. The P1
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
import {
  type IrAgentNode,
  type IrExecNode,
  type IrGateNode,
  type IrStepPlan,
  WORKFLOW_IR_VERSION,
  type WorkflowPlanGraph,
} from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Frontend A — YAML workflow program
// ─────────────────────────────────────────────────────────────────────────────

export type WorkflowProgramCompileResult =
  | { ok: true; plan: WorkflowPlanGraph }
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
  const steps: IrStepPlan[] = [];

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
    plan: {
      irVersion: WORKFLOW_IR_VERSION,
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

function compileProgramStep(step: ProgramStep, index: number, defaults: ProgramDefaults | undefined): IrStepPlan {
  const gate: IrGateNode = {
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

  let root: IrExecNode | undefined;
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
 * Lower one program unit into an agent node, merging the run-level `defaults`
 * block (frozen resolution — addendum: "the plan is self-contained"). Per-unit
 * declarations always win; the fail-fast `on_error` default applies last.
 */
function compileProgramUnit(unit: ProgramUnit, id: string, defaults: ProgramDefaults | undefined): IrAgentNode {
  const model = unit.model ?? defaults?.model;
  const timeoutMs = unit.timeoutMs !== undefined ? unit.timeoutMs : defaults?.timeoutMs;
  return {
    kind: "agent",
    id,
    instructions: unit.instructions,
    // YAML program instructions are `${{ … }}` templates (validated above);
    // the executor resolves them per unit.
    templating: "expressions",
    runner: unit.runner ?? defaults?.runner ?? "inherit",
    ...(unit.profile !== undefined ? { profile: unit.profile } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(unit.output !== undefined ? { schema: unit.output } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
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
    case "param":
      // Param presence is a run-scope concern (params may be supplied at
      // start time beyond the declared block); resolution errors surface at
      // execution with the reference named.
      return;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Frontend B — classic markdown workflow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compile a markdown `WorkflowDocument` to IR v2. Pure and deterministic: the
 * same document always compiles to the same plan. Linear workflows — the
 * stable contract — produce one `agent` node per step (`runner: inherit`,
 * fail-fast) guarded by its gate, identical behavior to today's step loop.
 */
export function compileWorkflowPlan(document: WorkflowDocument): WorkflowPlanGraph {
  const params = document.parameters?.map((p) => p.name);
  return {
    irVersion: WORKFLOW_IR_VERSION,
    title: document.title,
    ...(params && params.length > 0 ? { params } : {}),
    steps: document.steps.map(compileMarkdownStep),
  };
}

function compileMarkdownStep(step: WorkflowStep): IrStepPlan {
  const gate: IrGateNode = {
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
      kind: "agent",
      id: step.id,
      instructions: step.instructions.text,
      // Stable contract: markdown instructions are opaque data, passed to the
      // agent byte-exact. A literal `${{ … }}` (GitHub Actions syntax, docs of
      // the YAML format) is content here, never expression grammar.
      templating: "verbatim",
      runner: "inherit",
      // Markdown has no failure-policy surface; the fail-fast default applies.
      onError: "fail",
      source: step.instructions.source,
    },
    gate,
  };
}
