// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Native executor — executes ONE step's IR v2 subgraph (`IrStepPlan.root`) on
 * the local machine: fan-out through the scheduler, schema-validated
 * structured output through `runStructured` (core/structured.ts), per-unit
 * persistence through the serialized writer queue, and `workflow_unit_*`
 * events for observability.
 *
 * Data flow (redesign addendum, R1): workflow-authored templates go through
 * the deterministic `${{ … }}` expression language (`program/expressions.ts`)
 * — but ONLY for nodes the frontend marked `templating: "expressions"` (YAML
 * program units). Classic linear markdown instructions are `"verbatim"`:
 * opaque data handed to the agent byte-exact (the stable CLI contract — a
 * literal `${{` there is content, never grammar). Expression templates are
 * parsed ONCE per step and resolved per unit against `{ params, stepOutputs,
 * item, item_index }`; `map.over` resolves as a single whole-value reference.
 * Substituted content is data, never re-scanned — the P1 `{{item}}` re-scan
 * injection class is structurally impossible. There is NO ambient key search:
 * a `steps.<id>.output.<path>` reference addresses INTO that step's recorded
 * output explicitly.
 *
 * Step outputs (`${{ steps.<id>.output… }}`): every engine-executed step
 * journals a promoted ARTIFACT under `evidence.output` — the solo unit's
 * result/text, the collect reducer's per-item array, or the vote reducer's
 * winner — and that artifact is what the expression scope exposes
 * ({@link projectStepOutput}). The documented addressing
 * (`steps.discover.output.files`) therefore resolves against real step
 * results, never the raw evidence envelope (peer review R1). Steps completed
 * manually (no `output` key in their evidence) expose their recorded evidence
 * object as-is.
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
 *   - DUPLICATE items in one fan-out list collide on identity. That is an
 *     authoring error (the same work dispatched twice under one id): the step
 *     fails deterministically after resolving the item list, naming the
 *     duplicate, before anything dispatches.
 *   - REPLAY DIVERGENCE: a journaled COMPLETED row whose unit_id matches but
 *     whose `input_hash` differs is a hard step failure ("replay divergence"),
 *     never a silent re-dispatch — under a frozen plan the same identity must
 *     reproduce the same inputs, so a mismatch means the journal (or params
 *     row) was tampered with. Failed/running/missing rows dispatch live.
 *   - Pre-release R1 journals used positional ids (`node.unit[3]`). There is
 *     no back-compat shim: those rows simply never match a content-derived id
 *     and are ignored (the step re-runs cleanly on top of them).
 *
 * Gate loops (addendum, R2 `gate.max_loops`): when the engine re-executes a
 * step subgraph after a gate rejection, it threads the judge's feedback in as
 * `ctx.gateFeedback` (appended to every unit prompt — the input hash changes,
 * so re-dispatch is natural) and marks the attempt with `ctx.gateLoop` (>= 2).
 * Loop attempts journal under `<unitId>~l<loop>` — like `~r<n>` retries, pure
 * journal bookkeeping on top of the content-derived identity, so loop 1's
 * rows are never clobbered. Because gate feedback is JUDGE-authored (a fresh
 * LLM output per invocation, not a pure function of the frozen plan), a
 * journaled loop row whose hash no longer matches re-dispatches live instead
 * of raising replay divergence — the divergence guarantee applies to loop-1
 * rows, whose inputs ARE pure functions of (plan, params, journaled results).
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
 * retained + logged (uncollected work is never destroyed). A non-git base
 * directory fails the step cleanly before any dispatch, and llm units reject
 * isolation loudly — there is no child process to isolate.
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
 *     default dispatcher composes the EXISTING substrate — `executeRunner`
 *     (agent/sdk) and `chatCompletion` (llm, lazily imported so the engine
 *     stays offline-capable until a workflow actually declares an llm unit).
 *   - This module NEVER writes step rows: advancing the gated spine is the
 *     engine loop's job (`run-workflow.ts`) via `completeWorkflowStep`.
 */

