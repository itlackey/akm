import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { AkmConfig } from "../../src/core/config/config";
import type { ExecutionJsonObject } from "../../src/execution/json";
import {
  canonicalResolvedExecutionRequest,
  decodeResolvedExecutionRequest,
  type ResolvedExecutionRequestV1,
} from "../../src/execution/resolved-request";
import type { UnresolvedExecutionDefaults } from "../../src/execution/source";
import { buildExecution, currentLayer, resolveExecution } from "../../src/integrations/agent/execution";
import { checkWorkflowPlan, compileWorkflowSource, workflowStepInstructions } from "../../src/workflows/compile";
import { defaultMapConcurrency, workflowMaxConcurrency } from "../../src/workflows/concurrency-policy";
import {
  executeStepPlan as executeStepPlanInRoot,
  type StepExecutionContext,
  type StepExecutionResult,
} from "../../src/workflows/exec/native-executor";
import {
  type RunWorkflowOptions,
  type RunWorkflowResult,
  runWorkflowSteps as runWorkflowStepsInRoot,
  workflowRunLockPath,
} from "../../src/workflows/exec/run-workflow";
import { targetConcurrency } from "../../src/workflows/freeze/step-values";
import { canonicalPlanJson, computePlanHash } from "../../src/workflows/ir/plan-hash";
import { parseWorkflow } from "../../src/workflows/parser";
import {
  type FrozenWorkflowCommandTarget,
  type FrozenWorkflowEnvironmentBinding,
  type FrozenWorkflowShellTarget,
  WORKFLOW_PLAN_VERSION,
  type WorkflowError,
  type WorkflowExec,
  type WorkflowExecNode,
  type WorkflowPlan,
  type WorkflowPlanStep,
  type WorkflowUnitNode,
  type WorkflowUnitSettings,
} from "../../src/workflows/plan";
import { DEFAULT_EXEC_TIMEOUT_MS } from "../../src/workflows/resource-limits";
import { decodeWorkflowPlan, frozenStepRows } from "../../src/workflows/runtime/run-plan";

export const WORKFLOW_TEST_CONFIG = {
  configVersion: "0.9.0",
  semanticSearchMode: "off",
  connections: {
    "test-llm": {
      endpoint: "http://localhost:1/v1",
      models: { fast: "test-model", balanced: "test-model", reasoning: "test-model" },
    },
  },
} as const satisfies AkmConfig;

/**
 * The directory units and the gate judge work in for a test whose run is seeded without a bundle: its workflow ref
 * (`workflows/demo`) resolves to nothing, so `bundleRootOverride` is the one seam that names the root.
 */
export const WORKFLOW_FIXTURE_ROOT = os.tmpdir();

/** `runWorkflowSteps` with {@link WORKFLOW_FIXTURE_ROOT} as the bundle root unless the test names one. */
export function runWorkflowSteps(options: RunWorkflowOptions): Promise<RunWorkflowResult> {
  return runWorkflowStepsInRoot({ bundleRootOverride: WORKFLOW_FIXTURE_ROOT, ...options });
}

/** `executeStepPlan` with {@link WORKFLOW_FIXTURE_ROOT} as the bundle root unless the test names one. */
export function executeStepPlan(
  plan: Parameters<typeof executeStepPlanInRoot>[0],
  ctx: StepExecutionContext,
): Promise<StepExecutionResult> {
  return executeStepPlanInRoot(plan, { bundleRootOverride: WORKFLOW_FIXTURE_ROOT, ...ctx });
}

export type WorkflowPlanFixture = WorkflowPlan;

/**
 * Compile source bytes and freeze them into an executable plan without
 * touching the bundle: command targets resolve against `config` directly and
 * nothing is published. Production freezes through `freeze/freeze.ts`.
 *
 * `config` defaults to {@link WORKFLOW_TEST_CONFIG}; suites with their own
 * engine catalog pass it explicitly.
 */
