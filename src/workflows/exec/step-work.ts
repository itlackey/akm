// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared step semantics — the ONE implementation of a step's orchestration
 * decisions, consumed by BOTH the engine loop (`run-workflow.ts` +
 * `native-executor.ts`) and, from R3 on, the harness-neutral driver protocol
 * (`workflow brief` / `workflow report`). The cardinal rule of the driver
 * protocol (redesign addendum R3) is *no duplicated semantics*: work-list
 * computation, prompt assembly, reducer/artifact promotion, output-schema
 * validation, artifact-judged gate summaries, gate-feedback recovery, and
 * route evaluation live here so an engine-driven run and a brief/report-driven
 * run of the same frozen plan produce byte-identical unit graphs.
 *
 * ## What is PURE here
 *
 * {@link computeStepWorkList} — given the frozen step plan and a
 * {@link WorkListInput} (params, prior step outputs, gate-loop number + its
 * recovered feedback) — is a pure function: same inputs ⇒ same unit ids, input
 * hashes, and fully-resolved prompts. It takes NO clock, NO IO, and NO journal
 * (journal-derived state, i.e. the recovered gate feedback, is passed in). This
 * is the load-bearing guarantee that `brief` can predict exactly the units the
 * engine would dispatch. So are the reducer/artifact helpers
 * ({@link buildEvidence}, {@link projectStepOutput}, {@link validateStepArtifact},
 * {@link buildArtifactSummary}), the gate-feedback recovery
 * ({@link recoverGateFeedback} / {@link activeGateLoop}), and route evaluation
 * ({@link evaluateRoute} and its bookkeeping).
 *
 * ## What does IO here
 *
 * The gate-evaluation journaling ({@link journalGateEvaluationStart} /
 * {@link journalGateEvaluationFinish}) writes `workflow_run_units` rows through
 * the serialized writer queue — an engine-driven judge call is an LLM call and
 * is journaled like a unit. It lives here (not in the engine loop) so the
 * report path journals gate evaluations through the identical writer.
 *
 * This module NEVER dispatches a unit and NEVER writes step rows: dispatch is
 * the executor's job (`native-executor.ts`), advancing the gated spine is the
 * engine loop's job (`run-workflow.ts` via `completeWorkflowStep`).
 */

