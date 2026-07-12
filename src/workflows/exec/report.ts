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

import { randomUUID } from "node:crypto";
import { UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { validateJsonSchemaSubset } from "../../core/json-schema";
import { acquireMaintenanceActivity } from "../../core/maintenance-barrier";
import { isEnvPassthroughValueSafeToExpose, redactSensitiveText, redactSensitiveValue } from "../../core/redaction";
import type { WorkflowRunStatus } from "../../sources/types";
import {
  type WorkflowRunUnitRow,
  type WorkflowRunUnitStatus,
  withWorkflowRunsRepo,
} from "../../storage/repositories/workflow-runs-repository";
import { assertRunParamsSatisfyPlan } from "../ir/params";
import type { IrStepPlan, WorkflowPlanGraph } from "../ir/schema";
import { PROGRAM_RETRY_REASONS } from "../program/schema";
import { requireExecutableWorkflowPlan } from "../runtime/plan-classifier";
import {
  completeWorkflowStep,
  getNextWorkflowStep,
  snapshotRunForDriver,
  type WorkflowNextResult,
} from "../runtime/runs";
import { UNIT_STALE_MS } from "../runtime/unit-checkin";
import type { SummaryJudge } from "../validate-summary";
import { buildLease, resolveRunId } from "./brief";
import { frozenSummaryJudge } from "./frozen-judge";
import {
  activeGateLoop,
  cascadeSkippedRouter,
  computeStepWorkList,
  type ExecutedStepOutcome,
  finalizeExecutedStep,
  isRetryEligibleFailure,
  type RouteSkipInfo,
  recoverGateFeedback,
  reduceEmptyStep,
  reduceStepOutcomes,
  type StepWorkList,
  type StepWorkUnit,
  seedJournaledRouteDecisions,
  selectUnitAttemptRow,
  stepOutputsFromEvidence,
  type UnitOutcome,
  unitOutcomeFromRow,
  unitStillNeedsReport,
} from "./step-work";

// ── Public contract ──────────────────────────────────────────────────────────

export interface ReportUnitInput {
  /** Workflow run id (or a workflow ref with an active run). */
  target: string;
  /** Content-derived unit id from `brief` (the BASE id — copy it verbatim). */
  unitId: string;
  status: "completed" | "failed" | "running";
  /**
   * Optional spine guard (PR #714 review round 2, #14): the step id the driver
   * BELIEVES is active (echoed from the `brief` it planned against, embedded in
   * every brief `report` command as `--expect-step`). When the run's active step
   * no longer matches — a concurrent report/run/manual completion moved the
   * spine between brief and report — the report is refused with a clear message
   * instead of silently recording against the wrong step.
   */
  expectStep?: string;
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
  /**
   * Re-run an already-FAILED unit (review round 2, #25). A FAILED terminal row
   * is idempotence-protected: a re-report with a DIFFERING result is refused
   * unless `rerun` is set, which journals a NEW attempt (attempts increment,
   * budget admission re-applies). A same-content re-report of a failed row stays
   * an idempotent no-op regardless.
   */
  rerun?: boolean;
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
  kind: "advanced" | "failed" | "gate-rejected" | "blocked";
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
  /**
   * The claim minted/refreshed by a `--status running` report (review round 2,
   * #3). `holder` is the driver's `--session-id` or a token report generated;
   * the driver reuses it as `--session-id` on subsequent heartbeats and the
   * final `completed`/`failed` report so the claim's compare-and-set matches.
   */
  claim?: { holder: string; expiresAt: string };
  message: string;
}

/**
 * Claim time-to-live. Equal to the unit-checkin stale window
 * ({@link UNIT_STALE_MS}) so a claim expires at exactly the moment
 * `workflow brief` starts surfacing the unit as stale — an expired claim is,
 * by construction, a stale-driver claim another driver may reclaim.
 */
const CLAIM_TTL_MS = UNIT_STALE_MS;

/**
 * Finalization-lock TTL (review round 2, #5). The finalize path claims the run's
 * engine lease as a short-lived lock so exactly ONE reporter runs a step's
 * completion. Sized like the run lease; the loser never runs the judge (it
 * returns idempotent success on a failed acquire), so the TTL only bounds crash
 * recovery — and `completeWorkflowStep`'s own transactional CAS remains the true
 * arbiter of the single spine advance regardless.
 */
const FINALIZE_LOCK_TTL_MS = 90_000;

// ── Entry point ──────────────────────────────────────────────────────────────

export async function reportWorkflowUnit(input: ReportUnitInput): Promise<WorkflowReportResult> {
  const release = await acquireMaintenanceActivity("workflow-report");
  try {
    return await reportWorkflowUnitWithBarrier(input);
  } finally {
    release();
  }
}

async function reportWorkflowUnitWithBarrier(input: ReportUnitInput): Promise<WorkflowReportResult> {
  const nowFn = input.now ?? (() => new Date());
  const nowIso = nowFn().toISOString();

  const runId = await resolveRunId(input.target);
  // #14: read the spine, run row, and unit journal in ONE snapshot so the guards
  // below see a consistent point-in-time state (same fix as `brief`).
  const { next, run: runRow, units } = await snapshotRunForDriver(runId);
  const leaseHolder = runRow.engine_lease_holder;
  const leaseUntil = runRow.engine_lease_until;

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

  // #14: the optional spine guard. `brief` embeds `--expect-step <activeStep>` in
  // every report command; if the active step has since changed, refuse rather
  // than record against a step the driver did not plan against.
  if (input.expectStep !== undefined && next.step.id !== input.expectStep) {
    throw new UsageError(
      `Workflow run ${runId} is now on step "${next.step.id}", not "${input.expectStep}" (--expect-step). The spine ` +
        `moved since you briefed it — a concurrent report/run/manual completion advanced the run. Re-run ` +
        `\`akm workflow brief ${runId}\` and report against the current step.`,
      "INVALID_FLAG_VALUE",
    );
  }

  const plan = requireExecutableWorkflowPlan(runRow);
  // Reviewer #12: the journaled params row must still satisfy the frozen param
  // schemas before report resolves any unit prompt from it — a violation is
  // post-start corruption, refused loudly (mirrors the frozen-plan hash check
  // and the tampered-params replay-divergence path).
  assertRunParamsSatisfyPlan(runId, plan, next.run.params ?? {});

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
  if (!workUnit.engine || !workUnit.invocation) {
    throw new UsageError(`Unit "${workUnit.unitId}" has no complete frozen engine attribution.`);
  }
  const engineName = workUnit.engine.name;
  const exactModel = workUnit.invocation.model;
  const inputHash = workUnit.resolved.inputHash;
  const journalId = workUnit.journalBaseId;

  // ── running: claim / heartbeat, never advances the spine ───────────────────
  if (input.status === "running") {
    // The claim holder: the driver's --session-id, else a token we mint and
    // return so the driver can reuse it (as --session-id) to heartbeat and
    // finish the SAME claim. First unexpired claim wins.
    const holder = input.sessionId ?? `claim:${randomUUID()}`;
    const claimExpiresAt = new Date(nowFn().getTime() + CLAIM_TTL_MS).toISOString();
    const claimed = await withWorkflowRunsRepo((repo) =>
      repo.transaction((): "claim" | "heartbeat" => {
        const existing = repo.getUnit(runId, journalId);
        if (existing && (existing.status === "completed" || existing.status === "failed")) {
          throw new UsageError(
            `Unit "${journalId}" of run ${runId} is already ${existing.status} — cannot claim a terminal unit as ` +
              `running. Report a fresh result with --status completed|failed, or start a new run to redo it.`,
          );
        }
        if (existing) {
          // Stale-hash guard (#3): a running row whose recorded input_hash no
          // longer matches the recomputed one is a replay divergence (a
          // tampered/stale claim under a frozen plan) — refuse to heartbeat it.
          assertNoHashDivergence(existing, inputHash, runId, journalId);
          // Compare-and-set the claim owner: a LIVE claim held by a DIFFERENT
          // holder blocks reclaim; an expired one (or a claim already ours) is
          // (re)claimable. First unexpired claim wins (crash recovery on expiry).
          assertClaimHeldByOrFree(existing, holder, nowIso, runId, journalId, "heartbeat");
          repo.updateUnitClaim(runId, journalId, holder, claimExpiresAt, nowIso);
          return "heartbeat";
        }
        repo.insertUnit({
          runId,
          unitId: journalId,
          stepId: stepState.id,
          nodeId: workUnit.nodeId,
          parentUnitId: workUnit.isFanOut ? `${stepState.id}.map` : null,
          phase: null,
          runner: workUnit.runner,
          engine: engineName,
          model: exactModel,
          inputHash,
          startedAt: nowIso,
          claimHolder: holder,
          claimExpiresAt,
        });
        repo.updateUnitClaim(runId, journalId, holder, claimExpiresAt, nowIso);
        return "claim";
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
      claim: { holder, expiresAt: claimExpiresAt },
      message:
        claimed === "claim"
          ? `Claimed unit "${journalId}" of step "${stepState.id}" as ${holder} (until ${claimExpiresAt}). ` +
            `Reuse --session-id ${holder} to heartbeat, then report the result.`
          : `Heartbeat recorded for unit "${journalId}" of step "${stepState.id}" (claim ${holder} extended to ${claimExpiresAt}).`,
    };
  }

  // ── completed / failed: validate, guard, write, maybe finalize ─────────────
  const sensitiveValues = await collectReportedUnitSensitiveValues(workUnit);
  const { resultJson, failureReason } = prepareResult(input, workUnit, sensitiveValues);
  const thisTokens = input.tokens ?? 0;

  // Guarded write: the idempotent re-report / replay-divergence check and the
  // budget ceiling are evaluated INSIDE the same SQLite transaction as the
  // insert+finish, so two concurrent reports (same unit, or different units of
  // one budgeted step) serialize on the write lock — each sees the other's row
  // and the row is always internally consistent.
  const status: Exclude<WorkflowRunUnitStatus, "pending" | "running"> = input.status;
  const holder = input.sessionId ?? null;
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
      // A FAILED terminal row is idempotence-protected (#25): the same content
      // re-reported is a no-op; a DIFFERING re-report is refused unless --rerun
      // is set, which records a NEW attempt (insertUnit REPLACE bumps attempts,
      // budget admission re-applies below). A frozen-plan hash mismatch is a hard
      // replay divergence regardless of --rerun.
      if (existing?.status === "failed") {
        assertNoHashDivergence(existing, inputHash, runId, journalId);
        if (!input.rerun) {
          const sameOutcome =
            status === "failed" && existing.result_json === resultJson && existing.failure_reason === failureReason;
          if (sameOutcome) return { kind: "idempotent" };
          throw new UsageError(
            `Unit "${journalId}" of run ${runId} is already recorded FAILED. Re-reporting it with a different result ` +
              `requires an explicit --rerun (which records a NEW attempt and re-applies the declared budget). Without ` +
              `--rerun a differing re-report is refused; a same-content re-report is an idempotent no-op.`,
          );
        }
      }
      // A `running` row being finalized: the stale-hash guard (#3) refuses a
      // tampered/stale claim whose input_hash diverges, and the claim
      // compare-and-set requires the matching holder while the claim is live (a
      // claimless row, or an expired claim, finishes freely — simple drivers).
      if (existing?.status === "running") {
        assertNoHashDivergence(existing, inputHash, runId, journalId);
        assertClaimHeldByOrFree(existing, holder, nowIso, runId, journalId, "finish");
      }
      // Budget ceilings, journal-seeded exactly as the engine seeds
      // `DispatchBudget` (dispatch rows only — gate rows excluded). The existing
      // row's already-spent attempts are counted before admission (#4), then this
      // write's own increment is added, so overwriting a prior attempt never
      // erases it from the ceiling.
      const verdict = assessBudget(plan, repo.getUnitsForRun(runId), journalId, thisTokens, existing);
      // A `refuse` verdict crosses a ceiling on ADMISSION: the engine would fail
      // this dispatch WITHOUT journaling it. Write nothing; the caller fails the
      // step (matching the engine's terminal state, not a stuck run).
      if (verdict.kind === "refuse") return { kind: "budget-refused", message: verdict.message };

      // Journal the dispatch row, then finalize it. When this unit was already
      // claimed with `--status running`, its row exists with the SAME dispatch
      // metadata this insert would write; re-inserting would bump `attempts`
      // (migration 008) and count the claim+report of ONE execution as two
      // dispatches — inflating budget accounting relative to the engine, which
      // does a single `insertUnit` per dispatch. So skip the insert for a live
      // `running` claim (finishUnit below finalizes it, `attempts` unchanged);
      // a fresh report with no claim, or a re-dispatch over a prior FAILED row,
      // still (re)inserts and is charged an attempt.
      if (existing?.status !== "running") {
        repo.insertUnit({
          runId,
          unitId: journalId,
          stepId: stepState.id,
          nodeId: workUnit.nodeId,
          parentUnitId: workUnit.isFanOut ? `${stepState.id}.map` : null,
          phase: null,
          runner: workUnit.runner,
          engine: engineName,
          model: exactModel,
          inputHash,
          startedAt: existing?.started_at ?? nowIso,
        });
      }
      // Run-lifetime token accounting (Codex round-3 finding A). `finishUnit`
      // OVERWRITES the row's `tokens` column, so a `--rerun` over a prior FAILED
      // attempt would otherwise ERASE that attempt's already-spent tokens from
      // the run total — a budgeted run could spend 80 tokens on a failed report,
      // rerun for 30 more under `max_tokens: 100`, and pass because only 30 were
      // retained. The engine never hits this (its retries journal SEPARATE `~r`
      // rows, each keeping its own tokens). To match, the `tokens` column on a
      // re-dispatched row carries the CUMULATIVE spend across the row's attempts,
      // mirroring how `attempts` accumulates: budget seeds that sum this column
      // then see ALL tokens ever spent on the unit. A fresh write or a live
      // `running`-claim finish (no prior tokens on the row) keeps the plain
      // per-attempt value — and NULL when no tokens were reported — so the engine
      // parity graph (which journals NULL for a usage-less unit) is unchanged.
      const priorTokens = existing?.tokens ?? 0;
      const carriedTokens = priorTokens > 0 ? priorTokens + thisTokens : (input.tokens ?? null);
      repo.finishUnit({
        runId,
        unitId: journalId,
        status,
        resultJson,
        tokens: carriedTokens,
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
    // Fail-fast (Codex round-3 finding B). Under the default `on_error: fail` a
    // single TERMINAL unit failure already fixes the step's verdict: the shared
    // reducer maps ANY unit failure to a failed step, so the outstanding siblings
    // cannot change the outcome. Waiting for them (the pre-fix behavior) only
    // strands the run forever when a driver stops after its first failure. So a
    // failed report finalizes the step NOW — through the SAME completion path +
    // finalize CAS as a fully-terminal work-list — instead of returning as
    // outstanding. Exceptions kept identical to the engine: `on_error: continue`
    // always waits for the full work-list; a RETRY-ELIGIBLE failure is not yet
    // terminal (the unit may still be re-run under its retry budget — the
    // `--rerun` form brief advertises, mirroring the engine's `~r<n>` retry), so
    // it too keeps waiting; and an idempotent re-report changed nothing to act on.
    if (
      status === "failed" &&
      !idempotent &&
      workList.template.onError === "fail" &&
      !isRetryEligibleFailure(workUnit, byUnit.get(journalId), failureReason)
    ) {
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
        summaryJudge:
          input.summaryJudge === undefined ? frozenSummaryJudge(plan, stepPlan.gate.judge) : input.summaryJudge,
        now: nowFn,
        written: { unitId: journalId, status },
        recorded: "written",
      });
    }
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
    summaryJudge: input.summaryJudge === undefined ? frozenSummaryJudge(plan, stepPlan.gate.judge) : input.summaryJudge,
    now: nowFn,
    written: { unitId: journalId, status },
    recorded: idempotent ? "idempotent" : "written",
  });
}

// ── The settle verb (finding D) ──────────────────────────────────────────────

/**
 * `akm workflow report <run> --settle` — the mutating verb that advances a run
 * parked on a NON-DISPATCHING step (Codex round-3 finding D).
 *
 * A driver following the documented `brief → execute → report` loop has no
 * `report --unit` it can run when the active step dispatches nothing: a
 * params-based route step, an empty fan-out (`over: []`), or a step whose every
 * unit is unresolvable. The engine auto-advances such steps, but a pure
 * brief/report driver — one whose FIRST step is a params-routed route, with no
 * preceding unit report to trigger the internal `settleSpine` — would get stuck.
 *
 * `--settle` runs the EXISTING deterministic settle path ({@link settleSpine} —
 * route decision journaled, cascaded skips, spine advance) under the SAME guards
 * as `report --unit`: it refuses a non-active run, refuses while a LIVE engine
 * lease is held, honors `--expect-step`, and REFUSES when the active step has
 * reportable units (a driver must `report --unit` those, not settle them). The
 * settle runs under a short-lived engine-lease finalize lock (the same CAS
 * `finalizeStep` uses) so two concurrent settles/reports cannot double-journal.
 */
export async function settleWorkflowSpine(input: {
  target: string;
  /** The step id the driver briefed against (from `brief`'s settle command). */
  expectStep?: string;
  summaryJudge?: SummaryJudge | null;
  now?: () => Date;
}): Promise<WorkflowReportResult> {
  const release = await acquireMaintenanceActivity("workflow-report-settle");
  try {
    return await settleWorkflowSpineWithBarrier(input);
  } finally {
    release();
  }
}

async function settleWorkflowSpineWithBarrier(input: {
  target: string;
  expectStep?: string;
  summaryJudge?: SummaryJudge | null;
  now?: () => Date;
}): Promise<WorkflowReportResult> {
  const nowFn = input.now ?? (() => new Date());
  const runId = await resolveRunId(input.target);
  const { next, run: runRow, units } = await snapshotRunForDriver(runId);

  if (next.run.status !== "active" || next.done) {
    throw new UsageError(
      `Workflow run ${runId} is ${next.run.status} — \`akm workflow report --settle\` only advances an ACTIVE run. ` +
        `${next.run.status === "completed" ? "The run is already done." : `Reopen it first: \`akm workflow resume ${runId}\`.`}`,
    );
  }

  const lease = buildLease(runRow.engine_lease_holder, runRow.engine_lease_until);
  if (lease?.live) {
    throw new UsageError(
      `Workflow run ${runId} is being driven by engine ${lease.holder} (run lease expires ${lease.until}). ` +
        `\`akm workflow report --settle\` is refused while the engine lease is live — the engine settles its own ` +
        `non-dispatching steps.`,
    );
  }

  if (!next.step) {
    throw new UsageError(`Workflow run ${runId} is active but has no current step to settle.`);
  }

  if (input.expectStep !== undefined && next.step.id !== input.expectStep) {
    throw new UsageError(
      `Workflow run ${runId} is now on step "${next.step.id}", not "${input.expectStep}" (--expect-step). The spine ` +
        `moved since you briefed it — re-run \`akm workflow brief ${runId}\` and settle against the current step.`,
      "INVALID_FLAG_VALUE",
    );
  }

  const plan = requireExecutableWorkflowPlan(runRow);
  assertRunParamsSatisfyPlan(runId, plan, next.run.params ?? {});

  // A step with resolvable units is settled ONLY when its work-list is FULLY
  // TERMINAL — every resolvable unit run to a terminal state, nothing left to
  // `report --unit` — yet still un-finalized (a required-gate block that was
  // resumed, or a crash between the last unit write and completion; owner
  // manual-validation finding 3). Such a list has no pending unit to report, so
  // `--settle` runs the SAME shared completion path a report would
  // (reducer → gate → advance / re-block). A step with GENUINELY PENDING units
  // (pending, in-flight, or retry-eligible failed) is still refused — those
  // advance via `report --unit`.
  const ctx = buildStepContext(runId, plan, next, units);
  if (ctx.dispatching) {
    const workList = ctx.workList;
    if (!workList) {
      throw new UsageError(`Active step "${ctx.stepState.id}" of run ${runId} has no work-list to settle.`);
    }
    const byUnit = indexDispatchRows(units);
    const outstanding = workList.units.filter((u) => unitStillNeedsReport(u, byUnit));
    if (outstanding.length > 0) {
      const valid = outstanding.filter((u) => u.resolved.ok).map((u) => u.unitId);
      throw new UsageError(
        `Active step "${ctx.stepState.id}" of run ${runId} has reportable units — advance it with ` +
          `\`akm workflow report ${runId} --unit <id> ...\`, not --settle. Unit ids: ${valid.join(", ") || "(none)"}.`,
        "INVALID_FLAG_VALUE",
      );
    }
    // Fully terminal: finalize through the shared completion path. `finalizeStep`
    // runs its OWN finalize CAS (claims the engine lease as a lock), so we must
    // NOT also hold the settle lock here — call it directly.
    return finalizeStep({
      runId,
      next,
      plan,
      stepPlan: ctx.stepPlan,
      stepState: ctx.stepState,
      workList,
      byUnit,
      gateLoop: ctx.gateLoop,
      priorEvidence: ctx.priorEvidence,
      summaryJudge: input.summaryJudge,
      now: nowFn,
      written: { unitId: "(settle)", status: "skipped" },
      recorded: "not-recorded",
    });
  }

  // Finalize CAS: claim the engine lease as a short-lived settle lock, thread the
  // holder through the settle so its `completeWorkflowStep` calls pass the
  // single-driver guard, and release it in `finally`.
  const holder = `report-settle:${randomUUID()}`;
  const nowIso = nowFn().toISOString();
  const lockExpiry = new Date(nowFn().getTime() + FINALIZE_LOCK_TTL_MS).toISOString();
  const acquired = await withWorkflowRunsRepo((repo) => repo.acquireEngineLease(runId, holder, lockExpiry, nowIso));
  if (!acquired) {
    // A concurrent finalizer/settler holds the lock; report the fresh spine state
    // as idempotent success rather than racing it.
    const fresh = await getNextWorkflowStep(runId);
    return settleVerbResult(runId, fresh, `A concurrent driver is settling run ${runId}`);
  }
  let settled: WorkflowNextResult;
  try {
    settled = await settleSpine({ plan, runId, summaryJudge: input.summaryJudge, leaseHolder: holder });
  } finally {
    await withWorkflowRunsRepo((repo) => repo.releaseEngineLease(runId, holder));
  }
  return settleVerbResult(runId, settled);
}

