// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Plain-text renderers for `akm workflow *` commands.
 *
 * Split out of `helpers.ts` (formerly 1418 lines / 59 fns) as its own
 * sibling module: the workflow list/status/run/create/resume renderers form a
 * cohesive, self-contained cluster (they call only each other, never
 * formatters from other domains).
 */

export function formatWorkflowListPlain(result: Record<string, unknown>): string {
  const runs = Array.isArray(result.runs) ? (result.runs as Array<Record<string, unknown>>) : [];
  if (runs.length === 0) {
    return "No workflow runs in the current working scope. Start one with `akm workflow run workflows/<name>` or author one with `akm workflow create <name>`.";
  }

  return runs
    .map((run) => {
      const id = typeof run.id === "string" ? run.id : "unknown";
      // Fallback matches the `id`/`status` convention just below (plain
      // "unknown", not a `type:name`-shaped placeholder — that shape reads as
      // a ref in the dead colon grammar, which this fallback must not model).
      const ref = typeof run.workflowRef === "string" ? run.workflowRef : "unknown";
      const status = typeof run.status === "string" ? run.status : "unknown";
      const currentStep = typeof run.currentStepId === "string" ? ` (current: ${run.currentStepId})` : "";
      return `${id} ${ref} [${status}]${currentStep}`;
    })
    .join("\n");
}

/** §4.5's glyph table (P3b) — drawn from the repo's existing vocabulary (status-list.ts's ✗/✓, proposal-format.ts's →). */
const CHILD_STATUS_GLYPHS: Readonly<Record<string, string>> = {
  completed: "✓",
  active: "→",
  blocked: "⚠",
  failed: "✗",
};

/**
 * Render one `children:` tree node (P3b, spec §4.5) plus its own children,
 * recursively, indenting two spaces per level. Order is SPAWN order (the
 * envelope's own array order) — the tree is structural, never severity-sorted.
 */
function renderChildNode(child: Record<string, unknown>, depth: number, lines: string[]): void {
  const indent = "  ".repeat(depth + 1);
  const runId = typeof child.runId === "string" ? child.runId : "unknown";
  const ref = typeof child.workflowRef === "string" ? child.workflowRef : "unknown";
  const status = typeof child.status === "string" ? child.status : "unknown";
  const glyph = CHILD_STATUS_GLYPHS[status] ?? "?";
  const stepId = typeof child.stepId === "string" ? ` (step "${child.stepId}")` : "";
  lines.push(`${indent}- ${glyph} ${runId} ${ref} [${status}]${stepId}`);
  const resume =
    typeof child.resume === "object" && child.resume !== null ? (child.resume as Record<string, unknown>) : undefined;
  if (resume) {
    lines.push(`${indent}    resume: ${typeof resume.command === "string" ? resume.command : ""}`);
    lines.push(`${indent}    then:   ${typeof resume.then === "string" ? resume.then : ""}`);
  }
  const nested = Array.isArray(child.children) ? (child.children as Array<Record<string, unknown>>) : [];
  for (const grandchild of nested) renderChildNode(grandchild, depth + 1, lines);
}