import { ConfigError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { validateJsonSchemaSubset } from "../../core/json-schema";
import { runStructured } from "../../core/structured";
import { warn } from "../../core/warn";
import type { AgentTokenUsage } from "../../integrations/agent/spawn";
import { type WorkflowRunUnitRow, withWorkflowRunsRepo } from "../../storage/repositories/workflow-runs-repository";
import type { IrBudget, IrStepPlan } from "../ir/schema";
import { LIFETIME_UNIT_CAP, scheduleUnits, UnitCapExceededError } from "./scheduler";
// Shared step semantics — the ONE implementation consumed by both the engine
// (this module + run-workflow.ts) and, from R3, the brief/report driver
// protocol. This module dispatches; step-work.ts owns the pure decisions.
import {
  buildArtifactSummary,
  buildEvidence,
  computeStepWorkList,
  DEFAULT_UNIT_TIMEOUT_MS,
  type GateFeedback,
  projectStepOutput,
  type StepWorkUnit,
  stepOutputsFromEvidence,
  type UnitOutcome,
  validateStepArtifact,
} from "./step-work";
import { enqueueUnitWrite } from "./unit-writer";
import { assertGitWorkTree, cleanupUnitWorktree, createUnitWorktree } from "./worktree";

// Re-exported for existing consumers (run-workflow.ts, tests) that import these
// from native-executor; they now live in the shared step-work module.
export { buildArtifactSummary, DEFAULT_UNIT_TIMEOUT_MS, type GateFeedback, projectStepOutput, type UnitOutcome };

/** Everything the dispatcher needs to run one unit, resolved by the executor. */
export interface UnitDispatchRequest {
  runId: string;
  stepId: string;
  unitId: string;
  nodeId: string;
  /** Fully-assembled prompt: preamble + interpolated instructions (+ schema directive). */
  prompt: string;
  runner: "llm" | "agent" | "sdk" | "inherit";
  profile?: string;
  model?: string;
  timeoutMs: number | null;
  schema?: Record<string, unknown>;
  /** Resolved env bindings to merge into the child environment. */
  env?: Record<string, string>;
  /**
   * Working directory for the unit's child — set exactly when the unit
   * declares `isolation: worktree` (a fresh detached worktree per attempt,
   * see `worktree.ts`). Forwarded to the agent (CLI) spawn and, per-call, to
   * the opencode SDK session; the llm runner has no working directory, so a
   * cwd reaching a resolved-llm dispatch fails loudly.
   */
  cwd?: string;
  signal?: AbortSignal;
}

export interface UnitDispatchResult {
  ok: boolean;
  /**
   * Text output. For agent (CLI) units whose harness declares a
   * `resultExtractor`, this is the NORMALIZED final answer (transport framing
   * stripped — plan §"The adapter contract" step 3); otherwise the raw
   * stdout / SDK message / LLM content.
   */
  text: string;
  /**
   * Harness-native session id, when the harness's result extractor (or the
   * SDK path) revealed one. Journaled opportunistically on the unit row
   * (`workflow_run_units.session_id`, migration 005) via {@link UnitOutcome};
   * akm never depends on it (plan §"Session, MCP, and identity across
   * harnesses").
   */
  sessionId?: string;
  /** Structured failure vocabulary (spawn.ts AgentFailureReason or config/llm errors). */
  failureReason?: string;
  error?: string;
  usage?: AgentTokenUsage;
}

/** The one dispatch seam. `feedback` carries runStructured's corrective retry message. */
export type UnitDispatcher = (request: UnitDispatchRequest, feedback?: string) => Promise<UnitDispatchResult>;

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
   * Base directory for `isolation: worktree` units — the git repository the
   * per-attempt detached worktrees are minted from. Defaults to
   * `process.cwd()` (the directory the engine invocation runs in); injected
   * by tests so no chdir is needed.
   */
  workDir?: string;
}

export interface StepExecutionResult {
  ok: boolean;
  units: UnitOutcome[];
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
   * failure (dispatch errors, replay divergence, cap) stays a hard stop.
   */
  artifactSchemaFailure?: true;
}

/**
 * Mutable per-step dispatch budget: the lifetime unit cap PLUS the declared
 * run-level budget ceilings (`budget.max_units` / `budget.max_tokens`,
 * addendum R2). Consumed once per journaled dispatch attempt (including
 * retries); durable-row reuses never touch it — the peer-review fix that
 * keeps large partially-completed fan-outs resumable instead of tripping the
 * cap on `journaled + items`. Token usage accumulates per actual dispatch on
 * top of the journal-seeded run total (reused rows' tokens are already in the
 * seed). Check-and-increment is synchronous, so concurrent units cannot race
 * it; crossing a declared ceiling fires `onExceeded` ONCE (the executor's
 * chained AbortController), aborting pending and in-flight dispatches.
 */
