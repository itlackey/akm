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
  type ExecutedStepOutcome,
  finalizeExecutedStep,
  parseFrozenPlan,
  type RouteSkipInfo,
  recoverGateFeedback,
  reduceEmptyStep,
  reduceStepOutcomes,
  type StepWorkList,
  type StepWorkUnit,
  seedJournaledRouteDecisions,
  stepOutputsFromEvidence,
  type UnitOutcome,
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
  /**
   * How the write resolved. `not-recorded` = no unit row was written because a
   * declared budget ceiling refused the unit (the step was failed instead) or
   * the spine settled past all work before this unit could be recorded.
   */
  recorded: "written" | "idempotent" | "heartbeat" | "not-recorded";
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

  if (!next.step) {
    throw new UsageError(`Workflow run ${runId} is active but has no current step to report against.`);
  }

  const plan = loadFrozenPlan(runId, planJson, planHash);

  // Resolve the step the driver should actually report against. If the spine is
  // parked on a NON-DISPATCHING step — a route-only step, an empty fan-out
  // (`over: []`), a step whose every unit is an unresolvable expression, or a
  // whole-list resolution failure — the engine auto-completes or fails it: there
  // is no `report --unit` that could ever advance it. So `report` first settles
  // the spine past such steps (mutating exactly as the engine would, through the
  // SAME shared completion path), then resolves the reported unit against the
  // resting step. This is a no-op when the active step already has real
  // reportable work (the common case) — no settle runs, nothing mutates.
  let ctx = buildStepContext(runId, plan, next, units);
  if (!ctx.dispatching) {
    const settled = await settleSpine({ plan, runId, summaryJudge: input.summaryJudge });
    if (settled.done || settled.run.status !== "active" || !settled.step) {
      return settledTerminalResult(input, settled);
    }
    const freshUnits = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(runId));
    ctx = buildStepContext(runId, plan, settled, freshUnits);
  }

  const { next: state, stepState, stepPlan, workList, gateLoop, priorEvidence, units: unitRows } = ctx;
  if (!workList) {
    throw new UsageError(
      `Active step "${stepState.id}" of run ${runId} dispatches no reportable units` +
        `${ctx.computeError ? ` (${ctx.computeError})` : " (route-only or empty)"}. There is nothing to ` +
        `\`report --unit\` for it; run \`akm workflow brief ${runId}\` to see the current state.`,
    );
  }

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
      ref: state.run.workflowRef,
      metadata: { runId, stepId: stepState.id, unitId: journalId, status: "running" },
    });
    const remaining = countRemaining(workList.units, unitRows, journalId, "running");
    return {
      ok: true,
      runId,
      stepId: stepState.id,
      unitId: journalId,
      status: "running",
      gateLoop,
      recorded: "heartbeat",
      remainingUnits: remaining,
      runStatus: state.run.status,
      message:
        claimed === "claim"
          ? `Claimed unit "${journalId}" of step "${stepState.id}". Heartbeat again with --status running, then report the result.`
          : `Heartbeat recorded for unit "${journalId}" of step "${stepState.id}".`,
    };
  }

  // ── completed / failed: validate, guard, write, maybe finalize ─────────────
  const { resultJson, failureReason } = prepareResult(input, workUnit);
  const thisTokens = input.tokens ?? 0;

  // Guarded write: the idempotent re-report / replay-divergence check and the
  // budget ceiling are evaluated INSIDE the same SQLite transaction as the
  // insert+finish, so two concurrent reports (same unit, or different units of
  // one budgeted step) serialize on the write lock — each sees the other's row
  // and the row is always internally consistent.
  const status: Exclude<WorkflowRunUnitStatus, "pending" | "running"> = input.status;
  const writeResult = await withWorkflowRunsRepo((repo) =>
    repo.transaction((): UnitWriteOutcome => {
      const existing = repo.getUnit(runId, journalId);
      if (existing?.status === "completed") {
        if (existing.input_hash === inputHash) return { kind: "idempotent" };
        throw new UsageError(
          `Replay divergence: unit "${journalId}" of run ${runId} is already recorded COMPLETED with a different ` +
            `input hash than this report's. Under a frozen plan the same unit identity must reproduce the same ` +
            `inputs — refusing to overwrite. Start a new run to re-execute this work.`,
        );
      }
      // Budget ceilings, journal-seeded exactly as the engine seeds
      // `DispatchBudget` (dispatch rows only — gate rows excluded).
      const verdict = assessBudget(plan, repo.getUnitsForRun(runId), journalId, thisTokens);
      // A `refuse` verdict crosses a ceiling on ADMISSION: the engine would fail
      // this dispatch WITHOUT journaling it. Write nothing; the caller fails the
      // step (matching the engine's terminal state, not a stuck run).
      if (verdict.kind === "refuse") return { kind: "budget-refused", message: verdict.message };

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
      // A `tokens-cross` verdict: this unit's OWN tokens push the run total over
      // `max_tokens`. The engine journals the unit (it dispatched), then aborts
      // and fails the step. The row is written above; the caller fails the step.
      if (verdict.kind === "tokens-cross") return { kind: "budget-tokens", message: verdict.message };
      return { kind: "written" };
    }),
  );

  // Budget REFUSAL: no row written — fail the step hard, naming the ceiling
  // (budget ceilings ignore on_error), so the run reaches the engine's terminal
  // FAILED state rather than getting permanently stuck (peer review R3).
  if (writeResult.kind === "budget-refused") {
    return failStepOnBudget(runId, stepState.id, journalId, status, gateLoop, writeResult.message, false);
  }

  // Events carry ids/status only — never workflow-authored content. Emitted only
  // when a row was actually written (idempotent/normal/token-crossing).
  appendEvent({
    eventType: "workflow_unit_started",
    ref: state.run.workflowRef,
    metadata: { runId, stepId: stepState.id, unitId: journalId, status: "running" },
  });
  appendEvent({
    eventType: "workflow_unit_finished",
    ref: state.run.workflowRef,
    metadata: {
      runId,
      stepId: stepState.id,
      unitId: journalId,
      status,
      ...(failureReason ? { failureReason } : {}),
      ...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
    },
  });

  // Budget TOKEN crossing: the row is written; fail the step hard naming the
  // ceiling (same terminal state as the engine's addTokens abort).
  if (writeResult.kind === "budget-tokens") {
    return failStepOnBudget(runId, stepState.id, journalId, status, gateLoop, writeResult.message, true);
  }

  const idempotent = writeResult.kind === "idempotent";

  // Is the step's work-list now fully terminal? Re-read the journal so a
  // concurrent report of a sibling unit is observed. Unresolvable units are
  // never reportable and count as terminally failed (the engine's
  // expression_error), so they never keep a step outstanding.
  const rowsAfter = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(runId));
  const byUnit = indexDispatchRows(rowsAfter);
  const remaining = remainingReportableUnits(workList, byUnit);

  if (remaining > 0) {
    // Not fully terminal → nothing to finalize. A written report advanced the
    // work-list by one; an idempotent re-report changed nothing.
    return {
      ok: true,
      runId,
      stepId: stepState.id,
      unitId: journalId,
      status,
      gateLoop,
      recorded: idempotent ? "idempotent" : "written",
      remainingUnits: remaining,
      runStatus: state.run.status,
      message: idempotent
        ? `Unit "${journalId}" was already recorded — no change (idempotent re-report). ${remaining} unit(s) still outstanding for step "${stepState.id}".`
        : `Recorded unit "${journalId}" (${status}). ${remaining} unit(s) still outstanding for step "${stepState.id}".`,
    };
  }

  // The work-list is fully terminal. For an idempotent re-report this is EITHER
  // the common case (the step's completion already ran on the first report and
  // the spine has since moved off this step) OR crash recovery: the process died
  // between the last unit write and `completeWorkflowStep`, so every unit is
  // journaled-terminal but the step never advanced. Re-read the spine: only when
  // this step is STILL the active, pending step is there completion left to run —
  // and then ANY driver (not just the engine) must be able to finalize it, or the
  // step is permanently un-advanceable through brief/report (peer review R3,
  // engine/driver crash-recovery symmetry). If the spine already moved past this
  // step, a concurrent report finalized it first and this is a true no-op.
  if (idempotent) {
    const fresh = await getNextWorkflowStep(runId);
    if (fresh.run.status !== "active" || fresh.step?.id !== stepState.id) {
      return {
        ok: true,
        runId,
        stepId: stepState.id,
        unitId: journalId,
        status,
        gateLoop,
        recorded: "idempotent",
        remainingUnits: 0,
        runStatus: fresh.run.status,
        message: `Unit "${journalId}" was already recorded — no change (idempotent re-report).`,
      };
    }
  }

  // Fully terminal AND this step still needs completion → run the SHARED
  // completion path (identical for a first report and a crash-recovering
  // idempotent re-report).
  return finalizeStep({
    runId,
    next: state,
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
    recorded: idempotent ? "idempotent" : "written",
  });
}

