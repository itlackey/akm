// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared step semantics: the one implementation of a step's orchestration
 * decisions, used by the engine on both a fresh run and a resume, so the same
 * frozen plan produces byte-identical unit graphs. Pure except the
 * gate-evaluation journaling; never dispatches and never writes step rows.
 * See docs/architecture/decisions/0002-unit-reuse-and-input-hash-scope.md.
 */

import { createHash } from "node:crypto";
import unitPreambleTemplate from "../../assets/prompts/workflow-unit-preamble.md" with { type: "text" };
import { UsageError } from "../../core/errors";
import { validateJsonSchemaSubset } from "../../core/json-schema";
import { parseEmbeddedJsonResponse } from "../../core/parse";
import { canonicalInputJson, type TaskInputBinding, validateInputs } from "../../execution/input-contract";
import type { LoweringNotice } from "../../execution/resolved-request";
import type { WorkflowRunStatus } from "../../sources/types";
import {
  type WorkflowRunUnitAttemptRowV4,
  type WorkflowRunUnitRow,
  withWorkflowRunsRepo,
} from "../../storage/repositories/workflow-runs-repository";
import { canonicalJson } from "../ir/plan-hash";
import type {
  FrozenWorkflowTarget,
  WorkflowIsolation,
  WorkflowOnError,
  WorkflowPlan,
  WorkflowPlanStep,
  WorkflowReducer,
  WorkflowRetry,
  WorkflowRoute,
  WorkflowRuntimeKind,
  WorkflowUnitNode,
} from "../plan";
import {
  type ExpressionScope,
  parseReference,
  type ResolveReferenceResult,
  resolveReferenceString,
} from "../program/expressions";
import { clip, WORKFLOW_UNIT_DIAGNOSTIC_CLIP } from "../resource-limits";
import { completeWorkflowStep, type SummaryValidationFailure, type WorkflowNextResult } from "../runtime/runs";
import { type JudgeCallIdentity, parseJudgeVerdict, type SummaryJudge } from "../validate-summary";
import { gateNodeId } from "./frozen-judge";
import { enqueueUnitWrite } from "./unit-writer";

/** How much raw unit output is retained in step evidence (full text lives on the unit row). */
const EVIDENCE_TEXT_CLIP = 2_000;

/** How much artifact JSON the completion-criteria judge receives. */
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
  /** Live lowering diagnostics; the current contract intentionally excludes them from durable result_json/evidence. */
  notices?: readonly Readonly<LoweringNotice>[];
  /**
   * Harness-native session id revealed during dispatch (last one wins across
   * structured-output retries). Persisted by `finishUnitAttempt`.
   */
  sessionId?: string;
  /** Live-only child-run identity for a child-workflow unit; never part of evidence (like {@link notices}). */
  childRun?: {
    runId: string;
    ref: string;
    status: WorkflowRunStatus;
    currentStepId: string | null;
  };
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
 * One unit's fully-resolved dispatch plan. `unitId`/`nodeId`/`item` are
 * content-derived; `resolved` carries the assembled prompt + input hash.
 * Resolution cannot fail per-unit: everything that CAN fail (map.over /
 * route.input / inputs:) resolves once per step and fails the WHOLE list
 * ({@link ComputeWorkListResult}).
 */
export interface StepWorkUnit {
  /** Content-derived base id: `<node_id>:<sha256>` (fan-out) / `<node_id>:solo`. */
  unitId: string;
  nodeId: string;
  index: number;
  /** The fan-out item (undefined for a solo unit). */
  item: unknown;
  isFanOut: boolean;
  /** Journal id root for attempt 0 (`<unitId>` or `<unitId>~l<loop>` in a gate loop). */
  journalBaseId: string;
  runner: WorkflowRuntimeKind;
  /** The sole normalized execution target. */
  frozenTarget: FrozenWorkflowTarget;
  /** Frozen named environment bindings materialized only at dispatch. */
  environment: WorkflowUnitNode["environment"];
  /**
   * `AKM_*` context environment for an exec unit's child (run/step/unit ids,
   * params, fan-out item + index, declared inputs) — the argv-array analogue of
   * the prompt context blocks an engine unit receives. Set on exactly the exec
   * units; see {@link buildExecContextEnv}.
   */
  execContext?: Record<string, string>;
  model?: string;
  /** Resolved timeout (unit override else engine default); null = no timeout. */
  timeoutMs: number | null;
  schema?: Record<string, unknown>;
  retry?: WorkflowRetry;
  onError: WorkflowOnError;
  isolation?: WorkflowIsolation;
  /** The unit's rendered instructions, built once by the work-list builder. */
  prompt: string;
  /** Canonical hash of this unit's frozen inputs — the durable-reuse identity. */
  inputHash: string;
  /** A child-workflow unit's resolved `with:` bindings: the child run's params. Absent, never `{}`, when empty. */
  childParams?: Readonly<Record<string, unknown>>;
}

