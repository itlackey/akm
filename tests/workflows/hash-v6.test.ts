// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P3a Lane A TESTS — the unit/gate `hashVersion` vocabulary (spec
 * docs/plans/specs/p3a-plan-v5-child-freeze.md §3.3, rows A-11…A-16).
 *
 * NOW AT `hashVersion` 7: the R-R15 fix (PR #844 review finding F6) added the
 * conditional `taskInputs` preimage field — the RESOLVED values of a target's
 * `inputBindings`, striking §3.3's documented exclusion #4 — and bumped the
 * unit AND gate prefixes 6 → 7 in lockstep (P4's own recorded imperative,
 * docs/plans/specs/p4-deletions-closeout.md §8 criterion 8; ADR-0002's rule
 * that changing the preimage's coverage requires a bump). `hashVersion` 6
 * never shipped in any released tag (v0.9.2-alpha.1…4 all carry v5), so the
 * bump invalidates no released user's journal. The file KEEPS its historical
 * name — sibling suites reference `hash-v6.test.ts` by name in their headers,
 * and the P3a narrative below is history, accurate as written for the values
 * P3a landed.
 *
 * `computeChildInvocationKey` (§3.4, rows A-17…A-19) is deliberately NOT in
 * this file — see `tests/workflows/child-invocation-key.test.ts` and its own
 * header (test-review round 3, finding 2). The two used to be combined here
 * because both bumps ride in Lane A's one implement commit, mirroring how
 * P2a's `tests/execution/input-contract.test.ts` combined its own
 * multi-group scope in one file — but combining them made
 * `child-invocation.ts`'s not-yet-existing module a STATIC top-level import
 * in THIS file too, which block-failed the whole file at load time and hid
 * A-11's and A-12's own `hashVersion` 6 RED signal behind an unrelated
 * "cannot find module" failure. This file now imports nothing from
 * `child-invocation.ts`, loads normally, and every test below fails (today)
 * on the real thing it exists to catch: the still-v5 hash prefix / still-5
 * `hashVersion` field.
 *
 * `FrozenChildWorkflowTarget` is likewise not yet a member of
 * `FrozenWorkflowTarget` (schema-v4.ts) — every child-workflow fixture
 * funnels through the single `asFrozenTarget` cast below (RED-PHASE TYPE
 * PINS: "Implement removes ONE `@ts-expect-error` directive, not one per
 * call site" — the exact convention `tests/workflows/task-input-bindings.test.ts`'s
 * `frozenInputBindings` helper established for the mirror-image case, A-N7
 * there vs A-N1's frozen-target union growth here). This cast is a
 * *type-level* suppression only — unlike a missing module, it has no effect
 * on whether the file LOADS at runtime, so it does not block A-11/A-12.
 *
 * IMPORTANT for whoever lands `hashVersion` 6 (§3.3's field table says the
 * preimage "otherwise byte-identical to head", but does not itself flag
 * this): `computeStepWorkList`'s existing per-unit resolution
 * (`step-work.ts`, building `StepWorkUnitContext`) has exactly one line that
 * assumes every NON-command frozen target carries an `.exec` spec —
 * `target.kind === "command" ? … : target.exec.timeoutMs` — true for
 * `shell`/`script` today, but `FrozenChildWorkflowTarget` (§3.5) has no
 * `exec` field at all. §3.1's file table now ALSO authorizes extending this
 * one ternary to admit `kind: "child-workflow"` → `timeoutMs: null` (Review
 * log R1, resolved test-review round 3): land it in the SAME commit as the
 * `hashVersion` 6 bump, since A-15 below needs both.
 *
 * TEST-REVIEW HISTORY: at round 2, `hash-v6.test.ts` (this file, before the
 * round-3 split) still combined A-11…A-19 behind the one static
 * `child-invocation.ts` import, so A-11's and A-12's `hashVersion` 6
 * mismatch was never actually observed — every test failed identically on
 * "cannot find module". Round 2 fixed that for A-11 alone by moving it onto
 * an ordinary, already-handled `shell` target (`buildOrdinaryShellTarget`,
 * still used below) so it no longer NEEDED `child-workflow` support to be
 * meaningful — but the file-level import still block-failed everything,
 * A-15 specifically still could not go green under §3.1's THEN-authorization
 * (Review log R1, then OPEN), and A-17…A-19 were untested for the same
 * reason with no independent path to being fixed on their own. Round 3
 * resolves both: R1 is now RESOLVED (see the `IMPORTANT` paragraph above),
 * and A-17…A-19 moved out to their own file (see the top of this comment),
 * so `hash-v6.test.ts` now loads cleanly and A-11 (`shell` target, no
 * `child-workflow` dependency), A-15 (`child-workflow` target, exercises the
 * now-authorized `:450` fix), and A-12 (gate hash) are each independently
 * red on the `hashVersion` 6 bump today, for the reason each one names.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { TaskInputBinding } from "../../src/execution/input-contract";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import type { UnitDispatchResult } from "../../src/workflows/exec/native-executor";
import { runWorkflowSteps } from "../../src/workflows/exec/run-workflow";
import { computeStepWorkList, type WorkListInput } from "../../src/workflows/exec/step-work";
import { canonicalJson } from "../../src/workflows/ir/plan-hash";
import type { FrozenWorkflowTarget, WorkflowPlanStep } from "../../src/workflows/plan";
import { decodeWorkflowPlan } from "../../src/workflows/runtime/run-plan";
import { startWorkflowRun } from "../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

// ── Shared child-workflow-target fixture builder (see file header) ─────────

interface ChildWorkflowTargetFixture {
  readonly kind: "child-workflow";
  readonly ref: string;
  readonly planHash: string;
  readonly frozenPlan: unknown;
  readonly contentHash: string;
  readonly via: "direct" | "task";
  readonly taskRef?: string;
  readonly inputBindings?: readonly TaskInputBinding[];
}

/**
 * §3.5: FrozenChildWorkflowTarget landed in Implement as a real
 * discriminated-union member. `ChildWorkflowTargetFixture.frozenPlan` stays
 * `unknown` on purpose — this file only hashes the frozen target, it never
 * decodes it, so building a fully-valid `WorkflowPlan` fixture would
 * add weight nothing here reads — so the fixture is structurally a
 * `FrozenChildWorkflowTarget` except for that one field, and the cast
 * routes through `unknown` (never truly type-legal, so `@ts-expect-error`
 * would be actively wrong here, not merely unused).
 */
function asFrozenTarget(target: ChildWorkflowTargetFixture): FrozenWorkflowTarget {
  return target as unknown as FrozenWorkflowTarget;
}

function childContentHash(fields: {
  ref: string;
  planHash: string;
  via: "direct" | "task";
  taskRef?: string;
  inputBindings?: readonly TaskInputBinding[];
}): string {
  return createHash("sha256")
    .update("akm.workflow.child-workflow\0v1\0")
    .update(
      canonicalJson({
        ref: fields.ref,
        planHash: fields.planHash,
        via: fields.via,
        taskRef: fields.taskRef ?? null,
        inputBindings: fields.inputBindings ?? null,
      }),
    )
    .digest("hex");
}

function buildChildTargetFixture(options: {
  ref?: string;
  planHash: string;
  frozenPlan: unknown;
  via?: "direct" | "task";
  taskRef?: string;
  inputBindings?: readonly TaskInputBinding[];
}): ChildWorkflowTargetFixture {
  const ref = options.ref ?? "workflows/child";
  const via = options.via ?? "direct";
  return {
    kind: "child-workflow",
    ref,
    planHash: options.planHash,
    frozenPlan: options.frozenPlan,
    contentHash: childContentHash({
      ref,
      planHash: options.planHash,
      via,
      taskRef: options.taskRef,
      inputBindings: options.inputBindings,
    }),
    via,
    ...(options.taskRef ? { taskRef: options.taskRef } : {}),
    ...(options.inputBindings ? { inputBindings: options.inputBindings } : {}),
  };
}

/** A minimal one-unit step plan whose sole unit targets `target`. */
function stepPlanWithTarget(target: FrozenWorkflowTarget, stepId = "spawn"): WorkflowPlanStep {
  return {
    stepId,
    title: stepId,
    sequenceIndex: 0,
    root: {
      kind: "unit",
      id: `${stepId}.unit`,
      instructions: "Spawn the child workflow.",
      onError: "fail",
      isolation: "none",
      frozenTarget: target,
      environment: [],
    },
    gate: { kind: "gate", id: `${stepId}.gate`, stepId, criteria: [], maxLoops: 1, frozenJudge: null },
  };
}

/**
 * An ORDINARY, already-supported `shell` target (see the file header's
 * TEST-REVIEW HISTORY paragraph). Unlike `buildChildTargetFixture`, this
 * needs no `@ts-expect-error` cast — `FrozenWorkflowShellTarget` is real,
 * landed schema — and `computeStepWorkList`'s `:450` timeoutMs ternary
 * already handles `kind: "shell"` correctly today, so a fixture built from
 * this function can never trip the `target.exec.timeoutMs`-on-`undefined`
 * `TypeError` that a `child-workflow` fixture hits until Implement lands the
 * now-authorized `:450` extension (Review log R1). Used by the A-11 tests
 * below, which are claims about the preimage SHAPE and prefix in general —
 * not about child-workflow composition specifically — so they do not need a
 * child-workflow fixture to be meaningful, and stay independent of R1's
 * resolution either way.
 */
function buildOrdinaryShellTarget(options: { inputBindings?: readonly TaskInputBinding[] } = {}): FrozenWorkflowTarget {
  return {
    kind: "shell",
    contentHash: "s".repeat(64),
    exec: { command: ["/bin/sh", "-c", "echo hi"], timeoutMs: 60_000 },
    cwdIdentity: {
      requestedRoot: "/stash",
      realRoot: "/stash",
      rootDevice: "1",
      rootInode: "1",
      requestedCwd: "/stash",
      realCwd: "/stash",
      cwdDevice: "1",
      cwdInode: "1",
    },
    ...(options.inputBindings ? { inputBindings: options.inputBindings } : {}),
  };
}

/**
 * A minimal `command` target carrying a resolved persona snapshot
 * (`request.persona.content`) — the byte-exact persona text resolved at
 * freeze time (A-N9: "persona snapshots ARE in the preimage... transitively
 * and wholesale", `docs/plans/specs/p3a-plan-v5-child-freeze.md`).
 * `ResolvedExecutionRequestV1`'s `command`/`persona` content types carry
 * private module-local brand symbols (`src/execution/resolved-request.ts`)
 * this test file has no access to construct directly, so this fixture routes
 * through the SAME `unknown` cast `asFrozenTarget` establishes above for the
 * mirror-image `child-workflow` case — this file only ever HASHES the frozen
 * target, it never decodes or dispatches it, so a fully-branded, schema-valid
 * fixture would add weight nothing here reads.
 */
function buildCommandTargetWithPersona(personaContent: string): FrozenWorkflowTarget {
  const target = {
    kind: "command",
    ref: null,
    contentHash: "c".repeat(64),
    request: {
      schemaVersion: 1,
      command: { template: "echo hi", content: "echo hi", source: null },
      engine: { name: "test-engine", kind: "agent" },
      persona: {
        content: personaContent,
        source: { ref: "stash//agents/reviewer", hash: "h".repeat(64) },
      },
      authorization: { status: "allowed" },
      runtime: {},
      notices: [],
    },
    runner: { kind: "agent", timeoutMs: 60_000 },
  };
  return target as unknown as FrozenWorkflowTarget;
}

// ── A-11, A-15: computeUnitInputHash (via computeStepWorkList) ─────────────
//
// A-11 (the preimage shape/prefix in general) uses buildOrdinaryShellTarget,
// so it is independently red on the hashVersion 6 bump alone, today, with no
// dependency on the child-workflow ternary fix — see the file header's
// TEST-REVIEW HISTORY note. A-15 (a claim specifically about embedded child
// planHash sensitivity) keeps its child-workflow fixture; it fails via the
// SAME TypeError today (step-work.ts:450 does not admit kind:
// "child-workflow" yet — nothing in this file's own change set touches
// source), and goes green in Implement's Lane A commit once BOTH the
// hashVersion 6 bump and the now-authorized `:450` extension land together
// (Review log R1, resolved test-review round 3).

describe("hashVersion 7 — unit input hash (A-11, A-14, A-15)", () => {
  test("the preimage matches §3.3's field list exactly, under the akm.workflow.unit\\0v7\\0 prefix (an ordinary target — independent of child-workflow support)", () => {
    const target = buildOrdinaryShellTarget();
    const stepPlan = stepPlanWithTarget(target);
    const input: WorkListInput = { runId: "run-1", params: { p: 1 }, stepOutputs: {} };

    const result = computeStepWorkList(stepPlan, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const unit = result.list.units[0];
    if (!unit) throw new Error("expected exactly one unit");

    // CHARACTERIZATION (R-R15 fix is shape-preserving for binding-free
    // units): this reconstruction is byte-for-byte the object this test
    // pinned under hashVersion 6 (base e640a23a) apart from the prefix and
    // the hashVersion field — in particular it has NO `taskInputs` key, so
    // the exact-hash equality below proves a unit whose target carries no
    // `inputBindings` gained no preimage field from the fix.
    const preimage = {
      hashVersion: 7,
      role: "unit",
      stepId: stepPlan.stepId,
      nodeId: unit.nodeId,
      template: "Spawn the child workflow.",
      item: null,
      inputs: [],
      params: input.params,
      frozenTarget: unit.frozenTarget,
      environment: [],
      schema: null,
      isolation: "none",
    };
    expect(canonicalJson(preimage)).not.toContain("taskInputs");
    const expectedHash = createHash("sha256")
      .update("akm.workflow.unit\0v7\0")
      .update(canonicalJson(preimage))
      .digest("hex");

    expect(unit.inputHash).toBe(expectedHash);
  });

  test("a target WITH inputBindings adds exactly ONE preimage field — taskInputs, the RESOLVED values — in gateFeedback's conditional style (R-R15)", () => {
    const target = buildOrdinaryShellTarget({
      inputBindings: [
        { kind: "literal", name: "ticket", value: "T-1" },
        { kind: "reference", name: "payload", from: "steps.prev.output", schema: { type: "string" } },
      ],
    });
    const stepPlan = stepPlanWithTarget(target);
    const input: WorkListInput = { runId: "run-1", params: { p: 1 }, stepOutputs: { prev: "VALUE-ONE" } };

    const result = computeStepWorkList(stepPlan, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const unit = result.list.units[0];
    if (!unit) throw new Error("expected exactly one unit");

    // Same field list as the binding-free reconstruction above PLUS
    // `taskInputs` carrying the resolved effective values: the literal's
    // frozen value and the reference's value as resolved against THIS
    // invocation's stepOutputs — never the binding expressions (those are
    // already covered inside frozenTarget).
    const expectedHash = createHash("sha256")
      .update("akm.workflow.unit\0v7\0")
      .update(
        canonicalJson({
          hashVersion: 7,
          role: "unit",
          stepId: stepPlan.stepId,
          nodeId: unit.nodeId,
          template: "Spawn the child workflow.",
          item: null,
          inputs: [],
          params: input.params,
          frozenTarget: unit.frozenTarget,
          environment: [],
          schema: null,
          isolation: "none",
          taskInputs: { ticket: "T-1", payload: "VALUE-ONE" },
        }),
      )
      .digest("hex");

    expect(unit.inputHash).toBe(expectedHash);
  });

  test("a changed embedded child planHash changes the unit's input hash (A-15)", () => {
    const childPlanA = { title: "child-a", irVersion: 5 };
    const childPlanB = { title: "child-b", irVersion: 5 };
    const targetA = asFrozenTarget(
      buildChildTargetFixture({ ref: "workflows/child", planHash: "a".repeat(64), frozenPlan: childPlanA }),
    );
    const targetB = asFrozenTarget(
      buildChildTargetFixture({ ref: "workflows/child", planHash: "b".repeat(64), frozenPlan: childPlanB }),
    );
    const input: WorkListInput = { runId: "run-1", params: {}, stepOutputs: {} };

    const resultA = computeStepWorkList(stepPlanWithTarget(targetA), input);
    const resultB = computeStepWorkList(stepPlanWithTarget(targetB), input);
    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    if (!resultA.ok || !resultB.ok) return;

    const hashA = resultA.list.units[0]?.inputHash;
    const hashB = resultB.list.units[0]?.inputHash;
    expect(hashA).toBeTruthy();
    expect(hashA).toMatch(/^[0-9a-f]{64}$/);
    expect(hashA).not.toBe(hashB);
  });

  test("a changed persona snapshot changes the unit's input hash (A-N9: persona snapshots ARE in the preimage, transitively via frozenTarget.request.persona)", () => {
    const targetA = buildCommandTargetWithPersona("You are a careful reviewer, PERSONA-A.");
    const targetB = buildCommandTargetWithPersona("You are a careful reviewer, PERSONA-B.");
    const input: WorkListInput = { runId: "run-1", params: {}, stepOutputs: {} };

    const resultA = computeStepWorkList(stepPlanWithTarget(targetA), input);
    const resultB = computeStepWorkList(stepPlanWithTarget(targetB), input);
    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    if (!resultA.ok || !resultB.ok) return;

    const hashA = resultA.list.units[0]?.inputHash;
    const hashB = resultB.list.units[0]?.inputHash;
    expect(hashA).toBeTruthy();
    expect(hashA).toMatch(/^[0-9a-f]{64}$/);
    expect(hashA).not.toBe(hashB);

    // Byte-identical persona content (everything else held constant) must
    // hash identically — this isn't merely sensitive to SOME field on the
    // fixture, it is specifically sensitive to the persona snapshot.
    const targetA2 = buildCommandTargetWithPersona("You are a careful reviewer, PERSONA-A.");
    const resultA2 = computeStepWorkList(stepPlanWithTarget(targetA2), input);
    expect(resultA2.ok).toBe(true);
    if (!resultA2.ok) return;
    expect(resultA2.list.units[0]?.inputHash).toBe(hashA);
  });

  test("a changed inputBindings entry changes the unit's input hash, target kind held constant (A-11's frozenTarget field)", () => {
    const withoutBindings = buildOrdinaryShellTarget();
    const withBindings = buildOrdinaryShellTarget({
      inputBindings: [{ kind: "literal", name: "x", value: "a" }],
    });
    const input: WorkListInput = { runId: "run-1", params: {}, stepOutputs: {} };

    const resultA = computeStepWorkList(stepPlanWithTarget(withoutBindings), input);
    const resultB = computeStepWorkList(stepPlanWithTarget(withBindings), input);
    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    if (!resultA.ok || !resultB.ok) return;

    expect(resultA.list.units[0]?.inputHash).not.toBe(resultB.list.units[0]?.inputHash);
  });
});

// ── A-12: the gate hash ─────────────────────────────────────────────────────

function writeProgram(name: string, markdown: string): void {
  const file = path.join(storage.stashDir, "workflows", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, markdown, "utf8");
}

const GATE_WF = [
  "---",
  "type: workflow",
  "steps:",
  "  - id: work",
  "---",
  "",
  "## work",
  "",
  "Do the work.",
  "",
  "### gate",
  "",
  "- the work is verified",
  "",
].join("\n");

describe("hashVersion 7 — the gate hash (A-12)", () => {
  test("the gate hash prefix is akm.workflow.gate\\0v7\\0 with hashVersion 7 in the preimage — bumped in lockstep with the unit prefix — dispatch/invocation/prompt otherwise unchanged", async () => {
    writeProgram("gate-hash", GATE_WF);
    const started = await startWorkflowRun("workflows/gate-hash");
    const runId = started.run.id;

    // SummaryJudge's prompt argument is the {system, user} pair
    // (validate-summary.ts) — the hash preimage hashes this whole object,
    // never a spliced string.
    let capturedPrompt: { system: string; user: string } | undefined;
    const result = await runWorkflowSteps({
      target: runId,
      summaryJudge: async (prompt) => {
        capturedPrompt = prompt;
        return '{"complete": true, "missing": []}';
      },
      dispatcher: async (): Promise<UnitDispatchResult> => ({ ok: true, text: "done" }),
    });
    expect(result.done).toBe(true);
    expect(capturedPrompt).toBeTruthy();

    const rows = await withWorkflowRunsRepo((repo) => repo.getUnitsForStep(runId, "work"));
    const gateRow = rows.find((row) => row.phase === "gate");
    expect(gateRow?.input_hash).toBeTruthy();

    const planRow = await withWorkflowRunsRepo((repo) => repo.getRunById(runId));
    const plan = decodeWorkflowPlan(JSON.parse(planRow?.plan_json ?? "null"));
    const gateTarget = plan.steps[0]?.gate.frozenJudge;
    expect(gateTarget).toBeTruthy();

    const expectedHash = createHash("sha256")
      .update("akm.workflow.gate\0v7\0")
      .update(canonicalJson({ hashVersion: 7, dispatch: gateTarget, invocation: null, prompt: capturedPrompt }))
      .digest("hex");

    expect(gateRow?.input_hash).toBe(expectedHash);
  });
});