/** Shape a `--settle` outcome as a (unit-less) report result. */
function settleVerbResult(runId: string, state: WorkflowNextResult, contendedNote?: string): WorkflowReportResult {
  const runStatus = state.run.status;
  const message =
    runStatus === "completed"
      ? `Settled non-dispatching steps — the workflow run is now DONE.`
      : state.step
        ? `Settled non-dispatching steps. Next: run \`akm workflow brief ${runId}\` for step "${state.step.id}".`
        : `Run ${runId} is ${runStatus} after settling.`;
  return {
    ok: true,
    runId,
    stepId: state.run.currentStepId ?? "(none)",
    // No unit was reported — the settle verb advances the deterministic spine.
    unitId: "(settle)",
    status: "skipped",
    gateLoop: 1,
    recorded: "not-recorded",
    remainingUnits: 0,
    ...(runStatus === "completed" ? { stepOutcome: { kind: "advanced" as const } } : {}),
    runStatus,
    message: contendedNote ? `${contendedNote} (idempotent success). ${message}` : message,
  };
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
    engines: plan.execution.engines,
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
  | { kind: "gate-rejected"; loopsRemaining: boolean; missing: string[]; feedback: string }
  /** Reviewer #18: a required gate with no judge available — the step is BLOCKED for a human. */
  | { kind: "blocked"; summary: string };

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
  const outcomes: UnitOutcome[] = [];
  for (const u of workList.units) {
    if (!u.resolved.ok) {
      outcomes.push({ unitId: u.unitId, ok: false, failureReason: "expression_error", error: u.resolved.error });
      continue;
    }
    // Reduce each unit by its BEST terminal attempt (base + `~r<n>` retries), the
    // SAME reuse the engine applies (shared {@link selectUnitAttemptRow}). A unit
    // whose base attempt failed but whose retry completed reduces as COMPLETED,
    // exactly like engine resume (finding C). A still-outstanding sibling with no
    // terminal row is excluded rather than reduced against a missing row — this
    // only arises on the fail-fast path (a single failed unit under
    // `on_error: fail` already fixes the step's verdict; unreported siblings play
    // no part in it). On the normal finalize path every resolvable unit is
    // terminal, so nothing is excluded and the reduction is unchanged.
    const row = selectUnitAttemptRow(u, byUnit);
    if (!row || (row.status !== "completed" && row.status !== "failed")) continue;
    outcomes.push(unitOutcomeFromRow(u.unitId, row, u.schema !== undefined));
  }
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
  /**
   * Finalization-lock holder (#5). When the finalize path holds the run's engine
   * lease as its completion lock, every `completeWorkflowStep` this attempt makes
   * must pass the SAME holder or the lease's own single-driver guard would refuse
   * it. Absent on the non-locked settle path (route-only / empty steps).
   */
  leaseHolder?: string;
}): Promise<StepCompletion> {
  const maxLoops = Math.max(1, args.stepPlan.gate.maxLoops ?? 1);
  const lease = args.leaseHolder !== undefined ? { leaseHolder: args.leaseHolder } : {};
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
    ...lease,
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
        ...lease,
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
  if (finalize.kind === "blocked") {
    // Reviewer #18: a required gate with no judge available. The frozen plan's
    // `gate.required` rides both surfaces, so the report path blocks identically.
    return { kind: "blocked", summary: finalize.summary };
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
  /**
   * How the triggering unit write resolved — surfaced verbatim on the result.
   * `not-recorded` is the `--settle` verb finalizing a fully-terminal step: no
   * unit row was written by this call, only the step advanced.
   */
  recorded: "written" | "idempotent" | "not-recorded";
}): Promise<WorkflowReportResult> {
  const { runId, next, plan, stepPlan, stepState, workList, byUnit, gateLoop, recorded } = args;

  // ── Finalization CAS (#5) ──────────────────────────────────────────────────
  // Two reporters that both observe the work-list fully terminal would otherwise
  // BOTH run the completion path — double-judging the gate, journaling duplicate
  // gate rows, racing `completeWorkflowStep`. Claim the run's engine lease as a
  // short-lived finalize lock (the same atomic single-UPDATE primitive the engine
  // uses): exactly one reporter wins. The loser (failed acquire) never runs the
  // judge; it re-reads the spine and returns the winner's outcome as idempotent
  // success — never a raw throw after useful work. `completeWorkflowStep`'s own
  // transactional CAS remains the ultimate arbiter of the single spine advance.
  const finalizeHolder = `report-finalize:${randomUUID()}`;
  const nowIso = args.now().toISOString();
  const lockExpiry = new Date(args.now().getTime() + FINALIZE_LOCK_TTL_MS).toISOString();
  const acquired = await withWorkflowRunsRepo((repo) =>
    repo.acquireEngineLease(runId, finalizeHolder, lockExpiry, nowIso),
  );
  if (!acquired) {
    // A concurrent finalizer holds the lock; it will advance the step exactly
    // once. Return idempotent success reflecting the freshest spine state.
    return contendedFinalizeResult(runId, stepState, args.written, gateLoop, recorded);
  }

  let completion: StepCompletion;
  const maxLoops = Math.max(1, stepPlan.gate.maxLoops ?? 1);
  try {
    // Under the lock, re-read the spine: a PRIOR finalizer may have already
    // advanced this step (a sequential race — both reporters saw the work-list
    // terminal, the first finished before this one acquired). If so, skip
    // re-completion and report idempotent success — the step is done.
    const fresh = await getNextWorkflowStep(runId);
    if (fresh.run.status !== "active" || fresh.step?.id !== stepState.id) {
      return contendedFinalizeResult(runId, stepState, args.written, gateLoop, recorded, fresh);
    }

    const reduced = reduceWorkListOutcomes(stepPlan, workList, byUnit);
    // Route/skip bookkeeping seeded from the journal so cascaded skips survive
    // (identical to the engine's resume seeding).
    const routeSelected = new Set<string>();
    const routeUnselected = new Map<string, RouteSkipInfo>();
    seedJournaledRouteDecisions(plan, next, routeSelected, routeUnselected);

    completion = await runStepCompletion({
      runId,
      workflowRef: next.run.workflowRef,
      stepPlan,
      stepId: stepState.id,
      completionCriteria: stepPlan.gate.criteria,
      gateLoop,
      reduced,
      priorEvidence: args.priorEvidence,
      params: next.run.params ?? {},
      routeSelected,
      routeUnselected,
      summaryJudge: args.summaryJudge,
      leaseHolder: finalizeHolder,
    });
  } finally {
    // Release the finalize lock before the trailing settle/messaging below runs
    // its own (unlocked) `completeWorkflowStep` calls for downstream
    // non-dispatching steps.
    await withWorkflowRunsRepo((repo) => repo.releaseEngineLease(runId, finalizeHolder));
  }

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

  if (completion.kind === "blocked") {
    // Reviewer #18: a required gate with no judge available blocked the step.
    // The run is now `blocked`; a human resolves it via `akm workflow resume`.
    const state = await getNextWorkflowStep(runId);
    return reportResult(
      runId,
      stepState.id,
      args.written,
      gateLoop,
      state.run.status,
      { kind: "blocked", summary: completion.summary },
      `Step "${stepState.id}" is BLOCKED: ${completion.summary}`,
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
  /**
   * Finalization-lock holder (finding D). When the standalone `--settle` verb
   * runs the settle under a short-lived engine-lease lock, every
   * `completeWorkflowStep` / `finalizeExecutedStep` it performs must pass the
   * SAME holder or the lease's own single-driver guard would refuse it. Absent
   * on the report-path settle (line 257) and the post-advance settle (line 993),
   * which run UNLOCKED exactly as before — behavior preserved.
   */
  leaseHolder?: string;
}): Promise<WorkflowNextResult> {
  const { plan, runId, summaryJudge, leaseHolder } = args;
  const leaseArg = leaseHolder !== undefined ? { leaseHolder } : {};
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
    const stepJudge = summaryJudge === undefined ? frozenSummaryJudge(plan, sp.gate.judge) : summaryJudge;

    // A route-skipped target: complete it as skipped, cascading if it is itself
    // a router (identical to the engine loop's skip handling).
    const skipInfo = routeUnselected.get(step.id);
    if (skipInfo && !routeSelected.has(step.id)) {
      if (sp.route) cascadeSkippedRouter(sp.route, step.id, routeUnselected);
      const notes =
        skipInfo.selected === null
          ? `Skipped by route: step "${skipInfo.router}" was itself skipped, so none of its branch targets run.`
          : `Skipped by route: step "${skipInfo.router}" selected "${skipInfo.selected}".`;
      await completeWorkflowStep({ runId, stepId: step.id, status: "skipped", notes, ...leaseArg });
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
        completionCriteria: sp.gate.criteria,
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
        summaryJudge: stepJudge,
        ...leaseArg,
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
        engines: plan.execution.engines,
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
          ...leaseArg,
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
        completionCriteria: sp.gate.criteria,
        gateLoop,
        reduced,
        priorEvidence,
        params: state.run.params ?? {},
        routeSelected,
        routeUnselected,
        summaryJudge: stepJudge,
        ...leaseArg,
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

/**
 * Normalize a driver-supplied `--failure-reason` to the persisted taxonomy (PR
 * #714 review round 2, #16). An external driver can type ANY string; storing it
 * verbatim would let an arbitrary token masquerade as a first-class failure
 * vocabulary and (worse) accidentally match a workflow's `retry.on`. So:
 *
 *   - an EMPTY/absent reason → the neutral default `reported_failure`;
 *   - a reason IN the canonical taxonomy ({@link PROGRAM_RETRY_REASONS}, the
 *     exact `AgentFailureReason` set `retry.on` accepts) → stored VERBATIM, so a
 *     driver reporting e.g. `timeout` participates in retry semantics identically
 *     to an engine-dispatched unit;
 *   - anything ELSE → namespaced under `external:<slug>` (lowercase, `[a-z0-9_-]`,
 *     clipped). An `external:*` value is BY CONSTRUCTION outside the taxonomy, so
 *     `retry.on` (which only lists taxonomy reasons) can never fire on it — an
 *     unknown external reason is recorded for observability without ever
 *     triggering retry.
 */
export function normalizeFailureReason(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return "reported_failure";
  if ((PROGRAM_RETRY_REASONS as readonly string[]).includes(trimmed)) return trimmed;
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `external:${slug || "unknown"}`;
}

/** Validate + shape the reported result into what `finishUnit` persists. */
function prepareResult(
  input: ReportUnitInput,
  workUnit: StepWorkUnit,
  sensitiveValues: readonly string[],
): { resultJson: string | null; failureReason: string | null } {
  if (input.status === "failed") {
    return {
      resultJson:
        input.resultRaw !== undefined && input.resultRaw !== ""
          ? JSON.stringify(redactSensitiveText(input.resultRaw, sensitiveValues))
          : null,
      failureReason: normalizeFailureReason(input.failureReason),
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
        `Unit "${input.unitId}" result is not valid JSON (its output schema requires a JSON value): ${redactSensitiveText(
          err instanceof Error ? err.message : String(err),
          sensitiveValues,
        )}`,
        "INVALID_FLAG_VALUE",
      );
    }
    const errors = validateJsonSchemaSubset(parsed, workUnit.schema);
    if (errors.length > 0) {
      throw new UsageError(
        `Unit "${input.unitId}" result failed validation against its declared output schema: ${redactSensitiveText(errors.join("; "), sensitiveValues)}.`,
        "INVALID_FLAG_VALUE",
      );
    }
    return { resultJson: JSON.stringify(redactSensitiveValue(parsed, sensitiveValues)), failureReason: null };
  }
  // Free-text unit: journal the text as a JSON string EXACTLY as the executor
  // does — `native-executor.ts` finishUnit uses `outcome.text ? JSON.stringify… :
  // null`, so an empty (or absent) output journals result_json = NULL, not '""'.
  // Matching that keeps the promoted artifact and the dispatch row byte-identical
  // across the engine and report surfaces (the cardinal graph-parity rule), and
  // stays consistent with the FAILED branch above which also maps ""→null.
  return {
    resultJson: input.resultRaw ? JSON.stringify(redactSensitiveText(input.resultRaw, sensitiveValues)) : null,
    failureReason: null,
  };
}

async function collectReportedUnitSensitiveValues(workUnit: StepWorkUnit): Promise<string[]> {
  const values = new Set<string>();
  for (const ref of workUnit.env ?? []) {
    const { resolveEnvBinding } = await import("../../commands/env/env-binding.js");
    for (const value of Object.values(resolveEnvBinding(ref).values)) values.add(value);
  }
  const collectEngine = (engine: StepWorkUnit["engine"] | StepWorkUnit["fallbackEngine"]): void => {
    if (!engine) return;
    if (engine.kind === "llm") {
      for (const name of engine.credential?.names ?? []) {
        const value = process.env[name]?.trim();
        if (value) values.add(value);
      }
      return;
    }
    for (const name of engine.envPassthrough) {
      const value = process.env[name];
      if (!isEnvPassthroughValueSafeToExpose(name, value) && value) values.add(value);
    }
  };
  collectEngine(workUnit.engine);
  collectEngine(workUnit.fallbackEngine);
  return [...values];
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
  existing: WorkflowRunUnitRow | undefined,
): BudgetVerdict {
  const budget = plan.budget;
  if (!budget || (budget.maxUnits === undefined && budget.maxTokens === undefined)) return { kind: "ok" };
  // The row being (re)written carries CUMULATIVE tokens across its attempts
  // (finding A): `finishUnit` will preserve them (prior spend + this write), so
  // they are part of the run's committed token total and count against
  // `max_tokens` here just like every other row's tokens. NULL ⇒ 0.
  const existingTokens = existing?.tokens ?? 0;
  let othersDispatched = 0;
  let othersTokens = 0;
  let existingAttempts = 0;
  for (const row of rows) {
    if (row.phase !== null) continue; // gate rows excluded
    if (row.unit_id === journalId) {
      // The row being (re)written. Its ALREADY-SPENT attempts must be counted
      // before admission (#4): excluding them let a re-report of a non-terminal
      // or failed unit erase the prior attempt from the ceiling. Its tokens are
      // accounted via `existingTokens` (the finish carries them forward, not
      // overwrites), so a rerun never drops a failed attempt's spend (finding A).
      existingAttempts = row.attempts;
      continue;
    }
    // Sum `attempts` (migration 008), not a per-row +1: a crash-retried unit
    // occupies ONE row whose `attempts` records every re-dispatch, so this
    // mirrors the engine seed (`run-workflow.ts`) and charges each dispatch.
    othersDispatched += row.attempts;
    othersTokens += row.tokens ?? 0;
  }
  // The attempts this write adds: a live `running` claim being finalized reuses
  // the claim's already-charged attempt (finishUnit, no insert ⇒ +0); every
  // other write (fresh, or a FAILED --rerun re-dispatch) inserts and bumps
  // `attempts` by one, mirroring the engine's charge-before-dispatch. The
  // projected total after this write must not exceed `max_units`.
  const increment = existing?.status === "running" ? 0 : 1;
  const projectedUnits = othersDispatched + existingAttempts + increment;
  if (budget.maxUnits !== undefined && projectedUnits > budget.maxUnits) {
    return {
      kind: "refuse",
      message:
        `budget exceeded (max_units ceiling): ${projectedUnits} unit dispatch(es) would be charged for this run ` +
        `against the workflow's declared budget.max_units of ${budget.maxUnits} — the step fails hard (budget ` +
        `ceilings ignore on_error).`,
    };
  }
  const committedTokens = othersTokens + existingTokens;
  if (budget.maxTokens !== undefined && committedTokens >= budget.maxTokens) {
    return {
      kind: "refuse",
      message:
        `budget exceeded (max_tokens ceiling): ${committedTokens} token(s) already spent for this run against the ` +
        `workflow's declared budget.max_tokens of ${budget.maxTokens} — the step fails hard (budget ceilings ignore on_error).`,
    };
  }
  if (budget.maxTokens !== undefined && committedTokens + thisTokens >= budget.maxTokens) {
    return {
      kind: "tokens-cross",
      message:
        `budget exceeded (max_tokens ceiling): ${committedTokens + thisTokens} token(s) spent for this run, reaching the ` +
        `workflow's declared budget.max_tokens of ${budget.maxTokens} — the step fails hard (budget ceilings ignore on_error).`,
    };
  }
  return { kind: "ok" };
}

// ── Claim + hash guards (shared by the running + finish transactions) ─────────

/**
 * Stale-hash guard (review round 2, #3): under a frozen plan the same unit
 * identity must reproduce the same input hash, so an existing row whose recorded
 * `input_hash` differs from the recomputed one is a hard replay divergence — a
 * stale or tampered row. A NULL recorded hash (never seen in practice for a
 * report-claimed row) is treated as non-divergent.
 */
function assertNoHashDivergence(
  existing: WorkflowRunUnitRow,
  inputHash: string,
  runId: string,
  journalId: string,
): void {
  if (existing.input_hash !== null && existing.input_hash !== inputHash) {
    throw new UsageError(
      `Replay divergence: unit "${journalId}" of run ${runId} has a journaled ${existing.status} row whose input ` +
        `hash differs from this report's. Under a frozen plan the same unit identity must reproduce the same inputs ` +
        `— refusing to heartbeat or finalize a stale/tampered row. Start a new run to re-execute this work.`,
    );
  }
}

/**
 * Claim compare-and-set (review round 2, #3): a LIVE claim (holder set, expiry
 * in the future) held by a DIFFERENT holder blocks a reclaim/heartbeat/finish;
 * a free row, an EXPIRED claim (crash recovery), or a claim already ours passes.
 * A claimless row always passes — simple drivers skip claims entirely.
 */
function assertClaimHeldByOrFree(
  existing: WorkflowRunUnitRow,
  holder: string | null,
  nowIso: string,
  runId: string,
  journalId: string,
  action: "heartbeat" | "finish",
): void {
  const claimLive = existing.claim_expires_at !== null && existing.claim_expires_at >= nowIso;
  if (existing.claim_holder !== null && claimLive && existing.claim_holder !== holder) {
    throw new UsageError(
      `Unit "${journalId}" of run ${runId} is claimed by ${existing.claim_holder} until ${existing.claim_expires_at}; ` +
        `only that holder can ${action} it while the claim is live. Pass --session-id ${existing.claim_holder} if you ` +
        `own the claim, or wait for it to expire (then it is reclaimable — crash recovery).`,
    );
  }
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
 * The result surfaced to the LOSER of the finalization CAS (#5): a concurrent
 * reporter holds (or already finished) the step's finalization. This report's
 * unit row IS durably journaled; the step advance is (being) done exactly once
 * by the winner, so this is idempotent success — never a raw throw. Re-reads the
 * freshest spine so the surfaced run status / advance is accurate.
 */
async function contendedFinalizeResult(
  runId: string,
  stepState: NonNullable<WorkflowNextResult["step"]>,
  written: { unitId: string; status: WorkflowRunUnitStatus },
  gateLoop: number,
  recorded: "written" | "idempotent" | "not-recorded",
  fresh?: WorkflowNextResult,
): Promise<WorkflowReportResult> {
  const state = fresh ?? (await getNextWorkflowStep(runId));
  const advancedPast = state.run.status !== "active" || state.step?.id !== stepState.id;
  return {
    ok: true,
    runId,
    stepId: stepState.id,
    unitId: written.unitId,
    status: written.status,
    gateLoop,
    // The UNIT write resolved as `recorded` (a real write, or an idempotent
    // re-report); only the STEP finalization was contended (a concurrent
    // reporter owns it), which the message conveys.
    recorded,
    remainingUnits: 0,
    ...(advancedPast ? { stepOutcome: { kind: "advanced" as const } } : {}),
    runStatus: state.run.status,
    message: advancedPast
      ? `Unit "${written.unitId}" recorded; step "${stepState.id}" was finalized by a concurrent reporter (idempotent success).`
      : `Unit "${written.unitId}" recorded; step "${stepState.id}" is being finalized by a concurrent reporter (idempotent success).`,
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
    // A unit is terminal when its best attempt (base OR a completed `~r<n>`
    // retry) is terminal — the SAME reuse the reducer applies (finding C), so a
    // base-failed unit rescued by a completed retry is NOT counted outstanding.
    const row = selectUnitAttemptRow(u, byUnit);
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
    // Best terminal attempt (base + `~r<n>` retries), the shared reuse (finding C).
    const row = selectUnitAttemptRow(u, byUnit);
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
  recorded: "written" | "idempotent" | "not-recorded" = "written",
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
