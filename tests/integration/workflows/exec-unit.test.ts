// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `exec` (shell) unit DISPATCH path, against real subprocesses.
 *
 * Unlike the rest of the workflow suite these tests do not inject a fake
 * dispatcher: an exec unit's whole value is that it really spawns a process, so
 * a fake would test nothing that matters. The child is always `process.execPath`
 * (the bun binary already running the suite) with `-e`, so there is no
 * dependency on any external tool beyond `git` for the worktree case.
 *
 * The authoring surface (parser / freeze / decoder / hashing) is covered purely
 * in `tests/workflows/exec-unit-authoring.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { openStateDatabase } from "../../../src/core/state-db";
import { readStream, runManagedSubprocess } from "../../../src/core/subprocess";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { EXEC_DEFAULT_ENV_PASSTHROUGH, runExecUnit } from "../../../src/workflows/exec/exec-unit";
import {
  defaultUnitDispatcher,
  executeStepPlan as executeFrozenStepPlan,
  type StepExecutionContext,
  type StepExecutionResult,
} from "../../../src/workflows/exec/native-executor";
import { cpuDerivedUnitConcurrency } from "../../../src/workflows/exec/scheduler";
import type { IrStepPlan, WorkflowPlanGraph } from "../../../src/workflows/ir/schema";
import {
  execContextLimits,
  WORKFLOW_EXEC_OUTPUT_TRUNCATED_MARKER,
  WORKFLOW_MAX_EXEC_CONTEXT_VAR_BYTES_WIN32,
  WORKFLOW_MAX_EXEC_OUTPUT_BYTES,
} from "../../../src/workflows/resource-limits";
import { requireExecutableWorkflowPlan } from "../../../src/workflows/runtime/plan-classifier";
import { getWorkflowStatus } from "../../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";
import { freezeWorkflow, storeFrozenWorkflowPlan } from "../../_helpers/workflow";

let storage: IsolatedAkmStorage;
/** Scratch root for fixtures the workflow itself touches (never akm storage). */
let tmpDir = "";
let workDir = "";

const RUN_ID = "55555555-5555-4555-8555-555555555555";
const BUN = process.execPath;

/** A child that runs `code` under the bun binary already running this suite. */
function bunArgv(code: string): string[] {
  return [BUN, "-e", code];
}

function seedRun(steps: string[], params: Record<string, unknown> = {}): void {
  const db = openStateDatabase();
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
          params_json, current_step_id, created_at, updated_at)
       VALUES (?, 'workflows/exec-demo', 'dir:v1:exec-demo', NULL, 'Exec demo', 'active', ?, ?, ?, ?)`,
    ).run(RUN_ID, JSON.stringify(params), steps[0]!, now, now);
    steps.forEach((stepId, index) => {
      db.prepare(
        `INSERT INTO workflow_run_steps
           (run_id, step_id, step_title, instructions, completion_json, sequence_index, status)
         VALUES (?, ?, ?, 'instructions', NULL, ?, 'pending')`,
      ).run(RUN_ID, stepId, stepId, index);
    });
  } finally {
    db.close();
  }
}

function storePlan(plan: WorkflowPlanGraph): void {
  const db = openStateDatabase();
  try {
    storeFrozenWorkflowPlan(db, RUN_ID, plan);
  } finally {
    db.close();
  }
}

/** Freeze a one-step exec workflow whose `unit:` block is spelled by the caller. */
function execPlan(unitLines: string[], opts: { stepId?: string; body?: string; extra?: string[] } = {}) {
  const stepId = opts.stepId ?? "work";
  const markdown = [
    "---",
    "type: workflow",
    ...(opts.extra ?? []),
    "steps:",
    `  - id: ${stepId}`,
    ...unitLines,
    "---",
    "",
    `## ${stepId}`,
    "",
    opts.body ?? "Run the command.",
    "",
  ].join("\n");
  return freezeWorkflow(markdown);
}

function run(plan: WorkflowPlanGraph, ctx: Partial<StepExecutionContext> = {}): Promise<StepExecutionResult> {
  const step: IrStepPlan = plan.steps[0]!;
  return executeFrozenStepPlan(step, {
    runId: RUN_ID,
    workflowRef: "workflows/exec-demo",
    params: {},
    evidence: {},
    engines: plan.execution.engines,
    workDir,
    ...ctx,
  });
}

async function unitRows(): Promise<
  Array<{
    unit_id: string;
    status: string;
    result_json: string | null;
    failure_reason: string | null;
    runner: string | null;
    engine?: string | null;
  }>
> {
  return (await withWorkflowRunsRepo((repo) => repo.getUnitsForStep(RUN_ID, "work"))) as never;
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  tmpDir = path.join(storage.root, "scratch");
  workDir = path.join(tmpDir, "work");
  fs.mkdirSync(workDir, { recursive: true });
});

afterEach(() => {
  storage.cleanup();
});

describe("exec unit — a passing command", () => {
  test("stdout is the promoted artifact, with trailing newlines stripped", async () => {
    seedRun(["work"]);
    const plan = execPlan([
      "    unit:",
      "      exec:",
      `        command: ${JSON.stringify(bunArgv("process.stdout.write('built ok\\n\\n')"))}`,
    ]);
    storePlan(plan);
    const result = await run(plan);
    expect(result.ok).toBe(true);
    expect(result.evidence.output).toBe("built ok");
    expect(result.units[0]!.ok).toBe(true);
  });

  test("the unit row journals runner=exec with no engine, and status completed", async () => {
    seedRun(["work"]);
    const plan = execPlan([
      "    unit:",
      "      exec:",
      `        command: ${JSON.stringify(bunArgv("process.stdout.write('x')"))}`,
    ]);
    storePlan(plan);
    await run(plan);
    const rows = await unitRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.runner).toBe("exec");
    expect(rows[0]!.engine ?? null).toBeNull();
    expect(rows[0]!.status).toBe("completed");
    expect(JSON.parse(rows[0]!.result_json!)).toBe("x");
  });

  test("the command really runs in the engine's working directory", async () => {
    seedRun(["work"]);
    const plan = execPlan([
      "    unit:",
      "      exec:",
      `        command: ${JSON.stringify(bunArgv("process.stdout.write(process.cwd())"))}`,
    ]);
    storePlan(plan);
    const result = await run(plan);
    expect(fs.realpathSync(String(result.evidence.output))).toBe(fs.realpathSync(workDir));
  });

  test("a relative `cwd:` runs inside a subdirectory of the working directory", async () => {
    fs.mkdirSync(path.join(workDir, "packages", "core"), { recursive: true });
    seedRun(["work"]);
    const plan = execPlan([
      "    unit:",
      "      exec:",
      `        command: ${JSON.stringify(bunArgv("process.stdout.write(process.cwd())"))}`,
      "        cwd: packages/core",
    ]);
    storePlan(plan);
    const result = await run(plan);
    expect(fs.realpathSync(String(result.evidence.output))).toBe(
      fs.realpathSync(path.join(workDir, "packages", "core")),
    );
  });
});

