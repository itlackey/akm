// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Native executor — executes one frozen step subgraph (`IrStepPlan.root`) on
 * the local machine: fan-out through the scheduler, schema-validated
 * structured output through `runStructured` (core/structured.ts), per-unit
 * persistence through the serialized writer queue, and `workflow_unit_*`
 * events for observability.
 *
 * Data flow: there is no interpolation language — a unit's instructions are
 * the step's body prose byte-exact, and data reaches it as attached
 * structured context instead. References resolve once per step, only in the
 * closed frontmatter positions, against the promoted step-output artifact.
 * See docs/architecture/decisions/0001-no-interpolation-attached-structured-context.md
 * for the full design history (peer review R1, the P1 injection class it closes).
 *
 * Empty free-text outputs (peer review): a SUCCESSFUL schemaless unit that
 * returns the empty string is normalized to "no output" — {@link dispatchUnit}
 * drops the falsy `text`, `finishUnitAttempt` journals `result_json = NULL`, and
 * durable-row reuse rehydrates the same absence (`unitOutcomeFromRow`). This is
 * the ONLY empty-output resolution: `''` never survives into the journal, so the
 * live artifact cannot diverge from the artifact a resume rebuilds from the same
 * rows (the byte-identical-graph cardinal rule). Consequences that follow from
 * "empty == absent", not special-cased anywhere:
 *   - a SOLO empty step promotes `output = null` (the unit's absent text ??
 *     null); a `collect` fan-out promotes `null` in that item's slot.
 *   - A downstream `steps.x.output` reference to an empty solo step therefore
 *     resolves against `null` and fails LOUDLY at reference resolution
 *     (`… resolved to null`) — a deterministic whole-step failure, never a
 *     silent empty string.
 *   - A SCHEMA unit is unaffected by this normalization: an empty response is
 *     not parseable JSON, so `runStructured` fails it (`parse_error`) — an
 *     empty output can never satisfy a declared schema as a silent `null`.
 *
 * Typed artifacts (addendum, R2): when the step declares an `output` schema
 * (`IrStepPlan.outputSchema`), the promoted artifact is validated with the
 * JSON-schema-subset validator BEFORE the step can complete. A mismatch fails
 * the step (fail-fast) with the validation errors in the summary — a
 * downstream consumer must never receive an artifact the author's contract
 * says cannot exist. The failure is flagged (`artifactSchemaFailure` on the
 * result) so the engine's bounded gate loop can re-run the step with the
 * validation errors as feedback ("gate loops can re-run it") — a step with
 * loop budget left regenerates instead of killing the run.
 *
 * Unit identity (addendum, R2): CONTENT-DERIVED, never positional. A fan-out
 * unit's id is `<node_id>:<sha256(canonicalJson(item))[:12]>`; a solo unit's
 * is `<node_id>:solo`. Identity therefore survives item-list regeneration and
 * reordering — resuming a run whose producer re-emitted the same items in a
 * different order reuses every journaled result. Consequences:
 *   - DUPLICATE items in one fan-out list are disambiguated by occurrence.
 *   - RESUME SKIPS COMPLETED UNITS: a journaled COMPLETED row for a unit id is
 *     its result and is never re-dispatched, whatever its recorded
 *     `input_hash` (informational). Failed/running/missing rows dispatch live.
 *   - Rows with unrelated ids never match a content-derived id and are ignored.
 *
 * Gate loops (addendum, R2 `gate.max_loops`): when the engine re-executes a
 * step subgraph after a gate rejection, it threads the judge's feedback in as
 * `ctx.gateFeedback` (appended to every unit prompt) and marks the attempt
 * with `ctx.gateLoop` (>= 2). Loop attempts journal under `<unitId>~l<loop>` —
 * like `~r<n>` retries, pure journal bookkeeping on top of the content-derived
 * identity, so loop 1's rows are never clobbered and each loop's completed
 * rows are what a resume of that loop reuses.
 *
 * Failure policy (addendum, "explicit surface, fail-fast default"):
 *   - `onError: "fail"` (default) fails the step on any unit failure;
 *     `"continue"` records failures in the evidence and lets the gate decide.
 *   - `retry: { max, on }` re-dispatches a failed unit up to `max` extra
 *     times when its `failureReason` is in `on`. Every retry journals its OWN
 *     row under `<unitId>~r<attempt>` so no attempt's record is clobbered.
 *
 * Worktree isolation (addendum, R2 `isolation: worktree`): each journaled
 * attempt of an isolated agent/sdk unit runs in a FRESH detached git worktree
 * of the engine's working directory (`ctx.workDir`, default `process.cwd()`),
 * minted under a run-scoped tmp dir (`worktree.ts`) and passed to dispatch as
 * the child's cwd. The path is journaled on the unit row (`worktree_path`);
 * after the unit finishes, a clean worktree is removed and a dirty one is
 * retained + logged (uncollected work is never destroyed). "Clean" is
 * `git status --porcelain` WITHOUT `--ignored`, so a worktree whose only
 * residue is `.gitignore`-matched files (build outputs, `node_modules`) counts
 * as clean and IS removed — those files are disposable by the repo's own
 * declaration, and retaining a worktree per build would blow up disk
 * (`worktree.ts` contract). A non-git base directory fails the step cleanly
 * before any dispatch, and llm units reject isolation loudly — there is no
 * child process to isolate.
 *
 * Budget ceilings (addendum, R2): a frozen plan's `budget` block
 * (`max_units` / `max_tokens`) is enforced per RUN. The engine seeds
 * `ctx.unitsDispatched` (journal row count) and `ctx.tokensUsed` (journaled
 * token sum) and threads the running totals across steps; this executor
 * consumes both per ACTUAL dispatch. Hitting a ceiling aborts pending and
 * in-flight dispatches through an AbortController chained onto `ctx.signal`
 * and fails the step with a "budget exceeded (<which> ceiling)" summary —
 * hard, regardless of `on_error`, exactly like the lifetime cap.
 *
 * Layering (see the plan's *Reconciliation* section):
 *   - Dispatch goes through ONE injected {@link UnitDispatcher} seam. The
 *     default dispatcher adapts the frozen snapshot into the common resolved
 *     request, lowers it through the registered harness/direct-LLM adapter,
 *     and reaches transport only through the central lowered-dispatch seam.
 *   - This module NEVER writes step rows: advancing the gated spine is the
 *     engine loop's job (`run-workflow.ts`) via `completeWorkflowStep`.
 */

import { appendEvent } from "../../core/events";
import { validateJsonSchemaSubset } from "../../core/json-schema";
import { runStructured } from "../../core/structured";
import { warn } from "../../core/warn";
import { assertFrozenDirectoryContained } from "../../execution/directory-identity";
import type { LoweringNotice } from "../../execution/resolved-request";
import {
  type WorkflowRunUnitAttemptRowV4,
  type WorkflowRunUnitRow,
  withWorkflowRunsConnection,
  withWorkflowRunsRepo,
} from "../../storage/repositories/workflow-runs-repository";
import type { TaskV3ScriptInterpreter } from "../../tasks/prepare/prepared-execution";
import { materializeFrozenWorkflowEnvironment } from "../ir/environment-v4";
import type { IrBudget } from "../ir/schema";
import type { IrStepPlanV4, IrUnitNodeV4 } from "../ir/schema-v4";
import { WORKFLOW_UNIT_DIAGNOSTIC_CLIP } from "../resource-limits";
// The ONE child-workflow drive (P3b §3.2) — publishes and drives a
// `child-workflow`-targeted unit; this module's dispatch seam is its only
// production caller.
import { driveChildWorkflowUnit } from "./child-workflow";
// The ONE dispatch redaction contract, shared with the gate-judge path
// (exec/frozen-judge.ts). Consumers import the leaf directly — this module is
// not a second front door onto the seam.
import { collectWorkflowDispatchSensitiveValues, redactUnitOutcome } from "./dispatch-redaction";
// The exec (shell) unit runner — a leaf that owns argv spawning, containment,
// and the process-outcome → failure-reason mapping.
import { runExecUnit } from "./exec-unit";
import { mergeLoweringNotices } from "./lowering-notices";
import { secretShapedParamValues } from "./param-secrets";
import { scheduleUnits } from "./scheduler";
// Shared step semantics — the ONE implementation consumed by the engine
// (this module + run-workflow.ts) on both the fresh-execution and the resume
// path. This module dispatches; step-work.ts owns the pure decisions.
import {
  clip,
  computeStepWorkList,
  type GateFeedback,
  reduceEmptyStep,
  reduceStepOutcomes,
  type StepWorkUnit,
  stepOutputsFromEvidence,
  type UnitOutcome,
  unitOutcomeFromRow,
} from "./step-work";
import {
  dispatchWorkflowExecution,
  type UnitDispatcher,
  type UnitDispatchRequest,
  type UnitDispatchResult,
} from "./unit-dispatch";

export type { UnitDispatcher, UnitDispatchRequest, UnitDispatchResult } from "./unit-dispatch";

import { cleanupFrozenScript, frozenScriptCommand, materializeFrozenScript } from "../../tasks/frozen-script";
import { enqueueUnitWrite } from "./unit-writer";
import { assertGitWorkTree, cleanupUnitWorktree, createUnitWorktree } from "./worktree";

export interface StepExecutionContext {
  runId: string;
  workflowRef: string;
  params: Record<string, unknown>;
  /** Evidence of prior steps, keyed by step id — fan-out `over:` sources. */
  evidence: Record<string, Record<string, unknown> | undefined>;
  /**
   * Gate-loop attempt number, 1-based (absent = 1, the first execution).
   * Attempts >= 2 journal their units under `<unitId>~l<loop>` so loop 1's
   * rows are never clobbered (module doc, *Gate loops*).
   */
  gateLoop?: number;
  /** Judge feedback from the previous (rejected) gate loop; appended to every unit prompt. */
  gateFeedback?: GateFeedback;
  signal?: AbortSignal;
  /** Test seam / backend override; defaults to the runner-substrate dispatcher. */
  dispatcher?: UnitDispatcher;
  /**
   * F-1 (spec docs/plans/specs/p1b-model-extraction.md §5.2 point 2): the
   * task runner's resolved provenance event source, threaded from
   * RunWorkflowOptions.eventSource. Undefined for every non-task caller.
   * Forwarded to an exec unit's child env via UnitDispatchRequest.eventSource
   * -> exec-unit.ts's childEnv (applied to the allowlisted base only, so an
   * ambient value and an authored env: binding both still win). Typed as a
   * bare `string` (not `UsageEventSource`) — see run-workflow.ts's
   * RunWorkflowOptions.eventSource for why.
   */
  eventSource?: string;
  /**
   * Dispatch attempts already journaled for this run (lifetime-cap
   * accounting). Only ACTUAL dispatches consume the cap — durable-row reuses
   * are free, so a partially-completed fan-out stays resumable.
   */
  unitsDispatched?: number;
  /**
   * Declared run-level budget ceilings from the frozen plan
   * (`WorkflowPlanGraph.budget`, addendum R2). When present, `unitsDispatched`
   * counts against `maxUnits` and `tokensUsed` against `maxTokens`; hitting a
   * ceiling aborts pending dispatches (an AbortController chained onto
   * `signal`) and fails the step hard, regardless of `on_error`.
   */
  budget?: IrBudget;
  /**
   * Run-total tokens already spent BEFORE this step: the journal-seeded sum
   * of `workflow_run_units.tokens` plus this invocation's earlier steps'
   * dispatch usage (threaded via {@link StepExecutionResult.tokensUsed}).
   */
  tokensUsed?: number;
  /** Test seam for the engine concurrency cap. */
  maxConcurrency?: number;
  /**
   * The engine invocation's working directory. Two uses:
   *   - the git repository `isolation: worktree` mints its per-attempt
   *     detached worktrees from;
   *   - the base directory a NON-isolated `exec` unit spawns in (an isolated
   *     one spawns in its worktree instead).
   * Defaults to `process.cwd()`; injected by tests so no chdir is needed.
   */
  workDir?: string;
  /**
   * Worktree-isolation preflight seam (defaults to {@link assertGitWorkTree}).
   * Only invoked when a unit will ACTUALLY dispatch, so a fully-journaled step
   * resumes even when its cwd is no longer a git worktree or git is missing.
   * Injected by tests to simulate those conditions deterministically.
   */
  preflightWorktree?: (dir: string) => string | undefined;
}

export interface StepExecutionResult {
  ok: boolean;
  units: UnitOutcome[];
  /** Safe live lowering diagnostics; never included in durable step/unit evidence. */
  notices?: readonly Readonly<LoweringNotice>[];
  /** Step evidence for `completeWorkflowStep` (units, reducer output). */
  evidence: Record<string, unknown>;
  /** Deterministic machine summary for the step-completion gate. */
  summary: string;
  /**
   * Cumulative dispatched-unit count: input + the attempts this step ACTUALLY
   * dispatched (durable-row reuses are not dispatches and are not counted).
   */
  unitsDispatched: number;
  /**
   * Cumulative run-total token count: `ctx.tokensUsed` + the usage this
   * step's actual dispatches reported (reuses contribute nothing — their
   * tokens are already in the journal-seeded input). Absent on failure paths
   * that never reached dispatch, where the input total is unchanged.
   */
  tokensUsed?: number;
  /**
   * Set when `ok` is false BECAUSE the promoted artifact failed the step's
   * declared output schema (typed artifacts, R2). This is the one failure the
   * engine may retry through the bounded gate loop (`gate.max_loops`): the
   * validation errors become gate feedback and the subgraph re-executes —
   * the pinned decision's "fail-fast — gate loops can re-run it". Every other
   * failure (dispatch errors, cap) stays a hard stop.
   */
  artifactSchemaFailure?: true;
  /**
   * Set when `ok` is false BECAUSE a composed child workflow is `blocked`
   * (P3b, spec docs/plans/specs/p3b-child-executor.md §3.4). Threaded through
   * from {@link reduceStepOutcomes}'s `ExecutedStepOutcome.childBlocked` via
   * the `...reduced` spread below — never set independently here.
   */
  childBlocked?: {
    childRunId: string;
    childRef: string;
    childStepId: string | null;
  };
}

/**
 * Mutable per-step dispatch budget: the declared run-level budget ceilings
 * (`budget.max_units` / `budget.max_tokens`, addendum R2). Consumed once per
 * journaled dispatch attempt (including retries); durable-row reuses never
 * touch it — the peer-review fix that keeps large partially-completed
 * fan-outs resumable instead of tripping a pre-batch check on
 * `journaled + items`. Token usage accumulates per actual dispatch on top of
 * the journal-seeded run total (reused rows' tokens are already in the
 * seed). Check-and-increment is synchronous, so concurrent units cannot race
 * it; crossing a declared ceiling fires `onExceeded` ONCE (the executor's
 * chained AbortController), aborting pending and in-flight dispatches.
 */
class DispatchBudget {
  used: number;
  /** Run-total tokens: journal-seeded input + this step's dispatch usage. */
  tokens: number;
  /** Set (once) when a declared budget ceiling was hit; the step fails hard with it. */
  budgetMessage: string | undefined;
  private readonly maxUnits: number | undefined;
  private readonly maxTokens: number | undefined;
  private readonly onExceeded: (() => void) | undefined;

  constructor(alreadyDispatched: number, opts?: { tokensUsed?: number; budget?: IrBudget; onExceeded?: () => void }) {
    this.used = alreadyDispatched;
    this.tokens = opts?.tokensUsed ?? 0;
    this.maxUnits = opts?.budget?.maxUnits;
    this.maxTokens = opts?.budget?.maxTokens;
    this.onExceeded = opts?.onExceeded;
  }

  /** Consume one dispatch slot; false (and a sticky message) when a ceiling or the cap is hit. */
  tryConsume(): boolean {
    if (this.budgetMessage !== undefined) return false;
    if (this.maxUnits !== undefined && this.used >= this.maxUnits) {
      this.exceed(
        `budget exceeded (max_units ceiling): ${this.used} unit(s) already dispatched for this run ` +
          `against the workflow's declared budget.max_units of ${this.maxUnits} — refusing further dispatch.`,
      );
      return false;
    }
    if (this.maxTokens !== undefined && this.tokens >= this.maxTokens) {
      this.exceed(
        `budget exceeded (max_tokens ceiling): ${this.tokens} token(s) already spent for this run ` +
          `against the workflow's declared budget.max_tokens of ${this.maxTokens} — refusing further dispatch.`,
      );
      return false;
    }
    this.used++;
    return true;
  }

  /** Record one dispatch's reported usage; crossing `maxTokens` trips the ceiling. */
  addTokens(tokens: number): void {
    this.tokens += tokens;
    if (this.budgetMessage === undefined && this.maxTokens !== undefined && this.tokens >= this.maxTokens) {
      this.exceed(
        `budget exceeded (max_tokens ceiling): ${this.tokens} token(s) spent for this run, ` +
          `reaching the workflow's declared budget.max_tokens of ${this.maxTokens} — aborting pending dispatches.`,
      );
    }
  }

  private exceed(message: string): void {
    this.budgetMessage = message;
    this.onExceeded?.();
  }
}

/**
 * Per-unit durable-row reuse decision. Shared by {@link runUnit} (which ACTS on
 * it) and executeStepPlan's pre-dispatch gate (which asks "will ANY unit
 * dispatch?" to decide whether env resolution + worktree preflight are needed
 * at all — reviewer finding #2). Both go through this one function so the
 * preflight gate can never disagree with what runUnit does:
 *   - `reuse`    — a completed row for this unit IS the result;
 *   - `dispatch` — no completed row: this unit will actually issue work.
 */
type UnitReuseDecision = { kind: "reuse"; row: WorkflowRunUnitRow } | { kind: "dispatch" };

function classifyUnitReuse(workUnit: StepWorkUnit, completedRows: CompletedRowIndex | undefined): UnitReuseDecision {
  // Scan EVERY journaled attempt row of this unit (`<base>` / `<base>~r<N>`
  // for ANY N), not just the attempts the CURRENT retry policy allows: a run
  // re-invoked with a lowered retry.max must still find the `~rN` row a prior
  // invocation completed beyond the new max, never re-dispatch finished work.
  // The row's `input_hash` is informational — resume skips completed units.
  const prior = completedRows?.get(workUnit.journalBaseId)?.[0];
  return prior ? { kind: "reuse", row: prior } : { kind: "dispatch" };
}

/**
 * The step's COMPLETED journal rows grouped by base journal id (`~r<N>`
 * stripped), built ONCE per step so classifyUnitReuse is a map probe over that
 * unit's own attempt rows instead of an O(rows) scan of the whole step journal
 * (a 10 000-unit fan-out resume would otherwise re-walk the full journal once
 * per unit).
 */
type CompletedRowIndex = Map<string, WorkflowRunUnitRow[]>;

function indexCompletedRows(rows: Iterable<WorkflowRunUnitRow>): CompletedRowIndex {
  const index: CompletedRowIndex = new Map();
  for (const row of rows) {
    if (row.status !== "completed") continue;
    const base = row.unit_id.replace(/~r\d+$/, "");
    const forBase = index.get(base);
    if (forBase) forBase.push(row);
    else index.set(base, [row]);
  }
  return index;
}

/**
 * Execute one step plan natively. Never throws for unit-level failures.
 *
 * The whole step runs inside ONE state.db connection scope
 * ({@link withWorkflowRunsConnection}): the journal read, every unit's
 * insert/finish transaction, and every `workflow_unit_*` event share a single
 * handle for the step's lifetime instead of opening and closing state.db twice
 * per unit plus twice per unit's events. The scope closes the handle when the
 * step settles (success, failure, or throw), so there is no handle to leak and
 * no lifetime that outlives the step. Everything inside keeps its existing
 * transaction boundaries — see `core/state-db-scope.ts` for why sharing a
 * handle across concurrently-scheduled units is safe here.
 */
export function executeStepPlan(plan: IrStepPlanV4, ctx: StepExecutionContext): Promise<StepExecutionResult> {
  return withWorkflowRunsConnection(() => executeStepPlanInConnection(plan, ctx));
}

/**
 * Open the step's dispatch budget and the abort signal it trips.
 *
 * Budget ceilings (addendum R2): when the frozen plan declares a budget,
 * dispatch runs under an AbortController CHAINED onto `ctx.signal` — hitting a
 * ceiling aborts pending and in-flight dispatches, and the step fails hard.
 * Without a budget the context signal passes through untouched (the no-budget
 * path is byte-identical to pre-R2 behavior).
 *
 * The returned {@link DispatchBudget} is seeded with the run's journaled
 * dispatch count and token total and consumed per ACTUAL dispatch inside
 * `runUnit` — never for durable-row reuses, so resuming a large
 * partially-completed fan-out works.
 *
 * `unchainSignal` MUST be called when dispatch finishes (the caller's
 * `finally`) so the upstream abort listener is removed.
 */
function openDispatchBudget(
  ctx: StepExecutionContext,
  dispatched: number,
): { signal: AbortSignal | undefined; budget: DispatchBudget; unchainSignal: (() => void) | undefined } {
  const declaredBudget =
    ctx.budget && (ctx.budget.maxUnits !== undefined || ctx.budget.maxTokens !== undefined) ? ctx.budget : undefined;
  let signal = ctx.signal;
  let onExceeded: (() => void) | undefined;
  let unchainSignal: (() => void) | undefined;
  if (declaredBudget) {
    const controller = new AbortController();
    const upstream = ctx.signal;
    if (upstream) {
      if (upstream.aborted) {
        controller.abort();
      } else {
        const onUpstreamAbort = () => controller.abort();
        upstream.addEventListener("abort", onUpstreamAbort, { once: true });
        unchainSignal = () => upstream.removeEventListener("abort", onUpstreamAbort);
      }
    }
    signal = controller.signal;
    onExceeded = () => controller.abort();
  }
  const budget = new DispatchBudget(dispatched, {
    tokensUsed: ctx.tokensUsed ?? 0,
    ...(declaredBudget ? { budget: declaredBudget } : {}),
    ...(onExceeded ? { onExceeded } : {}),
  });
  return { signal, budget, unchainSignal };
}

type StepDispatchPrerequisites =
  | {
      ok: true;
      env?: Record<string, string>;
      sensitiveValues?: readonly string[];
      worktreeBase?: string;
    }
  | { ok: false; result: StepExecutionResult };

/** Resolve the live-at-dispatch prerequisites once, after durable-row reuse is known. */
async function prepareStepDispatchPrerequisites(input: {
  plan: IrStepPlanV4;
  template: IrUnitNodeV4;
  workUnits: readonly StepWorkUnit[];
  ctx: StepExecutionContext;
  willDispatch: boolean;
  dispatched: number;
}): Promise<StepDispatchPrerequisites> {
  const { plan, template, workUnits, ctx, willDispatch, dispatched } = input;
  let env: Record<string, string> | undefined;
  let sensitiveValues: readonly string[] | undefined;
  const frozenEnvironment = workUnits[0]?.environment;
  if (willDispatch && frozenEnvironment && frozenEnvironment.length > 0) {
    try {
      const materialized = materializeFrozenWorkflowEnvironment(frozenEnvironment);
      env = materialized.values;
      sensitiveValues = materialized.sensitiveValues;
      for (const audit of materialized.audits) {
        appendEvent({
          eventType: audit.eventType,
          ref: audit.ref,
          metadata: { keys: audit.keys, secretNames: audit.secretNames },
        });
      }
    } catch (err) {
      return {
        ok: false,
        result: failedStep(dispatched, `Step "${plan.stepId}" frozen environment preflight failed: ${message(err)}`),
      };
    }
  }

  let worktreeBase: string | undefined;
  if (willDispatch && template.isolation === "worktree") {
    if (template.frozenTarget.kind === "command" && template.frozenTarget.runner.kind === "llm") {
      return {
        ok: false,
        result: failedStep(
          dispatched,
          `Step "${plan.stepId}" declares isolation: worktree on an llm unit — the llm runner has no ` +
            `working directory to isolate. Use the agent or sdk runner for worktree-isolated units.`,
        ),
      };
    }
    const target = workUnits[0]?.frozenTarget;
    const frozenCwd = target && "cwdIdentity" in target ? target.cwdIdentity : undefined;
    if (frozenCwd) assertFrozenDirectoryContained(frozenCwd);
    const base = frozenCwd?.realRoot ?? ctx.workDir ?? process.cwd();
    const preflightWorktree = ctx.preflightWorktree ?? assertGitWorkTree;
    const gitError = preflightWorktree(base);
    if (gitError !== undefined) {
      return {
        ok: false,
        result: failedStep(dispatched, `Step "${plan.stepId}" cannot use isolation: worktree: ${gitError}`),
      };
    }
    worktreeBase = base;
  }

  return {
    ok: true,
    ...(env ? { env } : {}),
    ...(sensitiveValues ? { sensitiveValues } : {}),
    ...(worktreeBase !== undefined ? { worktreeBase } : {}),
  };
}

async function executeStepPlanInConnection(
  plan: IrStepPlanV4,
  ctx: StepExecutionContext,
): Promise<StepExecutionResult> {
  const dispatched = ctx.unitsDispatched ?? 0;

  // Work-list computation is the SHARED, PURE decision (step-work.ts): resolve
  // the fan-out list, derive content-derived unit ids, assemble each unit's
  // prompt, and hash its resolved input. A resume recomputes the identical list
  // from the same frozen plan — that shared pure implementation is what lets
  // journaled rows be matched instead of re-executed. This module owns only the
  // impure remainder: env/worktree preflight, durable-row reuse, dispatch,
  // journaling, budget.
  const workList = computeStepWorkList(plan, {
    runId: ctx.runId,
    params: ctx.params,
    stepOutputs: stepOutputsFromEvidence(ctx.evidence),
    ...(ctx.gateLoop !== undefined ? { gateLoop: ctx.gateLoop } : {}),
    ...(ctx.gateFeedback ? { gateFeedback: ctx.gateFeedback } : {}),
  });
  if (!workList.ok) {
    return failedStep(dispatched, workList.error);
  }
  const { template, reducer, isFanOut, items, units: workUnits } = workList.list;

  if (items.length === 0) {
    // Empty fan-out: the promoted artifact is the degenerate empty value, honored
    // against the step's declared output schema. `reduceEmptyStep` (step-work.ts)
    // owns that decision so a zero-unit step promotes the identical artifact +
    // schema verdict every time the spine reaches it.
    return { ...reduceEmptyStep(plan, reducer), unitsDispatched: dispatched };
  }

  const dispatcher = ctx.dispatcher ?? defaultUnitDispatcher;

  // Durable-row resume: load the step's journaled unit rows FIRST — before
  // resolving env or preflighting worktrees. A unit whose previous attempt
  // completed is reused, not re-dispatched — a crash-resume must never
  // double-issue side-effecting work. Loading the rows up front is what lets
  // us skip the dispatch prerequisites below when nothing will actually
  // dispatch.
  const completedRows = indexCompletedRows(
    await withWorkflowRunsRepo((repo) => repo.getUnitsForStep(ctx.runId, plan.stepId)),
  );

  // Reviewer finding #2: env resolution and worktree preflight are DISPATCH
  // prerequisites, so they must run only when a unit will actually dispatch. A
  // fully-journaled step whose units all reuse completed rows must resume to
  // completion even if an env asset was deleted, a secret is unavailable, the
  // cwd is no longer a git worktree, or git is missing — none of that is needed
  // to hand back a cached result. The predicate mirrors runUnit's reuse
  // decision exactly (shared classifyUnitReuse).
  // Classify every unit ONCE. The gate below and each unit's own dispatch then
  // read the SAME decision rather than recomputing it from inputs that must be
  // identical — the agreement the gate depends on is structural, not a property
  // two call sites have to keep re-establishing.
  const reuseDecisions = workUnits.map((unit) => classifyUnitReuse(unit, completedRows));
  const willDispatch = reuseDecisions.some((decision) => decision.kind === "dispatch");

  const prerequisites = await prepareStepDispatchPrerequisites({
    plan,
    template,
    workUnits,
    ctx,
    willDispatch,
    dispatched,
  });
  if (!prerequisites.ok) return prerequisites.result;
  const { env, sensitiveValues, worktreeBase } = prerequisites;

  // Budget ceilings + lifetime-cap accounting, and the budget-chained abort
  // signal they trip. Extracted verbatim (behavior-identical) — see
  // {@link openDispatchBudget}.
  const { signal, budget, unchainSignal } = openDispatchBudget(ctx, dispatched);

  let outcomes: Array<UnitOutcome | undefined>;
  // Worktree removals started by finished units and awaited below, before this
  // step reports anything. Cleanup is best-effort, but "the step resolved" must
  // still mean "its clean worktrees are gone" — only the WAIT moves off the
  // unit's scheduler slot, not the guarantee.
  const pendingWorktreeCleanups: Array<Promise<void>> = [];
  const frozenTargetConcurrency =
    template.frozenTarget.kind === "command" ? template.frozenTarget.concurrency : undefined;
  try {
    outcomes = await scheduleUnits(
      workUnits,
      (workUnit, index) =>
        runUnit({
          plan,
          workUnit,
          env,
          sensitiveValues,
          ...(worktreeBase !== undefined ? { worktreeBase } : {}),
          ctx,
          signal,
          dispatcher,
          reuse: reuseDecisions[index]!,
          pendingWorktreeCleanups,
          budget,
        }),
      {
        concurrency: workList.list.concurrency,
        signal,
        maxConcurrency: ctx.maxConcurrency,
        ...(frozenTargetConcurrency !== undefined ? { llmConcurrency: frozenTargetConcurrency } : {}),
      },
    );
  } finally {
    unchainSignal?.();
    // The barrier. `allSettled` because each task already swallowed its own
    // failure into a warn — nothing here can fail the step.
    await Promise.allSettled(pendingWorktreeCleanups);
  }

  // Capture live-only diagnostics BEFORE any hard reduction replaces the unit
  // list with a failed-step envelope. Budget/cap and journal-write failures
  // must not erase notices already observed from real dispatches; durable row
  // reuses naturally contribute none.
  const notices = mergeLoweringNotices(...outcomes.map((outcome) => outcome?.notices));

  // A declared budget ceiling is a hard backstop: a step that hit one FAILS
  // regardless of on_error policy (a capped run must never quietly pass its
  // gate). The budget message names WHICH ceiling tripped.
  if (budget.budgetMessage) {
    return { ...failedStep(budget.used, budget.budgetMessage, notices), tokensUsed: budget.tokens };
  }

  const units = outcomes.map(
    (outcome, index) =>
      outcome ?? {
        unitId: workUnits[index]!.unitId,
        ok: false,
        failureReason: "aborted",
        error: "unit was not dispatched (aborted or scheduler failure)",
      },
  );

  // A journal-write failure is HARD regardless of on_error: the
  // unit dispatched (spent tokens, ran side effects) but its result could not
  // be persisted, so completing the step would promote an artifact the
  // journal cannot rebuild on resume — and the stuck-`running` row would
  // wedge or double-dispatch a later invocation. The summary carries the
  // per-unit cause verbatim.
  const unjournaled = units.filter((u) => u.failureReason === "journal_write_failed");
  if (unjournaled.length > 0) {
    return {
      ...failedStep(
        budget.used,
        unjournaled.map((u) => u.error ?? `unit "${u.unitId}" result could not be journaled`).join(" "),
        notices,
      ),
      tokensUsed: budget.tokens,
    };
  }

  // Failure policy + reducer + typed-artifact validation are the SHARED
  // post-dispatch decision (`reduceStepOutcomes`): `onError: "fail"` (default)
  // fails the step on any unit failure, `"continue"` records failures and lets
  // the gate decide, a vote reducer with no majority fails under either policy,
  // and the promoted artifact is validated against the step's declared output
  // schema (fail-fast; the `artifactSchemaFailure` marker lets the bounded gate
  // loop retry that ONE failure class with the errors as feedback). The report
  // path (R3) reduces journal-replayed outcomes through the same function, so a
  // step promotes the SAME artifact whichever surface drove it.
  const reduced = reduceStepOutcomes(plan, reducer, isFanOut, template.onError, units);

  return {
    ...reduced,
    ...(notices ? { notices } : {}),
    unitsDispatched: budget.used,
    tokensUsed: budget.tokens,
  };
}

// ── One unit ─────────────────────────────────────────────────────────────────

interface RunUnitInput {
  plan: IrStepPlanV4;
  /** The precomputed work unit (id, resolved prompt + input hash, node metadata) from step-work. */
  workUnit: StepWorkUnit;
  env?: Record<string, string>;
  /** Current values sampled from v4 symbolic descriptors, for terminal scrub. */
  sensitiveValues?: readonly string[];
  /** Git repo worktrees are minted from — set exactly when the unit declares `isolation: worktree`. */
  worktreeBase?: string;
  ctx: StepExecutionContext;
  /**
   * Effective dispatch signal: `ctx.signal`, or the budget-chained
   * AbortController's signal when the plan declares budget ceilings.
   */
  signal?: AbortSignal;
  dispatcher: UnitDispatcher;
  /**
   * This unit's durable-row decision, classified once per step alongside the
   * gate that consumes the same array — never re-derived here.
   */
  reuse: UnitReuseDecision;
  /** The step's worktree-removal barrier — see {@link JournaledAttemptInput}. */
  pendingWorktreeCleanups: Array<Promise<void>>;
  /** Shared lifetime-cap budget; consumed once per actual dispatch attempt. */
  budget: DispatchBudget;
}

async function runUnit(input: RunUnitInput): Promise<UnitOutcome> {
  const { plan, workUnit, env, sensitiveValues, ctx, dispatcher } = input;
  const unitId = workUnit.unitId;

  // Target validity is a WHOLE-LIST invariant, never a per-unit condition:
  // computeStepWorkList rejects a step before building any unit when its sole
  // frozen target is invalid, so every unit below carries one executable
  // command/agent/SDK/direct-LLM target.

  // The prompt (and therefore the input hash) was built once with the BASE
  // unit id by computeStepWorkList: a retry re-dispatches the SAME input, the
  // `~r<n>` suffix is journal bookkeeping only.
  const { prompt, inputHash } = workUnit;
  const request: UnitDispatchRequest = {
    runId: ctx.runId,
    stepId: plan.stepId,
    unitId,
    nodeId: workUnit.nodeId,
    prompt,
    frozenTarget: workUnit.frozenTarget,
    ...(workUnit.execContext ? { execContext: workUnit.execContext } : {}),
    // A NON-isolated exec unit spawns in the engine invocation's working
    // directory. `dispatchJournaledAttempt` overwrites this with the unit's
    // fresh worktree when `isolation: worktree` is in play. Only exec units get
    // it: handing an agent unit a cwd it never had would change harness
    // behavior, and the agent path already takes its cwd from its profile.
    ...(workUnit.frozenTarget.kind !== "command" && ctx.workDir !== undefined ? { cwd: ctx.workDir } : {}),
    timeoutMs: workUnit.timeoutMs,
    ...(workUnit.schema ? { schema: workUnit.schema } : {}),
    ...(env ? { env } : {}),
    ...(sensitiveValues ? { sensitiveValues } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    // F-1 (spec §5.2 point 2): forwarded to exec-unit.ts's childEnv for a
    // "script"/"shell" unit, and to dispatchWorkflowExecution's
    // runExecution eventSource option (unit-dispatch.ts)
    // for a "command" unit — both arms observe it.
    ...(ctx.eventSource !== undefined ? { eventSource: ctx.eventSource } : {}),
  };

  // One content-derived unit id is retained across every retry; the append-only
  // attempt table supplies the 1-based attempt identity.
  const retry = workUnit.retry;
  const maxAttempts = 1 + Math.max(0, retry?.max ?? 0);
  const journalBaseId = workUnit.journalBaseId;
  const attemptIdFor = (_attempt: number): string => journalBaseId;

  // Durable-row reuse — literally the decision executeStepPlan's preflight gate
  // counted, handed down rather than recomputed, so the gate cannot disagree
  // with what happens here. A completed row IS the result: return it without
  // touching rows, dispatching, or re-emitting events (a crash-resume must
  // never double-issue work). Failed/running/missing rows dispatch live.
  const reuse = input.reuse;
  if (reuse.kind === "reuse") {
    // Identity in the durable step evidence is the CONTENT-derived base id, not
    // the `~r<n>` attempt row it was reused from — the work list only ever knows
    // base ids, so evidence.units[].unitId stays stable across retries+resumes.
    return reuseCompletedUnit(unitId, reuse.row, workUnit.schema !== undefined);
  }

  let outcome: UnitOutcome | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (input.signal?.aborted) {
      return (
        outcome ?? {
          unitId,
          ok: false,
          failureReason: "aborted",
          error: "unit was not dispatched because the workflow invocation was interrupted",
        }
      );
    }
    const attemptId = attemptIdFor(attempt);
    // Declared budget ceilings, consumed per ACTUAL dispatch (reuses above
    // returned before reaching here). Refusal fails this unit without
    // journaling a row — nothing was dispatched — and the sticky
    // budgetMessage fails the step.
    if (!input.budget.tryConsume()) {
      return (
        outcome ?? {
          unitId,
          ok: false,
          failureReason: "budget_exceeded",
          error: input.budget.budgetMessage ?? "budget exceeded",
        }
      );
    }
    outcome = await dispatchJournaledAttempt({
      plan,
      workUnit,
      ctx,
      dispatcher,
      request: { ...request, unitId: attemptId },
      attemptId,
      inputHash,
      ...(input.worktreeBase !== undefined ? { worktreeBase: input.worktreeBase } : {}),
      pendingWorktreeCleanups: input.pendingWorktreeCleanups,
    });
    // Attempts use `~r<n>` journal suffixes while durable step evidence remains
    // attached to the content-derived base identity.
    outcome.unitId = unitId;
    // Budget token accounting (addendum R2): every actual dispatch's reported
    // usage counts against the run's max_tokens ceiling; crossing it aborts
    // pending dispatches via the chained controller. Reuses never reach here
    // (their tokens are already in the journal-seeded total).
    if (outcome.tokens !== undefined) input.budget.addTokens(outcome.tokens);
    if (outcome.ok) return outcome;
    if (input.signal?.aborted) return outcome;
    const reason = outcome.failureReason;
    if (!retry || reason === undefined || !retry.on.includes(reason)) return outcome;
  }
  // maxAttempts >= 1, so outcome is always set by the loop above.
  return outcome as UnitOutcome;
}

interface JournaledAttemptInput {
  plan: IrStepPlanV4;
  workUnit: StepWorkUnit;
  ctx: StepExecutionContext;
  dispatcher: UnitDispatcher;
  request: UnitDispatchRequest;
  /** Journal id of this attempt: `<unitId>` or `<unitId>~r<n>` for retries. */
  attemptId: string;
  inputHash: string;
  /** Git repo to mint this attempt's isolation worktree from (`isolation: worktree`). */
  worktreeBase?: string;
  /**
   * Where this attempt parks its worktree removal for the step to await. See
   * the barrier in {@link executeStepPlanInConnection} for why it is not
   * awaited here.
   */
  pendingWorktreeCleanups: Array<Promise<void>>;
}

/**
 * What a finished attempt writes to `workflow_run_steps`' unit row
 * `result_json` — the ONE durable, human-facing surface for a dispatch outcome
 * (`akm workflow status --units` reads exactly this, and the step summary is
 * built from the same text).
 *
 * A SUCCESS journals its promoted value, unchanged.
 *
 * A FAILURE journals its DIAGNOSTIC. Before this, only `result`/`text` were
 * written: `outcome.error` — the one field that says WHY — reached nothing
 * durable, because `buildEvidence` deliberately drops it from the deterministic
 * evidence graph and nothing else persisted it. For an engine unit that mostly
 * cost detail; for an `exec` unit it lost the diagnostic entirely, since a
 * command that fails and explains itself on stderr with empty stdout left
 * `status --units` showing a bare `non_zero_exit`.
 *
 * Three constraints hold:
 *
 *   - REDACTION — the caller journals only `redactUnitOutcome(...)` output, so
 *     `error` has already been through the shared dispatch redaction contract
 *     (`exec/dispatch-redaction.ts`) with this dispatch's resolved `env:`
 *     values. It is scrubbed by construction, exactly like `text`.
 *   - BOUNDS — clipped to {@link WORKFLOW_UNIT_DIAGNOSTIC_CLIP}, the same bound
 *     `status --units` renders with, so a runaway command cannot use the journal
 *     as its log file.
 *   - HASHES — `result_json` is an OUTPUT. The unit input hash
 *     (`computeUnitInputHash`) is computed from plan-frozen INPUTS only and
 *     recorded on the row as information; nothing here feeds it.
 *
 * Partial output on a failed unit is kept ALONGSIDE the diagnostic rather than
 * replacing it: a tool that fails after printing its real complaint on stdout
 * is common, and the reason lives on whichever stream that tool chose.
 */
function journaledUnitResultJson(outcome: UnitOutcome): string | null {
  if (outcome.result !== undefined) return JSON.stringify(outcome.result);
  if (outcome.ok) return outcome.text ? JSON.stringify(outcome.text) : null;
  const parts = [outcome.error, outcome.text].filter((part): part is string => Boolean(part && part.trim()));
  if (parts.length === 0) return null;
  return JSON.stringify(clip(parts.join("\n--- unit output ---\n"), WORKFLOW_UNIT_DIAGNOSTIC_CLIP));
}

type PreparedAttemptWorktree =
  | { ok: true; request: UnitDispatchRequest; worktreePath?: string }
  | { ok: false; outcome: UnitOutcome };

async function prepareAttemptWorktree(input: JournaledAttemptInput): Promise<PreparedAttemptWorktree> {
  if (input.worktreeBase === undefined) return { ok: true, request: input.request };
  const created = await createUnitWorktree(
    input.worktreeBase,
    input.ctx.runId,
    input.attemptId,
    // A child-workflow target (P3a, schema-v4.ts) carries no gitCommitOid of
    // its own — it is a composition target, never a worktree-isolated exec
    // one. This arm IS reachable — a step that composes a child workflow and
    // also declares `isolation: worktree` gets a worktree prepared here
    // (worktree prep runs ahead of dispatch), but the child executor
    // (child-workflow.ts, P3b §3.2) never dispatches through it: driving a
    // child publishes and drives a RUN, not a command/exec unit, so the
    // prepared worktree is simply unused by the drive. This ternary keeps the
    // field access total over the frozen-target union either way.
    input.workUnit.frozenTarget.kind === "child-workflow" ? undefined : input.workUnit.frozenTarget.gitCommitOid,
  );
  if (created.preservedLeftover !== undefined) {
    warn(
      `Workflow unit ${input.attemptId}: a previous attempt left uncollected work in its isolation worktree; ` +
        `preserved at ${created.preservedLeftover}`,
    );
  }
  if (!created.ok) {
    return {
      ok: false,
      outcome: {
        unitId: input.request.unitId,
        ok: false,
        failureReason: "worktree_failed",
        error: created.error,
      },
    };
  }
  return { ok: true, request: { ...input.request, cwd: created.path }, worktreePath: created.path };
}

async function reserveJournaledDispatch(
  input: JournaledAttemptInput,
  worktreePath: string | undefined,
  startedAt: string,
): Promise<WorkflowRunUnitAttemptRowV4> {
  const { plan, workUnit, ctx, attemptId, inputHash } = input;
  let durableAttempt: WorkflowRunUnitAttemptRowV4 | undefined;
  await enqueueUnitWrite(async () => {
    await withWorkflowRunsRepo((repo) => {
      const target = workUnit.frozenTarget;
      durableAttempt = repo.reserveUnitAttempt({
        runId: ctx.runId,
        unitId: attemptId,
        stepId: plan.stepId,
        nodeId: workUnit.nodeId,
        parentUnitId: workUnit.isFanOut ? `${plan.stepId}.map` : null,
        phase: "unit",
        runner: workUnit.runner,
        engine: target.kind === "command" ? target.request.engine.name : null,
        model: target.kind === "command" ? (target.request.model?.resolved ?? null) : null,
        inputHash,
        worktreePath: worktreePath ?? null,
        now: startedAt,
      }).attempt;
    });
  });
  if (!durableAttempt) throw new Error(`unit "${attemptId}" did not reserve a durable attempt`);
  return durableAttempt;
}

async function finishJournaledDispatch(input: {
  attempt: JournaledAttemptInput;
  durableAttempt: WorkflowRunUnitAttemptRowV4;
  finishedAt: string;
  outcome: UnitOutcome;
}): Promise<void> {
  const { attempt: source, durableAttempt, finishedAt, outcome } = input;
  const { ctx, attemptId } = source;
  await enqueueUnitWrite(() =>
    withWorkflowRunsRepo((repo) => {
      const finished = repo.finishUnitAttempt({
        runId: ctx.runId,
        unitId: attemptId,
        attempt: durableAttempt.attempt,
        dispatchId: durableAttempt.dispatch_id,
        status: outcome.ok ? "completed" : "failed",
        resultJson: journaledUnitResultJson(outcome),
        tokens: outcome.tokens ?? null,
        failureReason: outcome.failureReason ?? null,
        sessionId: outcome.sessionId ?? null,
        finishedAt,
      });
      if (!finished) {
        if (repo.getUnitAttempts(ctx.runId, attemptId).length === 0) {
          throw new Error(
            `finishUnitAttempt updated no row: no durable attempt "${attemptId}" exists for run "${ctx.runId}".`,
          );
        }
        warn(
          `Workflow unit ${attemptId} (run ${ctx.runId}) ${outcome.ok ? "completed" : `failed (${outcome.failureReason ?? "error"})`}, ` +
            "but its durable attempt was already finished — refusing a duplicate terminal write. " +
            "This dispatch's result is not journaled.",
        );
      }
    }),
  );
}

function queueAttemptWorktreeCleanup(input: JournaledAttemptInput, worktreePath: string | undefined): void {
  if (worktreePath === undefined || input.worktreeBase === undefined) return;
  const worktreeBase = input.worktreeBase;
  input.pendingWorktreeCleanups.push(
    (async () => {
      try {
        const cleanup = await cleanupUnitWorktree(worktreeBase, worktreePath);
        if (cleanup.dirty) {
          warn(
            `Workflow unit ${input.attemptId} left uncommitted changes in its isolation worktree; retained at ${worktreePath}`,
          );
        } else if (!cleanup.removed) {
          warn(
            `Workflow unit ${input.attemptId}: could not clean up isolation worktree ${worktreePath}: ${cleanup.error}`,
          );
        }
      } catch (err) {
        warn(
          `Workflow unit ${input.attemptId}: could not clean up isolation worktree ${worktreePath}: ${message(err)}`,
        );
      }
    })(),
  );
}

/** Journal one dispatch attempt: insert row, events, dispatch, finish row. */
async function dispatchJournaledAttempt(input: JournaledAttemptInput): Promise<UnitOutcome> {
  const { workUnit, ctx, dispatcher, attemptId } = input;
  const prepared = await prepareAttemptWorktree(input);
  if (!prepared.ok) return prepared.outcome;
  let { request } = prepared;
  const { worktreePath } = prepared;

  const startedAt = new Date().toISOString();
  let durableAttempt: WorkflowRunUnitAttemptRowV4;
  try {
    durableAttempt = await reserveJournaledDispatch(input, worktreePath, startedAt);
  } catch (err) {
    // A failed dispatch-row insert means NOTHING dispatched (the row is the
    // dispatch's precondition) — fail the unit with the real cause instead of
    // letting the throw escape into the scheduler, where a swallowed worker
    // error is indistinguishable from "never claimed" and used to be
    // misreported as an aborted, never-dispatched unit.
    if (worktreePath !== undefined && input.worktreeBase !== undefined)
      await cleanupUnitWorktree(input.worktreeBase, worktreePath);
    return {
      unitId: request.unitId,
      ok: false,
      failureReason: "dispatch_error",
      error: `unit "${attemptId}" could not journal its dispatch row (nothing was dispatched): ${message(err)}`,
    };
  }
  request = {
    ...request,
    attempt: durableAttempt.attempt,
    dispatchId: durableAttempt.dispatch_id,
  };

  // P3b §3.2: the ONE dispatch-seam branch. A `child-workflow`-targeted unit
  // never reaches `UnitDispatcher` — it is routed to the child executor
  // instead (src/workflows/exec/child-workflow.ts), which publishes the
  // child idempotently and drives it with the SAME engine
  // (`runWorkflowSteps`) the top-level path uses. Placed HERE — after
  // `reserveJournaledDispatch` claims this attempt row, before
  // `finishJournaledDispatch`/the worktree epilogue below — so a
  // child-workflow unit is journaled exactly like any other unit, and a
  // crash between reservation and child publication leaves a `running`
  // parent row with no child, recovered by resume (which re-dispatches the
  // parent unit and republishes the child idempotently).
  const dispatched =
    request.frozenTarget.kind === "child-workflow"
      ? await driveChildWorkflowUnit({
          request,
          target: request.frozenTarget,
          ctx,
          childParams: workUnit.childParams ?? {},
          inputHash: input.inputHash,
          dispatcher,
        })
      : await dispatchUnit(request, dispatcher);
  // Credential and passthrough values are intentionally sampled only AFTER
  // the default dispatcher has authorized/lowered the frozen request and
  // materialized credentials at its terminal dispatch boundary. Custom test
  // dispatchers receive the same post-dispatch journal scrub. Secret-shaped
  // run params join the set: they must reach the prompt in clear (the unit
  // needs them), but nothing about them needs to reach the journal.
  const sensitiveValues = collectWorkflowDispatchSensitiveValues(
    {
      ...(request.frozenTarget.kind === "command" ? { runner: request.frozenTarget.runner } : {}),
      sensitiveValues: [...(request.sensitiveValues ?? []), ...secretShapedParamValues(ctx.params)],
    },
    request.env,
  );
  const outcome = redactUnitOutcome(dispatched, sensitiveValues);

  const finishedAt = new Date().toISOString();
  // A dispatched unit's outcome is NEVER silently discarded: the attempt is
  // finished with the real result even when the run went non-active
  // mid-flight — dropping it would leave the row `running` and make a later
  // resume re-dispatch side-effecting work that already ran and already spent
  // tokens. Persisting a unit result never advances the run; that is
  // completeWorkflowStep's job.
  let journalError: unknown;
  try {
    await finishJournaledDispatch({
      attempt: input,
      durableAttempt,
      finishedAt,
      outcome,
    });
  } catch (err) {
    journalError = err;
  }

  // Worktree lifecycle epilogue: a CLEAN worktree is removed; a DIRTY one is
  // retained and logged — the unit left uncollected work, and its journaled
  // worktree_path says where. Cleanup is best-effort observability, never a
  // unit failure, so it is STARTED here and awaited at the step barrier: the
  // removal serializes on the same per-repo chain as every sibling's
  // `git worktree add`, and awaiting it in this unit's scheduler slot made a
  // finished unit wait out other units' full checkouts before its worker could
  // claim the next item.
  queueAttemptWorktreeCleanup(input, worktreePath);

  // A journal-write failure AFTER a successful dispatch is its own loud
  // failure class: the unit's work ran (and may have succeeded), but its
  // terminal state could not be recorded, so the row may be stuck `running`.
  // It must never masquerade as "not dispatched" — the outcome names the unit
  // and the real cause, and executeStepPlan fails the step hard on it
  // (out-of-taxonomy reason, so retry.on can never re-dispatch the work).
  if (journalError !== undefined) {
    return {
      unitId: request.unitId,
      ok: false,
      failureReason: "journal_write_failed",
      error:
        `unit "${attemptId}" dispatched and ${outcome.ok ? "completed" : `failed (${outcome.failureReason ?? "error"})`}, ` +
        `but its result could not be journaled: ${message(journalError)}`,
      ...(outcome.tokens !== undefined ? { tokens: outcome.tokens } : {}),
      ...(outcome.sessionId !== undefined ? { sessionId: outcome.sessionId } : {}),
      ...(outcome.notices ? { notices: outcome.notices } : {}),
    };
  }

  return outcome;
}

/**
 * Strict JSON parse for an `exec` unit's declared-schema output: stdout must be
 * EXACTLY one JSON value (leading/trailing whitespace tolerated, nothing else).
 *
 * Deliberately NOT `parseEmbeddedJsonResponse` — that scan strips code fences
 * and hunts for a JSON island inside prose, which is the right forgiving
 * behavior for an LLM and the wrong one for a command, where it would silently
 * promote a JSON fragment found in unrelated log noise as the typed artifact.
 * Returning `undefined` makes `runStructured` report `parse_error` (a real
 * member of the retry taxonomy), so `retry.on: [parse_error]` still works.
 */
function parseExecJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Transport failures surface as this sentinel so runStructured doesn't retry them. */
class UnitTransportError extends Error {
  constructor(readonly result: UnitDispatchResult) {
    super(result.error ?? "unit dispatch failed");
    this.name = "UnitTransportError";
  }
}

async function dispatchUnit(request: UnitDispatchRequest, dispatcher: UnitDispatcher): Promise<UnitOutcome> {
  let tokens = 0;
  let sawUsage = false;
  let loweringNotices: UnitDispatchResult["notices"];
  // Harness-native session id revealed by dispatch (P2). Captured across
  // structured-output retries (last one wins) so it survives into the
  // UnitOutcome and gets journaled by finishUnitAttempt — the seam's
  // contract ("stored opportunistically on the unit row for resume").
  let sessionId: string | undefined;
  const dispatchOnce = async (feedback?: string): Promise<string> => {
    const result = await dispatcher(request, feedback);
    if (result.usage) {
      sawUsage = true;
      tokens +=
        (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0) + (result.usage.reasoningTokens ?? 0);
    }
    loweringNotices = mergeLoweringNotices(loweringNotices, result.notices);
    // Capture before the ok-check: a failed attempt can still have configured
    // a session (e.g. codex `session_configured` then a tool crash).
    if (result.sessionId !== undefined) sessionId = result.sessionId;
    if (!result.ok) throw new UnitTransportError(result);
    return result.text;
  };
  const captured = (): Partial<UnitOutcome> => ({
    ...(sawUsage ? { tokens } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(loweringNotices ? { notices: loweringNotices } : {}),
  });

  try {
    if (request.schema) {
      const schema = request.schema;
      const structured = await runStructured<unknown>({
        dispatch: dispatchOnce,
        // A command is not re-promptable. Its stdout must be EXACTLY one JSON
        // value: the default embedded-JSON scan (fences, think-blocks, "find the
        // JSON inside the prose") is right for an LLM and wrong for a command,
        // where it would pluck a JSON fragment out of unrelated log noise and
        // promote it as the typed artifact. And it gets exactly ONE attempt —
        // `runStructured`'s corrective retry re-dispatches with feedback, which
        // for a command means running a SIDE-EFFECTING process a second time
        // with byte-identical argv: it cannot produce different output, and it
        // can produce a second deployment. Declared `retry:` still applies (the
        // executor's own loop), because that is a policy the author opted into
        // per failure reason.
        ...(request.frozenTarget.kind !== "command" ? { parse: parseExecJson, maxAttempts: 1 } : {}),
        validate: (candidate) => {
          const errors = validateJsonSchemaSubset(candidate, schema);
          return errors.length === 0 ? { ok: true, value: candidate } : { ok: false, errors };
        },
      });
      if (structured.ok) {
        return { unitId: request.unitId, ok: true, result: structured.value, ...captured() };
      }
      return {
        unitId: request.unitId,
        ok: false,
        // NOTE: `validation_error` is deliberately outside PROGRAM_RETRY_REASONS,
        // so no `retry.on:` can name it and a schema-violating unit is not
        // re-run — see "fails with `validation_error` and is NOT re-run" in
        // tests/integration/workflows/exec-unit.test.ts. A sweep finding
        // proposed mapping it onto `llm_invalid_json` (which the parser accepts
        // but this path never emits) to make such failures retryable; that is a
        // behaviour change against an intentional design, not a bug fix, so it
        // is left alone. Reconciling the vocabulary is a 0.9.2 decision.
        failureReason: structured.reason,
        error: structured.errors.join("; "),
        text: structured.raw,
        ...captured(),
      };
    }

    const text = await dispatchOnce();
    // Normalize an EMPTY successful output to "no text". `finishUnitAttempt` journals
    // result_json = NULL for a falsy text, so durable-reuse rehydrates NO text
    // from the row (unitOutcomeFromRow). Preserving `text: ""` only in this live
    // outcome would make the LIVE step artifact ("") diverge from the artifact a
    // resume rebuilds from the row (null) — the exact byte-identical-graph
    // violation the cardinal rule forbids. Treating empty as absent keeps live
    // dispatch and engine resume identical.
    return { unitId: request.unitId, ok: true, ...(text ? { text } : {}), ...captured() };
  } catch (err) {
    if (err instanceof UnitTransportError) {
      return {
        unitId: request.unitId,
        ok: false,
        failureReason: err.result.failureReason ?? "dispatch_error",
        error: err.result.error ?? "unit dispatch failed",
        text: err.result.text,
        ...captured(),
      };
    }
    return {
      unitId: request.unitId,
      ok: false,
      failureReason: "dispatch_error",
      error: message(err),
      ...captured(),
    };
  }
}

// ── Default dispatcher (production substrate) ───────────────────────────────

/**
 * Dispatch a frozen engine through the common prepare → lower → dispatch seam.
 * No live profile/default/model map is consulted, and credentials remain
 * symbolic until the final dispatch boundary.
 */
export const defaultUnitDispatcher: UnitDispatcher = async (request, feedback) => {
  const frozenTarget = request.frozenTarget;
  if (frozenTarget.kind === "script") {
    assertFrozenDirectoryContained(frozenTarget.cwdIdentity);
    const materialized = materializeFrozenScript({
      sourceRef: frozenTarget.ref,
      interpreter: frozenTarget.interpreter as TaskV3ScriptInterpreter,
      extension: frozenTarget.extension,
      bytesBase64: frozenTarget.bytesBase64,
      byteLength: frozenTarget.byteLength,
      sha256: frozenTarget.contentHash,
    });
    try {
      const command = frozenScriptCommand(
        {
          sourceRef: frozenTarget.ref,
          interpreter: frozenTarget.interpreter as TaskV3ScriptInterpreter,
          extension: frozenTarget.extension,
          bytesBase64: frozenTarget.bytesBase64,
          byteLength: frozenTarget.byteLength,
          sha256: frozenTarget.contentHash,
        },
        materialized.file,
      );
      return await runExecUnit({
        unitId: request.unitId,
        exec: {
          ...frozenTarget.exec,
          command: command as [string, ...string[]],
        },
        baseDir: request.cwd ?? frozenTarget.cwdIdentity.realCwd,
        ...(request.env ? { env: request.env } : {}),
        ...(request.execContext ? { context: request.execContext } : {}),
        ...(request.schema ? { hasOutputSchema: true } : {}),
        timeoutMs: request.timeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.eventSource !== undefined ? { eventSource: request.eventSource } : {}),
      });
    } finally {
      cleanupFrozenScript(materialized);
    }
  }
  if (frozenTarget.kind === "shell") {
    if (frozenTarget.cwdIdentity) assertFrozenDirectoryContained(frozenTarget.cwdIdentity);
    return runExecUnit({
      unitId: request.unitId,
      exec: frozenTarget.exec,
      baseDir: request.cwd ?? frozenTarget.cwdIdentity?.realCwd ?? process.cwd(),
      ...(request.env ? { env: request.env } : {}),
      ...(request.execContext ? { context: request.execContext } : {}),
      ...(request.schema ? { hasOutputSchema: true } : {}),
      timeoutMs: request.timeoutMs,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.eventSource !== undefined ? { eventSource: request.eventSource } : {}),
    });
  }
  return dispatchWorkflowExecution(request, feedback);
};

// ── Small helpers ────────────────────────────────────────────────────────────

/**
 * Rehydrate a journaled completed unit row into a UnitOutcome (durable-row
 * reuse). Delegates to the shared {@link unitOutcomeFromRow} — the reuse path
 * only reaches here for completed rows (the caller guards `status ===
 * "completed"`), so a reused unit contributes exactly what its original
 * dispatch did.
 */
function reuseCompletedUnit(unitId: string, row: WorkflowRunUnitRow, hasSchema: boolean): UnitOutcome {
  return unitOutcomeFromRow(unitId, row, hasSchema);
}

function failedStep(
  dispatched: number,
  reason: string,
  notices?: readonly Readonly<LoweringNotice>[],
): StepExecutionResult {
  return {
    ok: false,
    units: [],
    ...(notices ? { notices } : {}),
    evidence: { error: reason },
    summary: reason,
    unitsDispatched: dispatched,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
