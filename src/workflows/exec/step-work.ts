// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared step semantics — the ONE implementation of a step's orchestration
 * decisions, consumed by the engine loop (`run-workflow.ts` +
 * `native-executor.ts`) on both the fresh-execution and the resume/replay
 * path, so a first run and a resumed run of the same frozen plan produce
 * byte-identical unit graphs. `computeStepWorkList` and its reducer/gate/route
 * helpers are PURE (no clock, no IO, no journal read); the gate-evaluation
 * journaling functions are the one deliberate exception. This module never
 * dispatches a unit and never writes step rows.
 *
 * See docs/architecture/decisions/0002-unit-reuse-and-input-hash-scope.md for
 * the full purity-contract design history.
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
import type { IrIsolation, IrMapReducer, IrOnError, IrRetry, IrRouteSpec, IrRuntimeKind } from "../ir/schema";
import type { FrozenWorkflowTarget, IrStepPlanV4, IrUnitNodeV4, WorkflowPlanGraphV4 } from "../ir/schema-v4";
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
  /** Live lowering diagnostics; the current contract intentionally excludes them from durable result_json/evidence. */
  notices?: readonly Readonly<LoweringNotice>[];
  /**
   * Harness-native session id revealed during dispatch (last one wins across
   * structured-output retries). Persisted by `finishUnitAttempt`.
   */
  sessionId?: string;
  /**
   * Live-only child-run identity for a child-workflow unit (P3b, spec
   * docs/plans/specs/p3b-child-executor.md §3.4). Excluded from durable
   * evidence — the current contract intentionally excludes it from
   * result_json/evidence, exactly like {@link notices}: `buildEvidence`
   * projects a closed whitelist that this field is not a member of, so it
   * cannot leak into a hashed artifact.
   */
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
  runner: IrRuntimeKind;
  /** The sole normalized execution target. */
  frozenTarget: FrozenWorkflowTarget;
  /** Frozen named environment bindings materialized only at dispatch. */
  environment: IrUnitNodeV4["environment"];
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
  retry?: IrRetry;
  onError: IrOnError;
  isolation?: IrIsolation;
  /** The unit's rendered instructions, built once by the work-list builder. */
  prompt: string;
  /** Canonical hash of this unit's frozen inputs — the durable-reuse identity. */
  inputHash: string;
  /**
   * A child-workflow unit's resolved `with:` bindings (P3b, spec
   * docs/plans/specs/p3b-child-executor.md §3.3 step 2), set from the SAME
   * resolution every frozen target's `inputBindings` already runs
   * ({@link buildStepWorkUnit}'s `taskInputs` — no second binding resolver
   * exists). Consumed by `child-workflow.ts`'s `driveChildWorkflowUnit` as the
   * published child run's `params_json`; absent (never `{}`) when the step
   * binds nothing, exactly like `taskInputs`.
   */
  childParams?: Readonly<Record<string, unknown>>;
}

export interface StepWorkList {
  template: IrUnitNodeV4;
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
 * null or duplicate fan-out items) return `{ ok: false }`. Per-unit resolution
 * cannot fail in the shared source IR — prose is never scanned for references,
 * and everything that CAN fail (map.over / route.input / inputs:) resolves
 * once per step, failing the whole list above.
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
 * Resolve one whole-value reference, refusing a value a persisted TRUNCATION
 * ENVELOPE stands in for (`clipStepEvidenceForPersistence`, runtime/runs.ts).
 *
 * The first occurrence of a given canonical value keeps the byte-identical id
 * {@link unitIdFor} always produced for it — so a plan with no duplicates (the
 * overwhelming common case) is completely unaffected, and no prior journal
 * entry is ever invalidated by this change. Only the SECOND and later
 * occurrences gain a `#<n>` suffix (`#2`, `#3`, …), computed purely from each
 * item's position in `items` — deterministic across a fresh run and a
 * resumed one, since both call this from the same place in
 * {@link computeStepWorkList} over the same resolved list.
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

