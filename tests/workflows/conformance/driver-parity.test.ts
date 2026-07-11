// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `\${{ … }}` is the
// workflow expression grammar under test, not a JS template literal.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type WorkflowRunUnitRow,
  withWorkflowRunsRepo,
} from "../../../src/storage/repositories/workflow-runs-repository";
import { closeWorkflowDatabase, openWorkflowDatabase } from "../../../src/workflows/db";
import { buildWorkflowBrief, type WorkflowBriefUnit } from "../../../src/workflows/exec/brief";
import type { UnitDispatcher } from "../../../src/workflows/exec/native-executor";
import { reportWorkflowUnit, settleWorkflowSpine } from "../../../src/workflows/exec/report";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { canonicalJson, computeStepWorkList } from "../../../src/workflows/exec/step-work";
import { canonicalPlanJson, computePlanHash } from "../../../src/workflows/ir/plan-hash";
import type { WorkflowPlanGraph } from "../../../src/workflows/ir/schema";
import { frozenStepRows } from "../../../src/workflows/runtime/plan-classifier";
import { getWorkflowStatus } from "../../../src/workflows/runtime/runs";
import type { SummaryJudge } from "../../../src/workflows/validate-summary";
import { freezeWorkflowProgram } from "../../_helpers/workflow";

/**
 * R4 — cross-surface driver-parity conformance (redesign addendum, "no
 * duplicated semantics"). For every golden program that exercises a distinct
 * orchestration feature, the SAME frozen plan is run twice against the SAME
 * fixture dispatch results and the SAME injected judge verdicts:
 *
 *   (a) engine-driven   — `runWorkflowSteps` with a fake dispatcher;
 *   (b) brief/report    — loop `buildWorkflowBrief` → `reportWorkflowUnit` for
 *                         every pending unit until the run is terminal.
 *
 * The suite then asserts the two runs produce IDENTICAL unit graphs: the same
 * dispatch-unit rows (unit_id, node_id, input_hash, status, result_json,
 * failure_reason), the same gate-evaluation rows, the same journaled route
 * decisions, the same per-step statuses + promoted artifacts, and the same
 * final run status. A divergence prints the first differing graph row.
 *
 * This is the load-bearing R3/R4 invariant: work-list computation, prompt
 * assembly (incl. recovered gate feedback), reducer/artifact promotion,
 * output-schema validation, route evaluation and artifact-judged gates all
 * live in one shared module (`step-work.ts`), so an engine-driven run and a
 * driver-driven run of the same plan cannot drift.
 *
 * ## What is (deliberately) collapsed
 *
 * `retry` is an ENGINE-INTERNAL dispatch mechanic: akm re-dispatches a failed
 * unit under `<baseId>~r<n>`. The harness-neutral driver protocol delegates
 * retries to the driver, which reports only the unit's FINAL outcome. So the
 * canonical graph groups a unit's retry attempts by content-derived base id and
 * compares the effective terminal outcome (input_hash is still compared, so a
 * hash divergence is never hidden). GATE-LOOP rows (`<baseId>~l<n>`) are NOT
 * collapsed — both surfaces genuinely produce them, and their byte-identical
 * input hashes are exactly what proves recovered-feedback parity.
 */

const RUN_ID = "77777777-7777-4777-8777-777777777777";

let rootDir = "";
let prevDataDir: string | undefined;
let prevCacheDir: string | undefined;

