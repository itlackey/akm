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
import { computePlanHash } from "../ir/plan-hash";
import type {
  IrAgentNode,
  IrIsolation,
  IrMapReducer,
  IrOnError,
  IrRetry,
  IrRouteSpec,
  IrRunnerKind,
  IrStepPlan,
  WorkflowPlanGraph,
} from "../ir/schema";
import {
  type ExpressionScope,
  parseTemplate,
  resolveTemplate,
  resolveWholeValue,
  type TemplateSegment,
} from "../program/expressions";
import type { SummaryValidationFailure, WorkflowNextResult } from "../runtime/runs";
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
  runner: IrRunnerKind;
  profile?: string;
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
  template: IrAgentNode;
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

  // Content-derived unit identity: compute every id up front. Duplicate items
  // collide on identity — an authoring error caught HERE, deterministically.
  const isFanOut = root.kind === "map";
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
  const timeoutMs = template.timeoutMs === undefined ? DEFAULT_UNIT_TIMEOUT_MS : template.timeoutMs;

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
      resolved = { ok: true, prompt, inputHash };
    }

    return {
      unitId,
      nodeId: template.id,
      index,
      item,
      isFanOut,
      journalBaseId,
      runner: template.runner,
      ...(template.profile ? { profile: template.profile } : {}),
      ...(template.model ? { model: template.model } : {}),
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
 * `phase` marker stamped on gate-evaluation unit rows. Node ids may legally
 * contain dots (a step could be NAMED `x.gate`), so the phase column — not a
 * `node_id` suffix match — is the unambiguous discriminator. Dispatch rows
 * always journal `phase: null`.
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
 */
export function activeGateLoop(rows: WorkflowRunUnitRow[], stepId: string): number {
  let maxRejectedLoop = 0;
  for (const row of rows) {
    if (row.phase !== GATE_EVALUATION_PHASE || row.step_id !== stepId) continue;
    const loop = gateLoopOf(row.unit_id, stepId);
    if (loop === undefined) continue;
    if (gateRowRejected(row) && loop > maxRejectedLoop) maxRejectedLoop = loop;
  }
  return maxRejectedLoop + 1;
}

/**
 * Recover the gate feedback the engine threads into `loop`'s unit prompts: the
 * `{ feedback, missing }` journaled by the previous loop's rejection
 * (`<stepId>.gate:l<loop-1>`). Loop 1 (or a missing/passed previous row) has
 * no feedback. Pure — the journal rows are passed in.
 */
export function recoverGateFeedback(
  rows: WorkflowRunUnitRow[],
  stepId: string,
  loop: number,
): GateFeedback | undefined {
  if (loop <= 1) return undefined;
  const prevId = gateUnitId(stepId, loop - 1);
  const prev = rows.find((r) => r.unit_id === prevId && r.phase === GATE_EVALUATION_PHASE);
  if (!prev || prev.result_json === null) return undefined;
  let verdict: unknown;
  try {
    verdict = JSON.parse(prev.result_json);
  } catch {
    return undefined;
  }
  if (typeof verdict !== "object" || verdict === null) return undefined;
  const v = verdict as Record<string, unknown>;
  if (v.complete !== false) return undefined;
  const feedback = typeof v.feedback === "string" ? v.feedback : "";
  const missing = Array.isArray(v.missing) ? v.missing.filter((m): m is string => typeof m === "string") : [];
  return { feedback, missing };
}

/** The 1-based loop encoded in a `<stepId>.gate:l<n>` unit id, if well-formed. */
function gateLoopOf(unitId: string, stepId: string): number | undefined {
  const prefix = `${stepId}.gate:l`;
  if (!unitId.startsWith(prefix)) return undefined;
  const n = Number.parseInt(unitId.slice(prefix.length), 10);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** True when a gate-evaluation row journaled a rejection (`complete: false`). */
function gateRowRejected(row: WorkflowRunUnitRow): boolean {
  if (row.result_json === null) return false;
  try {
    const v = JSON.parse(row.result_json) as Record<string, unknown>;
    return v.complete === false;
  } catch {
    return false;
  }
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
        model: null,
        inputHash: null,
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
 * threw journals a failed row (the gate then failed open inside
 * `validateStepSummary`).
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
  let plan: WorkflowPlanGraph;
  try {
    plan = JSON.parse(planJson) as WorkflowPlanGraph;
  } catch {
    throw new UsageError(
      `Workflow run ${runId} has a corrupt frozen plan (plan_json is not valid JSON). ` +
        `The journaled plan cannot be executed — start a new run.`,
    );
  }
  if (computePlanHash(plan) !== planHash) {
    throw new UsageError(
      `Workflow run ${runId} failed the frozen-plan integrity check: plan_json does not match plan_hash. ` +
        `The journaled plan was modified after the run started — refusing to execute it. Start a new run.`,
    );
  }
  return plan;
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