/**
 * Resolve one whole-value reference (`inputs[]`, `map.over`, `route.input`).
 *
 * Every step artifact is now persisted whole (issue C), so this is a thin
 * wrapper: source adapters may retain GitHub's whole-value `${{ ... }}`
 * spelling, and this work-list seam unwraps only an exact whole-value
 * wrapper — it never interpolates prose.
 */
function resolveStepReference(reference: string, scope: ExpressionScope): ResolveReferenceResult {
  // Source adapters may retain GitHub's whole-value `${{ ... }}` spelling.
  // The source IR owns GitHub's whole-value spelling; this work-list seam
  // unwraps only an exact whole-value wrapper and never interpolates prose.
  const exactWrapper = /^\$\{\{\s*([^{}]+?)\s*\}\}$/.exec(reference);
  const canonicalReference = exactWrapper?.[1] ?? reference;
  return resolveReferenceString(canonicalReference, scope);
}

/** The whole-step failure shape `computeStepWorkList` returns — one field, so a resolver's own failure IS this shape. */
type TaskInputBindingsResolution =
  | { ok: true; values: Readonly<Record<string, unknown>> }
  | { ok: false; error: string };

/**
 * Pre-attempt resolution of a task-composing step's frozen `inputBindings`
 * (spec docs/plans/specs/p2b-input-bindings.md §3.6, B-31..B-34): a
 * `{kind:"literal"}` passes through unchanged — its schema was already
 * checked at FREEZE (`freezeTaskInputBindings`,
 * `src/workflows/freeze/task-bindings.ts`), so it is never re-validated. A
 * `{kind:"reference"}` resolves via the SAME {@link resolveStepReference}
 * every other whole-value position uses, then validates the resolved value
 * against the binding's own frozen `schema` — a mismatch (or a reference that
 * fails to resolve at all) fails the WHOLE step here, before
 * `reserveUnitAttempt` is ever called by the native executor. Absent
 * `bindings` (the overwhelmingly common case — no `with:` on this step's
 * target) resolves trivially to `{}` with no scope access at all.
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

export function computeStepWorkList(plan: IrStepPlanV4, input: WorkListInput): ComputeWorkListResult {
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
    const resolved = resolveStepReference(reference, scope);
    if (!resolved.ok) {
      return {
        ok: false,
        error: `Step "${plan.stepId}" declared input "${reference}" failed to resolve: ${resolved.error.message}`,
      };
    }
    resolvedInputs.push({ reference, value: resolved.value });
  }

  // P2b Lane A2 — pre-attempt resolution of a task-composing step's frozen
  // `inputBindings` (spec §3.6, B-31..B-34): a `{kind:"literal"}` passes
  // through unchanged (its schema was already checked at freeze, B-34); a
  // `{kind:"reference"}` resolves against this SAME scope, then its resolved
  // value is validated against the binding's own frozen `schema` — a
  // mismatch fails the WHOLE step here, before `reserveUnitAttempt` is ever
  // reached (B-32). This runs for every target kind (command/shell/script);
  // Lane B's delivery consumes the result via `StepWorkUnitContext.taskInputs`
  // / `taskInputsJson` below.
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
  const runner: IrRuntimeKind = target.kind === "command" ? target.runner.kind : "exec";
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
  // An exec unit's budget is frozen on its exec spec (there is no engine to
  // inherit one from); `ir/freeze.ts` resolved it once from unit `timeout:` →
  // `defaults.timeout` → DEFAULT_EXEC_TIMEOUT_MS.
  const timeoutMs =
    target.kind === "command"
      ? (target.runner.timeoutMs ?? null)
      : target.kind === "child-workflow"
        ? // A child-workflow target carries no exec spec of its own (§3.5).
          // computeStepWorkList still builds this unit's context
          // unconditionally — the child executor (child-workflow.ts,
          // reached from native-executor.ts's dispatch seam, P3b §3.2) is
          // what actually drives a child-workflow unit, not this line, so
          // `null` only needs to be a value this layer can carry, never one
          // an engine acts on.
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
  // P2b Lane A2 (§3.6): the resolved effective task-composition inputs,
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
  plan: IrStepPlanV4;
  input: WorkListInput;
  template: IrUnitNodeV4;
  isFanOut: boolean;
  gateLoop: number;
  resolvedInputs: Array<{ reference: string; value: unknown }>;
  runner: IrRuntimeKind;
  timeoutMs: number | null;
  target: FrozenWorkflowTarget;
  frozenExec?: Extract<FrozenWorkflowTarget, { kind: "shell" | "script" }>["exec"];
  /** Step-constant `AKM_PARAMS` / `AKM_INPUTS` payloads, serialized once (exec steps only). */
  execParamsJson?: string;
  execInputsJson?: string;
  /**
   * P2b Lane B (delivery) / Lane A2 (pre-attempt resolution, spec
   * docs/plans/specs/p2b-input-bindings.md §3.6, §4.1/§4.2): the composed
   * task's EFFECTIVE `inputBindings` — resolved (references against
   * `input.params`/`input.stepOutputs`) and schema-validated once per step,
   * exactly like `resolvedInputs` above. `taskInputs` feeds the command-target
   * prompt's `## Task inputs` block (`buildUnitPrompt`); `taskInputsJson` is
   * its canonical-JSON serialization, feeding `AKM_TASK_INPUTS`
   * (`buildExecContextEnv`). Both are absent when the frozen target carries no
   * `inputBindings` or every resolved value is empty (B-39) — this module's
   * own delivery consumers (Lane B) never populate these fields; only the
   * pre-attempt resolution step does.
   */
  taskInputs?: Readonly<Record<string, unknown>>;
  taskInputsJson?: string;
}

