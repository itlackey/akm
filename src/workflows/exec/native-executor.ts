// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Native executor — Backend B of the orchestration plan (P1).
 *
 * Executes ONE step's IR subgraph (`IrStepPlan.root`) on the local machine:
 * fan-out through the scheduler, schema-validated structured output through
 * `runStructured` (core/structured.ts), per-unit persistence through the
 * serialized writer queue, and `workflow_unit_*` events for observability.
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
import { scheduleUnits, UnitCapExceededError } from "./scheduler";
import { enqueueUnitWrite } from "./unit-writer";

/**
 * Default per-unit timeout. Deliberately NOT the 60 s agent default
 * (`DEFAULT_AGENT_TIMEOUT_MS`) — workflow units routinely run real coding
 * tasks on slow local models; 10 minutes matches the LLM-path default
 * (`tryLlmFeature`). A step's `### Timeout` overrides this; `none` disables.
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
  /** Raw text output (agent stdout / SDK message / LLM content). */
  text: string;
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
}

export interface StepExecutionContext {
  runId: string;
  workflowRef: string;
  params: Record<string, unknown>;
  /** Evidence of prior steps, keyed by step id — fan-out `over:` sources. */
  evidence: Record<string, Record<string, unknown> | undefined>;
  signal?: AbortSignal;
  /** Test seam / backend override; defaults to the runner-substrate dispatcher. */
  dispatcher?: UnitDispatcher;
  /** Units already dispatched in this run (lifetime-cap accounting). */
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
  /** Cumulative dispatched-unit count (input + this step). */
  unitsDispatched: number;
}