export interface StepWorkList {
  template: WorkflowUnitNode;
  reducer: WorkflowReducer;
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
 * Validate a fan-out item list before any identity/dispatch work: no
 * null/undefined items (there would be nothing to hand the unit) and no
 * canonical duplicates (content-derived unit ids would collide). Returns the
 * failure message, or undefined when the list is dispatchable.
 */
function validateFanOutItems(stepId: string, items: unknown[]): string | undefined {
  const nullIndex = items.findIndex((item) => item === null || item === undefined);
  if (nullIndex !== -1) {
    return (
      `Step "${stepId}" fan-out list contains a null item (index ${nullIndex}). ` +
      `Every item must be a concrete value — fix the producing step's output.`
    );
  }
  return undefined;
}

/**
 * Unit ids for a fan-out list: the first occurrence of a canonical value keeps
 * {@link unitIdFor}'s id; later occurrences gain `#2`, `#3`, … by position, so
 * a fresh run and a resume derive the same ids.
 */
function occurrenceSuffixedUnitIds(nodeId: string, items: readonly unknown[]): string[] {
  const occurrenceByCanonical = new Map<string, number>();
  return items.map((item) => {
    const base = unitIdFor(nodeId, item, true, true);
    const canonical = canonicalJson(item) ?? "null";
    const occurrence = (occurrenceByCanonical.get(canonical) ?? 0) + 1;
    occurrenceByCanonical.set(canonical, occurrence);
    return occurrence === 1 ? base : `${base}#${occurrence}`;
  });
}

/** Resolve one whole-value reference (`inputs[]`, `map.over`, `route.input`, a binding's `from`). */
function resolveStepReference(reference: string, scope: ExpressionScope): ResolveReferenceResult {
  return resolveReferenceString(reference, scope);
}

/** The whole-step failure shape `computeStepWorkList` returns — one field, so a resolver's own failure IS this shape. */
type TaskInputBindingsResolution =
  | { ok: true; values: Readonly<Record<string, unknown>> }
  | { ok: false; error: string };

/**
 * Resolve a composing step's frozen `inputBindings` before any attempt: a
 * literal passes through (checked at freeze); a reference resolves like every
 * other whole-value position and is validated against its frozen schema. A
 * failure fails the whole step. No bindings resolve to `{}`.
 */
function resolveTaskInputBindings(
  bindings: readonly TaskInputBinding[] | undefined,
  stepId: string,
  scope: ExpressionScope,
): TaskInputBindingsResolution {
  if (!bindings || bindings.length === 0) return { ok: true, values: {} };
  const values: Record<string, unknown> = {};
  for (const binding of bindings) {
    if (binding.kind === "literal") {
      values[binding.name] = binding.value;
      continue;
    }
    const resolved = resolveStepReference(binding.from, scope);
    if (!resolved.ok) {
      return {
        ok: false,
        error:
          `Step "${stepId}" input "${binding.name}" reference ${binding.from} failed to resolve: ` +
          resolved.error.message,
      };
    }
    const errors = validateInputs(
      { [binding.name]: { schema: binding.schema, required: false } },
      { [binding.name]: resolved.value },
      // Fixed neutral namespace (matches `checkScheduleEntryRunnable`'s
      // `pathRoot: "inputs"` and the `contractViolation` diagnostics' own
      // `$`-strip) — NOT `binding.name`, which would double the input name
      // (`count.count: ...`) since the outer message below already names it.
      { pathRoot: "inputs" },
    );
    if (errors.length > 0) {
      return {
        ok: false,
        error:
          `Step "${stepId}" input "${binding.name}" reference ${binding.from} resolved to a value violating its ` +
          `declared schema: ${errors.join("; ")}`,
      };
    }
    values[binding.name] = resolved.value;
  }
  return { ok: true, values };
}

/**
 * Compute a step's work list purely from the frozen plan and its inputs:
 * resolve the fan-out list, derive content-derived unit ids, assemble each
 * unit's prompt, and hash its input. Same inputs give byte-identical
 * ids/hashes/prompts — what resume relies on to recognize journaled units.
 * Every reference resolves once per step, so failures fail the whole list.
 */
export function computeStepWorkList(plan: WorkflowPlanStep, input: WorkListInput): ComputeWorkListResult {
  const root = plan.root;
  // Route-only steps (YAML `route:`) carry no execution subgraph.
  if (!root) {
    return {
      ok: false,
      error: `Step "${plan.stepId}" has no execution subgraph (a route-only step); the native executor cannot dispatch it.`,
    };
  }

  const template = root.kind === "map" ? root.template : root;
  const reducer: WorkflowReducer = root.kind === "map" ? root.reducer : "collect";

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
    const resolved = resolveStepReference(reference, scope);
    if (!resolved.ok) {
      return {
        ok: false,
        error: `Step "${plan.stepId}" declared input "${reference}" failed to resolve: ${resolved.error.message}`,
      };
    }
    resolvedInputs.push({ reference, value: resolved.value });
  }

  // A composing step's frozen `inputBindings`, resolved against this scope for every target kind.
  const taskInputsResolution = resolveTaskInputBindings(template.frozenTarget.inputBindings, plan.stepId, scope);
  if (!taskInputsResolution.ok) return taskInputsResolution;
  const hasTaskInputs = Object.keys(taskInputsResolution.values).length > 0;

