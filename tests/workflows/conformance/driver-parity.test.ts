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
import { reportWorkflowUnit } from "../../../src/workflows/exec/report";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { canonicalJson, computeStepWorkList } from "../../../src/workflows/exec/step-work";
import { compileWorkflowProgram } from "../../../src/workflows/ir/compile";
import { canonicalPlanJson, computePlanHash } from "../../../src/workflows/ir/plan-hash";
import type { WorkflowPlanGraph } from "../../../src/workflows/ir/schema";
import { parseWorkflowProgram } from "../../../src/workflows/program/parser";
import { getWorkflowStatus } from "../../../src/workflows/runtime/runs";
import type { SummaryJudge } from "../../../src/workflows/validate-summary";

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

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-parity-"));
  prevDataDir = process.env.AKM_DATA_DIR;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.AKM_DATA_DIR;
  else process.env.AKM_DATA_DIR = prevDataDir;
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
  const parsed = parseWorkflowProgram(yamlText, { path: "workflows/golden.yaml" });
  if (!parsed.ok) throw new Error(parsed.errors.map((e) => `${e.line}: ${e.message}`).join(" | "));
  const compiled = compileWorkflowProgram(parsed.program);
  if (!compiled.ok) throw new Error(compiled.errors.map((e) => `${e.line}: ${e.message}`).join(" | "));
  return compiled.plan;
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
    report: "",
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
          params_json, current_step_id, created_at, updated_at, plan_json, plan_hash)
       VALUES (?, 'workflow:golden', 'dir:v1:golden', NULL, 'Golden', 'active', ?, ?, ?, ?, ?, ?)`,
    ).run(RUN_ID, JSON.stringify(params), current, now, now, canonicalPlanJson(plan), computePlanHash(plan));
    steps.forEach((step, i) => {
      db.prepare(
        `INSERT INTO workflow_run_steps
           (run_id, step_id, step_title, instructions, completion_json, sequence_index, status)
         VALUES (?, ?, ?, 'instructions', ?, ?, 'pending')`,
      ).run(RUN_ID, step.id, step.id, step.criteria ? JSON.stringify(step.criteria) : null, i);
    });
  } finally {
    closeWorkflowDatabase(db);
  }
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
    if (pending.length === 0) return; // nothing left the driver can advance
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
  yaml: `version: 1
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
  yaml: `version: 1
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
  yaml: `version: 1
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
  yaml: `version: 1
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
  yaml: `version: 1
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
  const yaml = `version: 1
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
  yaml: `version: 1
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

const GOLDENS: Golden[] = [SOLO, FAN_OUT_COLLECT, VOTE, ROUTE, GATE_MAX_LOOPS, onErrorContinueGolden(), RETRY];

// ── The parity suite ─────────────────────────────────────────────────────────

describe("conformance — engine/driver cross-surface parity", () => {
  for (const golden of GOLDENS) {
    test(`${golden.name}: engine-driven and brief/report-driven runs produce identical unit graphs`, async () => {
      const plan = compile(golden.yaml);

      // (a) engine-driven, in its own database.
      const engineDir = path.join(rootDir, "engine");
      fs.mkdirSync(engineDir, { recursive: true });
      process.env.AKM_DATA_DIR = engineDir;
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
      process.env.AKM_DATA_DIR = driverDir;
      seedRun(plan, golden.params, golden.steps);
      await runDriverSurface(golden);
      const driverGraph = await canonicalGraph();

      assertGraphsIdentical(engineGraph, driverGraph, golden.name);

      // Explicit structural expectations (conformance convention): guard against
      // BOTH surfaces drifting together. Runs against the (identical) graph.
      if (golden.verify) golden.verify(engineGraph);
    });
  }

  test("the parity assertion actually catches a divergence (harness self-check)", () => {
    const a = ["unit x status=completed", "run status=completed"];
    const b = ["unit x status=failed", "run status=failed"];
    expect(() => assertGraphsIdentical(a, b, "self-check")).toThrow(/diverge at row 0/);
  });
});