// ── Active-step resolution (shared) ──────────────────────────────────────────

/** The resolved report target: the active step, its frozen plan, and its work-list. */
interface StepContext {
  next: WorkflowNextResult;
  stepState: NonNullable<WorkflowNextResult["step"]>;
  stepPlan: IrStepPlan;
  /** The computed work-list, or `null` for a non-dispatching step (route-only / whole-list failure). */
  workList: StepWorkList | null;
  /** Set when `workList` is null because the fan-out list itself failed to resolve. */
  computeError?: string;
  gateLoop: number;
  priorEvidence: Record<string, Record<string, unknown> | undefined>;
  units: WorkflowRunUnitRow[];
  /** True when the step has ≥1 reportable (resolvable) unit — a driver can report it. */
  dispatching: boolean;
}

/**
 * Compute the report context for a run's active step: find the frozen step plan,
 * project prior evidence, recover the gate loop + feedback, and compute the
 * SHARED work-list (same ids/hashes/prompts the engine and `brief` compute).
 * `dispatching` is false for the non-dispatching steps the engine auto-advances
 * (route-only, empty fan-out, all-unresolvable, whole-list failure) — the report
 * path settles past those rather than getting stuck at a step no `report --unit`
 * can complete.
 */
function buildStepContext(
  runId: string,
  plan: WorkflowPlanGraph,
  next: WorkflowNextResult,
  units: WorkflowRunUnitRow[],
): StepContext {
  const stepState = next.step;
  if (!stepState) {
    throw new UsageError(`Workflow run ${runId} is active but has no current step to report against.`);
  }
  const stepPlan = plan.steps.find((s) => s.stepId === stepState.id);
  if (!stepPlan) {
    throw new UsageError(
      `Step "${stepState.id}" of run ${runId} is not present in the run's frozen plan — cannot report against it.`,
    );
  }
  const priorEvidence: Record<string, Record<string, unknown> | undefined> = {};
  for (const s of next.workflow.steps) priorEvidence[s.id] = s.evidence;
  const stepOutputs = stepOutputsFromEvidence(priorEvidence);
  const gateLoop = activeGateLoop(units, stepState.id);
  const gateFeedback = recoverGateFeedback(units, stepState.id, gateLoop);

  // Route-only steps carry no execution subgraph — nothing to report.
  if (!stepPlan.root) {
    return { next, stepState, stepPlan, workList: null, gateLoop, priorEvidence, units, dispatching: false };
  }

  const computed = computeStepWorkList(stepPlan, {
    runId,
    params: next.run.params ?? {},
    stepOutputs,
    gateLoop,
    ...(gateFeedback ? { gateFeedback } : {}),
  });
  if (!computed.ok) {
    return {
      next,
      stepState,
      stepPlan,
      workList: null,
      computeError: computed.error,
      gateLoop,
      priorEvidence,
      units,
      dispatching: false,
    };
  }
  const workList = computed.list;
  // A step is dispatching only if a driver can actually report ≥1 unit: an empty
  // fan-out or an all-unresolvable work-list has nothing to report.
  const dispatching = workList.units.some((u) => u.resolved.ok);
  return { next, stepState, stepPlan, workList, gateLoop, priorEvidence, units, dispatching };
}

