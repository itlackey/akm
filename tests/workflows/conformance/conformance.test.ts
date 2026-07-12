// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { cpuDerivedUnitConcurrency } from "../../../src/workflows/concurrency-policy";
import { closeWorkflowDatabase, openWorkflowDatabase } from "../../../src/workflows/db";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import type { WorkflowPlanGraph } from "../../../src/workflows/ir/schema";
import { frozenStepRows } from "../../../src/workflows/runtime/plan-classifier";
import { getWorkflowStatus } from "../../../src/workflows/runtime/runs";
import { freezeMarkdownWorkflow, freezeWorkflowProgram, storeFrozenWorkflowPlan } from "../../_helpers/workflow";

/**
 * Conformance suite (orchestration plan, §Anti-drift; conformance goldens
 * rewritten against YAML program sources per the R1 redesign addendum):
 * golden workflows run through every execution backend with mocked runners;
 * the suite asserts an identical compiled plan and an identical per-unit
 * graph. Today the native executor is the only backend — when the R3 driver
 * protocol lands, brief/report-driven runs plug into `BACKENDS` below and
 * every golden workflow must produce the same unit graph on each.
 *
 * The golden plans are EXPLICIT expected structures, not snapshots: a change
 * that alters the compiled IR or the executed unit graph must edit this file
 * knowingly.
 */

let tmpDir = "";
let prevDataDir: string | undefined;

const RUN_ID = "55555555-5555-4555-8555-555555555555";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-conformance-"));
  prevDataDir = process.env.AKM_DATA_DIR;
  process.env.AKM_DATA_DIR = tmpDir;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.AKM_DATA_DIR;
  else process.env.AKM_DATA_DIR = prevDataDir;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** Compile a golden YAML program source (the orchestrated frontend). */
function compile(yamlText: string): WorkflowPlanGraph {
  return freezeWorkflowProgram(yamlText, "workflows/golden.yaml");
}

/** Compile a golden classic markdown source (the stable linear contract). */
function compileMarkdown(markdown: string): WorkflowPlanGraph {
  return freezeMarkdownWorkflow(markdown, "workflows/golden.md");
}

function seedRun(plan: WorkflowPlanGraph, params: Record<string, unknown>): void {
  const steps = frozenStepRows(plan);
  const db = openWorkflowDatabase(path.join(tmpDir, "workflow.db"));
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
          params_json, current_step_id, created_at, updated_at)
       VALUES (?, 'workflow:golden', 'dir:v1:golden', NULL, 'Golden', 'active', ?, ?, ?, ?)`,
    ).run(RUN_ID, JSON.stringify(params), steps[0]?.stepId, now, now);
    steps.forEach((step) => {
      db.prepare(
        `INSERT INTO workflow_run_steps
           (run_id, step_id, step_title, instructions, completion_json, sequence_index, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      ).run(RUN_ID, step.stepId, step.stepTitle, step.instructions, step.completionJson, step.sequenceIndex);
    });
  } finally {
    closeWorkflowDatabase(db);
  }
}

/** Execution backends under conformance. R3 driver-protocol backends register here. */
const BACKENDS = [
  {
    name: "native",
    run: (plan: WorkflowPlanGraph) => {
      const db = openWorkflowDatabase(path.join(tmpDir, "workflow.db"));
      try {
        storeFrozenWorkflowPlan(db, RUN_ID, plan);
      } finally {
        closeWorkflowDatabase(db);
      }
      return runWorkflowSteps({
        target: RUN_ID,
        summaryJudge: null,
        dispatcher: async (req) =>
          req.schema ? { ok: true, text: '{"verdict": "pass"}' } : { ok: true, text: `did ${req.unitId}` },
        loadPlan: async () => plan,
      });
    },
  },
] as const;

