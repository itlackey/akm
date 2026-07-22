// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Plain-text renderers for `akm workflow *` commands.
 *
 * Split out of `helpers.ts` (formerly 1418 lines / 59 fns) as its own
 * sibling module: the workflow run/step/status/brief renderers form a
 * cohesive, self-contained cluster (they call only each other, never
 * formatters from other domains).
 */

export function formatWorkflowValidatePlain(r: Record<string, unknown>): string {
  const ok = r.ok !== false;
  const pathValue = String(r.path ?? "?");
  if (!ok) return `workflow validate: failed (${pathValue})`;
  const title = typeof r.title === "string" ? r.title : "";
  const stepCount = typeof r.stepCount === "number" ? r.stepCount : 0;
  const lines = [`workflow validate: ok — ${title || pathValue} (${stepCount} step(s))`];
  // Non-fatal advisories: clearly marked, printed after the ok line so `ok`
  // is never in doubt. Absent/empty for markdown and fully-typed programs.
  const warnings = Array.isArray(r.warnings) ? (r.warnings as Array<Record<string, unknown>>) : [];
  if (warnings.length > 0) {
    lines.push(`  ${warnings.length} warning(s):`);
    for (const w of warnings) {
      const line = typeof w.line === "number" ? w.line : "?";
      lines.push(`    warning: ${pathValue}:${line} — ${String(w.message ?? "")}`);
    }
  }
  return lines.join("\n");
}

/**
 * Plain-text rendering for a step-completion that was rejected by the
 * summary-validation gate (#506): the step stays pending and the agent gets
 * corrective feedback on what to finish/fix.
 */
export function formatWorkflowCompleteRejectedPlain(r: Record<string, unknown>): string {
  const stepId = String(r.stepId ?? "?");
  const feedback = typeof r.feedback === "string" ? r.feedback : "";
  const missing = Array.isArray(r.missing) ? (r.missing as unknown[]).map((m) => String(m)) : [];
  const lines = [`workflow complete: rejected — step "${stepId}" does not meet its completion criteria`];
  if (feedback) lines.push(`  feedback: ${feedback}`);
  if (missing.length > 0) {
    lines.push("  outstanding:");
    for (const m of missing) lines.push(`    - ${m}`);
  }
  return lines.join("\n");
}

export function formatWorkflowListPlain(result: Record<string, unknown>): string {
  const runs = Array.isArray(result.runs) ? (result.runs as Array<Record<string, unknown>>) : [];
  if (runs.length === 0) {
    return "No workflow runs in the current working scope. Start one with `akm workflow next workflows/<name>` or author one with `akm workflow create <name>`.";
  }

  return runs
    .map((run) => {
      const id = typeof run.id === "string" ? run.id : "unknown";
      const ref = typeof run.workflowRef === "string" ? run.workflowRef : "workflow:unknown";
      const status = typeof run.status === "string" ? run.status : "unknown";
      const currentStep = typeof run.currentStepId === "string" ? ` (current: ${run.currentStepId})` : "";
      return `${id} ${ref} [${status}]${currentStep}`;
    })
    .join("\n");
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
    `workflow: ${String(workflow.ref ?? "workflow:unknown")}`,
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
      // Codex round-3 finding B: a `running` claim gone silent past the check-in
      // window — the driver likely died. Surface it (with the claim holder) so a
      // human can reclaim/re-run the unit, matching what `brief` reports.
      if (unit.stale === true) {
        const holder =
          typeof unit.claimHolder === "string" && unit.claimHolder.trim() ? ` claimed by ${unit.claimHolder}` : "";
        lines.push(`    stale: claim went silent past the check-in window${holder} — its driver may have died`);
      }
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

  // Review C2: the check-in `continue` directive must survive plain-text
  // rendering — JSON consumers saw `checkin` but the text path dropped it.
  const checkinLine = formatWorkflowCheckinLine(result);
  if (checkinLine) {
    lines.push("");
    lines.push(checkinLine);
  }
  return lines.join("\n");
}

/**
 * Render the stalled-run check-in directive (#506) when present on a
 * workflow-next/status result. Returns null when the run is healthy.
 */
function formatWorkflowCheckinLine(result: Record<string, unknown>): string | null {
  const checkin =
    typeof result.checkin === "object" && result.checkin !== null
      ? (result.checkin as Record<string, unknown>)
      : undefined;
  if (!checkin || typeof checkin.directive !== "string" || !checkin.directive.trim()) return null;
  return checkin.directive.trim();
}