export function freezeWorkflow(
  markdown: string,
  sourcePath = "workflows/demo.md",
  config: AkmConfig = WORKFLOW_TEST_CONFIG,
): WorkflowPlanFixture {
  const compiled = compileWorkflowSource(markdown, { path: sourcePath });
  if (!compiled.ok) {
    throw new Error(compiled.errors.map((error) => `${error.line}: ${error.message}`).join(" | "));
  }
  const checked = checkWorkflowPlan(compiled.plan);
  if (!checked.ok) {
    throw new Error(checked.errors.map((error) => `${error.line}: ${error.message}`).join(" | "));
  }
  const title =
    sourcePath
      .split("/")
      .pop()
      ?.replace(/\.(?:md|yml)$/i, "") || "demo";
  const defaults = compiled.plan.defaults;
  const steps: WorkflowPlanStep[] = compiled.plan.steps.map((step) => {
    const { spec, ...base } = step;
    const root = spec ? freezeRoot(step, config, defaults) : undefined;
    const frozenJudge =
      step.gate.criteria.length > 0
        ? freezeCommandTarget(step.gate.criteria.join("\n"), {}, config, undefined, true)
        : null;
    return { ...base, ...(root ? { root } : {}), gate: { ...step.gate, frozenJudge } };
  });
  return decodeWorkflowPlan({
    irVersion: WORKFLOW_PLAN_VERSION,
    title,
    ...(compiled.plan.params ? { params: compiled.plan.params } : {}),
    ...(compiled.plan.paramSchemas ? { paramSchemas: compiled.plan.paramSchemas } : {}),
    ...(compiled.plan.budget ? { budget: compiled.plan.budget } : {}),
    execution: { maxConcurrency: workflowMaxConcurrency(config.workflow?.maxConcurrency) },
    sourceHash: createHash("sha256").update(markdown).digest("hex"),
    steps,
  });
}

type ExecutionUnitLike = Partial<
  Pick<WorkflowUnitSettings, "connection" | "harness" | "engine" | "model" | "llm" | "timeoutMs" | "output">
>;

function executionValues(unit: ExecutionUnitLike | undefined): UnresolvedExecutionDefaults {
  return {
    ...(unit && Object.hasOwn(unit, "connection") ? { connection: unit.connection } : {}),
    ...(unit && Object.hasOwn(unit, "harness") ? { harness: unit.harness } : {}),
    ...(unit && Object.hasOwn(unit, "engine") ? { engine: unit.engine } : {}),
    ...(unit && Object.hasOwn(unit, "model") ? { model: unit.model } : {}),
    ...(unit && Object.hasOwn(unit, "llm") ? { inference: unit.llm as ExecutionJsonObject } : {}),
    ...(unit && Object.hasOwn(unit, "timeoutMs") ? { timeout: unit.timeoutMs } : {}),
    ...(unit && Object.hasOwn(unit, "output") ? { outputSchema: unit.output as ExecutionJsonObject | null } : {}),
  };
}

function durableRequest(request: ResolvedExecutionRequestV1): ResolvedExecutionRequestV1 {
  const wire = JSON.parse(canonicalResolvedExecutionRequest(request)) as Record<string, unknown>;
  const runtime = { ...(wire.runtime as Record<string, unknown>) };
  delete runtime.environment;
  wire.runtime = runtime;
  return decodeResolvedExecutionRequest(wire);
}

function freezeCommandTarget(
  instructions: string,
  current: UnresolvedExecutionDefaults,
  config: AkmConfig,
  invocationDefaults?: UnresolvedExecutionDefaults,
  modelWork = false,
): FrozenWorkflowCommandTarget {
  const prepared = resolveExecution({
    content: instructions,
    config,
    layers: [
      ...(invocationDefaults
        ? [{ id: "invocation-defaults", kind: "invocation-defaults" as const, values: invocationDefaults }]
        : []),
      currentLayer(current),
    ],
    modelWork,
  });
  const resolved = durableRequest(prepared.request);
  const runner = buildExecution(resolved, prepared.runner).runner;
  const request = JSON.parse(canonicalResolvedExecutionRequest(resolved)) as ResolvedExecutionRequestV1;
  return Object.freeze({
    kind: "command",
    ref: null,
    contentHash: createHash("sha256").update(request.command.content).digest("hex"),
    request,
    runner,
    ...(targetConcurrency(runner) ? { concurrency: targetConcurrency(runner) } : {}),
  });
}