  // Resolve fan-out items: `over` is a single whole-value reference naming
  // its producer explicitly — no ambient key search.
  let items: unknown[];
  if (root.kind === "map") {
    const source = resolveStepReference(root.over, scope);
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

  // Content-derived unit identity: compute every id up front. A fan-out's
  // canonical duplicates are disambiguated by occurrence ordinal rather than
  // rejected (issue 6); a solo (non-fan-out) step has exactly one item, so
  // there is nothing to disambiguate.
  const unitIds = isFanOut
    ? occurrenceSuffixedUnitIds(template.id, items)
    : [unitIdFor(template.id, undefined, false, true)];

  const gateLoop = input.gateLoop ?? 1;
  const target = template.frozenTarget;
  const frozenExec = target.kind === "shell" || target.kind === "script" ? target.exec : undefined;
  const runner: WorkflowRuntimeKind = target.kind === "command" ? target.runner.kind : "exec";
  // Taken verbatim from the frozen plan, resolved once at freeze (an exec
  // unit's on its exec spec). A frozen `null` means genuinely unbounded
  // (`timeout: none`, or an agent harness that owns its own lifetime).
  const timeoutMs =
    target.kind === "command"
      ? (target.runner.timeoutMs ?? null)
      : target.kind === "child-workflow"
        ? // A child-workflow target carries no exec spec of its own.
          // A child-workflow unit is driven by child-workflow.ts, never by this value.
          null
        : target.exec.timeoutMs;

  // Step-constant exec context: `AKM_PARAMS` / `AKM_INPUTS` depend only on
  // step-level values, so they are serialized ONCE here and shared by every
  // unit. Building them inside the per-unit loop deep-cloned and re-stringified
  // identical data per unit, and retained one distinct copy per unit until the
  // step reduced.
  const execParamsJson = frozenExec ? (canonicalJson(input.params) ?? "{}") : undefined;
  const execInputsJson =
    frozenExec && resolvedInputs.length > 0
      ? (canonicalJson(Object.fromEntries(resolvedInputs.map((entry) => [entry.reference, entry.value]))) ?? "{}")
      : undefined;
  // P2b Lane A2: the resolved effective task-composition inputs,
  // serialized ONCE here (mirrors execParamsJson/execInputsJson above) —
  // Lane B's delivery (buildUnitPrompt's "## Task inputs" block,
  // buildExecContextEnv's AKM_TASK_INPUTS) reads both back per unit.
  const taskInputsJson = hasTaskInputs ? (canonicalJson(taskInputsResolution.values) ?? "{}") : undefined;

  const ctx: StepWorkUnitContext = {
    plan,
    input,
    template,
    isFanOut,
    gateLoop,
    resolvedInputs,
    runner,
    timeoutMs,
    target,
    ...(frozenExec ? { frozenExec } : {}),
    ...(execParamsJson !== undefined ? { execParamsJson } : {}),
    ...(execInputsJson !== undefined ? { execInputsJson } : {}),
    ...(hasTaskInputs ? { taskInputs: taskInputsResolution.values, taskInputsJson } : {}),
  };
  const units: StepWorkUnit[] = items.map((item, index) => buildStepWorkUnit(ctx, unitIds[index]!, item, index));

  const concurrency = root.kind === "map" ? root.concurrency : 1;
  return {
    ok: true,
    list: { template, reducer, isFanOut, ...(concurrency !== undefined ? { concurrency } : {}), items, units },
  };
}

/** Everything {@link buildStepWorkUnit} needs, resolved ONCE per step. */
interface StepWorkUnitContext {
  plan: WorkflowPlanStep;
  input: WorkListInput;
  template: WorkflowUnitNode;
  isFanOut: boolean;
  gateLoop: number;
  resolvedInputs: Array<{ reference: string; value: unknown }>;
  runner: WorkflowRuntimeKind;
  timeoutMs: number | null;
  target: FrozenWorkflowTarget;
  frozenExec?: Extract<FrozenWorkflowTarget, { kind: "shell" | "script" }>["exec"];
  /** Step-constant `AKM_PARAMS` / `AKM_INPUTS` payloads, serialized once (exec steps only). */
  execParamsJson?: string;
  execInputsJson?: string;
  /**
   * The composed target's resolved `inputBindings`: `taskInputs` feeds the
   * prompt's `## Task inputs` block, `taskInputsJson` feeds `AKM_TASK_INPUTS`.
   * Both absent when nothing is bound.
   */
  taskInputs?: Readonly<Record<string, unknown>>;
  taskInputsJson?: string;
}

/** Build one unit of the step's work list: journal id, prompt, exec context env, and input hash. */
function buildStepWorkUnit(ctx: StepWorkUnitContext, unitId: string, item: unknown, index: number): StepWorkUnit {
  const { plan, input, template, isFanOut, resolvedInputs, target, frozenExec, taskInputs } = ctx;
  // Gate loops (>= 2) journal under `<unitId>~l<loop>` so loop 1's rows are
  // never clobbered; the content-derived identity (and the prompt's
  // {{UNIT_ID}}) stays the base id.
  const journalBaseId = ctx.gateLoop > 1 ? `${unitId}~l${ctx.gateLoop}` : unitId;

  // Every unit receives the run params, its item + index if it is a map unit,
  // and its step's `inputs:` artifacts as attached context; instructions are
  // never interpolated. An exec unit gets no prompt: its context reaches the
  // child as environment ({@link buildExecContextEnv}), never spliced into argv.
  const prompt = frozenExec
    ? ""
    : buildUnitPrompt({
        runId: input.runId,
        stepId: plan.stepId,
        unitId,
        params: input.params,
        ...(isFanOut ? { item, itemIndex: index } : {}),
        ...(resolvedInputs.length > 0 ? { inputs: resolvedInputs } : {}),
        // P2b Lane B: the composed task's resolved
        // `inputBindings`, when non-empty — see StepWorkUnitContext.taskInputs.
        ...(taskInputs && Object.keys(taskInputs).length > 0 ? { taskInputs } : {}),
        ...(input.gateFeedback ? { gateFeedback: input.gateFeedback } : {}),
        ...(template.schema ? { schema: template.schema } : {}),
        instructions: template.instructions,
      });
  const inputHash = computeUnitInputHash(ctx, item);

  return {
    unitId,
    nodeId: template.id,
    index,
    item,
    isFanOut,
    journalBaseId,
    runner: ctx.runner,
    frozenTarget: target,
    environment: template.environment,
    ...(frozenExec ? { execContext: buildExecContextEnv({ ctx, unitId, item, index }) } : {}),
    ...(target.kind === "command" && target.request.model?.resolved ? { model: target.request.model.resolved } : {}),
    timeoutMs: ctx.timeoutMs,
    ...(template.schema ? { schema: template.schema } : {}),
    ...(template.retry ? { retry: template.retry } : {}),
    onError: template.onError,
    ...(template.isolation ? { isolation: template.isolation } : {}),
    // the SAME resolved `with:` bindings `taskInputs` already
    // carries, exposed under the name `child-workflow.ts`'s drive contract
    // reads. Absent (never `{}`) when the step binds nothing.
    ...(taskInputs && Object.keys(taskInputs).length > 0 ? { childParams: taskInputs } : {}),
    prompt,
    inputHash,
  };
}

/**
 * The `AKM_*` context environment an exec unit's child receives: how a fan-out
 * item, the run params, and the step's `inputs:` artifacts reach a frozen argv
 * (as canonical JSON). Applied over the resolved `env:` bindings so a binding
 * cannot shadow it. Size is checked at the spawn boundary
 * (`checkExecContextSize`, exec-unit.ts), where an E2BIG can be reported by name.
 */
function buildExecContextEnv(args: {
  ctx: StepWorkUnitContext;
  unitId: string;
  item: unknown;
  index: number;
}): Record<string, string> {
  const { ctx, unitId, item, index } = args;
  // The step-constant payloads were serialized once by `computeStepWorkList`;
  // only the item and the ids vary per unit.
  const env: Record<string, string> = {
    AKM_RUN_ID: ctx.input.runId,
    AKM_STEP_ID: ctx.plan.stepId,
    AKM_UNIT_ID: unitId,
    AKM_PARAMS: ctx.execParamsJson ?? "{}",
  };
  if (ctx.isFanOut) {
    env.AKM_ITEM = canonicalJson(item) ?? "null";
    env.AKM_ITEM_INDEX = String(index);
  }
  if (ctx.execInputsJson !== undefined) env.AKM_INPUTS = ctx.execInputsJson;
  // One variable carrying the resolved `inputBindings` as canonical JSON; absent when nothing is bound.
  if (ctx.taskInputsJson !== undefined) env.AKM_TASK_INPUTS = ctx.taskInputsJson;
  return env;
}

/**
 * The unit's `input_hash`: every input that changes what the backend is asked
 * to do (names, never secret values). Informational — resume reuses a
 * completed row by unit id. `gateFeedback`/`taskInputs` are included only when
 * present so the loop-1, binding-free preimage keeps its `hashVersion` 7 shape.
 * See docs/architecture/decisions/0002-unit-reuse-and-input-hash-scope.md.
 */
function computeUnitInputHash(ctx: StepWorkUnitContext, item: unknown): string {
  return createHash("sha256")
    .update("akm.workflow.unit\0v7\0")
    .update(
      canonicalJson({
        hashVersion: 7,
        role: "unit",
        stepId: ctx.plan.stepId,
        nodeId: ctx.template.id,
        template: ctx.template.instructions,
        item: ctx.isFanOut ? (item ?? null) : null,
        inputs: ctx.resolvedInputs,
        params: ctx.input.params,
        frozenTarget: ctx.target,
        environment: ctx.template.environment,
        schema: ctx.template.schema ?? null,
        isolation: ctx.template.isolation ?? "none",
        ...(ctx.taskInputs !== undefined ? { taskInputs: ctx.taskInputs } : {}),
        ...(ctx.input.gateFeedback ? { gateFeedback: ctx.input.gateFeedback } : {}),
      }),
    )
    .digest("hex");
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
  /**
   * P2b Lane B: the composed task's effective
   * `inputBindings`, resolved. Renders as the `## Task inputs` fenced JSON
   * block, appended after `inputs` and before `gateFeedback`. Absent (or
   * empty) renders nothing — byte-identical to today's prompt shape.
   */
  taskInputs?: Readonly<Record<string, unknown>>;
  gateFeedback?: GateFeedback;
  schema?: Record<string, unknown>;
  /** The step's body prose, byte-exact — never interpolated. */
  instructions: string;
}

/**
 * Assemble the final prompt: the engine preamble (params, item/index, input
 * artifacts as JSON context) + the step's byte-exact instructions (+ gate
 * feedback on a loop, + schema directive). Only the preamble's own
 * placeholders are substituted.
 */
export function buildUnitPrompt(input: BuildUnitPromptInput): string {
  const { runId, stepId, unitId, params, itemIndex, item, inputs, taskInputs, gateFeedback, schema, instructions } =
    input;
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

  // The resolved `inputBindings` as a fenced JSON block, serialized exactly like AKM_TASK_INPUTS.
  const taskInputsBlock =
    taskInputs && Object.keys(taskInputs).length > 0
      ? `\n\n## Task inputs\nThe composed task's declared inputs resolved to:\n\`\`\`json\n${canonicalInputJson(taskInputs)}\n\`\`\``
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

  return `${preamble}\n${instructions}${itemBlock}${inputsBlock}${taskInputsBlock}${gateBlock}${schemaDirective}`;
}

/**
 * Content-derived unit identity (module doc): `<node_id>:<sha256>` for a
 * fan-out item, `<node_id>:solo` otherwise. The hash is over the item's
 * canonical JSON (sorted keys — same canonicalization the vote reducer
 * counts with), so identity survives list reordering/regeneration and is
 * independent of item position. Retry attempts stack `~r<n>` on top.
 */
export function unitIdFor(nodeId: string, item: unknown, isFanOut: boolean, collisionSafe = false): string {
  if (!isFanOut) return `${nodeId}:solo`;
  const canonical = canonicalJson(item) ?? "null";
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `${nodeId}:${collisionSafe ? digest : digest.slice(0, 12)}`;
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

/** The step's dispatch template — the map template for a fan-out, else the root unit. */
function stepTemplate(stepPlan: WorkflowPlanStep): WorkflowUnitNode | undefined {
  const root = stepPlan.root;
  if (!root) return undefined;
  return root.kind === "map" ? root.template : root;
}

/**
 * The step ids another step can still read (named by `inputs[]`, `map.over`,
 * or `route.input` — the whole reference surface). A step outside this set
 * need not keep its artifact in memory once journaled. Derived from the plan alone.
 */
export function referencedStepIds(plan: WorkflowPlan): Set<string> {
  const referenced = new Set<string>();
  const note = (reference: string): void => {
    const parsed = parseReference(reference);
    if (parsed.ok && parsed.expr.kind === "stepOutput") referenced.add(parsed.expr.stepId);
  };
  for (const step of plan.steps) {
    if (step.root?.kind === "map") note(step.root.over);
    for (const reference of stepTemplate(step)?.inputs ?? []) note(reference);
    if (step.route) note(step.route.input);
  }
  return referenced;
}

/**
 * Typed artifacts: validate the promoted step artifact against
 * `WorkflowPlanStep.outputSchema`. Returns the step-failure summary (validation
 * errors included) on mismatch, undefined when valid or when no schema is
 * declared.
 */
export function validateStepArtifact(plan: WorkflowPlanStep, evidence: Record<string, unknown>): string | undefined {
  if (!plan.outputSchema) return undefined;
  const errors = validateJsonSchemaSubset(projectStepOutput(evidence), plan.outputSchema);
  if (errors.length === 0) return undefined;
  return (
    `Step "${plan.stepId}" artifact failed validation against the step's declared output schema: ` +
    `${errors.join("; ")}.`
  );
}

/**
 * Warn-only check of each successful unit's value against its declared
 * `unit.output` schema — the field a harness without structured output drops
 * during lowering. Never fails the step (unlike {@link validateStepArtifact}).
 */
export function unitSchemaWarning(plan: WorkflowPlanStep, units: readonly UnitOutcome[]): string | undefined {
  const schema = stepTemplate(plan)?.schema;
  if (!schema) return undefined;
  const mismatches: string[] = [];
  for (const unit of units) {
    if (!unit.ok) continue;
    const candidate =
      unit.result !== undefined
        ? unit.result
        : unit.text !== undefined
          ? parseEmbeddedJsonResponse(unit.text)
          : undefined;
    if (candidate === undefined) {
      mismatches.push(`unit "${unit.unitId}" produced no structured output to check`);
      continue;
    }
    const errors = validateJsonSchemaSubset(candidate, schema);
    if (errors.length > 0) mismatches.push(`unit "${unit.unitId}": ${errors.join("; ")}`);
  }
  if (mismatches.length === 0) return undefined;
  return `Output does not match the unit's declared schema (advisory; the run continued): ${mismatches.join("; ")}.`;
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
  reducer: WorkflowReducer,
  isFanOut: boolean,
): Record<string, unknown> {
  // Per-unit evidence carries only what the journal can reproduce, so a fresh
  // run and a resume agree byte-for-byte: a success keeps its `result`/clipped
  // `text`, a failure only its `failureReason` (diagnostics stay on the unit row).
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
      const winner = ranked[0]!.value;
      evidence.vote = { winner, votes: ranked[0]!.count, total: units.length };
      // An empty free-text winner is `undefined`; normalize to "" so a live run
      // and a resume promote the same `output` key.
      evidence.output = winner === undefined ? "" : winner;
    }
  }