/**
 * Build ONE unit of the step's work list: its journal id, its assembled prompt,
 * its exec context env (exec units only), and its canonical input hash.
 *
 * Extracted from {@link computeStepWorkList} verbatim — same inputs, same
 * bytes. It is a separate named pass only because the step-level resolution
 * (inputs, fan-out items, runner, timeout) and the per-unit instantiation are
 * two different jobs, and keeping them in one function had grown it past the
 * repo's 220-line function bar.
 */
function buildStepWorkUnit(ctx: StepWorkUnitContext, unitId: string, item: unknown, index: number): StepWorkUnit {
  const { plan, input, template, isFanOut, resolvedInputs, target, frozenExec, taskInputs } = ctx;
  // Gate loops (>= 2) journal under `<unitId>~l<loop>` so loop 1's rows are
  // never clobbered; the content-derived identity (and the prompt's
  // {{UNIT_ID}}) stays the base id.
  const journalBaseId = ctx.gateLoop > 1 ? `${unitId}~l${ctx.gateLoop}` : unitId;

  // Context attachment (workflow-format-unification, spec §4): every unit
  // receives the run params (already in the preamble), its item + index if
  // it is a map unit, and the artifacts named by its step's `inputs:`.
  // Instructions reach the unit byte-exact — never interpolated.
  //
  // An EXEC unit gets NO prompt: there is no model to read one, the exec
  // dispatch branch returns before ever touching `request.prompt`, and the input
  // hash is built from `template.instructions`, not from the assembled string.
  // Its context reaches the child through {@link buildExecContextEnv} instead —
  // attached as environment, never spliced into argv, which is the argv-array
  // analogue of "data is attached context, not string splices".
  const prompt = frozenExec
    ? ""
    : buildUnitPrompt({
        runId: input.runId,
        stepId: plan.stepId,
        unitId,
        params: input.params,
        ...(isFanOut ? { item, itemIndex: index } : {}),
        ...(resolvedInputs.length > 0 ? { inputs: resolvedInputs } : {}),
        // P2b Lane B (§4.2, B-38/B-39): the composed task's resolved
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
    // P3b §3.3 step 2: the SAME resolved `with:` bindings `taskInputs` already
    // carries, exposed under the name `child-workflow.ts`'s drive contract
    // reads. Absent (never `{}`) when the step binds nothing.
    ...(taskInputs && Object.keys(taskInputs).length > 0 ? { childParams: taskInputs } : {}),
    prompt,
    inputHash,
  };
}

/**
 * The `AKM_*` context environment an exec unit's child receives.
 *
 * An exec unit's argv is FROZEN and never interpolated (the shared source IR has
 * no substitution language at all), so this is how a fan-out item, the run
 * params, and the step's declared `inputs:` artifacts actually reach a command
 * — as attached environment, exactly as they reach an engine unit as attached
 * prompt context. Values are canonical JSON so a command can parse them.
 *
 * These are applied on top of the resolved `env:` bindings in the child, so an
 * engine-authored context variable can never be shadowed by a binding. Params
 * reach the child in clear (only the journal scrubs secret-shaped values —
 * `exec/param-secrets.ts`); secrets belong in `env:` bindings, which reach the
 * child by name.
 *
 * SIZE is not bounded here, on purpose. A workflow artifact has no bound
 * comparable to an OS environment entry, so `AKM_INPUTS` (and `AKM_PARAMS` /
 * `AKM_ITEM` / `AKM_TASK_INPUTS`) can serialize past what `execve` accepts and
 * make PROCESS CREATION
 * fail with a bare `E2BIG`. The check belongs at the spawn boundary, where the
 * failure can be journaled as a unit outcome with an actionable message naming
 * the variable: `checkExecContextSize` in `exec/exec-unit.ts`, against
 * `execContextLimits()` for the platform the run is actually on (a Linux run is
 * checked against Linux's ceiling, not against the smallest supported one).
 * This function stays PURE and total.
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
  // P2b Lane B (spec §4.1, B-35/B-36/B-39, B-N1): ONE variable carrying the
  // composed task's effective `inputBindings` as canonical JSON — never one
  // var per input. Absent when the frozen target carries no `inputBindings`
  // or every resolved value is empty. Sizing is enforced by the SAME generic
  // `checkExecContextSize` loop as every other `AKM_*` entry (exec-unit.ts) —
  // no change there, the roster is just longer by one name (B-37).
  if (ctx.taskInputsJson !== undefined) env.AKM_TASK_INPUTS = ctx.taskInputsJson;
  return env;
}

/**
 * The canonical dispatch-input envelope, recorded on every attempt row as
 * `input_hash`: every field here is an input that changes what the backend is
 * actually asked to do. It is INFORMATIONAL — resume reuses a completed row by
 * unit id regardless of it (a diagnostic can still tell two dispatches of one
 * unit apart). `env` carries names only, never resolved secret values.
 * `retry`/`onError` are excluded — they govern failed-unit re-dispatch, not a
 * unit's inputs. `gateFeedback` and `taskInputs` are included conditionally so
 * a binding-free, loop-1 unit's preimage keeps its historical shape
 * (`hashVersion` 7). This is the ONE place a unit's inputHash is computed.
 *
 * See docs/architecture/decisions/0002-unit-reuse-and-input-hash-scope.md for
 * the full field-by-field inclusion/exclusion rationale (reviewer finding #1).
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
   * P2b Lane B (spec §4.2, B-38/B-39, B-N2): the composed task's effective
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
 * Assemble the final prompt: engine preamble (run params + item/index +
 * declared-input artifacts, all as structured JSON context) + the step's
 * BYTE-EXACT prose instructions (+ gate feedback on loop re-executions, +
 * schema directive). Instructions are NEVER interpolated (workflow-format-
 * unification, spec §2.3) — data reaches the unit as attached context, not
 * string splices; only the ENGINE's own preamble placeholders are substituted
 * here.
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

  // P2b Lane B (spec §4.2, B-38/B-39, B-N2): the composed task's resolved
  // `inputBindings`, as a structured fenced JSON block — the same "attached
  // context, never a splice" mechanism as itemBlock/inputsBlock above.
  // `canonicalInputJson` (sorted keys) matches the AKM_TASK_INPUTS env var's
  // own serialization, so the effective-inputs value reads identically on
  // every delivery surface. Absent (or empty) appends nothing (B-39).
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
function stepTemplate(stepPlan: IrStepPlanV4): IrUnitNodeV4 | undefined {
  const root = stepPlan.root;
  if (!root) return undefined;
  return root.kind === "map" ? root.template : root;
}

/**
 * The step ids that ANOTHER step of the frozen plan can still read: the
 * producers named by an `inputs[]` entry, a `map.over`, or a `route.input`.
 * Those three fields are the WHOLE reference surface — instructions are never
 * scanned (workflow-format-unification, spec §2.3) — so a step outside this set
 * has no in-plan consumer and nothing needs to hold its artifact in memory once
 * it is journaled.
 *
 * Derived from the plan alone: O(plan), independent of run state, and stable
 * across the retry and gate loops (a retry re-opens one failed step, and a
 * looping step has not advanced, so neither can turn an unreferenced producer
 * into a referenced one mid-invocation).
 */
export function referencedStepIds(plan: WorkflowPlanGraphV4): Set<string> {
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
 * Typed artifacts (addendum, R2): validate the promoted step artifact against
 * `IrStepPlan.outputSchema`. Returns the step-failure summary (validation
 * errors included) on mismatch, undefined when valid or when no schema is
 * declared.
 */
export function validateStepArtifact(plan: IrStepPlanV4, evidence: Record<string, unknown>): string | undefined {
  if (!plan.outputSchema) return undefined;
  const errors = validateJsonSchemaSubset(projectStepOutput(evidence), plan.outputSchema);
  if (errors.length === 0) return undefined;
  return (
    `Step "${plan.stepId}" artifact failed validation against the step's declared output schema: ` +
    `${errors.join("; ")}.`
  );
}

/**
 * Warn-only check of each successful unit's own promoted value against its
 * template's declared `schema` (`unit.output`) — the one field a harness that
 * cannot request structured output drops during lowering (`untranslated-field`,
 * field `outputSchema`), after which nothing else ever compares the returned
 * text to it. Unlike {@link validateStepArtifact} this never fails the step:
 * a harness that DID honor the schema already returned a compliant `result`
 * (this re-check then finds nothing), and one that could not is exactly the
 * case this exists to surface — the run continues either way.
 */
export function unitSchemaWarning(plan: IrStepPlanV4, units: readonly UnitOutcome[]): string | undefined {
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
      const winner = ranked[0]!.value;
      evidence.vote = { winner, votes: ranked[0]!.count, total: units.length };
      // An empty free-text unit normalizes to absent text, so its vote value is
      // `undefined`. Assigning that to `evidence.output` made the key vanish
      // under JSON serialization: a LIVE run then saw `output` absent (and fell
      // back to the whole evidence envelope), while a RESUMED run rehydrated the
      // same step from the journal and produced a different artifact — with the
      // raw envelope exposed as `steps.<id>.output`. Normalize to an explicit
      // empty string so both paths promote the same value.
      evidence.output = winner === undefined ? "" : winner;
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
  /**
   * Set when a unit failed because the child workflow it composes is
   * `blocked` (P3b, spec docs/plans/specs/p3b-child-executor.md §3.4).
   * Carries what `blockStepForChildWorkflow` needs to build the resume
   * notes; `finalizeExecutedStep`'s `!result.ok` arm checks this FIRST,
   * before the `artifactSchemaFailure` retry branch — a gate is a gate for a
   * child workflow too, so this is never fed into the bounded gate loop.
   */
  childBlocked?: {
    childRunId: string;
    childRef: string;
    childStepId: string | null;
  };
}

/**
 * The FIRST failed unit's diagnostic, appended to the step summary.
 *
 * A failure reason alone is not a diagnosis. `non_zero_exit` says a command
 * failed; for an exec unit the reason it failed is on stderr, and the summary is
 * what `akm workflow run` prints and what the failed step row keeps as its
 * notes. Bounded on both axes: ONE unit (a 10 000-wide fan-out must not turn its
 * summary into a log) clipped to {@link WORKFLOW_UNIT_DIAGNOSTIC_CLIP} — the same
 * bound the journal and `status --units` use.
 *
 * Reproducible on both surfaces: a live dispatch carries the diagnostic as
 * `error`; a unit rehydrated from the journal carries it as `text` (the column
 * `journaledUnitResultJson` wrote it to), so the fallback below composes the
 * SAME summary from either.
 */
function firstFailureDiagnostic(failed: UnitOutcome[]): string {
  const first = failed.find((u) => (u.error ?? u.text)?.trim());
  if (!first) return "";
  const diagnostic = (first.error ?? first.text ?? "").trim();
  return ` First failure diagnostic (${first.unitId}): ${clip(diagnostic, WORKFLOW_UNIT_DIAGNOSTIC_CLIP)}`;
}

/**
 * Reduce a step's terminal unit outcomes into the promoted artifact + step
 * verdict — the shared semantics between native dispatch and the report path.
 * Applies the `on_error` policy (`fail` vs `continue`), the reducer (via
 * {@link buildEvidence}), the vote-tie failure, and the typed-artifact schema
 * validation (fail-fast, errors in the summary, `artifactSchemaFailure` marker).
 * Callers own dispatch-specific concerns (budget, journal writes) BEFORE
 * calling this; those never occur on the report path (units are journaled).
 */
export function reduceStepOutcomes(
  plan: IrStepPlanV4,
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

  // P3b §3.4: a composed child workflow that blocked is carried on the
  // failed unit's LIVE-ONLY `childRun` field (child-workflow.ts's
  // driveChildWorkflowUnit). Surfaced here, unconditionally on the unit
  // list, so `finalizeExecutedStep` can check it before deciding whether
  // this step's failure is retryable — an `onError: "continue"` step that
  // tolerates the failure (`ok` stays true) never reaches that check at all.
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
export function reduceEmptyStep(plan: IrStepPlanV4, reducer: IrMapReducer): ExecutedStepOutcome {
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
 * validated structure. A failed row carries its `failure_reason` plus whatever
 * `journaledUnitResultJson` (native-executor.ts) wrote to `result_json` —
 * surfaced as `text`, its historical meaning. {@link firstFailureDiagnostic} is
 * the one consumer that wants it as a diagnostic and falls back to `text`, so
 * the step summary stays the same on both surfaces.
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
// A gate rejection is journaled as `<stepId>.gate:l<loop>` with result_json
// `{ complete: false, missing, feedback }` (see journalGateEvaluationFinish).
// The feedback stored there is BYTE-IDENTICAL to what the engine threads into
// the next loop's prompts — both are the same `rejection.feedback`/`.missing`.
// A resume recovers it from the journal so its loop-N work-list (and therefore
// every unit id and input hash in it) matches the one the original run built.
// `native-executor.test.ts` asserts the round-trip identity.

/**
 * `phase` marker stamped on gate-evaluation unit rows. Step ids cannot contain
 * dots (`PROGRAM_STEP_ID_PATTERN`), so a step can never be NAMED `x.gate` and
 * the synthetic `<stepId>.gate` node id is collision-free against user step
 * ids. The phase column is nonetheless the discriminator we key on — an
 * explicit marker, not a `node_id` suffix match. Dispatch rows always journal
 * `phase: null`.
 */
const GATE_EVALUATION_PHASE = "gate";

/** The unit id of a step's gate-evaluation row for a given 1-based loop. */
export function gateUnitId(stepId: string, loop: number): string {
  return `${stepId}.gate:l${loop}`;
}

/**
 * How many times a step's subgraph may run under its completion gate — the
 * bound the engine loop walks and the one `loopsRemaining` is derived from.
 *
 * A gate loop only earns its re-dispatch when the subgraph can ANSWER the
 * judge: an engine unit reads the rejection feedback in its prompt and produces
 * different work. An `exec` unit cannot. Its argv is frozen and never
 * interpolated, {@link buildExecContextEnv} exposes no feedback variable, and
 * the default dispatcher drops feedback for exec — so a second loop re-runs the
 * BYTE-IDENTICAL command for a verdict that cannot change, which for a deploy /
 * publish / migrate command means performing the side effect twice. The same
 * reasoning already pins exec structured output to a single attempt and makes
 * `exec_capture_incomplete` non-retryable (`native-executor.ts`).
 *
 * So an exec step's gate still EVALUATES — the verdict can still fail the step
 * — but it never loops: a rejection lands on the gate-exhausted terminal
 * instead of re-dispatching. An authored `gate.max_loops` on an engine step is
 * untouched.
 */
export function effectiveGateMaxLoops(stepPlan: IrStepPlanV4): number {
  const declared = Math.max(1, stepPlan.gate.maxLoops ?? 1);
  const target = stepTemplate(stepPlan)?.frozenTarget;
  return target && target.kind !== "command" ? 1 : declared;
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
  engine: string;
  model: string | null;
  runner: IrRuntimeKind;
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
export function evaluateRoute(route: IrRouteSpec, scope: ExpressionScope): RouteDecision {
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
  plan: WorkflowPlanGraphV4,
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
// caller owns the SPINE-WALKING glue (which loop to run next, skip cascades);
// this function performs exactly ONE completion attempt.

export interface FinalizeStepInput {
  runId: string;
  workflowRef: string;
  stepId: string;
  stepPlan: IrStepPlanV4;
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
  /**
   * The executed step's evidence, when the judge failed AFTER its units ran.
   * Persisting it is what makes the documented recovery real: `akm workflow
   * resume` re-evaluates the gate against these results instead of
   * re-dispatching them. The PRE-DISPATCH failure (an unresolvable frozen
   * judge, caught before a single unit runs) has no results to preserve and
   * omits it — the difference is what the step produced, not a policy split.
   */
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

/**
 * §3.4's exact `blockStepForChildWorkflow` notes — the ONE place the
 * blocked-child resume sequence is worded, mirroring {@link judgeFailureNotes}.
 * Two properties this wording pins (each its own test): the CHILD is resumed
 * FIRST, and the PARENT's own re-drive is what advances it (the child drive
 * never calls `resumeWorkflowRun` itself, row A-22); the notes name the child
 * run id and both commands verbatim, so the text renderer needs no change
 * (B-N15 — Lane A touches no output module).
 */
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

/**
 * Complete a step `blocked` because the child workflow it composes is
 * blocked, and return the notes written (P3b §3.4). Sits beside
 * {@link blockStepForJudgeFailure} — the SAME shape of "infrastructure-like"
 * block: the step is completed `blocked`, and `akm workflow resume` is what
 * clears it (of the CHILD first, then the parent) rather than an automatic
 * in-step re-dispatch.
 */
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

  if (!result.ok) {
    // P3b §3.4: a composed child workflow that blocked is never fed into the
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

  // Reviewer #6: once the judge is invoked, its gate row is journaled `running`
  // (journalGateEvaluationStart) and MUST be finished on every exit. The
  // already-fixed window is the judge itself throwing (caught inside
  // validateStepSummary — `judgeFailure` records it). The remaining window is
  // `completeWorkflowStep` throwing AFTER the judge ran — a concurrent state
  // change (the run abandoned mid-step), a DB error — which would otherwise
  // skip the finish and strand the gate row in `running`. Finish it as an
  // errored row (the observed outcome: the completion did not succeed), then
  // re-propagate. The caller's signal reaches the completion path so an abort
  // mid-judge is an interruption, not a verifier outage.
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
