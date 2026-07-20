// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${{ … }}` is the
// workflow expression grammar under test, not a JS template literal.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStateDatabase } from "../../../src/core/state-db";
import type { WorkflowRunUnitRow } from "../../../src/storage/repositories/workflow-runs-repository";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { buildWorkflowBrief } from "../../../src/workflows/exec/brief";
import type { UnitDispatchRequest, UnitDispatchResult } from "../../../src/workflows/exec/native-executor";
import { reportWorkflowUnit } from "../../../src/workflows/exec/report";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import {
  activeGateLoop,
  assertJournaledRouteSelectionsValid,
  buildEvidence,
  canonicalJson,
  computeStepWorkList,
  type ExecutedStepOutcome,
  evaluateRoute,
  finalizeExecutedStep,
  type RouteSkipInfo,
  recoverGateFeedback,
  seedJournaledRouteDecisions,
  type UnitOutcome,
  unitOutcomeFromRow,
} from "../../../src/workflows/exec/step-work";
import { canonicalPlanJson, computePlanHash } from "../../../src/workflows/ir/plan-hash";
import type {
  FrozenEngineSnapshot,
  IrInvocation,
  IrRouteSpec,
  IrStepPlan,
  IrUnitNode,
  WorkflowPlanGraph,
} from "../../../src/workflows/ir/schema";
import type { ExpressionScope } from "../../../src/workflows/program/expressions";
import { getWorkflowStatus, type WorkflowNextResult } from "../../../src/workflows/runtime/runs";
import type { SummaryJudge } from "../../../src/workflows/validate-summary";
import { freezeWorkflowProgram, storeFrozenWorkflowPlan } from "../../_helpers/workflow";

/**
 * The shared step-semantics core (redesign addendum R3, task step 1). Proves:
 *
 *   1. `computeStepWorkList` is PURE — same inputs ⇒ byte-identical unit ids,
 *      input hashes, and resolved prompts. This is the guarantee `brief` (R3)
 *      relies on to predict exactly what the engine will dispatch.
 *   2. gate-feedback recovery (`recoverGateFeedback` / `activeGateLoop`) reads
 *      the `{ feedback, missing }` the engine journaled, and — the anti-drift
 *      proof — recomputing a gate loop's work-list from the journal-recovered
 *      feedback reproduces the engine's ACTUAL loop-2 prompt + input hash
 *      byte-for-byte.
 */

// ── Hand-built plans for the pure work-list tests ────────────────────────────

const FROZEN_ENGINES: Record<string, FrozenEngineSnapshot> = {
  sdk: {
    name: "sdk",
    kind: "agent",
    runnerKind: "sdk",
    platform: "opencode-sdk",
    bin: "opencode",
    args: [],
    workspace: null,
    envPassthrough: [],
    commandBuilder: "opencode-sdk",
    fallbackLlmEngine: "llm",
  },
  agent: {
    name: "agent",
    kind: "agent",
    runnerKind: "agent",
    platform: "opencode",
    bin: "opencode",
    args: [],
    workspace: null,
    envPassthrough: [],
    commandBuilder: "opencode",
    fallbackLlmEngine: null,
  },
  llm: {
    name: "llm",
    kind: "llm",
    endpoint: "https://example.test/v1/chat/completions",
    model: "test-model",
    concurrency: 1,
  },
};

const SDK_INVOCATION: IrInvocation = { engine: "sdk", model: null, timeoutMs: 600_000 };

function soloStep(instructions: string, templating: "expressions" | "verbatim" = "expressions"): IrStepPlan {
  return {
    stepId: "s1",
    title: "S1",
    sequenceIndex: 0,
    root: { kind: "unit", id: "s1", instructions, templating, invocation: SDK_INVOCATION, onError: "fail" },
    gate: { kind: "gate", id: "s1.gate", stepId: "s1", criteria: [] },
  };
}

function mapStep(instructions: string, over = "${{ params.files }}"): IrStepPlan {
  return {
    stepId: "review",
    title: "Review",
    sequenceIndex: 0,
    root: {
      kind: "map",
      id: "review",
      over,
      reducer: "collect",
      template: {
        kind: "unit",
        id: "review",
        instructions,
        templating: "expressions",
        invocation: SDK_INVOCATION,
        onError: "fail",
      },
    },
    gate: { kind: "gate", id: "review.gate", stepId: "review", criteria: [] },
  };
}