// ── Step finalization (shared path) ──────────────────────────────────────────

/** The normalized decision of ONE step-completion attempt (engine parity). */
type StepCompletion =
  | { kind: "advanced" }
  | { kind: "failed"; summary: string }
  | { kind: "gate-rejected"; loopsRemaining: boolean; missing: string[]; feedback: string };

/**
 * Rebuild a step's unit outcomes from the journal and reduce them through the
 * SAME functions the executor uses. An EMPTY work-list promotes the degenerate
 * empty artifact ({@link reduceEmptyStep}); otherwise each unit is rehydrated
 * from its journal row, and an UNRESOLVABLE unit (a bad `item.<path>` reference)
 * is treated as the engine's immediate `expression_error` failure — never
 * journaled, always reduced as a failed outcome — so a partially- or fully-
 * unresolvable step reduces identically on both surfaces.
 */
function reduceWorkListOutcomes(
  stepPlan: IrStepPlan,
  workList: StepWorkList,
  byUnit: Map<string, WorkflowRunUnitRow>,
): ExecutedStepOutcome {
  if (workList.units.length === 0) {
    return reduceEmptyStep(stepPlan, workList.reducer);
  }
  const outcomes: UnitOutcome[] = workList.units.map((u) => {
    if (!u.resolved.ok) {
      return { unitId: u.unitId, ok: false, failureReason: "expression_error", error: u.resolved.error };
    }
    const row = byUnit.get(u.journalBaseId);
    return unitOutcomeFromRow(u.unitId, row as WorkflowRunUnitRow, u.schema !== undefined);
  });
  return reduceStepOutcomes(stepPlan, workList.reducer, workList.isFanOut, workList.template.onError, outcomes);
}

