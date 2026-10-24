// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Dispatch guard for a `kind: "child-workflow"` frozen target.
 *
 * `dispatchJournaledAttempt` (`src/workflows/exec/native-executor.ts`) routes a
 * `child-workflow` unit to the child executor seam
 * (`src/workflows/exec/child-workflow.ts`, `driveChildWorkflowUnit`) BEFORE
 * dispatch is ever reached. Arriving at `dispatchWorkflowExecution`
 * (`src/workflows/exec/unit-dispatch.ts`) or its production caller,
 * `defaultUnitDispatcher`, with a `child-workflow` target therefore means the
 * child executor seam was BYPASSED — an engine routing bug, not a feature gap.
 * The guard fails closed (never falling through to the generic
 * `kind !== "command"` `ConfigError` "... is not a command target." — false,
 * since a `child-workflow` target is a legitimate, freeze-validated target
 * kind) as a plain `Error` naming the bypassed seam file. It is not a
 * `UsageError`: that tells a USER to change their input, and nothing a user
 * can author reaches this line. `WORKFLOW_CHILD_EXECUTION_UNSUPPORTED` is
 * retired (pinned in tests/workflows/child-executor-seam.test.ts).
 *
 * The properties asserted below: the message names the child ref and the unit
 * id (never the generic `ConfigError` text), and it names
 * `src/workflows/exec/child-workflow.ts` — the seam that should have been
 * reached instead.
 *
 * No live agent/LLM/exec dispatch is needed to exercise this: the guard is a
 * synchronous check on `request.frozenTarget.kind` at the very top of
 * `dispatchWorkflowExecution`, before anything touches
 * `buildExecutionFromWire` / `runExecution` — mirrors
 * `tests/workflows/unit-dispatch-event-source.test.ts`'s "no injectable
 * runAgent/runSdk/chat seam, so pin the fix at the exact point the decision is
 * made" approach for this same module.
 */

import { describe, expect, test } from "bun:test";
import { UsageError } from "../../src/core/errors";
import { defaultUnitDispatcher } from "../../src/workflows/exec/native-executor";
import { dispatchWorkflowExecution, type UnitDispatchRequest } from "../../src/workflows/exec/unit-dispatch";

/**
 * A structurally minimal `FrozenChildWorkflowTarget`. Both dispatch entry
 * points under test decide on `.kind` alone before touching any other
 * field, so `frozenPlan` stays an empty object cast through `unknown` rather
 * than a fully valid `WorkflowPlan` — mirrors
 * `tests/workflows/hash-v6.test.ts`'s `asFrozenTarget` fixture.
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

describe("child-workflow dispatch fails closed as an internal-invariant guard", () => {
  test('dispatchWorkflowExecution rejects a child-workflow target with a plain Error naming the bypassed child-executor seam — not the retired UsageError and not the generic "not a command target" ConfigError', async () => {
    const request = childWorkflowRequest("workflows/child");
    const caught = await captureThrow(() => dispatchWorkflowExecution(request));

    // A bypassed seam is an engine routing bug, not a user-actionable input, so
    // this is a plain Error rather than a UsageError; nothing a user can author
    // reaches this line.
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UsageError);
    const err = caught as Error;
    // The ref and unit id are named, and the generic ConfigError text is absent.
    expect(err.message).toContain("workflows/child");
    expect(err.message).toContain("unit-compose-0");
    expect(err.message).not.toContain("is not a command target");
    // The message names the seam that should have been reached instead of
    // dispatch.
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
    // "shell" directly) — asserted here as the negative control: the
    // child-workflow guard is specific to "child-workflow" and does not leak onto
    // other target kinds.
    const caught = await captureThrow(() => dispatchWorkflowExecution(request));
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UsageError);
  });
});
