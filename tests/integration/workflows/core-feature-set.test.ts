// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #1096 — the workflow CORE feature set, end to end, through the real
 * task -> workflow path.
 *
 * "Core" is the subset the owner's scheduled workflows actually use (the #1091
 * audit): `params`, ordered `steps`, step `inputs:`, `output` / `unit.output`,
 * `defaults.engine`, and `### gate` rubrics judged by `workflow.judgeEngine`.
 * Nothing else is exercised here on purpose; the unused features are tracked in
 * docs/plans/0.10-workflows.md.
 *
 * Why this file exists: a daily task silently broke when the old
 * `workflow next/complete` verbs were removed, because every existing test
 * either drove the workflow runner directly or replaced it with a fake. These
 * tests go through the three entry points a schedule really uses:
 *
 *   1. `akm workflow run <ref> --<param> …`  (the CLI verb, in process),
 *   2. `akm task run <id>` for a v4 task whose target is `uses: workflows/…`,
 *   3. a v4 task whose `run:` line is the literal shell command
 *      `akm workflow run workflows/<name> --<param> … --skip-if-locked` (the
 *      owner's actual task shape), executed by the task runner as a REAL
 *      subprocess against a real `akm` on PATH.
 *
 * Agent/engine dispatch goes through the opencode-sdk harness against a fake
 * `createOpencode` server (`__setServerFactory`), the repo's existing pattern
 * from tests/opencode-sdk-runner.test.ts. The fake keys its reply on the model
 * the server was started with, so each assertion can say WHICH engine served
 * a call: `defaults.engine` for the units, `workflow.judgeEngine` for the gate.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../../src/core/config/config";
import { __setServerFactory, closeServer } from "../../../src/integrations/harnesses/opencode-sdk/sdk-runner";
import { listWorkflowRuns } from "../../../src/workflows/runtime/runs";
import { runCliCapture } from "../../_helpers/cli";
import { fakeOpencodeMajor } from "../../_helpers/opencode-version";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

const UNIT_MODEL = "fixture/unit-model";
const JUDGE_MODEL = "fixture/judge-model";
const OTHER_MODEL = "fixture/other-model";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  fakeOpencodeMajor(1);
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({
    engines: {
      // The workflow names this one in `defaults.engine`.
      "unit-engine": { kind: "agent", platform: "opencode-sdk", model: UNIT_MODEL },
      // The workflow-level judge.
      "judge-engine": { kind: "agent", platform: "opencode-sdk", model: JUDGE_MODEL },
      // The install-wide default. A workflow that declares its own default
      // engine must never fall through to this one.
      "other-engine": { kind: "agent", platform: "opencode-sdk", model: OTHER_MODEL },
    },
    defaults: { engine: "other-engine" },
    workflow: { judgeEngine: "judge-engine" },
    bundles: { fixture: { path: storage.stashDir, writable: true } },
    defaultBundle: "fixture",
  });
  resetConfigCache();
});

afterEach(async () => {
  __setServerFactory(null);
  await closeServer();
  resetConfigCache();
  storage.cleanup();
});

// ── fake OpenCode SDK server ────────────────────────────────────────────────

interface SdkCall {
  /** The model the serving `opencode` instance was configured with. */
  model: string | undefined;
  prompt: string;
  system: string | undefined;
}

type Reply = (call: SdkCall) => string;

/** Install a fake server factory; every prompt is recorded and answered by `reply`. */
function installFakeSdk(reply: Reply): SdkCall[] {
  const calls: SdkCall[] = [];
  __setServerFactory((async (options: { config?: { model?: string } }) => {
    const model = options.config?.model;
    return {
      client: {
        session: {
          create: async () => ({ data: { id: `session-${calls.length + 1}` } }),
          prompt: async (args: { body: { parts: { text: string }[]; system?: string } }) => {
            const call: SdkCall = {
              model,
              prompt: args.body.parts.map((part) => part.text).join("\n"),
              system: args.body.system,
            };
            calls.push(call);
            return { data: { parts: [{ type: "text", text: reply(call) }] } };
          },
          abort: async () => ({}),
        },
      },
      server: { close() {} },
    };
  }) as never);
  return calls;
}