function frozenEnvironment(exec: WorkflowExec | undefined) {
  const bindings: FrozenWorkflowEnvironmentBinding[] = (exec?.passEnv ?? []).map((name) => ({
    kind: "pass-through" as const,
    name,
  }));
  return Object.freeze(bindings);
}

function freezeRoot(step: WorkflowPlanStep, config: AkmConfig, defaults: WorkflowPlan["defaults"]): WorkflowExecNode {
  const spec = step.spec;
  if (!spec) throw new Error(`missing spec for step ${step.stepId}`);
  const unit = spec.unit;
  if (unit?.env?.length)
    throw new Error("freezeWorkflow test fixtures do not resolve env assets; use a v4 source test");
  const environment = frozenEnvironment(spec.exec);
  const instructions = workflowStepInstructions(step);
  let frozenTarget: FrozenWorkflowCommandTarget | FrozenWorkflowShellTarget;
  if (spec.exec) {
    const declaredTimeout =
      unit && Object.hasOwn(unit, "timeoutMs")
        ? unit.timeoutMs
        : defaults && Object.hasOwn(defaults, "timeoutMs")
          ? defaults.timeoutMs
          : DEFAULT_EXEC_TIMEOUT_MS;
    const exec = {
      ...spec.exec,
      command: spec.exec.command as [string, ...string[]],
      timeoutMs: declaredTimeout ?? null,
    };
    frozenTarget = {
      kind: "shell",
      contentHash: createHash("sha256")
        .update("akm.workflow.shell.v1\0")
        .update(canonicalPlanJson({ exec, environment }))
        .digest("hex"),
      exec,
    };
  } else {
    frozenTarget = freezeCommandTarget(instructions, executionValues(unit), config, executionValues(defaults));
  }
  const node: WorkflowUnitNode = {
    kind: "unit",
    id: spec.map ? `${step.stepId}.unit` : step.stepId,
    instructions,
    ...(spec.inputs?.length ? { inputs: [...spec.inputs] } : {}),
    ...(unit?.output !== undefined ? { schema: unit.output } : {}),
    ...(unit?.retry ? { retry: unit.retry } : {}),
    onError: unit?.onError ?? defaults?.onError ?? "fail",
    ...(unit?.env ? { env: unit.env } : {}),
    source: spec.source,
    frozenTarget,
    environment,
  };
  if (!spec.map) return node;
  return {
    kind: "map",
    id: `${step.stepId}.map`,
    over: spec.map.over,
    template: node,
    concurrency: spec.map.concurrency ?? defaultMapConcurrency(config.workflow?.defaultMapConcurrency),
    reducer: spec.map.reducer ?? "collect",
    source: spec.source,
  };
}

/** Parse a workflow document and return its parser errors (`[]` when it parses cleanly). */
export function parseErrors(markdown: string, sourcePath = "workflows/test.md"): WorkflowError[] {
  const result = parseWorkflow(markdown, { path: sourcePath });
  return result.ok ? [] : result.errors;
}

/**
 * Build a minimal one-step workflow document around a `work` step.
 *
 * `stepLines` are extra frontmatter lines under `  - id: work` (already
 * indented by the caller), `body` is the markdown after the frontmatter, and
 * `extra` lines land between `type: workflow` and `steps:` (e.g. `defaults:`
 * or `params:` blocks).
 */
export function workflowDoc(stepLines: string[], body = "## work\n\nDo it.\n", extra: string[] = []): string {
  return ["---", "type: workflow", ...extra, "steps:", "  - id: work", ...stepLines, "---", "", body].join("\n");
}

