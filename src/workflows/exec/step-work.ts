// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared step semantics — the ONE implementation of a step's orchestration
 * decisions, consumed by the engine loop (`run-workflow.ts` +
 * `native-executor.ts`) on both the fresh-execution and the resume/replay path.
 * The cardinal rule here is *no duplicated semantics*: work-list computation,
 * prompt assembly, reducer/artifact promotion, output-schema validation,
 * artifact-judged gate summaries, gate-feedback recovery, and route evaluation
 * live here so a first run and a resumed run of the same frozen plan produce
 * byte-identical unit graphs.
 *
 * ## What is PURE here
 *
 * {@link computeStepWorkList} — given the frozen step plan and a
 * {@link WorkListInput} (params, prior step outputs, gate-loop number + its
 * recovered feedback) — is a pure function: same inputs ⇒ same unit ids, input
 * hashes, and fully-resolved prompts. It takes NO clock, NO IO, and NO journal
 * (journal-derived state, i.e. the recovered gate feedback, is passed in). This
 * is the load-bearing guarantee that a resumed run recomputes exactly the units
 * the original run dispatched, so journaled rows can be reused instead of
 * re-executed. So are the reducer/artifact helpers
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
 * is journaled like a unit. It lives here (not in the engine loop) so every
 * caller journals gate evaluations through the identical writer.
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
import { canonicalJson as canonicalJsonString } from "../ir/plan-hash";
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
import { type ExpressionScope, resolveReferenceString } from "../program/expressions";
import { WORKFLOW_MAX_MAP_EXPANSION } from "../resource-limits";
import { requireExecutableWorkflowPlan } from "../runtime/plan-classifier";
import { completeWorkflowStep, type SummaryValidationFailure, type WorkflowNextResult } from "../runtime/runs";
import { GATE_EVALUATION_PHASE } from "../runtime/unit-phases";
import { parseJudgeVerdict, type SummaryJudge } from "../validate-summary";
import { enqueueUnitWrite } from "./unit-writer";

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
 * ids/hashes/prompts — the invariant resume/replay relies on to recognize the
 * units an earlier run already journaled.
 *
 * Whole-list failures (missing subgraph, unresolvable / non-array `over`,
 * null or duplicate fan-out items) return `{ ok: false }`. The per-unit
 * `resolved: { ok: false }` branch is STRUCTURALLY UNREACHABLE in the unified
 * format — prose is never scanned for references, and everything that CAN
 * fail (map.over / route.input / inputs:) resolves once per step, failing the
 * whole list above. The branch is retained because every consumer of the work
 * list shares the shape and defensively handles it; if a future unit kind
 * reintroduces per-unit resolution (e.g. an exec/shell unit with real
 * substitution), the failure plumbing is already in place.
 */
/**
 * Validate a fan-out item list BEFORE any identity/dispatch work: expansion
 * within the resource limit, no null/undefined items, no canonical duplicates.
 * Returns the failure message, or undefined when the list is dispatchable.
 *
 * Null items: producer garbage — there is nothing to hand the unit as its work
 * item. The pre-unification format rejected them incidentally (substituting
 * `${{ item }}` failed); with items attached as context instead of spliced,
 * nothing later would stop a unit from being dispatched with "Item: null", so
 * the rejection is explicit here. Duplicates: content-derived unit identity
 * makes canonical duplicates collide on id — an authoring error caught
 * deterministically, before dispatch.
 */