/**
 * Run ONE completion attempt for a reduced step outcome through the SHARED
 * {@link finalizeExecutedStep} (route eval → artifact-judged gate → gate-row
 * journaling → `completeWorkflowStep`), normalizing its result. A typed-artifact
 * schema mismatch is a HARD failure on the report surface (documented call:
 * the ENGINE recovers it from in-invocation memory, but no gate row is
 * journaled, so the stateless report path cannot recover the feedback across
 * invocations — and synthesizing a gate row would break engine/report unit-graph
 * parity). A GATE rejection journals its `<stepId>.gate:l<loop>` row, so its
 * feedback IS recoverable and stays a real bounded loop.
 */
async function runStepCompletion(args: {
  runId: string;
  workflowRef: string;
  stepPlan: IrStepPlan;
  stepId: string;
  completionCriteria: string[];
  gateLoop: number;
  reduced: ExecutedStepOutcome;
  priorEvidence: Record<string, Record<string, unknown> | undefined>;
  params: Record<string, unknown>;
  routeSelected: Set<string>;
  routeUnselected: Map<string, RouteSkipInfo>;
  summaryJudge: SummaryJudge | null | undefined;
}): Promise<StepCompletion> {
  const maxLoops = Math.max(1, args.stepPlan.gate.maxLoops ?? 1);
  const finalize = await finalizeExecutedStep({
    runId: args.runId,
    workflowRef: args.workflowRef,
    stepId: args.stepId,
    stepPlan: args.stepPlan,
    completionCriteria: args.completionCriteria,
    gateLoop: args.gateLoop,
    loopsRemaining: args.gateLoop < maxLoops,
    result: args.reduced,
    priorEvidence: args.priorEvidence,
    params: args.params,
    routeSelected: args.routeSelected,
    routeUnselected: args.routeUnselected,
    summaryJudge: args.summaryJudge,
  });

  if (finalize.kind === "retry") {
    if (!args.reduced.ok) {
      // Typed-artifact schema mismatch → hard failure on the report surface.
      await completeWorkflowStep({
        runId: args.runId,
        stepId: args.stepId,
        status: "failed",
        notes: args.reduced.summary,
        evidence: args.reduced.evidence,
      });
      return { kind: "failed", summary: args.reduced.summary };
    }
    return {
      kind: "gate-rejected",
      loopsRemaining: true,
      missing: finalize.gateFeedback.missing,
      feedback: finalize.gateFeedback.feedback,
    };
  }
  if (finalize.kind === "gate-exhausted") {
    return {
      kind: "gate-rejected",
      loopsRemaining: false,
      missing: finalize.gateRejection.missing,
      feedback: finalize.gateRejection.feedback,
    };
  }
  if (finalize.kind === "failed") {
    return { kind: "failed", summary: finalize.summary };
  }
  return { kind: "advanced" };
}

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
  /** How the triggering unit write resolved — surfaced verbatim on the result. */
  recorded: "written" | "idempotent";
}): Promise<WorkflowReportResult> {
  const { runId, next, plan, stepPlan, stepState, workList, byUnit, gateLoop, recorded } = args;
  const reduced = reduceWorkListOutcomes(stepPlan, workList, byUnit);

  // Route/skip bookkeeping seeded from the journal so cascaded skips survive
  // (identical to the engine's resume seeding).
  const routeSelected = new Set<string>();
  const routeUnselected = new Map<string, RouteSkipInfo>();
  seedJournaledRouteDecisions(plan, next, routeSelected, routeUnselected);

  const completion = await runStepCompletion({
    runId,
    workflowRef: next.run.workflowRef,
    stepPlan,
    stepId: stepState.id,
    completionCriteria: stepState.completionCriteria ?? [],
    gateLoop,
    reduced,
    priorEvidence: args.priorEvidence,
    params: next.run.params ?? {},
    routeSelected,
    routeUnselected,
    summaryJudge: args.summaryJudge,
  });
  const maxLoops = Math.max(1, stepPlan.gate.maxLoops ?? 1);

  if (completion.kind === "failed") {
    const state = await getNextWorkflowStep(runId);
    return reportResult(
      runId,
      stepState.id,
      args.written,
      gateLoop,
      state.run.status,
      { kind: "failed", summary: completion.summary },
      `Step "${stepState.id}" failed: ${completion.summary}`,
      recorded,
    );
  }

  if (completion.kind === "gate-rejected") {
    if (completion.loopsRemaining) {
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
          missing: completion.missing,
          feedback: completion.feedback,
          summary: completion.feedback,
        },
        `Step "${stepState.id}" was rejected — run \`akm workflow brief ${runId}\` for loop ${nextLoop}'s work-list (feedback threaded in).`,
        recorded,
      );
    }
    return reportResult(
      runId,
      stepState.id,
      args.written,
      gateLoop,
      "active",
      {
        kind: "gate-rejected",
        loopsRemaining: false,
        missing: completion.missing,
        feedback: completion.feedback,
        summary: completion.feedback,
      },
      `Step "${stepState.id}" was rejected and its ${maxLoops}-loop gate budget is exhausted. Resolve it manually (\`akm workflow complete\`/\`resume\`/\`abandon\`).`,
      recorded,
    );
  }

  // advanced — the spine moved. Settle forward over any non-dispatching steps
  // (route-only / skipped / empty fan-out / all-unresolvable) so the run never
  // gets stuck at a step no driver could report, then surface the resting state.
  const state = await settleSpine({ plan, runId, summaryJudge: args.summaryJudge });
  const message =
    state.run.status === "completed"
      ? `Step "${stepState.id}" completed — the workflow run is now DONE.`
      : state.step
        ? `Step "${stepState.id}" completed. Next: run \`akm workflow brief ${runId}\` for step "${state.step.id}".`
        : `Step "${stepState.id}" completed; run is ${state.run.status}.`;
  return reportResult(
    runId,
    stepState.id,
    args.written,
    gateLoop,
    state.run.status,
    { kind: "advanced" },
    message,
    recorded,
  );
}

