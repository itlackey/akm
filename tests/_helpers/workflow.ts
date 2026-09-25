import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../../src/core/config/config";
import { captureFrozenDirectoryIdentity } from "../../src/execution/directory-identity";
import type { ExecutionJsonObject } from "../../src/execution/json";
import {
  canonicalResolvedExecutionRequest,
  decodeResolvedExecutionRequest,
  type ResolvedExecutionRequestV1,
} from "../../src/execution/resolved-request";
import type { UnresolvedExecutionDefaults } from "../../src/execution/source";
import { buildExecution, resolveExecution } from "../../src/integrations/agent/execution";
import { MODEL_MAP_VERSION, type ResolvedModelMapV1 } from "../../src/integrations/agent/model-map";
import type { RunnerSpec } from "../../src/integrations/agent/runner";
import {
  defaultLlmEngineConcurrency,
  defaultMapConcurrency,
  workflowMaxConcurrency,
} from "../../src/workflows/concurrency-policy";
import { workflowRunLockPath } from "../../src/workflows/exec/run-workflow";
import { compileWorkflowPlan } from "../../src/workflows/ir/compile";
import { canonicalPlanJson, computePlanHash } from "../../src/workflows/ir/plan-hash";
import {
  decodeWorkflowPlanV4,
  type FrozenWorkflowCommandTarget,
  type FrozenWorkflowEnvironmentBinding,
  type FrozenWorkflowShellTarget,
  type IrStepPlanV4,
  type IrUnitNodeV4,
  WORKFLOW_IR_V5_VERSION,
  type WorkflowPlanGraphV4,
} from "../../src/workflows/ir/schema-v4";
import { parseWorkflow } from "../../src/workflows/parser";
import type { ProgramExec, ProgramUnit } from "../../src/workflows/program/schema";
import { DEFAULT_EXEC_TIMEOUT_MS } from "../../src/workflows/resource-limits";
import { frozenStepRows } from "../../src/workflows/runtime/run-plan";
import type { WorkflowError } from "../../src/workflows/schema";
import { compileWorkflowSource } from "../../src/workflows/source-ir/compile";
import { sourceStepInstructions, sourceStepProgramUnit } from "../../src/workflows/source-ir/program";

export const WORKFLOW_TEST_CONFIG = {
  configVersion: "0.9.0",
  semanticSearchMode: "off",
  engines: {
    "test-agent": { kind: "agent", platform: "opencode-sdk" },
    "test-llm": {
      kind: "llm",
      endpoint: "http://localhost:1/v1/chat/completions",
      model: "test-model",
    },
  },
  defaults: { engine: "test-agent", llmEngine: "test-llm" },
  workflow: { judgeEngine: "test-llm" },
} as const satisfies AkmConfig;

const WORKFLOW_TEST_MODEL_MAP: ResolvedModelMapV1 = Object.freeze({
  version: MODEL_MAP_VERSION,
  aliases: Object.freeze(Object.create(null)) as ResolvedModelMapV1["aliases"],
});

export type WorkflowPlanFixture = WorkflowPlanGraphV4;

/**
 * Compile source bytes into the shared executor-core fixture used by unit
 * tests. Production starts use the durable-v4 freezer; this helper deliberately
 * does not publish a stored plan or recreate the retired new-start-v3 path.
 *
 * `config` defaults to {@link WORKFLOW_TEST_CONFIG}; suites with their own
 * engine catalog pass it explicitly.
 */