describe("computeStepWorkList — dispatch-input hash envelope (reviewer finding #1)", () => {
  // A verbatim solo step so the prompt is fixed and only the varied field moves
  // the hash. Every field below reaches dispatch (native-executor's
  // UnitDispatchRequest), so a change to any of them must re-dispatch.
  const base: IrStepPlan = {
    stepId: "s1",
    title: "S1",
    sequenceIndex: 0,
    root: {
      kind: "unit",
      id: "s1",
      instructions: "Build it.",
      templating: "verbatim",
      invocation: SDK_INVOCATION,
      onError: "fail",
    },
    gate: { kind: "gate", id: "s1.gate", stepId: "s1", criteria: [] },
  };
  const input = { runId: "run-1", params: {}, stepOutputs: {}, engines: FROZEN_ENGINES };

  function hashOf(
    root: Partial<IrUnitNode>,
    invocation: Partial<IrInvocation> = {},
    engines: Record<string, FrozenEngineSnapshot> = FROZEN_ENGINES,
  ): string {
    const baseRoot = base.root as IrUnitNode;
    const step: IrStepPlan = {
      ...base,
      root: { ...baseRoot, ...root, invocation: { ...SDK_INVOCATION, ...invocation } },
    };
    const wl = computeStepWorkList(step, { ...input, engines });
    if (!wl.ok) throw new Error(wl.error);
    const u = wl.list.units[0];
    if (!u.resolved.ok) throw new Error(u.resolved.error);
    return u.resolved.inputHash;
  }

  const baseline = hashOf({});

  test("the frozen dispatch snapshot is part of the hash", () => {
    const engines = structuredClone(FROZEN_ENGINES);
    const sdk = engines.sdk;
    if (!sdk || sdk.kind !== "agent") throw new Error("expected SDK fixture");
    sdk.workspace = "/tmp/reviewer";
    expect(hashOf({}, {}, engines)).not.toBe(baseline);
  });

  test("resolved timeout is part of the hash (a unit override AND `timeout: none` both move it)", () => {
    expect(hashOf({}, { timeoutMs: 5_000 })).not.toBe(baseline);
    // null = author's `timeout: none`, distinct from the engine default.
    expect(hashOf({}, { timeoutMs: null })).not.toBe(baseline);
    expect(hashOf({}, { timeoutMs: 5_000 })).not.toBe(hashOf({}, { timeoutMs: 9_000 }));
  });

  test("env ref NAMES are part of the hash (order-sensitive), never resolved values", () => {
    expect(hashOf({ env: ["env/ci"] })).not.toBe(baseline);
    // Distinct name lists ⇒ distinct hashes; identical names ⇒ identical hash
    // (the hash carries NAMES, so it cannot leak or depend on secret values).
    expect(hashOf({ env: ["env/a", "env/b"] })).not.toBe(hashOf({ env: ["env/b", "env/a"] }));
    expect(hashOf({ env: ["env/ci"] })).toBe(hashOf({ env: ["env/ci"] }));
  });

  test("isolation is part of the hash", () => {
    expect(hashOf({ isolation: "worktree" })).not.toBe(baseline);
  });

  test("runtime kind and exact model remain part of the hash", () => {
    expect(hashOf({}, { engine: "agent" })).not.toBe(baseline);
    expect(hashOf({}, { model: "deep" })).not.toBe(baseline);
  });

  test("retry and on_error are DELIBERATELY excluded — a completed unit stays reusable across policy changes", () => {
    // These govern failed-unit re-dispatch and step-level failure reduction, not
    // a COMPLETED unit's inputs/output, so they must not invalidate a cached row.
    expect(hashOf({ retry: { max: 2, on: ["timeout"] } })).toBe(baseline);
    expect(hashOf({ onError: "continue" })).toBe(baseline);
  });
});