/**
 * Settle the spine forward over every NON-DISPATCHING step the engine would
 * auto-advance but no `report --unit` could ever complete: a route-skipped
 * target, a route-only step, an empty fan-out (`over: []`), a step whose every
 * unit is unresolvable, and a whole-list resolution failure. Each is completed
 * (or failed) through the SAME shared helpers the engine uses, so the run does
 * not get stuck — the exact gap peer review R3 flagged. Stops at the first step
 * with real reportable work, or when the run leaves `active`.
 */
async function settleSpine(args: {
  plan: WorkflowPlanGraph;
  runId: string;
  summaryJudge: SummaryJudge | null | undefined;
}): Promise<WorkflowNextResult> {
  const { plan, runId, summaryJudge } = args;
  let state = await getNextWorkflowStep(runId);
  const routeSelected = new Set<string>();
  const routeUnselected = new Map<string, RouteSkipInfo>();
  seedJournaledRouteDecisions(plan, state, routeSelected, routeUnselected);

  // Bounded: each iteration advances the spine by one step OR advances one gate
  // loop of a stuck gated step (which journals a gate row and is capped by that
  // step's max_loops). The sum-of-loops bound cannot be exceeded.
  const cap = plan.steps.reduce((n, s) => n + Math.max(1, s.gate.maxLoops ?? 1) + 2, 1);
  for (let guard = 0; guard < cap && state.run.status === "active" && state.step; guard++) {
    const step = state.step;
    const sp = plan.steps.find((s) => s.stepId === step.id);
    if (!sp) break;

    // A route-skipped target: complete it as skipped, cascading if it is itself
    // a router (identical to the engine loop's skip handling).
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

    // A route-only step (no execution subgraph): evaluate + complete it here.
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

    // An executing step. Settle it ONLY when it dispatches no reportable units
    // (empty fan-out, all-unresolvable, or a whole-list failure); otherwise the
    // driver briefs and reports it, so stop here.
    if (sp.root) {
      const freshUnits = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(runId));
      const priorEvidence: Record<string, Record<string, unknown> | undefined> = {};
      for (const s of state.workflow.steps) priorEvidence[s.id] = s.evidence;
      const stepOutputs = stepOutputsFromEvidence(priorEvidence);
      const gateLoop = activeGateLoop(freshUnits, step.id);
      const gateFeedback = recoverGateFeedback(freshUnits, step.id, gateLoop);
      const computed = computeStepWorkList(sp, {
        runId,
        params: state.run.params ?? {},
        stepOutputs,
        gateLoop,
        ...(gateFeedback ? { gateFeedback } : {}),
      });
      if (!computed.ok) {
        // Whole-list resolution failure → the engine fails the step (failedStep).
        await completeWorkflowStep({
          runId,
          stepId: step.id,
          status: "failed",
          notes: computed.error,
          evidence: { error: computed.error },
        });
        break; // run failed
      }
      const list = computed.list;
      if (list.units.some((u) => u.resolved.ok)) break; // real reportable work — stop.

      // No reportable units (empty fan-out OR all-unresolvable). Auto-complete
      // it exactly as the engine would, through the SAME completion path.
      const byUnit = indexDispatchRows(freshUnits);
      const reduced = reduceWorkListOutcomes(sp, list, byUnit);
      const completion = await runStepCompletion({
        runId,
        workflowRef: state.run.workflowRef,
        stepPlan: sp,
        stepId: step.id,
        completionCriteria: step.completionCriteria ?? [],
        gateLoop,
        reduced,
        priorEvidence,
        params: state.run.params ?? {},
        routeSelected,
        routeUnselected,
        summaryJudge,
      });
      if (completion.kind === "advanced") {
        state = await getNextWorkflowStep(runId);
        continue;
      }
      // A gate rejection on a zero-unit step re-runs the (unchanged) empty
      // artifact, but the journaled gate row advances the loop, so the next
      // iteration re-evaluates at gateLoop+1, bounded by max_loops. Loop the
      // SAME step WITHOUT advancing the spine.
      if (completion.kind === "gate-rejected" && completion.loopsRemaining) continue;
      // failed / gate-exhausted → nothing more to auto-advance.
      break;
    }

    break;
  }
  // Re-read the freshest run state: a terminal-break path (a failed step, an
  // exhausted gate) left `state` reflecting the pre-completion snapshot from the
  // top of the loop iteration, but the DB now holds the true resting state.
  return getNextWorkflowStep(runId);
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
  // Free-text unit: journal the text as a JSON string EXACTLY as the executor
  // does — `native-executor.ts` finishUnit uses `outcome.text ? JSON.stringify… :
  // null`, so an empty (or absent) output journals result_json = NULL, not '""'.
  // Matching that keeps the promoted artifact and the dispatch row byte-identical
  // across the engine and report surfaces (the cardinal graph-parity rule), and
  // stays consistent with the FAILED branch above which also maps ""→null.
  return { resultJson: input.resultRaw ? JSON.stringify(input.resultRaw) : null, failureReason: null };
}