describe("exec unit — argv is never shell-interpreted", () => {
  test("shell metacharacters in an argument are inert literal bytes", async () => {
    seedRun(["work"]);
    // If ANY shell were involved, `; touch pwned` would run `touch`, `$(…)`
    // would substitute, `&&` would chain, and `*` would glob. All of it must
    // arrive at the child as one literal argv entry.
    const hostile = "; touch pwned && echo $(whoami) `id` * > out.txt | cat";
    const plan = execPlan([
      "    unit:",
      "      exec:",
      `        command: ${JSON.stringify([BUN, "-e", "process.stdout.write(process.argv[process.argv.length - 1] ?? '')", hostile])}`,
    ]);
    storePlan(plan);
    const result = await run(plan);

    expect(result.ok).toBe(true);
    // The metacharacters came back byte-for-byte: nothing parsed them.
    expect(result.evidence.output).toBe(hostile);
    // ...and nothing a shell would have done actually happened.
    expect(fs.existsSync(path.join(workDir, "pwned"))).toBe(false);
    expect(fs.existsSync(path.join(workDir, "out.txt"))).toBe(false);
    expect(fs.readdirSync(workDir)).toEqual([]);
  });
});

describe("exec unit — failure semantics", () => {
  test("a non-zero exit fails the unit with `non_zero_exit` and fails the step (on_error: fail)", async () => {
    seedRun(["work"]);
    const plan = execPlan([
      "    unit:",
      "      exec:",
      `        command: ${JSON.stringify(bunArgv("process.stderr.write('boom\\n'); process.exit(3)"))}`,
    ]);
    storePlan(plan);
    const result = await run(plan);
    expect(result.ok).toBe(false);
    expect(result.units[0]!.failureReason).toBe("non_zero_exit");
    expect(result.units[0]!.error).toContain("exited 3");
    expect(result.units[0]!.error).toContain("boom");
    const rows = await unitRows();
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.failure_reason).toBe("non_zero_exit");
  });

  test("`on_error: continue` records the failure and lets the step pass", async () => {
    seedRun(["work"]);
    const plan = execPlan([
      "    unit:",
      "      exec:",
      `        command: ${JSON.stringify(bunArgv("process.exit(1)"))}`,
      "      on_error: continue",
    ]);
    storePlan(plan);
    const result = await run(plan);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("on_error: continue");
    expect(result.units[0]!.failureReason).toBe("non_zero_exit");
  });

  test("`retry: { on: [non_zero_exit] }` re-runs the command and journals every attempt", async () => {
    seedRun(["work"]);
    const marker = path.join(tmpDir, "attempts.log");
    const code = `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x'); process.exit(9)`;
    const plan = execPlan([
      "    unit:",
      "      exec:",
      `        command: ${JSON.stringify(bunArgv(code))}`,
      "      retry: { max: 2, on: [non_zero_exit] }",
    ]);
    storePlan(plan);
    const result = await run(plan);
    expect(result.ok).toBe(false);
    // 1 initial attempt + 2 retries = 3 real executions...
    expect(fs.readFileSync(marker, "utf8")).toBe("xxx");
    // ...each with its own journal row (`~r1`, `~r2` on top of the base id).
    const rows = await unitRows();
    expect(rows.map((r) => r.unit_id).sort()).toEqual(["work:solo", "work:solo~r1", "work:solo~r2"]);
    expect(rows.every((r) => r.failure_reason === "non_zero_exit")).toBe(true);
  });

  test("a failure reason OUTSIDE the declared retry.on is not retried", async () => {
    seedRun(["work"]);
    const marker = path.join(tmpDir, "attempts.log");
    const code = `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x'); process.exit(9)`;
    const plan = execPlan([
      "    unit:",
      "      exec:",
      `        command: ${JSON.stringify(bunArgv(code))}`,
      "      retry: { max: 3, on: [timeout] }",
    ]);
    storePlan(plan);
    await run(plan);
    expect(fs.readFileSync(marker, "utf8")).toBe("x");
  });

  test("a missing binary fails with `spawn_failed` without journaling a completed row", async () => {
    seedRun(["work"]);
    const plan = execPlan([
      "    unit:",
      "      exec:",
      '        command: ["akm-definitely-not-a-real-binary-9f2a", "--version"]',
    ]);
    storePlan(plan);
    const result = await run(plan);
    expect(result.ok).toBe(false);
    expect(result.units[0]!.failureReason).toBe("spawn_failed");
  });
});