function selectSurfaceDir(dir: string): void {
  process.env.AKM_DATA_DIR = dir;
  process.env.AKM_CACHE_DIR = path.join(dir, "cache");
}

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-parity-"));
  prevDataDir = process.env.AKM_DATA_DIR;
  prevCacheDir = process.env.AKM_CACHE_DIR;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.AKM_DATA_DIR;
  else process.env.AKM_DATA_DIR = prevDataDir;
  if (prevCacheDir === undefined) delete process.env.AKM_CACHE_DIR;
  else process.env.AKM_CACHE_DIR = prevCacheDir;
  try {
    fs.rmSync(rootDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ── Fixtures + golden definitions ────────────────────────────────────────────

/** The effective terminal outcome of one content-derived unit, shared by both surfaces. */
interface UnitFixture {
  ok: boolean;
  /** Raw text / JSON the unit produced (a schema unit must produce matching JSON). */
  text?: string;
  failureReason?: string;
  tokens?: number;
}

interface SeedStep {
  id: string;
  criteria?: string[];
}

interface Golden {
  name: string;
  yaml: string;
  params: Record<string, unknown>;
  steps: SeedStep[];
  /** The terminal outcome for a content-derived BASE unit id (`<node>:<hash>` / `<node>:solo`). */
  outcome: (baseUnitId: string, nodeId: string) => UnitFixture;
  /** Fresh judge per run (call counting is safe: each run gets its own). Omit ⇒ fail-open (null). */
  judge?: () => SummaryJudge;
  /**
   * Optional custom engine dispatcher factory (the retry golden needs per-attempt
   * behavior). Default: a uniform dispatcher derived from `outcome`.
   */
  engineDispatcher?: () => UnitDispatcher;
  /** Extra engine-only assertion — e.g. proving a retry attempt row was journaled. */
  assertEngineExtras?: (units: WorkflowRunUnitRow[]) => void;
  /** Explicit structural expectations over the (identical) canonical graph. */
  verify?: (graph: GraphLine[]) => void;
}

/** Count graph lines matching a substring — a small structural assertion helper. */
function countLines(graph: GraphLine[], needle: string): number {
  return graph.filter((l) => l.includes(needle)).length;
}

/** The single graph line for a given prefixed id (e.g. `unit build:solo`), or "". */
function lineFor(graph: GraphLine[], prefix: string): string {
  return graph.find((l) => l.startsWith(prefix)) ?? "";
}

function compile(yamlText: string): WorkflowPlanGraph {
  return freezeWorkflowProgram(yamlText, "workflows/golden.yaml");
}

/** Strip every trailing gate-loop / retry suffix to recover the content-derived base id. */
function contentBaseId(unitId: string): string {
  return unitId.replace(/(~[lr]\d+)+$/, "");
}

/** The base unit ids the first step of a golden fans out to (for item-keyed fixtures). */
function stepUnitIds(plan: WorkflowPlanGraph, stepIndex: number, params: Record<string, unknown>): WorkflowBriefUnit[] {
  const computed = computeStepWorkList(plan.steps[stepIndex], { runId: RUN_ID, params, stepOutputs: {} });
  if (!computed.ok) throw new Error(computed.error);
  // Only the fields the parity harness reads.
  return computed.list.units.map((u) => ({
    unitId: u.unitId,
    nodeId: u.nodeId,
    index: u.index,
    runner: u.runner,
    timeoutMs: u.timeoutMs,
    onError: u.onError,
    item: u.item,
    resolved: u.resolved.ok
      ? { ok: true, instructions: u.resolved.prompt, inputHash: u.resolved.inputHash }
      : { ok: false, error: u.resolved.error },
    action: "pending" as const,
  }));
}

function rejectThenAccept(): SummaryJudge {
  let n = 0;
  return async () => {
    n += 1;
    return n === 1
      ? '{"complete": false, "missing": ["the work is thorough"], "feedback": "Add the missing analysis section."}'
      : '{"complete": true, "missing": []}';
  };
}

/** Map a shared UnitFixture into an engine dispatch result. */
function toDispatchResult(fx: UnitFixture): Awaited<ReturnType<UnitDispatcher>> {
  if (fx.ok) {
    return {
      ok: true,
      text: fx.text ?? "",
      ...(fx.tokens !== undefined ? { usage: { inputTokens: fx.tokens, outputTokens: 0 } } : {}),
    };
  }
  return {
    ok: false,
    text: fx.text ?? "",
    failureReason: fx.failureReason ?? "dispatch_error",
    ...(fx.tokens !== undefined ? { usage: { inputTokens: fx.tokens, outputTokens: 0 } } : {}),
  };
}

// ── Canonical unit-graph (the observable, surface-independent contract) ──────

/** One comparable line of the run's unit graph. */
type GraphLine = string;

async function canonicalGraph(): Promise<GraphLine[]> {
  const status = await getWorkflowStatus(RUN_ID);
  const units = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(RUN_ID));
  const lines: GraphLine[] = [];

  // Dispatch rows (phase = null), grouped by content-derived base id with retry
  // attempts collapsed to the unit's effective terminal outcome.
  const dispatch = units.filter((u) => u.phase === null);
  const groups = new Map<string, WorkflowRunUnitRow[]>();
  for (const u of dispatch) {
    const base = u.unit_id.replace(/~r\d+$/, "");
    const bucket = groups.get(base);
    if (bucket) bucket.push(u);
    else groups.set(base, [u]);
  }
  // `attempts` (migration 008) is deliberately NOT projected here: it counts
  // an ENGINE-internal crash/resume re-dispatch (an `insertUnit` REPLACE of a
  // still-`running` row), which the byte-identical fixture runs below never
  // trigger — both surfaces journal `attempts = 1` per unit, so it would match
  // vacuously. It is a budget-accounting field, not part of the observable unit
  // graph; the crash/resume accumulation it drives is covered by budget.test.ts.
  //
  // `claim_holder` / `claim_expires_at` (migration 009) are likewise EXCLUDED:
  // they are report-surface bookkeeping for `report --status running` claims. The
  // engine never claims (it dispatches synchronously) and this parity driver
  // reports terminal outcomes directly (never `--status running`), so both
  // surfaces leave them NULL — they are not part of the cross-surface unit graph.
  for (const base of [...groups.keys()].sort()) {
    const rows = groups.get(base) ?? [];
    const rep = rows.find((r) => r.status === "completed") ?? rows[rows.length - 1];
    lines.push(
      `unit ${base} node=${rep.node_id} parent=${rep.parent_unit_id ?? "-"} hash=${rep.input_hash ?? "-"} ` +
        `status=${rep.status} result=${rep.result_json ?? "-"} fail=${rep.failure_reason ?? "-"} ` +
        `tokens=${rep.tokens ?? "-"} session=${rep.session_id ?? "-"}`,
    );
  }

  // Gate-evaluation rows (phase = "gate"): compared verbatim.
  const gates = units.filter((u) => u.phase === "gate").sort((a, b) => a.unit_id.localeCompare(b.unit_id));
  for (const g of gates) {
    lines.push(`gate ${g.unit_id} node=${g.node_id} status=${g.status} verdict=${g.result_json ?? "-"}`);
  }

  // Steps: status + promoted artifact + the FULL per-unit evidence projection +
  // journaled route decision. Comparing `evidence.units` (not just the promoted
  // `evidence.output`) is load-bearing: a real engine-vs-report divergence lives
  // in the failed-unit projection (the engine's in-memory dispatch `error`/`text`
  // vs a driver-reported failure that carries neither). Projecting steps down to
  // `output` alone would hide it — so the byte-identical-graph guarantee the
  // cardinal rule promises would be unproven. `units` is now surface-independent
  // (see `buildEvidence`), so both surfaces must produce the SAME array.
  for (const s of status.workflow.steps) {
    const evidence = s.evidence;
    const output = evidence && Object.hasOwn(evidence, "output") ? canonicalJson(evidence.output) : "(none)";
    const units = evidence && Object.hasOwn(evidence, "units") ? canonicalJson(evidence.units) : "-";
    const route =
      evidence && typeof evidence.route === "object" && evidence.route !== null
        ? ((evidence.route as Record<string, unknown>).selected ?? "-")
        : "-";
    lines.push(`step ${s.id} status=${s.status} artifact=${output} units=${units} route=${String(route)}`);
  }

  lines.push(`run status=${status.run.status}`);
  return lines;
}

/** Diff-style parity assertion naming the first divergent graph row. */
function assertGraphsIdentical(engine: GraphLine[], driver: GraphLine[], label: string): void {
  const n = Math.max(engine.length, driver.length);
  for (let i = 0; i < n; i++) {
    if (engine[i] !== driver[i]) {
      throw new Error(
        `[${label}] engine/driver unit graphs diverge at row ${i}:\n` +
          `  engine: ${engine[i] ?? "(missing)"}\n` +
          `  driver: ${driver[i] ?? "(missing)"}\n` +
          `  full engine graph:\n${engine.map((l) => `    ${l}`).join("\n")}\n` +
          `  full driver graph:\n${driver.map((l) => `    ${l}`).join("\n")}`,
      );
    }
  }
  expect(driver).toEqual(engine);
}

// ── Run seeding + the two surface drivers ────────────────────────────────────

function seedRun(plan: WorkflowPlanGraph, params: Record<string, unknown>, steps: SeedStep[]): void {
  const db = openWorkflowDatabase(path.join(process.env.AKM_DATA_DIR ?? rootDir, "workflow.db"));
  try {
    const now = new Date().toISOString();
    const current = steps[0]?.id ?? null;
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
           params_json, current_step_id, created_at, updated_at, plan_json, plan_hash, plan_ir_version)
        VALUES (?, 'workflow:golden', 'dir:v1:golden', NULL, 'Golden', 'active', ?, ?, ?, ?, ?, ?, 3)`,
    ).run(RUN_ID, JSON.stringify(params), current, now, now, canonicalPlanJson(plan), computePlanHash(plan));
    const plannedSteps = new Map(frozenStepRows(plan).map((step) => [step.stepId, step]));
    steps.forEach((step, i) => {
      const planned = plannedSteps.get(step.id);
      db.prepare(
        `INSERT INTO workflow_run_steps
           (run_id, step_id, step_title, instructions, completion_json, sequence_index, status)
          VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      ).run(
        RUN_ID,
        step.id,
        planned?.stepTitle ?? step.id,
        planned?.instructions ?? "instructions",
        planned?.completionJson ?? (step.criteria ? JSON.stringify(step.criteria) : null),
        planned?.sequenceIndex ?? i,
      );
    });
  } finally {
    closeWorkflowDatabase(db);
  }
}

