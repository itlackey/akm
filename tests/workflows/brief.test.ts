// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `\${{ … }}` is the
// workflow expression grammar under test, not a JS template literal.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkflowRunStatus } from "../../src/sources/types";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { closeWorkflowDatabase, openWorkflowDatabase } from "../../src/workflows/db";
import { buildWorkflowBrief } from "../../src/workflows/exec/brief";
import { computeStepWorkList } from "../../src/workflows/exec/step-work";
import { canonicalPlanJson, computePlanHash } from "../../src/workflows/ir/plan-hash";
import type { WorkflowPlanGraph } from "../../src/workflows/ir/schema";
import { frozenStepRows } from "../../src/workflows/runtime/plan-classifier";
import { freezeWorkflowProgram } from "../_helpers/workflow";

/**
 * `akm workflow brief` (redesign addendum R3, task step 2). Proves brief:
 *   - is read-only (workflow.db byte-identical before/after);
 *   - predicts the engine's work-list via the SHARED step-work module (unit
 *     ids / input hashes equal `computeStepWorkList`), across solo, fan-out
 *     (mixed journaled statuses), and gate loop 2 (feedback recovered from the
 *     journaled gate row);
 *   - surfaces the deterministic route decision, a completed run's empty list,
 *     a live engine lease warning, and a clear error for a legacy NULL-plan run.
 */

let tmpDir = "";
let prevDataDir: string | undefined;
const RUN_ID = "12345678-1234-4123-8123-123456789abc";

function dbPath(): string {
  return path.join(tmpDir, "workflow.db");
}

function plan(yamlText: string): WorkflowPlanGraph {
  return freezeWorkflowProgram(yamlText);
}

interface SeedStep {
  id: string;
  title?: string;
  criteria?: string[];
  status?: "pending" | "completed" | "failed" | "blocked" | "skipped";
  evidence?: Record<string, unknown>;
}

interface SeedUnit {
  unitId: string;
  stepId: string;
  nodeId: string;
  phase?: string | null;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  inputHash?: string | null;
  resultJson?: string | null;
  tokens?: number | null;
  failureReason?: string | null;
  /** Override the row's first-claim timestamp (drives stale-unit evaluation). */
  startedAt?: string;
  claimHolder?: string | null;
  claimExpiresAt?: string | null;
  lastCheckinAt?: string | null;
}