const unitCalls = (calls: SdkCall[]) => calls.filter((call) => call.model === UNIT_MODEL);
const judgeCalls = (calls: SdkCall[]) => calls.filter((call) => call.model === JUDGE_MODEL);

// ── fixtures (neutral; shapes modelled on the real scheduled workflows) ─────

const COLLECT_SCHEMA = `{ type: object, properties: { topic: { type: string }, items: { type: array, items: { type: string } }, count: { type: integer, minimum: 0 } }, required: [topic, items, count] }`;
const REPORT_SCHEMA = `{ type: object, properties: { summary: { type: string }, item_count: { type: integer } }, required: [summary, item_count] }`;

function write(relative: string, content: string): void {
  const file = path.join(storage.stashDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

/** Agent workflow: typed params, two chained steps, typed outputs, a gate on the first. */
function agentWorkflow(options: { gate?: boolean } = {}): string {
  const gate = options.gate ?? true;
  return [
    "---",
    "type: workflow",
    "description: Core feature fixture",
    "params:",
    "  topic: { type: string, default: widgets, description: What to collect }",
    "  limit: { type: integer, default: 2, description: Maximum items }",
    "  dry_run: { type: boolean, default: false, description: Report only }",
    "defaults: { engine: unit-engine }",
    "steps:",
    "  - id: collect",
    "    unit:",
    `      output: ${COLLECT_SCHEMA}`,
    `    output: ${COLLECT_SCHEMA}`,
    "  - id: report",
    "    inputs: [steps.collect.output]",
    "    unit:",
    `      output: ${REPORT_SCHEMA}`,
    `    output: ${REPORT_SCHEMA}`,
    "---",
    "",
    "# Core fixture",
    "",
    "## collect",
    "",
    "STEP-COLLECT: gather items for the topic given in the run params.",
    ...(gate ? ["", "### gate", "", "- Every item is a non-empty string.", "- count equals the number of items."] : []),
    "",
    "## report",
    "",
    "STEP-REPORT: summarize the collected items attached to this unit.",
    "",
  ].join("\n");
}

function collectReply(topic: string, items: string[]): string {
  return JSON.stringify({ topic, items, count: items.length });
}

/** A reply function that plays the whole happy path. */
const happyReply: Reply = (call) => {
  if (call.model === JUDGE_MODEL) return JSON.stringify({ complete: true, missing: [] });
  if (call.prompt.includes("STEP-COLLECT")) return collectReply("gadgets", ["alpha", "beta", "gamma"]);
  return JSON.stringify({ summary: "three gadgets", item_count: 3 });
};

interface RunEnvelope {
  ok?: boolean;
  run: { id: string; status: string; params: Record<string, unknown>; currentStepId: string | null };
  executed: Array<{ stepId: string; status?: string }>;
  gateRejection?: unknown;
}

function parseEnvelope(stdout: string): RunEnvelope {
  return JSON.parse(stdout) as RunEnvelope;
}

// ── 1. `akm workflow run` ───────────────────────────────────────────────────

describe("core feature set: akm workflow run", () => {
  test("params, chained steps, typed outputs, defaults.engine and a judged gate run to completion", async () => {
    write("workflows/core.md", agentWorkflow());
    const calls = installFakeSdk(happyReply);

    const result = await runCliCapture(["workflow", "run", "workflows/core", "--topic", "gadgets", "--limit", "3"]);
    expect(result.stderr).not.toContain('"ok":false');
    expect(result.code).toBe(0);

    const envelope = parseEnvelope(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.run.status).toBe("completed");
    // params: the flags were typed against the declared schema (limit is an integer);
    // the unsupplied boolean is simply absent (see the default-not-applied test below).
    expect(envelope.run.params).toEqual({ topic: "gadgets", limit: 3 });
    expect(envelope.executed.map((step) => step.stepId)).toEqual(["collect", "report"]);

    // defaults.engine: both units ran on the workflow's own engine, never the install default.
    expect(unitCalls(calls)).toHaveLength(2);
    expect(calls.some((call) => call.model === OTHER_MODEL)).toBe(false);
    // The run params reach the first unit.
    const collectPrompt = unitCalls(calls)[0]?.prompt ?? "";
    expect(collectPrompt).toContain("STEP-COLLECT");
    expect(collectPrompt).toContain("gadgets");
    // inputs: the second unit receives the first step's typed artifact, not prose.
    const reportPrompt = unitCalls(calls)[1]?.prompt ?? "";
    expect(reportPrompt).toContain("STEP-REPORT");
    expect(reportPrompt).toContain("alpha");
    expect(reportPrompt).toContain("gamma");

    // gate + workflow.judgeEngine: exactly one judge call (only `collect` has a rubric), on the
    // judge engine, with the rubric and the artifact it is judging.
    const judged = judgeCalls(calls);
    expect(judged).toHaveLength(1);
    expect(`${judged[0]?.system}\n${judged[0]?.prompt}`).toContain("Every item is a non-empty string");
    expect(judged[0]?.prompt).toContain("alpha");

    // The persisted run carries the typed artifacts.
    const status = await runCliCapture(["workflow", "status", envelope.run.id]);
    expect(status.code).toBe(0);
    const text = status.stdout;
    expect(text).toContain("three gadgets");
  }, 30_000);

  test("an omitted param is absent from the run: frontmatter `default:` is not applied or shown to the unit", async () => {
    // Pins today's behaviour so a fix is a deliberate change (see docs/plans/0.10-workflows.md,
    // "Gaps in the core set"): the schema accepts `default:` but the engine neither fills
    // `run.params` nor puts the default in the unit prompt, which is why the real workflows
    // restate their defaults in prose.
    write("workflows/core.md", agentWorkflow({ gate: false }));
    const calls = installFakeSdk(happyReply);

    const result = await runCliCapture(["workflow", "run", "workflows/core"]);
    expect(result.code).toBe(0);
    const envelope = parseEnvelope(result.stdout);
    expect(envelope.run.status).toBe("completed");
    expect(envelope.run.params).toEqual({});
    expect(unitCalls(calls)[0]?.prompt).toContain("Run parameters: {}");
    // No rubric anywhere: no judge call is made.
    expect(judgeCalls(calls)).toHaveLength(0);
    expect(unitCalls(calls)).toHaveLength(2);
  }, 30_000);

  test("a unit whose reply violates unit.output is re-dispatched once with the validation errors, then accepted", async () => {
    write("workflows/core.md", agentWorkflow({ gate: false }));
    let collectAttempts = 0;
    const calls = installFakeSdk((call) => {
      if (!call.prompt.includes("STEP-COLLECT")) return JSON.stringify({ summary: "ok", item_count: 1 });
      collectAttempts++;
      // First reply is valid JSON but misses the required `count`.
      return collectAttempts === 1
        ? JSON.stringify({ topic: "widgets", items: ["only"] })
        : collectReply("widgets", ["only"]);
    });

    const result = await runCliCapture(["workflow", "run", "workflows/core"]);
    expect(result.code).toBe(0);
    expect(parseEnvelope(result.stdout).run.status).toBe("completed");

    const collects = calls.filter((call) => call.prompt.includes("STEP-COLLECT"));
    expect(collects).toHaveLength(2);
    // The second attempt carries the schema complaint, naming the missing field.
    expect(collects[1]?.prompt).toContain("count");
  }, 30_000);

  test("a unit that never satisfies unit.output fails its step and the run stops before the next step", async () => {
    write("workflows/core.md", agentWorkflow({ gate: false }));
    const calls = installFakeSdk((call) =>
      call.prompt.includes("STEP-COLLECT") ? JSON.stringify({ topic: "widgets" }) : "{}",
    );

    const result = await runCliCapture(["workflow", "run", "workflows/core"]);
    expect(result.code).toBe(1);
    const envelope = parseEnvelope(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.run.status).not.toBe("completed");
    expect(calls.some((call) => call.prompt.includes("STEP-REPORT"))).toBe(false);
  }, 30_000);

  test("a gate rejection from workflow.judgeEngine stops the run and surfaces the judge's feedback", async () => {
    write("workflows/core.md", agentWorkflow());
    const calls = installFakeSdk((call) => {
      if (call.model === JUDGE_MODEL) {
        return JSON.stringify({
          complete: false,
          missing: ["count equals the number of items."],
          feedback: "count is off",
        });
      }
      if (call.prompt.includes("STEP-COLLECT")) return collectReply("widgets", ["a", "b"]);
      return JSON.stringify({ summary: "x", item_count: 2 });
    });

    const result = await runCliCapture(["workflow", "run", "workflows/core"]);
    expect(result.code).toBe(1);
    const envelope = parseEnvelope(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.run.status).not.toBe("completed");
    expect(JSON.stringify(envelope)).toContain("count equals the number of items.");
    // The step after the rejected gate never dispatched.
    expect(calls.some((call) => call.prompt.includes("STEP-REPORT"))).toBe(false);
    expect(judgeCalls(calls)).toHaveLength(1);
  }, 30_000);

  test("a malformed judge verdict fails closed instead of advancing the step", async () => {
    write("workflows/core.md", agentWorkflow());
    const calls = installFakeSdk((call) => {
      if (call.model === JUDGE_MODEL) return "looks fine to me";
      if (call.prompt.includes("STEP-COLLECT")) return collectReply("widgets", ["a"]);
      return JSON.stringify({ summary: "x", item_count: 1 });
    });

    const result = await runCliCapture(["workflow", "run", "workflows/core"]);
    expect(result.code).toBe(1);
    expect(parseEnvelope(result.stdout).run.status).not.toBe("completed");
    expect(calls.some((call) => call.prompt.includes("STEP-REPORT"))).toBe(false);
  }, 30_000);

  test("a run interrupted after the first step resumes from the second without re-dispatching the first", async () => {
    write("workflows/core.md", agentWorkflow({ gate: false }));
    const calls = installFakeSdk(happyReply);

    const first = await runCliCapture(["workflow", "run", "workflows/core", "--max-steps", "1"]);
    expect(first.code).toBe(0);
    const started = parseEnvelope(first.stdout);
    expect(started.run.status).toBe("active");
    expect(started.run.currentStepId).toBe("report");
    expect(unitCalls(calls)).toHaveLength(1);

    const resumed = await runCliCapture(["workflow", "run", started.run.id]);
    expect(resumed.code).toBe(0);
    expect(parseEnvelope(resumed.stdout).run.status).toBe("completed");
    expect(unitCalls(calls)).toHaveLength(2);
    expect(unitCalls(calls)[1]?.prompt).toContain("STEP-REPORT");
  }, 30_000);
});

// ── 2. v4 task whose target is `uses: workflows/<ref>` ──────────────────────

describe("core feature set: akm task run -> workflow target", () => {
  test("task inputs become the run's params and the agent workflow completes", async () => {
    write("workflows/core.md", agentWorkflow());
    write(
      "tasks/core-daily.yml",
      [
        "version: 4",
        "name: Core daily",
        "description: Neutral task that fronts the core workflow",
        "inputs:",
        "  topic: { type: string, default: widgets }",
        "  limit: { type: integer, default: 2 }",
        "uses: workflows/core",
        "",
      ].join("\n"),
    );
    const calls = installFakeSdk(happyReply);

    const result = await runCliCapture(["task", "run", "core-daily", "--topic", "gadgets", "--limit", "3"]);
    expect(result.stderr).not.toContain('"ok":false');
    expect(result.code).toBe(0);

    const { runs } = await listWorkflowRuns();
    const core = runs.filter((run) => run.workflowRef.includes("core"));
    expect(core).toHaveLength(1);
    expect(core[0]?.status).toBe("completed");
    expect(core[0]?.params).toMatchObject({ topic: "gadgets", limit: 3 });
    expect(unitCalls(calls)).toHaveLength(2);
    expect(judgeCalls(calls)).toHaveLength(1);
    expect(calls.some((call) => call.model === OTHER_MODEL)).toBe(false);
  }, 30_000);

  test("a gate rejection inside the workflow makes the task itself fail", async () => {
    write("workflows/core.md", agentWorkflow());
    write("tasks/core-daily.yml", ["version: 4", "name: Core daily", "uses: workflows/core", ""].join("\n"));
    installFakeSdk((call) => {
      if (call.model === JUDGE_MODEL)
        return JSON.stringify({ complete: false, missing: ["Every item is a non-empty string."] });
      if (call.prompt.includes("STEP-COLLECT")) return collectReply("widgets", ["a"]);
      return "{}";
    });

    const result = await runCliCapture(["task", "run", "core-daily"]);
    expect(result.code).not.toBe(0);
    const { runs } = await listWorkflowRuns();
    expect(runs.filter((run) => run.workflowRef.includes("core"))[0]?.status).not.toBe("completed");
  }, 30_000);
});

// ── 3. the owner's task shape: a shell `run:` line calling `akm workflow run` ─

/**
 * Exec-only workflow: needs no engine, so a REAL subprocess can run it. It
 * still exercises params (via AKM_PARAMS), ordered steps, `inputs:` (via
 * AKM_INPUTS) and typed `unit.output` / `output` on stdout JSON.
 */
const EXEC_WORKFLOW = [
  "---",
  "type: workflow",
  "description: Exec-only core fixture",
  "params:",
  "  topic: { type: string, default: widgets, description: Topic }",
  "  limit: { type: integer, default: 2, description: Limit }",
  "steps:",
  "  - id: collect",
  "    unit:",
  "      exec:",
  `        command: ["bun", "-e", "const p = JSON.parse(process.env.AKM_PARAMS); process.stdout.write(JSON.stringify({ topic: p.topic, count: p.limit }))"]`,
  "      output: { type: object, properties: { topic: { type: string }, count: { type: integer } }, required: [topic, count] }",
  "    output: { type: object, properties: { topic: { type: string }, count: { type: integer } }, required: [topic, count] }",
  "  - id: report",
  "    inputs: [steps.collect.output]",
  "    unit:",
  "      exec:",
  `        command: ["bun", "-e", "const i = JSON.parse(process.env.AKM_INPUTS); process.stdout.write(JSON.stringify({ line: i['steps.collect.output'].topic + ':' + i['steps.collect.output'].count }))"]`,
  "      output: { type: object, properties: { line: { type: string } }, required: [line] }",
  "    output: { type: object, properties: { line: { type: string } }, required: [line] }",
  "---",
  "",
  "## collect",
  "",
  "Emit the topic and limit.",
  "",
  "## report",
  "",
  "Join them.",
  "",
].join("\n");

describe("core feature set: a scheduled task that shells out to `akm workflow run`", () => {
  test("the literal owner-style run line starts, executes and completes the workflow as a real subprocess", async () => {
    write("workflows/exec-core.md", EXEC_WORKFLOW);
    // The shape of a real daily task: shell `run:`, a param flag and --skip-if-locked.
    write(
      "tasks/exec-daily.yml",
      [
        "version: 4",
        "name: Exec daily",
        "description: Neutral task whose run line calls the workflow verb",
        "run: akm workflow run workflows/exec-core --topic gadgets --limit 4 --skip-if-locked",
        "timeout: 120000",
        "",
      ].join("\n"),
    );
    const result = await runCliCapture(["task", "run", "exec-daily"]);
    expect(result.stderr).not.toContain("UNKNOWN_COMMAND");
    expect(result.code).toBe(0);

    // The task runs in its own working directory, so its run lives in another scope.
    const { runs } = await listWorkflowRuns({ allScopes: true });
    const exec = runs.filter((run) => run.workflowRef.includes("exec-core"));
    expect(exec).toHaveLength(1);
    expect(exec[0]?.status).toBe("completed");
    expect(exec[0]?.params).toMatchObject({ topic: "gadgets", limit: 4 });

    const status = await runCliCapture(["workflow", "status", exec[0]?.id ?? "", "--all-scopes"]);
    expect(status.stdout).toContain("gadgets:4");
  }, 120_000);

  test("a run line calling a verb that does not exist makes the task fail loudly", async () => {
    write("workflows/exec-core.md", EXEC_WORKFLOW);
    // This is the regression: the removed `workflow next` verb. The task must report failure,
    // never pass silently.
    write(
      "tasks/stale-daily.yml",
      ["version: 4", "name: Stale daily", "run: akm workflow next workflows/exec-core", "timeout: 60000", ""].join(
        "\n",
      ),
    );
    const result = await runCliCapture(["task", "run", "stale-daily"]);
    expect(result.code).not.toBe(0);
  }, 120_000);
});