export interface SeedWorkflowRunStep {
  stepId: string;
  /** Defaults to `stepId`. */
  stepTitle?: string;
  /** Defaults to `"instructions"`. */
  instructions?: string;
  /** Defaults to `null`. */
  completionJson?: string | null;
}

/**
 * Seed the `workflow_runs` + `workflow_run_steps` rows an executable run
 * starts from — the INSERT boilerplate every integration suite otherwise
 * hand-rolls. Steps are inserted `pending` with contiguous sequence indexes;
 * a bare string step is shorthand for `{ stepId }`.
 */
export function seedWorkflowRun(
  db: { prepare(sql: string): { run(...params: unknown[]): unknown } },
  options: {
    runId: string;
    steps: Array<string | SeedWorkflowRunStep>;
    /** Defaults to `"workflows/demo"`. */
    workflowRef?: string;
    /** Defaults to `"Demo"`. */
    workflowTitle?: string;
    /** Defaults to `{}`. */
    params?: Record<string, unknown>;
    /** Defaults to the first step's id. */
    currentStepId?: string;
  },
): void {
  const now = new Date().toISOString();
  const workflowRef = options.workflowRef ?? "workflows/demo";
  const steps = options.steps.map((step) => (typeof step === "string" ? { stepId: step } : step));
  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_ref, workflow_title, status,
        params_json, current_step_id, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
  ).run(
    options.runId,
    workflowRef,
    options.workflowTitle ?? "Demo",
    JSON.stringify(options.params ?? {}),
    options.currentStepId ?? steps[0]!.stepId,
    now,
    now,
  );
  steps.forEach((step, index) => {
    db.prepare(
      `INSERT INTO workflow_run_steps
         (run_id, step_id, step_title, instructions, completion_json, sequence_index, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    ).run(
      options.runId,
      step.stepId,
      step.stepTitle ?? step.stepId,
      step.instructions ?? "instructions",
      step.completionJson ?? null,
      index,
    );
  });
}

export function storeFrozenWorkflowPlan(
  db: { prepare(sql: string): { run(...params: unknown[]): unknown } },
  runId: string,
  plan: WorkflowPlan,
): void {
  for (const step of frozenStepRows(plan)) {
    db.prepare(
      `UPDATE workflow_run_steps
         SET step_title = ?, instructions = ?, completion_json = ?, sequence_index = ?
         WHERE run_id = ? AND step_id = ?`,
    ).run(step.stepTitle, step.instructions, step.completionJson, step.sequenceIndex, runId, step.stepId);
  }
  db.prepare("UPDATE workflow_runs SET plan_json = ?, plan_hash = ?, plan_ir_version = ? WHERE id = ?").run(
    canonicalPlanJson(plan),
    computePlanHash(plan),
    WORKFLOW_PLAN_VERSION,
    runId,
  );
}

/**
 * Plant the per-run lock another akm process would hold while driving
 * `runId`. The default holder is THIS test process — alive, so the lock reads
 * as held; pass a dead pid (e.g. `999_999_999`) for a crashed holder. Returns
 * a release function.
 */
export function plantRunLock(runId: string, pid: number = process.pid): () => void {
  const lockPath = workflowRunLockPath(runId);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid, startedAt: new Date().toISOString() }), { flag: "wx" });
  return () => fs.rmSync(lockPath, { force: true });
}

/** One step of a markdown parent that runs a child workflow (`unit.workflow`, optional `with`). */
export interface ChildStepFixture {
  readonly id: string;
  readonly workflow: string;
  readonly with?: Record<string, unknown>;
}

/** A markdown workflow whose every step runs a child workflow. */
export function childParentDoc(steps: readonly ChildStepFixture[]): string {
  const frontmatter = {
    type: "workflow",
    steps: steps.map((step) => ({
      id: step.id,
      unit: { workflow: step.workflow, ...(step.with ? { with: step.with } : {}) },
    })),
  };
  const body = steps.map((step) => `## ${step.id}\n\nRun ${step.workflow}.\n`).join("\n");
  return `---\n${stringifyYaml(frontmatter)}---\n\n${body}`;
}