describe("computeStepWorkList — purity + content-derived identity", () => {
  test("same inputs ⇒ byte-identical unit ids, input hashes, and prompts", () => {
    const step = soloStep("Do ${{ params.x }} for ${{ params.y }}.");
    const input = { runId: "run-1", params: { x: "alpha", y: "beta" }, stepOutputs: {}, engines: FROZEN_ENGINES };

    const a = computeStepWorkList(step, input);
    const b = computeStepWorkList(step, input);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // Deep equality across two independent computations is the purity proof.
    expect(a.list.units).toEqual(b.list.units);

    const u = a.list.units[0];
    expect(u.unitId).toBe("s1:solo");
    expect(u.resolved.ok).toBe(true);
    if (u.resolved.ok) {
      expect(u.resolved.prompt).toContain("Do alpha for beta.");
      // 64-hex sha256.
      expect(u.resolved.inputHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("fan-out identity is content-derived — independent of item order", () => {
    const step = mapStep("Review ${{ item }}.");
    const forward = computeStepWorkList(step, {
      runId: "r",
      params: { files: ["a.ts", "b.ts"] },
      stepOutputs: {},
      engines: FROZEN_ENGINES,
    });
    const reversed = computeStepWorkList(step, {
      runId: "r",
      params: { files: ["b.ts", "a.ts"] },
      stepOutputs: {},
      engines: FROZEN_ENGINES,
    });
    expect(forward.ok && reversed.ok).toBe(true);
    if (!forward.ok || !reversed.ok) return;

    const byItem = (list: typeof forward.list, item: string) => list.units.find((u) => u.item === item);
    const fwdA = byItem(forward.list, "a.ts");
    const revA = byItem(reversed.list, "a.ts");
    // The SAME item derives the SAME content-derived id regardless of position
    // — the R2 identity guarantee that survives list reordering/regeneration.
    expect(fwdA?.unitId).toBe(revA?.unitId);
    expect(fwdA?.unitId).toMatch(/^review:[0-9a-f]{12}$/);
    expect(fwdA?.resolved.ok).toBe(true);
  });

  test("duplicate fan-out items are a whole-list failure naming the collision", () => {
    const step = mapStep("Review ${{ item }}.");
    const result = computeStepWorkList(step, {
      runId: "r",
      params: { files: ["dup", "dup"] },
      stepOutputs: {},
      engines: FROZEN_ENGINES,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("duplicate items (indices 0 and 1");
  });

  test("a non-array `over` is a whole-list failure", () => {
    const step = mapStep("Review ${{ item }}.");
    const result = computeStepWorkList(step, {
      runId: "r",
      params: { files: "not-a-list" },
      stepOutputs: {},
      engines: FROZEN_ENGINES,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not an array");
  });

  test("a resolution error is carried on the unit's `resolved`, not a whole-list failure", () => {
    // The template parses (valid `steps.<id>.output.<path>` grammar) but the
    // referenced producer isn't in scope, so it fails at RESOLUTION — carried
    // per unit (the engine's `expression_error` outcome), never a step failure.
    const step = mapStep("Review ${{ steps.prior.output.name }} for ${{ item }}.");
    const result = computeStepWorkList(step, {
      runId: "r",
      params: { files: ["a", "b"] },
      stepOutputs: {},
      engines: FROZEN_ENGINES,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.list.units).toHaveLength(2);
    for (const u of result.list.units) {
      expect(u.resolved.ok).toBe(false);
      if (!u.resolved.ok) expect(u.resolved.error).toContain("failed to resolve");
    }
  });

  test("verbatim instructions pass `${{ … }}` through as literal content (no parse, no failure)", () => {
    const step = soloStep("Literal ${{ not.parsed }} here.", "verbatim");
    const result = computeStepWorkList(step, { runId: "r", params: {}, stepOutputs: {}, engines: FROZEN_ENGINES });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const u = result.list.units[0];
    expect(u.resolved.ok).toBe(true);
    if (u.resolved.ok) expect(u.resolved.prompt).toContain("Literal ${{ not.parsed }} here.");
  });

  test("gate feedback changes the prompt AND the input hash (natural re-dispatch), and the journal id", () => {
    const step = soloStep("Do the work.");
    const base = { runId: "r", params: {}, stepOutputs: {}, engines: FROZEN_ENGINES };
    const loop1 = computeStepWorkList(step, base);
    const loop2 = computeStepWorkList(step, {
      ...base,
      gateLoop: 2,
      gateFeedback: { feedback: "Add analysis.", missing: ["thoroughness"] },
    });
    expect(loop1.ok && loop2.ok).toBe(true);
    if (!loop1.ok || !loop2.ok) return;

    const u1 = loop1.list.units[0];
    const u2 = loop2.list.units[0];
    expect(u1.journalBaseId).toBe("s1:solo");
    expect(u2.journalBaseId).toBe("s1:solo~l2");
    expect(u1.resolved.ok && u2.resolved.ok).toBe(true);
    if (u1.resolved.ok && u2.resolved.ok) {
      expect(u2.resolved.prompt).toContain("Add analysis.");
      expect(u2.resolved.prompt).toContain("- thoroughness");
      expect(u1.resolved.prompt).not.toContain("Add analysis.");
      expect(u2.resolved.inputHash).not.toBe(u1.resolved.inputHash);
    }
  });
});

// ── Gate-feedback recovery (pure, synthetic journal rows) ────────────────────

function gateRow(stepId: string, loop: number, verdict: unknown): WorkflowRunUnitRow {
  return {
    run_id: "r",
    unit_id: `${stepId}.gate:l${loop}`,
    step_id: stepId,
    node_id: `${stepId}.gate`,
    parent_unit_id: null,
    phase: "gate",
    runner: "llm",
    model: null,
    status: "completed",
    input_hash: null,
    result_json: JSON.stringify(verdict),
    tokens: null,
    failure_reason: null,
    session_id: null,
    worktree_path: null,
    started_at: null,
    finished_at: null,
    last_checkin_at: null,
    attempts: 1,
    claim_holder: null,
    claim_expires_at: null,
  };
}

describe("recoverGateFeedback / activeGateLoop — pure journal derivation", () => {
  const reject = { complete: false, missing: ["thoroughness"], feedback: "Add analysis." };

  test("recovers the previous loop's rejection feedback for loop N", () => {
    const rows = [gateRow("work", 1, reject)];
    expect(recoverGateFeedback(rows, "work", 2)).toEqual({ feedback: "Add analysis.", missing: ["thoroughness"] });
  });

  test("loop 1 has no prior feedback", () => {
    expect(recoverGateFeedback([gateRow("work", 1, reject)], "work", 1)).toBeUndefined();
  });

  test("a PASSED previous gate carries no feedback", () => {
    const rows = [gateRow("work", 1, { complete: true, missing: [] })];
    expect(recoverGateFeedback(rows, "work", 2)).toBeUndefined();
  });

  test("activeGateLoop is one past the highest journaled rejection", () => {
    expect(activeGateLoop([], "work")).toBe(1);
    expect(activeGateLoop([gateRow("work", 1, reject)], "work")).toBe(2);
    expect(activeGateLoop([gateRow("work", 1, reject), gateRow("work", 2, reject)], "work")).toBe(3);
  });

  test("activeGateLoop ignores other steps' gate rows and non-gate phases", () => {
    const rows = [
      gateRow("other", 1, reject),
      { ...gateRow("work", 1, reject), phase: null }, // a (hypothetical) non-gate row
    ];
    expect(activeGateLoop(rows, "work")).toBe(1);
  });

  test("non-string entries in a journaled `missing[]` are dropped (only strings are threaded as feedback)", () => {
    // A judge that returns a malformed `missing` (numbers, null, objects) must
    // not crash recovery or leak non-strings into the next loop's prompt — the
    // recovery filters to strings, keeping `feedback` intact.
    const rows = [
      gateRow("work", 1, { complete: false, missing: ["ok", 42, null, { a: 1 }, "also"], feedback: "fix it" }),
    ];
    expect(recoverGateFeedback(rows, "work", 2)).toEqual({ feedback: "fix it", missing: ["ok", "also"] });
  });

  test("a non-array `missing` and a non-string `feedback` degrade to empty defaults, never a throw", () => {
    const rows = [gateRow("work", 1, { complete: false, missing: "not-a-list", feedback: 7 })];
    expect(recoverGateFeedback(rows, "work", 2)).toEqual({ feedback: "", missing: [] });
  });

  // ── Reviewer #17 (test ask 8): a corrupt gate row must NOT silently look like
  //    loop 1. A present-but-unparseable / invalid-shape verdict fails loudly.
  test("a corrupt gate-rejection row (unparseable JSON) fails LOUDLY — never silently loop 1", () => {
    const corrupt: WorkflowRunUnitRow = { ...gateRow("work", 1, {}), result_json: "{not valid json" };
    // Old behavior swallowed the parse error, dropping the step back to loop 1
    // and re-dispatching work whose gate outcome is unknown. Both readers refuse.
    expect(() => activeGateLoop([corrupt], "work")).toThrow(/corrupt gate-evaluation row/);
    expect(() => recoverGateFeedback([corrupt], "work", 2)).toThrow(/corrupt gate-evaluation row/);
  });

  test("a gate row with an invalid verdict shape (no boolean `complete`) fails loudly", () => {
    const badShape = gateRow("work", 1, { complete: "yes", missing: [] });
    expect(() => activeGateLoop([badShape], "work")).toThrow(/complete/);
    // A non-object verdict (a bare array/number) is corruption too.
    const bareArray: WorkflowRunUnitRow = { ...gateRow("work", 1, {}), result_json: "[1,2,3]" };
    expect(() => activeGateLoop([bareArray], "work")).toThrow(/not a JSON object/);
  });

  test("a NULL-verdict gate row (errored judge / in-flight) is treated as empty, not corrupt", () => {
    // journalGateEvaluationFinish writes result_json = NULL for an errored judge,
    // and a `running` row has no verdict yet — both are legitimate, not corruption.
    const errored: WorkflowRunUnitRow = {
      ...gateRow("work", 1, {}),
      result_json: null,
      status: "failed",
      failure_reason: "dispatch_error",
    };
    expect(activeGateLoop([errored], "work")).toBe(1); // no rejection ⇒ loop 1, no throw
    expect(recoverGateFeedback([errored], "work", 2)).toBeUndefined();
  });
});

// ── evaluateRoute — routing on an explicit input, own-property when-map ───────

describe("evaluateRoute — explicit-input routing, prototype-safe when map", () => {
  function route(input: string, when: Record<string, string>, defaultStepId?: string): IrRouteSpec {
    return { input, when, ...(defaultStepId !== undefined ? { defaultStepId } : {}) };
  }
  function scope(stepOutputs: Record<string, unknown>, params: Record<string, unknown> = {}): ExpressionScope {
    return { params, stepOutputs };
  }

  test("selects the matching branch by exact string equality", () => {
    const r = route("${{ steps.review.output.verdict }}", { pass: "ship", fail: "rework" });
    const decision = evaluateRoute(r, scope({ review: { verdict: "pass" } }));
    expect(decision).toEqual({ ok: true, value: "pass", selected: "ship" });
  });

  test("boolean and number route inputs are stringified deterministically before matching", () => {
    // `String(value)` — true→"true", false→"false", 0→"0", 42→"42" — is the
    // pinned key form the `when:` map is matched against.
    const boolRoute = route("${{ steps.s.output.flag }}", { true: "yes", false: "no" });
    expect(evaluateRoute(boolRoute, scope({ s: { flag: true } }))).toEqual({
      ok: true,
      value: "true",
      selected: "yes",
    });
    expect(evaluateRoute(boolRoute, scope({ s: { flag: false } }))).toEqual({
      ok: true,
      value: "false",
      selected: "no",
    });

    const numRoute = route("${{ steps.s.output.n }}", { "0": "zero", "42": "life" });
    expect(evaluateRoute(numRoute, scope({ s: { n: 0 } }))).toEqual({ ok: true, value: "0", selected: "zero" });
    expect(evaluateRoute(numRoute, scope({ s: { n: 42 } }))).toEqual({ ok: true, value: "42", selected: "life" });
  });

  test("a route-input value of `constructor` / `__proto__` / `toString` never matches through Object.prototype", () => {
    // The when map is author-controlled; a resolved value that happens to spell a
    // prototype member must be looked up with Object.hasOwn, so it falls to the
    // default (or fails) rather than resolving to `Object.prototype.toString`.
    for (const hostile of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const withDefault = route("${{ steps.s.output.kind }}", { real: "a" }, "fallback");
      expect(evaluateRoute(withDefault, scope({ s: { kind: hostile } }))).toEqual({
        ok: true,
        value: hostile,
        selected: "fallback",
      });
      const noDefault = route("${{ steps.s.output.kind }}", { real: "a" });
      const decision = evaluateRoute(noDefault, scope({ s: { kind: hostile } }));
      expect(decision.ok).toBe(false);
      if (!decision.ok) expect(decision.error).toContain(hostile);
    }
  });

  test("an OWN when-branch literally named `constructor` still routes (own-property, not a name blocklist)", () => {
    const r = route("${{ steps.s.output.kind }}", { constructor: "handled" });
    expect(evaluateRoute(r, scope({ s: { kind: "constructor" } }))).toEqual({
      ok: true,
      value: "constructor",
      selected: "handled",
    });
  });

  test("no matching branch and no default fails loudly; a default catches the miss", () => {
    const noDefault = route("${{ steps.s.output.v }}", { a: "x" });
    const missed = evaluateRoute(noDefault, scope({ s: { v: "z" } }));
    expect(missed.ok).toBe(false);
    if (!missed.ok) expect(missed.error).toContain('"z"');

    const withDefault = route("${{ steps.s.output.v }}", { a: "x" }, "catch-all");
    expect(evaluateRoute(withDefault, scope({ s: { v: "z" } }))).toEqual({
      ok: true,
      value: "z",
      selected: "catch-all",
    });
  });

  test("a default value shared with an explicit branch is legal — both spellings pick that step", () => {
    const r = route("${{ steps.s.output.v }}", { a: "shared", b: "other" }, "shared");
    expect(evaluateRoute(r, scope({ s: { v: "a" } }))).toEqual({ ok: true, value: "a", selected: "shared" }); // explicit
    expect(evaluateRoute(r, scope({ s: { v: "zzz" } }))).toEqual({ ok: true, value: "zzz", selected: "shared" }); // default
  });

  test("a non-primitive (object/array) route input is rejected — branches match primitives only", () => {
    const r = route("${{ steps.s.output }}", { a: "x" }, "d");
    expect(evaluateRoute(r, scope({ s: { nested: true } })).ok).toBe(false);
    expect(evaluateRoute(route("${{ steps.s.output.list }}", { a: "x" }, "d"), scope({ s: { list: [1, 2] } })).ok).toBe(
      false,
    );
  });

  test("an unresolvable route input fails with the reference in the message", () => {
    const r = route("${{ steps.missing.output.v }}", { a: "x" }, "d");
    const decision = evaluateRoute(r, scope({}));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.error).toContain("steps.missing.output");
  });
});

// ── Anti-drift proof: journal-recovered feedback reproduces the engine's loop-2 dispatch ──

const LOOPED_WF = `version: 2
name: Looped
steps:
  - id: work
    title: Work
    unit:
      instructions: Do the work.
    gate:
      criteria: [the work is thorough]
      max_loops: 2
  - id: wrap-up
    title: Wrap up
    unit:
      instructions: Wrap up.
`;

const RUN_ID = "77777777-7777-4777-8777-777777777777";
let tmpDir = "";
let prevDataDir: string | undefined;

function plan(yamlText: string): WorkflowPlanGraph {
  return freezeWorkflowProgram(yamlText);
}

function seedRun(steps: Array<{ id: string; criteria?: string[] }>, frozen: WorkflowPlanGraph): void {
  const db = openStateDatabase(path.join(tmpDir, "state.db"));
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
          params_json, current_step_id, created_at, updated_at)
       VALUES (?, 'workflows/demo', 'dir:v1:demo', NULL, 'Demo', 'active', '{}', ?, ?, ?)`,
    ).run(RUN_ID, steps[0].id, now, now);
    steps.forEach((step, i) => {
      db.prepare(
        `INSERT INTO workflow_run_steps
           (run_id, step_id, step_title, instructions, completion_json, sequence_index, status)
         VALUES (?, ?, ?, 'instructions', ?, ?, 'pending')`,
      ).run(RUN_ID, step.id, step.id, step.criteria ? JSON.stringify(step.criteria) : null, i);
    });
    storeFrozenWorkflowPlan(db, RUN_ID, frozen);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-step-work-"));
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

describe("anti-drift — recomputing loop 2 from the journal reproduces the engine's dispatch", () => {
  test("recovered feedback yields the SAME prompt + input hash the engine actually dispatched", async () => {
    const frozen = plan(LOOPED_WF);
    seedRun([{ id: "work", criteria: ["the work is thorough"] }, { id: "wrap-up" }], frozen);

    const workPrompts: string[] = [];
    const dispatcher = async (req: UnitDispatchRequest): Promise<UnitDispatchResult> => {
      if (req.nodeId === "work") workPrompts.push(req.prompt);
      return { ok: true, text: `did ${req.unitId}` };
    };
    let judgeCalls = 0;
    const judge: SummaryJudge = async () => {
      judgeCalls++;
      return judgeCalls === 1
        ? '{"complete": false, "missing": ["the work is thorough"], "feedback": "Add the frobnicator analysis."}'
        : '{"complete": true, "missing": []}';
    };

    const result = await runWorkflowSteps({
      target: RUN_ID,
      dispatcher,
      loadPlan: async () => frozen,
      summaryJudge: judge,
    });
    expect(result.done).toBe(true);
    expect(workPrompts).toHaveLength(2); // loop 1 (rejected) + loop 2 (feedback)

    const rows = await withWorkflowRunsRepo((repo) => repo.getUnitsForStep(RUN_ID, "work"));

    // 1. The engine journaled the EXACT feedback it threaded into loop 2.
    const recovered = recoverGateFeedback(rows, "work", 2);
    expect(recovered).toEqual({ feedback: "Add the frobnicator analysis.", missing: ["the work is thorough"] });

    // 2. Recomputing loop 2's work-list from the frozen plan + journal-recovered
    //    feedback reproduces the engine's loop-2 dispatch BYTE-FOR-BYTE — the
    //    guarantee that `brief` predicts exactly what the engine ran.
    const workStep = frozen.steps.find((s) => s.stepId === "work");
    expect(workStep).toBeDefined();
    if (!workStep || !recovered) return;
    const list = computeStepWorkList(workStep, {
      runId: RUN_ID,
      params: {},
      stepOutputs: {},
      gateLoop: 2,
      gateFeedback: recovered,
      engines: frozen.execution?.engines,
    });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const u = list.list.units[0];
    expect(u.journalBaseId).toBe("work:solo~l2");
    expect(u.resolved.ok).toBe(true);
    if (u.resolved.ok) {
      expect(u.resolved.prompt).toBe(workPrompts[1]);
      const journaled = rows.find((r) => r.unit_id === "work:solo~l2");
      expect(journaled?.input_hash).toBe(u.resolved.inputHash);
    }
  });
});

/**
 * Regression (R4 conformance, peer-review finding): the DURABLE per-unit
 * projection `buildEvidence` writes must be surface-INDEPENDENT — the exact byte
 * identity the conformance suite compares. The engine reduces from an in-memory
 * dispatch outcome (a failed unit carries a residual `text` and an internal
 * `error` diagnostic); the report surface reduces from a journal row (a
 * driver-reported failure carries neither). If `buildEvidence` copied those
 * engine-only fields through, `evidence.units` — hence the durable unit graph —
 * would diverge between the two surfaces even though every other row matched.
 */
describe("buildEvidence — surface-independent unit projection (R4 anti-drift)", () => {
  /** Shape a journal row the report surface would rehydrate from. */
  function row(overrides: Partial<WorkflowRunUnitRow>): WorkflowRunUnitRow {
    return {
      run_id: RUN_ID,
      unit_id: "u",
      step_id: "s1",
      node_id: "s1",
      parent_unit_id: null,
      phase: null,
      runner: "sdk",
      model: null,
      input_hash: "h",
      result_json: null,
      status: "failed",
      failure_reason: null,
      tokens: null,
      session_id: null,
      worktree_path: null,
      started_at: null,
      finished_at: null,
      last_checkin_at: null,
      ...overrides,
    } as WorkflowRunUnitRow;
  }

  test("a failed unit's evidence is identical whether the engine or a driver produced it", () => {
    // Engine-shaped: dispatchUnit's UnitTransportError path fills text + error.
    const engineOutcome: UnitOutcome = {
      unitId: "s1:solo",
      ok: false,
      failureReason: "timeout",
      text: "",
      error: "unit dispatch failed",
    };
    // Report-shaped: rehydrated from a driver-reported failed row (no text/error).
    const reportOutcome = unitOutcomeFromRow(
      "s1:solo",
      row({ unit_id: "s1:solo", status: "failed", failure_reason: "timeout" }),
      false,
    );

    const engineEvidence = buildEvidence([engineOutcome], "collect", false);
    const reportEvidence = buildEvidence([reportOutcome], "collect", false);

    // Byte-identical durable projection — the load-bearing R4 invariant.
    expect(canonicalJson(engineEvidence.units)).toBe(canonicalJson(reportEvidence.units));
    // And it carries ONLY the surface-independent fields (no engine-only leakage).
    expect(engineEvidence.units).toEqual([{ unitId: "s1:solo", ok: false, failureReason: "timeout" }]);
  });

  test("a successful unit keeps its promoted contribution on BOTH surfaces", () => {
    const engineOutcome: UnitOutcome = { unitId: "s1:solo", ok: true, text: "did the work", tokens: 42 };
    const reportOutcome = unitOutcomeFromRow(
      "s1:solo",
      row({ unit_id: "s1:solo", status: "completed", result_json: JSON.stringify("did the work"), tokens: 42 }),
      false,
    );
    const engineEvidence = buildEvidence([engineOutcome], "collect", false);
    const reportEvidence = buildEvidence([reportOutcome], "collect", false);
    expect(canonicalJson(engineEvidence.units)).toBe(canonicalJson(reportEvidence.units));
    expect(engineEvidence.units).toEqual([{ unitId: "s1:solo", ok: true, text: "did the work" }]);
  });
});

// ── Reviewer #7 — tampered route selection fails loudly (test ask 9) ──────────

const ROUTE_WF = `version: 2
name: Routed
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
      instructions: Ship.
  - id: rework
    title: Rework
    unit:
      instructions: Rework.
`;

/** A resting WorkflowNextResult with `triage` completed and its route decision journaled. */
function routeState(selected: string): WorkflowNextResult {
  return {
    run: { id: RUN_ID, params: {} },
    workflow: {
      ref: "workflows/routed",
      title: "Routed",
      steps: [
        {
          id: "classify",
          title: "Classify",
          instructions: "",
          status: "completed",
          evidence: { output: { verdict: "pass" } },
        },
        {
          id: "triage",
          title: "Triage",
          instructions: "",
          status: "completed",
          evidence: { route: { input: "${{ steps.classify.output.verdict }}", value: "pass", selected } },
        },
        { id: "ship", title: "Ship", instructions: "", status: "pending" },
        { id: "rework", title: "Rework", instructions: "", status: "pending" },
      ],
    },
    step: null,
  } as unknown as WorkflowNextResult;
}

/** Seed a DB run parked after a completed (route) `triage` with a tampered selection. */
function seedRouteRunDb(routePlan: WorkflowPlanGraph, selected: string): void {
  const db = openStateDatabase(path.join(tmpDir, "state.db"));
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
           params_json, current_step_id, created_at, updated_at, plan_json, plan_hash, plan_ir_version)
        VALUES (?, 'workflows/routed', 'dir:v1:routed', NULL, 'Routed', 'active', '{}', 'ship', ?, ?, ?, ?, 3)`,
    ).run(RUN_ID, now, now, canonicalPlanJson(routePlan), computePlanHash(routePlan));
    const rows = [
      { id: "classify", status: "completed", evidence: { output: { verdict: "pass" } } },
      { id: "triage", status: "completed", evidence: { route: { input: "x", value: "pass", selected } } },
      { id: "ship", status: "pending", evidence: null as Record<string, unknown> | null },
      { id: "rework", status: "pending", evidence: null as Record<string, unknown> | null },
    ];
    rows.forEach((s, i) => {
      db.prepare(
        `INSERT INTO workflow_run_steps
           (run_id, step_id, step_title, instructions, completion_json, sequence_index, status, evidence_json)
         VALUES (?, ?, ?, 'i', NULL, ?, ?, ?)`,
      ).run(RUN_ID, s.id, s.id, i, s.status, s.evidence ? JSON.stringify(s.evidence) : null);
    });
    storeFrozenWorkflowPlan(db, RUN_ID, routePlan);
  } finally {
    db.close();
  }
}

describe("reviewer #7 — a tampered route selection fails loudly on every surface", () => {
  test("seedJournaledRouteDecisions refuses a selection naming a non-declared target (pure replay)", () => {
    const routePlan = plan(ROUTE_WF);
    const routeSelected = new Set<string>();
    const routeUnselected = new Map<string, RouteSkipInfo>();
    expect(() => seedJournaledRouteDecisions(routePlan, routeState("ghost"), routeSelected, routeUnselected)).toThrow(
      /not a declared branch or default target/,
    );
  });

  test("assertJournaledRouteSelectionsValid throws on a bogus selection, passes on a valid one", () => {
    const routePlan = plan(ROUTE_WF);
    expect(() => assertJournaledRouteSelectionsValid(routePlan, routeState("ghost"))).toThrow(
      /not a declared branch or default target/,
    );
    expect(() => assertJournaledRouteSelectionsValid(routePlan, routeState("ship"))).not.toThrow();
  });

  test("a VALID journaled selection is applied to the skip bookkeeping without throwing", () => {
    const routePlan = plan(ROUTE_WF);
    const routeSelected = new Set<string>();
    const routeUnselected = new Map<string, RouteSkipInfo>();
    seedJournaledRouteDecisions(routePlan, routeState("ship"), routeSelected, routeUnselected);
    expect(routeSelected.has("ship")).toBe(true);
    // The unselected branch is marked skip-on-reach.
    expect(routeUnselected.get("rework")?.selected).toBe("ship");
  });

  test("brief fails loudly (read-only surface) on tampered route evidence", async () => {
    seedRouteRunDb(plan(ROUTE_WF), "ghost");
    await expect(buildWorkflowBrief(RUN_ID)).rejects.toThrow(/not a declared branch or default target/);
  });

  test("engine run (resume) fails loudly on tampered route evidence", async () => {
    seedRouteRunDb(plan(ROUTE_WF), "ghost");
    await expect(
      runWorkflowSteps({
        target: RUN_ID,
        loadPlan: async () => plan(ROUTE_WF),
        dispatcher: async () => ({ ok: true, text: "x" }),
        summaryJudge: null,
      }),
    ).rejects.toThrow(/not a declared branch or default target/);
  });

  test("report fails loudly on tampered route evidence when it finalizes the active step", async () => {
    const routePlan = plan(ROUTE_WF);
    seedRouteRunDb(routePlan, "ghost");
    const shipStep = routePlan.steps.find((s) => s.stepId === "ship");
    if (!shipStep) throw new Error("fixture: ship step missing");
    const wl = computeStepWorkList(shipStep, {
      runId: RUN_ID,
      params: {},
      stepOutputs: {},
      engines: routePlan.execution.engines,
    });
    if (!wl.ok) throw new Error(wl.error);
    await expect(
      reportWorkflowUnit({
        target: RUN_ID,
        unitId: wl.list.units[0].unitId,
        status: "completed",
        resultRaw: "done",
        summaryJudge: null,
      }),
    ).rejects.toThrow(/not a declared branch or default target/);
  });
});

// ── Reviewer #6 — the gate row is finalized when completeWorkflowStep throws ───

/** A solo executing step plan whose gate carries criteria (so the judge runs). */
function gatedStep(required = false): IrStepPlan {
  return {
    stepId: "work",
    title: "Work",
    sequenceIndex: 0,
    root: {
      kind: "unit",
      id: "work",
      instructions: "Do the work.",
      templating: "expressions",
      invocation: SDK_INVOCATION,
      onError: "fail",
    },
    gate: {
      kind: "gate",
      id: "work.gate",
      stepId: "work",
      criteria: ["the work is thorough"],
      ...(required ? { required: true } : {}),
    },
  };
}

function passingResult(): ExecutedStepOutcome {
  const unit: UnitOutcome = { unitId: "work:solo", ok: true, text: "did the work" };
  return { ok: true, units: [unit], evidence: buildEvidence([unit], "collect", false), summary: "Executed 1 unit." };
}

function finalizeArgs(overrides: Record<string, unknown>) {
  return {
    runId: RUN_ID,
    workflowRef: "workflows/demo",
    stepId: "work",
    stepPlan: gatedStep(),
    completionCriteria: ["the work is thorough"],
    gateLoop: 1,
    loopsRemaining: false,
    result: passingResult(),
    priorEvidence: {},
    params: {},
    routeSelected: new Set<string>(),
    routeUnselected: new Map<string, RouteSkipInfo>(),
    summaryJudge: null as SummaryJudge | null,
    ...overrides,
  };
}

describe("reviewer #6 — the gate-evaluation row is finalized even when completeWorkflowStep throws", () => {
  test("a lease stolen DURING the judge finishes the gate row (failed), never strands it in running", async () => {
    seedRun([{ id: "work", criteria: ["the work is thorough"] }], plan(REQ_WF));
    // The judge steals the run lease as a side effect, so completeWorkflowStep's
    // write transaction throws AFTER the judge ran (the exact reviewer-#6 window).
    const judge: SummaryJudge = async () => {
      await withWorkflowRunsRepo((repo) =>
        repo.acquireEngineLease(
          RUN_ID,
          "other-engine",
          new Date(Date.now() + 90_000).toISOString(),
          new Date().toISOString(),
        ),
      );
      return '{"complete": true, "missing": []}';
    };
    await expect(finalizeExecutedStep(finalizeArgs({ summaryJudge: judge }))).rejects.toThrow();

    const rows = await withWorkflowRunsRepo((repo) => repo.getUnitsForStep(RUN_ID, "work"));
    const gate = rows.find((r) => r.unit_id === "work.gate:l1");
    expect(gate).toBeDefined();
    // The try/finally in finalizeExecutedStep finished it as an errored row —
    // without the fix it would still be "running" (stranded).
    expect(gate?.status).toBe("failed");
  });
});

// ── Reviewer #18 — a required gate with no judge blocks the step ──────────────

const REQ_WF = `version: 2
name: Req
steps:
  - id: work
    title: Work
    unit:
      instructions: Do the work.
    gate:
      criteria: [the work is thorough]
`;

describe("reviewer #18 — a required gate with no judge available blocks the step", () => {
  test("finalizeExecutedStep BLOCKS (not fail-open) when gate.required and no judge is available", async () => {
    seedRun([{ id: "work", criteria: ["the work is thorough"] }], plan(REQ_WF));
    const fin = await finalizeExecutedStep(finalizeArgs({ stepPlan: gatedStep(true), summaryJudge: null }));
    expect(fin.kind).toBe("blocked");

    const status = await getWorkflowStatus(RUN_ID);
    expect(status.workflow.steps.find((s) => s.id === "work")?.status).toBe("blocked");
    expect(status.run.status).toBe("blocked");
    // The judge was never invoked, so no gate row was journaled.
    const rows = await withWorkflowRunsRepo((repo) => repo.getUnitsForStep(RUN_ID, "work"));
    expect(rows.some((r) => r.unit_id === "work.gate:l1")).toBe(false);
  });

  test("a required gate WITH a judge available completes normally (no block)", async () => {
    seedRun([{ id: "work", criteria: ["the work is thorough"] }], plan(REQ_WF));
    const judge: SummaryJudge = async () => '{"complete": true, "missing": []}';
    const fin = await finalizeExecutedStep(finalizeArgs({ stepPlan: gatedStep(true), summaryJudge: judge }));
    expect(fin.kind).toBe("advanced");
    expect((await getWorkflowStatus(RUN_ID)).workflow.steps.find((s) => s.id === "work")?.status).toBe("completed");
  });

  // ── Codex round-3 finding A — a required gate whose judge ERRORS must BLOCK,
  //    never fail open (the offline/misconfigured-judge bypass required gates exist
  //    to prevent). A CONFIGURED judge that throws is NOT the no-judge case above.
  test("finding A: required gate + a judge that THROWS blocks the step (does not fail open)", async () => {
    seedRun([{ id: "work", criteria: ["the work is thorough"] }], plan(REQ_WF));
    const judge: SummaryJudge = async () => {
      throw new Error("LLM unreachable");
    };
    const fin = await finalizeExecutedStep(finalizeArgs({ stepPlan: gatedStep(true), summaryJudge: judge }));
    expect(fin.kind).toBe("blocked");
    if (fin.kind === "blocked") expect(fin.summary).toContain("REQUIRED completion gate");

    const status = await getWorkflowStatus(RUN_ID);
    expect(status.workflow.steps.find((s) => s.id === "work")?.status).toBe("blocked");
    expect(status.run.status).toBe("blocked");
    // The judge WAS invoked, so the gate row exists — but finished ERRORED
    // (status failed, NULL verdict), not passed.
    const rows = await withWorkflowRunsRepo((repo) => repo.getUnitsForStep(RUN_ID, "work"));
    const gate = rows.find((r) => r.unit_id === "work.gate:l1");
    expect(gate?.status).toBe("failed");
    expect(gate?.result_json).toBeNull();
  });

  test("finding A: required gate + a judge that returns an UNPARSEABLE verdict blocks the step", async () => {
    seedRun([{ id: "work", criteria: ["the work is thorough"] }], plan(REQ_WF));
    const judge: SummaryJudge = async () => "not json at all";
    const fin = await finalizeExecutedStep(finalizeArgs({ stepPlan: gatedStep(true), summaryJudge: judge }));
    expect(fin.kind).toBe("blocked");
    expect((await getWorkflowStatus(RUN_ID)).workflow.steps.find((s) => s.id === "work")?.status).toBe("blocked");
    const rows = await withWorkflowRunsRepo((repo) => repo.getUnitsForStep(RUN_ID, "work"));
    expect(rows.find((r) => r.unit_id === "work.gate:l1")?.status).toBe("failed");
  });

  test("finding A: a NON-required gate whose judge throws still fails OPEN (documented offline behavior)", async () => {
    seedRun([{ id: "work", criteria: ["the work is thorough"] }], plan(REQ_WF));
    const judge: SummaryJudge = async () => {
      throw new Error("LLM unreachable");
    };
    const fin = await finalizeExecutedStep(finalizeArgs({ stepPlan: gatedStep(false), summaryJudge: judge }));
    expect(fin.kind).toBe("advanced");
    expect((await getWorkflowStatus(RUN_ID)).workflow.steps.find((s) => s.id === "work")?.status).toBe("completed");
  });

  test("engine --require-gates blocks a NON-required criteria gate with no judge (run-wide override)", async () => {
    seedRun([{ id: "work", criteria: ["the work is thorough"] }], plan(REQ_WF));
    const result = await runWorkflowSteps({
      target: RUN_ID,
      loadPlan: async () => plan(REQ_WF),
      dispatcher: async () => ({ ok: true, text: "did the work" }),
      summaryJudge: null,
      requireGates: true,
    });
    expect(result.run.status).toBe("blocked");
    expect(result.done).toBeUndefined();
    expect((await getWorkflowStatus(RUN_ID)).workflow.steps.find((s) => s.id === "work")?.status).toBe("blocked");
  });

  test("without --require-gates, a non-required gate with no judge still fails OPEN (offline behavior unchanged)", async () => {
    seedRun([{ id: "work", criteria: ["the work is thorough"] }], plan(REQ_WF));
    const result = await runWorkflowSteps({
      target: RUN_ID,
      loadPlan: async () => plan(REQ_WF),
      dispatcher: async () => ({ ok: true, text: "did the work" }),
      summaryJudge: null,
    });
    expect(result.done).toBe(true);
    expect((await getWorkflowStatus(RUN_ID)).workflow.steps.find((s) => s.id === "work")?.status).toBe("completed");
  });
});
