// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The child workflow executor (P3b, spec docs/plans/specs/p3b-child-executor.md
 * §3). `driveChildWorkflowUnit` is the ONE place a `child-workflow`-targeted
 * unit is published (idempotently) and driven: no second executor, no second
 * scheduler, no second journal writer. It is reached from the ONE dispatch
 * seam in `native-executor.ts`'s `dispatchJournaledAttempt` (§3.2).
 *
 * Ordered algorithm (§3.3): (1) re-verify the embedded child plan's integrity;
 * (2) validate the resolved `with:` bindings against the child's declared
 * `params:`; (3) derive the deterministic invocation key; (4) publish the
 * child run idempotently (`publishChildWorkflowRun`, P3a); (5) read the
 * published row's status; (6) drive it with the SAME engine the top-level path
 * uses (`runWorkflowSteps`) unless it is already terminal-for-this-invocation
 * (`blocked`/`failed`, rows A-22/A-23); (7) map the child's FINAL status
 * through §3.4's table onto this unit's outcome.
 *
 * ## Why `runWorkflowSteps` is reached through a LAZY dynamic import, not a
 * static one (B-N5, and the §7 preservation-gate contingency)
 *
 * `native-executor.ts` must import `driveChildWorkflowUnit` FROM this file
 * (the dispatch seam calls it inline, §3.2) — that edge is fixed. `run-
 * workflow.ts` imports `native-executor.ts` (existing, load-bearing:
 * `executeStepPlan`). If this file ALSO imported `runWorkflowSteps` from
 * `./run-workflow` STATICALLY, the three edges would close a static cycle
 * (native-executor.ts -> child-workflow.ts -> run-workflow.ts ->
 * native-executor.ts), which `tests/architecture/import-cycle-ratchet.test.ts`
 * (shrink-only, EMPTY baseline — an absolute gate) forbids outright; adding an
 * entry to admit it is not an option the ratchet allows. Per this spec's own
 * §7 checklist ("if the ratchet objects, the drive is reached through an
 * injected function value, the pattern `ir/freeze-v4.ts`'s `ChildFreezeFn`
 * already establishes"), the drive is instead reached through
 * {@link driveWithRealEngine}'s `await import("./run-workflow")` — a
 * DYNAMIC import, invisible to the static-graph cycle ratchet by design (its
 * own doc: "dynamic `import()` is excluded because it is the repo's
 * sanctioned lazy-loading escape hatch"), registered in
 * `DYNAMIC_IMPORT_BASELINE` (scripts/lint-import-cycles.ts) as a genuine
 * lazy-load: the vast majority of workflow runs compose no child at all, so
 * loading `run-workflow.ts`'s full engine (lease heartbeat, retry loop) is
 * deferred until a `child-workflow` unit is actually dispatched. Bun/Node
 * cache a module on first dynamic import, so this costs nothing on repeat
 * calls, and it resolves the SAME module namespace object a test's
 * `import * as runWorkflowModule from "./run-workflow"` holds — a
 * `spyOn(runWorkflowModule, "runWorkflowSteps")` is therefore observed
 * exactly as if this module had imported it statically. Unlike a registered
 * function value (which would depend on `run-workflow.ts` having already
 * been loaded by SOME OTHER file — fragile for a test file exercising this
 * seam in isolation), a dynamic import always resolves correctly regardless
 * of what the rest of the process has loaded. This is the ONLY runtime
 * indirection in the whole drive: no second executor is created, and
 * `driveRun` itself is never exported (B-N5's "no second executor" holds).
 */

import { randomUUID } from "node:crypto";
import { TransientError } from "../../core/errors";
import { type WorkflowRunRow, withWorkflowRunsRepo } from "../../storage/repositories/workflow-runs-repository";
import { validateWorkflowParams } from "../ir/params";
import { canonicalPlanJson, computePlanHash } from "../ir/plan-hash";
import type { FrozenChildWorkflowTarget } from "../ir/schema-v4";
import { frozenStepRows } from "../runtime/plan-classifier";
import { workflowRunExportedResult } from "../runtime/run-outputs";
import { computeChildInvocationKey } from "./child-invocation";
import type { UnitOutcome } from "./step-work";
import type { UnitDispatcher, UnitDispatchRequest } from "./unit-dispatch";

// ── The lazy dynamic-import seam (see the module doc above) ────────────────

/**
 * The subset of `native-executor.ts`'s `StepExecutionContext` this module
 * reads. Defined LOCALLY — never imported from `native-executor.ts` — because
 * `native-executor.ts` imports `driveChildWorkflowUnit` FROM this file; an
 * import edge the other way would close a static cycle (see the module doc).
 * TypeScript's structural typing makes the real `StepExecutionContext`
 * assignable here without either type naming the other: every field below is
 * a same-named, same-typed field of `StepExecutionContext`.
 */
export interface DriveChildWorkflowContext {
  readonly runId: string;
  readonly signal?: AbortSignal;
  readonly dispatcher?: UnitDispatcher;
  readonly maxConcurrency?: number;
  readonly eventSource?: string;
  /**
   * Unread by this module — present only so a test's inline `ctx` object
   * literal (mirroring the full `StepExecutionContext` shape) does not trip
   * excess-property checking. An index signature would fix that too, but
   * then the REAL `StepExecutionContext` (native-executor.ts, no index
   * signature of its own) stops being assignable here — TypeScript's excess-
   * property exemption applies only to fresh object literals, not to a named
   * type passed as a value. Naming the fields keeps both directions valid.
   */
  readonly workflowRef?: string;
  readonly params?: Record<string, unknown>;
  readonly evidence?: Record<string, Record<string, unknown> | undefined>;
  readonly leaseHolder?: string;
}

/**
 * The subset of `run-workflow.ts`'s `RunWorkflowOptions` this module passes
 * to {@link driveWithRealEngine} (§3.3.1). Defined LOCALLY for the same
 * reason as {@link DriveChildWorkflowContext} — `RunWorkflowOptions` is a
 * structural superset (every field below is optional except `target`, so a
 * real `RunWorkflowOptions` value is always assignable to this type where
 * needed).
 */
export interface ChildWorkflowDriveOptions {
  readonly target: string;
  readonly signal?: AbortSignal;
  readonly dispatcher?: UnitDispatcher;
  readonly maxConcurrency?: number;
  readonly eventSource?: string;
  readonly disposeDispatchResources?: () => void | Promise<void>;
}

/**
 * The real engine's `runWorkflowSteps`, reached ONLY through a dynamic
 * import — see the module doc for why. The return value is deliberately
 * unused by the caller: this module always RE-READS the child run row from
 * the repository afterward (spec step 7) rather than trusting the driver's
 * return value, so no result shape needs to be shared across the seam.
 */
async function driveWithRealEngine(options: ChildWorkflowDriveOptions): Promise<void> {
  const { runWorkflowSteps } = await import("./run-workflow");
  await runWorkflowSteps(options);
}

// ── The drive contract (spec §3.3) ──────────────────────────────────────────

export interface DriveChildWorkflowInput {
  /** `unitId` is the parent unit's `journalBaseId` (B-N8). */
  readonly request: UnitDispatchRequest;
  readonly target: FrozenChildWorkflowTarget;
  readonly ctx: DriveChildWorkflowContext;
  readonly childParams: Readonly<Record<string, unknown>>;
  /** The `hashVersion` 7 unit input hash. */
  readonly inputHash: string;
  readonly dispatcher: UnitDispatcher;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `acquireRunLease`'s exact refusal shape (run-workflow.ts) — matched by text, since this module cannot import that private helper. */
function isLeaseBusyError(err: unknown): boolean {
  return err instanceof TransientError && err.message.includes("is already being driven by engine");
}

/** §3.4's exact `child_workflow_failed` message. */
function childWorkflowFailedMessage(input: {
  childRunId: string;
  childRef: string;
  childStepId: string;
  parentStepId: string;
}): string {
  return (
    `Child workflow run ${input.childRunId} (${input.childRef}) failed at step "${input.childStepId}". ` +
    `Inspect it with \`akm workflow status ${input.childRunId}\`; the parent run's step ` +
    `"${input.parentStepId}" cannot advance until it succeeds.`
  );
}

/**
 * Steps 1-3 (spec §3.3): integrity re-check, param validation, and the
 * deterministic invocation key. Returns either the key or an already-shaped
 * `child_workflow_publish_failed` outcome.
 */
function precheckAndDeriveInvocationKey(
  input: Pick<DriveChildWorkflowInput, "request" | "target" | "ctx" | "childParams" | "inputHash">,
): { ok: true; invocationKey: string } | { ok: false; outcome: UnitOutcome } {
  const { request, target, ctx, childParams, inputHash } = input;

  // Step 1 — integrity re-check (row A-10).
  const recomputedPlanHash = computePlanHash(target.frozenPlan);
  if (recomputedPlanHash !== target.planHash) {
    return {
      ok: false,
      outcome: {
        unitId: request.unitId,
        ok: false,
        failureReason: "child_workflow_publish_failed",
        error:
          `Workflow step "${request.stepId}" composes child workflow ${target.ref}, but its embedded plan's ` +
          `recomputed hash (${recomputedPlanHash}) does not match the frozen target's planHash (${target.planHash}). ` +
          "The frozen plan has been corrupted or tampered with.",
      },
    };
  }

  // Step 2 — resolved params against the child's declared param schemas (row A-11).
  const paramErrors = validateWorkflowParams(target.frozenPlan, childParams);
  if (paramErrors.length > 0) {
    return {
      ok: false,
      outcome: {
        unitId: request.unitId,
        ok: false,
        failureReason: "child_workflow_publish_failed",
        error:
          `Workflow step "${request.stepId}" composes child workflow ${target.ref}, but the resolved params do not ` +
          `satisfy its declared param schemas:\n${paramErrors.map((e) => `  - ${e}`).join("\n")}`,
      },
    };
  }

  // Step 3 — the deterministic invocation key (B-N8: parentUnitId is request.unitId, the parent unit's journalBaseId).
  return {
    ok: true,
    invocationKey: computeChildInvocationKey({
      parentRunId: ctx.runId,
      parentUnitId: request.unitId,
      unitInputHash: inputHash,
    }),
  };
}

/**
 * Step 4/5 (spec §3.3): publish the child run idempotently and return the
 * pre-drive status read (the returned row IS that read). B-N16: no
 * transaction open on this connection — this seam is reached from
 * dispatchJournaledAttempt, outside resumeWorkflowRun's and
 * completeWorkflowStep's own transactions.
 */
async function publishChildRun(
  input: Pick<DriveChildWorkflowInput, "request" | "target" | "ctx" | "childParams">,
  invocationKey: string,
): Promise<{ ok: true; childRow: WorkflowRunRow } | { ok: false; outcome: UnitOutcome }> {
  const { request, target, ctx, childParams } = input;
  try {
    const parentRow = await withWorkflowRunsRepo((repo) => repo.getRunById(ctx.runId));
    if (!parentRow) {
      throw new Error(`parent run ${ctx.runId} was not found`);
    }
    const now = new Date().toISOString();
    const childRunId = randomUUID();
    const childRow = await withWorkflowRunsRepo((repo) =>
      repo.publishChildWorkflowRun({
        parentRunId: ctx.runId,
        spawnedByUnitId: request.unitId,
        invocationKey,
        run: {
          id: childRunId,
          workflowRef: target.ref,
          scopeKey: parentRow.scope_key,
          workflowEntryId: null,
          workflowTitle: target.frozenPlan.title,
          paramsJson: JSON.stringify(childParams),
          currentStepId: target.frozenPlan.steps[0]?.stepId ?? null,
          createdAt: now,
          updatedAt: now,
          agentHarness: parentRow.agent_harness,
          agentSessionId: parentRow.agent_session_id,
          checkinArmedAt: now,
        },
        steps: frozenStepRows(target.frozenPlan).map((row) => ({ ...row, runId: childRunId })),
        planJson: canonicalPlanJson(target.frozenPlan),
        planHash: target.planHash,
      }),
    );
    return { ok: true, childRow };
  } catch (err) {
    return {
      ok: false,
      outcome: {
        unitId: request.unitId,
        ok: false,
        failureReason: "child_workflow_publish_failed",
        error: `Workflow step "${request.stepId}" could not publish child workflow run for ${target.ref}: ${errorMessage(err)}`,
      },
    };
  }
}

/**
 * Step 6 (spec §3.3): drive the published child run with the real engine,
 * unless it is already terminal-for-this-invocation (`blocked`/`failed`,
 * rows A-22/A-23 — never re-driven, no lease taken). Returns the FINAL row
 * (re-read after the drive) or an already-shaped `child_workflow_busy` /
 * `child_workflow_drive_failed` outcome.
 */
async function driveChildRun(
  input: Pick<DriveChildWorkflowInput, "request" | "target" | "ctx">,
  childRow: WorkflowRunRow,
): Promise<{ ok: true; finalRow: WorkflowRunRow } | { ok: false; outcome: UnitOutcome }> {
  const { request, target, ctx } = input;
  const shouldDrive = childRow.status !== "blocked" && childRow.status !== "failed";
  if (!shouldDrive) {
    return { ok: true, finalRow: childRow };
  }

  const driveOptions: ChildWorkflowDriveOptions = {
    target: childRow.id,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.dispatcher ? { dispatcher: ctx.dispatcher } : {}),
    ...(ctx.maxConcurrency !== undefined ? { maxConcurrency: ctx.maxConcurrency } : {}),
    ...(ctx.eventSource !== undefined ? { eventSource: ctx.eventSource } : {}),
    // B-N6: a no-op, distinct from the real registry drain — the PARENT's
    // own `finally` remains the single owner of the process-lifecycle
    // drain for the whole process (row A-24).
    disposeDispatchResources: () => {},
    // B-N7: deliberately no maxSteps, no maxRetries (rows A-25, A-26).
  };
  try {
    // The re-read is INSIDE the same try as the drive (code-review round 4,
    // finding 1; Review log R1): every throw between here and a mapped
    // UnitOutcome — the drive itself, OR this immediately-following
    // getRunById — must be caught. Left to escape, it skips past
    // dispatchJournaledAttempt's finishJournaledDispatch (no try/catch
    // wraps this seam there by design), so the parent's reserved attempt
    // row is never finished; the throw then propagates through runUnit
    // into concurrentMap's worker (src/core/concurrent.ts), which SWALLOWS
    // it and leaves the unit's outcome slot `undefined`, which
    // executeStepPlanInConnection then maps to the false diagnostic
    // "unit was not dispatched (aborted or scheduler failure)" — losing
    // the real cause and leaving the composing attempt row stuck
    // `running` forever (unrecoverable by inspection; a resume + re-drive
    // reproduces the identical false diagnostic).
    await driveWithRealEngine(driveOptions);
    const finalRow = (await withWorkflowRunsRepo((repo) => repo.getRunById(childRow.id))) ?? childRow;
    return { ok: true, finalRow };
  } catch (err) {
    if (isLeaseBusyError(err)) {
      return {
        ok: false,
        outcome: {
          unitId: request.unitId,
          ok: false,
          failureReason: "child_workflow_busy",
          error: errorMessage(err),
          childRun: {
            runId: childRow.id,
            ref: childRow.workflow_ref,
            status: childRow.status,
            currentStepId: childRow.current_step_id,
          },
        },
      };
    }
    // EVERY other throw is mapped here too — never rethrown. §3.5's
    // original premise ("classified by the existing dispatch_error
    // handling") was false: no handling exists at this seam
    // (dispatchJournaledAttempt awaits this call with no try of its own),
    // so an uncaught throw here escaped all the way into the scheduler and
    // was silently swallowed (R1, above). Reachable causes include the
    // child's own LeaseHeartbeat.assertAlive() firing mid-drive,
    // requireExecutableWorkflowPlan rejecting a
    // tampered child plan_json, and the child's status changing between
    // this function's own step 5 read and the drive's internal
    // getNextWorkflowStep re-read — none of which match
    // isLeaseBusyError's text. child_workflow_drive_failed is a SIBLING of
    // child_workflow_publish_failed (row A-10…A-12): same shape, same
    // errorMessage(err) content, but naming the child run id and ref
    // (already known at this point, unlike the publish arm above) since
    // driving — not publishing — is what failed.
    return {
      ok: false,
      outcome: {
        unitId: request.unitId,
        ok: false,
        failureReason: "child_workflow_drive_failed",
        error:
          `Workflow step "${request.stepId}" composes child workflow run ${childRow.id} (${target.ref}), ` +
          `but driving it failed: ${errorMessage(err)}`,
        childRun: {
          runId: childRow.id,
          ref: childRow.workflow_ref,
          status: childRow.status,
          currentStepId: childRow.current_step_id,
        },
      },
    };
  }
}

/**
 * `driveChildWorkflowUnit` — the ONE child drive (spec §3.3). Every failure
 * before step 6 (publication) produces `child_workflow_publish_failed`.
 */
export async function driveChildWorkflowUnit(input: DriveChildWorkflowInput): Promise<UnitOutcome> {
  const { request, ctx } = input;

  const precheck = precheckAndDeriveInvocationKey(input);
  if (!precheck.ok) {
    return precheck.outcome;
  }

  const published = await publishChildRun(input, precheck.invocationKey);
  if (!published.ok) {
    return published.outcome;
  }
  const { childRow } = published;

  const driven = await driveChildRun(input, childRow);
  if (!driven.ok) {
    return driven.outcome;
  }
  const { finalRow } = driven;

  const childRunSummary = {
    runId: finalRow.id,
    ref: finalRow.workflow_ref,
    status: finalRow.status,
    currentStepId: finalRow.current_step_id,
  };

  // A-28/A-29: the child did not reach a terminal state, and the parent's
  // own dispatch signal is what aborted it — checked against the RE-READ
  // status (not the signal alone) so an already-terminal child is never
  // misreported as aborted.
  if (finalRow.status === "active" && ctx.signal?.aborted) {
    return {
      unitId: request.unitId,
      ok: false,
      failureReason: "aborted",
      error:
        `Child workflow run ${finalRow.id} (${finalRow.workflow_ref}) was not driven to completion: ` +
        "the parent workflow invocation was interrupted.",
      childRun: childRunSummary,
    };
  }

  switch (finalRow.status) {
    case "completed":
      return {
        unitId: request.unitId,
        ok: true,
        result: workflowRunExportedResult(finalRow),
        childRun: childRunSummary,
      };
    case "failed": {
      const childStepId = finalRow.current_step_id ?? "(unknown)";
      return {
        unitId: request.unitId,
        ok: false,
        failureReason: "child_workflow_failed",
        error: childWorkflowFailedMessage({
          childRunId: finalRow.id,
          childRef: finalRow.workflow_ref,
          childStepId,
          parentStepId: request.stepId,
        }),
        childRun: childRunSummary,
      };
    }
    case "blocked":
      return {
        unitId: request.unitId,
        ok: false,
        failureReason: "child_workflow_blocked",
        error:
          `Child workflow run ${finalRow.id} (${finalRow.workflow_ref}) is blocked at its own step ` +
          `"${finalRow.current_step_id ?? "(unknown)"}". Inspect it with \`akm workflow status ${finalRow.id}\`.`,
        childRun: childRunSummary,
      };
    default:
      // The child's own gate loop exhausted without reaching a terminal
      // status (a genuine gate rejection on the child's own step, never
      // reached by this phase's fixtures — B-N7 forwards no maxSteps/
      // maxRetries, so nothing else can leave a driven child non-terminal
      // without an abort). Treated conservatively as a failure so the
      // parent never silently advances on an unresolved child.
      return {
        unitId: request.unitId,
        ok: false,
        failureReason: "child_workflow_failed",
        error:
          `Child workflow run ${finalRow.id} (${finalRow.workflow_ref}) did not reach a terminal state ` +
          `(status: ${finalRow.status}). Inspect it with \`akm workflow status ${finalRow.id}\`.`,
        childRun: childRunSummary,
      };
  }
}