/** How the guarded unit write resolved inside the SQLite transaction. */
type UnitWriteOutcome =
  | { kind: "written" }
  | { kind: "idempotent" }
  /** A ceiling was crossed on ADMISSION — no row written; the caller fails the step. */
  | { kind: "budget-refused"; message: string }
  /** This unit's own tokens crossed `max_tokens` — the row IS written; the caller fails the step. */
  | { kind: "budget-tokens"; message: string };

/** A declared-budget verdict for a single report, seeded from the journal. */
type BudgetVerdict = { kind: "ok" } | { kind: "refuse"; message: string } | { kind: "tokens-cross"; message: string };

/**
 * Assess the frozen plan's declared budget ceilings for ONE report, seeded from
 * the journal exactly as the engine seeds `DispatchBudget`: dispatch rows
 * (phase = null) OTHER than the one being written count against `max_units`, and
 * their token sum against `max_tokens`. Unlike a simple admission check, this
 * mirrors the engine's TWO enforcement points so the report path reaches the
 * engine's terminal state (a HARD step failure naming the ceiling) instead of
 * throwing and leaving the run stuck (peer review R3, finding 1):
 *
 *   - `refuse` — the engine's `tryConsume` refuses the (maxUnits+1)-th dispatch,
 *     or a dispatch whose run token total is already at/over `max_tokens`,
 *     WITHOUT journaling it. The report writes no row and fails the step.
 *   - `tokens-cross` — the engine's `addTokens` crosses `max_tokens` AFTER a
 *     dispatch: the unit IS journaled, then pending dispatches abort and the
 *     step fails. The report writes the row, then fails the step.
 *
 * Budget ceilings fail the step regardless of `on_error` — a capped run must
 * never quietly pass its gate.
 */