/** Read one journaled unit row by id (crash-resume assertions). */
async function unitRow(unitId: string): Promise<WorkflowRunUnitRow | undefined> {
  const rows = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(RUN_ID));
  return rows.find((r) => r.unit_id === unitId);
}

/**
 * Seed a crashed-after-loop-1-rejection pre-state for the single-step "work"
 * golden: the loop-1 solo unit completed (with the engine's content-derived
 * input hash) + a rejected `work.gate:l1` row. The step is left active. Both
 * surfaces resume from this identical journal.
 */
async function seedCrashedLoop1(
  plan: WorkflowPlanGraph,
  feedback: { feedback: string; missing: string[] },
): Promise<void> {
  const computed = computeStepWorkList(plan.steps[0], { runId: RUN_ID, params: {}, stepOutputs: {}, gateLoop: 1 });
  if (!computed.ok) throw new Error(computed.error);
  const unit = computed.list.units[0];
  if (!unit.resolved.ok) throw new Error(unit.resolved.error);
  const inputHash = unit.resolved.inputHash;
  const unitId = unit.unitId;
  const nodeId = unit.nodeId;
  await withWorkflowRunsRepo((repo) => {
    const now = new Date().toISOString();
    repo.insertUnit({
      runId: RUN_ID,
      unitId,
      stepId: "work",
      nodeId,
      parentUnitId: null,
      phase: null,
      runner: "agent",
      model: null,
      inputHash,
      startedAt: now,
    });
    // Match the uniform dispatcher's fixture text so both surfaces' loop-1 row is
    // byte-identical to what a real dispatch would have journaled.
    repo.finishUnit({
      runId: RUN_ID,
      unitId,
      status: "completed",
      resultJson: JSON.stringify(`did ${unitId}`),
      tokens: null,
      failureReason: null,
      finishedAt: now,
    });
    repo.insertUnit({
      runId: RUN_ID,
      unitId: "work.gate:l1",
      stepId: "work",
      nodeId: "work.gate",
      parentUnitId: null,
      phase: "gate",
      runner: "llm",
      model: null,
      inputHash: null,
      startedAt: now,
    });
    repo.finishUnit({
      runId: RUN_ID,
      unitId: "work.gate:l1",
      status: "completed",
      resultJson: JSON.stringify({ complete: false, missing: feedback.missing, feedback: feedback.feedback }),
      tokens: null,
      failureReason: null,
      finishedAt: now,
    });
  });
}

/** The uniform engine dispatcher: look up the shared fixture by content-derived base id. */
function uniformDispatcher(golden: Golden): UnitDispatcher {
  return async (req) => toDispatchResult(golden.outcome(contentBaseId(req.unitId), req.nodeId));
}

async function runEngineSurface(golden: Golden): Promise<void> {
  const dispatcher = golden.engineDispatcher ? golden.engineDispatcher() : uniformDispatcher(golden);
  const judge = golden.judge ? golden.judge() : null;
  await runWorkflowSteps({ target: RUN_ID, dispatcher, summaryJudge: judge });
}

/** True while the unit has no terminal journal row for the CURRENT gate loop. */
function needsReport(u: WorkflowBriefUnit): boolean {
  if (!u.resolved.ok) return false;
  const j = u.journaled;
  return !j || (j.status !== "completed" && j.status !== "failed");
}

async function runDriverSurface(golden: Golden): Promise<void> {
  const judge = golden.judge ? golden.judge() : null;
  for (let guard = 0; guard < 200; guard++) {
    const brief = await buildWorkflowBrief(RUN_ID);
    if (brief.done || !brief.active) return;
    const pending = brief.workList.units.filter(needsReport);
    if (pending.length === 0) {
      // Finding D: a non-dispatching step (route-only / empty / all-unresolvable)
      // has no `report --unit`. brief emits the `--settle` verb; a pure driver
      // uses it to advance the deterministic spine, exactly as the engine does.
      if (brief.settleCommand) {
        await settleWorkflowSpine({
          target: RUN_ID,
          ...(brief.step ? { expectStep: brief.step.stepId } : {}),
          summaryJudge: judge,
        });
        continue;
      }
      return; // nothing left the driver can advance
    }
    for (const u of pending) {
      const fx = golden.outcome(contentBaseId(u.unitId), u.nodeId);
      await reportWorkflowUnit({
        target: RUN_ID,
        unitId: u.unitId,
        status: fx.ok ? "completed" : "failed",
        ...(fx.text !== undefined ? { resultRaw: fx.text } : {}),
        ...(fx.tokens !== undefined ? { tokens: fx.tokens } : {}),
        ...(fx.failureReason ? { failureReason: fx.failureReason } : {}),
        summaryJudge: judge,
      });
    }
  }
  throw new Error(`[${golden.name}] driver loop did not terminate within the guard bound`);
}