export function formatWorkflowNextPlain(result: Record<string, unknown>): string | null {
  const base = formatWorkflowStatusPlain(result);
  const step =
    typeof result.step === "object" && result.step !== null ? (result.step as Record<string, unknown>) : undefined;
  if (!step) return base;

  const lines = base ? [base, "", "next:"] : ["next:"];
  lines.push(`  ${String(step.title ?? "Untitled step")} [${String(step.id ?? "unknown")}]`);
  if (typeof step.instructions === "string" && step.instructions.trim()) {
    const instrLines = step.instructions.trim().split("\n");
    lines.push(`  instructions: ${instrLines[0]}`);
    for (const instrLine of instrLines.slice(1)) lines.push(`    ${instrLine}`);
  }
  const completion = Array.isArray(step.completionCriteria) ? step.completionCriteria : [];
  if (completion.length > 0) {
    lines.push("  completion:");
    for (const criterion of completion) {
      lines.push(`    - ${String(criterion)}`);
    }
  }

  // T2-3: surface run-id as labeled field
  const run =
    typeof result.run === "object" && result.run !== null ? (result.run as Record<string, unknown>) : undefined;
  const runId = typeof run?.id === "string" ? run.id : null;
  const stepId = typeof step?.id === "string" ? step.id : null;
  if (runId) {
    lines.push("");
    lines.push(`runId: ${runId}`);
  }

  // T1-6: complete command
  if (runId && stepId) {
    lines.push("");
    lines.push("COMPLETE THIS STEP:");
    lines.push(`  akm workflow complete '${runId}' --step '${stepId}'`);
  } else if (runId) {
    lines.push("");
    lines.push("COMPLETE THIS STEP:");
    lines.push(`  akm workflow complete '${runId}' --step '<step-id>'`);
  }

  return lines.join("\n");
}

export function formatWorkflowRunPlain(result: Record<string, unknown>): string | null {
  const run =
    typeof result.run === "object" && result.run !== null ? (result.run as Record<string, unknown>) : undefined;
  if (!run) return null;

  const lines = [`run: ${String(run.id ?? "unknown")}`, `status: ${String(run.status ?? "unknown")}`];
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
  if (result.done === true) lines.push("workflow completed.");
  return lines.join("\n");
}