function validateFanOutItems(stepId: string, items: unknown[]): string | undefined {
  if (items.length > WORKFLOW_MAX_MAP_EXPANSION) {
    return `Step "${stepId}" fan-out expands to ${items.length} units, exceeding the ${WORKFLOW_MAX_MAP_EXPANSION}-unit resource limit.`;
  }
  const nullIndex = items.findIndex((item) => item === null || item === undefined);
  if (nullIndex !== -1) {
    return (
      `Step "${stepId}" fan-out list contains a null item (index ${nullIndex}). ` +
      `Every item must be a concrete value — fix the producing step's output.`
    );
  }
  const firstIndexByCanonical = new Map<string, number>();
  for (let i = 0; i < items.length; i++) {
    const canonical = canonicalJson(items[i]) ?? "null";
    const firstIndex = firstIndexByCanonical.get(canonical);
    if (firstIndex !== undefined) {
      return (
        `Step "${stepId}" fan-out list contains duplicate items (indices ${firstIndex} and ${i}: ` +
        `${clip(canonical, 200)}). Content-derived unit identity requires distinct items — ` +
        `deduplicate the list this workflow fans out over.`
      );
    }
    firstIndexByCanonical.set(canonical, i);
  }
  return undefined;
}

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

  // Instructions are ALWAYS the step's body prose, byte-exact — never
  // templated, never scanned for reference syntax (workflow-format-
  // unification, spec §2.3). Only `map.over` / `route.input` / `inputs[]`
  // carry the closed reference grammar.

  // Resolve the step's declared `inputs:` ONCE (shared by every unit in this
  // step — map items differ, declared inputs do not): prior-step artifacts
  // attached to every dispatched unit as structured context.
  const resolvedInputs: Array<{ reference: string; value: unknown }> = [];
  for (const reference of template.inputs ?? []) {
    const resolved = resolveReferenceString(reference, scope);
    if (!resolved.ok) {
      return {
        ok: false,
        error: `Step "${plan.stepId}" declared input "${reference}" failed to resolve: ${resolved.error.message}`,
      };
    }
    resolvedInputs.push({ reference, value: resolved.value });
  }

  // Resolve fan-out items: `over` is a single whole-value reference naming
  // its producer explicitly — no ambient key search.
  let items: unknown[];
  if (root.kind === "map") {
    const source = resolveReferenceString(root.over, scope);
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
  const fanOutProblem = isFanOut ? validateFanOutItems(plan.stepId, items) : undefined;
  if (fanOutProblem) return { ok: false, error: fanOutProblem };

  // Content-derived unit identity: compute every id up front (duplicate items
  // were rejected above — identity requires distinct items).
  const unitIds = items.map((item) => unitIdFor(template.id, item, isFanOut));

  const gateLoop = input.gateLoop ?? 1;
  const frozenInvocation = template.invocation;
  if (!frozenInvocation) return { ok: false, error: `Step "${plan.stepId}" has no frozen invocation.` };
  const frozenEngine = input.engines?.[frozenInvocation.engine];
  if (!frozenEngine) {
    return { ok: false, error: `Step "${plan.stepId}" references missing frozen engine "${frozenInvocation.engine}".` };
  }
  const runner: IrRuntimeKind = frozenEngine.kind === "llm" ? "llm" : frozenEngine.runnerKind;
  // Taken VERBATIM from the frozen plan — there is no engine-side backstop, by
  // design. The whole timeout decision happens once at freeze time
  // (`ir/freeze.ts` `effectiveTimeout`: unit `timeout:` → document
  // `defaults.timeout` → `engines.<name>.timeoutMs` → the engine-kind default,
  // `DEFAULT_LLM_TIMEOUT_MS` / `DEFAULT_AGENT_TIMEOUT_MS`). A frozen `null`
  // means genuinely unbounded and is honored as such: it is reached either by an
  // author writing `timeout: none` — an explicit, documented opt-out that a
  // silent cap here would break — or by `DEFAULT_AGENT_TIMEOUT_MS`, which is
  // itself `null` because agent harnesses own their own lifetime. The frozen IR
  // collapses both to `timeoutMs: null`, so this layer could not tell them apart
  // even if it wanted to; anything that should bound a unit belongs in
  // `effectiveTimeout`, not here.
  const timeoutMs = frozenInvocation.timeoutMs;

  const units: StepWorkUnit[] = items.map((item, index) => {
    const unitId = unitIds[index]!;
    // Gate loops (>= 2) journal under `<unitId>~l<loop>` so loop 1's rows are
    // never clobbered; the content-derived identity (and the prompt's
    // {{UNIT_ID}}) stays the base id.
    const journalBaseId = gateLoop > 1 ? `${unitId}~l${gateLoop}` : unitId;

    // Context attachment (workflow-format-unification, spec §4): every unit
    // receives the run params (already in the preamble), its item + index if
    // it is a map unit, and the artifacts named by its step's `inputs:`.
    // Instructions reach the unit byte-exact — never interpolated.
    const prompt = buildUnitPrompt({
      runId: input.runId,
      stepId: plan.stepId,
      unitId,
      params: input.params,
      ...(isFanOut ? { item, itemIndex: index } : {}),
      ...(resolvedInputs.length > 0 ? { inputs: resolvedInputs } : {}),
      ...(input.gateFeedback ? { gateFeedback: input.gateFeedback } : {}),
      ...(template.schema ? { schema: template.schema } : {}),
      instructions: template.instructions,
    });
    // Canonical dispatch-input envelope (reviewer finding #1). Every field
    // here is a PLAN-FROZEN input that changes what the backend is actually
    // asked to do, so a completed unit is reused ONLY when all of them match;
    // a change to any of them re-dispatches. Key order is FIXED — it is the
    // hash preimage (JSON.stringify preserves insertion order) — and this is
    // the ONE place a unit's inputHash is computed (every caller goes through
    // computeStepWorkList), so a hash that is byte-identical across a fresh
    // run and a resume is structural, not coincidental.
    //
    // Unit identity (workflow-format-unification, spec §2.3/§4) hashes the
    // FROZEN TEMPLATE BYTES (`template.instructions`, byte-exact, never an
    // instantiated/interpolated string) + the canonical item JSON + the
    // declared-input artifact hashes + the params snapshot — instead of a
    // resolved/spliced prompt string, since there is no more splicing. The
    // assembled `prompt` above is what the harness SEES; the hash is over the
    // plan-frozen INPUTS that determine it, which is the same replay contract
    // the old resolved-prompt hash gave (same inputs ⇒ same hash) with the
    // interpolation step removed.
    //
    // Included beyond the R4 baseline (template/runner/model/schema): resolved
    // timeoutMs, the env asset ref NAMES, and isolation — each reaches
    // dispatch (native-executor's UnitDispatchRequest) and a changed one
    // yields a materially different call. `env` carries NAMES ONLY, never
    // resolved values: hashing a resolved secret would leak it into a durable
    // hash oracle and would spuriously re-dispatch on every secret rotation.
    // `retry`/`onError` are DELIBERATELY excluded — they govern failed-unit
    // re-dispatch and step-level failure reduction, not a COMPLETED unit's
    // inputs/output, so a completed row stays valid across policy changes.
    //
    // `gateFeedback` IS included (conditionally, so a no-feedback unit's
    // preimage is byte-identical to before): it is appended to the prompt by
    // `buildUnitPrompt`, so a gate loop's retry is materially a different ask
    // than the rejected attempt — omitting it made loop 1 and loop 2 journal
    // identical hashes for different prompts, breaking the "changed inputs ⇒
    // changed hash" audit contract. Replay-safe: feedback is re-derived from
    // the journaled gate decision, so a resumed retry re-hashes identically.
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
          hashVersion: 4,
          template: template.instructions,
          item: isFanOut ? (item ?? null) : null,
          inputs: resolvedInputs,
          params: input.params,
          dispatch,
          invocation: frozenInvocation,
          schema: template.schema ?? null,
          env: template.env ?? null,
          isolation: template.isolation ?? "none",
          ...(input.gateFeedback ? { gateFeedback: input.gateFeedback } : {}),
        }),
      )
      .digest("hex");
    const resolved: StepWorkUnit["resolved"] = { ok: true, prompt, inputHash };

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
  /** Present for a map unit — the item it was given + its 0-based index. */
  item?: unknown;
  itemIndex?: number;
  /** Resolved artifacts named by the step's `inputs:`, in declaration order. */
  inputs?: Array<{ reference: string; value: unknown }>;
  gateFeedback?: GateFeedback;
  schema?: Record<string, unknown>;
  /** The step's body prose, byte-exact — never interpolated. */
  instructions: string;
}