export function freezeWorkflow(
  markdown: string,
  sourcePath = "workflows/demo.md",
  config: AkmConfig = WORKFLOW_TEST_CONFIG,
): WorkflowPlanFixture {
  const compiledSource = compileWorkflowSource(markdown, { path: sourcePath, workspaceRoot: "/tmp" });
  if (!compiledSource.ok) {
    throw new Error(compiledSource.errors.map((error) => `${error.line}: ${error.message}`).join(" | "));
  }
  const title =
    sourcePath
      .split("/")
      .pop()
      ?.replace(/\.(?:md|yml)$/i, "") || "demo";
  const sourceSteps = compiledSource.ir.jobs[0]?.steps ?? [];
  const resolvedUnits = new Map(
    sourceSteps
      .filter((step) => step.route === undefined)
      .map(
        (step) => [step.id, { unit: sourceStepProgramUnit(step), instructions: sourceStepInstructions(step) }] as const,
      ),
  );
  const compiled = compileWorkflowPlan(compiledSource.ir, title, resolvedUnits);
  if (!compiled.ok) {
    throw new Error(compiled.errors.map((error) => `${error.line}: ${error.message}`).join(" | "));
  }
  const sourceById = new Map(sourceSteps.map((step) => [step.id, step]));
  const steps: IrStepPlanV4[] = compiled.plan.steps.map((step) => {
    const source = sourceById.get(step.stepId);
    if (!source) throw new Error(`missing source step ${step.stepId}`);
    const programUnit = resolvedUnits.get(step.stepId)?.unit;
    const root = step.root
      ? step.root.kind === "map"
        ? {
            ...step.root,
            concurrency: step.root.concurrency ?? defaultMapConcurrency(config.workflow?.defaultMapConcurrency),
            template: freezeCurrentUnit(
              step.root.template,
              programUnit,
              source.env,
              config,
              compiledSource.ir.defaults,
            ),
          }
        : freezeCurrentUnit(step.root, programUnit, source.env, config, compiledSource.ir.defaults)
      : undefined;
    const frozenJudge =
      step.gate.criteria.length > 0
        ? freezeCommandTarget(step.gate.criteria.join("\n"), { engine: config.workflow?.judgeEngine }, config)
        : null;
    const { root: _root, gate: _gate, ...base } = step;
    return {
      ...base,
      ...(root ? { root } : {}),
      gate: { ...step.gate, maxLoops: step.gate.maxLoops ?? 1, frozenJudge },
    };
  });
  return decodeWorkflowPlanV4({
    irVersion: WORKFLOW_IR_V5_VERSION,
    title,
    ...(compiled.plan.params ? { params: compiled.plan.params } : {}),
    ...(compiled.plan.paramSchemas ? { paramSchemas: compiled.plan.paramSchemas } : {}),
    ...(compiled.plan.budget ? { budget: compiled.plan.budget } : {}),
    execution: { maxConcurrency: workflowMaxConcurrency(config.workflow?.maxConcurrency) },
    sourceReadSet: [
      {
        identity: {
          ref: `test//${sourcePath.replace(/\.(?:md|yml)$/i, "")}`,
          bundle: "test",
          adapter: "akm-workflow",
          file: sourcePath,
          hash: createHash("sha256").update(markdown).digest("hex"),
        },
        containmentPhysicalIdentity: "test-fixture-root",
        physicalIdentity: createHash("sha256").update(`${sourcePath}\0${markdown}`).digest("hex"),
        size: Buffer.byteLength(markdown),
      },
    ],
    steps,
  });
}

type ExecutionUnitLike = Partial<Pick<ProgramUnit, "engine" | "model" | "llm" | "timeoutMs" | "output">>;