import { createHash } from "node:crypto";
import unitPreambleTemplate from "../../assets/prompts/workflow-unit-preamble.md" with { type: "text" };
import { UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { validateJsonSchemaSubset } from "../../core/json-schema";
import { type WorkflowRunUnitRow, withWorkflowRunsRepo } from "../../storage/repositories/workflow-runs-repository";
import { canonicalJson as canonicalJsonString, decodeCanonicalPlan } from "../ir/plan-hash";
import type {
  FrozenEngineSnapshot,
  IrInvocation,
  IrIsolation,
  IrMapReducer,
  IrOnError,
  IrRetry,
  IrRouteSpec,
  IrRuntimeKind,
  IrStepPlan,
  IrUnitNode,
  WorkflowPlanGraph,
} from "../ir/schema";
import {
  type ExpressionScope,
  parseTemplate,
  resolveTemplate,
  resolveWholeValue,
  type TemplateSegment,
} from "../program/expressions";
import { WORKFLOW_MAX_MAP_EXPANSION } from "../resource-limits";
import { requireExecutableWorkflowPlan } from "../runtime/plan-classifier";
import { completeWorkflowStep, type SummaryValidationFailure, type WorkflowNextResult } from "../runtime/runs";
import type { SummaryJudge } from "../validate-summary";
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

/** How much artifact JSON the completion-criteria judge receives (addendum R2, artifact-judging gates). */
const GATE_ARTIFACT_CLIP = 4_000;

// ── Unit outcomes + gate feedback (shared vocabulary) ────────────────────────

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

// ── Work-list computation (PURE) ─────────────────────────────────────────────

/** Everything `computeStepWorkList` needs — all pure inputs, no clock, no IO. */
export interface WorkListInput {
  runId: string;
  params: Record<string, unknown>;
  /** Prior steps' promoted artifacts, keyed by step id (`stepOutputsFromEvidence`). */
  stepOutputs: Record<string, unknown>;
  /** Frozen catalog for v3 dispatch. */
  engines: Record<string, FrozenEngineSnapshot>;
  /**
   * Gate-loop attempt, 1-based (absent = 1). Attempts >= 2 journal their units
   * under `<unitId>~l<loop>` and thread {@link gateFeedback} into every prompt.
   */
  gateLoop?: number;
  /** Judge feedback recovered from the previous (rejected) gate loop's journal row. */
  gateFeedback?: GateFeedback;
}

/**
 * One unit's fully-resolved dispatch plan. `unitId`/`nodeId`/`item` are always
 * present (content-derived, independent of resolution); `resolved` carries the
 * assembled prompt + input hash, or a deterministic resolution error (a bad
 * `item.<path>` reference) that fails just this unit without dispatching.
 */
export interface StepWorkUnit {
  /** Content-derived base id: `<node_id>:<hash12>` (fan-out) / `<node_id>:solo`. */
  unitId: string;
  nodeId: string;
  index: number;
  /** The fan-out item (undefined for a solo unit). */
  item: unknown;
  isFanOut: boolean;
  /** Journal id root for attempt 0 (`<unitId>` or `<unitId>~l<loop>` in a gate loop). */
  journalBaseId: string;
  runner: IrRuntimeKind;
  /** Frozen catalog entry used at dispatch. */
  engine?: FrozenEngineSnapshot;
  fallbackEngine?: Extract<FrozenEngineSnapshot, { kind: "llm" }>;
  invocation?: IrInvocation;
  model?: string;
  /** Resolved timeout (unit override else engine default); null = no timeout. */
  timeoutMs: number | null;
  schema?: Record<string, unknown>;
  /** Env binding asset refs (NAMES only — never resolved values). */
  env?: string[];
  retry?: IrRetry;
  onError: IrOnError;
  isolation?: IrIsolation;
  resolved: { ok: true; prompt: string; inputHash: string } | { ok: false; error: string };
}

export interface StepWorkList {
  template: IrUnitNode;
  reducer: IrMapReducer;
  isFanOut: boolean;
  /** Per-step concurrency (map `concurrency`; 1 for a solo step). */
  concurrency?: number;
  /** Resolved fan-out items (a single `[undefined]` for a solo step). */
  items: unknown[];
  units: StepWorkUnit[];
}

/** A whole-list failure (no root, parse/resolve error, duplicate items). */
export type ComputeWorkListResult = { ok: true; list: StepWorkList } | { ok: false; error: string };

/**
 * Compute a step's expected work-list PURELY from the frozen plan and its
 * inputs: resolve the fan-out list, derive content-derived unit ids, assemble
 * each unit's prompt (preamble + interpolated instructions + gate feedback +
 * schema directive), and hash the resolved input. Same inputs ⇒ byte-identical
 * ids/hashes/prompts — the invariant `brief` relies on to predict the engine.
 *
 * Whole-list failures (missing subgraph, template parse error, unresolvable /
 * non-array `over`, duplicate fan-out items) return `{ ok: false }`; a per-unit
 * expression-resolution failure is carried on that unit's `resolved` field so
 * the caller fails just that unit (mirroring the engine's `expression_error`
 * outcome), never the whole step.
 */
export function computeStepWorkList(plan: IrStepPlan, input: WorkListInput): ComputeWorkListResult {
  const root = plan.root;
  // Route-only steps (YAML `route:`) carry no execution subgraph.
  if (!root) {
    return {
      ok: false,
      error: `Step "${plan.stepId}" has no execution subgraph (a route-only step); the native executor cannot dispatch it.`,
    };
  }

  const template = root.kind === "map" ? root.template : root;
  const reducer: IrMapReducer = root.kind === "map" ? root.reducer : "collect";

  const scope: ExpressionScope = { params: input.params, stepOutputs: input.stepOutputs };

  // Parse the instruction template ONCE (deterministic; resolution is a single
  // pass per unit — substituted content is never re-scanned). Only nodes the
  // frontend marked `templating: "expressions"` carry the `${{ … }}` grammar;
  // classic linear markdown is opaque verbatim text.
  let instructionSegments: TemplateSegment[];
  if (template.templating === "expressions") {
    const parsedInstructions = parseTemplate(template.instructions);
    if (!parsedInstructions.ok) {
      return {
        ok: false,
        error:
          `Step "${plan.stepId}" instructions template failed to parse: ` +
          parsedInstructions.errors.map((e) => e.message).join(" "),
      };
    }
    instructionSegments = parsedInstructions.segments;
  } else {
    instructionSegments = [{ kind: "literal", text: template.instructions }];
  }

  // Resolve fan-out items: `over` is a single whole-value `${{ … }}` reference
  // naming its producer explicitly — no ambient key search.
  let items: unknown[];
  if (root.kind === "map") {
    const source = resolveWholeValue(root.over, scope);
    if (!source.ok) {
      return {
        ok: false,
        error: `Step "${plan.stepId}" fan-out "over" (${root.over}) failed to resolve: ${source.error.message}`,
      };
    }
    if (!Array.isArray(source.value)) {
      return {
        ok: false,
        error: `Step "${plan.stepId}" fan-out "over" (${root.over}) resolved to ${typeof source.value}, not an array.`,
      };
    }
    items = source.value;
  } else {
    items = [undefined];
  }

  const isFanOut = root.kind === "map";
  if (isFanOut && items.length > WORKFLOW_MAX_MAP_EXPANSION) {
    return {
      ok: false,
      error: `Step "${plan.stepId}" fan-out expands to ${items.length} units, exceeding the ${WORKFLOW_MAX_MAP_EXPANSION}-unit resource limit.`,
    };
  }

  // Content-derived unit identity: compute every id up front. Duplicate items
  // collide on identity — an authoring error caught HERE, deterministically.
  const unitIds = items.map((item) => unitIdFor(template.id, item, isFanOut));
  if (isFanOut) {
    const firstIndexByCanonical = new Map<string, number>();
    for (let i = 0; i < items.length; i++) {
      const canonical = canonicalJson(items[i]) ?? "null";
      const firstIndex = firstIndexByCanonical.get(canonical);
      if (firstIndex !== undefined) {
        return {
          ok: false,
          error:
            `Step "${plan.stepId}" fan-out list contains duplicate items (indices ${firstIndex} and ${i}: ` +
            `${clip(canonical, 200)}). Content-derived unit identity requires distinct items — ` +
            `deduplicate the list this workflow fans out over.`,
        };
      }
      firstIndexByCanonical.set(canonical, i);
    }
  }

  const gateLoop = input.gateLoop ?? 1;
  const frozenInvocation = template.invocation;
  if (!frozenInvocation) return { ok: false, error: `Step "${plan.stepId}" has no frozen invocation.` };
  const frozenEngine = input.engines?.[frozenInvocation.engine];
  if (!frozenEngine) {
    return { ok: false, error: `Step "${plan.stepId}" references missing frozen engine "${frozenInvocation.engine}".` };
  }
  const runner: IrRuntimeKind = frozenEngine.kind === "llm" ? "llm" : frozenEngine.runnerKind;
  const timeoutMs = frozenInvocation.timeoutMs;

  const units: StepWorkUnit[] = items.map((item, index) => {
    const unitId = unitIds[index];
    // Gate loops (>= 2) journal under `<unitId>~l<loop>` so loop 1's rows are
    // never clobbered; the content-derived identity (and the prompt's
    // {{UNIT_ID}}) stays the base id.
    const journalBaseId = gateLoop > 1 ? `${unitId}~l${gateLoop}` : unitId;

    // Single-pass resolution of the pre-parsed template against this unit's
    // scope. A resolution failure is deterministic authoring/data breakage.
    const unitScope: ExpressionScope = isFanOut ? { ...scope, item, itemIndex: index } : scope;
    const resolvedInstr = resolveTemplate(instructionSegments, unitScope);

    let resolved: StepWorkUnit["resolved"];
    if (!resolvedInstr.ok) {
      resolved = {
        ok: false,
        error: `instructions failed to resolve: ${resolvedInstr.errors.map((e) => e.message).join(" ")}`,
      };
    } else {
      const prompt = buildUnitPrompt({
        runId: input.runId,
        stepId: plan.stepId,
        unitId,
        params: input.params,
        ...(input.gateFeedback ? { gateFeedback: input.gateFeedback } : {}),
        ...(template.schema ? { schema: template.schema } : {}),
        instructions: resolvedInstr.text,
      });
      // Canonical dispatch-input envelope (reviewer finding #1). Every field
      // here is a PLAN-FROZEN input that changes what the backend is actually
      // asked to do, so a completed unit is reused ONLY when all of them match;
      // a change to any of them re-dispatches. Key order is FIXED — it is the
      // hash preimage (JSON.stringify preserves insertion order) — and shared
      // by ALL surfaces, since this is the ONE place a unit's inputHash is
      // computed (engine, brief, and report all call computeStepWorkList), so
      // the byte-identical hash across surfaces is structural, not coincidental.
      //
      // Included beyond the R4 baseline (prompt/runner/model/schema): resolved
      // timeoutMs, the env asset ref NAMES, and isolation — each
      // reaches dispatch (native-executor's UnitDispatchRequest) and a changed
      // one yields a materially different call. `env` carries NAMES ONLY, never
      // resolved values: hashing a resolved secret would leak it into a
      // durable hash oracle and would spuriously re-dispatch on every secret
      // rotation. `retry`/`onError` are DELIBERATELY excluded — they govern
      // failed-unit re-dispatch and step-level failure reduction, not a
      // COMPLETED unit's inputs/output, so a completed row stays valid across
      // policy changes.
      //
      // Ambient config is DELIBERATELY excluded — the model-alias table, the
      // resolved backend/connection, and the working directory (`ctx.workDir` /
      // process.cwd()) are NOT plan-frozen. The frozen plan is the identity
      // boundary (redesign addendum determinism bar #2): config drift under an
      // in-flight run is out of scope by design.
      const dispatch = transitiveDispatchSnapshot(frozenEngine, input.engines ?? {});
      const inputHash = createHash("sha256")
        .update(
          canonicalJsonString({
            hashVersion: 3,
            prompt,
            dispatch,
            invocation: frozenInvocation,
            schema: template.schema ?? null,
            env: template.env ?? null,
            isolation: template.isolation ?? "none",
          }),
        )
        .digest("hex");
      resolved = { ok: true, prompt, inputHash };
    }

    return {
      unitId,
      nodeId: template.id,
      index,
      item,
      isFanOut,
      journalBaseId,
      runner,
      engine: frozenEngine,
      ...(frozenEngine?.kind === "agent" &&
      frozenEngine.fallbackLlmEngine &&
      input.engines?.[frozenEngine.fallbackLlmEngine]?.kind === "llm"
        ? {
            fallbackEngine: input.engines[frozenEngine.fallbackLlmEngine] as Extract<
              FrozenEngineSnapshot,
              { kind: "llm" }
            >,
          }
        : {}),
      invocation: frozenInvocation,
      ...(frozenInvocation.model ? { model: frozenInvocation.model } : {}),
      timeoutMs,
      ...(template.schema ? { schema: template.schema } : {}),
      ...(template.env ? { env: template.env } : {}),
      ...(template.retry ? { retry: template.retry } : {}),
      onError: template.onError,
      ...(template.isolation ? { isolation: template.isolation } : {}),
      resolved,
    };
  });

  const concurrency = root.kind === "map" ? root.concurrency : 1;
  return {
    ok: true,
    list: { template, reducer, isFanOut, ...(concurrency !== undefined ? { concurrency } : {}), items, units },
  };
}

// ── Prompt assembly (PURE) ───────────────────────────────────────────────────

export interface BuildUnitPromptInput {
  runId: string;
  stepId: string;
  unitId: string;
  params: Record<string, unknown>;
  gateFeedback?: GateFeedback;
  schema?: Record<string, unknown>;
  /** Instructions with every `${{ … }}` reference already resolved (single pass). */
  instructions: string;
}

/**
 * Assemble the final prompt: engine preamble + resolved instructions
 * (+ gate feedback on loop re-executions, + schema directive). Workflow-
 * authored interpolation happened upstream via the expression module; only
 * the ENGINE's own preamble placeholders are substituted here.
 */
export function buildUnitPrompt(input: BuildUnitPromptInput): string {
  const { runId, stepId, unitId, params, gateFeedback, schema, instructions } = input;
  // Function replacements throughout: a string replacement would interpret
  // GetSubstitution patterns ($&, $$, $', $`) inside VALUES and silently
  // corrupt the prompt (e.g. a param value containing "$&").
  const preamble = unitPreambleTemplate
    .replaceAll("{{RUN_ID}}", () => runId)
    .replaceAll("{{STEP_ID}}", () => stepId)
    .replaceAll("{{UNIT_ID}}", () => unitId)
    .replaceAll("{{PARAMS_JSON}}", () => safeJson(params));

  // Gate-loop feedback (R2 max_loops): the judge's rejection is appended so
  // the re-executed unit can address it — and so the input hash changes,
  // making the loop's re-dispatch natural instead of a durable-row reuse.
  const gateBlock = gateFeedback
    ? `\n\n## Completion-gate feedback (previous attempt rejected)\n` +
      `A completion-criteria judge rejected this step's previous results. Address this feedback:\n` +
      gateFeedback.feedback +
      (gateFeedback.missing.length > 0
        ? `\nUnmet criteria:\n${gateFeedback.missing.map((m) => `- ${m}`).join("\n")}`
        : "")
    : "";

  const schemaDirective = schema
    ? `\n\nRespond with ONLY a JSON value matching this JSON Schema (no prose, no code fences):\n${safeJson(schema)}`
    : "";

  return `${preamble}\n${instructions}${gateBlock}${schemaDirective}`;
}

/**
 * Content-derived unit identity (module doc): `<node_id>:<hash12>` for a
 * fan-out item, `<node_id>:solo` otherwise. The hash is over the item's
 * canonical JSON (sorted keys — same canonicalization the vote reducer
 * counts with), so identity survives list reordering/regeneration and is
 * independent of item position. Retry attempts stack `~r<n>` on top.
 */
export function unitIdFor(nodeId: string, item: unknown, isFanOut: boolean): string {
  if (!isFanOut) return `${nodeId}:solo`;
  const canonical = canonicalJson(item) ?? "null";
  return `${nodeId}:${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`;
}

/** Include an SDK fallback in v3 call identity without copying catalog entries onto nodes. */
function transitiveDispatchSnapshot(
  engine: FrozenEngineSnapshot,
  engines: Record<string, FrozenEngineSnapshot>,
): FrozenEngineSnapshot | { engine: FrozenEngineSnapshot; fallback: FrozenEngineSnapshot } {
  if (engine.kind !== "agent" || !engine.fallbackLlmEngine) return engine;
  const fallback = engines[engine.fallbackLlmEngine];
  if (!fallback || fallback.kind !== "llm") {
    throw new UsageError(`Frozen agent engine "${engine.name}" has no valid LLM fallback snapshot.`);
  }
  return { engine, fallback };
}

// ── Step outputs + reducers + typed artifacts ────────────────────────────────

/**
 * The value `${{ steps.<id>.output }}` resolves to for ONE step, given that
 * step's journaled evidence: an engine-executed step carries a promoted
 * ARTIFACT under `evidence.output` (solo unit result/text, collect array, or
 * vote winner); evidence without an `output` key (manually-completed steps) is
 * exposed as-is.
 */
export function projectStepOutput(evidence: Record<string, unknown>): unknown {
  return Object.hasOwn(evidence, "output") ? evidence.output : evidence;
}

/** Project the engine's evidence map into the expression scope's `stepOutputs`. */
export function stepOutputsFromEvidence(
  evidence: Record<string, Record<string, unknown> | undefined>,
): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  for (const [stepId, stepEvidence] of Object.entries(evidence)) {
    if (stepEvidence !== undefined) outputs[stepId] = projectStepOutput(stepEvidence);
  }
  return outputs;
}