/**
 * Assemble the final prompt: engine preamble (run params + item/index +
 * declared-input artifacts, all as structured JSON context) + the step's
 * BYTE-EXACT prose instructions (+ gate feedback on loop re-executions, +
 * schema directive). Instructions are NEVER interpolated (workflow-format-
 * unification, spec §2.3) — data reaches the unit as attached context, not
 * string splices; only the ENGINE's own preamble placeholders are substituted
 * here.
 */
export function buildUnitPrompt(input: BuildUnitPromptInput): string {
  const { runId, stepId, unitId, params, itemIndex, item, inputs, gateFeedback, schema, instructions } = input;
  // Function replacements throughout: a string replacement would interpret
  // GetSubstitution patterns ($&, $$, $', $`) inside VALUES and silently
  // corrupt the prompt (e.g. a param value containing "$&").
  const preamble = unitPreambleTemplate
    .replaceAll("{{RUN_ID}}", () => runId)
    .replaceAll("{{STEP_ID}}", () => stepId)
    .replaceAll("{{UNIT_ID}}", () => unitId)
    .replaceAll("{{PARAMS_JSON}}", () => safeJson(params));

  // Map-unit context: the item this unit was given, plus its index. Attached
  // as structured JSON — the engine never splices it into the instructions.
  const itemBlock =
    itemIndex !== undefined
      ? `\n\n## Item (index ${itemIndex})\nYou were given this item from the fan-out list:\n${safeJson(item)}`
      : "";

  // Declared `inputs:` context: the prior-step artifacts this step named.
  const inputsBlock =
    inputs && inputs.length > 0
      ? `\n\n## Declared inputs\n${inputs.map((i) => `### ${i.reference}\n${safeJson(i.value)}`).join("\n\n")}`
      : "";

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

  return `${preamble}\n${instructions}${itemBlock}${inputsBlock}${gateBlock}${schemaDirective}`;
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
 * The value a `steps.<id>.output` reference resolves to for ONE step, given that
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

export function buildEvidence(units: UnitOutcome[], reducer: IrMapReducer, isFanOut: boolean): Record<string, unknown> {
  // Per-unit evidence is the DURABLE projection of the unit graph — a fresh run
  // and a resumed run of the same plan must agree on it byte-for-byte. It
  // therefore carries ONLY fields that can be reproduced from the journal alone:
  //   - a SUCCESS keeps its promoted contribution (structured `result` or clipped
  //     `text`) — the reuse path rehydrates exactly these from the unit row;
  //   - a FAILURE keeps only its `failureReason` (the durable, journaled failure
  //     vocabulary). The in-memory dispatch diagnostic (`error`) and any residual
  //     `text` on a failed unit are NOT persisted here: they do not survive a
  //     restart, so persisting them on the live-dispatch path alone would make
  //     the durable graph depend on WHEN it was built. The full raw text/reason
  //     still lives on the unit row for diagnostics; this is the shared graph.
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

  // Promoted step artifact (`evidence.output`) — what a `steps.<id>.output`
  // reference resolves to (see projectStepOutput). Values are UNCLIPPED.
  if (reducer === "vote") {
    evidence.output = null;
  } else {
    evidence.output = isFanOut ? units.map(unitOutputValue) : unitOutputValue(units[0]!);
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
    } else if (ranked.length > 1 && ranked[0]!.count === ranked[1]!.count) {
      evidence.voteError = `Vote reducer tied at ${ranked[0]!.count} vote(s) — no majority.`;
    } else {
      evidence.vote = { winner: ranked[0]!.value, votes: ranked[0]!.count, total: units.length };
      evidence.output = ranked[0]!.value;
    }
  }

  return evidence;
}