  return evidence;
}

/**
 * The reduced outcome of a step's units — live or rehydrated from the journal —
 * so the same frozen plan always promotes the same artifact under the same
 * `on_error` policy and output schema.
 */
export interface ExecutedStepOutcome {
  ok: boolean;
  units: UnitOutcome[];
  evidence: Record<string, unknown>;
  summary: string;
  /** Set when `ok` is false BECAUSE the promoted artifact failed the step's
   * declared output schema (the one failure a gate loop may re-run). */
  artifactSchemaFailure?: true;
  /** Set when a unit's composed child workflow is `blocked`; the step blocks too, never gate-looping. */
  childBlocked?: {
    childRunId: string;
    childRef: string;
    childStepId: string | null;
  };
}

/**
 * The first failed unit's diagnostic (e.g. an exec unit's stderr), clipped to
 * {@link WORKFLOW_UNIT_DIAGNOSTIC_CLIP}, for the step summary. A live outcome
 * carries it as `error`, a rehydrated one as `text`; both give the same summary.
 */
function firstFailureDiagnostic(failed: UnitOutcome[]): string {
  const first = failed.find((u) => (u.error ?? u.text)?.trim());
  if (!first) return "";
  const diagnostic = (first.error ?? first.text ?? "").trim();
  return ` First failure diagnostic (${first.unitId}): ${clip(diagnostic, WORKFLOW_UNIT_DIAGNOSTIC_CLIP)}`;
}