describe("exec unit — timeout and abort really kill the process", () => {
  test("a command that outlives its timeout is terminated and reported as `timeout`", async () => {
    seedRun(["work"]);
    const marker = path.join(tmpDir, "survived.txt");
    // Sleeps far past the 400ms budget, then would write a marker. If the kill
    // ladder did not reach it, the marker appears.
    const code = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 10000)`;
    const plan = execPlan([
      "    unit:",
      "      exec:",
      `        command: ${JSON.stringify(bunArgv(code))}`,
      '      timeout: "400ms"',
    ]);
    storePlan(plan);

    const result = await run(plan);

    expect(result.ok).toBe(false);
    expect(result.units[0]!.failureReason).toBe("timeout");
    // The OBSERVABLE proof that the kill really landed: the step settled while
    // the child still had ~9.5s of its own sleep left, and the marker the child
    // would have written never appears — even after we wait past its deadline.
    // (No wall-clock assertion: the settle itself is the evidence, since a
    // surviving child would make the marker exist.)
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(fs.existsSync(marker)).toBe(false);
  }, 30_000);

  test("aborting the invocation cancels the running command with `aborted`", async () => {
    seedRun(["work"]);
    const marker = path.join(tmpDir, "survived-abort.txt");
    const code = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 10000)`;
    const plan = execPlan([
      "    unit:",
      "      exec:",
      `        command: ${JSON.stringify(bunArgv(code))}`,
      '      timeout: "none"',
    ]);
    storePlan(plan);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    // `timeout: "none"` means only the abort can end this — if the signal were
    // ignored the step would hang on the child's own 10s sleep and this test
    // would fail on its own timeout rather than pass slowly.
    const result = await run(plan, { signal: controller.signal });

    expect(result.ok).toBe(false);
    expect(result.units[0]!.failureReason).toBe("aborted");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(fs.existsSync(marker)).toBe(false);
  }, 30_000);

  test("a killed command does not leave orphaned grandchildren", async () => {
    seedRun(["work"]);
    const marker = path.join(tmpDir, "grandchild.txt");
    // The unit's child spawns its OWN detached-from-us grandchild that would
    // write a marker. The kill ladder targets the process GROUP, so both die.
    const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 8000)`;
    const code =
      `require('node:child_process').spawn(${JSON.stringify(BUN)}, ['-e', ${JSON.stringify(grandchild)}], ` +
      `{ stdio: 'ignore' }); setTimeout(() => {}, 8000)`;
    const plan = execPlan([
      "    unit:",
      "      exec:",
      `        command: ${JSON.stringify(bunArgv(code))}`,
      '      timeout: "500ms"',
    ]);
    storePlan(plan);

    const result = await run(plan);
    expect(result.units[0]!.failureReason).toBe("timeout");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(fs.existsSync(marker)).toBe(false);
  }, 30_000);
});

describe("exec unit — env bindings arrive by name, values never reach the journal", () => {
  const SECRET = "sk-exec-unit-super-secret-value-2f81";

  test("the binding value reaches the child but is redacted out of the journaled outcome", async () => {
    seedRun(["work"]);
    const plan = execPlan([
      "    unit:",
      "      exec:",
      `        command: ${JSON.stringify(bunArgv("process.stdout.write('token=' + process.env.DEPLOY_TOKEN)"))}`,
      "      env: [env/ci]",
    ]);
    storePlan(plan);

    // The plan carries the REF NAME only — never the value.
    expect(JSON.stringify(plan)).toContain("env/ci");
    expect(JSON.stringify(plan)).not.toContain(SECRET);

    const result = await run(plan, { resolveEnv: async () => ({ DEPLOY_TOKEN: SECRET }) });

    expect(result.ok).toBe(true);
    // The child really saw it (the prefix proves the var was injected)...
    expect(String(result.evidence.output)).toStartWith("token=");
    // ...and the value is gone from the promoted artifact and the summary.
    expect(String(result.evidence.output)).not.toContain(SECRET);
    expect(JSON.stringify(result.evidence)).not.toContain(SECRET);

    // ...and gone from the durable journal row.
    const rows = await unitRows();
    expect(rows[0]!.status).toBe("completed");
    expect(rows[0]!.result_json).not.toContain(SECRET);
  });

  test("a secret echoed on stderr of a FAILING command is redacted out of the failure diagnostic", async () => {
    seedRun(["work"]);
    const plan = execPlan([
      "    unit:",
      "      exec:",
      `        command: ${JSON.stringify(bunArgv("process.stderr.write(process.env.DEPLOY_TOKEN); process.exit(2)"))}`,
      "      env: [env/ci]",
    ]);
    storePlan(plan);
    const result = await run(plan, { resolveEnv: async () => ({ DEPLOY_TOKEN: SECRET }) });
    expect(result.units[0]!.failureReason).toBe("non_zero_exit");
    expect(result.units[0]!.error).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test("an env-binding resolution failure fails the step before anything is spawned", async () => {
    seedRun(["work"]);
    const marker = path.join(tmpDir, "ran.txt");
    const code = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`;
    const plan = execPlan([
      "    unit:",
      "      exec:",
      `        command: ${JSON.stringify(bunArgv(code))}`,
      "      env: [env/missing]",
    ]);
    storePlan(plan);
    const result = await run(plan, {
      resolveEnv: async () => {
        throw new Error("env asset env/missing not found");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("env binding failed");
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("exec unit — the child environment is an ALLOWLIST", () => {
  /**
   * A name that is NOT on {@link EXEC_DEFAULT_ENV_PASSTHROUGH} and is really
   * present in this test process's environment — the stand-in for the unrelated
   * credentials an interactive shell or a CI job routinely exports.
   */
  const PROBE = "EXEC_UNIT_AMBIENT_PROBE";
  const PROBE_VALUE = "ambient-value-from-the-akm-process";
  let priorProbe: string | undefined;

  beforeEach(() => {
    priorProbe = process.env[PROBE];
    process.env[PROBE] = PROBE_VALUE;
  });
  afterEach(() => {
    if (priorProbe === undefined) delete process.env[PROBE];
    else process.env[PROBE] = priorProbe;
  });

  /** A child that reports the exact env names/values this assertion cares about. */
  const REPORT = bunArgv(
    "process.stdout.write(JSON.stringify({" +
      "PATH: process.env.PATH ?? null, HOME: process.env.HOME ?? null, " +
      "probe: process.env.EXEC_UNIT_AMBIENT_PROBE ?? null, " +
      // Length, not the value: a resolved binding value is scrubbed out of the
      // artifact by the redaction contract, which is exactly as intended.
      "binding: process.env.DEPLOY_TOKEN ? 'len=' + process.env.DEPLOY_TOKEN.length : null, " +
      "runId: process.env.AKM_RUN_ID ?? null, " +
      'windows: ["SystemRoot", "SystemDrive", "WINDIR", "COMSPEC", "PATHEXT"]' +
      ".filter((n) => process.env[n] !== undefined)}))",
  );

  async function report(unitLines: string[], ctx: Partial<StepExecutionContext> = {}) {
    seedRun(["work"]);
    const plan = execPlan(["    unit:", "      exec:", `        command: ${JSON.stringify(REPORT)}`, ...unitLines]);
    storePlan(plan);
    const result = await run(plan, ctx);
    expect(result.ok).toBe(true);
    return JSON.parse(String(result.evidence.output)) as {
      PATH: string | null;
      HOME: string | null;
      probe: string | null;
      binding: string | null;
      runId: string | null;
      windows: string[];
    };
  }

  test("PATH and HOME (and, on Windows, the process-creation essentials) arrive by default", async () => {
    const env = await report([]);
    expect(env.PATH).toBeTruthy();
    expect(env.HOME).toBe(process.env.HOME ?? null);
    // Windows cannot even CREATE a process without these; the allowlist carries
    // whichever of them the host actually defines, and on POSIX that is none.
    const expectedWindows = ["SystemRoot", "SystemDrive", "WINDIR", "COMSPEC", "PATHEXT"].filter(
      (name) => process.env[name] !== undefined,
    );
    expect(env.windows.sort()).toEqual(expectedWindows.sort());
    if (process.platform === "win32") expect(env.windows).toContain("SystemRoot");
  });

  test("REGRESSION: a parent env var that is NOT on the allowlist is ABSENT from the child", async () => {
    // The core of the model: `EXEC_UNIT_AMBIENT_PROBE` is genuinely set in this
    // process, and the command still cannot see it.
    expect(process.env[PROBE]).toBe(PROBE_VALUE);
    expect((await report([])).probe).toBeNull();
  });

  test("`inherit_env: true` restores full inheritance — that same var IS present", async () => {
    expect((await report(["        inherit_env: true"])).probe).toBe(PROBE_VALUE);
  });

  test("`pass_env` widens the allowlist by NAME without going all-in on inherit_env", async () => {
    const env = await report([`        pass_env: [${PROBE}]`]);
    expect(env.probe).toBe(PROBE_VALUE);
    expect(env.PATH).toBeTruthy();
  });

  test.each([
    ["the allowlist default", [] as string[]],
    ["inherit_env: true", ["        inherit_env: true"]],
  ])("`env:` bindings and AKM_* context arrive under %s, precedence unchanged", async (_label, mode) => {
    const env = await report([...mode, "      env: [env/ci]"], {
      resolveEnv: async () => ({ DEPLOY_TOKEN: "binding-value", AKM_RUN_ID: "binding-tried-to-shadow-this" }),
    });
    expect(env.binding).toBe(`len=${"binding-value".length}`);
    // Engine-authored context is applied LAST, so the binding above could not
    // shadow it — the command is told the truth about which run it is in.
    expect(env.runId).toBe(RUN_ID);
  });

  test("both env-scope keys survive the durable `plan_json` round-trip", async () => {
    seedRun(["work"]);
    const plan = execPlan([
      "    unit:",
      "      exec:",
      `        command: ${JSON.stringify(REPORT)}`,
      "        inherit_env: true",
      `        pass_env: [${PROBE}]`,
    ]);
    storePlan(plan);

    // Read the plan back the way a resumed run does: off the row, hash-verified
    // and through the strict decoder — not from the in-memory object.
    const db = openStateDatabase();
    let row: { plan_json: string | null; plan_hash: string | null; plan_ir_version: number | null };
    try {
      row = db
        .prepare("SELECT plan_json, plan_hash, plan_ir_version FROM workflow_runs WHERE id = ?")
        .get(RUN_ID) as never;
    } finally {
      db.close();
    }
    const reloaded = requireExecutableWorkflowPlan({ ...row, id: RUN_ID });
    const root = reloaded.steps[0]!.root!;
    const unit = root.kind === "map" ? root.template : root;
    expect(unit.exec?.inheritEnv).toBe(true);
    expect(unit.exec?.passEnv).toEqual([PROBE]);
  });

  test("the exported default allowlist is the single definition the child is built from", async () => {
    // Structural pin: no name reaches the child that is not on the allowlist,
    // a binding, or the AKM_* context. `_`/`PWD`-style shell additions are not
    // in play because the child env is replaced wholesale, not merged.
    seedRun(["work"]);
    const plan = execPlan([
      "    unit:",
      "      exec:",
      `        command: ${JSON.stringify(bunArgv("process.stdout.write(Object.keys(process.env).join(','))"))}`,
    ]);
    storePlan(plan);
    const names = String((await run(plan)).evidence.output)
      .split(",")
      .filter(Boolean);
    const allowed = new Set<string>([
      ...EXEC_DEFAULT_ENV_PASSTHROUGH,
      "AKM_RUN_ID",
      "AKM_STEP_ID",
      "AKM_UNIT_ID",
      "AKM_PARAMS",
    ]);
    expect(names.filter((name) => !allowed.has(name))).toEqual([]);
    expect(names).toContain("PATH");
  });
});

describe("exec unit — typed artifacts", () => {
  const SCHEMA = [
    "      output:",
    "        type: object",
    "        required: [passed, failed]",
    "        properties:",
    "          passed: { type: number }",
    "          failed: { type: number }",
  ];

  test("with a declared output schema, stdout is parsed as JSON and validated", async () => {
    seedRun(["work"]);
    const plan = execPlan([
      "    unit:",
      "      exec:",
      `        command: ${JSON.stringify(bunArgv("process.stdout.write(JSON.stringify({passed: 12, failed: 0}))"))}`,
      ...SCHEMA,
    ]);
    storePlan(plan);
    const result = await run(plan);
    expect(result.ok).toBe(true);
    expect(result.evidence.output).toEqual({ passed: 12, failed: 0 });
  });

  test("stdout that does not match the schema fails with `validation_error` and is NOT re-run", async () => {
    seedRun(["work"]);
    const marker = path.join(tmpDir, "runs.log");
    const code =
      `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x'); ` +
      `process.stdout.write(JSON.stringify({passed: "twelve"}))`;
    const plan = execPlan(["    unit:", "      exec:", `        command: ${JSON.stringify(bunArgv(code))}`, ...SCHEMA]);
    storePlan(plan);
    const result = await run(plan);
    expect(result.ok).toBe(false);
    expect(result.units[0]!.failureReason).toBe("validation_error");
    // The structured-output corrective retry must NEVER re-run a side-effecting
    // command: a fixed argv cannot produce different output, but it CAN deploy
    // twice.
    expect(fs.readFileSync(marker, "utf8")).toBe("x");
  });

  test("non-JSON stdout under a declared schema is a strict `parse_error`, not an embedded-JSON scan", async () => {
    seedRun(["work"]);
    // A real command's log noise happens to contain a JSON object. The LLM
    // parser would happily pluck it out; a command that claims a schema must
    // print the JSON and nothing else.
    const code = 'process.stdout.write(\'running tests...\\n{"passed": 1, "failed": 0}\\ndone\\n\')';
    const plan = execPlan(["    unit:", "      exec:", `        command: ${JSON.stringify(bunArgv(code))}`, ...SCHEMA]);
    storePlan(plan);
    const result = await run(plan);
    expect(result.ok).toBe(false);
    expect(result.units[0]!.failureReason).toBe("parse_error");
  });
});

describe("exec unit — map fan-out", () => {
  test("fans out over an item list, gives each unit its own item, and really overlaps", async () => {
    const targets = ["alpha", "beta", "gamma", "delta"];
    seedRun(["work"], { targets });
    const outDir = path.join(tmpDir, "out");
    fs.mkdirSync(outDir);
    // Each child records that it ran and echoes the item + index it was handed
    // through the AKM_* context env (a frozen argv is never interpolated).
    const code =
      `const fs=require('node:fs'); const item=JSON.parse(process.env.AKM_ITEM); ` +
      `fs.writeFileSync(${JSON.stringify(outDir)}+'/'+item, 'ran'); ` +
      `setTimeout(() => process.stdout.write(item + ':' + process.env.AKM_ITEM_INDEX), 150)`;
    const plan = execPlan(
      [
        "    map:",
        "      over: params.targets",
        "      concurrency: 4",
        "      unit:",
        "        exec:",
        `          command: ${JSON.stringify(bunArgv(code))}`,
      ],
      { extra: ["params:", "  targets: { type: array }"] },
    );
    storePlan(plan);

    // Concurrency is measured by PEAK IN-FLIGHT dispatches (the same
    // deterministic technique `native-executor.test.ts` uses for engine units),
    // not by a wall clock — and the real exec runner still does the work
    // underneath, so these are four genuine subprocesses.
    let inFlight = 0;
    let peak = 0;
    const result = await run(plan, {
      params: { targets },
      maxConcurrency: 4,
      dispatcher: async (request, feedback) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        try {
          return await defaultUnitDispatcher(request, feedback);
        } finally {
          inFlight--;
        }
      },
    });

    expect(result.ok).toBe(true);
    expect(result.evidence.output).toEqual(["alpha:0", "beta:1", "gamma:2", "delta:3"]);
    expect(fs.readdirSync(outDir).sort()).toEqual(["alpha", "beta", "delta", "gamma"]);
    // The effective width is min(map concurrency, engine cap, host CPU cap) —
    // the host cap is reapplied at dispatch and is not a test seam, so the
    // expectation names it rather than assuming a big machine.
    expect(peak).toBe(Math.min(4, cpuDerivedUnitConcurrency()));
  }, 60_000);

  test("two exec units in one fan-out are genuinely alive at the same time", async () => {
    // A real rendezvous, so nothing here depends on timing: each child writes
    // its own marker and then BLOCKS until the sibling's marker appears. Under
    // a serial scheduler neither can ever observe the other, so both exit 1 and
    // the step fails; only true overlap lets both exit 0.
    const targets = ["one", "two"];
    seedRun(["work"], { targets });
    const gate = path.join(tmpDir, "rendezvous");
    fs.mkdirSync(gate);
    const code =
      `const fs=require('node:fs'); const item=JSON.parse(process.env.AKM_ITEM); ` +
      `fs.writeFileSync(${JSON.stringify(gate)}+'/'+item, 'here'); ` +
      `const deadline=Date.now()+10000; ` +
      `const poll=()=>{ if(fs.readdirSync(${JSON.stringify(gate)}).length>=2){ process.stdout.write('overlapped'); return; } ` +
      `if(Date.now()>deadline){ process.exit(1); } setTimeout(poll, 25); }; poll();`;
    const plan = execPlan(
      [
        "    map:",
        "      over: params.targets",
        "      concurrency: 2",
        "      unit:",
        "        exec:",
        `          command: ${JSON.stringify(bunArgv(code))}`,
      ],
      { extra: ["params:", "  targets: { type: array }"] },
    );
    storePlan(plan);

    const result = await run(plan, { params: { targets }, maxConcurrency: 2 });
    expect(result.ok).toBe(true);
    expect(result.evidence.output).toEqual(["overlapped", "overlapped"]);
  }, 60_000);

  test("a serial fan-out (`concurrency: 1`) is honored", async () => {
    const items = ["a", "b", "c"];
    seedRun(["work"], { targets: items });
    const log = path.join(tmpDir, "serial.log");
    // Each unit brackets itself with `<` … `>`. Under a serial scheduler every
    // `<` is immediately followed by its OWN `>`; any overlap interleaves them.
    const code =
      `const fs=require('node:fs'); const item=JSON.parse(process.env.AKM_ITEM); ` +
      `fs.appendFileSync(${JSON.stringify(log)}, item+'<'); ` +
      `setTimeout(() => { fs.appendFileSync(${JSON.stringify(log)}, item+'>'); process.stdout.write(item); }, 150)`;
    const plan = execPlan(
      [
        "    map:",
        "      over: params.targets",
        "      concurrency: 1",
        "      unit:",
        "        exec:",
        `          command: ${JSON.stringify(bunArgv(code))}`,
      ],
      { extra: ["params:", "  targets: { type: array }"] },
    );
    storePlan(plan);
    await run(plan, { params: { targets: items } });
    expect(fs.readFileSync(log, "utf8")).toBe("a<a>b<b>c<c>");
  }, 60_000);
});

describe("exec unit — worktree isolation", () => {
  async function initRepo(dir: string): Promise<void> {
    fs.mkdirSync(dir, { recursive: true });
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "t@example.com"],
      ["config", "user.name", "Test"],
      ["config", "commit.gpgsign", "false"],
    ]) {
      await runManagedSubprocess(["git", "-C", dir, ...args], { capture: true, timeoutMs: 30_000 });
    }
    fs.writeFileSync(path.join(dir, "README.md"), "base\n");
    await runManagedSubprocess(["git", "-C", dir, "add", "."], { capture: true, timeoutMs: 30_000 });
    await runManagedSubprocess(["git", "-C", dir, "commit", "-qm", "base"], { capture: true, timeoutMs: 30_000 });
  }

  test("the command runs in a fresh detached worktree, not in the base repo", async () => {
    const repo = path.join(tmpDir, "repo");
    await initRepo(repo);
    seedRun(["work"]);
    // Print the cwd and mutate a tracked file — the base repo must stay clean.
    const code =
      "const fs=require('node:fs');" +
      "fs.writeFileSync('README.md', 'changed in the worktree\\n');" +
      "process.stdout.write(process.cwd())";
    const plan = execPlan([
      "    unit:",
      "      exec:",
      `        command: ${JSON.stringify(bunArgv(code))}`,
      "      isolation: worktree",
    ]);
    storePlan(plan);

    const result = await run(plan, { workDir: repo });
    expect(result.ok).toBe(true);

    const cwd = String(result.evidence.output);
    expect(cwd).not.toBe(fs.realpathSync(repo));
    expect(cwd).toContain("akm-worktrees");
    expect(cwd).toContain(RUN_ID);

    // The base checkout was never touched.
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("base\n");
    // The dirty worktree is RETAINED (uncollected work is never destroyed) and
    // its path is journaled on the unit row.
    const rows = (await withWorkflowRunsRepo((repo_) => repo_.getUnitsForStep(RUN_ID, "work"))) as Array<{
      worktree_path: string | null;
    }>;
    expect(rows[0]!.worktree_path).toBe(cwd);

    fs.rmSync(cwd, { recursive: true, force: true });
  }, 60_000);

  test("a non-git working directory fails the step cleanly before anything is spawned", async () => {
    seedRun(["work"]);
    const marker = path.join(tmpDir, "ran.txt");
    const code = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`;
    const plan = execPlan([
      "    unit:",
      "      exec:",
      `        command: ${JSON.stringify(bunArgv(code))}`,
      "      isolation: worktree",
    ]);
    storePlan(plan);
    const result = await run(plan, {
      workDir,
      preflightWorktree: () => "not a git worktree",
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("cannot use isolation: worktree");
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("exec unit — replay / reuse", () => {
  test("a COMPLETED exec unit is NOT re-run when the step is re-executed", async () => {
    seedRun(["work"]);
    const marker = path.join(tmpDir, "side-effects.log");
    const code = `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x'); process.stdout.write('deployed')`;
    const plan = execPlan(["    unit:", "      exec:", `        command: ${JSON.stringify(bunArgv(code))}`]);
    storePlan(plan);

    const first = await run(plan);
    expect(first.ok).toBe(true);
    expect(first.evidence.output).toBe("deployed");
    expect(first.unitsDispatched).toBe(1);

    // Same frozen plan, same params ⇒ same content-derived id AND the same input
    // hash, so the journaled row IS the result. A crash-resume must never
    // re-issue side-effecting work.
    const second = await run(plan);
    expect(second.ok).toBe(true);
    expect(second.evidence.output).toBe("deployed");
    expect(second.unitsDispatched).toBe(0);
    expect(fs.readFileSync(marker, "utf8")).toBe("x");
  });

  test("a CHANGED argv is a different input hash, so the journaled row is not reused", async () => {
    seedRun(["work"]);
    const marker = path.join(tmpDir, "side-effects.log");
    const mk = (tag: string) =>
      execPlan([
        "    unit:",
        "      exec:",
        `        command: ${JSON.stringify(bunArgv(`require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x'); process.stdout.write(${JSON.stringify(tag)})`))}`,
      ]);

    const first = mk("v1");
    storePlan(first);
    expect((await run(first)).evidence.output).toBe("v1");

    const second = mk("v2");
    // Divergence only guards a matching id with a DIFFERENT hash and no matching
    // sibling; here the id is the same (solo) and the hash differs, which is
    // exactly the replay-divergence contract.
    const result = await run(second);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("replay divergence");
    expect(fs.readFileSync(marker, "utf8")).toBe("x");
  });
});

describe("exec unit — budget accounting", () => {
  test("exec dispatches consume the run's declared max_units ceiling", async () => {
    const items = ["a", "b", "c"];
    seedRun(["work"], { targets: items });
    const plan = execPlan(
      [
        "    map:",
        "      over: params.targets",
        "      concurrency: 1",
        "      unit:",
        "        exec:",
        `          command: ${JSON.stringify(bunArgv("process.stdout.write('ok')"))}`,
      ],
      { extra: ["budget: { max_units: 2 }", "params:", "  targets: { type: array }"] },
    );
    storePlan(plan);
    const result = await run(plan, { params: { targets: items }, budget: plan.budget });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("budget exceeded (max_units ceiling)");
  }, 30_000);
});

// ── Reviewer round-4 findings — resource bounds and honest failure surfaces ───

describe("exec unit — retained output is BOUNDED, but a passing command is never failed for it", () => {
  /**
   * A child that writes `mib` MiB to stdout with BLOCKING `fs.writeSync(1, …)`
   * and only then touches `marker`.
   *
   * `writeSync` is the load-bearing detail: a synchronous write to a full pipe
   * BLOCKS. If akm stopped draining at the cap (the pre-change behavior was to
   * cancel the reader and kill the process group), the loop would wedge and the
   * marker would never appear. Its existence is therefore proof that the reader
   * kept draining past the cap and the child ran to completion.
   */
  function giantWriterArgv(mib: number, marker: string): string[] {
    return bunArgv(
      `const fs=require('node:fs'); const chunk=Buffer.alloc(1024*1024,120); ` +
        `for (let i=0;i<${mib};i++) fs.writeSync(1, chunk); ` +
        `fs.writeFileSync(${JSON.stringify(marker)}, 'ran-to-completion');`,
    );
  }

  /** Split a truncated artifact into its retained prefix and its marker block. */
  function splitTruncated(artifact: unknown): { retained: string; note: string } {
    const text = String(artifact);
    const at = text.indexOf(`[${WORKFLOW_EXEC_OUTPUT_TRUNCATED_MARKER}]`);
    if (at < 0) throw new Error("artifact carries no truncation marker");
    return { retained: text.slice(0, at).replace(/\n+$/, ""), note: text.slice(at) };
  }

  test("a 12 MiB writer with NO output schema SUCCEEDS; the artifact is marked truncated and the child completed", async () => {
    seedRun(["work"]);
    const marker = path.join(tmpDir, "ran-to-completion.txt");
    // 12 MiB — half again the 8 MiB cap. Under the old behavior this command was
    // killed and the unit failed `exec_output_limit`, which is exactly the
    // tripwire being removed: nothing about a chatty-but-passing command
    // deserves a failed run.
    const plan = execPlan([
      "    unit:",
      "      exec:",
      `        command: ${JSON.stringify(giantWriterArgv(12, marker))}`,
      '      timeout: "60s"',
    ]);
    storePlan(plan);

    const result = await run(plan);

    // 1. The unit SUCCEEDS: the command exited 0 and that verdict stands.
    expect(result.ok).toBe(true);
    expect(result.units[0]!.failureReason).toBeUndefined();

    // 2. The child really ran to completion — it could only have reached the
    //    marker write if akm kept draining the pipe past the cap.
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.readFileSync(marker, "utf8")).toBe("ran-to-completion");

    // 3. The artifact is UNMISTAKABLY marked. Truncated data can never be
    //    mistaken for complete data.
    const { retained, note } = splitTruncated(result.evidence.output);
    expect(note).toContain(WORKFLOW_EXEC_OUTPUT_TRUNCATED_MARKER);
    expect(note).toContain("TRUNCATED");
    expect(note).toContain("THIS TEXT IS INCOMPLETE");
    // Both byte counts, so a reader can see exactly how much is missing.
    expect(note).toContain(String(12 * 1024 * 1024));
    expect(note).toContain(String(WORKFLOW_MAX_EXEC_OUTPUT_BYTES));
    // The marker is the LAST thing in the artifact — `stripTrailingNewlines`
    // cannot shave it off, and a naive tail read cannot miss it.
    expect(String(result.evidence.output).endsWith(note)).toBe(true);

    // 4. MEMORY IS STILL BOUNDED — the justified part of the cap, unchanged.
    expect(Buffer.byteLength(retained, "utf8")).toBe(WORKFLOW_MAX_EXEC_OUTPUT_BYTES);
    expect(Buffer.byteLength(retained, "utf8")).toBeLessThanOrEqual(WORKFLOW_MAX_EXEC_OUTPUT_BYTES);

    // 5. The unit row records a success, not a failure.
    const rows = await unitRows();
    expect(rows[0]!.status).toBe("completed");
    expect(rows[0]!.failure_reason).toBeNull();
  }, 120_000);

  test("the SAME writer WITH an output schema still fails `exec_output_limit` — a truncated prefix is not a typed artifact", async () => {
    seedRun(["work"]);
    const marker = path.join(tmpDir, "schema-writer-done.txt");
    const plan = execPlan([
      "    unit:",
      "      exec:",
      `        command: ${JSON.stringify(giantWriterArgv(12, marker))}`,
      '      timeout: "60s"',
      "      output:",
      "        type: object",
      "        required: [ok]",
      "        properties:",
      "          ok: { type: boolean }",
    ]);
    storePlan(plan);

    const result = await run(plan);

    expect(result.ok).toBe(false);
    expect(result.units[0]!.failureReason).toBe("exec_output_limit");
    const error = result.units[0]!.error ?? "";
    // Actionable: both byte counts, the cap, WHY the schema makes it fatal.
    expect(error).toContain(String(12 * 1024 * 1024));
    expect(error).toContain(String(WORKFLOW_MAX_EXEC_OUTPUT_BYTES));
    expect(error).toContain("output: schema");
    expect(error).toContain("exactly one JSON value");
    expect(error).toContain("NO artifact was promoted");
    // Nothing is promoted: a truncated prefix must never become a typed artifact.
    expect(result.evidence.output).toBeNull();

    // The child was still allowed to finish — the cap never kills it. What
    // failed is the PROMISE the unit made about its output, not the command.
    expect(fs.existsSync(marker)).toBe(true);

    // `exec_output_limit` keeps its out-of-taxonomy, no-retry meaning.
    const rows = await unitRows();
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.failure_reason).toBe("exec_output_limit");
  }, 120_000);

  test("memory stays bounded no matter how much the command writes", async () => {
    seedRun(["work"]);
    const marker = path.join(tmpDir, "giant-done.txt");
    // 20 MiB — 2.5× the cap. Retention must not grow with the command's output.
    const plan = execPlan([
      "    unit:",
      "      exec:",
      `        command: ${JSON.stringify(giantWriterArgv(20, marker))}`,
      '      timeout: "90s"',
    ]);
    storePlan(plan);

    const result = await run(plan);

    expect(result.ok).toBe(true);
    const { retained, note } = splitTruncated(result.evidence.output);
    expect(Buffer.byteLength(retained, "utf8")).toBeLessThanOrEqual(WORKFLOW_MAX_EXEC_OUTPUT_BYTES);
    // …and the whole artifact is the bounded prefix plus a fixed-size note, not
    // a function of the 20 MiB the command produced.
    expect(String(result.evidence.output).length).toBeLessThan(WORKFLOW_MAX_EXEC_OUTPUT_BYTES + 2_000);
    expect(note).toContain(String(20 * 1024 * 1024));
    expect(fs.existsSync(marker)).toBe(true);
  }, 120_000);

  test("the cap DRAINS past the bound rather than cancelling — every chunk is read, only some are kept", async () => {
    // The mechanism under all of the above, isolated: `readStream` must consume
    // the stream to its end so the writer never blocks on backpressure. A reader
    // that cancelled at the cap (the pre-change behavior) would leave chunks
    // unread and wedge a real child on its next write.
    let chunksRead = 0;
    const chunk = new Uint8Array(1024).fill(0x61); // "a" × 1024
    const total = 100;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunksRead >= total) {
          controller.close();
          return;
        }
        chunksRead++;
        controller.enqueue(chunk);
      },
    });

    const cap = 10 * 1024;
    const read = await readStream(stream, { maxBytes: cap });

    // Every chunk was pulled: the producer was never left blocked.
    expect(chunksRead).toBe(total);
    expect(read.bytesRead).toBe(total * 1024);
    // …and retention is bounded, exactly.
    expect(read.overflowed).toBe(true);
    expect(read.retainedBytes).toBe(cap);
    expect(Buffer.byteLength(read.text, "utf8")).toBe(cap);
    expect(read.timedOut).toBe(false);
    expect(read.error).toBeUndefined();
  });

  test("an UNCAPPED drain is byte-for-byte what it always was", async () => {
    // The cap is opt-in; a caller that asks for none must see the pre-existing
    // shape, with no `overflowed`/`bytesRead`/`retainedBytes` fields at all.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello "));
        controller.enqueue(new TextEncoder().encode("world"));
        controller.close();
      },
    });
    const read = await readStream(stream);
    expect(read).toEqual({ text: "hello world", timedOut: false });
  });

  test("output comfortably under the cap is unaffected", async () => {
    seedRun(["work"]);
    const code = "process.stdout.write('y'.repeat(256*1024))";
    const plan = execPlan(["    unit:", "      exec:", `        command: ${JSON.stringify(bunArgv(code))}`]);
    storePlan(plan);
    const result = await run(plan);
    expect(result.ok).toBe(true);
    expect(String(result.evidence.output).length).toBe(256 * 1024);
  }, 30_000);
});