export function formatWorkflowBriefPlain(result: Record<string, unknown>): string | null {
  const run =
    typeof result.run === "object" && result.run !== null ? (result.run as Record<string, unknown>) : undefined;
  if (!run) return null;

  const lines: string[] = [];
  lines.push(`# Workflow brief: ${String(run.id ?? "unknown")}`);
  lines.push(`workflow: ${String(run.workflowRef ?? "?")}  (${String(run.workflowTitle ?? "")})`);
  lines.push(`status: ${String(run.status ?? "?")}`);
  if (typeof result.message === "string") lines.push(result.message);

  const lease =
    typeof result.engineLease === "object" && result.engineLease !== null
      ? (result.engineLease as Record<string, unknown>)
      : undefined;
  if (lease) {
    const live = lease.live === true ? "LIVE" : "expired";
    lines.push(`engine lease: ${String(lease.holder ?? "?")} (until ${String(lease.until ?? "?")}) [${live}]`);
  }

  const warnings = Array.isArray(result.warnings) ? (result.warnings as unknown[]) : [];
  for (const w of warnings) lines.push(`! ${String(w)}`);

  if (result.done === true) {
    lines.push("");
    lines.push("This run is completed — no work remains.");
    return lines.join("\n");
  }

  const step =
    typeof result.step === "object" && result.step !== null ? (result.step as Record<string, unknown>) : undefined;
  if (!step) {
    return lines.join("\n");
  }

  const gate = typeof step.gate === "object" && step.gate !== null ? (step.gate as Record<string, unknown>) : undefined;
  lines.push("");
  lines.push(
    `## Active step: ${String(step.stepId ?? "?")} — ${String(step.title ?? "")}  [${String(step.kind ?? "execute")}]`,
  );
  if (gate) {
    const criteria = Array.isArray(gate.criteria) ? (gate.criteria as unknown[]) : [];
    lines.push(
      `gate: loop ${String(gate.currentLoop ?? 1)} of max ${String(gate.maxLoops ?? 1)}` +
        (criteria.length > 0 ? `; criteria: ${criteria.map(String).join("; ")}` : "; no completion criteria") +
        (gate.judgesArtifact === true ? " (artifact-judged)" : ""),
    );
  }
  if (step.outputSchema !== undefined) lines.push("outputSchema: declared (see JSON output)");

  const feedback =
    typeof result.gateFeedback === "object" && result.gateFeedback !== null
      ? (result.gateFeedback as Record<string, unknown>)
      : undefined;
  if (feedback) {
    lines.push(`gate feedback (previous loop rejected): ${String(feedback.feedback ?? "")}`);
    const missing = Array.isArray(feedback.missing) ? (feedback.missing as unknown[]) : [];
    for (const m of missing) lines.push(`  - missing: ${String(m)}`);
  }

  const route =
    typeof result.route === "object" && result.route !== null ? (result.route as Record<string, unknown>) : undefined;
  if (route) {
    lines.push("");
    lines.push(`## Route contract on ${String(route.input ?? "?")}`);
    const when = typeof route.when === "object" && route.when !== null ? (route.when as Record<string, unknown>) : {};
    for (const [value, target] of Object.entries(when)) lines.push(`  when "${value}" → ${String(target)}`);
    if (route.defaultStepId !== undefined) lines.push(`  default → ${String(route.defaultStepId)}`);
    const decision =
      typeof route.decision === "object" && route.decision !== null
        ? (route.decision as Record<string, unknown>)
        : undefined;
    if (decision) lines.push(`  decision NOW: value "${String(decision.value)}" → ${String(decision.selected)}`);
    else if (typeof route.decisionError === "string") lines.push(`  decision error: ${route.decisionError}`);
    else lines.push("  decision: pending this step's output (evaluated after units complete)");
  }

  const workList =
    typeof result.workList === "object" && result.workList !== null
      ? (result.workList as Record<string, unknown>)
      : undefined;
  const units = workList && Array.isArray(workList.units) ? (workList.units as Array<Record<string, unknown>>) : [];
  if (workList?.error) {
    lines.push("");
    lines.push(`work-list error: ${String(workList.error)}`);
  } else if (units.length > 0) {
    lines.push("");
    lines.push(`## Units (${units.length})`);
    for (const u of units) {
      const model = u.model ? ` model=${String(u.model)}` : "";
      const journaled =
        typeof u.journaled === "object" && u.journaled !== null ? (u.journaled as Record<string, unknown>) : undefined;
      const jstatus = journaled ? ` [journaled: ${String(journaled.status)}]` : "";
      lines.push(`- ${String(u.unitId)}  (runner=${String(u.runner)}${model})${jstatus}`);
      const env = Array.isArray(u.env) ? (u.env as unknown[]) : [];
      if (env.length > 0) lines.push(`    env (names): ${env.map(String).join(", ")}`);
      if (u.outputSchema !== undefined) lines.push("    outputSchema: declared (see JSON output)");
      const resolved =
        typeof u.resolved === "object" && u.resolved !== null ? (u.resolved as Record<string, unknown>) : undefined;
      if (resolved && resolved.ok === false) lines.push(`    RESOLUTION ERROR: ${String(resolved.error)}`);
      if (typeof u.report === "string") lines.push(`    report: ${u.report}`);
    }
  }

  // Finding D: a non-dispatching step (route-only / empty / all-unresolvable)
  // advances via the `--settle` verb, surfaced so a driver can advance the spine.
  if (typeof result.settleCommand === "string") {
    lines.push("");
    lines.push("## Advance (no reportable units)");
    lines.push(`settle: ${result.settleCommand}`);
  }

  const guidance =
    typeof result.reportGuidance === "object" && result.reportGuidance !== null
      ? (result.reportGuidance as Record<string, unknown>)
      : undefined;
  if (guidance) {
    lines.push("");
    lines.push("## Reporting");
    if (typeof guidance.checkin === "string") lines.push(`heartbeat: ${guidance.checkin}`);
    if (typeof guidance.failure === "string") lines.push(`on failure: ${guidance.failure}`);
  }

  return lines.join("\n");
}

export function formatWorkflowCreatePlain(r: Record<string, unknown>): string | null {
  if (r.ref && r.path) {
    return `Created ${String(r.ref)} at ${String(r.path)}`;
  }
  return null;
}

export function formatWorkflowResumePlain(r: Record<string, unknown>): string {
  return formatWorkflowStatusPlain(r) ?? `Resumed workflow run ${String(r.id ?? r.runId ?? "?")}`;
}