function assessBudget(
  plan: WorkflowPlanGraph,
  rows: WorkflowRunUnitRow[],
  journalId: string,
  thisTokens: number,
): BudgetVerdict {
  const budget = plan.budget;
  if (!budget || (budget.maxUnits === undefined && budget.maxTokens === undefined)) return { kind: "ok" };
  let dispatched = 0;
  let tokens = 0;
  for (const row of rows) {
    if (row.phase !== null) continue; // gate rows excluded
    if (row.unit_id === journalId) continue; // the row being (re)written
    dispatched++;
    tokens += row.tokens ?? 0;
  }
  if (budget.maxUnits !== undefined && dispatched >= budget.maxUnits) {
    return {
      kind: "refuse",
      message:
        `budget exceeded (max_units ceiling): ${dispatched} unit(s) already dispatched for this run against the ` +
        `workflow's declared budget.max_units of ${budget.maxUnits} — the step fails hard (budget ceilings ignore on_error).`,
    };
  }
  if (budget.maxTokens !== undefined && tokens >= budget.maxTokens) {
    return {
      kind: "refuse",
      message:
        `budget exceeded (max_tokens ceiling): ${tokens} token(s) already spent for this run against the workflow's ` +
        `declared budget.max_tokens of ${budget.maxTokens} — the step fails hard (budget ceilings ignore on_error).`,
    };
  }
  if (budget.maxTokens !== undefined && tokens + thisTokens >= budget.maxTokens) {
    return {
      kind: "tokens-cross",
      message:
        `budget exceeded (max_tokens ceiling): ${tokens + thisTokens} token(s) spent for this run, reaching the ` +
        `workflow's declared budget.max_tokens of ${budget.maxTokens} — the step fails hard (budget ceilings ignore on_error).`,
    };
  }
  return { kind: "ok" };
}