describe("exec unit — an INCOMPLETE capture is never a success (finding 2)", () => {
  test("leader exits 0 while a descendant holds stdout open → `spawn_failed`, not a partial artifact", async () => {
    seedRun(["work"]);
    // The command LEADER writes a prefix of its output and exits 0 immediately,
    // but leaves a detached descendant holding the stdout fd open far past the
    // stream-drain deadline (the unit's wall budget + 2s). `exitCode` is 0 and
    // `stdout` holds only the leader's prefix — promoting it would hand every
    // downstream reference a silently truncated artifact.
    const holder = "setTimeout(() => {}, 30000)";
    const code =
      `const cp=require('node:child_process'); ` +
      `const child=cp.spawn(${JSON.stringify(BUN)}, ['-e', ${JSON.stringify(holder)}], ` +
      `{ stdio: ['ignore', 'inherit', 'ignore'] }); child.unref(); ` +
      `process.stdout.write('partial-artifact');`;
    const plan = execPlan([
      "    unit:",
      "      exec:",
      `        command: ${JSON.stringify(bunArgv(code))}`,
      '      timeout: "2s"',
    ]);
    storePlan(plan);

    const result = await run(plan);

    expect(result.ok).toBe(false);
    // The SAME reason the agent spawn path reports for the same condition.
    expect(result.units[0]!.failureReason).toBe("spawn_failed");
    expect(result.units[0]!.error).toContain("output capture did not complete");
    expect(result.units[0]!.error).toContain("drain timed out");
    // The prefix never became the step artifact.
    expect(result.evidence.output).toBeNull();
    expect(JSON.stringify(result.evidence)).not.toContain("partial-artifact");
  }, 90_000);
});

