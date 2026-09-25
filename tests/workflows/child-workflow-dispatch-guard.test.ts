// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P3a round 1, finding 1 (docs/plans/specs/p3a-plan-v5-child-freeze.md
 * Review log R8) — AUTHORIZED FLIP, P3b spec §6 F-A1 / §1.6 B-N11
 * (docs/plans/specs/p3b-child-executor.md).
 *
 * P3a's freeze side (`src/workflows/freeze/targets/child-workflow.ts`)
 * legitimately produces a `kind: "child-workflow"` frozen target for a step
 * that composes another workflow — that is the whole point of Lane B.
 * `computeStepWorkList` (`src/workflows/exec/step-work.ts`) then builds an
 * ordinary work unit for that step like any other, and the two production
 * dispatch entry points — `defaultUnitDispatcher`
 * (`src/workflows/exec/native-executor.ts`) and the `unit-dispatch.ts`
 * `dispatchWorkflowExecution` it falls through to for every kind other than
 * "script"/"shell" — had no dedicated arm for it. Before P3a's fix, such a
 * unit fell into `dispatchWorkflowExecution`'s generic `kind !== "command"`
 * guard, which threw a `ConfigError` reading "... is not a command target."
 * — false (a `child-workflow` target is a legitimate, freeze-validated
 * target kind) and unhelpful. P3a's fix (this file, pre-flip) made both
 * dispatch entry points fail closed with a dedicated `UsageError`, code
 * `WORKFLOW_CHILD_EXECUTION_UNSUPPORTED`, naming the child ref and the P3b
 * timeline — because P3a shipped no production caller for a `child-workflow`
 * target at all.
 *
 * P3b removes that premise. `dispatchJournaledAttempt`
 * (`src/workflows/exec/native-executor.ts:1168`) now routes a
 * `child-workflow` unit to the child executor seam
 * (`src/workflows/exec/child-workflow.ts`, `driveChildWorkflowUnit`) BEFORE
 * dispatch is ever reached (spec §3.2). Arriving at
 * `dispatchWorkflowExecution` (or its production caller,
 * `defaultUnitDispatcher`) with a `child-workflow` target therefore means the
 * child executor seam was BYPASSED — an engine routing bug, not a
 * not-yet-implemented feature. Per B-N11: the guard STAYS (a bypassed seam
 * must still fail closed, never fall through to the generic "not a command
 * target" `ConfigError` R8 was opened to remove), but it becomes a plain
 * `Error` naming the bypassed seam file, and its `UsageErrorCode` is deleted
 * (no producer would remain — a `UsageError` tells a USER to change their
 * input, and nothing a user can author reaches this line once the seam
 * exists). `WORKFLOW_CHILD_EXECUTION_UNSUPPORTED` itself is retired (row
 * A-04, pinned in tests/workflows/child-executor-seam.test.ts: `rg
 * WORKFLOW_CHILD_EXECUTION_UNSUPPORTED src/` is zero hits).
 *
 * The R8 properties that must survive this flip are asserted explicitly
 * below: the message still names the child ref and the unit id (never the
 * generic `ConfigError` "... is not a command target." text), and it now
 * ALSO names `src/workflows/exec/child-workflow.ts` — the seam that should
 * have been reached instead (row A-03).
 *
 * No live agent/LLM/exec dispatch is needed to exercise this: the guard is a
 * synchronous check on `request.frozenTarget.kind` at the very top of
 * `dispatchWorkflowExecution`, before anything touches
 * `buildExecutionFromWire` / `runExecution`
 * — mirrors `tests/workflows/unit-dispatch-event-source.test.ts`'s existing
 * "no injectable runAgent/runSdk/chat seam, so pin the fix at the
 * exact point the decision is made" approach for this same module.
 */

import { describe, expect, test } from "bun:test";
import { UsageError } from "../../src/core/errors";
import { defaultUnitDispatcher } from "../../src/workflows/exec/native-executor";
import { dispatchWorkflowExecution, type UnitDispatchRequest } from "../../src/workflows/exec/unit-dispatch";

/**
 * A structurally minimal `FrozenChildWorkflowTarget`. Both dispatch entry
 * points under test decide on `.kind` alone before touching any other
 * field, so `frozenPlan` stays an empty object cast through `unknown` rather
 * than a fully valid `WorkflowPlanGraphV4` — mirrors
 * `tests/workflows/hash-v6.test.ts`'s `asFrozenTarget` fixture, which
 * established the identical "cast through unknown for this one field, never
 * a real `@ts-expect-error`" convention for this exact target shape.
 */
function childWorkflowRequest(ref: string): UnitDispatchRequest {
  const frozenTarget = {
    kind: "child-workflow",
    ref,
    planHash: "a".repeat(64),
    frozenPlan: {},
    contentHash: "b".repeat(64),
    via: "direct",
  } as unknown as UnitDispatchRequest["frozenTarget"];
  return {
    runId: "run-1",
    stepId: "compose",
    unitId: "unit-compose-0",
    nodeId: "compose",
    prompt: "",
    frozenTarget,
    timeoutMs: null,
  };
}

async function captureThrow(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected fn() to throw, but it resolved");
}

describe("child-workflow dispatch fails closed as an internal-invariant guard (P3b flip, B-N11)", () => {
  test('dispatchWorkflowExecution rejects a child-workflow target with a plain Error naming the bypassed child-executor seam — not the retired UsageError and not the generic "not a command target" ConfigError', async () => {
    const request = childWorkflowRequest("workflows/child");
    const caught = await captureThrow(() => dispatchWorkflowExecution(request));

    // B-N11: a bypassed seam is an engine routing bug, not a user-actionable
    // input — the UsageError (and its WORKFLOW_CHILD_EXECUTION_UNSUPPORTED
    // code) P3a threw here is retired; nothing a user can author reaches
    // this line once the seam exists (row A-03).
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UsageError);
    const err = caught as Error;
    // The R8 properties that must survive the flip: the ref and unit id are
    // still named, and the generic ConfigError text is still absent.
    expect(err.message).toContain("workflows/child");
    expect(err.message).toContain("unit-compose-0");
    expect(err.message).not.toContain("is not a command target");
    // New in P3b: the message names the seam that should have been reached
    // instead of dispatch.
    expect(err.message).toContain("child-workflow.ts");
  });

  test("defaultUnitDispatcher (the production dispatch seam) falls through to the same guard", async () => {
    const request = childWorkflowRequest("workflows/other-child");
    const caught = await captureThrow(() => defaultUnitDispatcher(request));

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UsageError);
    const err = caught as Error;
    expect(err.message).toContain("workflows/other-child");
    expect(err.message).toContain("child-workflow.ts");
  });

  test("an ordinary command target is unaffected — still reaches the command-only lowering path, not this guard", async () => {
    const request: UnitDispatchRequest = {
      runId: "run-1",
      stepId: "compose",
      unitId: "unit-compose-1",
      nodeId: "compose",
      prompt: "",
      timeoutMs: null,
      frozenTarget: {
        kind: "shell",
        exec: { command: ["true"] },
      } as unknown as UnitDispatchRequest["frozenTarget"],
    };
    // A "shell" target never reaches dispatchWorkflowExecution's guards at
    // all (native-executor.ts's defaultUnitDispatcher handles "script" and
    // "shell" directly) — asserted here as the negative control: the new
    // WORKFLOW_CHILD_EXECUTION_UNSUPPORTED code is specific to
    // "child-workflow" and does not leak onto other target kinds.
    const caught = await captureThrow(() => dispatchWorkflowExecution(request));
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UsageError);
  });
});