/**
 * Reduce a step's terminal unit outcomes into the promoted artifact and step
 * verdict: the `on_error` policy, the reducer, the vote-tie failure, and the
 * typed-artifact schema check (`artifactSchemaFailure` marks a retryable one).
 */
export function reduceStepOutcomes(
  plan: WorkflowPlanStep,
  reducer: WorkflowReducer,
  isFanOut: boolean,
  onError: WorkflowOnError,
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
    firstFailureDiagnostic(failed) +
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

  if (!artifactSchemaFailure) {
    const schemaWarning = unitSchemaWarning(plan, units);
    if (schemaWarning !== undefined) summary += ` ${schemaWarning}`;
  }

  // A blocked child workflow (the failed unit's live-only `childRun`) is
  // surfaced so `finalizeExecutedStep` blocks the step instead of retrying.
  const blockedChildUnit = failed.find((u) => u.failureReason === "child_workflow_blocked" && u.childRun !== undefined);
  const childBlocked = blockedChildUnit?.childRun
    ? {
        childRunId: blockedChildUnit.childRun.runId,
        childRef: blockedChildUnit.childRun.ref,
        childStepId: blockedChildUnit.childRun.currentStepId,
      }
    : undefined;

  return {
    ok,
    units,
    evidence,
    summary,
    ...(artifactSchemaFailure ? { artifactSchemaFailure: true as const } : {}),
    ...(childBlocked ? { childBlocked } : {}),
  };
}