function seedRun(opts: {
  plan?: WorkflowPlanGraph | null;
  status?: WorkflowRunStatus;
  currentStepId?: string | null;
  params?: Record<string, unknown>;
  steps: SeedStep[];
  units?: SeedUnit[];
  lease?: { holder: string; until: string };
}): void {
  const db = openWorkflowDatabase(dbPath());
  try {
    const now = new Date().toISOString();
    const frozen = opts.plan === null ? null : (opts.plan ?? null);
    const planJson = frozen ? canonicalPlanJson(frozen) : null;
    const planHash = frozen ? computePlanHash(frozen) : null;
    const current =
      opts.currentStepId !== undefined
        ? opts.currentStepId
        : (opts.steps.find((s) => (s.status ?? "pending") === "pending")?.id ?? null);
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
           params_json, current_step_id, created_at, updated_at, plan_json, plan_hash, plan_ir_version,
           engine_lease_holder, engine_lease_until)
        VALUES (?, 'workflow:demo', 'dir:v1:demo', NULL, 'Demo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      RUN_ID,
      opts.status ?? "active",
      JSON.stringify(opts.params ?? {}),
      current,
      now,
      now,
      planJson,
      planHash,
      frozen?.irVersion ?? null,
      opts.lease?.holder ?? null,
      opts.lease?.until ?? null,
    );
    const plannedSteps = new Map((frozen ? frozenStepRows(frozen) : []).map((step) => [step.stepId, step]));
    opts.steps.forEach((step, i) => {
      const planned = plannedSteps.get(step.id);
      db.prepare(
        `INSERT INTO workflow_run_steps
           (run_id, step_id, step_title, instructions, completion_json, sequence_index, status, evidence_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        RUN_ID,
        step.id,
        planned?.stepTitle ?? step.title ?? step.id,
        planned?.instructions ?? "instructions",
        planned?.completionJson ?? (step.criteria ? JSON.stringify(step.criteria) : null),
        planned?.sequenceIndex ?? i,
        step.status ?? "pending",
        step.evidence ? JSON.stringify(step.evidence) : null,
      );
    });
    for (const u of opts.units ?? []) {
      db.prepare(
        `INSERT INTO workflow_run_units
           (run_id, unit_id, step_id, node_id, parent_unit_id, phase, runner, model, status,
            input_hash, result_json, tokens, failure_reason, worktree_path, started_at, finished_at,
            last_checkin_at, claim_holder, claim_expires_at)
         VALUES (?, ?, ?, ?, NULL, ?, 'sdk', NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      ).run(
        RUN_ID,
        u.unitId,
        u.stepId,
        u.nodeId,
        u.phase ?? null,
        u.status,
        u.inputHash ?? null,
        u.resultJson ?? null,
        u.tokens ?? null,
        u.failureReason ?? null,
        u.startedAt ?? now,
        u.status === "completed" || u.status === "failed" ? now : null,
        u.lastCheckinAt ?? null,
        u.claimHolder ?? null,
        u.claimExpiresAt ?? null,
      );
    }
  } finally {
    closeWorkflowDatabase(db);
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-brief-"));
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

// ── Workflows ────────────────────────────────────────────────────────────────

const SOLO_WF = `version: 2
name: Solo
steps:
  - id: build
    title: Build
    unit:
      instructions: Build \${{ params.target }}.
      env: [env:ci-secrets]
    gate:
      criteria: [the build passes]
  - id: wrap
    title: Wrap
    unit:
      instructions: Wrap up.
`;

const FANOUT_WF = `version: 2
name: Fanout
steps:
  - id: review
    title: Review
    map:
      over: \${{ params.files }}
      reducer: collect
      unit:
        instructions: Review \${{ item }}.
        output:
          type: object
          properties: { verdict: { type: string } }
          required: [verdict]
`;

const LOOP_WF = `version: 2
name: Loop
steps:
  - id: work
    title: Work
    unit:
      instructions: Do the work.
    gate:
      criteria: [the work is thorough]
      max_loops: 3
`;

const ROUTE_WF = `version: 2
name: Route
steps:
  - id: judge
    title: Judge
    unit:
      instructions: Judge it.
  - id: triage
    title: Triage
    route:
      input: \${{ steps.judge.output.verdict }}
      when: { pass: ship, fail: rework }
      default: rework
  - id: ship
    title: Ship
    unit:
      instructions: Ship it.
  - id: rework
    title: Rework
    unit:
      instructions: Rework it.
`;

// ── Tests ────────────────────────────────────────────────────────────────────

describe("workflow brief — solo step", () => {
  test("emits the active step's single unit with env NAMES only + report command", async () => {
    const p = plan(SOLO_WF);
    seedRun({
      plan: p,
      params: { target: "widget" },
      steps: [{ id: "build", criteria: ["the build passes"] }, { id: "wrap" }],
    });

    const brief = await buildWorkflowBrief(RUN_ID);
    expect(brief.active).toBe(true);
    expect(brief.step?.stepId).toBe("build");
    expect(brief.step?.kind).toBe("execute");
    expect(brief.step?.gate.currentLoop).toBe(1);
    expect(brief.step?.gate.judgesArtifact).toBe(true);
    expect(brief.workList.units).toHaveLength(1);

    const u = brief.workList.units[0];
    // Predicts the engine: unit id + input hash equal computeStepWorkList.
    const engine = computeStepWorkList(p.steps[0], {
      runId: RUN_ID,
      params: { target: "widget" },
      stepOutputs: {},
      engines: p.execution?.engines,
    });
    expect(engine.ok).toBe(true);
    if (engine.ok) {
      expect(u.unitId).toBe(engine.list.units[0].unitId);
      if (u.resolved.ok && engine.list.units[0].resolved.ok) {
        expect(u.resolved.inputHash).toBe(engine.list.units[0].resolved.inputHash);
        expect(u.resolved.instructions).toContain("Build widget.");
      }
    }
    // Env is surfaced as REF NAMES, never resolved values.
    expect(u.env).toEqual(["env:ci-secrets"]);
    // The rest of the required per-unit contract (node id, frozen engine attribution, timeout,
    // on_error) is carried too — a driver needs every one to dispatch.
    expect(u.nodeId).toBe("build");
    expect(u.engine).toBe("test-agent");
    expect(u.runtimeKind).toBe("sdk");
    expect(u.platform).toBe("opencode-sdk");
    expect(u.model).toBeNull();
    expect(u).not.toHaveProperty("runner");
    expect(u).not.toHaveProperty("profile");
    expect(u.timeoutMs).toBe(600_000);
    expect(u.onError).toBe("fail");
    // #15: an un-journaled unit is `pending` with the completed report command,
    // and #14 embeds the --expect-step spine guard in it.
    expect(u.action).toBe("pending");
    expect(u.report).toContain(`report ${RUN_ID} --unit ${u.unitId} --expect-step build --status completed`);
    expect(u.journaled).toBeUndefined();
    // #14: the brief carries a spine watermark token stamping the active step.
    expect(brief.spineToken).toContain(`${RUN_ID}#build#l1#`);
  });

  test("attributes an LLM unit to its frozen engine and exact model without legacy selectors", async () => {
    const p = plan(`version: 2
name: Direct LLM
defaults: { engine: test-llm }
steps:
  - id: answer
    unit: { instructions: Answer directly. }
`);
    seedRun({ plan: p, steps: [{ id: "answer" }] });

    const unit = (await buildWorkflowBrief(RUN_ID)).workList.units[0];
    expect(unit).toMatchObject({
      engine: "test-llm",
      runtimeKind: "llm",
      platform: null,
      model: "test-model",
    });
    expect(unit).not.toHaveProperty("runner");
    expect(unit).not.toHaveProperty("profile");
  });
});

describe("workflow brief — read-only", () => {
  test("leaves workflow.db byte-identical", async () => {
    seedRun({ plan: plan(SOLO_WF), params: { target: "x" }, steps: [{ id: "build" }, { id: "wrap" }] });
    // Settle any residual WAL frames so the pre/post snapshots compare cleanly.
    await withWorkflowRunsRepo((repo) => repo.getRunById(RUN_ID));

    const before = createHash("sha256").update(fs.readFileSync(dbPath())).digest("hex");
    await buildWorkflowBrief(RUN_ID);
    const after = createHash("sha256").update(fs.readFileSync(dbPath())).digest("hex");
    expect(after).toBe(before);
  });
});

describe("workflow brief — fan-out with mixed journaled statuses", () => {
  test("surfaces per-unit journaled status and predicts every content-derived id", async () => {
    const p = plan(FANOUT_WF);
    const params = { files: ["a.ts", "b.ts", "c.ts"] };
    const engine = computeStepWorkList(p.steps[0], { runId: RUN_ID, params, stepOutputs: {} });
    expect(engine.ok).toBe(true);
    if (!engine.ok) return;
    const [ua, ub, uc] = engine.list.units;

    // a.ts already completed, b.ts failed, c.ts never dispatched.
    seedRun({
      plan: p,
      params,
      steps: [{ id: "review" }],
      units: [
        {
          unitId: ua.unitId,
          stepId: "review",
          nodeId: ua.nodeId,
          status: "completed",
          inputHash: ua.resolved.ok ? ua.resolved.inputHash : null,
          resultJson: JSON.stringify({ verdict: "ok" }),
          tokens: 42,
        },
        { unitId: ub.unitId, stepId: "review", nodeId: ub.nodeId, status: "failed", failureReason: "timeout" },
      ],
    });

    const brief = await buildWorkflowBrief(RUN_ID);
    expect(brief.workList.isFanOut).toBe(true);
    expect(brief.workList.itemCount).toBe(3);
    const byId = new Map(brief.workList.units.map((u) => [u.unitId, u]));
    expect(byId.get(ua.unitId)?.journaled?.status).toBe("completed");
    expect(byId.get(ua.unitId)?.journaled?.tokens).toBe(42);
    expect(byId.get(ub.unitId)?.journaled?.status).toBe("failed");
    expect(byId.get(ub.unitId)?.journaled?.failureReason).toBe("timeout");
    expect(byId.get(uc.unitId)?.journaled).toBeUndefined();
    // Every unit carries its output schema + fan-out item.
    expect(byId.get(ua.unitId)?.outputSchema).toBeDefined();
    expect(byId.get(ua.unitId)?.item).toBe("a.ts");

    // #15: action derivation + report-command suppression for terminal rows.
    // a.ts completed → `done`, no report command.
    expect(byId.get(ua.unitId)?.action).toBe("done");
    expect(byId.get(ua.unitId)?.report).toBeUndefined();
    // b.ts failed → `failed`, only the `--rerun` form is offered.
    expect(byId.get(ub.unitId)?.action).toBe("failed");
    expect(byId.get(ub.unitId)?.report).toContain("--rerun");
    // c.ts never dispatched → `pending`, normal completed command (no --rerun).
    expect(byId.get(uc.unitId)?.action).toBe("pending");
    expect(byId.get(uc.unitId)?.report).toContain("--status completed");
    expect(byId.get(uc.unitId)?.report).not.toContain("--rerun");
  });
});

describe("workflow brief — gate loop 2", () => {
  test("recovers feedback from the journaled gate row; unit ids match the engine's loop-2 dispatch", async () => {
    const p = plan(LOOP_WF);
    const reject = { complete: false, missing: ["the work is thorough"], feedback: "Add the analysis." };
    seedRun({
      plan: p,
      steps: [{ id: "work", criteria: ["the work is thorough"] }],
      units: [
        {
          unitId: "work.gate:l1",
          stepId: "work",
          nodeId: "work.gate",
          phase: "gate",
          status: "completed",
          resultJson: JSON.stringify(reject),
        },
      ],
    });

    const brief = await buildWorkflowBrief(RUN_ID);
    expect(brief.step?.gate.currentLoop).toBe(2);
    expect(brief.gateFeedback).toEqual({ feedback: "Add the analysis.", missing: ["the work is thorough"] });

    const u = brief.workList.units[0];
    // The engine would compute loop 2 the same way — ids, hashes, prompt.
    const engine = computeStepWorkList(p.steps[0], {
      runId: RUN_ID,
      params: {},
      stepOutputs: {},
      gateLoop: 2,
      gateFeedback: { feedback: "Add the analysis.", missing: ["the work is thorough"] },
      engines: p.execution?.engines,
    });
    expect(engine.ok).toBe(true);
    if (engine.ok && u.resolved.ok && engine.list.units[0].resolved.ok) {
      expect(u.unitId).toBe(engine.list.units[0].unitId);
      expect(u.resolved.inputHash).toBe(engine.list.units[0].resolved.inputHash);
      expect(u.resolved.instructions).toBe(engine.list.units[0].resolved.prompt);
      expect(u.resolved.instructions).toContain("Add the analysis.");
    }
  });
});

describe("workflow brief — route step", () => {
  test("shows the deterministic decision contract and the selected branch", async () => {
    seedRun({
      plan: plan(ROUTE_WF),
      currentStepId: "triage",
      steps: [
        { id: "judge", status: "completed", evidence: { output: { verdict: "pass" } } },
        { id: "triage" },
        { id: "ship" },
        { id: "rework" },
      ],
    });

    const brief = await buildWorkflowBrief(RUN_ID);
    expect(brief.step?.kind).toBe("route");
    expect(brief.workList.units).toHaveLength(0);
    expect(brief.route?.input).toBe("${{ steps.judge.output.verdict }}");
    expect(brief.route?.when).toEqual({ pass: "ship", fail: "rework" });
    expect(brief.route?.evaluatedNow).toBe(true);
    expect(brief.route?.decision).toEqual({ value: "pass", selected: "ship" });
  });
});

describe("workflow brief — completed run", () => {
  test("reports done with an empty work-list", async () => {
    seedRun({
      plan: plan(SOLO_WF),
      status: "completed",
      currentStepId: null,
      steps: [
        { id: "build", status: "completed" },
        { id: "wrap", status: "completed" },
      ],
    });

    const brief = await buildWorkflowBrief(RUN_ID);
    expect(brief.done).toBe(true);
    expect(brief.active).toBe(false);
    expect(brief.workList.units).toHaveLength(0);
    expect(brief.message).toContain("completed");
  });
});

describe("workflow brief — legacy run (NULL plan_json)", () => {
  test("errors clearly, pointing at engine-driven mode", async () => {
    seedRun({ plan: null, params: { target: "x" }, steps: [{ id: "build" }, { id: "wrap" }] });
    await expect(buildWorkflowBrief(RUN_ID)).rejects.toThrow(
      /no executable workflow IR plan.*inspection-only.*workflow abandon/s,
    );
  });
});

describe("workflow brief — live engine lease", () => {
  test("surfaces the lease and a loud warning", async () => {
    const until = new Date(Date.now() + 60_000).toISOString();
    seedRun({
      plan: plan(SOLO_WF),
      params: { target: "x" },
      steps: [{ id: "build" }, { id: "wrap" }],
      lease: { holder: "engine-abc", until },
    });

    const brief = await buildWorkflowBrief(RUN_ID);
    expect(brief.engineLease).toEqual({ holder: "engine-abc", until, live: true });
    expect(brief.warnings.some((w) => w.includes("LIVE run lease") && w.includes("engine-abc"))).toBe(true);
  });

  test("an expired lease is surfaced but not live and raises no warning", async () => {
    const until = new Date(Date.now() - 60_000).toISOString();
    seedRun({
      plan: plan(SOLO_WF),
      params: { target: "x" },
      steps: [{ id: "build" }, { id: "wrap" }],
      lease: { holder: "engine-old", until },
    });

    const brief = await buildWorkflowBrief(RUN_ID);
    expect(brief.engineLease?.live).toBe(false);
    expect(brief.warnings.some((w) => w.includes("LIVE run lease"))).toBe(false);
  });
});

describe("workflow brief — unknown run", () => {
  test("a missing run id is a not-found error", async () => {
    seedRun({ plan: plan(SOLO_WF), steps: [{ id: "build" }, { id: "wrap" }] });
    await expect(buildWorkflowBrief("nonexistent-run-id")).rejects.toThrow(/not found/i);
  });
});

describe("workflow brief — secret-shaped params (#13)", () => {
  test("warns loudly on a credential-looking param value and a secret-suggesting key", async () => {
    seedRun({
      plan: plan(SOLO_WF),
      params: { target: "widget", apiKey: "sk-abcdEFGH1234ijklMNOP5678qrstUVWX" },
      steps: [{ id: "build" }, { id: "wrap" }],
    });
    const brief = await buildWorkflowBrief(RUN_ID);
    // The standing advisory (params are non-secret, part of every prompt).
    expect(brief.warnings.some((w) => w.includes("NOT secret") && w.includes("env bindings"))).toBe(true);
    // The best-effort secret-shaped-value hit names the offending path.
    expect(brief.warnings.some((w) => w.includes('"apiKey"'))).toBe(true);
  });

  test("no standing advisory when a run carries no params", async () => {
    seedRun({ plan: plan(LOOP_WF), steps: [{ id: "work", criteria: ["thorough"] }] });
    const brief = await buildWorkflowBrief(RUN_ID);
    expect(brief.warnings.some((w) => w.includes("NOT secret"))).toBe(false);
  });
});

describe("workflow brief — unit action states (#15)", () => {
  test("a live-claimed running unit is `claimed`; a live engine lease makes it `do_not_run`", async () => {
    const p = plan(LOOP_WF);
    const engine = computeStepWorkList(p.steps[0], { runId: RUN_ID, params: {}, stepOutputs: {} });
    if (!engine.ok) throw new Error("compute failed");
    const solo = engine.list.units[0];
    seedRun({
      plan: p,
      steps: [{ id: "work", criteria: ["thorough"] }],
      units: [
        {
          unitId: solo.unitId,
          stepId: "work",
          nodeId: solo.nodeId,
          status: "running",
          inputHash: solo.resolved.ok ? solo.resolved.inputHash : null,
          claimHolder: "claim:other",
          claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    });
    const brief = await buildWorkflowBrief(RUN_ID);
    expect(brief.workList.units[0].action).toBe("claimed");
    expect(brief.workList.units[0].journaled?.claimedBy).toBe("claim:other");
    // Finding 2: a live-claimed unit's report command MUST carry the holder's
    // --session-id (only that holder can finish it), so a second driver reads it
    // as spoken-for rather than free, runnable work.
    const claimedCmd = brief.workList.units[0].report ?? "";
    expect(claimedCmd).toContain("--session-id claim:other");
    expect(claimedCmd).toContain("--status completed");
  });

  test("a running unit silent past the window is `stale` and reclaimable", async () => {
    const p = plan(LOOP_WF);
    const engine = computeStepWorkList(p.steps[0], { runId: RUN_ID, params: {}, stepOutputs: {} });
    if (!engine.ok) throw new Error("compute failed");
    const solo = engine.list.units[0];
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    seedRun({
      plan: p,
      steps: [{ id: "work", criteria: ["thorough"] }],
      units: [
        {
          unitId: solo.unitId,
          stepId: "work",
          nodeId: solo.nodeId,
          status: "running",
          inputHash: solo.resolved.ok ? solo.resolved.inputHash : null,
          startedAt: old,
          lastCheckinAt: old,
        },
      ],
    });
    const brief = await buildWorkflowBrief(RUN_ID);
    expect(brief.workList.units[0].action).toBe("stale");
    expect(brief.workList.units[0].report).toBeDefined();
    // An EXPIRED/silent claim is freely reclaimable, so its report command is the
    // plain completed form — NO --session-id (contrast the live `claimed` case).
    expect(brief.workList.units[0].report).not.toContain("--session-id");
    expect(brief.staleUnits.some((s) => s.unitId === solo.unitId)).toBe(true);
  });

  test("an unclaimed unit is `pending` with a plain completed command (no --session-id)", async () => {
    const p = plan(LOOP_WF);
    seedRun({ plan: p, steps: [{ id: "work", criteria: ["thorough"] }] });
    const brief = await buildWorkflowBrief(RUN_ID);
    const u0 = brief.workList.units[0];
    expect(u0.action).toBe("pending");
    expect(u0.journaled).toBeUndefined();
    expect(u0.report).toContain("--status completed");
    expect(u0.report).not.toContain("--session-id");
  });

  test("a live engine lease flips every unit to do_not_run with no report command", async () => {
    seedRun({
      plan: plan(SOLO_WF),
      params: { target: "x" },
      steps: [{ id: "build" }, { id: "wrap" }],
      lease: { holder: "engine-live", until: new Date(Date.now() + 60_000).toISOString() },
    });
    const brief = await buildWorkflowBrief(RUN_ID);
    expect(brief.workList.units[0].action).toBe("do_not_run");
    expect(brief.workList.units[0].report).toBeUndefined();
  });
});

describe("workflow brief — fully-terminal step needing finalization (owner finding 3)", () => {
  const REQUIRED_GATE_WF = `version: 2
name: ReqGate
steps:
  - id: work
    title: Work
    unit:
      instructions: Do the work.
    gate:
      criteria: [the work is thorough]
      required: true
`;

  /** Seed the post-resume state: the run is active, the step is pending again,
   *  but its only unit already ran to completion — the fully-terminal recovery
   *  state a required-gate block + resume (or a crash before completion) leaves. */
  function seedResumedFullyTerminal(p: WorkflowPlanGraph): { unitId: string; nodeId: string } {
    const engine = computeStepWorkList(p.steps[0], { runId: RUN_ID, params: {}, stepOutputs: {} });
    if (!engine.ok) throw new Error("compute failed");
    const solo = engine.list.units[0];
    seedRun({
      plan: p,
      currentStepId: "work",
      steps: [{ id: "work", criteria: ["the work is thorough"], status: "pending" }],
      units: [
        {
          unitId: solo.unitId,
          stepId: "work",
          nodeId: solo.nodeId,
          status: "completed",
          inputHash: solo.resolved.ok ? solo.resolved.inputHash : null,
          resultJson: JSON.stringify("Did the work."),
        },
      ],
    });
    return { unitId: solo.unitId, nodeId: solo.nodeId };
  }

  test("the completed unit is `done` with no report command, yet a settle command IS emitted", async () => {
    const p = plan(REQUIRED_GATE_WF);
    seedResumedFullyTerminal(p);
    const brief = await buildWorkflowBrief(RUN_ID);
    expect(brief.active).toBe(true);
    expect(brief.workList.units).toHaveLength(1);
    expect(brief.workList.units[0].action).toBe("done");
    expect(brief.workList.units[0].report).toBeUndefined();
    // The recovery command a driver can actually run.
    expect(brief.settleCommand).toContain("--settle");
    expect(brief.settleCommand).toContain("--expect-step work");
  });

  test("the message no longer says 'Execute them' and explains the required-gate re-block", async () => {
    const p = plan(REQUIRED_GATE_WF);
    seedResumedFullyTerminal(p);
    const brief = await buildWorkflowBrief(RUN_ID);
    expect(brief.message).not.toContain("Execute them");
    expect(brief.message).toContain("terminal state");
    expect(brief.message).toContain("--settle");
    // A required gate with no judge available re-blocks — the message says so.
    expect(brief.message).toMatch(/re-block/i);
  });

  test("a non-required fully-terminal gate omits the re-block note but still emits settle", async () => {
    const p = plan(LOOP_WF); // gate criteria, not `required`
    const engine = computeStepWorkList(p.steps[0], { runId: RUN_ID, params: {}, stepOutputs: {} });
    if (!engine.ok) throw new Error("compute failed");
    const solo = engine.list.units[0];
    seedRun({
      plan: p,
      currentStepId: "work",
      steps: [{ id: "work", criteria: ["the work is thorough"], status: "pending" }],
      units: [
        {
          unitId: solo.unitId,
          stepId: "work",
          nodeId: solo.nodeId,
          status: "completed",
          inputHash: solo.resolved.ok ? solo.resolved.inputHash : null,
          resultJson: JSON.stringify("Did the work."),
        },
      ],
    });
    const brief = await buildWorkflowBrief(RUN_ID);
    expect(brief.settleCommand).toContain("--settle");
    expect(brief.message).toContain("terminal state");
    expect(brief.message).not.toMatch(/re-block/i);
  });

  test("a still-pending unit keeps the normal per-unit report path (no settle command)", async () => {
    const p = plan(REQUIRED_GATE_WF);
    seedRun({
      plan: p,
      currentStepId: "work",
      steps: [{ id: "work", criteria: ["the work is thorough"], status: "pending" }],
    });
    const brief = await buildWorkflowBrief(RUN_ID);
    expect(brief.workList.units[0].action).toBe("pending");
    expect(brief.workList.units[0].report).toBeDefined();
    expect(brief.settleCommand).toBeUndefined();
    expect(brief.message).toContain("Execute them");
  });

  test("a live engine lease suppresses the settle command even on a fully-terminal list", async () => {
    const p = plan(REQUIRED_GATE_WF);
    const engine = computeStepWorkList(p.steps[0], { runId: RUN_ID, params: {}, stepOutputs: {} });
    if (!engine.ok) throw new Error("compute failed");
    const solo = engine.list.units[0];
    seedRun({
      plan: p,
      currentStepId: "work",
      steps: [{ id: "work", criteria: ["the work is thorough"], status: "pending" }],
      units: [
        {
          unitId: solo.unitId,
          stepId: "work",
          nodeId: solo.nodeId,
          status: "completed",
          inputHash: solo.resolved.ok ? solo.resolved.inputHash : null,
          resultJson: JSON.stringify("Did the work."),
        },
      ],
      lease: { holder: "engine-live", until: new Date(Date.now() + 60_000).toISOString() },
    });
    const brief = await buildWorkflowBrief(RUN_ID);
    expect(brief.settleCommand).toBeUndefined();
  });
});

describe("workflow brief — worktree isolation warning (#21)", () => {
  const WORKTREE_WF = `version: 2
name: Isolated
steps:
  - id: build
    title: Build
    unit:
      engine: test-agent
      isolation: worktree
      instructions: Build it.
`;

  test("warns that .gitignore-matched outputs are disposable when a unit is worktree-isolated", async () => {
    seedRun({ plan: plan(WORKTREE_WF), steps: [{ id: "build" }] });
    const brief = await buildWorkflowBrief(RUN_ID);
    expect(brief.workList.units[0].action).toBe("pending");
    const warned = brief.warnings.some((w) => w.includes("isolated git worktree") && w.includes("DISPOSABLE"));
    expect(warned).toBe(true);
  });

  test("no worktree warning for a step whose units are not isolated", async () => {
    seedRun({ plan: plan(SOLO_WF), params: { target: "x" }, steps: [{ id: "build" }, { id: "wrap" }] });
    const brief = await buildWorkflowBrief(RUN_ID);
    expect(brief.warnings.some((w) => w.includes("isolated git worktree"))).toBe(false);
  });
});