function executionValues(unit: ExecutionUnitLike | undefined, workspace = "/tmp"): UnresolvedExecutionDefaults {
  return {
    ...(unit && Object.hasOwn(unit, "engine") ? { engine: unit.engine } : {}),
    ...(unit && Object.hasOwn(unit, "model") ? { model: unit.model } : {}),
    ...(unit && Object.hasOwn(unit, "llm") ? { inference: unit.llm as ExecutionJsonObject } : {}),
    ...(unit && Object.hasOwn(unit, "timeoutMs") ? { timeout: unit.timeoutMs } : {}),
    ...(unit && Object.hasOwn(unit, "output") ? { outputSchema: unit.output as ExecutionJsonObject | null } : {}),
    workspace,
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
): FrozenWorkflowCommandTarget {
  const prepared = resolveExecution({
    content: instructions,
    config,
    modelMap: WORKFLOW_TEST_MODEL_MAP,
    ...(invocationDefaults ? { invocationDefaults } : {}),
    current,
  });
  const resolved = durableRequest(prepared.request);
  const cwdIdentity = captureFrozenDirectoryIdentity("/tmp");
  const runner = buildExecution(resolved, prepared.runner).runner;
  const request = JSON.parse(canonicalResolvedExecutionRequest(resolved)) as ResolvedExecutionRequestV1;
  return Object.freeze({
    kind: "command",
    ref: null,
    contentHash: createHash("sha256").update(request.command.content).digest("hex"),
    request,
    runner,
    ...(targetConcurrency(runner, config) ? { concurrency: targetConcurrency(runner, config) } : {}),
    cwdIdentity,
  });
}

function targetConcurrency(runner: RunnerSpec, config: AkmConfig): number | undefined {
  if (runner.kind === "llm") {
    const configured = typeof runner.engine === "string" ? config.engines?.[runner.engine] : undefined;
    return defaultLlmEngineConcurrency(
      runner.connection.endpoint,
      configured?.kind === "llm" ? configured.concurrency : undefined,
    );
  }
  if (runner.kind !== "sdk" || !runner.fallbackConnection) return undefined;
  const selected = typeof runner.engine === "string" ? config.engines?.[runner.engine] : undefined;
  const fallbackName = selected?.kind === "agent" ? (selected.llmEngine ?? config.defaults?.llmEngine) : undefined;
  const fallback = fallbackName ? config.engines?.[fallbackName] : undefined;
  return defaultLlmEngineConcurrency(
    runner.fallbackConnection.endpoint,
    fallback?.kind === "llm" ? fallback.concurrency : undefined,
  );
}

function frozenEnvironment(exec: ProgramExec | undefined, literals: Readonly<Record<string, unknown>> | undefined) {
  const bindings: FrozenWorkflowEnvironmentBinding[] = [
    ...Object.entries(literals ?? {}).map(([name, value]) => ({
      kind: "literal" as const,
      name,
      value: String(value),
    })),
    ...(exec?.passEnv ?? []).map((name) => ({ kind: "pass-through" as const, name })),
  ];
  return Object.freeze(bindings);
}

function freezeCurrentUnit(
  node: import("../../src/workflows/ir/compile").WorkflowUnitDraft,
  unit: ProgramUnit | undefined,
  literals: Readonly<Record<string, unknown>> | undefined,
  config: AkmConfig,
  defaults: ExecutionUnitLike | undefined,
): IrUnitNodeV4 {
  if (unit?.env?.length)
    throw new Error("freezeWorkflow test fixtures do not resolve env assets; use a v4 source test");
  const environment = frozenEnvironment(unit?.exec, literals);
  let frozenTarget: FrozenWorkflowCommandTarget | FrozenWorkflowShellTarget;
  if (unit?.exec) {
    const declaredTimeout = Object.hasOwn(unit, "timeoutMs")
      ? unit.timeoutMs
      : defaults && Object.hasOwn(defaults, "timeoutMs")
        ? defaults.timeoutMs
        : DEFAULT_EXEC_TIMEOUT_MS;
    const exec = {
      ...unit.exec,
      command: unit.exec.command as [string, ...string[]],
      timeoutMs: declaredTimeout ?? null,
    };
    const cwdIdentity = captureFrozenDirectoryIdentity("/tmp", unit.exec.cwd);
    frozenTarget = {
      kind: "shell",
      contentHash: createHash("sha256")
        .update("akm.workflow.shell.v1\0")
        .update(canonicalPlanJson({ exec, environment, cwdIdentity }))
        .digest("hex"),
      exec,
      cwdIdentity,
    };
  } else {
    frozenTarget = freezeCommandTarget(node.instructions, executionValues(unit), config, executionValues(defaults));
  }
  const { exec: _exec, ...common } = node;
  return Object.freeze({ ...common, isolation: common.isolation ?? "none", frozenTarget, environment });
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
    /** Defaults to `dir:v1:<workflowRef basename>`. */
    scopeKey?: string;
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
  const scopeKey = options.scopeKey ?? `dir:v1:${workflowRef.split("/").pop()}`;
  const steps = options.steps.map((step) => (typeof step === "string" ? { stepId: step } : step));
  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
        params_json, current_step_id, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, 'active', ?, ?, ?, ?)`,
  ).run(
    options.runId,
    workflowRef,
    scopeKey,
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
  plan: WorkflowPlanGraphV4,
): void {
  for (const step of frozenStepRows(plan)) {
    db.prepare(
      `UPDATE workflow_run_steps
         SET step_title = ?, instructions = ?, completion_json = ?, sequence_index = ?
         WHERE run_id = ? AND step_id = ?`,
    ).run(step.stepTitle, step.instructions, step.completionJson, step.sequenceIndex, runId, step.stepId);
  }
  db.prepare("UPDATE workflow_runs SET plan_json = ?, plan_hash = ?, plan_ir_version = 5 WHERE id = ?").run(
    canonicalPlanJson(plan),
    computePlanHash(plan),
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
