// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm workflow report <run>` — the MUTATING half of the harness-neutral driver
 * protocol (redesign addendum R3). A driver that ran a unit from `akm workflow
 * brief` reports its result back through THIS path, which ingests the result
 * through the SAME shared step semantics the native engine uses
 * (`step-work.ts`), so an engine-driven run and a brief/report-driven run of the
 * same frozen plan produce byte-identical unit graphs (the invariant R4
 * asserts).
 *
 * ## No duplicated semantics (the cardinal rule)
 *
 * Every decision report makes is a shared function:
 *   - the expected work-list (item resolution + content-derived unit ids + input
 *     hashes + prompt assembly with recovered gate feedback) — the SAME
 *     {@link computeStepWorkList} / {@link activeGateLoop} /
 *     {@link recoverGateFeedback} `brief` and the executor call;
 *   - the input hash stored on the unit row is the engine's
 *     ({@link StepWorkUnit.resolved.inputHash});
 *   - reducer / artifact promotion / output-schema validation via
 *     {@link reduceStepOutcomes} (the executor's post-dispatch reduction);
 *   - route evaluation + artifact-judged gate completion + gate-row journaling +
 *     the bounded-loop rejection contract via {@link finalizeExecutedStep} (the
 *     engine loop's completion path).
 *
 * ## The ONE mutating verb, guarded
 *
 * A report is REFUSED unless the run is active AND no live engine lease is held
 * (the engine owns the spine while driving). The reported unit must belong to
 * the active step's recomputed work-list. A COMPLETED unit re-reported with the
 * same input hash is an idempotent no-op; a different hash is replay divergence.
 * Declared budget ceilings are enforced (journal-seeded, same rule as the
 * engine). When a report makes the active step's work-list fully terminal it
 * runs the identical completion path — reducer → artifact promotion → schema
 * validation → artifact-judged gate → `completeWorkflowStep` — honoring
 * `on_error` and `gate.max_loops`.
 */

import { UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { validateJsonSchemaSubset } from "../../core/json-schema";
import type { WorkflowRunStatus } from "../../sources/types";
import {
  type WorkflowRunUnitRow,
  type WorkflowRunUnitStatus,
  withWorkflowRunsRepo,
} from "../../storage/repositories/workflow-runs-repository";
import type { IrStepPlan, WorkflowPlanGraph } from "../ir/schema";
import { completeWorkflowStep, getNextWorkflowStep, type WorkflowNextResult } from "../runtime/runs";
import type { SummaryJudge } from "../validate-summary";
import { buildLease, resolveRunId } from "./brief";
import {
  activeGateLoop,
  cascadeSkippedRouter,
  computeStepWorkList,
  finalizeExecutedStep,
  parseFrozenPlan,
  type RouteSkipInfo,
  recoverGateFeedback,
  reduceStepOutcomes,
  type StepWorkList,
  type StepWorkUnit,
  seedJournaledRouteDecisions,
  stepOutputsFromEvidence,
  unitOutcomeFromRow,
} from "./step-work";

// ── Public contract ──────────────────────────────────────────────────────────

export interface ReportUnitInput {
  /** Workflow run id (or a workflow ref with an active run). */
  target: string;
  /** Content-derived unit id from `brief` (the BASE id — copy it verbatim). */
  unitId: string;
  status: "completed" | "failed" | "running";
  /**
   * Raw result payload. For a schema unit it MUST be valid JSON matching the
   * unit's output schema; otherwise it is stored as text. Absent for `running`
   * and optional (a failure note) for `failed`.
   */
  resultRaw?: string;
  tokens?: number;
  sessionId?: string;
  /** Structured failure vocabulary for a `failed` report. */
  failureReason?: string;
  /** Short progress note for a `running` heartbeat — intentionally NOT persisted. */
  note?: string;
  /**
   * Test seam: completion-criteria judge for the step gate (same seam as the
   * engine). `undefined` ⇒ build the default from config; `null` ⇒ fail-open.
   */
  summaryJudge?: SummaryJudge | null;
  /** Test seam for the clock. */
  now?: () => Date;
}

/** The outcome of the step's completion attempt, when this report triggered one. */
export interface ReportStepOutcome {
  kind: "advanced" | "failed" | "gate-rejected";
  /** For `gate-rejected`: true when the driver may retry (loop budget remains). */
  loopsRemaining?: boolean;
  missing?: string[];
  feedback?: string;
  summary?: string;
}

export interface WorkflowReportResult {
  ok: true;
  runId: string;
  stepId: string;
  /** The journal id actually written (`<unitId>` or `<unitId>~l<loop>` in a gate loop). */
  unitId: string;
  status: WorkflowRunUnitStatus;
  /** The gate loop this report was recorded under. */
  gateLoop: number;
  /** How the write resolved. */
  recorded: "written" | "idempotent" | "heartbeat";
  /** Non-terminal units still outstanding in the step's work-list after this report. */
  remainingUnits: number;
  /** Present when this report drove the active step to a completion decision. */
  stepOutcome?: ReportStepOutcome;
  /** Run status after the report. */
  runStatus: WorkflowRunStatus;
  message: string;
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function reportWorkflowUnit(input: ReportUnitInput): Promise<WorkflowReportResult> {
  const nowFn = input.now ?? (() => new Date());
  const nowIso = nowFn().toISOString();

  const runId = await resolveRunId(input.target);
  const next = await getNextWorkflowStep(runId);

  const { planJson, planHash, leaseHolder, leaseUntil, units } = await withWorkflowRunsRepo((repo) => {
    const row = repo.getRunById(runId);
    return {
      planJson: row?.plan_json ?? null,
      planHash: row?.plan_hash ?? null,
      leaseHolder: row?.engine_lease_holder ?? null,
      leaseUntil: row?.engine_lease_until ?? null,
      units: repo.getUnitsForRun(runId),
    };
  });

  // Refuse a non-active run: there is no work-list to report against.
  if (next.run.status !== "active" || next.done) {
    throw new UsageError(
      `Workflow run ${runId} is ${next.run.status} — \`akm workflow report\` only records results for an ACTIVE ` +
        `run. ${next.run.status === "completed" ? "The run is already done." : `Reopen it first: \`akm workflow resume ${runId}\`.`}`,
    );
  }

  // Refuse while a LIVE engine lease is held — the engine owns the spine while
  // driving; a report would race its completion.
  const lease = buildLease(leaseHolder, leaseUntil);
  if (lease?.live) {
    throw new UsageError(
      `Workflow run ${runId} is being driven by engine ${lease.holder} (run lease expires ${lease.until}). ` +
        `\`akm workflow report\` is refused while the engine lease is live — wait for the engine to finish or for ` +
        `the lease to expire before reporting units.`,
    );
  }

  const stepState = next.step;
  if (!stepState) {
    throw new UsageError(`Workflow run ${runId} is active but has no current step to report against.`);
  }

  const plan = loadFrozenPlan(runId, planJson, planHash);
  const stepPlan = plan.steps.find((s) => s.stepId === stepState.id);
  if (!stepPlan) {
    throw new UsageError(
      `Step "${stepState.id}" of run ${runId} is not present in the run's frozen plan — cannot report against it.`,
    );
  }
  // Route-only steps carry no execution subgraph and dispatch no units; a driver
  // has nothing to report for them (the engine advances them deterministically).
  if (!stepPlan.root) {
    throw new UsageError(
      `Step "${stepState.id}" of run ${runId} is a route step — it dispatches no units, so there is nothing to ` +
        `report. It advances deterministically once the prior executing step completes.`,
    );
  }

  // Recompute the SHARED work-list at the active gate loop — the same ids,
  // hashes, and prompts the engine (and `brief`) compute.
  const priorEvidence: Record<string, Record<string, unknown> | undefined> = {};
  for (const s of next.workflow.steps) priorEvidence[s.id] = s.evidence;
  const stepOutputs = stepOutputsFromEvidence(priorEvidence);
  const gateLoop = activeGateLoop(units, stepState.id);
  const gateFeedback = recoverGateFeedback(units, stepState.id, gateLoop);

  const computed = computeStepWorkList(stepPlan, {
    runId,
    params: next.run.params ?? {},
    stepOutputs,
    gateLoop,
    ...(gateFeedback ? { gateFeedback } : {}),
  });
  if (!computed.ok) {
    throw new UsageError(
      `Step "${stepState.id}" of run ${runId} could not compute a work-list to report against: ${computed.error}`,
    );
  }
  const workList = computed.list;

  const workUnit = workList.units.find((u) => u.unitId === input.unitId);
  if (!workUnit) {
    const valid = workList.units.map((u) => u.unitId).join(", ") || "(none)";
    throw new UsageError(
      `Unit "${input.unitId}" does not belong to the active step "${stepState.id}" of run ${runId}. ` +
        `Valid unit ids for this step: ${valid}. Run \`akm workflow brief ${runId}\` for the current work-list.`,
      "INVALID_FLAG_VALUE",
    );
  }
  if (!workUnit.resolved.ok) {
    throw new UsageError(
      `Unit "${input.unitId}" cannot be resolved (${workUnit.resolved.error}) — it has no dispatchable input to ` +
        `report a result against. This is an authoring/data error in the workflow; fix it and start a new run.`,
    );
  }
  const inputHash = workUnit.resolved.inputHash;
  const journalId = workUnit.journalBaseId;

  // ── running: claim / heartbeat, never advances the spine ───────────────────
  if (input.status === "running") {
    const claimed = await withWorkflowRunsRepo((repo) =>
      repo.transaction(() => {
        const existing = repo.getUnit(runId, journalId);
        if (existing && (existing.status === "completed" || existing.status === "failed")) {
          throw new UsageError(
            `Unit "${journalId}" of run ${runId} is already ${existing.status} — cannot claim a terminal unit as ` +
              `running. Report a fresh result with --status completed|failed, or start a new run to redo it.`,
          );
        }
        if (!existing) {
          repo.insertUnit({
            runId,
            unitId: journalId,
            stepId: stepState.id,
            nodeId: workUnit.nodeId,
            parentUnitId: workUnit.isFanOut ? `${stepState.id}.map` : null,
            phase: null,
            runner: workUnit.runner,
            model: workUnit.model ?? null,
            inputHash,
            startedAt: nowIso,
          });
        }
        repo.updateUnitCheckin(runId, journalId, nowIso);
        return existing ? "heartbeat" : "claim";
      }),
    );
    appendEvent({
      eventType: "workflow_unit_started",
      ref: next.run.workflowRef,
      metadata: { runId, stepId: stepState.id, unitId: journalId, status: "running" },
    });
    const remaining = countRemaining(workList.units, units, journalId, "running");
    return {
      ok: true,
      runId,
      stepId: stepState.id,
      unitId: journalId,
      status: "running",
      gateLoop,
      recorded: "heartbeat",
      remainingUnits: remaining,
      runStatus: next.run.status,
      message:
        claimed === "claim"
          ? `Claimed unit "${journalId}" of step "${stepState.id}". Heartbeat again with --status running, then report the result.`
          : `Heartbeat recorded for unit "${journalId}" of step "${stepState.id}".`,
    };
  }

  // ── completed / failed: validate, guard, write, maybe finalize ─────────────
  const { resultJson, failureReason } = prepareResult(input, workUnit);

  // Guarded write: an idempotent re-report / replay-divergence check and the
  // budget ceiling are enforced INSIDE the same SQLite transaction as the
  // insert+finish, so two concurrent reports for the same unit serialize on the
  // write lock and cannot corrupt the row (the row is always internally
  // consistent; the first COMPLETED write wins, and a same-hash re-report is an
  // idempotent no-op).
  const status: Exclude<WorkflowRunUnitStatus, "pending" | "running"> = input.status;
  const writeResult = await withWorkflowRunsRepo((repo) =>
    repo.transaction((): "written" | "idempotent" => {
      const existing = repo.getUnit(runId, journalId);
      if (existing?.status === "completed") {
        if (existing.input_hash === inputHash) return "idempotent";
        throw new UsageError(
          `Replay divergence: unit "${journalId}" of run ${runId} is already recorded COMPLETED with a different ` +
            `input hash than this report's. Under a frozen plan the same unit identity must reproduce the same ` +
            `inputs — refusing to overwrite. Start a new run to re-execute this work.`,
        );
      }
      // Budget ceilings (journal-seeded, same rule as the engine): count
      // journaled DISPATCH rows other than this one; gate rows are excluded.
      assertBudget(plan, repo.getUnitsForRun(runId), journalId);

      repo.insertUnit({
        runId,
        unitId: journalId,
        stepId: stepState.id,
        nodeId: workUnit.nodeId,
        parentUnitId: workUnit.isFanOut ? `${stepState.id}.map` : null,
        phase: null,
        runner: workUnit.runner,
        model: workUnit.model ?? null,
        inputHash,
        startedAt: existing?.started_at ?? nowIso,
      });
      repo.finishUnit({
        runId,
        unitId: journalId,
        status,
        resultJson,
        tokens: input.tokens ?? null,
        failureReason,
        sessionId: input.sessionId ?? null,
        finishedAt: nowIso,
      });
      return "written";
    }),
  );

  // Events carry ids/status only — never workflow-authored content.
  appendEvent({
    eventType: "workflow_unit_started",
    ref: next.run.workflowRef,
    metadata: { runId, stepId: stepState.id, unitId: journalId, status: "running" },
  });
  appendEvent({
    eventType: "workflow_unit_finished",
    ref: next.run.workflowRef,
    metadata: {
      runId,
      stepId: stepState.id,
      unitId: journalId,
      status,
      ...(failureReason ? { failureReason } : {}),
      ...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
    },
  });

  // An idempotent re-report changes nothing else — the step's completion (if any)
  // already happened on the first report.
  if (writeResult === "idempotent") {
    return {
      ok: true,
      runId,
      stepId: stepState.id,
      unitId: journalId,
      status,
      gateLoop,
      recorded: "idempotent",
      remainingUnits: 0,
      runStatus: next.run.status,
      message: `Unit "${journalId}" was already recorded — no change (idempotent re-report).`,
    };
  }

  // Is the step's work-list now fully terminal? Re-read the journal so a
  // concurrent report of a sibling unit is observed.
  const rowsAfter = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(runId));
  const byUnit = indexDispatchRows(rowsAfter);
  const remaining = workList.units.filter((u) => {
    const row = byUnit.get(u.journalBaseId);
    return !(row && (row.status === "completed" || row.status === "failed"));
  }).length;

  if (remaining > 0) {
    return {
      ok: true,
      runId,
      stepId: stepState.id,
      unitId: journalId,
      status,
      gateLoop,
      recorded: "written",
      remainingUnits: remaining,
      runStatus: next.run.status,
      message: `Recorded unit "${journalId}" (${status}). ${remaining} unit(s) still outstanding for step "${stepState.id}".`,
    };
  }

  // The work-list is fully terminal → run the SHARED completion path.
  return finalizeStep({
    runId,
    next,
    plan,
    stepPlan,
    stepState,
    workList,
    byUnit,
    gateLoop,
    priorEvidence,
    summaryJudge: input.summaryJudge,
    now: nowFn,
    written: { unitId: journalId, status },
  });
}

// ── Step finalization (shared path) ──────────────────────────────────────────

async function finalizeStep(args: {
  runId: string;
  next: WorkflowNextResult;
  plan: WorkflowPlanGraph;
  stepPlan: IrStepPlan;
  stepState: NonNullable<WorkflowNextResult["step"]>;
  workList: StepWorkList;
  byUnit: Map<string, WorkflowRunUnitRow>;
  gateLoop: number;
  priorEvidence: Record<string, Record<string, unknown> | undefined>;
  summaryJudge: SummaryJudge | null | undefined;
  now: () => Date;
  written: { unitId: string; status: WorkflowRunUnitStatus };
}): Promise<WorkflowReportResult> {
  const { runId, next, plan, stepPlan, stepState, workList, byUnit, gateLoop } = args;

  // Rebuild the unit outcomes from the journal and reduce them through the SAME
  // function the executor uses (reducer + on_error + artifact schema).
  const outcomes = workList.units.map((u) => {
    const row = byUnit.get(u.journalBaseId);
    // Every unit is terminal here (checked by the caller); the non-null row is
    // guaranteed.
    return unitOutcomeFromRow(u.unitId, row as WorkflowRunUnitRow, u.schema !== undefined);
  });
  const reduced = reduceStepOutcomes(
    stepPlan,
    workList.reducer,
    workList.isFanOut,
    workList.template.onError,
    outcomes,
  );

  // Route/skip bookkeeping seeded from the journal so cascaded skips survive
  // (identical to the engine's resume seeding).
  const routeSelected = new Set<string>();
  const routeUnselected = new Map<string, RouteSkipInfo>();
  seedJournaledRouteDecisions(plan, next, routeSelected, routeUnselected);

  const maxLoops = Math.max(1, stepPlan.gate.maxLoops ?? 1);
  const finalize = await finalizeExecutedStep({
    runId,
    workflowRef: next.run.workflowRef,
    stepId: stepState.id,
    stepPlan,
    completionCriteria: stepState.completionCriteria ?? [],
    gateLoop,
    loopsRemaining: gateLoop < maxLoops,
    result: reduced,
    priorEvidence: args.priorEvidence,
    params: next.run.params ?? {},
    routeSelected,
    routeUnselected,
    summaryJudge: args.summaryJudge,
  });

  if (finalize.kind === "retry") {
    // A typed-artifact schema mismatch (`reduced.ok === false`) yields a retry
    // that the ENGINE recovers from in-invocation memory — but no gate row is
    // journaled for it, so the stateless report path's next `brief` could not
    // recover the feedback (and journaling a synthetic gate row would break
    // engine/report unit-graph parity). Documented call: on the report surface
    // a schema mismatch is a HARD step failure. A driver fixes the workflow's
    // schema/unit contract and starts a new run. (A GATE rejection —
    // `reduced.ok === true` — journals its `<stepId>.gate:l<loop>` row, so its
    // feedback IS recoverable; that path stays a real bounded loop below.)
    if (!reduced.ok) {
      await completeWorkflowStep({
        runId,
        stepId: stepState.id,
        status: "failed",
        notes: reduced.summary,
        evidence: reduced.evidence,
      });
      const state = await getNextWorkflowStep(runId);
      return reportResult(
        runId,
        stepState.id,
        args.written,
        gateLoop,
        state.run.status,
        {
          kind: "failed",
          summary: reduced.summary,
        },
        `Step "${stepState.id}" failed: ${reduced.summary}`,
      );
    }
    // Gate rejected with loop budget left — the step stays active; the next
    // `brief` emits the loop-N work-list with the feedback recovered from the
    // journaled gate row.
    const nextLoop = gateLoop + 1;
    return reportResult(
      runId,
      stepState.id,
      args.written,
      gateLoop,
      "active",
      {
        kind: "gate-rejected",
        loopsRemaining: true,
        missing: finalize.gateFeedback.missing,
        feedback: finalize.gateFeedback.feedback,
        summary: finalize.gateFeedback.feedback,
      },
      `Step "${stepState.id}" was rejected — run \`akm workflow brief ${runId}\` for loop ${nextLoop}'s work-list (feedback threaded in).`,
    );
  }

  if (finalize.kind === "gate-exhausted") {
    return reportResult(
      runId,
      stepState.id,
      args.written,
      gateLoop,
      "active",
      {
        kind: "gate-rejected",
        loopsRemaining: false,
        missing: finalize.gateRejection.missing,
        feedback: finalize.gateRejection.feedback,
        summary: finalize.gateRejection.feedback,
      },
      `Step "${stepState.id}" was rejected and its ${maxLoops}-loop gate budget is exhausted. Resolve it manually (\`akm workflow complete\`/\`resume\`/\`abandon\`).`,
    );
  }

  if (finalize.kind === "failed") {
    const state = await getNextWorkflowStep(runId);
    return reportResult(
      runId,
      stepState.id,
      args.written,
      gateLoop,
      state.run.status,
      {
        kind: "failed",
        summary: finalize.summary,
      },
      `Step "${stepState.id}" failed: ${finalize.summary}`,
    );
  }

  // advanced — the spine moved. Walk forward over any route-only / skipped steps
  // (they dispatch no units, so no driver could report them) using the SAME
  // shared decision helpers, then surface the resting state.
  const state = await advanceNonExecutableSteps(plan, runId, routeSelected, routeUnselected, args.summaryJudge);
  const message =
    state.run.status === "completed"
      ? `Step "${stepState.id}" completed — the workflow run is now DONE.`
      : state.step
        ? `Step "${stepState.id}" completed. Next: run \`akm workflow brief ${runId}\` for step "${state.step.id}".`
        : `Step "${stepState.id}" completed; run is ${state.run.status}.`;
  return reportResult(runId, stepState.id, args.written, gateLoop, state.run.status, { kind: "advanced" }, message);
}

/**
 * Advance the spine over steps a driver cannot report (route-only + route-skipped
 * steps), using the shared route/skip helpers — identical semantics to the
 * engine loop, so the run does not get stuck at a route step no `report` can
 * touch. Stops at the first executable pending step, or when the run leaves
 * `active`.
 */
async function advanceNonExecutableSteps(
  plan: WorkflowPlanGraph,
  runId: string,
  routeSelected: Set<string>,
  routeUnselected: Map<string, RouteSkipInfo>,
  summaryJudge: SummaryJudge | null | undefined,
): Promise<WorkflowNextResult> {
  let state = await getNextWorkflowStep(runId);
  // Bounded by the step count — every iteration completes/skips one step.
  for (let guard = 0; guard <= plan.steps.length && state.run.status === "active" && state.step; guard++) {
    const step = state.step;
    const sp = plan.steps.find((s) => s.stepId === step.id);
    if (!sp) break;

    const skipInfo = routeUnselected.get(step.id);
    if (skipInfo && !routeSelected.has(step.id)) {
      if (sp.route) cascadeSkippedRouter(sp.route, step.id, routeUnselected);
      const notes =
        skipInfo.selected === null
          ? `Skipped by route: step "${skipInfo.router}" was itself skipped, so none of its branch targets run.`
          : `Skipped by route: step "${skipInfo.router}" selected "${skipInfo.selected}".`;
      await completeWorkflowStep({ runId, stepId: step.id, status: "skipped", notes });
      state = await getNextWorkflowStep(runId);
      continue;
    }

    // A route-only step: no units to report — evaluate + complete it here.
    if (!sp.root && sp.route) {
      const priorEvidence: Record<string, Record<string, unknown> | undefined> = {};
      for (const s of state.workflow.steps) priorEvidence[s.id] = s.evidence;
      const fin = await finalizeExecutedStep({
        runId,
        workflowRef: state.run.workflowRef,
        stepId: step.id,
        stepPlan: sp,
        completionCriteria: step.completionCriteria ?? [],
        gateLoop: 1,
        loopsRemaining: false,
        result: {
          ok: true,
          units: [],
          evidence: {},
          summary: `Step "${step.id}" is a route step — no units dispatched.`,
        },
        priorEvidence,
        params: state.run.params ?? {},
        routeSelected,
        routeUnselected,
        summaryJudge,
      });
      if (fin.kind !== "advanced") break; // a route failure stops the walk
      state = await getNextWorkflowStep(runId);
      continue;
    }

    // An executable step — the driver briefs and reports it next.
    break;
  }
  return state;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadFrozenPlan(runId: string, planJson: string | null, planHash: string | null): WorkflowPlanGraph {
  if (!planJson) {
    throw new UsageError(
      `Workflow run ${runId} predates frozen plans (no plan_json on the run row) and cannot be driven by ` +
        `\`akm workflow report\`. Use engine-driven mode: \`akm workflow run ${runId}\`.`,
    );
  }
  return parseFrozenPlan(runId, planJson, planHash);
}

/** Validate + shape the reported result into what `finishUnit` persists. */
function prepareResult(
  input: ReportUnitInput,
  workUnit: StepWorkUnit,
): { resultJson: string | null; failureReason: string | null } {
  if (input.status === "failed") {
    return {
      resultJson: input.resultRaw !== undefined && input.resultRaw !== "" ? JSON.stringify(input.resultRaw) : null,
      failureReason: input.failureReason ?? "reported_failure",
    };
  }
  // completed
  if (workUnit.schema) {
    const raw = input.resultRaw;
    if (raw === undefined || raw.trim() === "") {
      throw new UsageError(
        `Unit "${input.unitId}" declares an output schema — its --result must be a JSON value matching that schema, ` +
          `but no result was provided.`,
        "MISSING_REQUIRED_ARGUMENT",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new UsageError(
        `Unit "${input.unitId}" result is not valid JSON (its output schema requires a JSON value): ${
          err instanceof Error ? err.message : String(err)
        }`,
        "INVALID_FLAG_VALUE",
      );
    }
    const errors = validateJsonSchemaSubset(parsed, workUnit.schema);
    if (errors.length > 0) {
      throw new UsageError(
        `Unit "${input.unitId}" result failed validation against its declared output schema: ${errors.join("; ")}.`,
        "INVALID_FLAG_VALUE",
      );
    }
    return { resultJson: JSON.stringify(parsed), failureReason: null };
  }
  // Free-text unit: journal the text as a JSON string (as the executor does).
  return { resultJson: JSON.stringify(input.resultRaw ?? ""), failureReason: null };
}

/**
 * Enforce the frozen plan's declared budget ceilings on the report path, seeded
 * from the journal exactly as the engine seeds `DispatchBudget`: dispatch rows
 * (phase != gate) OTHER than the one being written count against `max_units`,
 * and their token sum against `max_tokens`. A ceiling already reached refuses
 * the new unit — the same hard rule as the engine (regardless of on_error).
 */
function assertBudget(plan: WorkflowPlanGraph, rows: WorkflowRunUnitRow[], journalId: string): void {
  const budget = plan.budget;
  if (!budget || (budget.maxUnits === undefined && budget.maxTokens === undefined)) return;
  let dispatched = 0;
  let tokens = 0;
  for (const row of rows) {
    if (row.phase !== null) continue; // gate rows excluded
    if (row.unit_id === journalId) continue; // the row being (re)written
    dispatched++;
    tokens += row.tokens ?? 0;
  }
  if (budget.maxUnits !== undefined && dispatched >= budget.maxUnits) {
    throw new UsageError(
      `budget exceeded (max_units ceiling): ${dispatched} unit(s) already dispatched for this run against the ` +
        `workflow's declared budget.max_units of ${budget.maxUnits} — refusing to record further units.`,
    );
  }
  if (budget.maxTokens !== undefined && tokens >= budget.maxTokens) {
    throw new UsageError(
      `budget exceeded (max_tokens ceiling): ${tokens} token(s) already spent for this run against the workflow's ` +
        `declared budget.max_tokens of ${budget.maxTokens} — refusing to record further units.`,
    );
  }
}

/** Index the run's DISPATCH unit rows (phase != gate) by unit id. */
function indexDispatchRows(rows: WorkflowRunUnitRow[]): Map<string, WorkflowRunUnitRow> {
  const map = new Map<string, WorkflowRunUnitRow>();
  for (const row of rows) {
    if (row.phase === null) map.set(row.unit_id, row);
  }
  return map;
}

/** Count units whose journal row is not yet terminal (for progress messaging). */
function countRemaining(
  workUnits: StepWorkUnit[],
  rows: WorkflowRunUnitRow[],
  justClaimed: string,
  claimedStatus: WorkflowRunUnitStatus,
): number {
  const byUnit = indexDispatchRows(rows);
  return workUnits.filter((u) => {
    if (u.journalBaseId === justClaimed) return claimedStatus !== "completed" && claimedStatus !== "failed";
    const row = byUnit.get(u.journalBaseId);
    return !(row && (row.status === "completed" || row.status === "failed"));
  }).length;
}

function reportResult(
  runId: string,
  stepId: string,
  written: { unitId: string; status: WorkflowRunUnitStatus },
  gateLoop: number,
  runStatus: WorkflowRunStatus,
  stepOutcome: ReportStepOutcome,
  message: string,
): WorkflowReportResult {
  return {
    ok: true,
    runId,
    stepId,
    unitId: written.unitId,
    status: written.status,
    gateLoop,
    recorded: "written",
    remainingUnits: 0,
    stepOutcome,
    runStatus,
    message,
  };
}
