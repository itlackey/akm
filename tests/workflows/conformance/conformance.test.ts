// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { closeWorkflowDatabase, openWorkflowDatabase } from "../../../src/workflows/db";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { compileWorkflowPlan, compileWorkflowProgram } from "../../../src/workflows/ir/compile";
import type { WorkflowPlanGraph } from "../../../src/workflows/ir/schema";
import { parseWorkflow } from "../../../src/workflows/parser";
import { parseWorkflowProgram } from "../../../src/workflows/program/parser";
import { getWorkflowStatus } from "../../../src/workflows/runtime/runs";

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
  const parsed = parseWorkflowProgram(yamlText, { path: "workflows/golden.yaml" });
  if (!parsed.ok) throw new Error(parsed.errors.map((e) => `${e.line}: ${e.message}`).join(" | "));
  const compiled = compileWorkflowProgram(parsed.program);
  if (!compiled.ok) throw new Error(compiled.errors.map((e) => `${e.line}: ${e.message}`).join(" | "));
  return compiled.plan;
}

/** Compile a golden classic markdown source (the stable linear contract). */
function compileMarkdown(markdown: string): WorkflowPlanGraph {
  const result = parseWorkflow(markdown, { path: "workflows/golden.md" });
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join(" | "));
  return compileWorkflowPlan(result.document);
}