// ── Golden programs (one distinct feature each) ──────────────────────────────

const SOLO: Golden = {
  name: "solo",
  yaml: `version: 2
name: Golden
steps:
  - id: build
    title: Build
    unit:
      instructions: Build it.
`,
  params: {},
  steps: [{ id: "build" }],
  // A non-null token count exercises the graph's `tokens=` column on BOTH
  // surfaces (engine journals dispatch `usage`; the driver reports `--tokens`),
  // proving the parity assertion actually compares it rather than vacuously
  // matching null everywhere.
  outcome: (base) => ({ ok: true, text: `did ${base}`, tokens: 7 }),
  verify: (g) => {
    expect(countLines(g, "unit ")).toBe(1);
    expect(lineFor(g, "unit build:solo")).toContain("status=completed");
    expect(lineFor(g, "unit build:solo")).toContain("tokens=7");
    expect(g).toContain("run status=completed");
  },
};

const FAN_OUT_COLLECT: Golden = {
  name: "fan-out + collect",
  yaml: `version: 2
name: Golden
params:
  files: { type: array }
steps:
  - id: review
    title: Review
    map:
      over: \${{ params.files }}
      reducer: collect
      unit:
        instructions: Review \${{ item }}.
`,
  params: { files: ["a.ts", "b.ts", "c.ts"] },
  steps: [{ id: "review" }],
  outcome: (base) => ({ ok: true, text: `reviewed ${base}` }),
  verify: (g) => {
    // Three content-derived fan-out units, all completed; collect artifact array.
    expect(countLines(g, "unit review.unit:")).toBe(3);
    expect(countLines(g, "parent=review.map")).toBe(3);
    expect(g.every((l) => !l.startsWith("unit ") || l.includes("status=completed"))).toBe(true);
    expect(lineFor(g, "step review")).toContain("status=completed");
    expect(g).toContain("run status=completed");
  },
};

const VOTE: Golden = {
  name: "vote",
  yaml: `version: 2
name: Golden
params:
  attempts: { type: array }
steps:
  - id: judge
    title: Judge
    map:
      over: \${{ params.attempts }}
      reducer: vote
      unit:
        instructions: Judge \${{ item }}.
        output:
          type: object
          properties: { verdict: { type: string } }
          required: [verdict]
`,
  params: { attempts: [1, 2, 3] },
  steps: [{ id: "judge" }],
  outcome: () => ({ ok: true, text: '{"verdict": "pass"}' }),
  verify: (g) => {
    // Three schema units voted; the winner artifact is promoted.
    expect(countLines(g, "unit judge.unit:")).toBe(3);
    expect(lineFor(g, "step judge")).toContain('artifact={"verdict":"pass"}');
    expect(g).toContain("run status=completed");
  },
};

const ROUTE: Golden = {
  name: "route",
  yaml: `version: 2
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
`,
  params: {},
  steps: [{ id: "classify" }, { id: "triage" }, { id: "ship" }, { id: "rework" }],
  outcome: (_base, nodeId) =>
    nodeId === "classify" ? { ok: true, text: '{"verdict": "pass"}' } : { ok: true, text: "shipped" },
  verify: (g) => {
    // Only the selected branch dispatched; the route decision is journaled;
    // the unselected branch is skipped with NO unit rows.
    expect(lineFor(g, "unit classify:solo")).toContain("status=completed");
    expect(lineFor(g, "unit ship:solo")).toContain("status=completed");
    expect(countLines(g, "unit rework")).toBe(0);
    expect(lineFor(g, "step triage")).toContain("route=ship");
    expect(lineFor(g, "step rework")).toContain("status=skipped");
    expect(g).toContain("run status=completed");
  },
};

const GATE_MAX_LOOPS: Golden = {
  name: "gate max_loops (reject then accept)",
  yaml: `version: 2
name: Golden
steps:
  - id: work
    title: Work
    unit:
      instructions: Do the work.
    gate:
      criteria: [the work is thorough]
      max_loops: 3
`,
  params: {},
  steps: [{ id: "work", criteria: ["the work is thorough"] }],
  outcome: () => ({ ok: true, text: "did the work" }),
  judge: rejectThenAccept,
  verify: (g) => {
    // Two gate loops: l1 rejected, l2 accepted. The loop-2 unit re-dispatched
    // under `~l2` with the recovered feedback threaded in — so its input hash
    // must DIFFER from loop 1's. That both surfaces reproduce this identical
    // hash is the load-bearing recovered-feedback parity proof.
    const l1 = lineFor(g, "unit work:solo ");
    const l2 = lineFor(g, "unit work:solo~l2 ");
    expect(l1).toContain("status=completed");
    expect(l2).toContain("status=completed");
    const hash1 = /hash=(\w+)/.exec(l1)?.[1];
    const hash2 = /hash=(\w+)/.exec(l2)?.[1];
    expect(hash1).toBeTruthy();
    expect(hash2).toBeTruthy();
    expect(hash1).not.toBe(hash2);
    expect(lineFor(g, "gate work.gate:l1")).toContain('"complete":false');
    expect(lineFor(g, "gate work.gate:l2")).toContain('"complete":true');
    expect(g).toContain("run status=completed");
  },
};

// on_error: continue — one fan-out unit fails; the step still completes.
function onErrorContinueGolden(): Golden {
  const yaml = `version: 2
name: Golden
params:
  files: { type: array }
steps:
  - id: review
    title: Review
    map:
      over: \${{ params.files }}
      reducer: collect
      unit:
        instructions: Review \${{ item }}.
        on_error: continue
`;
  const params = { files: ["a.ts", "b.ts"] };
  const plan = compile(yaml);
  // The unit that fans out over "b.ts" is the one we fail.
  const units = stepUnitIds(plan, 0, params);
  const failing = units.find((u) => u.item === "b.ts");
  if (!failing) throw new Error("fixture setup: could not locate the b.ts unit");
  const failingBase = failing.unitId;
  return {
    name: "on_error continue",
    yaml,
    params,
    steps: [{ id: "review" }],
    outcome: (base) =>
      base === failingBase ? { ok: false, failureReason: "timeout" } : { ok: true, text: `reviewed ${base}` },
    verify: (g) => {
      // One unit failed (timeout), one completed; on_error:continue tolerates
      // the failure and the step still completes.
      expect(countLines(g, "status=failed")).toBe(1);
      expect(lineFor(g, `unit ${failingBase}`)).toContain("fail=timeout");
      expect(lineFor(g, "step review")).toContain("status=completed");
      expect(g).toContain("run status=completed");
    },
  };
}