/** The observable per-unit graph: (unitId, nodeId, parent, status) tuples. */
async function unitGraph(): Promise<Array<[string, string, string | null, string]>> {
  return withWorkflowRunsRepo((repo) =>
    repo
      .getUnitsForRun(RUN_ID)
      .map((u): [string, string, string | null, string] => [u.unit_id, u.node_id, u.parent_unit_id, u.status])
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
}

const FROZEN_EXECUTION: NonNullable<WorkflowPlanGraph["execution"]> = {
  maxConcurrency: cpuDerivedUnitConcurrency(),
  engines: {
    "test-agent": {
      name: "test-agent",
      kind: "agent",
      runnerKind: "sdk",
      platform: "opencode-sdk",
      bin: "opencode",
      args: [],
      workspace: null,
      envPassthrough: [],
      commandBuilder: "opencode-sdk",
      fallbackLlmEngine: "test-llm",
    },
    "test-llm": {
      name: "test-llm",
      kind: "llm",
      endpoint: "http://localhost:1/v1/chat/completions",
      model: "test-model",
      credential: { names: ["AKM_ENGINE_TEST_LLM_API_KEY", "AKM_LLM_API_KEY"], required: false },
      concurrency: 1,
    },
  },
};

function linearGolden(
  templating: "expressions" | "verbatim",
  sources: [{ path: string; start: number; end: number }, { path: string; start: number; end: number }],
): WorkflowPlanGraph {
  const unit = (id: string, instructions: string, source: (typeof sources)[number]) => ({
    kind: "unit" as const,
    id,
    instructions,
    templating,
    invocation: { engine: "test-agent", model: null, timeoutMs: 600_000 },
    onError: "fail" as const,
    isolation: "none" as const,
    source,
  });
  return {
    irVersion: 3,
    title: "Golden",
    execution: FROZEN_EXECUTION,
    steps: [
      {
        stepId: "build",
        title: "Build",
        sequenceIndex: 0,
        root: unit("build", "Build it.", sources[0]),
        gate: {
          kind: "gate",
          id: "build.gate",
          stepId: "build",
          criteria: ["artifact exists"],
          maxLoops: 1,
          required: false,
          judge: { engine: "test-llm", model: "test-model", timeoutMs: 600_000 },
        },
      },
      {
        stepId: "deploy",
        title: "Deploy",
        sequenceIndex: 1,
        root: unit("deploy", "Deploy it.", sources[1]),
        gate: {
          kind: "gate",
          id: "deploy.gate",
          stepId: "deploy",
          criteria: [],
          maxLoops: 1,
          required: false,
          judge: null,
        },
      },
    ],
  };
}

// ── Golden 1: linear program (behavior identical to the classic step loop) ──

const LINEAR = `version: 2
name: Golden
steps:
  - id: build
    title: Build
    unit:
      instructions: Build it.
    gate:
      criteria: [artifact exists]
  - id: deploy
    title: Deploy
    unit:
      instructions: Deploy it.
`;

describe("conformance — linear workflow", () => {
  test("compiles to the golden plan", () => {
    expect(compile(LINEAR)).toEqual(
      linearGolden("expressions", [
        { path: "workflows/golden.yaml", start: 7, end: 7 },
        { path: "workflows/golden.yaml", start: 13, end: 13 },
      ]),
    );
  });

  for (const backend of BACKENDS) {
    test(`${backend.name}: executes the golden unit graph`, async () => {
      const plan = compile(LINEAR);
      seedRun(plan, {});
      const result = await backend.run(plan);
      expect(result.done).toBe(true);
      // Content-derived unit identity (R2): solo units are `<node_id>:solo`.
      expect(await unitGraph()).toEqual([
        ["build:solo", "build", null, "completed"],
        ["deploy:solo", "deploy", null, "completed"],
      ]);
    });
  }
});

// ── Golden 1b: classic linear markdown (the stable CLI contract) ────────────

const LINEAR_MD = `# Workflow: Golden

## Step: Build
Step ID: build

### Instructions
Build it.

### Completion Criteria
- artifact exists

## Step: Deploy
Step ID: deploy

### Instructions
Deploy it.
`;

describe("conformance — classic linear markdown (stable contract)", () => {
  test("compiles to the same golden plan shape as the linear program", () => {
    expect(compileMarkdown(LINEAR_MD)).toEqual(
      linearGolden("verbatim", [
        { path: "workflows/golden.md", start: 7, end: 8 },
        { path: "workflows/golden.md", start: 16, end: 17 },
      ]),
    );
  });

  for (const backend of BACKENDS) {
    test(`${backend.name}: executes the golden unit graph`, async () => {
      const plan = compileMarkdown(LINEAR_MD);
      seedRun(plan, {});
      const result = await backend.run(plan);
      expect(result.done).toBe(true);
      expect(await unitGraph()).toEqual([
        ["build:solo", "build", null, "completed"],
        ["deploy:solo", "deploy", null, "completed"],
      ]);
    });
  }
});

// ── Golden 2: fan-out + schema + vote reducer ────────────────────────────────

const FAN_OUT_VOTE = `version: 2
name: Golden
params:
  attempts: { type: array }
steps:
  - id: judge
    title: Judge
    map:
      over: \${{ params.attempts }}
      concurrency: 2
      reducer: vote
      unit:
        instructions: Judge \${{ item }}.
        output:
          type: object
          properties: { verdict: { type: string } }
          required: [verdict]
`;

describe("conformance — fan-out + schema + vote", () => {
  test("compiles to the golden plan", () => {
    const plan = compile(FAN_OUT_VOTE);
    expect(plan.params).toEqual(["attempts"]);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toEqual({
      stepId: "judge",
      title: "Judge",
      sequenceIndex: 0,
      root: {
        kind: "map",
        id: "judge.map",
        over: "${{ params.attempts }}",
        template: {
          kind: "unit",
          id: "judge.unit",
          instructions: "Judge ${{ item }}.",
          templating: "expressions",
          invocation: { engine: "test-agent", model: null, timeoutMs: 600_000 },
          onError: "fail",
          isolation: "none",
          schema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] },
          source: { path: "workflows/golden.yaml", start: 13, end: 17 },
        },
        concurrency: 2,
        reducer: "vote",
        source: { path: "workflows/golden.yaml", start: 6, end: 17 },
      },
      gate: {
        kind: "gate",
        id: "judge.gate",
        stepId: "judge",
        criteria: [],
        maxLoops: 1,
        required: false,
        judge: null,
      },
    });
  });

  for (const backend of BACKENDS) {
    test(`${backend.name}: executes the golden unit graph with vote evidence`, async () => {
      const plan = compile(FAN_OUT_VOTE);
      seedRun(plan, { attempts: [1, 2, 3] });
      const result = await backend.run(plan);
      expect(result.done).toBe(true);
      // Content-derived fan-out identity: `<node_id>:<sha256(canonicalJson(item))[:12]>`
      // for items 1, 2, 3 — position-independent, sorted by unit_id here.
      expect(await unitGraph()).toEqual([
        ["judge.unit:4e07408562be", "judge.unit", "judge.map", "completed"], // item 3
        ["judge.unit:6b86b273ff34", "judge.unit", "judge.map", "completed"], // item 1
        ["judge.unit:d4735e3a265e", "judge.unit", "judge.map", "completed"], // item 2
      ]);
      const status = await getWorkflowStatus(RUN_ID);
      expect(status.workflow.steps[0].evidence?.vote).toEqual({
        winner: { verdict: "pass" },
        votes: 3,
        total: 3,
      });
      // The promoted step artifact of a vote step IS the winner — what
      // `${{ steps.judge.output }}` resolves to downstream.
      expect(status.workflow.steps[0].evidence?.output).toEqual({ verdict: "pass" });
    });
  }
});