/**
 * The reduced outcome of a step's executed units — the shared post-dispatch
 * decision. `executeStepPlan` feeds its {@link UnitOutcome}[] through
 * {@link reduceStepOutcomes} to produce this, whether the outcomes came from a
 * live dispatch or were rehydrated from journaled rows on resume, so the same
 * frozen plan always promotes the SAME artifact, applies the SAME `on_error`
 * policy, and validates against the SAME output schema. The
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
  reducer: IrMapReducer,
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
 * Used by native dispatch (`executeStepPlan`'s `items.length === 0` branch): a
 * zero-unit step can never be advanced by a unit completion, so it is promoted
 * here instead. Deliberately does NOT run the reducer/vote-tie logic: an empty
 * step has no successful results to count, and a vote-tie "failure" would
 * diverge from the engine's long-standing empty-list semantics.
 */
export function reduceEmptyStep(plan: IrStepPlan, reducer: IrMapReducer): ExecutedStepOutcome {
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
 * Rehydrate a journaled unit row into a {@link UnitOutcome}. The executor's
 * durable-row reuse (`native-executor.ts`) calls it for completed rows; the
 * failed-row branch keeps the mapping TOTAL, so any reduction driven off the
 * journal yields the same outcome the live dispatch produced. A completed row's
 * text unit journals its output as a JSON string; a schema unit journals the
 * validated structure. A failed row carries its `failure_reason`; any journaled
 * text is surfaced too.
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
// A resume recovers it from the journal so its loop-N work-list (and therefore
// every unit id and input hash in it) matches the one the original run built.
// `native-executor.test.ts` asserts the round-trip identity.

// GATE_EVALUATION_PHASE moved to ../runtime/unit-phases.ts (leaf) so
// unit-checkin can key on it without closing the exec ↔ runtime cycle.

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
  /** NULL result_json: an in-flight row or a completion error before a verdict was recorded. */
  | { kind: "empty" };

/**
 * Classify a gate-evaluation row's journaled verdict, failing LOUDLY on a
 * corrupt one (reviewer #17). A NULL `result_json` is the LEGITIMATE
 * completion-error / in-flight shape (`journalGateEvaluationFinish` writes null
 * if completion itself throws after judge invocation, and a `running` row has no
 * verdict yet) and classifies as `empty`. But a PRESENT `result_json` that does
 * not parse as JSON, or parses to
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
// An engine-driven completion-criteria judge call is journaled like a unit.
// journaled like a unit: node_id `<stepId>.gate`, unit_id `<stepId>.gate:l<loop>`,
// runner = its frozen runtime kind, result_json = the verdict. Rows are observability + audit; they
// are never REUSED. Events carry ids/status only.

export interface GateUnitRef {
  runId: string;
  workflowRef: string;
  stepId: string;
  /** Gate-loop attempt, 1-based. */
  loop: number;
  invocation: IrInvocation;
  runner: IrRuntimeKind;
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
        runner: gate.runner,
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
 * feedback }`; a pass journals `{ complete: true, missing: [] }`. An ERRORED
 * evaluation (thrown judge, malformed verdict, completion failure after the
 * judge ran) journals a failed row with NO verdict (`result_json` NULL) —
 * `errored` takes precedence over any synthesized fail-closed rejection, so
 * `activeGateLoop`/`recoverGateFeedback` never mistake a judge outage for an
 * honest rejection and burn a gate loop on resume.
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
 * Resolve a route's input (a single whole-value reference string — `params.x` or
 * `steps.<id>.output…`, with no `${{ }}` delimiters) and pick the branch. No
 * ambient key search. Only primitive values route; the comparison is exact
 * string equality against the declared `when:` matches.
 */
export function evaluateRoute(route: IrRouteSpec, scope: ExpressionScope): RouteDecision {
  const resolved = resolveReferenceString(route.input, scope);
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
          `branch was selected. The run journal is inconsistent; abandon this run and start a new one.`,
      );
    }
    applyRouteDecision(stepPlan.route, stepPlan.stepId, selected, routeSelected, routeUnselected);
  }
}

// ── Step finalization (IO) — the shared completion path ──────────────────────
//
// ONE implementation of "given a step's executed outcome at a gate loop,
// evaluate the route, judge the completion gate, and advance (or not) the
// spine." Every step completion goes through it — first pass or resume — so
// route evaluation, artifact-judged gates, gate-row journaling, and the
// bounded-loop rejection contract have exactly one definition. The
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
  /** Cooperative run cancellation checked before completion is committed. */
  signal?: AbortSignal;
  /** Engine run-lease holder (engine path only); absent on the manual/report path. */
  leaseHolder?: string;
}

export type FinalizeStepResult =
  | { kind: "advanced"; summaryOverride?: string }
  | { kind: "failed"; summary: string; routeFailure?: true }
  | { kind: "retry"; gateFeedback: GateFeedback }
  | { kind: "gate-exhausted"; gateRejection: { stepId: string; missing: string[]; feedback: string } }
  /**
   * Verifier INFRASTRUCTURE failure — a missing judge, a thrown judge call, or
   * a malformed verdict — as opposed to an honest negative verdict. The step
   * was completed `blocked` (run derives `blocked`), NO gate loop was
   * consumed, and `akm workflow resume` re-evaluates the gate against the
   * journaled units without re-dispatching them.
   */
  | { kind: "judge-failed"; summary: string };

/**
 * The blocked-step notes for a verifier-infrastructure failure (bug: judge
 * outage must not burn the gate budget). Shared by every judge-failure path —
 * missing judge, unresolvable frozen judge, thrown judge call, malformed
 * verdict — so the resume instruction is worded once.
 */
export function judgeFailureNotes(runId: string, stepId: string, cause: string): string {
  return (
    `Step "${stepId}" could not be verified: ${cause}. ` +
    `This is a verification-judge failure, not a verdict — no gate loop was consumed and the step's ` +
    `journaled units are preserved. Fix the verifier configuration or service, then run ` +
    `\`akm workflow resume ${runId}\` to re-evaluate the gate against the existing results ` +
    `without re-dispatching units.`
  );
}