// retry — attempt 0 fails with a retryable reason, the retry succeeds. The
// engine journals `<base>` (failed) + `<base>~r1` (completed); the driver
// reports only the terminal success. The collapsed graphs must match.
const RETRY: Golden = {
  name: "retry (fail then succeed)",
  yaml: `version: 2
name: Golden
steps:
  - id: work
    title: Work
    unit:
      instructions: Do the work.
      retry: { max: 1, on: [timeout] }
`,
  params: {},
  steps: [{ id: "work" }],
  // Terminal outcome (what the driver reports, and the engine's retry attempt).
  outcome: () => ({ ok: true, text: "did the work" }),
  engineDispatcher: () => async (req) => {
    // Attempt 0 journals under the bare base id; the retry adds `~r1`.
    const isRetry = /~r\d+$/.test(req.unitId);
    return isRetry ? { ok: true, text: "did the work" } : { ok: false, text: "", failureReason: "timeout" };
  },
  assertEngineExtras: (units) => {
    const retryRow = units.find((u) => /~r1$/.test(u.unit_id));
    expect(retryRow?.status).toBe("completed");
    const attempt0 = units.find((u) => u.unit_id === "work:solo");
    expect(attempt0?.status).toBe("failed");
  },
  verify: (g) => {
    // Retry attempts collapse to the unit's effective terminal outcome: one
    // `work:solo` line, completed, on both surfaces (the engine's `~r1` row is
    // asserted separately via assertEngineExtras).
    expect(countLines(g, "unit work")).toBe(1);
    expect(lineFor(g, "unit work:solo")).toContain("status=completed");
    expect(g).toContain("run status=completed");
  },
};

// empty free-text output — a schemaless unit that legitimately produces the
// EMPTY string. The engine's `finishUnit` stores result_json = NULL for a falsy
// `outcome.text`; the report path must map ""→NULL identically, or the dispatch
// row (result column) AND the promoted solo artifact diverge across surfaces.
// This is the exact blind spot peer review flagged: no prior golden reports an
// empty completed result.
const EMPTY_OUTPUT: Golden = {
  name: "empty free-text output",
  yaml: `version: 2
name: Golden
steps:
  - id: build
    title: Build
    unit:
      instructions: Build it.
`,
  params: {},
  steps: [{ id: "build" }],
  outcome: () => ({ ok: true, text: "" }),
  verify: (g) => {
    // Empty output journals NULL (`result=-`), not '""', on BOTH surfaces; the
    // promoted solo artifact is null on both.
    expect(lineFor(g, "unit build:solo")).toContain("status=completed");
    expect(lineFor(g, "unit build:solo")).toContain("result=-");
    expect(lineFor(g, "step build")).toContain("artifact=null");
    expect(g).toContain("run status=completed");
  },
};

// Named engine + timeout in the hashed dispatch envelope (reviewer finding #1).
// The unit declares an engine and a per-unit timeout, which freeze into the
// dispatch inputs hashed by step-work.ts. Because the hash is computed in ONE shared place, the
// engine and brief/report surfaces MUST journal a byte-identical `input_hash`
// here; a future refactor that recomputed the hash per-surface from a subset of
// fields would diverge the `hash=` column and this golden would fail. (The
// fake dispatcher ignores engine/timeout, so no real backend is needed.)
const ENGINE_TIMEOUT: Golden = {
  name: "named engine + timeout in the input hash",
  yaml: `version: 2
name: Golden
steps:
  - id: build
    title: Build
    unit:
      engine: test-agent
      timeout: 5m
      instructions: Build it.
`,
  params: {},
  steps: [{ id: "build" }],
  outcome: (base) => ({ ok: true, text: `did ${base}` }),
  verify: (g) => {
    // A real 64-hex hash is journaled identically on both surfaces (the parity
    // assertion already compared the whole `hash=` token byte-for-byte).
    expect(lineFor(g, "unit build:solo")).toMatch(/hash=[0-9a-f]{64}/);
    expect(lineFor(g, "unit build:solo")).toContain("status=completed");
    expect(g).toContain("run status=completed");
  },
};

// required gate + no judge → BLOCKED (reviewer #18). A criteria-bearing gate
// marked `required: true` must be JUDGED; with no judge available (the parity
// harness omits the judge ⇒ null on both surfaces), the engine and the report
// path must BLOCK the step identically instead of failing open. The unit still
// completes, no gate row is journaled (the judge was never invoked), and the
// run lands `blocked` on BOTH surfaces — the same unit graph.
const REQUIRED_GATE_NO_JUDGE: Golden = {
  name: "required gate, no judge → blocked (offline parity)",
  yaml: `version: 2
name: Golden
steps:
  - id: work
    title: Work
    unit:
      instructions: Do the work.
    gate:
      criteria: [the work is thorough]
      required: true
`,
  params: {},
  steps: [{ id: "work", criteria: ["the work is thorough"] }],
  outcome: () => ({ ok: true, text: "did the work" }),
  // judge omitted ⇒ null on both surfaces ⇒ the required gate blocks.
  verify: (g) => {
    expect(lineFor(g, "unit work:solo")).toContain("status=completed");
    // The judge is never invoked, so no `<step>.gate:l<n>` row exists on either surface.
    expect(countLines(g, "gate ")).toBe(0);
    expect(lineFor(g, "step work")).toContain("status=blocked");
    expect(g).toContain("run status=blocked");
  },
};