/**
 * The outcome of a step whose fan-out list is empty: no units dispatch and the
 * artifact is `[]` (collect) or `null` (vote), still checked against the step's
 * `outputSchema`. The reducer/vote-tie logic does not run.
 */
export function reduceEmptyStep(plan: WorkflowPlanStep, reducer: WorkflowReducer): ExecutedStepOutcome {
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
 * Rehydrate a journaled unit row into the {@link UnitOutcome} its live dispatch
 * produced: a completed row's JSON text or structured result, or a failed row's
 * `failure_reason` with its journaled diagnostic as `text`.
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

/** Re-exported so existing importers (`tests/workflows/fuzz/*`) keep resolving; canonical impl lives in `../ir/plan-hash`. */
export { canonicalJson };

// ── Gate-feedback recovery (PURE) ────────────────────────────────────────────
//
// A gate rejection journals `{ complete: false, missing, feedback }` under
// `<stepId>.gate:l<loop>`, byte-identical to what the next loop's prompts
// carry, so a resume rebuilds the same loop-N work list.

/** `phase` marker on gate-evaluation unit rows (dispatch rows journal `phase: null`). */
const GATE_EVALUATION_PHASE = "gate";

/** The unit id of a step's gate-evaluation row for a given 1-based loop. */
export function gateUnitId(stepId: string, loop: number): string {
  return `${stepId}.gate:l${loop}`;
}

/**
 * How many times a step's subgraph may run under its gate. An exec step never
 * loops: its frozen argv cannot read the judge's feedback, so a second loop
 * would only repeat the command's side effects. Its gate still evaluates.
 */
export function effectiveGateMaxLoops(stepPlan: WorkflowPlanStep): number {
  const declared = Math.max(1, stepPlan.gate.maxLoops ?? 1);
  const target = stepTemplate(stepPlan)?.frozenTarget;
  return target && target.kind !== "command" ? 1 : declared;
}

/**
 * The gate loop the engine is about to run for an active step: one past the
 * highest journaled rejected loop (loop 1 when none). An unparseable gate row
 * throws ({@link parseGateVerdict}) rather than silently restarting at loop 1.
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
 * The `{ feedback, missing }` the previous loop's rejection journaled, which
 * `loop`'s prompts carry; none for loop 1. An unparseable previous row throws.
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
 * Classify a gate row's journaled verdict. A NULL `result_json` (in flight, or
 * a completion error) is `empty`; a present value that is not `{ complete:
 * boolean }` throws rather than resetting the gate loop to 1.
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
  engine: string;
  model: string | null;
  runner: WorkflowRuntimeKind;
  inputHash: string;
  durableAttempt?: WorkflowRunUnitAttemptRowV4;
  tokens?: number;
}

/** Insert the gate-evaluation unit row (running) just before the judge runs. */
export async function journalGateEvaluationStart(gate: GateUnitRef): Promise<GateUnitRef> {
  const unitId = gateUnitId(gate.stepId, gate.loop);
  const reserved = await enqueueUnitWrite(() =>
    withWorkflowRunsRepo((repo) =>
      repo.reserveUnitAttempt({
        runId: gate.runId,
        unitId,
        stepId: gate.stepId,
        nodeId: gateNodeId(gate.stepId),
        phase: GATE_EVALUATION_PHASE,
        runner: gate.runner,
        engine: gate.engine,
        model: gate.model,
        inputHash: gate.inputHash,
        now: new Date().toISOString(),
      }),
    ),
  );
  return { ...gate, durableAttempt: reserved.attempt };
}

/**
 * Finish the gate-evaluation row: a rejection journals `{ complete: false,
 * missing, feedback }`, a pass `{ complete: true, missing: [] }`. An errored
 * evaluation journals a failed row with no verdict, so a judge outage never
 * burns a gate loop on resume.
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
  if (!gate.durableAttempt) throw new UsageError(`Gate ${unitId} has no durable attempt to finish.`);
  const durableAttempt = gate.durableAttempt;
  const finished = await enqueueUnitWrite(() =>
    withWorkflowRunsRepo((repo) => {
      return repo.finishUnitAttempt({
        runId: gate.runId,
        unitId,
        attempt: durableAttempt.attempt,
        dispatchId: durableAttempt.dispatch_id,
        status,
        resultJson: verdict ? JSON.stringify(verdict) : null,
        tokens: gate.tokens ?? null,
        failureReason: errored ? "dispatch_error" : null,
        finishedAt: new Date().toISOString(),
      });
    }),
  );
  if (!finished) {
    throw new UsageError(`Gate ${unitId} was already finished; refusing a duplicate terminal write.`);
  }
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
export function evaluateRoute(route: WorkflowRoute, scope: ExpressionScope): RouteDecision {
  const resolved = resolveStepReference(route.input, scope);
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
  route: WorkflowRoute,
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
  route: WorkflowRoute,
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
function routeTargets(route: WorkflowRoute): Set<string> {
  return new Set([...Object.values(route.when), ...(route.defaultStepId ? [route.defaultStepId] : [])]);
}

/** A journaled route decision must name a target the route declares; anything else fails loudly. */
function assertRouteTargetDeclared(route: WorkflowRoute, stepId: string, selected: string, runId: string): void {
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
  plan: WorkflowPlan,
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
      // a stored decision must name a declared target — a bogus one
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
// The one implementation of "evaluate the route, judge the gate, and advance
// (or not) the spine" for an executed step, first pass or resume. The caller
// walks the spine; this performs exactly one completion attempt.

export interface FinalizeStepInput {
  runId: string;
  workflowRef: string;
  stepId: string;
  stepPlan: WorkflowPlanStep;
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
  | { kind: "judge-failed"; summary: string }
  /**
   * A composed child workflow is `blocked` (P3b, spec docs/plans/specs/
   * p3b-child-executor.md §3.4). The step was completed `blocked` (run
   * derives `blocked`) via {@link blockStepForChildWorkflow} — a gate is a
   * gate for a child workflow too, so this is never fed into the bounded
   * gate loop, exactly like `judge-failed`.
   */
  | { kind: "child-blocked"; summary: string };

/**
 * The blocked-step notes for a verifier-infrastructure failure (bug: judge
 * outage must not burn the gate budget). Shared by every judge-failure path —
 * missing judge, unresolvable frozen judge, thrown judge call, malformed
 * verdict — so the resume instruction is worded once.
 */
function judgeFailureNotes(runId: string, stepId: string, cause: string): string {
  return (
    `Step "${stepId}" could not be verified: ${cause}. ` +
    `This is a verification-judge failure, not a verdict — no gate loop was consumed and the step's ` +
    `journaled units are preserved. Fix the verifier configuration or service, then run ` +
    `\`akm workflow resume ${runId}\` to re-evaluate the gate against the existing results ` +
    `without re-dispatching units.`
  );
}

export interface JudgeFailureBlock {
  runId: string;
  stepId: string;
  /** What went wrong, spliced into the shared notes. */
  cause: string;
  /** The step's evidence when the judge failed after its units ran, so a resume re-judges instead of re-dispatching. */
  evidence?: Record<string, unknown>;
}

/**
 * Complete a step `blocked` for a verifier-INFRASTRUCTURE failure and return
 * the notes written. The ONE implementation for both judge-failure paths — the
 * engine's pre-dispatch judge resolution (`run-workflow.ts`) and this module's
 * post-execution gate — so the wording, the blocked status, and the evidence
 * decision cannot drift between them.
 */
export async function blockStepForJudgeFailure(input: JudgeFailureBlock): Promise<string> {
  const notes = judgeFailureNotes(input.runId, input.stepId, input.cause);
  await completeWorkflowStep({
    runId: input.runId,
    stepId: input.stepId,
    status: "blocked",
    notes,
    ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
  });
  return notes;
}

/** The finalize path's blocked write: the executed units' evidence is preserved. */
async function blockFinalizedStep(input: FinalizeStepInput, cause: string): Promise<FinalizeStepResult> {
  const summary = await blockStepForJudgeFailure({
    runId: input.runId,
    stepId: input.stepId,
    cause,
    evidence: input.result.evidence,
  });
  return { kind: "judge-failed", summary };
}

/** The blocked-child resume notes: resume the child first, then re-drive the parent. */
function childWorkflowBlockedNotes(
  runId: string,
  stepId: string,
  childRunId: string,
  childRef: string,
  childStepId: string | null,
): string {
  return (
    `Step "${stepId}" composes child workflow run ${childRunId} (${childRef}), ` +
    `which is blocked at its own step "${childStepId ?? "(unknown)"}". Nothing in this run advances ` +
    `until the child does — a gate is a gate for a child workflow too, so \`akm\` will ` +
    `not resume it for you. Clear it with \`akm workflow resume ${childRunId}\`, then ` +
    `\`akm workflow resume ${runId}\` and \`akm workflow run ${runId}\` to ` +
    `continue: re-driving the parent drives the resumed child.`
  );
}

export interface ChildWorkflowBlock {
  runId: string;
  stepId: string;
  childRunId: string;
  childRef: string;
  childStepId: string | null;
  /** The executed step's evidence (the composing unit's outcome, including the child run identity). */
  evidence?: Record<string, unknown>;
}

/** Complete a step `blocked` because its child workflow is blocked; `akm workflow resume` clears it. */
export async function blockStepForChildWorkflow(input: ChildWorkflowBlock): Promise<string> {
  const notes = childWorkflowBlockedNotes(
    input.runId,
    input.stepId,
    input.childRunId,
    input.childRef,
    input.childStepId,
  );
  await completeWorkflowStep({
    runId: input.runId,
    stepId: input.stepId,
    status: "blocked",
    notes,
    ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
  });
  return notes;
}

/** The finalize path's child-blocked write: the executed units' evidence (the composing unit) is preserved. */
async function blockFinalizedStepForChildWorkflow(
  input: FinalizeStepInput,
  childBlocked: NonNullable<ExecutedStepOutcome["childBlocked"]>,
): Promise<FinalizeStepResult> {
  const summary = await blockStepForChildWorkflow({
    runId: input.runId,
    stepId: input.stepId,
    childRunId: childBlocked.childRunId,
    childRef: childBlocked.childRef,
    childStepId: childBlocked.childStepId,
    evidence: input.result.evidence,
  });
  return { kind: "child-blocked", summary };
}

/**
 * Perform one completion attempt for an executed step:
 *  - a hard unit failure fails the step (a retryable artifact-schema mismatch
 *    with loops left returns `retry` without a gate row);
 *  - a route decision is evaluated, journaled on the evidence, and applied to
 *    the skip bookkeeping; an unroutable value fails the step;
 *  - the gate judges a summary built from the promoted artifact: a rejection
 *    returns `retry` (loops left) or `gate-exhausted`, a pass `advanced`;
 *  - a judge infrastructure failure is not a verdict: it blocks the step for
 *    `akm workflow resume` (`judge-failed`) without consuming a loop.
 * Every advance goes through {@link completeWorkflowStep}.
 */
export async function finalizeExecutedStep(input: FinalizeStepInput): Promise<FinalizeStepResult> {
  const { runId, workflowRef, stepId, stepPlan, completionCriteria, gateLoop, loopsRemaining, result } = input;

  if (!result.ok) {
    // a composed child workflow that blocked is never fed into the
    // bounded gate loop — a gate is a gate for a child workflow too. Checked
    // FIRST, before the artifactSchemaFailure retry branch below.
    if (result.childBlocked) {
      return blockFinalizedStepForChildWorkflow(input, result.childBlocked);
    }
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
    return blockFinalizedStep(
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
      await completeWorkflowStep({ runId, stepId, status: "failed", notes, evidence: result.evidence });
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
  const gateTarget = innerJudge ? stepPlan.gate.frozenJudge : null;
  let gateUnit: GateUnitRef | undefined;
  // `judgeFailure` records a verifier INFRASTRUCTURE failure observed during
  // the judge call — a throw (transport/service error) or a response that is
  // not a well-formed verdict (same parser as validateStepSummary, so the
  // fail-closed rejection it synthesizes is recognizably NOT an honest verdict
  // here).
  let judgeFailure: string | undefined;
  const summaryJudge: SummaryJudge | null = innerJudge
    ? async (prompt) => {
        if (gateTarget) {
          const engineName = gateTarget.request.engine.name;
          if (!engineName) throw new Error(`Gate ${stepId} has no frozen engine identity.`);
          gateUnit = {
            runId,
            workflowRef,
            stepId,
            loop: gateLoop,
            engine: engineName,
            model: gateTarget.request.model?.resolved ?? null,
            runner: gateTarget.runner.kind,
            // The gate prefix rides the unit prefix's version — unit and gate
            // hashVersion are one vocabulary (p3a §0.1; the R-R15 fix moved
            // both 6 → 7 in lockstep even though the gate preimage's own
            // fields are unchanged).
            inputHash: createHash("sha256")
              .update("akm.workflow.gate\0v7\0")
              .update(
                canonicalJson({
                  hashVersion: 7,
                  dispatch: gateTarget,
                  invocation: null,
                  prompt,
                }),
              )
              .digest("hex"),
          };
          gateUnit = await journalGateEvaluationStart(gateUnit);
        }
        // The judge dispatch must describe the SAME thing the gate row does, so
        // the row identity is threaded down to the dispatcher from right here —
        // the one place that computes it — instead of being re-derived (or, as
        // before, synthesized as a constant "gate"). Both ids come from the same
        // helpers `journalGateEvaluationStart/Finish` use.
        const identity: JudgeCallIdentity = {
          runId,
          stepId,
          unitId: gateUnitId(stepId, gateLoop),
          ...(gateUnit?.durableAttempt
            ? {
                attempt: gateUnit.durableAttempt.attempt,
                dispatchId: gateUnit.durableAttempt.dispatch_id,
                recordTokens: (tokens: number) => {
                  if (gateUnit) gateUnit.tokens = tokens;
                },
              }
            : {}),
        };
        let raw: string;
        try {
          raw = await innerJudge(prompt, identity);
        } catch (err) {
          const detail = err instanceof Error && err.message ? ` (${err.message})` : "";
          judgeFailure = `the verification judge failed${detail}`;
          throw err;
        }
        if (parseJudgeVerdict(raw) === undefined) {
          judgeFailure =
            "the verification judge responded with a malformed verdict instead of the required JSON result";
        }
        return raw;
      }
    : null;

  // Once the judge runs, its `running` gate row must be finished on every
  // exit: if `completeWorkflowStep` throws afterwards, finish it as errored,
  // then re-propagate.
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
    });
  } catch (err) {
    if (gateUnit) await journalGateEvaluationFinish(gateUnit, true, undefined);
    throw err;
  }
  const rejection =
    "ok" in completion && completion.ok === false ? (completion as SummaryValidationFailure) : undefined;
  const judgeFailed = judgeFailure !== undefined;

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
    return blockFinalizedStep(input, judgeFailure ?? "the verification judge failed");
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

// `clip` lives with the bounds it applies (`workflows/resource-limits.ts`) so
// the write side here and the read side in `runtime/runs.ts` — which cannot
// import this module — truncate through one implementation. Re-exported
// because this module is where the dispatch path already reaches for it.
export { clip } from "../resource-limits";