/**
 * Typed artifacts (addendum, R2): validate the promoted step artifact against
 * `IrStepPlan.outputSchema`. Returns the step-failure summary (validation
 * errors included) on mismatch, undefined when valid or when no schema is
 * declared.
 */
export function validateStepArtifact(plan: IrStepPlan, evidence: Record<string, unknown>): string | undefined {
  if (!plan.outputSchema) return undefined;
  const errors = validateJsonSchemaSubset(projectStepOutput(evidence), plan.outputSchema);
  if (errors.length === 0) return undefined;
  return (
    `Step "${plan.stepId}" artifact failed validation against the step's declared output schema: ` +
    `${errors.join("; ")}.`
  );
}

/**
 * Build the summary the completion-criteria gate judges for a step (addendum
 * R2, "typed artifacts, honest gates"): a one-line unit count followed by the
 * promoted step artifact as canonical JSON, clipped at {@link GATE_ARTIFACT_CLIP}
 * chars. This replaces machine-prose so the gate evaluates real results.
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

/** A unit's contribution to the step artifact: structured result, else text, else null (failures). */
function unitOutputValue(unit: UnitOutcome): unknown {
  if (!unit.ok) return null;
  if (unit.result !== undefined) return unit.result;
  return unit.text ?? null;
}

export function buildEvidence(
  units: UnitOutcome[],
  reducer: "collect" | "vote" | "best-of-n",
  isFanOut: boolean,
): Record<string, unknown> {
  // Per-unit evidence is the DURABLE, surface-independent projection the two
  // driver surfaces (engine + brief/report) must agree on byte-for-byte (R4
  // conformance, "identical unit graph"). It therefore carries ONLY fields both
  // surfaces can reproduce from the journal:
  //   - a SUCCESS keeps its promoted contribution (structured `result` or clipped
  //     `text`) — the report path rehydrates exactly these from the unit row;
  //   - a FAILURE keeps only its `failureReason` (the durable, journaled failure
  //     vocabulary). The engine's in-memory dispatch diagnostic (`error`) and any
  //     residual `text` on a failed unit are NOT persisted here: a driver-reported
  //     failure carries neither, so persisting them on the engine surface alone
  //     would diverge the durable graph. The full raw text/reason still lives on
  //     the unit row for engine-side diagnostics; this is the shared graph.
  const collected = units.map((u) =>
    u.ok
      ? {
          unitId: u.unitId,
          ok: true as const,
          ...(u.result !== undefined ? { result: u.result } : {}),
          ...(u.text !== undefined ? { text: clip(u.text, EVIDENCE_TEXT_CLIP) } : {}),
        }
      : {
          unitId: u.unitId,
          ok: false as const,
          ...(u.failureReason ? { failureReason: u.failureReason } : {}),
        },
  );
  const evidence: Record<string, unknown> = { units: collected, itemCount: units.length };

  // Promoted step artifact (`evidence.output`) — what `${{ steps.<id>.output }}`
  // resolves to (see projectStepOutput). Values are UNCLIPPED.
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

/**
 * The reduced outcome of a step's executed units — the shared post-dispatch
 * decision. `executeStepPlan` (native dispatch) and the R3 report path (units
 * replayed from the journal) both feed their {@link UnitOutcome}[] through
 * {@link reduceStepOutcomes} to produce this, so an engine-driven step and a
 * report-driven step of the same frozen plan promote the SAME artifact, apply
 * the SAME `on_error` policy, and validate against the SAME output schema. The
 * dispatch-only accounting (`unitsDispatched` / `tokensUsed`) lives on the
 * executor's richer result, not here.
 */
export interface ExecutedStepOutcome {
  ok: boolean;
  units: UnitOutcome[];
  evidence: Record<string, unknown>;
  summary: string;
  /** Set when `ok` is false BECAUSE the promoted artifact failed the step's
   * declared output schema (the one failure a gate loop may re-run). */
  artifactSchemaFailure?: true;
}

/**
 * Reduce a step's terminal unit outcomes into the promoted artifact + step
 * verdict — the shared semantics between native dispatch and the report path.
 * Applies the `on_error` policy (`fail` vs `continue`), the reducer (via
 * {@link buildEvidence}), the vote-tie failure, and the typed-artifact schema
 * validation (fail-fast, errors in the summary, `artifactSchemaFailure` marker).
 * Callers own dispatch-specific concerns (replay-divergence, budget) BEFORE
 * calling this; those never occur on the report path (units are journaled).
 */
export function reduceStepOutcomes(
  plan: IrStepPlan,
  reducer: "collect" | "vote" | "best-of-n",
  isFanOut: boolean,
  onError: IrOnError,
  units: UnitOutcome[],
): ExecutedStepOutcome {
  const failed = units.filter((u) => !u.ok);
  const evidence = buildEvidence(units, reducer, isFanOut);
  const reducerNote = typeof evidence.voteError === "string" ? ` ${evidence.voteError}` : "";
  const tolerateFailures = onError === "continue";
  let ok = (tolerateFailures || failed.length === 0) && !evidence.voteError;
  let summary =
    `Executed ${units.length} unit(s) for step "${plan.stepId}" via workflow orchestration: ` +
    `${units.length - failed.length} succeeded, ${failed.length} failed.` +
    (failed.length > 0
      ? ` Failures${tolerateFailures ? " (recorded, on_error: continue)" : ""}: ${failed
          .map((u) => `${u.unitId} (${u.failureReason ?? "error"})`)
          .join(", ")}.`
      : "") +
    reducerNote;

  let artifactSchemaFailure = false;
  if (ok) {
    const schemaFailure = validateStepArtifact(plan, evidence);
    if (schemaFailure !== undefined) {
      ok = false;
      summary = schemaFailure;
      artifactSchemaFailure = true;
    }
  }

  return { ok, units, evidence, summary, ...(artifactSchemaFailure ? { artifactSchemaFailure: true as const } : {}) };
}

/**
 * The reduced outcome of a step whose fan-out list resolved to EMPTY (`over: []`
 * or a producer that yielded `[]`): no units are dispatched, so the promoted
 * artifact is the degenerate empty value — the empty array for a `collect`
 * reducer, `null` for `vote` (references into a missing winner fail loudly at
 * resolution rather than silently reading the envelope). Even the degenerate
 * artifact must honor the step's declared `outputSchema` before it can complete.
 *
 * Shared by native dispatch (`executeStepPlan`'s `items.length === 0` branch)
 * and the R3 driver protocol (`report` auto-completes an empty step the spine
 * reaches, since no `report --unit` can ever advance a zero-unit step) so both
 * surfaces promote the SAME artifact and apply the SAME schema verdict — the
 * anti-drift guarantee. Deliberately does NOT run the reducer/vote-tie logic:
 * an empty step has no successful results to count, and a vote-tie "failure"
 * would diverge from the engine's long-standing empty-list semantics.
 */
export function reduceEmptyStep(plan: IrStepPlan, reducer: "collect" | "vote" | "best-of-n"): ExecutedStepOutcome {
  const evidence: Record<string, unknown> = { units: [], itemCount: 0, output: reducer === "collect" ? [] : null };
  const schemaFailure = validateStepArtifact(plan, evidence);
  return {
    ok: schemaFailure === undefined,
    units: [],
    evidence,
    summary: schemaFailure ?? `Step "${plan.stepId}" fan-out list was empty — no units dispatched.`,
    ...(schemaFailure !== undefined ? { artifactSchemaFailure: true as const } : {}),
  };
}

/**
 * Rehydrate a journaled unit row into a {@link UnitOutcome}. Shared by the
 * executor's durable-row reuse (`native-executor.ts`, completed rows only) and
 * the R3 report path (which reduces completed AND failed rows replayed from the
 * journal). A completed row's text unit journals its output as a JSON string; a
 * schema unit journals the validated structure. A failed row carries its
 * `failure_reason`; any journaled text is surfaced too.
 */
export function unitOutcomeFromRow(unitId: string, row: WorkflowRunUnitRow, hasSchema: boolean): UnitOutcome {
  let parsed: unknown;
  try {
    parsed = row.result_json === null ? undefined : JSON.parse(row.result_json);
  } catch {
    parsed = undefined;
  }
  if (row.status === "completed") {
    return {
      unitId,
      ok: true,
      ...(hasSchema
        ? { result: parsed }
        : typeof parsed === "string"
          ? { text: parsed }
          : parsed !== undefined
            ? { result: parsed }
            : {}),
      ...(row.tokens !== null ? { tokens: row.tokens } : {}),
      ...(row.session_id !== null && row.session_id !== undefined ? { sessionId: row.session_id } : {}),
    };
  }
  return {
    unitId,
    ok: false,
    failureReason: row.failure_reason ?? "reported_failure",
    ...(typeof parsed === "string" ? { text: parsed } : {}),
    ...(row.tokens !== null ? { tokens: row.tokens } : {}),
  };
}

/**
 * Select the journaled attempt row that determines a unit's TERMINAL outcome on
 * a REPLAY surface — the engine's durable-row reuse AND the harness-neutral
 * brief/report driver protocol — given the run's dispatch rows indexed by
 * unit_id. This is the ONE place all surfaces resolve "which journaled row IS
 * this unit's outcome," so they cannot drift from each other or from the engine.
 *
 * It mirrors the executor's {@link classifyUnitReuse} attempt scan
 * (native-executor.ts): among the base attempt and its `~r<n>` retries — all
 * stacked on `journalBaseId`, which already carries the active `~l<loop>` gate
 * suffix — the FIRST completed attempt is the effective result. So a unit whose
 * base attempt FAILED but whose later retry COMPLETED reduces as COMPLETED,
 * exactly like an engine resume reusing the `~r1` row (Codex round-3 finding C);
 * reading only the base row would reduce it as failed and diverge the two
 * surfaces. With no completed attempt the HIGHEST journaled attempt stands (a
 * terminal failure, or a still-running row); no attempt row at all ⇒ `undefined`
 * (the unit is still outstanding).
 */
export function selectUnitAttemptRow(
  workUnit: StepWorkUnit,
  dispatchRows: Map<string, WorkflowRunUnitRow>,
): WorkflowRunUnitRow | undefined {
  const base = workUnit.journalBaseId;
  const maxAttempts = 1 + Math.max(0, workUnit.retry?.max ?? 0);
  let fallback: WorkflowRunUnitRow | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const row = dispatchRows.get(attempt === 0 ? base : `${base}~r${attempt}`);
    if (!row) continue;
    if (row.status === "completed") return row;
    fallback = row; // remember the highest journaled (non-completed) attempt
  }
  return fallback;
}

