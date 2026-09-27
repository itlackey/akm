// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The workflow compiler's front door. `.md` goes through the Markdown grammar
 * (`parser.ts`), `.yml` through the GitHub-shaped YAML grammar
 * (`github-yaml.ts`); both produce a {@link WorkflowPlan} directly.
 *
 * {@link checkWorkflowPlan} is the one cross-step pass the grammars do not
 * run: every `steps.<id>` reference must name an earlier step (outputs may
 * name any step), `inputs:` never name a param, and two non-fatal advisories.
 */

import path from "node:path";
import { parseBuiltinCommandAction } from "../commands/command/builtin-action";
import { PORTABLE_ARGUMENTS_PLACEHOLDER } from "../commands/command/portable-template";
import { parseGithubWorkflowSource, WorkflowSourceFailure } from "./github-yaml";
import { parseWorkflow } from "./parser";
import type { WorkflowError, WorkflowPlan, WorkflowPlanStep } from "./plan";
import { formatReference, parseReference } from "./program/expressions";
import { canonicalizeWorkflowWorkingDirectory, WorkflowSourceSemanticError } from "./source-semantics";

export { looksLikeGithubWorkflowSource } from "./github-yaml";

export interface WorkflowSourceError {
  code: string;
  message: string;
  path: string;
  /** 1-indexed source line. */
  line: number;
}

export type WorkflowCompileResult = { ok: true; plan: WorkflowPlan } | { ok: false; errors: WorkflowSourceError[] };

export interface CompileWorkflowSourceOptions {
  path: string;
  /** Verifies `cwd:`/`working-directory:` physically stay inside this root when given. */
  workspaceRoot?: string;
  /** Plan title; defaults to the file's basename. */
  title?: string;
}

/** Compile by authoritative source extension. */
export function compileWorkflowSource(source: string, options: CompileWorkflowSourceOptions): WorkflowCompileResult {
  const extension = path.extname(options.path).toLowerCase();
  const title = options.title ?? path.basename(options.path, path.extname(options.path));
  if (extension === ".yml") {
    try {
      return { ok: true, plan: parseGithubWorkflowSource(source, { ...options, title }) };
    } catch (cause) {
      if (cause instanceof WorkflowSourceFailure) return { ok: false, errors: [cause.error] };
      const message = cause instanceof Error ? cause.message : String(cause);
      return { ok: false, errors: [{ code: "invalid-workflow-source", message, path: options.path, line: 1 }] };
    }
  }
  if (extension !== ".md") {
    return {
      ok: false,
      errors: [
        {
          code: "unsupported-workflow-extension",
          message: `Workflow source ${options.path} must use .md or .yml.`,
          path: options.path,
          line: 1,
        },
      ],
    };
  }
  const parsed = parseWorkflow(source, {
    path: options.path,
    title,
    validateExecCwd: (value) => {
      try {
        return { ok: true, value: canonicalizeWorkflowWorkingDirectory(value, options.workspaceRoot) };
      } catch (cause) {
        if (cause instanceof WorkflowSourceSemanticError)
          return { ok: false, code: cause.code, message: cause.message };
        return { ok: false, code: "working-directory-unverifiable", message: "cwd cannot be physically verified." };
      }
    },
  });
  if (parsed.ok) return parsed;
  return {
    ok: false,
    errors: parsed.errors.map((error) => ({
      code: error.code ?? "invalid-markdown-workflow",
      message: error.message,
      path: options.path,
      line: error.line,
    })),
  };
}

/**
 * The display text a step contributes to `show`, search hints, and the run
 * spine: its authored prose, else what its target does. Empty for a route
 * step with no section.
 */
export function workflowStepInstructions(step: WorkflowPlanStep): string {
  const spec = step.spec;
  if (!spec) return "";
  if (spec.instructions !== undefined) return spec.instructions;
  if (spec.uses === "akm/command") {
    const action = parseBuiltinCommandAction(spec.with);
    if (action.kind === "stored") {
      return `Invoke stored command ${action.ref}${action.arguments === undefined ? "" : " with arguments"}.`;
    }
    if (spec.commandMode === "literal") return action.content;
    return action.content.split(PORTABLE_ARGUMENTS_PLACEHOLDER).join(action.arguments ?? "");
  }
  if (spec.uses !== undefined) return `Invoke local target ${spec.uses}.`;
  return "";
}

/** A route step's deterministic one-line description of its branch table. */
export function routeDescription(route: NonNullable<WorkflowPlanStep["route"]>): string {
  const branches = Object.entries(route.when).map(([match, stepId]) => `"${match}" -> ${stepId}`);
  if (route.defaultStepId !== undefined) branches.push(`default -> ${route.defaultStepId}`);
  return `Route on ${route.input}: ${branches.join(", ")}.`;
}

export type WorkflowPlanCheck = { ok: true; warnings: WorkflowError[] } | { ok: false; errors: WorkflowError[] };