// required gate + a judge that ERRORS → BLOCKED (Codex round-3 finding A). Unlike
// the no-judge golden above, a judge IS configured — it just THROWS (a transient
// LLM outage). A required gate must not fail open on that: both surfaces INVOKE
// the judge (so the `<step>.gate:l1` row IS journaled), finish it as an errored
// evaluation (status=failed, NULL verdict), and BLOCK the step identically — the
// same unit graph. This is the exact bypass finding A flagged.
const REQUIRED_GATE_JUDGE_ERRORS: Golden = {
  name: "required gate, judge errors → blocked (offline parity)",
  yaml: `version: 2
name: Golden
steps:
  - id: work
    title: Work
    unit:
      instructions: Do the work.
    gate:
      criteria: [the work is thorough]
      required: true
`,
  params: {},
  steps: [{ id: "work", criteria: ["the work is thorough"] }],
  outcome: () => ({ ok: true, text: "did the work" }),
  // A configured judge that throws (unreachable LLM) — NOT the no-judge case.
  judge: () => async () => {
    throw new Error("LLM unreachable");
  },
  verify: (g) => {
    expect(lineFor(g, "unit work:solo")).toContain("status=completed");
    // The judge WAS invoked, so an errored gate row exists on both surfaces.
    expect(countLines(g, "gate ")).toBe(1);
    expect(lineFor(g, "gate work.gate:l1")).toContain("status=failed");
    expect(lineFor(g, "gate work.gate:l1")).toContain("verdict=-");
    expect(lineFor(g, "step work")).toContain("status=blocked");
    expect(g).toContain("run status=blocked");
  },
};

// Codex round-3 finding D: a program whose FIRST step is a params-based ROUTE.
// There is no preceding unit report to trigger the engine's internal settle, so
// a pure brief/report driver must use the `--settle` verb (which brief emits) to
// advance past the route-only step. Both surfaces must reach identical graphs:
// the route decision journaled, the unselected branch skipped, the selected
// branch dispatched.
const PARAMS_ROUTE_FIRST: Golden = {
  name: "params-routed route as the FIRST step (settle verb)",
  yaml: `version: 2
name: Golden
params:
  mode: { type: string }
steps:
  - id: triage
    title: Triage
    route:
      input: \${{ params.mode }}
      when: { ship: ship, rework: rework }
  - id: ship
    title: Ship
    unit:
      instructions: Ship it.
  - id: rework
    title: Rework
    unit:
      instructions: Rework it.
`,
  params: { mode: "ship" },
  steps: [{ id: "triage" }, { id: "ship" }, { id: "rework" }],
  outcome: (base) => ({ ok: true, text: `did ${base}` }),
  verify: (g) => {
    // No unit rows for the route step; the decision selected `ship`; the
    // unselected `rework` branch is skipped with NO unit rows; ship dispatched.
    expect(countLines(g, "unit triage")).toBe(0);
    expect(lineFor(g, "step triage")).toContain("route=ship");
    expect(lineFor(g, "unit ship:solo")).toContain("status=completed");
    expect(countLines(g, "unit rework")).toBe(0);
    expect(lineFor(g, "step rework")).toContain("status=skipped");
    expect(g).toContain("run status=completed");
  },
};

const GOLDENS: Golden[] = [
  SOLO,
  FAN_OUT_COLLECT,
  VOTE,
  ROUTE,
  GATE_MAX_LOOPS,
  onErrorContinueGolden(),
  RETRY,
  EMPTY_OUTPUT,
  ENGINE_TIMEOUT,
  REQUIRED_GATE_NO_JUDGE,
  REQUIRED_GATE_JUDGE_ERRORS,
  PARAMS_ROUTE_FIRST,
];

// ── The parity suite ─────────────────────────────────────────────────────────