/**
 * Is a FAILED unit still RETRY-ELIGIBLE — i.e. NOT terminal, because a driver
 * could still re-run it via the `--rerun` form (the engine's automatic
 * `<baseId>~r<n>` retry)? A unit whose declared `retry.on` matches the recorded
 * failure reason AND whose attempt budget (`1 + retry.max`) is not yet spent can
 * still be re-run. No `retry`, an off-list reason, or an exhausted attempt budget
 * ⇒ the failure IS terminal. Shared by the report fail-fast decision, the
 * `--settle` refusal, and `brief`'s fully-terminal detection so all three agree
 * on when a failed unit is genuinely done vs. still re-runnable. The normalized
 * failure reason is compared against `retry.on` directly (a canonical taxonomy
 * reason is stored verbatim; an `external:*` reason is by construction outside
 * the taxonomy `retry.on` lists).
 */
export function isRetryEligibleFailure(
  workUnit: StepWorkUnit,
  row: WorkflowRunUnitRow | undefined,
  failureReason: string | null,
): boolean {
  const retry = workUnit.retry;
  if (!retry || failureReason === null || !retry.on.includes(failureReason)) return false;
  const attempts = row?.attempts ?? 1;
  return attempts < 1 + Math.max(0, retry.max);
}

/**
 * Does a resolvable unit still need a driver to execute + report it (or re-run
 * it)? True for a unit with no terminal row (pending), a still-`running` row (a
 * live/stale claim another driver holds), or a FAILED row that is still
 * retry-eligible. False for a COMPLETED row, a terminal non-retry-eligible
 * FAILURE, or an UNRESOLVABLE unit (the engine's immediate `expression_error` —
 * never reportable). The best terminal attempt (base + `~r<n>` retries) is the
 * one consulted, the SAME reuse the engine and reducer apply.
 */
export function unitStillNeedsReport(workUnit: StepWorkUnit, dispatchRows: Map<string, WorkflowRunUnitRow>): boolean {
  if (!workUnit.resolved.ok) return false;
  const row = selectUnitAttemptRow(workUnit, dispatchRows);
  if (!row) return true; // no journal row → pending
  if (row.status === "running") return true; // a live/stale claim is still in flight
  if (row.status === "failed") return isRetryEligibleFailure(workUnit, row, row.failure_reason);
  return false; // completed (or a non-retry-eligible failure) → terminal
}