/**
 * Fail the active step because a declared budget ceiling was crossed — the same
 * terminal state the engine reaches (`failedStep` → a FAILED step and run). The
 * failure goes through `completeWorkflowStep` (the gate spine is never bypassed)
 * with the ceiling-naming message as notes/evidence. `wroteRow` reflects whether
 * the crossing unit's row was journaled (a `tokens-cross`) or not (a `refuse`).
 */
async function failStepOnBudget(
  runId: string,
  stepId: string,
  journalId: string,
  status: WorkflowRunUnitStatus,
  gateLoop: number,
  message: string,
  wroteRow: boolean,
): Promise<WorkflowReportResult> {
  await completeWorkflowStep({ runId, stepId, status: "failed", notes: message, evidence: { error: message } });
  const state = await getNextWorkflowStep(runId);
  return {
    ok: true,
    runId,
    stepId,
    unitId: journalId,
    status,
    gateLoop,
    recorded: wroteRow ? "written" : "not-recorded",
    remainingUnits: 0,
    stepOutcome: { kind: "failed", summary: message },
    runStatus: state.run.status,
    message: `Step "${stepId}" failed: ${message}`,
  };
}

/**
 * The result surfaced when settling non-dispatching steps drove the run to a
 * terminal (or step-less) state before the reported unit could be recorded —
 * the run advanced/failed on its own, so there is nothing left to journal.
 */
function settledTerminalResult(input: ReportUnitInput, settled: WorkflowNextResult): WorkflowReportResult {
  const runStatus = settled.run.status;
  const message =
    runStatus === "completed"
      ? `The run advanced to completion while settling steps with no reportable work; unit "${input.unitId}" needed no report.`
      : `The run is ${runStatus} after settling steps with no reportable work; unit "${input.unitId}" could not be recorded.`;
  return {
    ok: true,
    runId: settled.run.id,
    stepId: settled.run.currentStepId ?? "(none)",
    unitId: input.unitId,
    status: input.status,
    gateLoop: 1,
    recorded: "not-recorded",
    remainingUnits: 0,
    stepOutcome: runStatus === "completed" ? { kind: "advanced" } : { kind: "failed", summary: message },
    runStatus,
    message,
  };
}

/**
 * Count the step's units that are still OUTSTANDING: resolvable units without a
 * terminal journal row. Unresolvable units are never reportable (the engine's
 * immediate `expression_error`), so they never keep a step outstanding — the
 * caller's reduction treats them as failed outcomes.
 */
function remainingReportableUnits(workList: StepWorkList, byUnit: Map<string, WorkflowRunUnitRow>): number {
  return workList.units.filter((u) => {
    if (!u.resolved.ok) return false;
    const row = byUnit.get(u.journalBaseId);
    return !(row && (row.status === "completed" || row.status === "failed"));
  }).length;
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
    // Unresolvable units are never reportable (the engine's expression_error), so
    // they never count as outstanding.
    if (!u.resolved.ok) return false;
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
  recorded: "written" | "idempotent" = "written",
): WorkflowReportResult {
  return {
    ok: true,
    runId,
    stepId,
    unitId: written.unitId,
    status: written.status,
    gateLoop,
    recorded,
    remainingUnits: 0,
    stepOutcome,
    runStatus,
    message,
  };
}