export function formatWorkflowStatusPlain(result: Record<string, unknown>): string | null {
  const run =
    typeof result.run === "object" && result.run !== null ? (result.run as Record<string, unknown>) : undefined;
  const workflow =
    typeof result.workflow === "object" && result.workflow !== null
      ? (result.workflow as Record<string, unknown>)
      : undefined;
  if (!run || !workflow) return null;

  const lines = [
    `workflow: ${String(workflow.ref ?? "unknown")}`,
    `run: ${String(run.id ?? "unknown")}`,
    `title: ${String(run.workflowTitle ?? workflow.title ?? "Workflow")}`,
    `status: ${String(run.status ?? "unknown")}`,
  ];
  if (run.currentStepId) lines.push(`currentStep: ${String(run.currentStepId)}`);

  const steps = Array.isArray(workflow.steps) ? (workflow.steps as Array<Record<string, unknown>>) : [];
  if (steps.length > 0) {
    lines.push("steps:");
    for (const step of steps) {
      const title = typeof step.title === "string" ? step.title : "Untitled step";
      const id = typeof step.id === "string" ? step.id : "unknown";
      const status = typeof step.status === "string" ? step.status : "unknown";
      lines.push(`  - ${title} [${id}] (${status})`);
      if (typeof step.notes === "string" && step.notes.trim()) {
        lines.push(`    notes: ${step.notes}`);
      }
    }
  }

  // The parent-child status tree (P3b, spec §4.5): renders ONLY when
  // `children` is a non-empty array, immediately after `steps:` and before
  // `units:`. Absent for a childless run — byte-identical to pre-P3b text
  // (row B-33, PRESERVE).
  const children = Array.isArray(result.children) ? (result.children as Array<Record<string, unknown>>) : undefined;
  if (children && children.length > 0) {
    lines.push("children:");
    for (const child of children) renderChildNode(child, 0, lines);
  }

  // `workflow status --units` (#22): the honest per-unit diagnostic surface —
  // failure_reason plus any journaled result/error text. Diagnostics only; the
  // deterministic step evidence above is unaffected.
  const units = Array.isArray(result.units) ? (result.units as Array<Record<string, unknown>>) : undefined;
  if (units) {
    lines.push("");
    lines.push(units.length > 0 ? "units:" : "units: (none journaled)");
    for (const unit of units) {
      const id = typeof unit.unitId === "string" ? unit.unitId : "unknown";
      const status = typeof unit.status === "string" ? unit.status : "unknown";
      const node = typeof unit.nodeId === "string" ? unit.nodeId : "";
      const attempts = typeof unit.attempts === "number" ? unit.attempts : undefined;
      const suffix = attempts !== undefined && attempts > 1 ? `, attempt ${attempts}` : "";
      lines.push(`  - ${id} [${node}] (${status}${suffix})`);
      if (typeof unit.failureReason === "string" && unit.failureReason.trim()) {
        lines.push(`    failure_reason: ${unit.failureReason}`);
      }
      if (typeof unit.diagnostic === "string" && unit.diagnostic.trim()) {
        const diagLines = unit.diagnostic.split("\n");
        lines.push(`    diagnostic: ${diagLines[0]}`);
        for (const diagLine of diagLines.slice(1)) lines.push(`      ${diagLine}`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * One `! lowering[<severity>] <code> (<adapter>[; <field>]): <message>` line
 * from a `{code, severity, adapter, field?, message}` lowering notice, or
 * `null` when `value` does not carry that shape. Shared by
 * `formatWorkflowRunPlain` (dispatch-time notices) and `formatWorkflowPlanPlain`
 * (freeze-time notices, P3b §4.6, B-57) — ONE projection, rendered the same
 * way regardless of which invocation computed the notice.
 */
function renderLoweringNoticeLine(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const notice = value as Record<string, unknown>;
  if (
    typeof notice.code !== "string" ||
    typeof notice.severity !== "string" ||
    typeof notice.adapter !== "string" ||
    typeof notice.message !== "string"
  ) {
    return null;
  }
  const field = typeof notice.field === "string" && notice.field ? `; ${notice.field}` : "";
  return `! lowering[${notice.severity}] ${notice.code} (${notice.adapter}${field}): ${notice.message}`;
}

export function formatWorkflowRunPlain(result: Record<string, unknown>): string | null {
  const run =
    typeof result.run === "object" && result.run !== null ? (result.run as Record<string, unknown>) : undefined;
  if (!run) return null;

  const lines: string[] = [];
  // #919: `workflow run <ref>` silently resuming an existing active run (the
  // #485 concurrency guard) is now announced up front, with the escape hatch.
  if (result.resumed === true) {
    lines.push(
      `resuming existing run ${String(run.id ?? "unknown")} for ${String(run.workflowRef ?? "this ref")}; ` +
        `pass --new to start a fresh run`,
    );
  }
  lines.push(`run: ${String(run.id ?? "unknown")}`, `status: ${String(run.status ?? "unknown")}`);
  // Creation-time notices (e.g. the implicit engine fallback) must survive the
  // text renderer: JSON/YAML pass them through, and dropping them here would
  // hide the announcement from the DEFAULT output mode — where it matters most.
  for (const warning of Array.isArray(result.warnings) ? result.warnings : []) lines.push(`! ${String(warning)}`);
  // Live-only common-lowerer diagnostics are already sanitized and deduped by
  // the workflow engine. Render their typed headline (not opaque details) so
  // default text output has the same observability as JSON without widening a
  // durable workflow schema.
  for (const value of Array.isArray(result.notices) ? result.notices : []) {
    const line = renderLoweringNoticeLine(value);
    if (line) lines.push(line);
  }
  const executed = Array.isArray(result.executed) ? (result.executed as Array<Record<string, unknown>>) : [];
  if (executed.length === 0) {
    lines.push("executed: (no steps — run was already done or blocked)");
  } else {
    lines.push("executed:");
    for (const step of executed) {
      const marker = step.ok === true ? "ok" : "FAILED";
      lines.push(
        `  - ${String(step.stepId ?? "?")} [${marker}] units: ${String(step.unitCount ?? 0)}` +
          (Number(step.failedUnits ?? 0) > 0 ? ` (${String(step.failedUnits)} failed)` : ""),
      );
      if (typeof step.summary === "string" && step.summary.trim()) {
        lines.push(`    ${step.summary}`);
      }
    }
  }
  const gate =
    typeof result.gateRejection === "object" && result.gateRejection !== null
      ? (result.gateRejection as Record<string, unknown>)
      : undefined;
  if (gate) {
    lines.push(`gate rejected step ${String(gate.stepId ?? "?")}: ${String(gate.feedback ?? "")}`);
    const missing = Array.isArray(gate.missing) ? gate.missing : [];
    for (const item of missing) lines.push(`  missing: ${String(item)}`);
  }
  if (result.aborted === true) {
    lines.push(
      result.timedOut === true
        ? "workflow timed out; the run remains resumable."
        : "workflow interrupted; the run remains resumable.",
    );
  }
  if (result.done === true) lines.push("workflow completed.");
  return lines.join("\n");
}

export function formatWorkflowCreatePlain(r: Record<string, unknown>): string | null {
  // `workflow create --print`: no file is written, just the template text
  // (dropped `workflow template`'s output, moved onto this shape).
  if (typeof r.template === "string") return r.template;
  if (r.ref && r.path) {
    return `Created ${String(r.ref)} at ${String(r.path)}`;
  }
  return null;
}

export function formatWorkflowResumePlain(r: Record<string, unknown>): string {
  return formatWorkflowStatusPlain(r) ?? `Resumed workflow run ${String(r.id ?? r.runId ?? "?")}`;
}

/**
 * A step's `inputBindings[]` (P3b §4.6's `with:` line) — a literal shows its
 * value, a reference shows only its unresolved `from` (never a resolved
 * value; B-52/B-53's closed print list explicitly allows a literal *task/
 * child* input binding's `.value`, unlike a literal **environment** binding's).
 */
function formatInputBindingsList(bindings: readonly Record<string, unknown>[]): string {
  return bindings
    .map((binding) => {
      const name = String(binding.name ?? "");
      return binding.kind === "literal"
        ? `${name}=${JSON.stringify(binding.value)} (literal)`
        : `${name} <- ${String(binding.from ?? "")} (reference)`;
    })
    .join(", ");
}

/**
 * One `akm workflow plan` step line (P3b, spec §4.6), plus its child-workflow
 * expansion's own steps, recursively, indented one level per composition
 * boundary. A child step also carries the child's `planHash` on the step
 * line itself, and (when present) a `with:` line for the step's own
 * `inputBindings[]` and an `exports:` line for the child's declared output
 * names — §4.6's worked example.
 */
function renderPlanStepLines(step: Record<string, unknown>, ordinal: number, lines: string[], prefix = "  "): void {
  const stepId = typeof step.stepId === "string" ? step.stepId : "unknown";
  const targetKind = typeof step.targetKind === "string" ? `[${step.targetKind}]` : "";
  const expansion =
    typeof step.expansion === "object" && step.expansion !== null ? (step.expansion as Record<string, unknown>) : {};
  const via = typeof expansion.via === "string" ? expansion.via : "direct";
  const childPlanHash = typeof expansion.childPlanHash === "string" ? expansion.childPlanHash : undefined;
  const viaText =
    via === "task"
      ? `via ${String(expansion.taskRef ?? "")}`
      : via === "child"
        ? `-> ${String(expansion.childRef ?? "")}${childPlanHash ? ` (plan ${childPlanHash})` : ""}`
        : "direct";
  lines.push(`${prefix}${ordinal}. ${stepId} ${targetKind} ${viaText}`.replace(/ +/g, " ").trimEnd());

  const detailPrefix = `${prefix}  `;
  const inputBindings = Array.isArray(step.inputBindings) ? (step.inputBindings as Record<string, unknown>[]) : [];
  if (inputBindings.length > 0) {
    lines.push(`${detailPrefix}with: ${formatInputBindingsList(inputBindings)}`);
  }
  if (via === "child") {
    const childOutputs = Array.isArray(expansion.childOutputs) ? expansion.childOutputs : [];
    if (childOutputs.length > 0) {
      lines.push(`${detailPrefix}exports: ${childOutputs.map(String).join(", ")}`);
    }
    const childSteps = Array.isArray(expansion.steps) ? (expansion.steps as Array<Record<string, unknown>>) : [];
    for (const [index, childStep] of childSteps.entries()) {
      renderPlanStepLines(childStep, index + 1, lines, `${prefix}  ${ordinal}.`);
    }
  }
}

/**
 * `akm workflow plan <ref>` text mode (P3b, spec §4.6): a human summary of
 * the same compile+freeze data `--format json` returns — never a resolved
 * env/secret value (B-52, B-53).
 */
export function formatWorkflowPlanPlain(result: Record<string, unknown>): string | null {
  if (typeof result.ref !== "string") return null;

  const sourceFormat = typeof result.sourceFormat === "string" ? result.sourceFormat : "unknown";
  const irVersion = typeof result.irVersion === "number" ? result.irVersion : "unknown";
  const planHash = typeof result.planHash === "string" ? result.planHash : "unknown";
  const execution =
    typeof result.execution === "object" && result.execution !== null
      ? (result.execution as Record<string, unknown>)
      : {};
  const budget =
    typeof result.budget === "object" && result.budget !== null
      ? (result.budget as Record<string, unknown>)
      : undefined;

  const lines = [
    `workflow: ${result.ref} (${sourceFormat})`,
    `source:   ${typeof result.sourcePath === "string" ? result.sourcePath : "unknown"}`,
    `plan:     irVersion ${irVersion}, hash ${planHash} (not published)`,
  ];

  const limitsParts = [
    `maxConcurrency ${typeof execution.maxConcurrency === "number" ? execution.maxConcurrency : "?"}`,
  ];
  if (budget) {
    const budgetParts: string[] = [];
    if (typeof budget.maxUnits === "number") budgetParts.push(`max_units ${budget.maxUnits}`);
    if (typeof budget.maxTokens === "number") budgetParts.push(`max_tokens ${budget.maxTokens}`);
    if (budgetParts.length > 0) limitsParts.push(`budget ${budgetParts.join(", ")}`);
  }
  lines.push(`limits:   ${limitsParts.join("; ")}`);

  const params = Array.isArray(result.params) ? (result.params as unknown[]) : undefined;
  if (params && params.length > 0) lines.push(`params:   ${params.join(", ")}`);

  const outputs =
    typeof result.outputs === "object" && result.outputs !== null
      ? (result.outputs as Record<string, unknown>)
      : undefined;
  if (outputs) {
    for (const [name, declaration] of Object.entries(outputs)) {
      const from =
        typeof declaration === "object" && declaration !== null
          ? String((declaration as Record<string, unknown>).from ?? "")
          : "";
      lines.push(`outputs:  ${name} <- ${from}`);
    }
  }

  const steps = Array.isArray(result.steps) ? (result.steps as Array<Record<string, unknown>>) : [];
  lines.push("steps:");
  for (const [index, step] of steps.entries()) {
    renderPlanStepLines(step, index + 1, lines);
  }

  const notices = Array.isArray(result.notices) ? result.notices : [];
  if (notices.length > 0) {
    lines.push("notices:");
    for (const value of notices) {
      const line = renderLoweringNoticeLine(value);
      if (line) lines.push(`  ${line}`);
    }
  }

  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  if (warnings.length > 0) {
    lines.push("warnings:");
    for (const warning of warnings) lines.push(`  ! ${String(warning)}`);
  }

  return lines.join("\n");
}