describe("exec unit — a stderr-only diagnosis survives to the journal (finding 3)", () => {
  const CAUSE = "fatal: reactor core temperature exceeded 9000K at line 42";

  test("a command that explains itself ONLY on stderr is visible through `status --units` and the run summary", async () => {
    seedRun(["work"]);
    // Empty stdout, the whole diagnosis on stderr — the shape that used to
    // reach durable state as a bare `non_zero_exit` and nothing else.
    const code = `process.stderr.write(${JSON.stringify(`${CAUSE}\n`)}); process.exit(7)`;
    const plan = execPlan(["    unit:", "      exec:", `        command: ${JSON.stringify(bunArgv(code))}`]);
    storePlan(plan);

    const result = await run(plan);
    expect(result.ok).toBe(false);
    expect(result.units[0]!.failureReason).toBe("non_zero_exit");

    // 1. The RUN SUMMARY (what `akm workflow run` prints and the failed step row keeps).
    expect(result.summary).toContain("non_zero_exit");
    expect(result.summary).toContain(CAUSE);

    // 2. The durable unit row — stdout was empty, so before the fix this was NULL.
    const rows = await unitRows();
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.result_json).not.toBeNull();
    expect(rows[0]!.result_json).toContain("exited 7");

    // 3. `akm workflow status --units`, the human diagnostic surface.
    const detail = await getWorkflowStatus(RUN_ID, { includeUnits: true });
    const unit = (detail.units ?? []).find((u) => u.unitId === "work:solo");
    expect(unit?.failureReason).toBe("non_zero_exit");
    expect(unit?.diagnostic ?? "").toContain(CAUSE);
  }, 30_000);

  test("the journaled diagnostic is REDACTED and BOUNDED", async () => {
    const SECRET = "sk-exec-diagnostic-secret-value-7c31";
    seedRun(["work"]);
    // A huge stderr carrying a resolved binding value: the row must contain
    // neither the secret nor an unbounded blob.
    const code =
      `process.stderr.write('noise\\n'.repeat(20000)); ` +
      "process.stderr.write(process.env.DEPLOY_TOKEN); process.exit(4)";
    const plan = execPlan([
      "    unit:",
      "      exec:",
      `        command: ${JSON.stringify(bunArgv(code))}`,
      "      env: [env/ci]",
    ]);
    storePlan(plan);

    await run(plan, { resolveEnv: async () => ({ DEPLOY_TOKEN: SECRET }) });

    const rows = await unitRows();
    expect(rows[0]!.result_json).not.toBeNull();
    expect(rows[0]!.result_json).not.toContain(SECRET);
    // 2000-char clip + JSON quoting/escaping overhead — bounded, not the 120 KB
    // of stderr the command actually produced.
    expect(rows[0]!.result_json!.length).toBeLessThan(3_000);

    const detail = await getWorkflowStatus(RUN_ID, { includeUnits: true });
    const unit = (detail.units ?? []).find((u) => u.unitId === "work:solo");
    expect(unit?.diagnostic ?? "").not.toContain(SECRET);
    expect((unit?.diagnostic ?? "").length).toBeLessThanOrEqual(2_001);
  }, 30_000);

  test("a SUCCESSFUL unit's journaled result is unchanged (the artifact, not a diagnostic)", async () => {
    seedRun(["work"]);
    const plan = execPlan([
      "    unit:",
      "      exec:",
      `        command: ${JSON.stringify(bunArgv("process.stderr.write('warning: noisy\\n'); process.stdout.write('ok')"))}`,
    ]);
    storePlan(plan);
    await run(plan);
    const rows = await unitRows();
    expect(JSON.parse(rows[0]!.result_json!)).toBe("ok");
  }, 30_000);
});