/**
 * Is the active step's work-list FULLY TERMINAL — every resolvable unit run to a
 * terminal (done, or non-retry-eligible failed) state with nothing left to
 * execute or per-unit report — yet still needing finalization? This is the
 * driver-recovery state after a required-gate block is resumed, or a crash
 * between the last unit write and the step's completion (owner manual-validation
 * finding 3): the work-list is done but the step never advanced. `brief`
 * surfaces it with a single `report --settle` command and `--settle` runs the
 * shared completion path for it. A list with ANY outstanding unit (pending,
 * in-flight, or retry-eligible failed) is NOT fully terminal — the driver
 * `report --unit`s those. A route-only / empty / all-unresolvable list (no
 * resolvable units) is a DIFFERENT non-dispatching state, handled separately.
 */
export function isWorkListFullyTerminal(
  workList: StepWorkList,
  dispatchRows: Map<string, WorkflowRunUnitRow>,
): boolean {
  if (!workList.units.some((u) => u.resolved.ok)) return false;
  return workList.units.every((u) => !unitStillNeedsReport(u, dispatchRows));
}

/** Stable stringify (sorted object keys, recursively) so equal values vote together. */
export function canonicalJson(value: unknown): string {
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

// ── Gate-feedback recovery (PURE) ────────────────────────────────────────────
//
// A gate rejection is journaled as `<stepId>.gate:l<loop>` with result_json
// `{ complete: false, missing, feedback }` (see journalGateEvaluationFinish).
// The feedback stored there is BYTE-IDENTICAL to what the engine threads into
// the next loop's prompts — both are the same `rejection.feedback`/`.missing`.
// `brief` recovers it from the journal so its loop-N work-list matches the
// engine's (redesign addendum R3, task item 2). `native-executor.test.ts`
// asserts the round-trip identity.

/**
 * `phase` marker stamped on gate-evaluation unit rows. Step ids cannot contain
 * dots (`PROGRAM_STEP_ID_PATTERN`), so a step can never be NAMED `x.gate` and
 * the synthetic `<stepId>.gate` node id is collision-free against user step
 * ids. The phase column is nonetheless the discriminator we key on — an
 * explicit marker, not a `node_id` suffix match, so recovery stays robust even
 * if the id scheme evolves. Dispatch rows always journal `phase: null`.
 */
export const GATE_EVALUATION_PHASE = "gate";

/** The unit id of a step's gate-evaluation row for a given 1-based loop. */
export function gateUnitId(stepId: string, loop: number): string {
  return `${stepId}.gate:l${loop}`;
}

/**
 * The gate loop the engine is about to (re-)run for an ACTIVE step, derived
 * purely from the journal: one past the highest journaled loop that REJECTED
 * (`complete: false`). No rejected gate rows ⇒ loop 1 (the first execution).
 * A passed gate would have advanced the spine, so an active step never has a
 * `complete: true` row as its latest gate evaluation.
 *
 * Reviewer #17: a gate row that EXISTS but cannot be parsed (or carries an
 * invalid verdict shape) is CORRUPTION — {@link parseGateVerdict} throws loudly
 * rather than letting `gateRowRejected` swallow the parse error, which would
 * silently drop the loop back to 1 and re-dispatch work whose gate outcome is
 * unknown.
 */
export function activeGateLoop(rows: WorkflowRunUnitRow[], stepId: string): number {
  let maxRejectedLoop = 0;
  for (const row of rows) {
    if (row.phase !== GATE_EVALUATION_PHASE || row.step_id !== stepId) continue;
    const loop = gateLoopOf(row.unit_id, stepId);
    if (loop === undefined) continue;
    // Throws loudly on a corrupt/malformed gate row — never treated as absent.
    if (parseGateVerdict(row).kind === "rejected" && loop > maxRejectedLoop) maxRejectedLoop = loop;
  }
  return maxRejectedLoop + 1;
}

/**
 * Recover the gate feedback the engine threads into `loop`'s unit prompts: the
 * `{ feedback, missing }` journaled by the previous loop's rejection
 * (`<stepId>.gate:l<loop-1>`). Loop 1 (or a missing/passed/errored previous row)
 * has no feedback. Pure — the journal rows are passed in.
 *
 * Reviewer #17: a PRESENT previous gate row that cannot be parsed fails LOUDLY
 * (via {@link parseGateVerdict}) instead of returning undefined — a corrupt row
 * must not make an in-loop step look like loop 1 with no recovered feedback.
 */
export function recoverGateFeedback(
  rows: WorkflowRunUnitRow[],
  stepId: string,
  loop: number,
): GateFeedback | undefined {
  if (loop <= 1) return undefined;
  const prevId = gateUnitId(stepId, loop - 1);
  const prev = rows.find((r) => r.unit_id === prevId && r.phase === GATE_EVALUATION_PHASE);
  if (!prev) return undefined;
  const verdict = parseGateVerdict(prev);
  return verdict.kind === "rejected" ? { feedback: verdict.feedback, missing: verdict.missing } : undefined;
}

/** The 1-based loop encoded in a `<stepId>.gate:l<n>` unit id, if well-formed. */
function gateLoopOf(unitId: string, stepId: string): number | undefined {
  const prefix = `${stepId}.gate:l`;
  if (!unitId.startsWith(prefix)) return undefined;
  const n = Number.parseInt(unitId.slice(prefix.length), 10);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** A gate-evaluation row's classified verdict (see {@link parseGateVerdict}). */
type GateVerdict =
  | { kind: "rejected"; missing: string[]; feedback: string }
  | { kind: "passed" }
  /** NULL result_json: an errored judge (fail-open) or an in-flight/running row. */
  | { kind: "empty" };

/**
 * Classify a gate-evaluation row's journaled verdict, failing LOUDLY on a
 * corrupt one (reviewer #17). A NULL `result_json` is the LEGITIMATE
 * errored-judge / in-flight shape (`journalGateEvaluationFinish` writes null for
 * an errored judge, and a `running` row has no verdict yet) and classifies as
 * `empty`. But a PRESENT `result_json` that does not parse as JSON, or parses to
 * anything other than an object with a boolean `complete` field, is corruption —
 * a truncated or hand-edited row — and MUST NOT be silently treated as absent
 * (which would reset an active step's gate loop to 1 and re-dispatch work whose
 * completion outcome is unknown). We refuse to guess.
 */
function parseGateVerdict(row: WorkflowRunUnitRow): GateVerdict {
  if (row.result_json === null) return { kind: "empty" };
  let verdict: unknown;
  try {
    verdict = JSON.parse(row.result_json);
  } catch {
    throw new UsageError(gateCorruptionMessage(row, "its result_json is not valid JSON"));
  }
  if (typeof verdict !== "object" || verdict === null || Array.isArray(verdict)) {
    throw new UsageError(gateCorruptionMessage(row, "its result_json is not a JSON object"));
  }
  const v = verdict as Record<string, unknown>;
  if (typeof v.complete !== "boolean") {
    throw new UsageError(gateCorruptionMessage(row, 'its verdict has no boolean "complete" field'));
  }
  if (v.complete === false) {
    const feedback = typeof v.feedback === "string" ? v.feedback : "";
    const missing = Array.isArray(v.missing) ? v.missing.filter((m): m is string => typeof m === "string") : [];
    return { kind: "rejected", missing, feedback };
  }
  return { kind: "passed" };
}

function gateCorruptionMessage(row: WorkflowRunUnitRow, why: string): string {
  return (
    `Workflow run ${row.run_id} has a corrupt gate-evaluation row "${row.unit_id}" for step "${row.step_id}" — ${why}. ` +
    `A gate verdict must be {"complete": true|false, …}; refusing to treat a malformed gate row as absent, which would ` +
    `silently restart the step's gate loop and re-dispatch work whose completion outcome is unknown. Fix or remove the ` +
    `journaled row, then resume the run.`
  );
}

// ── Gate-evaluation journaling (IO) ──────────────────────────────────────────
//
// An engine-driven completion-criteria judge call is an LLM call and is
// journaled like a unit: node_id `<stepId>.gate`, unit_id `<stepId>.gate:l<loop>`,
// runner "llm", result_json = the verdict. Rows are observability + audit; they
// are never REUSED. Events carry ids/status only.

export interface GateUnitRef {
  runId: string;
  workflowRef: string;
  stepId: string;
  /** Gate-loop attempt, 1-based. */
  loop: number;
  invocation: IrInvocation;
  inputHash: string;
}

/** Insert the gate-evaluation unit row (running) just before the judge runs. */
export async function journalGateEvaluationStart(gate: GateUnitRef): Promise<void> {
  const unitId = gateUnitId(gate.stepId, gate.loop);
  await enqueueUnitWrite(() =>
    withWorkflowRunsRepo((repo) =>
      repo.insertUnit({
        runId: gate.runId,
        unitId,
        stepId: gate.stepId,
        nodeId: `${gate.stepId}.gate`,
        parentUnitId: null,
        // Marks the row as a judge call, NOT a dispatch: the budget/lifetime
        // seed in `driveRun` skips these so resume accounting matches live.
        phase: GATE_EVALUATION_PHASE,
        runner: "llm",
        engine: gate.invocation.engine,
        model: gate.invocation.model,
        inputHash: gate.inputHash,
        startedAt: new Date().toISOString(),
      }),
    ),
  );
  appendEvent({
    eventType: "workflow_unit_started",
    ref: gate.workflowRef,
    metadata: { runId: gate.runId, stepId: gate.stepId, unitId },
  });
}

/**
 * Finish the gate-evaluation unit row with the verdict as observed from the
 * completion outcome: a rejection journals `{ complete: false, missing,
 * feedback }`; a pass journals `{ complete: true, missing: [] }`; a judge that
 * threw (or, on a required gate, returned an unparseable verdict) journals a
 * failed row with a NULL verdict. A NON-required errored gate then fails OPEN
 * inside `validateStepSummary`; a REQUIRED errored gate BLOCKS the step
 * (`finalizeExecutedStep`, Codex round-3 finding A).
 */
export async function journalGateEvaluationFinish(
  gate: GateUnitRef,
  errored: boolean,
  rejection: SummaryValidationFailure | undefined,
): Promise<void> {
  const unitId = gateUnitId(gate.stepId, gate.loop);
  const verdict = errored
    ? null
    : rejection
      ? { complete: false, missing: rejection.missing, feedback: rejection.feedback }
      : { complete: true, missing: [] };
  const status = errored ? ("failed" as const) : ("completed" as const);
  await enqueueUnitWrite(() =>
    withWorkflowRunsRepo((repo) =>
      repo.finishUnit({
        runId: gate.runId,
        unitId,
        status,
        resultJson: verdict ? JSON.stringify(verdict) : null,
        tokens: null,
        failureReason: errored ? "dispatch_error" : null,
        finishedAt: new Date().toISOString(),
      }),
    ),
  );
  appendEvent({
    eventType: "workflow_unit_finished",
    ref: gate.workflowRef,
    metadata: { runId: gate.runId, stepId: gate.stepId, unitId, status },
  });
}

// ── Route evaluation + cascaded-skip bookkeeping (PURE) ──────────────────────

export type RouteDecision = { ok: true; value: string; selected: string } | { ok: false; error: string };

/** `selected: null` = the router itself was skipped, so it selected nothing. */
export type RouteSkipInfo = { router: string; selected: string | null };

/**
 * Resolve a route's input (a single whole-value `${{ … }}` reference) and pick
 * the branch. No ambient key search. Only primitive values route; the
 * comparison is exact string equality against the declared `when:` matches.
 */
export function evaluateRoute(route: IrRouteSpec, scope: ExpressionScope): RouteDecision {
  const resolved = resolveWholeValue(route.input, scope);
  if (!resolved.ok) {
    return { ok: false, error: `route input ${route.input} failed to resolve: ${resolved.error.message}` };
  }
  const value = resolved.value;
  if (typeof value === "object" && value !== null) {
    return {
      ok: false,
      error: `route input ${route.input} resolved to a non-primitive value; branches match on strings/numbers/booleans.`,
    };
  }

  const valueString = typeof value === "string" ? value : String(value);
  // Own-property check: `when` is author-controlled, and a value such as
  // "constructor" must not resolve through Object.prototype.
  const selected = Object.hasOwn(route.when, valueString) ? route.when[valueString] : route.defaultStepId;
  if (!selected) {
    return {
      ok: false,
      error: `value "${valueString}" matched no "when:" branch and the route declares no default.`,
    };
  }
  return { ok: true, value: valueString, selected };
}

/**
 * Cascade a SKIPPED router: it never evaluated its route, so every declared
 * target (branches + default) is marked skip-on-reach unless an earlier router
 * already claimed it. Shared by the live skip path and the journal replay.
 */
export function cascadeSkippedRouter(
  route: IrRouteSpec,
  routerId: string,
  routeUnselected: Map<string, RouteSkipInfo>,
): void {
  const targets = [...Object.values(route.when), ...(route.defaultStepId ? [route.defaultStepId] : [])];
  for (const target of targets) {
    if (!routeUnselected.has(target)) {
      routeUnselected.set(target, { router: routerId, selected: null });
    }
  }
}

/**
 * Record one router's decision in the skip bookkeeping: the selected target is
 * protected, every other declared target (branches + default) is marked
 * skip-on-reach unless an earlier router already claimed it. Shared by the live
 * evaluation path and the journal replay.
 */
export function applyRouteDecision(
  route: IrRouteSpec,
  routerId: string,
  selected: string,
  routeSelected: Set<string>,
  routeUnselected: Map<string, RouteSkipInfo>,
): void {
  routeSelected.add(selected);
  const targets = [...Object.values(route.when), ...(route.defaultStepId ? [route.defaultStepId] : [])];
  for (const target of targets) {
    if (target !== selected && !routeUnselected.has(target)) {
      routeUnselected.set(target, { router: routerId, selected });
    }
  }
}

/**
 * The `stepOutputs` scope a route resolves against: every prior step's recorded
 * evidence plus the just-finished step's fresh evidence — each projected
 * through {@link projectStepOutput}. Same projection as unit templates, so the
 * two scopes cannot drift.
 */
export function routeStepOutputs(
  evidence: Record<string, Record<string, unknown> | undefined>,
  currentStepId: string,
  currentEvidence: Record<string, unknown>,
): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  for (const [stepId, stepEvidence] of Object.entries(evidence)) {
    if (stepEvidence !== undefined) outputs[stepId] = projectStepOutput(stepEvidence);
  }
  outputs[currentStepId] = projectStepOutput(currentEvidence);
  return outputs;
}

/** The `selected` target journaled on a route step's evidence, if well-formed. */
function journaledRouteSelection(evidence: Record<string, unknown> | undefined): string | undefined {
  const route = evidence?.route;
  if (typeof route !== "object" || route === null || Array.isArray(route)) return undefined;
  const selected = (route as Record<string, unknown>).selected;
  return typeof selected === "string" && selected !== "" ? selected : undefined;
}

/** The set of steps a route may legally select: its `when` branches + default. */
function routeTargets(route: IrRouteSpec): Set<string> {
  return new Set([...Object.values(route.when), ...(route.defaultStepId ? [route.defaultStepId] : [])]);
}

/**
 * Reviewer #7: a journaled route decision must name a target the route actually
 * DECLARES (`when` branch or `default`). Corrupted or hand-edited evidence can
 * otherwise mark a non-existent step as `selected` — which unselects and skips
 * every REAL branch target, silently steering the run down a phantom branch.
 * `evaluateRoute` can only ever produce a declared target, so a stored value
 * outside that set is provably tampered evidence: fail loudly rather than seed a
 * bogus skip set.
 */
function assertRouteTargetDeclared(route: IrRouteSpec, stepId: string, selected: string, runId: string): void {
  const targets = routeTargets(route);
  if (!targets.has(selected)) {
    throw new UsageError(
      `Workflow run ${runId} has a completed route step "${stepId}" whose journaled route decision selected ` +
        `"${selected}", which is not a declared branch or default target of the route (valid targets: ` +
        `${[...targets].join(", ") || "(none)"}). The route evidence was corrupted or manually edited — refusing to ` +
        `apply a bogus route decision that would skip the real branch targets. Start a new run.`,
    );
  }
}

/**
 * Validate every COMPLETED route step's journaled selection against its declared
 * targets (reviewer #7). Read-only: it throws on a PRESENT-but-invalid selection
 * and is silent on an absent one, so it never false-positives on a healthy run —
 * making it safe to call from the read-only `brief` surface as well as the
 * resume/report surfaces that already re-apply the decisions.
 */
export function assertJournaledRouteSelectionsValid(plan: WorkflowPlanGraph, state: WorkflowNextResult): void {
  for (const stepPlan of plan.steps) {
    if (!stepPlan.route) continue;
    const stepState = state.workflow.steps.find((s) => s.id === stepPlan.stepId);
    if (!stepState || stepState.status !== "completed") continue;
    const selected = journaledRouteSelection(stepState.evidence);
    if (selected !== undefined) {
      assertRouteTargetDeclared(stepPlan.route, stepPlan.stepId, selected, state.run.id);
    }
  }
}

/**
 * Replay journaled route decisions into the skip bookkeeping (resume path).
 * For every COMPLETED route step of the frozen plan, in spine order: the
 * journaled decision wins; else a re-derivation from the frozen plan +
 * journaled evidence; else fail loudly. A SKIPPED route step cascades its
 * targets into the skip set exactly as on the live path.
 */
export function seedJournaledRouteDecisions(
  plan: WorkflowPlanGraph,
  state: WorkflowNextResult,
  routeSelected: Set<string>,
  routeUnselected: Map<string, RouteSkipInfo>,
): void {
  const evidence: Record<string, Record<string, unknown> | undefined> = {};
  for (const s of state.workflow.steps) evidence[s.id] = s.evidence;

  for (const stepPlan of plan.steps) {
    if (!stepPlan.route) continue;
    const stepState = state.workflow.steps.find((s) => s.id === stepPlan.stepId);
    if (!stepState) continue;
    if (stepState.status === "skipped") {
      cascadeSkippedRouter(stepPlan.route, stepPlan.stepId, routeUnselected);
      continue;
    }
    if (stepState.status !== "completed") continue;

    let selected = journaledRouteSelection(stepState.evidence);
    if (selected !== undefined) {
      // Reviewer #7: a stored decision must name a declared target — a bogus one
      // (tampered/hand-edited evidence) fails loudly rather than seeding a skip
      // set that buries the real branches.
      assertRouteTargetDeclared(stepPlan.route, stepPlan.stepId, selected, state.run.id);
    }
    if (selected === undefined) {
      const scope: ExpressionScope = {
        params: state.run.params ?? {},
        stepOutputs: routeStepOutputs(evidence, stepPlan.stepId, stepState.evidence ?? {}),
      };
      const decision = evaluateRoute(stepPlan.route, scope);
      if (decision.ok) selected = decision.selected;
    }
    if (selected === undefined) {
      throw new UsageError(
        `Workflow run ${state.run.id} has a completed route step "${stepPlan.stepId}" with no journaled route ` +
          `decision, and the decision cannot be re-derived from the journaled evidence. Refusing to guess which ` +
          `branch was selected — advance the remaining steps manually with \`akm workflow complete\`.`,
      );
    }
    applyRouteDecision(stepPlan.route, stepPlan.stepId, selected, routeSelected, routeUnselected);
  }
}

// ── Step finalization (IO) — the shared completion path ──────────────────────
//
// ONE implementation of "given a step's executed outcome at a gate loop,
// evaluate the route, judge the completion gate, and advance (or not) the
// spine." The engine loop (`run-workflow.ts`) and the R3 report path both call
// it, so route evaluation, artifact-judged gates, gate-row journaling, and the
// bounded-loop rejection contract cannot drift between the two surfaces. The
// caller owns the SPINE-WALKING glue (which loop to run next, skip cascades,
// lease renewal); this function performs exactly ONE completion attempt.

export interface FinalizeStepInput {
  runId: string;
  workflowRef: string;
  stepId: string;
  stepPlan: IrStepPlan;
  /** The step's declared completion criteria (empty ⇒ no artifact-judging gate). */
  completionCriteria: string[];
  /** 1-based gate-loop attempt being completed. */
  gateLoop: number;
  /** True when a rejection may re-run the subgraph (`gateLoop < gate.max_loops`). */
  loopsRemaining: boolean;
  /** The reduced outcome of this loop's units (native dispatch or journal replay). */
  result: ExecutedStepOutcome;
  /** Prior steps' recorded evidence, keyed by step id (route scope; current step excluded). */
  priorEvidence: Record<string, Record<string, unknown> | undefined>;
  params: Record<string, unknown>;
  /** Route bookkeeping — mutated in place when this step carries a route decision. */
  routeSelected: Set<string>;
  routeUnselected: Map<string, RouteSkipInfo>;
  /**
   * Completion-criteria judge from the frozen plan. `undefined` and `null`
   * both mean no judge; live configuration is never consulted here.
   */
  summaryJudge: SummaryJudge | null | undefined;
  /**
   * Reviewer #18: treat EVERY criteria-bearing gate as required for this
   * completion (the engine's `--require-gates` run-wide override). A per-step
   * `gate.required: true` in the frozen plan has the same effect and rides both
   * surfaces; this flag is the engine-invocation-scoped override on top of it.
   */
  requireGates?: boolean;
  /** Engine run-lease holder (engine path only); absent on the manual/report path. */
  leaseHolder?: string;
}

export type FinalizeStepResult =
  | { kind: "advanced"; summaryOverride?: string }
  | { kind: "failed"; summary: string; routeFailure?: true }
  | { kind: "retry"; gateFeedback: GateFeedback }
  | { kind: "gate-exhausted"; gateRejection: { stepId: string; missing: string[]; feedback: string } }
  /** Reviewer #18: a required gate with no judge available — the step is BLOCKED for a human. */
  | { kind: "blocked"; summary: string };

/**
 * Perform ONE completion attempt for an executed step:
 *
 *  - a hard unit failure completes the step `failed` (a retryable typed-artifact
 *    mismatch with loops remaining returns `retry` WITHOUT journaling a gate row
 *    — no judge ran, exactly like the engine);
 *  - a route decision is evaluated against params + prior/fresh step outputs; an
 *    unroutable value fails the step; a valid decision is journaled on the
 *    step evidence and applied to the skip bookkeeping;
 *  - the completion gate judges a summary BUILT FROM the promoted artifact (when
 *    the step declares criteria), journaled as a `<stepId>.gate:l<loop>` unit
 *    row; a rejection with loops remaining returns `retry` (feedback threaded
 *    into the next loop), a rejection with none returns `gate-exhausted`, a pass
 *    returns `advanced`.
 *
 * Every DB advance goes through {@link completeWorkflowStep} — the gate spine is
 * never bypassed. Behavior is byte-identical to the engine's former inline loop
 * body (its tests prove it).
 */
export async function finalizeExecutedStep(input: FinalizeStepInput): Promise<FinalizeStepResult> {
  const { runId, workflowRef, stepId, stepPlan, completionCriteria, gateLoop, loopsRemaining, result } = input;
  const lease = input.leaseHolder !== undefined ? { leaseHolder: input.leaseHolder } : {};

  if (!result.ok) {
    // Typed-artifact mismatch with loop budget left: regenerate-with-errors
    // (the validation errors become the next loop's feedback). No judge ran, so
    // no gate row is journaled for this attempt.
    if (result.artifactSchemaFailure && loopsRemaining) {
      return { kind: "retry", gateFeedback: { feedback: result.summary, missing: [] } };
    }
    await completeWorkflowStep({
      runId,
      stepId,
      status: "failed",
      notes: result.summary,
      evidence: result.evidence,
      ...lease,
    });
    return { kind: "failed", summary: result.summary };
  }

  // Resolve the completion-criteria judge ONCE (reused by the gate below). A
  // A frozen plan either supplies its judge at the dispatch boundary or has no
  // judge. Re-selecting defaults here would let config drift change a run.
  const innerJudge = input.summaryJudge ?? null;

  // Reviewer #18: a REQUIRED completion gate must actually be judged. When the
  // gate carries criteria but no judge is available, `validateStepSummary` would
  // fail OPEN and silently pass the gate — exactly the offline/misconfigured
  // bypass a required gate exists to prevent. BLOCK the step instead (a human
  // resolves it via the documented manual path), rather than advance the spine
  // on an unjudged gate. `gate.required` rides the frozen plan (both surfaces);
  // `requireGates` is the engine's run-wide `--require-gates` override. Checked
  // BEFORE route evaluation so a blocked step journals no route decision.
  const gateRequired = stepPlan.gate.required === true || input.requireGates === true;
  if (gateRequired && completionCriteria.length > 0 && innerJudge === null) {
    const notes =
      `Step "${stepId}" has a REQUIRED completion gate but no summary-validation judge is available ` +
      `(no LLM is configured, or default LLM resolution failed). A required gate must be judged — refusing to fail ` +
      `open and silently pass it. The step is BLOCKED: configure an LLM, then \`akm workflow resume ${runId}\` to ` +
      `re-evaluate the gate, or advance the step manually with \`akm workflow complete\`.`;
    await completeWorkflowStep({ runId, stepId, status: "blocked", notes, evidence: result.evidence, ...lease });
    return { kind: "blocked", summary: notes };
  }

  // Route evaluation BEFORE completion: an unroutable value is an
  // authoring/config failure that must fail the step deterministically.
  let summaryOverride: string | undefined;
  if (stepPlan.route) {
    const scope: ExpressionScope = {
      params: input.params,
      stepOutputs: routeStepOutputs(input.priorEvidence, stepId, result.evidence),
    };
    const decision = evaluateRoute(stepPlan.route, scope);
    if (!decision.ok) {
      const notes = `Step "${stepId}" route failed: ${decision.error}`;
      await completeWorkflowStep({ runId, stepId, status: "failed", notes, evidence: result.evidence, ...lease });
      return { kind: "failed", summary: notes, routeFailure: true };
    }
    applyRouteDecision(stepPlan.route, stepId, decision.selected, input.routeSelected, input.routeUnselected);
    // Journal the decision on the evidence: resume replays it via
    // seedJournaledRouteDecisions, so the skip set survives re-invocation.
    result.evidence.route = { input: stepPlan.route.input, value: decision.value, selected: decision.selected };
    if (!stepPlan.root) {
      summaryOverride = `Step "${stepId}" routed on ${stepPlan.route.input}: value "${decision.value}" selected step "${decision.selected}".`;
    }
  }

  // Artifact-judging gate: a criteria-bearing executing step is judged on a
  // summary BUILT FROM the promoted artifact; everything else keeps the machine
  // summary (a route-only step's summary IS its decision).
  const summary =
    stepPlan.root && completionCriteria.length > 0
      ? buildArtifactSummary(stepId, result.units, result.evidence)
      : (summaryOverride ?? result.summary);

  // Journal engine-driven judge calls as unit rows (they are LLM calls). The
  // wrapper's `invoked` stays false when the gate is fail-open (no criteria / no
  // judge) — nothing is journaled, and human approvals are never cached.
  const frozenGate = innerJudge
    ? await withWorkflowRunsRepo((repo) => {
        const row = repo.getRunById(runId);
        if (!row) throw new UsageError(`Workflow run ${runId} was not found.`);
        const plan = requireExecutableWorkflowPlan(row);
        const invocation = plan.steps.find((step) => step.stepId === stepId)?.gate.judge ?? null;
        return invocation ? { invocation, engine: plan.execution?.engines[invocation.engine] ?? null } : null;
      })
    : null;
  const gateInvocation = frozenGate?.invocation ?? null;
  let gateUnit: GateUnitRef | undefined;
  const judgeState = { invoked: false, errored: false };
  const summaryJudge: SummaryJudge | null = innerJudge
    ? async (prompt) => {
        judgeState.invoked = true;
        if (gateInvocation) {
          gateUnit = {
            runId,
            workflowRef,
            stepId,
            loop: gateLoop,
            invocation: gateInvocation,
            inputHash: createHash("sha256")
              .update(
                canonicalJsonString({
                  hashVersion: 3,
                  dispatch: frozenGate?.engine ?? null,
                  invocation: gateInvocation,
                  prompt,
                }),
              )
              .digest("hex"),
          };
          await journalGateEvaluationStart(gateUnit);
        }
        try {
          return await innerJudge(prompt);
        } catch (err) {
          judgeState.errored = true;
          throw err;
        }
      }
    : null;

  // Reviewer #6: once the judge is invoked, its gate row is journaled `running`
  // (journalGateEvaluationStart) and MUST be finished on every exit. The
  // already-fixed window is the judge itself throwing (caught inside
  // validateStepSummary — `judgeState.errored` records it; a non-required gate
  // fails open, a required gate blocks below). The remaining
  // window is `completeWorkflowStep` throwing AFTER the judge ran — a stolen
  // lease, a concurrent state change, a DB error — which would otherwise skip the
  // finish and strand the gate row in `running`. Finish it as an errored row (the
  // observed outcome: the completion did not succeed), then re-propagate.
  let completion: Awaited<ReturnType<typeof completeWorkflowStep>>;
  try {
    completion = await completeWorkflowStep({
      runId,
      stepId,
      status: "completed",
      summary,
      evidence: result.evidence,
      summaryJudge,
      // Codex round-3 finding A: mark this completion's gate REQUIRED so
      // `validateStepSummary` does NOT fail open when the judge throws / is
      // unreachable / returns garbage — it flags `errored` and we block below.
      ...(gateRequired ? { requireGate: true } : {}),
      ...lease,
    });
  } catch (err) {
    if (gateUnit) await journalGateEvaluationFinish(gateUnit, true, undefined);
    throw err;
  }
  const rejection =
    "ok" in completion && completion.ok === false ? (completion as SummaryValidationFailure) : undefined;

  // A required gate whose judge could not be evaluated is an errored gate, not a
  // real rejection: journal the gate row as errored (verdict null) so the
  // observed outcome is honest, driven by EITHER the wrapper catching a throw OR
  // validateStepSummary flagging an unparseable verdict.
  const gateErrored = judgeState.errored || rejection?.errored === true;
  if (gateUnit) {
    await journalGateEvaluationFinish(gateUnit, gateErrored, rejection);
  }

  // Codex round-3 finding A: a REQUIRED gate that could not be judged (the judge
  // threw, was unreachable, or returned an unparseable verdict) must NOT fail
  // open and advance. The gate row is journaled errored above; BLOCK the step (a
  // human resolves it) instead of silently passing an unjudged required gate.
  if (rejection?.errored) {
    const notes =
      `Step "${stepId}" has a REQUIRED completion gate but its summary-validation judge failed to return a verdict ` +
      `(the LLM threw, was unreachable, or returned an unparseable response). A required gate must be judged — refusing ` +
      `to fail open and silently pass it. The step is BLOCKED: fix the LLM/connection, then \`akm workflow resume ${runId}\` ` +
      `to re-evaluate the gate, or advance the step manually with \`akm workflow complete\`.`;
    await completeWorkflowStep({ runId, stepId, status: "blocked", notes, evidence: result.evidence, ...lease });
    return { kind: "blocked", summary: notes };
  }

  if (!rejection) {
    return { kind: "advanced", ...(summaryOverride !== undefined ? { summaryOverride } : {}) };
  }
  if (loopsRemaining) {
    return { kind: "retry", gateFeedback: { feedback: rejection.feedback, missing: rejection.missing } };
  }
  return {
    kind: "gate-exhausted",
    gateRejection: { stepId, missing: rejection.missing, feedback: rejection.feedback },
  };
}

// ── Frozen plan parse + integrity check (shared) ─────────────────────────────

/**
 * Parse and integrity-check a run's frozen plan JSON (migration 006). Shared by
 * the engine loop's plan loader (`run-workflow.ts`) and the R3 brief/report
 * surfaces so all three apply the SAME corruption + hash checks — the frozen
 * plan the engine executes is the exact plan brief describes and report
 * validates against. A NULL `plan_json` is the CALLER's decision (the engine
 * warns and compiles from the asset; brief/report error), so this helper only
 * handles a PRESENT plan string.
 */
export function parseFrozenPlan(runId: string, planJson: string, planHash: string | null): WorkflowPlanGraph {
  try {
    return decodeCanonicalPlan(runId, planJson, planHash);
  } catch (cause) {
    throw new UsageError(
      `Workflow run ${runId} has a corrupt frozen plan: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        `The journaled plan cannot be executed — abandon it and start a new run.`,
    );
  }
}

// ── Small helpers ────────────────────────────────────────────────────────────

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
