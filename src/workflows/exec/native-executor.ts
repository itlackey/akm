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
 * says cannot exist.
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
 * Layering (see the plan's *Reconciliation* section):
 *   - Dispatch goes through ONE injected {@link UnitDispatcher} seam. The
 *     default dispatcher composes the EXISTING substrate — `executeRunner`
 *     (agent/sdk) and `chatCompletion` (llm, lazily imported so the engine
 *     stays offline-capable until a workflow actually declares an llm unit).
 *   - This module NEVER writes step rows: advancing the gated spine is the
 *     engine loop's job (`run-workflow.ts`) via `completeWorkflowStep`.
 */

import { createHash } from "node:crypto";
import unitPreambleTemplate from "../../assets/prompts/workflow-unit-preamble.md" with { type: "text" };
import { ConfigError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { validateJsonSchemaSubset } from "../../core/json-schema";
import { runStructured } from "../../core/structured";
import type { AgentTokenUsage } from "../../integrations/agent/spawn";
import { type WorkflowRunUnitRow, withWorkflowRunsRepo } from "../../storage/repositories/workflow-runs-repository";
import type { IrAgentNode, IrStepPlan } from "../ir/schema";
import {
  type ExpressionScope,
  parseTemplate,
  resolveTemplate,
  resolveWholeValue,
  type TemplateSegment,
} from "../program/expressions";
import { LIFETIME_UNIT_CAP, scheduleUnits, UnitCapExceededError } from "./scheduler";
import { enqueueUnitWrite } from "./unit-writer";

/**
 * Default per-unit timeout. Deliberately NOT the 60 s agent default
 * (`DEFAULT_AGENT_TIMEOUT_MS`) — workflow units routinely run real coding
 * tasks on slow local models; 10 minutes matches the LLM-path default
 * (`tryLlmFeature`). A unit's `timeout` declaration overrides this; `none`
 * disables.
 */
export const DEFAULT_UNIT_TIMEOUT_MS = 600_000;

/** How much raw unit output is retained in step evidence (full text lives on the unit row). */
const EVIDENCE_TEXT_CLIP = 2_000;

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

export interface UnitOutcome {
  unitId: string;
  ok: boolean;
  /** Parsed value for schema units; raw (clipped) text otherwise. */
  result?: unknown;
  text?: string;
  failureReason?: string;
  error?: string;
  tokens?: number;
  /**
   * Harness-native session id revealed during dispatch (last one wins across
   * structured-output retries). Persisted on the unit row by `finishUnit`.
   */
  sessionId?: string;
}

/**
 * Corrective feedback from a rejected completion gate, threaded into the next
 * gate-loop execution of the step subgraph (`gate.max_loops`, addendum R2).
 * Appended to every unit prompt, so the input hash changes and the loop's
 * units re-dispatch naturally instead of reusing the rejected attempt's rows.
 */
export interface GateFeedback {
  feedback: string;
  missing: string[];
}

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
  /** Test seam for the engine concurrency cap. */
  maxConcurrency?: number;
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
}

/**
 * Mutable per-step dispatch budget for the lifetime unit cap. Consumed once
 * per journaled dispatch attempt (including retries); durable-row reuses
 * never touch it — the peer-review fix that keeps large partially-completed
 * fan-outs resumable instead of tripping the cap on `journaled + items`.
 * Check-and-increment is synchronous, so concurrent units cannot race it.
 */
class DispatchBudget {
  used: number;
  /** Set (once) when a dispatch was refused; the step fails with this message. */
  capMessage: string | undefined;

  constructor(alreadyDispatched: number) {
    this.used = alreadyDispatched;
  }

  /** Consume one dispatch slot; false (and a sticky capMessage) when the cap is hit. */
  tryConsume(): boolean {
    if (this.used >= LIFETIME_UNIT_CAP) {
      this.capMessage ??= new UnitCapExceededError(LIFETIME_UNIT_CAP).message;
      return false;
    }
    this.used++;
    return true;
  }
}

/** Execute one step plan natively. Never throws for unit-level failures. */
export async function executeStepPlan(plan: IrStepPlan, ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const dispatched = ctx.unitsDispatched ?? 0;
  const root = plan.root;

  // Route-only steps (YAML `route:`) carry no execution subgraph — the engine
  // loop (`run-workflow.ts`) evaluates them without calling this function.
  // Reaching here without a root is an error, never a silent no-op.
  if (!root) {
    return failedStep(
      dispatched,
      `Step "${plan.stepId}" has no execution subgraph (a route-only step); the native executor cannot dispatch it.`,
    );
  }

  const template = root.kind === "map" ? root.template : root;
  const reducer = root.kind === "map" ? root.reducer : "collect";

  // The deterministic expression scope for this step: run params plus prior
  // steps' promoted artifacts (projectStepOutput over their journaled evidence).
  const scope: ExpressionScope = { params: ctx.params, stepOutputs: stepOutputsFromEvidence(ctx.evidence) };

  // Parse the instruction template ONCE per step (deterministic; resolution
  // is a single pass per unit — substituted content is never re-scanned).
  // Only nodes the frontend marked `templating: "expressions"` (YAML program
  // units) carry the `${{ … }}` grammar; everything else — classic linear
  // markdown steps, whose behavior is a stable contract — is opaque verbatim
  // text, so a literal `${{` in markdown instructions passes through to the
  // agent unchanged instead of failing the step.
  let instructionSegments: TemplateSegment[];
  if (template.templating === "expressions") {
    const parsedInstructions = parseTemplate(template.instructions);
    if (!parsedInstructions.ok) {
      return failedStep(
        dispatched,
        `Step "${plan.stepId}" instructions template failed to parse: ` +
          parsedInstructions.errors.map((e) => e.message).join(" "),
      );
    }
    instructionSegments = parsedInstructions.segments;
  } else {
    instructionSegments = [{ kind: "literal", text: template.instructions }];
  }

  // Resolve fan-out items: `over` is a single whole-value `${{ … }}`
  // reference naming its producer explicitly (a run param or an earlier
  // step's output) — no ambient key search.
  let items: unknown[];
  if (root.kind === "map") {
    const source = resolveWholeValue(root.over, scope);
    if (!source.ok) {
      return failedStep(
        dispatched,
        `Step "${plan.stepId}" fan-out "over" (${root.over}) failed to resolve: ${source.error.message}`,
      );
    }
    if (!Array.isArray(source.value)) {
      return failedStep(
        dispatched,
        `Step "${plan.stepId}" fan-out "over" (${root.over}) resolved to ${typeof source.value}, not an array.`,
      );
    }
    items = source.value;
  } else {
    items = [undefined];
  }

  // Content-derived unit identity (module doc): compute every unit id up
  // front from the resolved items. Duplicate items collide on identity — an
  // authoring error caught HERE, deterministically, before any dispatch.
  const isFanOut = root.kind === "map";
  const unitIds = items.map((item) => unitIdFor(template.id, item, isFanOut));
  if (isFanOut) {
    const firstIndexByCanonical = new Map<string, number>();
    for (let i = 0; i < items.length; i++) {
      const canonical = canonicalJson(items[i]) ?? "null";
      const firstIndex = firstIndexByCanonical.get(canonical);
      if (firstIndex !== undefined) {
        return failedStep(
          dispatched,
          `Step "${plan.stepId}" fan-out list contains duplicate items (indices ${firstIndex} and ${i}: ` +
            `${clip(canonical, 200)}). Content-derived unit identity requires distinct items — ` +
            `deduplicate the list this workflow fans out over.`,
        );
      }
      firstIndexByCanonical.set(canonical, i);
    }
  }

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

  const dispatcher = ctx.dispatcher ?? defaultUnitDispatcher;

  // Durable-row resume: a unit whose previous attempt completed with the
  // SAME input (prompt/runner/model/schema hash) is reused, not re-dispatched
  // — a crash-resume must never double-issue side-effecting work.
  const existingUnits = new Map<string, WorkflowRunUnitRow>();
  for (const row of await withWorkflowRunsRepo((repo) => repo.getUnitsForStep(ctx.runId, plan.stepId))) {
    existingUnits.set(row.unit_id, row);
  }

  // Lifetime-cap budget: seeded with the run's journaled dispatch count and
  // consumed per ACTUAL dispatch inside runUnit — never for durable-row
  // reuses, so resuming a large partially-completed fan-out works.
  const budget = new DispatchBudget(dispatched);

  const outcomes: Array<UnitOutcome | undefined> = await scheduleUnits(
    items,
    (item, index) =>
      runUnit({
        plan,
        template,
        instructionSegments,
        scope,
        item,
        index,
        unitId: unitIds[index],
        isFanOut,
        env,
        ctx,
        dispatcher,
        existingUnits,
        budget,
      }),
    {
      concurrency: root.kind === "map" ? root.concurrency : 1,
      signal: ctx.signal,
      maxConcurrency: ctx.maxConcurrency,
    },
  );

  // The cap is a hard backstop: a step that hit it FAILS regardless of
  // on_error policy (a capped run must never quietly pass its gate).
  if (budget.capMessage) {
    return failedStep(budget.used, budget.capMessage);
  }

  const units = outcomes.map(
    (outcome, index) =>
      outcome ?? {
        unitId: unitIds[index],
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
  const evidence = buildEvidence(units, reducer, root.kind === "map");
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
  // schema-violating artifact reach downstream references or the gate.
  if (ok) {
    const schemaFailure = validateStepArtifact(plan, evidence);
    if (schemaFailure !== undefined) {
      ok = false;
      summary = schemaFailure;
    }
  }

  return { ok, units, evidence, summary, unitsDispatched: budget.used };
}

// ── One unit ─────────────────────────────────────────────────────────────────

interface RunUnitInput {
  plan: IrStepPlan;
  template: IrAgentNode;
  /** Instruction template segments, parsed ONCE per step by executeStepPlan. */
  instructionSegments: TemplateSegment[];
  /** Step-wide expression scope (params + prior step outputs); item scoping is per unit. */
  scope: ExpressionScope;
  item: unknown;
  index: number;
  /** Content-derived unit id (`<node_id>:<hash12>` / `<node_id>:solo`), computed by executeStepPlan. */
  unitId: string;
  isFanOut: boolean;
  env?: Record<string, string>;
  ctx: StepExecutionContext;
  dispatcher: UnitDispatcher;
  /** Prior unit rows for this step, for durable-row reuse. */
  existingUnits?: Map<string, WorkflowRunUnitRow>;
  /** Shared lifetime-cap budget; consumed once per actual dispatch attempt. */
  budget: DispatchBudget;
}

async function runUnit(input: RunUnitInput): Promise<UnitOutcome> {
  const { plan, template, item, index, unitId, isFanOut, env, ctx, dispatcher } = input;

  // Single-pass resolution of the pre-parsed template against this unit's
  // scope. A resolution failure (missing param, bad path) is deterministic
  // authoring/data breakage: the unit fails WITHOUT dispatching — and without
  // journaling a row, since no resolved input exists to hash.
  const unitScope: ExpressionScope = isFanOut ? { ...input.scope, item, itemIndex: index } : input.scope;
  const resolved = resolveTemplate(input.instructionSegments, unitScope);
  if (!resolved.ok) {
    return {
      unitId,
      ok: false,
      failureReason: "expression_error",
      error: `instructions failed to resolve: ${resolved.errors.map((e) => e.message).join(" ")}`,
    };
  }

  // The prompt (and therefore the input hash) is built once with the BASE
  // unit id: a retry re-dispatches the SAME input, the `~r<n>` suffix is
  // journal bookkeeping only.
  const prompt = buildUnitPrompt({ plan, template, ctx, unitId, instructions: resolved.text });
  const timeoutMs = template.timeoutMs === undefined ? DEFAULT_UNIT_TIMEOUT_MS : template.timeoutMs;

  const request: UnitDispatchRequest = {
    runId: ctx.runId,
    stepId: plan.stepId,
    unitId,
    nodeId: template.id,
    prompt,
    runner: template.runner,
    ...(template.profile ? { profile: template.profile } : {}),
    ...(template.model ? { model: template.model } : {}),
    timeoutMs,
    ...(template.schema ? { schema: template.schema } : {}),
    ...(env ? { env } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };

  const inputHash = createHash("sha256")
    .update(
      JSON.stringify({
        prompt,
        runner: template.runner,
        model: template.model ?? null,
        schema: template.schema ?? null,
      }),
    )
    .digest("hex");

  // Bounded retry (IR v2 failure policy): attempt 0 journals under the base
  // unit id, retry attempt N under `<unitId>~r<N>` — every attempt keeps its
  // own row, nothing is clobbered. Retries only fire when the failure reason
  // is in `retry.on`.
  const retry = template.retry;
  const maxAttempts = 1 + Math.max(0, retry?.max ?? 0);
  // Gate loops (module doc): attempts of loop >= 2 journal under
  // `<unitId>~l<loop>` so loop 1's rows are never clobbered; `~r<n>` retry
  // suffixes stack on top. Both suffixes are journal bookkeeping — the
  // content-derived identity (and the prompt's {{UNIT_ID}}) stays the base id.
  const gateLoop = ctx.gateLoop ?? 1;
  const journalBaseId = gateLoop > 1 ? `${unitId}~l${gateLoop}` : unitId;
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
      return reuseCompletedUnit(attemptId, prior, template.schema !== undefined);
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
    // Lifetime cap, consumed per ACTUAL dispatch (reuses above returned before
    // reaching here). Refusal fails this unit without journaling a row —
    // nothing was dispatched — and the sticky capMessage fails the step.
    if (!input.budget.tryConsume()) {
      return (
        outcome ?? {
          unitId,
          ok: false,
          failureReason: "unit_cap_exceeded",
          error: input.budget.capMessage ?? "lifetime unit cap exceeded",
        }
      );
    }
    outcome = await dispatchJournaledAttempt({
      plan,
      template,
      ctx,
      dispatcher,
      request: { ...request, unitId: attemptId },
      attemptId,
      isFanOut,
      inputHash,
    });
    if (outcome.ok) return outcome;
    const reason = outcome.failureReason;
    if (!retry || reason === undefined || !retry.on.includes(reason)) return outcome;
  }
  // maxAttempts >= 1, so outcome is always set by the loop above.
  return outcome as UnitOutcome;
}

interface JournaledAttemptInput {
  plan: IrStepPlan;
  template: IrAgentNode;
  ctx: StepExecutionContext;
  dispatcher: UnitDispatcher;
  request: UnitDispatchRequest;
  /** Journal id of this attempt: `<unitId>` or `<unitId>~r<n>` for retries. */
  attemptId: string;
  isFanOut: boolean;
  inputHash: string;
}

/** Journal one dispatch attempt: insert row, events, dispatch, finish row. */
async function dispatchJournaledAttempt(input: JournaledAttemptInput): Promise<UnitOutcome> {
  const { plan, template, ctx, dispatcher, request, attemptId, isFanOut, inputHash } = input;

  await enqueueUnitWrite(async () => {
    await withWorkflowRunsRepo((repo) =>
      repo.insertUnit({
        runId: ctx.runId,
        unitId: attemptId,
        stepId: plan.stepId,
        nodeId: template.id,
        parentUnitId: isFanOut ? `${plan.stepId}.map` : null,
        phase: null,
        runner: template.runner,
        model: template.model ?? null,
        inputHash,
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

  const outcome = await dispatchUnit(request, template, dispatcher);

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

  return outcome;
}

/** Transport failures surface as this sentinel so runStructured doesn't retry them. */
class UnitTransportError extends Error {
  constructor(readonly result: UnitDispatchResult) {
    super(result.error ?? "unit dispatch failed");
    this.name = "UnitTransportError";
  }
}

async function dispatchUnit(
  request: UnitDispatchRequest,
  template: IrAgentNode,
  dispatcher: UnitDispatcher,
): Promise<UnitOutcome> {
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
    if (template.schema) {
      const schema = template.schema;
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

// ── Prompt assembly ──────────────────────────────────────────────────────────

interface BuildPromptInput {
  plan: IrStepPlan;
  template: IrAgentNode;
  ctx: StepExecutionContext;
  unitId: string;
  /** Instructions with every `${{ … }}` reference already resolved (single pass). */
  instructions: string;
}

/**
 * Assemble the final prompt: engine preamble + resolved instructions
 * (+ gate feedback on loop re-executions, + schema directive). Workflow-
 * authored interpolation happened upstream via the expression module; only
 * the ENGINE's own preamble placeholders are substituted here.
 */
function buildUnitPrompt(input: BuildPromptInput): string {
  const { plan, template, ctx, unitId, instructions } = input;
  // Function replacements throughout: a string replacement would interpret
  // GetSubstitution patterns ($&, $$, $', $`) inside VALUES and silently
  // corrupt the prompt (e.g. a param value containing "$&").
  const preamble = unitPreambleTemplate
    .replaceAll("{{RUN_ID}}", () => ctx.runId)
    .replaceAll("{{STEP_ID}}", () => plan.stepId)
    .replaceAll("{{UNIT_ID}}", () => unitId)
    .replaceAll("{{PARAMS_JSON}}", () => safeJson(ctx.params));

  // Gate-loop feedback (R2 max_loops): the judge's rejection is appended so
  // the re-executed unit can address it — and so the input hash changes,
  // making the loop's re-dispatch natural instead of a durable-row reuse.
  const gateBlock = ctx.gateFeedback
    ? `\n\n## Completion-gate feedback (previous attempt rejected)\n` +
      `A completion-criteria judge rejected this step's previous results. Address this feedback:\n` +
      ctx.gateFeedback.feedback +
      (ctx.gateFeedback.missing.length > 0
        ? `\nUnmet criteria:\n${ctx.gateFeedback.missing.map((m) => `- ${m}`).join("\n")}`
        : "")
    : "";

  const schemaDirective = template.schema
    ? `\n\nRespond with ONLY a JSON value matching this JSON Schema (no prose, no code fences):\n${safeJson(template.schema)}`
    : "";

  return `${preamble}\n${instructions}${gateBlock}${schemaDirective}`;
}

// ── Step outputs + reducers ──────────────────────────────────────────────────

/**
 * The value `${{ steps.<id>.output }}` resolves to for ONE step, given that
 * step's journaled evidence:
 *
 *   - engine-executed steps carry a promoted ARTIFACT under `evidence.output`
 *     (written by {@link buildEvidence}: solo unit result/text, collect
 *     array, or vote winner) — that artifact IS the step output, exactly the
 *     addressing the docs teach (`steps.discover.output.files`);
 *   - evidence without an `output` key (manually-completed steps, pre-R1
 *     rows) is exposed as-is — whatever the author recorded is the output.
 *
 * Typed artifacts (R2): when the step declares an output schema, the artifact
 * this projection exposes has already been validated against it — a
 * schema-violating artifact fails the step before completion
 * ({@link validateStepArtifact}), so it never reaches a reference.
 */
export function projectStepOutput(evidence: Record<string, unknown>): unknown {
  return Object.hasOwn(evidence, "output") ? evidence.output : evidence;
}

/**
 * Typed artifacts (addendum, R2): validate the promoted step artifact against
 * `IrStepPlan.outputSchema`. Returns the step-failure summary (validation
 * errors included) on mismatch, undefined when valid or when no schema is
 * declared. Runs BEFORE completion so a schema-violating artifact never
 * reaches the gate or downstream `${{ steps.<id>.output }}` references.
 */
function validateStepArtifact(plan: IrStepPlan, evidence: Record<string, unknown>): string | undefined {
  if (!plan.outputSchema) return undefined;
  const errors = validateJsonSchemaSubset(projectStepOutput(evidence), plan.outputSchema);
  if (errors.length === 0) return undefined;
  return (
    `Step "${plan.stepId}" artifact failed validation against the step's declared output schema: ` +
    `${errors.join("; ")}.`
  );
}

/** How much artifact JSON the completion-criteria judge receives (addendum R2, artifact-judging gates). */
const GATE_ARTIFACT_CLIP = 4_000;

/**
 * Build the summary the completion-criteria gate judges for an ENGINE-driven
 * step (addendum R2, "typed artifacts, honest gates"): a one-line unit count
 * followed by the promoted step artifact as canonical JSON, clipped at
 * {@link GATE_ARTIFACT_CLIP} chars. This replaces the machine-prose
 * "Executed N unit(s)…" summary as the judged content, so the gate evaluates
 * real results instead of engine bookkeeping.
 */
export function buildArtifactSummary(stepId: string, units: UnitOutcome[], evidence: Record<string, unknown>): string {
  const failedCount = units.filter((u) => !u.ok).length;
  const json = canonicalJson(projectStepOutput(evidence)) ?? "null";
  return (
    `Step "${stepId}" executed ${units.length} unit(s) (${units.length - failedCount} succeeded, ${failedCount} failed). ` +
    `Step artifact (canonical JSON${json.length > GATE_ARTIFACT_CLIP ? `, clipped at ${GATE_ARTIFACT_CLIP} chars` : ""}):\n` +
    clip(json, GATE_ARTIFACT_CLIP)
  );
}

/** Project the engine's evidence map into the expression scope's `stepOutputs`. */
function stepOutputsFromEvidence(evidence: StepExecutionContext["evidence"]): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  for (const [stepId, stepEvidence] of Object.entries(evidence)) {
    if (stepEvidence !== undefined) outputs[stepId] = projectStepOutput(stepEvidence);
  }
  return outputs;
}

/** A unit's contribution to the step artifact: structured result, else text, else null (failures). */
function unitOutputValue(unit: UnitOutcome): unknown {
  if (!unit.ok) return null;
  if (unit.result !== undefined) return unit.result;
  return unit.text ?? null;
}

function buildEvidence(
  units: UnitOutcome[],
  reducer: "collect" | "vote" | "best-of-n",
  isFanOut: boolean,
): Record<string, unknown> {
  const collected = units.map((u) => ({
    unitId: u.unitId,
    ok: u.ok,
    ...(u.result !== undefined ? { result: u.result } : {}),
    ...(u.text !== undefined ? { text: clip(u.text, EVIDENCE_TEXT_CLIP) } : {}),
    ...(u.failureReason ? { failureReason: u.failureReason } : {}),
    ...(u.error ? { error: clip(u.error, 500) } : {}),
  }));
  const evidence: Record<string, unknown> = { units: collected, itemCount: units.length };

  // Promoted step artifact (`evidence.output`) — what `${{ steps.<id>.output }}`
  // resolves to (see projectStepOutput). Values are UNCLIPPED (the clipped
  // copies above are diagnostics; downstream data flow must be lossless):
  //   solo unit      → its structured result or text;
  //   map + collect  → per-item values in item order (a failed unit under
  //                    on_error: continue contributes null — positions stay
  //                    aligned, and referencing the failed slot errs loudly);
  //   map + vote     → the winner (set below; a vote with no winner fails the
  //                    step, so its null artifact is never consumed).
  if (reducer === "vote") {
    evidence.output = null;
  } else {
    evidence.output = isFanOut ? units.map(unitOutputValue) : unitOutputValue(units[0]);
  }

  if (reducer === "vote") {
    const counts = new Map<string, { value: unknown; count: number }>();
    for (const unit of units) {
      if (!unit.ok) continue;
      const value = unit.result !== undefined ? unit.result : unit.text;
      const key = canonicalJson(value);
      const entry = counts.get(key);
      if (entry) entry.count++;
      else counts.set(key, { value, count: 1 });
    }
    const ranked = [...counts.values()].sort((a, b) => b.count - a.count);
    if (ranked.length === 0) {
      evidence.voteError = "Vote reducer had no successful unit results to count.";
    } else if (ranked.length > 1 && ranked[0].count === ranked[1].count) {
      evidence.voteError = `Vote reducer tied at ${ranked[0].count} vote(s) — no majority.`;
    } else {
      evidence.vote = { winner: ranked[0].value, votes: ranked[0].count, total: units.length };
      evidence.output = ranked[0].value;
    }
  }

  return evidence;
}

/** Stable stringify (sorted object keys, recursively) so equal values vote together. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
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

  // `env` bindings can only reach a spawned child process. The opencode
  // SDK server is process-wide (no per-call env — plan open decision 1) and
  // the llm runner has no child at all. Failing loudly beats an audit event
  // that claims an injection which never reached the unit.
  if (request.env && Object.keys(request.env).length > 0 && resolved.kind !== "agent") {
    return {
      ok: false,
      text: "",
      failureReason: "env_unsupported",
      error:
        `unit "${request.unitId}" declares env bindings, which currently require the agent (CLI) runner — ` +
        `the "${resolved.kind}" runner cannot inject a per-unit child environment.`,
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

/**
 * Content-derived unit identity (module doc): `<node_id>:<hash12>` for a
 * fan-out item, `<node_id>:solo` otherwise. The hash is over the item's
 * canonical JSON (sorted keys — same canonicalization the vote reducer
 * counts with), so identity survives list reordering/regeneration and is
 * independent of item position. Retry attempts stack `~r<n>` on top.
 */
function unitIdFor(nodeId: string, item: unknown, isFanOut: boolean): string {
  if (!isFanOut) return `${nodeId}:solo`;
  const canonical = canonicalJson(item) ?? "null";
  return `${nodeId}:${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`;
}

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

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "null";
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