/** Complete the step `blocked` for a judge-infrastructure failure and surface it. */
async function blockStepForJudgeFailure(input: FinalizeStepInput, cause: string): Promise<FinalizeStepResult> {
  const notes = judgeFailureNotes(input.runId, input.stepId, cause);
  await completeWorkflowStep({
    runId: input.runId,
    stepId: input.stepId,
    status: "blocked",
    notes,
    evidence: input.result.evidence,
    ...(input.leaseHolder !== undefined ? { leaseHolder: input.leaseHolder } : {}),
  });
  return { kind: "judge-failed", summary: notes };
}

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
 *    returns `advanced`;
 *  - a judge INFRASTRUCTURE failure (missing judge, thrown judge call, or a
 *    malformed verdict) is NOT a verdict: it consumes no gate loop and blocks
 *    the step for `akm workflow resume` (`judge-failed`) instead of feeding
 *    the bounded loop's re-dispatch.
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

  // A criteria-bearing step with NO judge cannot be verified at all — that is
  // verifier infrastructure failure, never a silent bypass and never an honest
  // rejection: block for resume without invoking the gate (no loop consumed).
  if (completionCriteria.some((c) => c.trim().length > 0) && !innerJudge) {
    return blockStepForJudgeFailure(
      input,
      "this step declares completion criteria but no verification judge is available " +
        "(the frozen plan resolves no judge — set workflow.judgeEngine, or restore the judge configuration)",
    );
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

  // Journal engine-driven judge calls as unit rows. With no criteria there is
  // no judge invocation or row; a criteria-bearing plan without a judge is a
  // configuration error rather than a silent bypass.
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
  // `failure` classifies a verifier INFRASTRUCTURE failure observed during the
  // judge call — a throw (transport/service error) or a response that is not a
  // well-formed verdict (same parser as validateStepSummary, so the fail-closed
  // rejection it synthesizes is recognizably NOT an honest verdict here).
  const judgeState: { invoked: boolean; failure?: string } = { invoked: false };
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
            runner: frozenGate?.engine?.kind === "agent" ? frozenGate.engine.runnerKind : ("llm" as const),
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
        let raw: string;
        try {
          raw = await innerJudge(prompt);
        } catch (err) {
          const detail = err instanceof Error && err.message ? ` (${err.message})` : "";
          judgeState.failure = `the verification judge failed${detail}`;
          throw err;
        }
        if (parseJudgeVerdict(raw) === undefined) {
          judgeState.failure =
            "the verification judge responded with a malformed verdict instead of the required JSON result";
        }
        return raw;
      }
    : null;

  // Reviewer #6: once the judge is invoked, its gate row is journaled `running`
  // (journalGateEvaluationStart) and MUST be finished on every exit. The
  // already-fixed window is the judge itself throwing (caught inside
  // validateStepSummary — `judgeState.failure` records it). The remaining
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
      ...(input.signal ? { signal: input.signal } : {}),
      ...lease,
    });
  } catch (err) {
    if (gateUnit) await journalGateEvaluationFinish(gateUnit, true, undefined);
    throw err;
  }
  const rejection =
    "ok" in completion && completion.ok === false ? (completion as SummaryValidationFailure) : undefined;
  const judgeFailed = judgeState.failure !== undefined;

  if (gateUnit) {
    // An infrastructure failure journals an ERRORED gate row (no verdict) —
    // never the synthesized fail-closed rejection, which would read as an
    // honest rejection to activeGateLoop/recoverGateFeedback on resume.
    await journalGateEvaluationFinish(gateUnit, judgeFailed, rejection);
  }

  // Judge infrastructure failure: the fail-closed rejection is synthetic, not a
  // verdict. Consume NO gate loop; block the step (and therefore the run) so
  // `akm workflow resume` retries the gate over the journaled units.
  if (rejection && judgeFailed) {
    return blockStepForJudgeFailure(input, judgeState.failure ?? "the verification judge failed");
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