describe("conformance — engine/driver cross-surface parity", () => {
  for (const golden of GOLDENS) {
    test(`${golden.name}: engine-driven and brief/report-driven runs produce identical unit graphs`, async () => {
      const plan = compile(golden.yaml);

      // (a) engine-driven, in its own database.
      const engineDir = path.join(rootDir, "engine");
      fs.mkdirSync(engineDir, { recursive: true });
      selectSurfaceDir(engineDir);
      seedRun(plan, golden.params, golden.steps);
      await runEngineSurface(golden);
      const engineGraph = await canonicalGraph();
      if (golden.assertEngineExtras) {
        const units = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(RUN_ID));
        golden.assertEngineExtras(units);
      }

      // (b) brief/report-driven, in a SEPARATE database, same plan + fixtures.
      const driverDir = path.join(rootDir, "driver");
      fs.mkdirSync(driverDir, { recursive: true });
      selectSurfaceDir(driverDir);
      seedRun(plan, golden.params, golden.steps);
      await runDriverSurface(golden);
      const driverGraph = await canonicalGraph();

      assertGraphsIdentical(engineGraph, driverGraph, golden.name);

      // Explicit structural expectations (conformance convention): guard against
      // BOTH surfaces drifting together. Runs against the (identical) graph.
      if (golden.verify) golden.verify(engineGraph);
    });
  }

  // Codex round-3 P1 parity extension: a run interrupted AFTER a rejected gate
  // was journaled must resume identically on both surfaces. The engine seeds its
  // starting gate loop from the journal (`activeGateLoop`/`recoverGateFeedback`)
  // exactly as brief/report already do; without that it restarts at loop 1,
  // reuses the rejected loop-1 rows, overwrites `<step>.gate:l1`, and re-judges
  // the stale artifact — diverging from the driver surface. Both surfaces resume
  // from the SAME seeded crashed pre-state (loop-1 unit + gate:l1 rejected) and
  // must reach byte-identical loop-2 graphs, WITHOUT clobbering the l1 gate row.
  test("crash-after-rejection resume: engine and brief/report reach identical loop-2 graphs, l1 gate row untouched", async () => {
    const yaml = `version: 2
name: Golden
steps:
  - id: work
    title: Work
    unit:
      instructions: Do the work.
    gate:
      criteria: [the work is thorough]
      max_loops: 3
`;
    const plan = compile(yaml);
    const steps: SeedStep[] = [{ id: "work", criteria: ["the work is thorough"] }];
    const feedback = { feedback: "Add the missing analysis section.", missing: ["the work is thorough"] };
    // The judge ACCEPTS — loop 2 (the resumed loop) passes on both surfaces.
    const golden: Golden = {
      name: "crash-resume",
      yaml,
      params: {},
      steps,
      outcome: (base) => ({ ok: true, text: `did ${base}` }),
      judge: () => async () => '{"complete": true, "missing": []}',
    };

    // (a) engine surface: seed the crashed pre-state, then resume once.
    const engineDir = path.join(rootDir, "engine");
    fs.mkdirSync(engineDir, { recursive: true });
    selectSurfaceDir(engineDir);
    seedRun(plan, {}, steps);
    await seedCrashedLoop1(plan, feedback);
    const engineGateBefore = await unitRow("work.gate:l1");
    await runWorkflowSteps({ target: RUN_ID, dispatcher: uniformDispatcher(golden), summaryJudge: golden.judge?.() });
    const engineGraph = await canonicalGraph();
    // The l1 gate row was NOT overwritten (same finished_at) — the buggy engine
    // re-judged loop 1 on resume, re-stamping this row.
    expect((await unitRow("work.gate:l1"))?.finished_at).toBe(engineGateBefore?.finished_at);

    // (b) brief/report surface: same crashed pre-state, resume via the driver loop.
    const driverDir = path.join(rootDir, "driver");
    fs.mkdirSync(driverDir, { recursive: true });
    selectSurfaceDir(driverDir);
    seedRun(plan, {}, steps);
    await seedCrashedLoop1(plan, feedback);
    await runDriverSurface(golden);
    const driverGraph = await canonicalGraph();

    assertGraphsIdentical(engineGraph, driverGraph, "crash-resume");

    // Structural expectations over the identical graph: l1 rejected + l2 accepted,
    // with DISTINCT input hashes (loop 2 carried the recovered feedback).
    expect(lineFor(engineGraph, "gate work.gate:l1")).toContain('"complete":false');
    expect(lineFor(engineGraph, "gate work.gate:l2")).toContain('"complete":true');
    const h1 = /hash=(\w+)/.exec(lineFor(engineGraph, "unit work:solo "))?.[1];
    const h2 = /hash=(\w+)/.exec(lineFor(engineGraph, "unit work:solo~l2 "))?.[1];
    expect(h1).toBeTruthy();
    expect(h2).toBeTruthy();
    expect(h1).not.toBe(h2);
    expect(engineGraph).toContain("run status=completed");
  });

  // Owner manual-validation finding 3 parity extension: a required-gate step
  // whose only unit already COMPLETED but whose gate never got judged (a
  // required-gate BLOCK that was resumed, or a crash before finalization) is a
  // FULLY-TERMINAL work-list on a still-active step. The engine re-reduces the
  // completed unit and re-blocks the required gate; the brief/report driver has
  // no `report --unit` to run (the unit is `done`) and must use the `--settle`
  // verb brief now emits, running the SAME shared completion path. Both surfaces
  // must re-block identically (no judge available), with byte-identical graphs.
  test("fully-terminal required-gate step: engine re-reduce and brief/report --settle both re-block identically", async () => {
    const yaml = `version: 2
name: Golden
steps:
  - id: work
    title: Work
    unit:
      instructions: Do the work.
    gate:
      criteria: [the work is thorough]
      required: true
`;
    const plan = compile(yaml);
    const steps: SeedStep[] = [{ id: "work", criteria: ["the work is thorough"] }];
    // No judge (fail-open resolution) ⇒ the required gate blocks on both surfaces.
    const golden: Golden = {
      name: "settle-reblock",
      yaml,
      params: {},
      steps,
      outcome: (base) => ({ ok: true, text: `did ${base}` }),
    };

    // Seed the fully-terminal recovery pre-state: run active, step pending again,
    // its solo unit already completed with the engine's content-derived hash.
    const seedCompletedUnit = async (): Promise<void> => {
      const computed = computeStepWorkList(plan.steps[0], {
        runId: RUN_ID,
        params: {},
        stepOutputs: {},
        gateLoop: 1,
        engines: plan.execution?.engines,
      });
      if (!computed.ok) throw new Error(computed.error);
      const unit = computed.list.units[0];
      if (!unit.resolved.ok) throw new Error(unit.resolved.error);
      await withWorkflowRunsRepo((repo) => {
        const now = new Date().toISOString();
        repo.insertUnit({
          runId: RUN_ID,
          unitId: unit.unitId,
          stepId: "work",
          nodeId: unit.nodeId,
          parentUnitId: null,
          phase: null,
          runner: "agent",
          model: null,
          inputHash: unit.resolved.ok ? unit.resolved.inputHash : null,
          startedAt: now,
        });
        repo.finishUnit({
          runId: RUN_ID,
          unitId: unit.unitId,
          status: "completed",
          resultJson: JSON.stringify(`did ${unit.unitId}`),
          tokens: null,
          failureReason: null,
          finishedAt: now,
        });
      });
    };

    // (a) engine surface.
    const engineDir = path.join(rootDir, "engine");
    fs.mkdirSync(engineDir, { recursive: true });
    selectSurfaceDir(engineDir);
    seedRun(plan, {}, steps);
    await seedCompletedUnit();
    await runEngineSurface(golden);
    const engineGraph = await canonicalGraph();

    // (b) brief/report surface: the driver loop sees a `done` unit + a settle
    // command and settles, running the same completion path.
    const driverDir = path.join(rootDir, "driver");
    fs.mkdirSync(driverDir, { recursive: true });
    selectSurfaceDir(driverDir);
    seedRun(plan, {}, steps);
    await seedCompletedUnit();
    await runDriverSurface(golden);
    const driverGraph = await canonicalGraph();

    assertGraphsIdentical(engineGraph, driverGraph, "settle-reblock");
    expect(lineFor(engineGraph, "unit work:solo ")).toContain("status=completed");
    expect(lineFor(engineGraph, "step work")).toContain("status=blocked");
    expect(engineGraph).toContain("run status=blocked");
  });

  // Codex round-3 finding C parity extension: an engine crash AFTER a unit's
  // retry succeeded leaves the journal with a FAILED base attempt AND a COMPLETED
  // `~r1` retry. Engine resume reuses the `~r1` row (classifyUnitReuse), so the
  // unit reduces as COMPLETED. The brief/report surfaces must reduce it by the
  // SAME best terminal attempt (shared selectUnitAttemptRow) — reading only the
  // base row would reduce it as FAILED and, under on_error: fail, wrongly fail
  // the whole step. Both surfaces resume from the identical seeded pre-state (one
  // unit crashed-then-retried, its sibling never run) and must reach byte-
  // identical completed graphs.
  test("crash-after-retry resume: a base-failed unit rescued by a completed ~r1 reduces as COMPLETED on both surfaces", async () => {
    const yaml = `version: 2
name: Golden
steps:
  - id: review
    title: Review
    map:
      over: \${{ params.files }}
      reducer: collect
      unit:
        instructions: Review \${{ item }}.
        retry: { max: 1, on: [timeout] }
`;
    const plan = compile(yaml);
    const params = { files: ["a.ts", "b.ts"] };
    const steps: SeedStep[] = [{ id: "review" }];
    const computed = computeStepWorkList(plan.steps[0], {
      runId: RUN_ID,
      params,
      stepOutputs: {},
      engines: plan.execution?.engines,
    });
    if (!computed.ok) throw new Error(computed.error);
    const [ua, ub] = computed.list.units;
    if (!ua.resolved.ok || !ub.resolved.ok) throw new Error("fixture: units did not resolve");

    // The crashed pre-state: unit A's base attempt FAILED (timeout) but its ~r1
    // retry COMPLETED with the matching input hash — exactly what an engine crash
    // after a successful retry journals. Unit B never ran. Seeded identically in
    // both databases so the A group is byte-identical up front; the surfaces only
    // differ in how they REDUCE it.
    const seedCrashedRetry = async (): Promise<void> => {
      await withWorkflowRunsRepo((repo) => {
        const now = new Date().toISOString();
        const attempt = (
          unitId: string,
          status: "completed" | "failed",
          result: string | null,
          reason: string | null,
        ) => {
          repo.insertUnit({
            runId: RUN_ID,
            unitId,
            stepId: "review",
            nodeId: ua.nodeId,
            parentUnitId: "review.map",
            phase: null,
            runner: "agent",
            model: null,
            inputHash: ua.resolved.ok ? ua.resolved.inputHash : null,
            startedAt: now,
          });
          repo.finishUnit({
            runId: RUN_ID,
            unitId,
            status,
            resultJson: result,
            tokens: null,
            failureReason: reason,
            finishedAt: now,
          });
        };
        attempt(ua.unitId, "failed", null, "timeout");
        attempt(`${ua.unitId}~r1`, "completed", JSON.stringify("retried a.ts"), null);
      });
    };

    // (a) engine surface: resume — A is reused from ~r1, B is dispatched.
    const engineDir = path.join(rootDir, "engine");
    fs.mkdirSync(engineDir, { recursive: true });
    selectSurfaceDir(engineDir);
    seedRun(plan, params, steps);
    await seedCrashedRetry();
    await runWorkflowSteps({
      target: RUN_ID,
      dispatcher: async (req) => ({ ok: true, text: `reviewed ${contentBaseId(req.unitId)}` }),
      summaryJudge: null,
    });
    const engineGraph = await canonicalGraph();

    // (b) brief/report surface: same pre-state, driven through the driver loop.
    const driverDir = path.join(rootDir, "driver");
    fs.mkdirSync(driverDir, { recursive: true });
    selectSurfaceDir(driverDir);
    seedRun(plan, params, steps);
    await seedCrashedRetry();
    const golden: Golden = {
      name: "crash-retry",
      yaml,
      params,
      steps,
      outcome: (base) => ({ ok: true, text: `reviewed ${base}` }),
    };
    await runDriverSurface(golden);
    const driverGraph = await canonicalGraph();

    assertGraphsIdentical(engineGraph, driverGraph, "crash-retry");
    // The crashed unit reduced as COMPLETED (via its ~r1 retry), NOT failed, so
    // on_error: fail did not fail the step — the run completed on both surfaces.
    expect(lineFor(engineGraph, `unit ${ua.unitId} `)).toContain("status=completed");
    expect(lineFor(engineGraph, "step review")).toContain("status=completed");
    expect(engineGraph).toContain("run status=completed");
  });

  test("the parity assertion actually catches a divergence (harness self-check)", () => {
    const a = ["unit x status=completed", "run status=completed"];
    const b = ["unit x status=failed", "run status=failed"];
    expect(() => assertGraphsIdentical(a, b, "self-check")).toThrow(/diverge at row 0/);
  });

  // Reviewer #12 parity extension: a program's param schemas are frozen into the
  // plan, and a journaled params row that VIOLATES them (post-start corruption)
  // is refused IDENTICALLY on every driver surface — engine, brief, and report.
  // Without matching guards one surface would resolve prompts from bad params
  // while another rejected, silently diverging.
  test("param schemas are frozen into the plan", () => {
    const plan = compile(FAN_OUT_COLLECT.yaml);
    expect(plan.paramSchemas).toEqual({ files: { type: "array" } });
  });

  test("schema-violating journaled params are refused on all three surfaces", async () => {
    const plan = compile(FAN_OUT_COLLECT.yaml);
    // `files` was declared `{ type: array }`; a hand-edited row makes it a string.
    const bad = { files: "no-longer-an-array" };

    // (a) engine surface.
    const engineDir = path.join(rootDir, "engine");
    fs.mkdirSync(engineDir, { recursive: true });
    selectSurfaceDir(engineDir);
    seedRun(plan, bad, FAN_OUT_COLLECT.steps);
    await expect(
      runWorkflowSteps({
        target: RUN_ID,
        dispatcher: async () => ({ ok: true, text: "must not run" }),
        summaryJudge: null,
      }),
    ).rejects.toThrow(/integrity check/);

    // (b) brief surface, separate database, same plan + bad params row.
    const briefDir = path.join(rootDir, "brief");
    fs.mkdirSync(briefDir, { recursive: true });
    selectSurfaceDir(briefDir);
    seedRun(plan, bad, FAN_OUT_COLLECT.steps);
    await expect(buildWorkflowBrief(RUN_ID)).rejects.toThrow(/integrity check/);

    // (c) report surface, separate database, same plan + bad params row.
    const reportDir = path.join(rootDir, "report");
    fs.mkdirSync(reportDir, { recursive: true });
    selectSurfaceDir(reportDir);
    seedRun(plan, bad, FAN_OUT_COLLECT.steps);
    await expect(
      reportWorkflowUnit({
        target: RUN_ID,
        unitId: "review.unit:whatever",
        status: "completed",
        resultRaw: "x",
        summaryJudge: null,
      }),
    ).rejects.toThrow(/integrity check/);
  });
});