describe("exec unit — the AKM_* context environment is bounded by THIS PLATFORM's spawn ceiling", () => {
  /** The per-variable ceiling that actually applies on the host running this suite. */
  const LIMITS = execContextLimits();

  /** A declared-input artifact far past what one environment entry may hold HERE. */
  const HUGE = "z".repeat(LIMITS.perVarBytes + 1_000);

  /**
   * Past the OLD, Windows-derived bound (32 000 bytes) but comfortably inside
   * this platform's real ceiling — the exact size the removed tripwire used to
   * refuse. On win32 the two bounds are within 767 bytes of each other, so this
   * is only a meaningful regression on a non-Windows host; there it is the whole
   * point of the change.
   */
  const OVER_OLD_BOUND_UNDER_PLATFORM = "q".repeat(40_000);

  /**
   * A two-step plan whose SECOND step declares the first step's artifact as a
   * declared `inputs:` — the surface that becomes `AKM_INPUTS` in the child.
   */
  function consumerPlan(argv: string[]): WorkflowPlanGraph {
    return freezeWorkflow(
      [
        "---",
        "type: workflow",
        "steps:",
        "  - id: produce",
        "  - id: work",
        "    inputs: [steps.produce.output]",
        "    unit:",
        "      exec:",
        `        command: ${JSON.stringify(argv)}`,
        "---",
        "",
        "## produce",
        "",
        "Produce the artifact.",
        "",
        "## work",
        "",
        "Consume the produced artifact.",
        "",
      ].join("\n"),
    );
  }

  /** Execute the CONSUMER step (steps[1]) with `produce` already in evidence. */
  function runConsumer(plan: WorkflowPlanGraph, produced: string): Promise<StepExecutionResult> {
    return executeFrozenStepPlan(plan.steps[1]!, {
      runId: RUN_ID,
      workflowRef: "workflows/exec-demo",
      params: {},
      evidence: { produce: { output: produced } },
      engines: plan.execution.engines,
      workDir,
    });
  }

  test("a context var over the OLD 32 000-byte bound but under this platform's ceiling now SUCCEEDS", async () => {
    // The tripwire-removal regression. 40 000 bytes was rejected before the
    // change (the guard applied Windows' ceiling everywhere) even though this
    // platform spawns it without complaint. A guard whose only job is to explain
    // an INEVITABLE E2BIG must not invent one.
    if (process.platform === "win32") return; // 40 000 > 32 767: genuinely over the ceiling here.
    seedRun(["produce", "work"]);
    const plan = consumerPlan(bunArgv("process.stdout.write(String(process.env.AKM_INPUTS.length))"));
    storePlan(plan);

    const result = await runConsumer(plan, OVER_OLD_BOUND_UNDER_PLATFORM);

    expect(result.units[0]!.failureReason).toBeUndefined();
    expect(result.ok).toBe(true);
    // The command really received the whole thing — the spawn the old guard
    // refused is a spawn the OS was always willing to make.
    expect(Number(result.evidence.output)).toBeGreaterThan(OVER_OLD_BOUND_UNDER_PLATFORM.length);
    // …and the size that used to be refused really is past the old bound and
    // inside this platform's ceiling.
    expect(OVER_OLD_BOUND_UNDER_PLATFORM.length).toBeGreaterThan(32_000);
    expect(OVER_OLD_BOUND_UNDER_PLATFORM.length).toBeLessThan(LIMITS.perVarBytes);
  }, 30_000);

  test("a genuinely over-ceiling AKM_INPUTS fails with an actionable error instead of a raw E2BIG", async () => {
    seedRun(["produce", "work"]);
    const marker = path.join(tmpDir, "spawned.txt");
    const code = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`;
    const plan = consumerPlan(bunArgv(code));
    storePlan(plan);

    const result = await runConsumer(plan, HUGE);

    expect(result.ok).toBe(false);
    expect(result.units[0]!.failureReason).toBe("exec_context_too_large");
    const error = result.units[0]!.error ?? "";
    // Actionable: names the VARIABLE, its SIZE, THIS platform's LIMIT and where
    // that number comes from, and what to do.
    expect(error).toContain("AKM_INPUTS");
    expect(error).toContain(String(LIMITS.perVarBytes));
    expect(error).toMatch(/\d+ bytes/);
    expect(error).toContain(LIMITS.source);
    expect(error).toContain("emit a REFERENCE");
    // And it says so BEFORE process creation is attempted, so the confusing
    // E2BIG never happens.
    expect(error).toContain("E2BIG");
    expect(fs.existsSync(marker)).toBe(false);
  }, 30_000);

  test("the ceiling is the CURRENT platform's — a win32 run is checked against Windows' 32 767 characters", async () => {
    // Same value, two platforms, two verdicts: 40 000 bytes is fine here and
    // over the line on Windows. Driving the platform explicitly is how a
    // single-platform CI still proves the win32 branch, and it is the mechanism
    // behind the docs' "stay under 32 767 if you also target Windows" guidance.
    const context = { AKM_INPUTS: OVER_OLD_BOUND_UNDER_PLATFORM };
    const argv = bunArgv("process.stdout.write('ok')") as [string, ...string[]];

    const onWindows = await runExecUnit({
      unitId: "work:solo",
      exec: { command: argv, timeoutMs: 30_000 },
      baseDir: workDir,
      context,
      timeoutMs: 30_000,
      platform: "win32",
    });
    expect(onWindows.ok).toBe(false);
    expect(onWindows.failureReason).toBe("exec_context_too_large");
    expect(onWindows.error).toContain(String(WORKFLOW_MAX_EXEC_CONTEXT_VAR_BYTES_WIN32));
    expect(onWindows.error).toContain("32 767 characters");

    const onLinux = await runExecUnit({
      unitId: "work:solo",
      exec: { command: argv, timeoutMs: 30_000 },
      baseDir: workDir,
      context,
      timeoutMs: 30_000,
      platform: "linux",
    });
    expect(onLinux.ok).toBe(true);
    expect(onLinux.text).toBe("ok");
  }, 30_000);

  test("the same bound covers AKM_PARAMS", async () => {
    seedRun(["work"], { blob: HUGE });
    const plan = execPlan(["    unit:", "      exec:", '        command: ["true"]'], {
      extra: ["params:", "  blob: { type: string }"],
    });
    storePlan(plan);
    const result = await run(plan, { params: { blob: HUGE } });
    expect(result.units[0]!.failureReason).toBe("exec_context_too_large");
    expect(result.units[0]!.error).toContain("AKM_PARAMS");
  }, 30_000);

  test("the same bound covers a fan-out AKM_ITEM", async () => {
    // Fans out over a PRIOR STEP's artifact, not over params, so the oversized
    // value lands in `AKM_ITEM` alone and `AKM_PARAMS` stays small — otherwise
    // the params check would fire first and prove nothing about the item.
    seedRun(["produce", "work"]);
    const plan = freezeWorkflow(
      [
        "---",
        "type: workflow",
        "steps:",
        "  - id: produce",
        "  - id: work",
        "    map:",
        "      over: steps.produce.output",
        "      unit:",
        "        exec:",
        '          command: ["true"]',
        "---",
        "",
        "## produce",
        "",
        "Produce the list.",
        "",
        "## work",
        "",
        "Run over each item.",
        "",
      ].join("\n"),
    );
    storePlan(plan);
    const result = await executeFrozenStepPlan(plan.steps[1]!, {
      runId: RUN_ID,
      workflowRef: "workflows/exec-demo",
      params: {},
      evidence: { produce: { output: [HUGE] } },
      engines: plan.execution.engines,
      workDir,
    });
    expect(result.units[0]!.failureReason).toBe("exec_context_too_large");
    expect(result.units[0]!.error).toContain("AKM_ITEM");
  }, 30_000);

  test("a context comfortably inside the bound still reaches the command", async () => {
    const payload = "p".repeat(1_000);
    seedRun(["produce", "work"]);
    const plan = consumerPlan(bunArgv("process.stdout.write(String(process.env.AKM_INPUTS.length))"));
    storePlan(plan);
    const result = await runConsumer(plan, payload);
    expect(result.ok).toBe(true);
    expect(Number(result.evidence.output)).toBeGreaterThan(payload.length);
  }, 30_000);
});