function seedRun(params: Record<string, unknown>, stepIds: string[]): void {
  const db = openWorkflowDatabase(path.join(tmpDir, "workflow.db"));
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
          params_json, current_step_id, created_at, updated_at)
       VALUES (?, 'workflow:golden', 'dir:v1:golden', NULL, 'Golden', 'active', ?, ?, ?, ?)`,
    ).run(RUN_ID, JSON.stringify(params), stepIds[0], now, now);
    stepIds.forEach((id, i) => {
      db.prepare(
        `INSERT INTO workflow_run_steps
           (run_id, step_id, step_title, instructions, completion_json, sequence_index, status)
         VALUES (?, ?, ?, 'instructions', NULL, ?, 'pending')`,
      ).run(RUN_ID, id, id, i);
    });
  } finally {
    closeWorkflowDatabase(db);
  }
}

/** Execution backends under conformance. R3 driver-protocol backends register here. */
const BACKENDS = [
  {
    name: "native",
    run: (plan: WorkflowPlanGraph) =>
      runWorkflowSteps({
        target: RUN_ID,
        dispatcher: async (req) =>
          req.schema ? { ok: true, text: '{"verdict": "pass"}' } : { ok: true, text: `did ${req.unitId}` },
        loadPlan: async () => plan,
      }),
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

const GOLDEN_SOURCE = expect.objectContaining({ path: "workflows/golden.yaml" });

// ── Golden 1: linear program (behavior identical to the classic step loop) ──

const LINEAR = `version: 1
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
    expect(compile(LINEAR)).toEqual({
      irVersion: 2,
      title: "Golden",
      steps: [
        {
          stepId: "build",
          title: "Build",
          sequenceIndex: 0,
          root: {
            kind: "agent",
            id: "build",
            instructions: "Build it.",
            runner: "inherit",
            onError: "fail",
            source: GOLDEN_SOURCE,
          },
          gate: { kind: "gate", id: "build.gate", stepId: "build", criteria: ["artifact exists"] },
        },
        {
          stepId: "deploy",
          title: "Deploy",
          sequenceIndex: 1,
          root: {
            kind: "agent",
            id: "deploy",
            instructions: "Deploy it.",
            runner: "inherit",
            onError: "fail",
            source: GOLDEN_SOURCE,
          },
          gate: { kind: "gate", id: "deploy.gate", stepId: "deploy", criteria: [] },
        },
      ],
    });
  });

  for (const backend of BACKENDS) {
    test(`${backend.name}: executes the golden unit graph`, async () => {
      seedRun({}, ["build", "deploy"]);
      const result = await backend.run(compile(LINEAR));
      expect(result.done).toBe(true);
      expect(await unitGraph()).toEqual([
        ["build", "build", null, "completed"],
        ["deploy", "deploy", null, "completed"],
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
    expect(compileMarkdown(LINEAR_MD)).toEqual({
      irVersion: 2,
      title: "Golden",
      steps: [
        {
          stepId: "build",
          title: "Build",
          sequenceIndex: 0,
          root: {
            kind: "agent",
            id: "build",
            instructions: "Build it.",
            runner: "inherit",
            onError: "fail",
            source: { path: "workflows/golden.md", start: 7, end: 8 },
          },
          gate: { kind: "gate", id: "build.gate", stepId: "build", criteria: ["artifact exists"] },
        },
        {
          stepId: "deploy",
          title: "Deploy",
          sequenceIndex: 1,
          root: {
            kind: "agent",
            id: "deploy",
            instructions: "Deploy it.",
            runner: "inherit",
            onError: "fail",
            source: { path: "workflows/golden.md", start: 16, end: 17 },
          },
          gate: { kind: "gate", id: "deploy.gate", stepId: "deploy", criteria: [] },
        },
      ],
    });
  });

  for (const backend of BACKENDS) {
    test(`${backend.name}: executes the golden unit graph`, async () => {
      seedRun({}, ["build", "deploy"]);
      const result = await backend.run(compileMarkdown(LINEAR_MD));
      expect(result.done).toBe(true);
      expect(await unitGraph()).toEqual([
        ["build", "build", null, "completed"],
        ["deploy", "deploy", null, "completed"],
      ]);
    });
  }
});

// ── Golden 2: fan-out + schema + vote reducer ────────────────────────────────

const FAN_OUT_VOTE = `version: 1
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
          kind: "agent",
          id: "judge.unit",
          instructions: "Judge ${{ item }}.",
          runner: "inherit",
          onError: "fail",
          schema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] },
          source: GOLDEN_SOURCE,
        },
        concurrency: 2,
        reducer: "vote",
        source: GOLDEN_SOURCE,
      },
      gate: { kind: "gate", id: "judge.gate", stepId: "judge", criteria: [] },
    });
  });

  for (const backend of BACKENDS) {
    test(`${backend.name}: executes the golden unit graph with vote evidence`, async () => {
      seedRun({ attempts: [1, 2, 3] }, ["judge"]);
      const result = await backend.run(compile(FAN_OUT_VOTE));
      expect(result.done).toBe(true);
      expect(await unitGraph()).toEqual([
        ["judge.unit[0]", "judge.unit", "judge.map", "completed"],
        ["judge.unit[1]", "judge.unit", "judge.map", "completed"],
        ["judge.unit[2]", "judge.unit", "judge.map", "completed"],
      ]);
      const status = await getWorkflowStatus(RUN_ID);
      expect(status.workflow.steps[0].evidence?.vote).toEqual({
        winner: { verdict: "pass" },
        votes: 3,
        total: 3,
      });
    });
  }
});

// ── Golden 3: routed workflow (route-only step, explicit input) ─────────────

const ROUTED = `version: 1
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
      input: \${{ steps.classify.output.units[0].result.verdict }}
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
        input: "${{ steps.classify.output.units[0].result.verdict }}",
        when: { pass: "ship", fail: "rework" },
      },
      gate: { kind: "gate", id: "triage.gate", stepId: "triage", criteria: [] },
    });
    expect(plan.steps[1].root).toBeUndefined();
  });

  for (const backend of BACKENDS) {
    test(`${backend.name}: selected branch dispatches, unselected is skipped with no units`, async () => {
      seedRun({}, ["classify", "triage", "ship", "rework"]);
      const result = await backend.run(compile(ROUTED));
      expect(result.done).toBe(true);
      // Neither the route step nor rework may have unit rows — the route
      // dispatches nothing, and rework never ran.
      expect(await unitGraph()).toEqual([
        ["classify", "classify", null, "completed"],
        ["ship", "ship", null, "completed"],
      ]);
      const status = await getWorkflowStatus(RUN_ID);
      const byId = new Map(status.workflow.steps.map((s) => [s.id, s.status]));
      expect(byId.get("triage")).toBe("completed");
      expect(byId.get("rework")).toBe("skipped");
    });
  }
});
