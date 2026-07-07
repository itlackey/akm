// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm workflow brief <run>` — the read-only half of the harness-neutral driver
 * protocol (redesign addendum R3). It tells ANY agent session (Claude Code,
 * opencode, Codex, a human at a shell) exactly what units the native engine
 * would dispatch for a run's active step, and how to report the results back
 * through `akm workflow report` (the mutating half, R3 step 3).
 *
 * ## Read-only, no lease, no dispatch, no mutation
 *
 * `brief` computes; it never writes. It takes no engine lease, dispatches no
 * units, and never advances the gate spine. The only database access is
 * SELECTs (`getNextWorkflowStep` + the run row + the unit journal). A test
 * proves the workflow.db file is byte-identical before and after a `brief`.
 *
 * ## No duplicated semantics (the cardinal rule)
 *
 * The expected work-list is computed by the SAME shared functions the engine
 * uses (`step-work.ts`): {@link computeStepWorkList} for item resolution +
 * content-derived unit ids + input hashes + prompt assembly,
 * {@link activeGateLoop} / {@link recoverGateFeedback} to recover the gate-loop
 * number and the judge feedback the engine threads into loop-N prompts (so a
 * loop-2 brief's unit ids/hashes equal what the engine would compute),
 * {@link stepOutputsFromEvidence} for the expression scope, and
 * {@link evaluateRoute} for the deterministic route decision. Because both
 * surfaces call one implementation, an engine-driven run and a brief/report
 * driven run of the same frozen plan produce byte-identical unit graphs — the
 * invariant R4 asserts.
 */

import { parseAssetRef } from "../../core/asset/asset-ref";
import { canonicalizeWorkflowName } from "../../core/asset/asset-spec";
import { NotFoundError, UsageError } from "../../core/errors";
import type { WorkflowRunUnitStatus } from "../../storage/repositories/workflow-runs-repository";
import { type WorkflowRunUnitRow, withWorkflowRunsRepo } from "../../storage/repositories/workflow-runs-repository";
import { getCurrentWorkflowScopeKey } from "../authoring/scope-key";
import { assertRunParamsSatisfyPlan } from "../ir/params";
import type { IrMapReducer, IrOnError, IrRetry, IrRunnerKind, WorkflowPlanGraph } from "../ir/schema";
import type { ExpressionScope } from "../program/expressions";
import { snapshotRunForDriver } from "../runtime/runs";
import { evaluateStaleUnits, type StaleUnit } from "../runtime/unit-checkin";
import { detectSecretShapedParams } from "./param-secrets";
import {
  activeGateLoop,
  assertJournaledRouteSelectionsValid,
  computeStepWorkList,
  evaluateRoute,
  GATE_EVALUATION_PHASE,
  type GateFeedback,
  parseFrozenPlan,
  recoverGateFeedback,
  selectUnitAttemptRow,
  stepOutputsFromEvidence,
} from "./step-work";

// ── Public contract (the JSON `brief` emits) ─────────────────────────────────

export interface WorkflowBriefRun {
  id: string;
  workflowRef: string;
  workflowTitle: string;
  status: string;
  currentStepId: string | null;
  params: Record<string, unknown>;
}

/** The engine run lease, surfaced with a `live` flag so drivers know to wait. */
export interface WorkflowBriefLease {
  holder: string;
  until: string;
  /** True when the lease has not yet expired — `report` is refused while live. */
  live: boolean;
}

/** One unit's journaled state, if a row already exists for the active loop's attempt. */
export interface WorkflowBriefJournaled {
  unitId: string;
  status: WorkflowRunUnitStatus;
  failureReason?: string;
  tokens?: number;
  startedAt?: string;
  finishedAt?: string;
  /**
   * Claim owner of a still-`running` unit (migration 009): the driver that holds
   * it via `report --status running`, surfaced so another driver sees whether the
   * unit is spoken for. Only present while the unit is `running` (a terminal unit
   * is no longer claimable).
   */
  claimedBy?: string;
  /** Claim expiry (ISO-8601 UTC). Past this the claim is reclaimable (crash recovery). */
  claimExpiresAt?: string;
}

/**
 * The driver-facing ACTION state for one unit (PR #714 review round 2, #15).
 * Distinct from the journaled DB status: it folds in the engine lease and the
 * unit's resolvability so a driver reads one field to decide whether to run it.
 *
 *   - `pending`     — no journal row yet; execute it and report the result.
 *   - `claimed`     — a driver holds a live `--status running` claim; another
 *                     driver should leave it (its own holder may still finish it).
 *   - `stale`       — claimed `running` but silent past the check-in window;
 *                     reclaimable — re-execute and report.
 *   - `done`        — completed terminal row; nothing to do (no report command).
 *   - `failed`      — failed terminal row; re-run only via the `--rerun` form.
 *   - `do_not_run`  — not executable now: a live engine lease owns the spine, or
 *                     the unit's inputs are unresolvable (an authoring error).
 */
export type WorkflowBriefUnitAction = "pending" | "claimed" | "stale" | "done" | "failed" | "do_not_run";

/** One unit the driver must execute, exactly as the engine would dispatch it. */
export interface WorkflowBriefUnit {
  /** Content-derived id — the `--unit` value `report` expects. */
  unitId: string;
  nodeId: string;
  index: number;
  runner: IrRunnerKind;
  profile?: string;
  model?: string;
  /** Resolved timeout (ms); null = no timeout declared. */
  timeoutMs: number | null;
  /** JSON Schema the reported result must validate against, when declared. */
  outputSchema?: Record<string, unknown>;
  /** Env binding asset refs — NAMES ONLY, never resolved secret values. */
  env?: string[];
  retry?: IrRetry;
  onError: IrOnError;
  /** The fan-out item this unit runs over (absent for a solo unit). */
  item?: unknown;
  /**
   * The fully-resolved instructions (engine preamble + interpolated workflow
   * instructions + any gate feedback + schema directive) and the input hash —
   * BYTE-IDENTICAL to what the engine would dispatch. A per-unit resolution
   * failure (bad `item.<path>` reference) is carried as `{ ok: false }`.
   */
  resolved: { ok: true; instructions: string; inputHash: string } | { ok: false; error: string };
  /** Already-journaled state for this loop's attempt, when a row exists. */
  journaled?: WorkflowBriefJournaled;
  /**
   * The driver-facing action state (#15). Terminal/blocked rows are NOT
   * `pending`, so a driver never re-executes finished work.
   */
  action: WorkflowBriefUnitAction;
  /**
   * The exact `akm workflow report` command line to run for this unit —
   * present ONLY for actionable states (`pending`/`stale`/`claimed`, and the
   * `--rerun` form for `failed`). A `done` or `do_not_run` unit carries NO
   * command (#15). The command carries `--expect-step` so a stale copy fails
   * loudly if the spine moved (#14).
   */
  report?: string;
}

export interface WorkflowBriefWorkList {
  isFanOut: boolean;
  /** The step's reducer (`collect`/`vote`); null for a route-only step. */
  reducer: IrMapReducer | null;
  concurrency?: number;
  itemCount: number;
  units: WorkflowBriefUnit[];
  /** A whole-list failure (missing subgraph, unresolvable `over`, duplicate items). */
  error?: string;
}

export interface WorkflowBriefRoute {
  input: string;
  when: Record<string, string>;
  defaultStepId?: string;
  /** True when brief evaluated the decision NOW (route-only steps, resolvable from prior outputs). */
  evaluatedNow: boolean;
  decision?: { value: string; selected: string };
  decisionError?: string;
}

export interface WorkflowBriefStep {
  stepId: string;
  title: string;
  sequenceIndex: number;
  /** `execute` (units only), `route` (spine decision only), `execute-and-route` (both). */
  kind: "execute" | "route" | "execute-and-route";
  instructions: string;
  gate: {
    criteria: string[];
    maxLoops: number;
    /** The gate loop the engine is about to (re-)run, derived from the journal. */
    currentLoop: number;
    /** True when the gate judges the promoted artifact (criteria declared on an executing step). */
    judgesArtifact: boolean;
    /** Reviewer #18: `gate.required` — with no judge available the step BLOCKS instead of failing open. */
    required: boolean;
  };
  outputSchema?: Record<string, unknown>;
}

export interface WorkflowBrief {
  ok: true;
  run: WorkflowBriefRun;
  /**
   * Spine watermark (PR #714 review round 2, #14): an opaque token stamping the
   * run id, the active step id, the gate loop, and a run-mutation watermark
   * (`updated_at` + journal row count). A driver can compare it across polls to
   * detect that a concurrent report/run/manual completion moved the spine, and
   * `report --expect-step` enforces the step half server-side.
   */
  spineToken: string;
  engineLease?: WorkflowBriefLease;
  /** Present (true) when the run is completed — nothing left to execute. */
  done?: true;
  /** True when there is an active step whose work-list is described below. */
  active: boolean;
  step?: WorkflowBriefStep;
  /** Judge feedback recovered from the previous rejected gate loop (loop >= 2). */
  gateFeedback?: GateFeedback;
  workList: WorkflowBriefWorkList;
  route?: WorkflowBriefRoute;
  /** Report-command guidance (heartbeat + failure forms) shared by all units. */
  reportGuidance: {
    checkin: string;
    failure: string;
    note: string;
  };
  /**
   * Units another driver claimed (`report --status running`) but has not
   * heartbeated within the staleness window — surfaced so a driver can reclaim
   * abandoned work. Pure timestamp evaluation (`runtime/unit-checkin.ts`).
   */
  staleUnits: StaleUnit[];
  warnings: string[];
  /** Human-oriented one-liner about the run's overall state. */
  message: string;
}

const EMPTY_WORK_LIST: WorkflowBriefWorkList = { isFanOut: false, reducer: null, itemCount: 0, units: [] };

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Build the read-only brief for a run. `target` is a run id (preferred) or a
 * workflow ref that ALREADY has an active run in the current scope — brief
 * never auto-starts a run (that would mutate), so a ref with no active run is a
 * NotFoundError, not a silent start.
 */
export async function buildWorkflowBrief(target: string): Promise<WorkflowBrief> {
  const runId = await resolveRunId(target);
  // Read-only spine walk. #14: read the run row, its steps, AND its unit journal
  // in ONE transaction so a concurrent report/run/manual completion cannot change
  // the active step between the spine read and the unit-journal read. A bare run
  // id never auto-starts (we resolved to a concrete id above).
  const { next, run: runRow, units } = await snapshotRunForDriver(runId);
  const planJson = runRow.plan_json;
  const planHash = runRow.plan_hash;
  const leaseHolder = runRow.engine_lease_holder;
  const leaseUntil = runRow.engine_lease_until;

  const run: WorkflowBriefRun = {
    id: next.run.id,
    workflowRef: next.run.workflowRef,
    workflowTitle: next.run.workflowTitle,
    status: next.run.status,
    currentStepId: next.run.currentStepId ?? null,
    params: next.run.params ?? {},
  };

  const warnings: string[] = [];

  // #13: params are declared NON-SECRET. They are interpolated into every unit
  // prompt AND hashed into the unit identity, so `brief` cannot redact them
  // without breaking the byte-identical-prompt contract a driver executes
  // against. Surface the standing advisory (whenever the run carries params) plus
  // any best-effort secret-shaped-value hits, so an author moves credentials to
  // an env binding (which `brief` only ever names).
  if (Object.keys(run.params).length > 0) {
    warnings.push(
      "Workflow params are copied verbatim into every unit prompt shown to any driver and are hashed into the unit " +
        "identity — they are NOT secret. Never put credentials in params; put secrets in env bindings (`env:` refs), " +
        "which `brief` surfaces by name only and never resolves.",
    );
  }
  warnings.push(...detectSecretShapedParams(run.params));

  const lease = buildLease(leaseHolder, leaseUntil);
  if (lease?.live) {
    warnings.push(
      `Engine ${lease.holder} holds a LIVE run lease (expires ${lease.until}). This run is being driven by the ` +
        `native engine right now — \`akm workflow report\` is REFUSED while the lease is live. Do NOT execute these ` +
        `units; wait for the engine to finish or for the lease to expire.`,
    );
  }

  // Stale claimed units (pure timestamp evaluation): a driver claimed these via
  // `report --status running` but has not heartbeated within the window — flag
  // them so another driver can reclaim the abandoned work.
  const staleUnits = evaluateStaleUnits(units);
  if (staleUnits.length > 0) {
    warnings.push(
      `${staleUnits.length} unit(s) were claimed with \`report --status running\` but have gone silent past the ` +
        `check-in window (${staleUnits.map((u) => u.unitId).join(", ")}). Their driver may have died — you can ` +
        `reclaim and re-execute them.`,
    );
  }

  const reportGuidance = {
    checkin: `akm workflow report ${run.id} --unit <unit_id> --status running --note "<short progress note>"`,
    failure: `akm workflow report ${run.id} --unit <unit_id> --status failed --failure-reason <vocab>`,
    note: "Run each unit, then report its result. A unit belongs to the active step's work-list; its unit_id is content-derived — copy it verbatim.",
  };

  // Spine watermark (#14): run-mutation counter shared by every return below.
  // The active branch re-stamps it with the real gate loop + active step id.
  const watermark = `${runRow.updated_at}:u${units.length}`;
  const base = {
    ok: true as const,
    run,
    spineToken: makeSpineToken(run.id, run.currentStepId, 1, watermark),
    ...(lease ? { engineLease: lease } : {}),
    reportGuidance,
    staleUnits,
    warnings,
  };

  // Completed run: nothing to do.
  if (next.done || run.status === "completed") {
    return {
      ...base,
      done: true,
      active: false,
      workList: EMPTY_WORK_LIST,
      message: "Workflow run is completed — no work remains.",
    };
  }

  // Blocked / failed: not active, so the engine dispatches nothing. Point the
  // driver at `resume` rather than inventing a work-list for a dead run.
  if (run.status !== "active") {
    warnings.push(
      `Workflow run is ${run.status}, not active — no work-list. Reopen it first: \`akm workflow resume ${run.id}\`.`,
    );
    return {
      ...base,
      active: false,
      workList: EMPTY_WORK_LIST,
      message: `Workflow run is ${run.status} — resume it to continue.`,
    };
  }

  const stepState = next.step;
  if (!stepState) {
    return {
      ...base,
      active: false,
      workList: EMPTY_WORK_LIST,
      message: "Workflow run is active but has no current step.",
    };
  }

  // Load the FROZEN plan the engine executes (migration 006). A legacy run
  // (NULL plan_json) has no plan for brief to read — point at engine-driven
  // mode, which still handles pre-006 runs by compiling from the asset.
  const plan = loadFrozenPlanForBrief(run.id, planJson, planHash);
  // Reviewer #12: the journaled params row must still satisfy the frozen param
  // schemas — a violation is post-start corruption, loud on the brief surface
  // too (mirrors the frozen-plan hash check and the tampered-params divergence).
  assertRunParamsSatisfyPlan(run.id, plan, next.run.params ?? {});
  // Reviewer #7: a completed route step whose journaled decision names a target
  // the route never declared is tampered evidence — fail loudly on the read-only
  // brief surface too, not just on the resume/report surfaces that replay it.
  assertJournaledRouteSelectionsValid(plan, next);
  const stepPlan = plan.steps.find((s) => s.stepId === stepState.id);
  if (!stepPlan) {
    throw new UsageError(
      `Step "${stepState.id}" of run ${run.id} is not present in the run's frozen plan. The plan and the step ` +
        `journal disagree — this run cannot be described; drive it manually with \`akm workflow complete\`.`,
    );
  }

  // Expression scope: prior steps' promoted artifacts + run params, projected
  // exactly as the engine does (stepOutputsFromEvidence). The current (pending)
  // step contributes no output yet.
  const evidence: Record<string, Record<string, unknown> | undefined> = {};
  for (const s of next.workflow.steps) evidence[s.id] = s.evidence;
  const stepOutputs = stepOutputsFromEvidence(evidence);

  // Gate loop + recovered feedback — the journal-derived state that makes a
  // loop-N brief predict the engine's loop-N dispatch (unit ids + hashes).
  const gateLoop = activeGateLoop(units, stepState.id);
  const gateFeedback = recoverGateFeedback(units, stepState.id, gateLoop);

  const isRouteOnly = !!stepPlan.route && !stepPlan.root;
  const kind: WorkflowBriefStep["kind"] = isRouteOnly ? "route" : stepPlan.route ? "execute-and-route" : "execute";
  const criteria = stepState.completionCriteria ?? [];

  const step: WorkflowBriefStep = {
    stepId: stepState.id,
    title: stepState.title,
    sequenceIndex: stepState.sequenceIndex ?? 0,
    kind,
    instructions: stepState.instructions,
    gate: {
      criteria,
      maxLoops: Math.max(1, stepPlan.gate.maxLoops ?? 1),
      currentLoop: gateLoop,
      judgesArtifact: !isRouteOnly && criteria.length > 0,
      required: stepPlan.gate.required === true,
    },
    ...(stepPlan.outputSchema ? { outputSchema: stepPlan.outputSchema } : {}),
  };

  // Journaled dispatch rows for THIS step, keyed by unit id (exclude gate rows).
  const journaledByUnit = new Map<string, WorkflowRunUnitRow>();
  for (const row of units) {
    if (row.step_id === stepState.id && row.phase !== GATE_EVALUATION_PHASE) {
      journaledByUnit.set(row.unit_id, row);
    }
  }

  // #15 action derivation inputs: the stale-claim set (by unit id) and whether a
  // live engine lease means the whole work-list is `do_not_run` right now.
  const staleIds = new Set(staleUnits.map((u) => u.unitId));
  const leaseLive = lease?.live === true;

  // The work-list — the SAME computation the engine runs (no drift).
  let workList: WorkflowBriefWorkList = EMPTY_WORK_LIST;
  if (!isRouteOnly) {
    const computed = computeStepWorkList(stepPlan, {
      runId: run.id,
      params: run.params,
      stepOutputs,
      gateLoop,
      ...(gateFeedback ? { gateFeedback } : {}),
    });
    if (!computed.ok) {
      workList = { ...EMPTY_WORK_LIST, error: computed.error };
    } else {
      const list = computed.list;
      // #21: a worktree-isolated unit runs in a throwaway git worktree that is
      // auto-removed when clean. Files it writes to a `.gitignore`d path are
      // treated as disposable and discarded — warn any driver so collectible
      // artifacts go to a non-ignored path or come back as a reported result.
      if (list.units.some((u) => u.isolation === "worktree")) {
        warnings.push(
          "This step runs unit(s) in an isolated git worktree (`isolation: worktree`). Outputs matched by the " +
            "repository's `.gitignore` are treated as DISPOSABLE — a clean worktree is auto-removed, discarding them. " +
            "Write any artifact that must survive to a NON-ignored path (a tracked or untracked-unignored file), or " +
            "report it as the unit's result. Do not leave collectible work under `node_modules`/`dist`/build/cache paths.",
        );
      }
      workList = {
        isFanOut: list.isFanOut,
        reducer: list.reducer,
        ...(list.concurrency !== undefined ? { concurrency: list.concurrency } : {}),
        itemCount: list.items.length,
        units: list.units.map((u) =>
          // Resolve the unit's journaled state by its BEST terminal attempt
          // (base + `~r<n>` retries), the SAME reuse the engine and report
          // surfaces apply (shared selectUnitAttemptRow, finding C): a unit whose
          // base attempt failed but whose retry completed surfaces as `done`, not
          // `failed`, so brief never advertises re-running work a prior retry
          // already finished — keeping the read-only surface consistent with what
          // report/resume would reduce.
          toBriefUnit(run.id, u, stepState.id, selectUnitAttemptRow(u, journaledByUnit), {
            stale: staleIds.has(u.journalBaseId),
            leaseLive,
          }),
        ),
      };
    }
  }

  // Route contract. A route-only step's decision depends solely on prior step
  // outputs, so brief evaluates it deterministically NOW. An execute-and-route
  // step's decision needs the current step's fresh output, which does not exist
  // until the units run — so brief surfaces the contract without a decision.
  let route: WorkflowBriefRoute | undefined;
  if (stepPlan.route) {
    route = {
      input: stepPlan.route.input,
      when: stepPlan.route.when,
      ...(stepPlan.route.defaultStepId ? { defaultStepId: stepPlan.route.defaultStepId } : {}),
      evaluatedNow: isRouteOnly,
    };
    if (isRouteOnly) {
      const scope: ExpressionScope = { params: run.params, stepOutputs };
      const decision = evaluateRoute(stepPlan.route, scope);
      if (decision.ok) route.decision = { value: decision.value, selected: decision.selected };
      else route.decisionError = decision.error;
    }
  }

  const message = buildMessage(step, workList, route, gateLoop);

  return {
    ...base,
    // Re-stamp the spine token with the resolved active step + real gate loop.
    spineToken: makeSpineToken(run.id, stepState.id, gateLoop, watermark),
    active: true,
    step,
    ...(gateFeedback ? { gateFeedback } : {}),
    workList,
    ...(route ? { route } : {}),
    message,
  };
}

/**
 * The spine watermark stamped on every brief (#14): run id, active step id,
 * gate loop, and a run-mutation watermark (`updated_at` + journal row count). A
 * driver diffs it across polls to notice the spine moved; `report --expect-step`
 * enforces the step half server-side.
 */
function makeSpineToken(runId: string, stepId: string | null, gateLoop: number, watermark: string): string {
  return `${runId}#${stepId ?? "-"}#l${gateLoop}#${watermark}`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toBriefUnit(
  runId: string,
  unit: import("./step-work").StepWorkUnit,
  stepId: string,
  journaled: WorkflowRunUnitRow | undefined,
  ctx: { stale: boolean; leaseLive: boolean },
): WorkflowBriefUnit {
  const action = deriveUnitAction(unit, journaled, ctx);
  const report = reportCommandForAction(runId, unit, stepId, action);
  return {
    unitId: unit.unitId,
    nodeId: unit.nodeId,
    index: unit.index,
    runner: unit.runner,
    ...(unit.profile ? { profile: unit.profile } : {}),
    ...(unit.model ? { model: unit.model } : {}),
    timeoutMs: unit.timeoutMs,
    ...(unit.schema ? { outputSchema: unit.schema } : {}),
    // Env asset REF names only — brief never resolves bindings, so no secret
    // value can ever reach this output.
    ...(unit.env ? { env: unit.env } : {}),
    ...(unit.retry ? { retry: unit.retry } : {}),
    onError: unit.onError,
    ...(unit.isFanOut ? { item: unit.item } : {}),
    resolved: unit.resolved.ok
      ? { ok: true, instructions: unit.resolved.prompt, inputHash: unit.resolved.inputHash }
      : { ok: false, error: unit.resolved.error },
    ...(journaled ? { journaled: toBriefJournaled(journaled) } : {}),
    action,
    ...(report ? { report } : {}),
  };
}

/**
 * Fold the journaled row + engine lease + resolvability into ONE driver-facing
 * action (#15). A live engine lease or an unresolvable unit is `do_not_run`; a
 * terminal row is `done`/`failed`; a live claim is `claimed` (or `stale` once
 * silent); no row is `pending`.
 */
function deriveUnitAction(
  unit: import("./step-work").StepWorkUnit,
  journaled: WorkflowRunUnitRow | undefined,
  ctx: { stale: boolean; leaseLive: boolean },
): WorkflowBriefUnitAction {
  if (!unit.resolved.ok) return "do_not_run";
  if (ctx.leaseLive) return "do_not_run";
  if (!journaled) return "pending";
  if (journaled.status === "completed") return "done";
  if (journaled.status === "failed") return "failed";
  if (journaled.status === "running") return ctx.stale ? "stale" : "claimed";
  return "pending";
}

function toBriefJournaled(row: WorkflowRunUnitRow): WorkflowBriefJournaled {
  // Claim state is meaningful only while the unit is still running; a terminal
  // row keeps its claim columns but they are no longer actionable.
  const claim =
    row.status === "running"
      ? {
          ...(row.claim_holder ? { claimedBy: row.claim_holder } : {}),
          ...(row.claim_expires_at ? { claimExpiresAt: row.claim_expires_at } : {}),
        }
      : {};
  return {
    unitId: row.unit_id,
    status: row.status,
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
    ...(row.tokens !== null ? { tokens: row.tokens } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    ...claim,
  };
}

/**
 * The `report` command line for a unit, tailored to its action (#15). Terminal
 * `done` and `do_not_run` units get NO command; a `failed` unit gets the
 * `--rerun` form (records a fresh attempt, per #25); `pending`/`stale`/`claimed`
 * get the normal completed form. Every command carries `--expect-step` (#14) so
 * a copy-pasted command from a stale brief is refused once the spine moves on.
 */
function reportCommandForAction(
  runId: string,
  unit: import("./step-work").StepWorkUnit,
  stepId: string,
  action: WorkflowBriefUnitAction,
): string | undefined {
  if (action === "done" || action === "do_not_run") return undefined;
  const resultHint = unit.schema
    ? "--result-file <result.json>   # JSON matching the unit's outputSchema"
    : "--result-file <result.txt>    # or --result '<text>' / pipe via stdin";
  const rerun = action === "failed" ? " --rerun" : "";
  return `akm workflow report ${runId} --unit ${unit.unitId} --expect-step ${stepId} --status completed${rerun} ${resultHint}`;
}

export function buildLease(holder: string | null, until: string | null): WorkflowBriefLease | undefined {
  if (!holder || !until) return undefined;
  return { holder, until, live: until >= new Date().toISOString() };
}

function buildMessage(
  step: WorkflowBriefStep,
  workList: WorkflowBriefWorkList,
  route: WorkflowBriefRoute | undefined,
  gateLoop: number,
): string {
  const loopNote = gateLoop > 1 ? ` (gate loop ${gateLoop}, addressing prior rejection feedback)` : "";
  if (step.kind === "route") {
    const decided = route?.decision ? ` → selects step "${route.decision.selected}"` : "";
    return `Active step "${step.stepId}" is a route step — no units to execute${decided}. Advances deterministically.`;
  }
  if (workList.error) {
    return `Active step "${step.stepId}" could not compute a work-list: ${workList.error}`;
  }
  const n = workList.units.length;
  return `Active step "${step.stepId}" expects ${n} unit(s)${loopNote}. Execute them, then report each result.`;
}

/**
 * brief-specific frozen-plan loader: unlike the engine's loader, a NULL
 * plan_json is a hard, actionable error rather than a warn-and-compile — brief
 * describes the frozen plan the engine executes, and a legacy run has none.
 */
function loadFrozenPlanForBrief(runId: string, planJson: string | null, planHash: string | null): WorkflowPlanGraph {
  if (!planJson) {
    throw new UsageError(
      `Workflow run ${runId} predates frozen plans (no plan_json on the run row) and cannot be described by ` +
        `\`akm workflow brief\`. Drive it with engine-driven mode instead: \`akm workflow run ${runId}\` ` +
        `(which compiles a legacy run's plan from the live asset).`,
    );
  }
  return parseFrozenPlan(runId, planJson, planHash);
}

/**
 * Resolve `target` to a concrete run id WITHOUT starting anything. A run id
 * resolves directly; a workflow ref resolves to its active run in the current
 * scope, and NO active run is a NotFoundError (brief never auto-starts — that
 * would mutate).
 */
export async function resolveRunId(target: string): Promise<string> {
  return withWorkflowRunsRepo((repo) => {
    const byId = repo.getRunById(target);
    if (byId) return byId.id;

    if (!target.includes(":")) {
      throw new NotFoundError(`Workflow run "${target}" not found.`, "WORKFLOW_NOT_FOUND");
    }
    const parsed = parseAssetRef(target);
    if (parsed.type !== "workflow") {
      throw new UsageError(`Expected a workflow run id or workflow ref (workflow:<name>), got "${target}".`);
    }
    const ref = `${parsed.origin ? `${parsed.origin}//` : ""}workflow:${canonicalizeWorkflowName(parsed.name)}`;
    const active = repo.getActiveRunRowForScope(ref, getCurrentWorkflowScopeKey());
    if (!active) {
      throw new NotFoundError(
        `No active workflow run for ${ref} in this scope. \`akm workflow brief\` describes an existing run and never ` +
          `starts one — run \`akm workflow start ${ref}\` (or \`akm workflow run ${ref}\`) first.`,
        "WORKFLOW_NOT_FOUND",
      );
    }
    return active.id;
  });
}