/** Cross-step reference validation plus the non-fatal advisories. Pure. */
export function checkWorkflowPlan(plan: WorkflowPlan): WorkflowPlanCheck {
  const errors: WorkflowError[] = [];
  const allStepIds = new Set(plan.steps.map((step) => step.stepId));
  const earlierStepIds = new Set<string>();

  const check = (text: string, line: number, label: string, paramsAllowed: boolean): void => {
    const parsed = parseReference(text);
    if (!parsed.ok) {
      errors.push({ line, message: `${label}: ${parsed.message}` });
      return;
    }
    if (parsed.expr.kind === "param") {
      if (paramsAllowed) return;
      errors.push({
        line,
        message:
          `${label}: "${formatReference(parsed.expr)}" names a param, not a step output — params are already ` +
          `attached to every unit, so declaring one as an input is redundant. "inputs:" only names step outputs ` +
          `(steps.<id>.output...).`,
      });
      return;
    }
    if (earlierStepIds.has(parsed.expr.stepId)) return;
    const why = allStepIds.has(parsed.expr.stepId)
      ? `step "${parsed.expr.stepId}" does not come before this step — references must name an earlier step (a producer that has already run)`
      : `"${parsed.expr.stepId}" is not a step in this workflow`;
    errors.push({ line, message: `${label}: "${formatReference(parsed.expr)}" cannot be resolved — ${why}.` });
  };

  for (const step of plan.steps) {
    const line = step.spec?.source.start ?? 1;
    if (step.spec?.map) check(step.spec.map.over, line, `Step "${step.stepId}" map.over`, true);
    if (step.route) check(step.route.input, line, `Step "${step.stepId}" route.input`, true);
    for (const [index, reference] of (step.spec?.inputs ?? []).entries()) {
      check(reference, line, `Step "${step.stepId}" inputs[${index}]`, false);
    }
    earlierStepIds.add(step.stepId);
  }

  // Outputs resolve at run completion, so they may name any declared step.
  for (const [name, declaration] of Object.entries(plan.outputs ?? {})) {
    const parsed = parseReference(declaration.from);
    const label = `Output "${name}" from`;
    if (!parsed.ok) errors.push({ line: 1, message: `${label}: ${parsed.message}` });
    else if (parsed.expr.kind === "param") {
      errors.push({
        line: 1,
        message:
          `${label}: "${formatReference(parsed.expr)}" names a param, not a step output — an output projects a ` +
          `STEP artifact, never a param. "outputs:" only names step outputs (steps.<id>.output...).`,
      });
    } else if (!allStepIds.has(parsed.expr.stepId)) {
      errors.push({
        line: 1,
        message: `${label}: "${formatReference(parsed.expr)}" cannot be resolved — "${parsed.expr.stepId}" is not a step in this workflow.`,
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, warnings: workflowWarnings(plan) };
}

/**
 * Advisories that never fail compilation or change the plan:
 *   A. a `params.<name>` reference (in `map.over`/`route.input`) to a param the
 *      document's `params:` block does not declare — a likely typo;
 *   B. `gate.max_loops` above 1 on an exec step, which is judged but never
 *      looped (a frozen argv cannot read the judge's feedback).
 */
function workflowWarnings(plan: WorkflowPlan): WorkflowError[] {
  const warnings: WorkflowError[] = [];
  const declared = plan.paramSchemas ? new Set(Object.keys(plan.paramSchemas)) : undefined;
  for (const step of plan.steps) {
    const line = step.spec?.source.start ?? 1;
    const maxLoops = step.gate.maxLoops;
    if (maxLoops > 1 && step.spec?.exec && step.gate.criteria.length > 0) {
      warnings.push({
        line,
        message:
          `Step "${step.stepId}" declares \`gate.max_loops: ${maxLoops}\` on an \`exec\` step — it runs its command ` +
          `ONCE. A gate loop re-executes the step so it can address the judge's feedback, and a frozen argv cannot ` +
          `read that feedback; looping would only repeat the command's side effects. The gate still evaluates and ` +
          `can still fail the step.`,
      });
    }
    if (!declared) continue;
    const scan = (text: string | undefined, label: string): void => {
      if (!text) return;
      const parsed = parseReference(text);
      if (!parsed.ok || parsed.expr.kind !== "param" || declared.has(parsed.expr.name)) return;
      warnings.push({
        line,
        message:
          `${label}: "${formatReference(parsed.expr)}" references a param not declared in \`params:\` ` +
          `(declared: ${[...declared].join(", ") || "none"}) — likely a typo. An undeclared param supplied at start ` +
          `still resolves at run time.`,
      });
    };
    scan(step.spec?.map?.over, `Step "${step.stepId}" map.over`);
    scan(step.route?.input, `Step "${step.stepId}" route.input`);
  }
  return warnings;
}