// ── Golden 3: routed workflow (route-only step, explicit input) ─────────────

const ROUTED = `version: 2
name: Golden
steps:
  - id: classify
    title: Classify
    unit:
      instructions: Classify.
      output:
        type: object
        properties: { verdict: { type: string } }
        required: [verdict]
  - id: triage
    title: Triage
    route:
      input: \${{ steps.classify.output.verdict }}
      when: { pass: ship, fail: rework }
  - id: ship
    title: Ship
    unit:
      instructions: Ship it.
  - id: rework
    title: Rework
    unit:
      instructions: Rework it.
`;

describe("conformance — routed workflow", () => {
  test("compiles the route into a route-only step plan", () => {
    const plan = compile(ROUTED);
    expect(plan.steps[1]).toEqual({
      stepId: "triage",
      title: "Triage",
      sequenceIndex: 1,
      route: {
        input: "${{ steps.classify.output.verdict }}",
        when: { pass: "ship", fail: "rework" },
      },
      gate: {
        kind: "gate",
        id: "triage.gate",
        stepId: "triage",
        criteria: [],
        maxLoops: 1,
        required: false,
        judge: null,
      },
    });
    expect(plan.steps[1].root).toBeUndefined();
  });

  for (const backend of BACKENDS) {
    test(`${backend.name}: selected branch dispatches, unselected is skipped with no units`, async () => {
      const plan = compile(ROUTED);
      seedRun(plan, {});
      const result = await backend.run(plan);
      expect(result.done).toBe(true);
      // Neither the route step nor rework may have unit rows — the route
      // dispatches nothing, and rework never ran.
      expect(await unitGraph()).toEqual([
        ["classify:solo", "classify", null, "completed"],
        ["ship:solo", "ship", null, "completed"],
      ]);
      const status = await getWorkflowStatus(RUN_ID);
      const byId = new Map(status.workflow.steps.map((s) => [s.id, s.status]));
      expect(byId.get("triage")).toBe("completed");
      expect(byId.get("rework")).toBe("skipped");
    });
  }
});