/** Execute one step plan natively. Never throws for unit-level failures. */
export async function executeStepPlan(plan: IrStepPlan, ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const dispatched = ctx.unitsDispatched ?? 0;
  const root = plan.root;

  if (root.kind !== "agent" && root.kind !== "map") {
    return failedStep(
      dispatched,
      `Step "${plan.stepId}" uses IR node kind "${root.kind}", which the native executor does not support yet.`,
    );
  }

  const template = root.kind === "map" ? root.template : root;
  const reducer = root.kind === "map" ? root.reducer : "collect";

  // Resolve fan-out items.
  let items: unknown[];
  if (root.kind === "map") {
    const source = resolveFanOutSource(root.over, ctx);
    if (!Array.isArray(source)) {
      return failedStep(
        dispatched,
        `Step "${plan.stepId}" fan-out key "${root.over}" did not resolve to an array in run params or prior step evidence` +
          (source === undefined ? " (not found)." : ` (got ${typeof source}).`),
      );
    }
    items = source;
  } else {
    items = [undefined];
  }

  if (items.length === 0) {
    return {
      ok: true,
      units: [],
      evidence: { units: [], itemCount: 0 },
      summary: `Step "${plan.stepId}" fan-out list was empty — no units dispatched.`,
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

  let outcomes: Array<UnitOutcome | undefined>;
  try {
    outcomes = await scheduleUnits(
      items,
      (item, index) =>
        runUnit({
          plan,
          template,
          item,
          index,
          isFanOut: root.kind === "map",
          env,
          ctx,
          dispatcher,
          existingUnits,
        }),
      {
        concurrency: root.kind === "map" ? root.concurrency : 1,
        signal: ctx.signal,
        unitsDispatched: dispatched,
        maxConcurrency: ctx.maxConcurrency,
      },
    );
  } catch (err) {
    if (err instanceof UnitCapExceededError) {
      return failedStep(dispatched, err.message);
    }
    throw err;
  }

  const units = outcomes.map(
    (outcome, index) =>
      outcome ?? {
        unitId: unitIdFor(template, index, root.kind === "map"),
        ok: false,
        failureReason: "aborted",
        error: "unit was not dispatched (aborted or scheduler failure)",
      },
  );

  const failed = units.filter((u) => !u.ok);
  const evidence = buildEvidence(units, reducer);
  const reducerNote = typeof evidence.voteError === "string" ? ` ${evidence.voteError}` : "";
  const ok = failed.length === 0 && !evidence.voteError;
  const summary =
    `Executed ${units.length} unit(s) for step "${plan.stepId}" via the native executor: ` +
    `${units.length - failed.length} succeeded, ${failed.length} failed.` +
    (failed.length > 0
      ? ` Failures: ${failed.map((u) => `${u.unitId} (${u.failureReason ?? "error"})`).join(", ")}.`
      : "") +
    reducerNote;

  return { ok, units, evidence, summary, unitsDispatched: dispatched + units.length };
}

// ── One unit ─────────────────────────────────────────────────────────────────

interface RunUnitInput {
  plan: IrStepPlan;
  template: IrAgentNode;
  item: unknown;
  index: number;
  isFanOut: boolean;
  env?: Record<string, string>;
  ctx: StepExecutionContext;
  dispatcher: UnitDispatcher;
  /** Prior unit rows for this step, for durable-row reuse. */
  existingUnits?: Map<string, WorkflowRunUnitRow>;
}

async function runUnit(input: RunUnitInput): Promise<UnitOutcome> {
  const { plan, template, item, index, isFanOut, env, ctx, dispatcher } = input;
  const unitId = unitIdFor(template, index, isFanOut);
  const prompt = buildUnitPrompt({ plan, template, item, index, isFanOut, ctx, unitId });
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

  // Durable-row reuse: same unit, same input, already completed → return the
  // journaled result without touching the row, dispatching, or re-emitting
  // events. Failed/running/stale-input rows fall through and re-dispatch.
  const prior = input.existingUnits?.get(unitId);
  if (prior && prior.status === "completed" && prior.input_hash === inputHash) {
    return reuseCompletedUnit(unitId, prior, template.schema !== undefined);
  }

  await enqueueUnitWrite(async () => {
    await withWorkflowRunsRepo((repo) =>
      repo.insertUnit({
        runId: ctx.runId,
        unitId,
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
    metadata: { runId: ctx.runId, stepId: plan.stepId, unitId },
  });

  const outcome = await dispatchUnit(request, template, dispatcher);

  await enqueueUnitWrite(async () => {
    await withWorkflowRunsRepo((repo) =>
      repo.finishUnit({
        runId: ctx.runId,
        unitId,
        status: outcome.ok ? "completed" : "failed",
        resultJson:
          outcome.result !== undefined
            ? JSON.stringify(outcome.result)
            : outcome.text
              ? JSON.stringify(outcome.text)
              : null,
        tokens: outcome.tokens ?? null,
        failureReason: outcome.failureReason ?? null,
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
      unitId,
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
  const dispatchOnce = async (feedback?: string): Promise<string> => {
    const result = await dispatcher(request, feedback);
    if (result.usage) {
      sawUsage = true;
      tokens +=
        (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0) + (result.usage.reasoningTokens ?? 0);
    }
    if (!result.ok) throw new UnitTransportError(result);
    return result.text;
  };

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
        return { unitId: request.unitId, ok: true, result: structured.value, ...(sawUsage ? { tokens } : {}) };
      }
      return {
        unitId: request.unitId,
        ok: false,
        failureReason: structured.reason,
        error: structured.errors.join("; "),
        text: structured.raw,
        ...(sawUsage ? { tokens } : {}),
      };
    }

    const text = await dispatchOnce();
    return { unitId: request.unitId, ok: true, text, ...(sawUsage ? { tokens } : {}) };
  } catch (err) {
    if (err instanceof UnitTransportError) {
      return {
        unitId: request.unitId,
        ok: false,
        failureReason: err.result.failureReason ?? "dispatch_error",
        error: err.result.error ?? "unit dispatch failed",
        text: err.result.text,
        ...(sawUsage ? { tokens } : {}),
      };
    }
    return {
      unitId: request.unitId,
      ok: false,
      failureReason: "dispatch_error",
      error: message(err),
      ...(sawUsage ? { tokens } : {}),
    };
  }
}

// ── Prompt assembly ──────────────────────────────────────────────────────────

interface BuildPromptInput {
  plan: IrStepPlan;
  template: IrAgentNode;
  item: unknown;
  index: number;
  isFanOut: boolean;
  ctx: StepExecutionContext;
  unitId: string;
}

function buildUnitPrompt(input: BuildPromptInput): string {
  const { plan, template, item, index, isFanOut, ctx, unitId } = input;
  // Function replacements throughout: a string replacement would interpret
  // GetSubstitution patterns ($&, $$, $', $`) inside item/param VALUES and
  // silently corrupt the prompt (e.g. an item named "a$&b.ts").
  const preamble = unitPreambleTemplate
    .replaceAll("{{RUN_ID}}", () => ctx.runId)
    .replaceAll("{{STEP_ID}}", () => plan.stepId)
    .replaceAll("{{UNIT_ID}}", () => unitId)
    .replaceAll("{{PARAMS_JSON}}", () => safeJson(ctx.params));

  let instructions = template.instructions;
  if (isFanOut) {
    const itemText = typeof item === "string" ? item : safeJson(item);
    instructions = instructions
      .replaceAll("{{item}}", () => itemText)
      .replaceAll("{{item_index}}", () => String(index));
  }
  instructions = instructions.replace(/\{\{params\.([A-Za-z0-9_.-]+)\}\}/g, (_, name: string) => {
    const value = ctx.params[name];
    if (value === undefined) return "";
    return typeof value === "string" ? value : safeJson(value);
  });

  const schemaDirective = template.schema
    ? `\n\nRespond with ONLY a JSON value matching this JSON Schema (no prose, no code fences):\n${safeJson(template.schema)}`
    : "";

  return `${preamble}\n${instructions}${schemaDirective}`;
}

// ── Fan-out source + reducers ────────────────────────────────────────────────

function resolveFanOutSource(over: string, ctx: StepExecutionContext): unknown {
  if (over in ctx.params) return ctx.params[over];
  for (const stepEvidence of Object.values(ctx.evidence)) {
    if (stepEvidence && over in stepEvidence) return stepEvidence[over];
  }
  return undefined;
}

function buildEvidence(units: UnitOutcome[], reducer: "collect" | "vote" | "best-of-n"): Record<string, unknown> {
  const collected = units.map((u) => ({
    unitId: u.unitId,
    ok: u.ok,
    ...(u.result !== undefined ? { result: u.result } : {}),
    ...(u.text !== undefined ? { text: clip(u.text, EVIDENCE_TEXT_CLIP) } : {}),
    ...(u.failureReason ? { failureReason: u.failureReason } : {}),
    ...(u.error ? { error: clip(u.error, 500) } : {}),
  }));
  const evidence: Record<string, unknown> = { units: collected, itemCount: units.length };

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
 * Resolve every `### Env` ref through the extracted `akm env run` core
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

  // `### Env` bindings can only reach a spawned child process. The opencode
  // SDK server is process-wide (no per-call env — plan open decision 1) and
  // the llm runner has no child at all. Failing loudly beats an audit event
  // that claims an injection which never reached the unit.
  if (request.env && Object.keys(request.env).length > 0 && resolved.kind !== "agent") {
    return {
      ok: false,
      text: "",
      failureReason: "env_unsupported",
      error:
        `unit "${request.unitId}" declares "### Env" bindings, which currently require the agent (CLI) runner — ` +
        `the "${resolved.kind}" runner cannot inject a per-unit child environment.`,
    };
  }

  if (resolved.kind === "llm") {
    const { chatCompletion } = await import("../../llm/client.js");
    const { resolveModel } = await import("../../integrations/agent/model-aliases.js");
    const connection = request.model
      ? { ...resolved.connection, model: resolveModel(request.model, "llm", undefined, config.modelAliases) }
      : resolved.connection;
    try {
      const text = await chatCompletion(connection, [{ role: "user", content: prompt }], {
        // null = author declared "### Timeout: none" — cap at the max signed
        // 32-bit delay (setTimeout's ceiling, ~24.8 days ≈ unbounded here).
        timeoutMs: request.timeoutMs === null ? 2 ** 31 - 1 : request.timeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
        // Native structured output where the connection supports it; the
        // executor's subset validator still runs downstream either way.
        ...(request.schema ? { responseSchema: request.schema } : {}),
      });
      return { ok: true, text };
    } catch (err) {
      return { ok: false, text: "", failureReason: "llm_error", error: message(err) };
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
  return {
    ok: result.ok,
    text: result.stdout,
    ...(result.reason ? { failureReason: result.reason } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
  };
};

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
      `or declare a "### Runner" profile on the step.`,
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

function unitIdFor(template: IrAgentNode, index: number, isFanOut: boolean): string {
  return isFanOut ? `${template.id}[${index}]` : template.id;
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