class DispatchBudget {
  used: number;
  /** Run-total tokens: journal-seeded input + this step's dispatch usage. */
  tokens: number;
  /** Set (once) when a dispatch was refused; the step fails with this message. */
  capMessage: string | undefined;
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
    if (this.used >= LIFETIME_UNIT_CAP) {
      this.capMessage ??= new UnitCapExceededError(LIFETIME_UNIT_CAP).message;
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

/** Execute one step plan natively. Never throws for unit-level failures. */
export async function executeStepPlan(plan: IrStepPlan, ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const dispatched = ctx.unitsDispatched ?? 0;

  // Work-list computation is the SHARED, PURE decision (step-work.ts): resolve
  // the fan-out list, derive content-derived unit ids, assemble each unit's
  // prompt, and hash its resolved input. `brief` (R3) computes the identical
  // list — that shared implementation is the anti-drift guarantee. This module
  // owns only the impure remainder: env/worktree preflight, durable-row reuse,
  // dispatch, journaling, budget.
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
    // The promoted step artifact of an empty collect is the empty array; an
    // empty vote has no winner, so its artifact is null (references into it
    // fail loudly at resolution instead of falling back to the envelope).
    const emptyEvidence = { units: [], itemCount: 0, output: reducer === "collect" ? [] : null };
    // Typed artifacts (R2): even the degenerate empty artifact must honor the
    // step's declared output schema before it can complete.
    const schemaFailure = validateStepArtifact(plan, emptyEvidence);
    return {
      ok: schemaFailure === undefined,
      units: [],
      evidence: emptyEvidence,
      summary: schemaFailure ?? `Step "${plan.stepId}" fan-out list was empty — no units dispatched.`,
      unitsDispatched: dispatched,
      ...(schemaFailure !== undefined ? { artifactSchemaFailure: true as const } : {}),
    };
  }

  // Env bindings resolve once per step, before any dispatch; a binding error
  // fails the whole step cleanly rather than N units racing into it.
  let env: Record<string, string> | undefined;
  if (template.env && template.env.length > 0) {
    try {
      env = await resolveEnvBindings(template.env);
    } catch (err) {
      return failedStep(dispatched, `Step "${plan.stepId}" env binding failed: ${message(err)}`);
    }
  }

  // Worktree isolation preflight (addendum R2), once per step, before any
  // dispatch: llm units have no working directory to isolate (fail loudly),
  // and a non-git base directory fails the step cleanly instead of N units
  // racing into identical git errors. The actual worktrees are minted per
  // journaled attempt in dispatchJournaledAttempt.
  let worktreeBase: string | undefined;
  if (template.isolation === "worktree") {
    if (template.runner === "llm") {
      return failedStep(
        dispatched,
        `Step "${plan.stepId}" declares isolation: worktree on an llm unit — the llm runner has no ` +
          `working directory to isolate. Use the agent or sdk runner for worktree-isolated units.`,
      );
    }
    const base = ctx.workDir ?? process.cwd();
    const gitError = assertGitWorkTree(base);
    if (gitError !== undefined) {
      return failedStep(dispatched, `Step "${plan.stepId}" cannot use isolation: worktree: ${gitError}`);
    }
    worktreeBase = base;
  }

  const dispatcher = ctx.dispatcher ?? defaultUnitDispatcher;

  // Durable-row resume: a unit whose previous attempt completed with the
  // SAME input (prompt/runner/model/schema hash) is reused, not re-dispatched
  // — a crash-resume must never double-issue side-effecting work.
  const existingUnits = new Map<string, WorkflowRunUnitRow>();
  for (const row of await withWorkflowRunsRepo((repo) => repo.getUnitsForStep(ctx.runId, plan.stepId))) {
    existingUnits.set(row.unit_id, row);
  }

  // Budget ceilings (addendum R2): when the frozen plan declares a budget,
  // dispatch runs under an AbortController CHAINED onto ctx.signal — hitting
  // a ceiling aborts pending and in-flight dispatches, and the step fails
  // hard below. Without a budget the context signal passes through untouched
  // (the no-budget path is byte-identical to pre-R2 behavior).
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

  // Lifetime-cap + declared-budget accounting: seeded with the run's
  // journaled dispatch count and token total, consumed per ACTUAL dispatch
  // inside runUnit — never for durable-row reuses, so resuming a large
  // partially-completed fan-out works.
  const budget = new DispatchBudget(dispatched, {
    tokensUsed: ctx.tokensUsed ?? 0,
    ...(declaredBudget ? { budget: declaredBudget } : {}),
    ...(onExceeded ? { onExceeded } : {}),
  });

  let outcomes: Array<UnitOutcome | undefined>;
  try {
    outcomes = await scheduleUnits(
      workUnits,
      (workUnit) =>
        runUnit({
          plan,
          workUnit,
          env,
          ...(worktreeBase !== undefined ? { worktreeBase } : {}),
          ctx,
          signal,
          dispatcher,
          existingUnits,
          budget,
        }),
      {
        concurrency: workList.list.concurrency,
        signal,
        maxConcurrency: ctx.maxConcurrency,
      },
    );
  } finally {
    unchainSignal?.();
  }

  // Declared budget ceilings and the lifetime cap are hard backstops: a step
  // that hit one FAILS regardless of on_error policy (a capped run must never
  // quietly pass its gate). The budget message names WHICH ceiling tripped.
  if (budget.budgetMessage) {
    return { ...failedStep(budget.used, budget.budgetMessage), tokensUsed: budget.tokens };
  }
  if (budget.capMessage) {
    return { ...failedStep(budget.used, budget.capMessage), tokensUsed: budget.tokens };
  }

  const units = outcomes.map(
    (outcome, index) =>
      outcome ?? {
        unitId: workUnits[index].unitId,
        ok: false,
        failureReason: "aborted",
        error: "unit was not dispatched (aborted or scheduler failure)",
      },
  );

  // Replay divergence is a HARD failure regardless of on_error: a journal
  // whose completed row disagrees with the frozen plan's inputs must stop the
  // run loudly (module doc), never be tolerated as "just a failed unit".
  const diverged = units.filter((u) => u.failureReason === "replay_divergence");
  if (diverged.length > 0) {
    return failedStep(
      budget.used,
      diverged
        .map((u) => u.error ?? `replay divergence: unit "${u.unitId}" was journaled with different inputs`)
        .join(" "),
    );
  }

  // Failure policy (IR v2): `onError: "fail"` (the default) fails the step on
  // any unit failure; `"continue"` records the failures in the evidence (the
  // summary still counts them) and lets the completion gate decide. A vote
  // reducer with no majority fails the step under either policy — a routing
  // decision downstream must never consume a non-result.
  const failed = units.filter((u) => !u.ok);
  const evidence = buildEvidence(units, reducer, isFanOut);
  const reducerNote = typeof evidence.voteError === "string" ? ` ${evidence.voteError}` : "";
  const tolerateFailures = template.onError === "continue";
  let ok = (tolerateFailures || failed.length === 0) && !evidence.voteError;
  let summary =
    `Executed ${units.length} unit(s) for step "${plan.stepId}" via the native executor: ` +
    `${units.length - failed.length} succeeded, ${failed.length} failed.` +
    (failed.length > 0
      ? ` Failures${tolerateFailures ? " (recorded, on_error: continue)" : ""}: ${failed
          .map((u) => `${u.unitId} (${u.failureReason ?? "error"})`)
          .join(", ")}.`
      : "") +
    reducerNote;

  // Typed artifacts (R2): validate the promoted artifact against the step's
  // declared output schema BEFORE completion. A mismatch fails the step —
  // fail-fast, with the validation errors in the summary — never lets a
  // schema-violating artifact reach downstream references or the gate. The
  // `artifactSchemaFailure` marker lets the engine's bounded gate loop retry
  // this ONE failure class with the errors as feedback (module doc).
  let artifactSchemaFailure = false;
  if (ok) {
    const schemaFailure = validateStepArtifact(plan, evidence);
    if (schemaFailure !== undefined) {
      ok = false;
      summary = schemaFailure;
      artifactSchemaFailure = true;
    }
  }

  return {
    ok,
    units,
    evidence,
    summary,
    unitsDispatched: budget.used,
    tokensUsed: budget.tokens,
    ...(artifactSchemaFailure ? { artifactSchemaFailure: true as const } : {}),
  };
}

// ── One unit ─────────────────────────────────────────────────────────────────

interface RunUnitInput {
  plan: IrStepPlan;
  /** The precomputed work unit (id, resolved prompt + input hash, node metadata) from step-work. */
  workUnit: StepWorkUnit;
  env?: Record<string, string>;
  /** Git repo worktrees are minted from — set exactly when the unit declares `isolation: worktree`. */
  worktreeBase?: string;
  ctx: StepExecutionContext;
  /**
   * Effective dispatch signal: `ctx.signal`, or the budget-chained
   * AbortController's signal when the plan declares budget ceilings.
   */
  signal?: AbortSignal;
  dispatcher: UnitDispatcher;
  /** Prior unit rows for this step, for durable-row reuse. */
  existingUnits?: Map<string, WorkflowRunUnitRow>;
  /** Shared lifetime-cap budget; consumed once per actual dispatch attempt. */
  budget: DispatchBudget;
}

async function runUnit(input: RunUnitInput): Promise<UnitOutcome> {
  const { plan, workUnit, env, ctx, dispatcher } = input;
  const unitId = workUnit.unitId;

  // A per-unit expression resolution failure (missing param, bad `item.<path>`)
  // is deterministic authoring/data breakage computed by the shared work-list:
  // the unit fails WITHOUT dispatching — and without journaling a row, since no
  // resolved input exists to hash.
  if (!workUnit.resolved.ok) {
    return { unitId, ok: false, failureReason: "expression_error", error: workUnit.resolved.error };
  }

  // The prompt (and therefore the input hash) was built once with the BASE
  // unit id by computeStepWorkList: a retry re-dispatches the SAME input, the
  // `~r<n>` suffix is journal bookkeeping only.
  const { prompt, inputHash } = workUnit.resolved;

  const request: UnitDispatchRequest = {
    runId: ctx.runId,
    stepId: plan.stepId,
    unitId,
    nodeId: workUnit.nodeId,
    prompt,
    runner: workUnit.runner,
    ...(workUnit.profile ? { profile: workUnit.profile } : {}),
    ...(workUnit.model ? { model: workUnit.model } : {}),
    timeoutMs: workUnit.timeoutMs,
    ...(workUnit.schema ? { schema: workUnit.schema } : {}),
    ...(env ? { env } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  };

  // Bounded retry (IR v2 failure policy): attempt 0 journals under the base
  // journal id (`<unitId>`, or `<unitId>~l<loop>` in a gate loop — computed by
  // the shared work-list), retry attempt N under `<baseId>~r<N>`. Every attempt
  // keeps its own row. Retries only fire when the failure reason is in
  // `retry.on`.
  const retry = workUnit.retry;
  const maxAttempts = 1 + Math.max(0, retry?.max ?? 0);
  const gateLoop = ctx.gateLoop ?? 1;
  const journalBaseId = workUnit.journalBaseId;
  const attemptIdFor = (attempt: number): string => (attempt === 0 ? journalBaseId : `${journalBaseId}~r${attempt}`);

  // Durable-row reuse: the FIRST completed attempt of this unit decides.
  // Matching input hash → it IS the result: return it without touching rows,
  // dispatching, or re-emitting events (a crash-resume must never
  // double-issue work). A DIFFERENT hash → replay divergence: under a frozen
  // plan the same content-derived identity must reproduce the same inputs,
  // so the journal was tampered with — fail loudly (executeStepPlan promotes
  // this to a hard step failure regardless of on_error), never silently
  // re-dispatch. Failed/running/missing rows fall through and dispatch live;
  // pre-release R1 positional ids (`node.unit[3]`) never match and are
  // ignored (module doc).
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const attemptId = attemptIdFor(attempt);
    const prior = input.existingUnits?.get(attemptId);
    if (!prior || prior.status !== "completed") continue;
    if (prior.input_hash === inputHash) {
      return reuseCompletedUnit(attemptId, prior, workUnit.schema !== undefined);
    }
    if (gateLoop > 1) {
      // Gate-loop rows are NOT replay-deterministic: the prompt embeds the
      // judge's feedback, a fresh LLM output per invocation. A stale loop row
      // with a different hash re-dispatches live (INSERT OR REPLACE takes the
      // row over) — divergence only guards loop-1 rows (module doc).
      break;
    }
    return {
      unitId,
      ok: false,
      failureReason: "replay_divergence",
      error:
        `replay divergence: unit "${attemptId}" was journaled with different inputs ` +
        `(journaled input_hash does not match this invocation's) — refusing to re-dispatch.`,
    };
  }

  let outcome: UnitOutcome | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const attemptId = attemptIdFor(attempt);
    // Lifetime cap + declared budget ceilings, consumed per ACTUAL dispatch
    // (reuses above returned before reaching here). Refusal fails this unit
    // without journaling a row — nothing was dispatched — and the sticky
    // capMessage/budgetMessage fails the step.
    if (!input.budget.tryConsume()) {
      const budgetHit = input.budget.budgetMessage !== undefined;
      return (
        outcome ?? {
          unitId,
          ok: false,
          failureReason: budgetHit ? "budget_exceeded" : "unit_cap_exceeded",
          error: input.budget.budgetMessage ?? input.budget.capMessage ?? "lifetime unit cap exceeded",
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
    });
    // Budget token accounting (addendum R2): every actual dispatch's reported
    // usage counts against the run's max_tokens ceiling; crossing it aborts
    // pending dispatches via the chained controller. Reuses never reach here
    // (their tokens are already in the journal-seeded total).
    if (outcome.tokens !== undefined) input.budget.addTokens(outcome.tokens);
    if (outcome.ok) return outcome;
    const reason = outcome.failureReason;
    if (!retry || reason === undefined || !retry.on.includes(reason)) return outcome;
  }
  // maxAttempts >= 1, so outcome is always set by the loop above.
  return outcome as UnitOutcome;
}

interface JournaledAttemptInput {
  plan: IrStepPlan;
  workUnit: StepWorkUnit;
  ctx: StepExecutionContext;
  dispatcher: UnitDispatcher;
  request: UnitDispatchRequest;
  /** Journal id of this attempt: `<unitId>` or `<unitId>~r<n>` for retries. */
  attemptId: string;
  inputHash: string;
  /** Git repo to mint this attempt's isolation worktree from (`isolation: worktree`). */
  worktreeBase?: string;
}

/** Journal one dispatch attempt: insert row, events, dispatch, finish row. */
async function dispatchJournaledAttempt(input: JournaledAttemptInput): Promise<UnitOutcome> {
  const { plan, workUnit, ctx, dispatcher, attemptId, inputHash } = input;
  let request = input.request;

  // Worktree isolation (addendum R2): a FRESH detached worktree per journaled
  // attempt, minted before the row is inserted so worktree_path is journaled
  // with the dispatch. A creation failure fails the unit WITHOUT journaling a
  // row — nothing was dispatched (same contract as an expression failure).
  let worktreePath: string | undefined;
  if (input.worktreeBase !== undefined) {
    const created = createUnitWorktree(input.worktreeBase, ctx.runId, attemptId);
    if (!created.ok) {
      return { unitId: request.unitId, ok: false, failureReason: "worktree_failed", error: created.error };
    }
    if (created.preservedLeftover !== undefined) {
      // Never destroy a dirty (or unverifiable) leftover from a prior
      // invocation of the same attempt — it was moved aside instead.
      warn(
        `Workflow unit ${attemptId}: a previous attempt left uncollected work in its isolation worktree; ` +
          `preserved at ${created.preservedLeftover}`,
      );
    }
    worktreePath = created.path;
    request = { ...request, cwd: worktreePath };
  }

  await enqueueUnitWrite(async () => {
    await withWorkflowRunsRepo((repo) =>
      repo.insertUnit({
        runId: ctx.runId,
        unitId: attemptId,
        stepId: plan.stepId,
        nodeId: workUnit.nodeId,
        parentUnitId: workUnit.isFanOut ? `${plan.stepId}.map` : null,
        phase: null,
        runner: workUnit.runner,
        model: workUnit.model ?? null,
        inputHash,
        worktreePath: worktreePath ?? null,
        startedAt: new Date().toISOString(),
      }),
    );
  });
  // Ids/status only — instructions and results are workflow-authored content
  // and stay out of the events stream (07 P1-B).
  appendEvent({
    eventType: "workflow_unit_started",
    ref: ctx.workflowRef,
    metadata: { runId: ctx.runId, stepId: plan.stepId, unitId: attemptId },
  });

  const outcome = await dispatchUnit(request, dispatcher);

  await enqueueUnitWrite(async () => {
    await withWorkflowRunsRepo((repo) =>
      repo.finishUnit({
        runId: ctx.runId,
        unitId: attemptId,
        status: outcome.ok ? "completed" : "failed",
        resultJson:
          outcome.result !== undefined
            ? JSON.stringify(outcome.result)
            : outcome.text
              ? JSON.stringify(outcome.text)
              : null,
        tokens: outcome.tokens ?? null,
        failureReason: outcome.failureReason ?? null,
        // Harness-native session id (P2): journaled so resume can replay the
        // harness's own context cache (e.g. `codex exec resume <id>`).
        sessionId: outcome.sessionId ?? null,
        finishedAt: new Date().toISOString(),
      }),
    );
  });
  appendEvent({
    eventType: "workflow_unit_finished",
    ref: ctx.workflowRef,
    metadata: {
      runId: ctx.runId,
      stepId: plan.stepId,
      unitId: attemptId,
      status: outcome.ok ? "completed" : "failed",
      ...(outcome.failureReason ? { failureReason: outcome.failureReason } : {}),
      ...(outcome.tokens !== undefined ? { tokens: outcome.tokens } : {}),
    },
  });

  // Worktree lifecycle epilogue: a CLEAN worktree (`git status --porcelain`
  // empty) is removed; a DIRTY one is retained and logged — the unit left
  // uncollected work, and its journaled worktree_path says where. Cleanup is
  // best-effort observability, never a unit failure.
  if (worktreePath !== undefined && input.worktreeBase !== undefined) {
    const cleanup = cleanupUnitWorktree(input.worktreeBase, worktreePath);
    if (cleanup.dirty) {
      warn(
        `Workflow unit ${attemptId} left uncommitted changes in its isolation worktree; retained at ${worktreePath}`,
      );
    } else if (!cleanup.removed) {
      warn(`Workflow unit ${attemptId}: could not clean up isolation worktree ${worktreePath}: ${cleanup.error}`);
    }
  }

  return outcome;
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
  // Harness-native session id revealed by dispatch (P2). Captured across
  // structured-output retries (last one wins) so it survives into the
  // UnitOutcome and gets journaled on the unit row by finishUnit — the seam's
  // contract ("stored opportunistically on the unit row for resume").
  let sessionId: string | undefined;
  const dispatchOnce = async (feedback?: string): Promise<string> => {
    const result = await dispatcher(request, feedback);
    if (result.usage) {
      sawUsage = true;
      tokens +=
        (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0) + (result.usage.reasoningTokens ?? 0);
    }
    // Capture before the ok-check: a failed attempt can still have configured
    // a session (e.g. codex `session_configured` then a tool crash).
    if (result.sessionId !== undefined) sessionId = result.sessionId;
    if (!result.ok) throw new UnitTransportError(result);
    return result.text;
  };
  const captured = (): Partial<UnitOutcome> => ({
    ...(sawUsage ? { tokens } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  });

  try {
    if (request.schema) {
      const schema = request.schema;
      const structured = await runStructured<unknown>({
        dispatch: dispatchOnce,
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
        failureReason: structured.reason,
        error: structured.errors.join("; "),
        text: structured.raw,
        ...captured(),
      };
    }

    const text = await dispatchOnce();
    return { unitId: request.unitId, ok: true, text, ...captured() };
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

// ── Env bindings ─────────────────────────────────────────────────────────────

/**
 * Resolve every unit `env` ref through the extracted `akm env run` core
 * (loadEnv + secret tokens + dangerous-key policy + keys-only audit event).
 * Lazily imported so the engine has no env/secret dependency until a
 * workflow actually declares bindings.
 */
async function resolveEnvBindings(refs: string[]): Promise<Record<string, string>> {
  const { resolveEnvBinding } = await import("../../commands/env/env-binding.js");
  const merged: Record<string, string> = {};
  for (const ref of refs) {
    Object.assign(merged, resolveEnvBinding(ref).values);
  }
  return merged;
}

// ── Default dispatcher (production substrate) ───────────────────────────────

/**
 * Dispatch through akm's existing execution substrate:
 *   llm   → `chatCompletion` on the profile/default LLM connection
 *   agent → `executeRunner` → `runAgent` (per-harness AgentCommandBuilder)
 *   sdk   → `executeRunner` → `runOpencodeSdk`
 *
 * `inherit` resolves against config: the node/step profile, else
 * `defaults.agent` (sdk when the profile is opencode-sdk), else `defaults.llm`.
 */
export const defaultUnitDispatcher: UnitDispatcher = async (request, feedback) => {
  const { loadConfig } = await import("../../core/config/config.js");
  const config = loadConfig();
  const prompt = feedback ? `${request.prompt}\n\n${feedback}` : request.prompt;

  const resolved = resolveUnitRunner(request, config);

  // `env` bindings can only reach a child process. The agent (CLI) runner
  // spawns one per call, and the sdk runner now injects them for real via the
  // env-keyed opencode server registry (sdk-runner.ts module doc, open seam
  // decision 1 resolved in R2) — but the llm runner has no child at all, so
  // it still fails loudly: an audit event claiming an injection that never
  // reached the unit would be a lie.
  if (request.env && Object.keys(request.env).length > 0 && resolved.kind === "llm") {
    return {
      ok: false,
      text: "",
      failureReason: "env_unsupported",
      error:
        `unit "${request.unitId}" declares env bindings, which require a child process (agent or sdk runner) — ` +
        `the "llm" runner cannot inject a per-unit child environment.`,
    };
  }

  // Same shape for worktree isolation resolved onto llm through `inherit`:
  // the executor already rejects an EXPLICIT llm+isolation pairing before
  // dispatch, but an inherit unit only reveals its runner here.
  if (request.cwd && resolved.kind === "llm") {
    return {
      ok: false,
      text: "",
      failureReason: "isolation_unsupported",
      error:
        `unit "${request.unitId}" declares isolation: worktree but resolved to the "llm" runner, ` +
        `which has no working directory to isolate. Use the agent or sdk runner for isolated units.`,
    };
  }

  if (resolved.kind === "llm") {
    const { chatCompletion, LlmCallError } = await import("../../llm/client.js");
    const { resolveModel } = await import("../../integrations/agent/model-aliases.js");
    const connection = request.model
      ? { ...resolved.connection, model: resolveModel(request.model, "llm", undefined, config.modelAliases) }
      : resolved.connection;
    try {
      const text = await chatCompletion(connection, [{ role: "user", content: prompt }], {
        // null = author declared `timeout: none` — cap at the max signed
        // 32-bit delay (setTimeout's ceiling, ~24.8 days ≈ unbounded here).
        timeoutMs: request.timeoutMs === null ? 2 ** 31 - 1 : request.timeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
        // Native structured output where the connection supports it; the
        // executor's subset validator still runs downstream either way.
        ...(request.schema ? { responseSchema: request.schema } : {}),
      });
      return { ok: true, text };
    } catch (err) {
      // Map typed LlmCallError codes into the persisted AgentFailureReason
      // taxonomy — the vocabulary `retry.on` is validated against (program
      // schema PROGRAM_RETRY_REASONS) and the journal's failure_reason column
      // speaks. A collapsed out-of-taxonomy value ("llm_error") made the
      // declared failure policy dead for the entire llm runner.
      const failureReason = err instanceof LlmCallError ? llmFailureReasonFor(err.code) : ("dispatch_error" as const);
      return { ok: false, text: "", failureReason, error: message(err) };
    }
  }

  const { executeRunner } = await import("../../integrations/agent/runner-dispatch.js");
  const profile = request.model ? { ...resolved.profile, model: request.model } : resolved.profile;
  const result = await executeRunner({ kind: resolved.kind, profile }, prompt, {
    stdio: "captured",
    parseOutput: "text",
    timeoutMs: request.timeoutMs,
    ...(request.env ? { env: request.env } : {}),
    // Worktree isolation: the unit's fresh checkout is the child's cwd —
    // runAgent spawns there; the sdk runner scopes the session to it.
    ...(request.cwd ? { cwd: request.cwd } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
    // Route CLI dispatch through the platform AgentCommandBuilder so model
    // aliases resolve per-harness (P0.5 model routing).
    ...(resolved.kind === "agent" ? { dispatch: { prompt, ...(request.model ? { model: request.model } : {}) } } : {}),
  });

  // Harness result extraction (P2, plan §"The adapter contract" step 3):
  // when the profile's harness declares a `resultExtractor`, normalize the
  // raw stdout into the final answer (+ opportunistic session id) BEFORE the
  // engine's schema validation / retry loop sees it. Only successful agent
  // (CLI) runs are normalized — failures keep the raw stdout for diagnostics,
  // and the default path is byte-identical when no extractor is registered.
  let text = result.stdout;
  let sessionId = result.sessionId;
  if (resolved.kind === "agent" && result.ok) {
    const extractor = await resolveHarnessExtractor(resolved.profile);
    if (extractor) {
      const extraction = extractor(result);
      text = extraction.text;
      if (extraction.sessionId !== undefined) sessionId = extraction.sessionId;
    }
  }

  return {
    ok: result.ok,
    text,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(result.reason ? { failureReason: result.reason } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
  };
};

/**
 * Map a typed {@link import("../../llm/client").LlmCallErrorCode} into the
 * persisted `AgentFailureReason` taxonomy (agent/spawn.ts) — the ONLY
 * vocabulary `retry.on` accepts and the journal's `failure_reason` column
 * carries. Exhaustive over the code union (typecheck fails on drift):
 *
 *   - `timeout`        → `timeout`         (wall-clock expiry; also covers
 *                                           signal aborts, which chatCompletion
 *                                           folds into its timeout code)
 *   - `rate_limited`   → `llm_rate_limit`  (HTTP 429 — the canonical transient)
 *   - `parse_error` / `provider_html_error`
 *                      → `parse_error`     (a response arrived but was not the
 *                                           promised JSON)
 *   - `network_error` / `provider_error`
 *                      → `spawn_failed`    (the backend could not be reached or
 *                                           could not do the work — the LLM
 *                                           analog of failing to start the
 *                                           child; retryable as a transient)
 */
export function llmFailureReasonFor(
  code: import("../../llm/client").LlmCallErrorCode,
): import("../../integrations/agent/spawn").AgentFailureReason {
  switch (code) {
    case "timeout":
      return "timeout";
    case "rate_limited":
      return "llm_rate_limit";
    case "parse_error":
    case "provider_html_error":
      return "parse_error";
    case "network_error":
    case "provider_error":
      return "spawn_failed";
  }
}

/**
 * Resolve the harness `resultExtractor` for an agent profile, mirroring the
 * platform routing of `getCommandBuilder`: the profile's explicit
 * `commandBuilder` wins, else its name (with the `-headless` builtin-variant
 * suffix stripped, same derivation as BUILTIN_BUILDERS). Unknown/custom
 * platforms resolve to no extractor — raw stdout passes through unchanged.
 */
async function resolveHarnessExtractor(
  profile: import("../../integrations/agent/profiles").AgentProfile,
): Promise<import("../../integrations/agent/builder-shared").AgentResultExtractor | undefined> {
  const { getHarness } = await import("../../integrations/harnesses/index.js");
  const platform = profile.commandBuilder ?? profile.name;
  const harness = getHarness(platform) ?? getHarness(platform.replace(/-headless$/, ""));
  return harness?.resultExtractor;
}

type ResolvedUnitRunner =
  | { kind: "llm"; connection: import("../../core/config/config").LlmConnectionConfig }
  | { kind: "agent" | "sdk"; profile: import("../../integrations/agent/profiles").AgentProfile };

function resolveUnitRunner(
  request: UnitDispatchRequest,
  config: import("../../core/config/config").AkmConfig,
): ResolvedUnitRunner {
  const requested = request.runner;

  if (requested === "llm") {
    const connection = request.profile ? config.profiles?.llm?.[request.profile] : requireDefaultLlm(config, request);
    if (!connection) {
      throw new ConfigError(
        `Workflow unit "${request.unitId}" wants llm profile "${request.profile}", which is not in profiles.llm.`,
        "LLM_NOT_CONFIGURED",
      );
    }
    return { kind: "llm", connection };
  }

  const profileName = request.profile ?? config.defaults?.agent;
  if (profileName) {
    const { resolveProfileFromConfig } =
      require("../../integrations/agent/config") as typeof import("../../integrations/agent/config");
    const profile = resolveProfileFromConfig(profileName, config);
    if (!profile) {
      throw new ConfigError(
        `Workflow unit "${request.unitId}" wants agent profile "${profileName}", which cannot be resolved. ` +
          `Define profiles.agent."${profileName}" or set defaults.agent.`,
        "INVALID_CONFIG_FILE",
      );
    }
    const inferred = profile.sdkMode ? "sdk" : "agent";
    if (requested !== "inherit" && requested !== inferred) {
      throw new ConfigError(
        `Workflow unit "${request.unitId}" declares runner "${requested}" but profile "${profileName}" is ${
          profile.sdkMode ? "an opencode-sdk (sdk) profile" : "a CLI (agent) profile"
        }.`,
        "INVALID_CONFIG_FILE",
      );
    }
    return { kind: inferred, profile };
  }

  if (requested === "inherit") {
    const connection = requireDefaultLlm(config, request, /* soft */ true);
    if (connection) return { kind: "llm", connection };
  }
  throw new ConfigError(
    `Workflow unit "${request.unitId}" has no runnable backend: set defaults.agent or defaults.llm in config.json, ` +
      `or declare a runner/profile on the unit.`,
    "INVALID_CONFIG_FILE",
  );
}

function requireDefaultLlm(
  config: import("../../core/config/config").AkmConfig,
  request: UnitDispatchRequest,
  soft = false,
): import("../../core/config/config").LlmConnectionConfig | undefined {
  const { getDefaultLlmConfig } = require("../../core/config/config") as typeof import("../../core/config/config");
  const connection = getDefaultLlmConfig(config);
  if (!connection && !soft) {
    throw new ConfigError(
      `Workflow unit "${request.unitId}" declares runner "llm" but no default LLM is configured (defaults.llm).`,
      "LLM_NOT_CONFIGURED",
    );
  }
  return connection ?? undefined;
}

// ── Small helpers ────────────────────────────────────────────────────────────

/** Rehydrate a journaled completed unit row into a UnitOutcome (durable-row reuse). */
function reuseCompletedUnit(unitId: string, row: WorkflowRunUnitRow, hasSchema: boolean): UnitOutcome {
  let parsed: unknown;
  try {
    parsed = row.result_json === null ? undefined : JSON.parse(row.result_json);
  } catch {
    parsed = undefined;
  }
  return {
    unitId,
    ok: true,
    // Text units journal their output as a JSON string; schema units journal
    // the validated structure.
    ...(hasSchema
      ? { result: parsed }
      : typeof parsed === "string"
        ? { text: parsed }
        : parsed !== undefined
          ? { result: parsed }
          : {}),
    ...(row.tokens !== null ? { tokens: row.tokens } : {}),
    // Rehydrate the journaled harness session id so resume-with-native-context
    // consumers see it on reuse exactly as on a fresh dispatch.
    ...(row.session_id !== null && row.session_id !== undefined ? { sessionId: row.session_id } : {}),
  };
}

function failedStep(dispatched: number, reason: string): StepExecutionResult {
  return {
    ok: false,
    units: [],
    evidence: { error: reason },
    summary: reason,
    unitsDispatched: dispatched,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
