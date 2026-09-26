// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The child workflow executor. `driveChildWorkflowUnit` is the one place a
 * `child-workflow`-targeted unit is published (idempotently) and driven,
 * reached from `native-executor.ts`'s dispatch seam: (1) validate the resolved
 * `with:` bindings against the child's `params:`; (2) derive the deterministic
 * invocation key; (3) publish the child run idempotently; (4) drive it with
 * the same engine as a top-level run unless it is already `blocked`/`failed`;
 * (5) map the child's final status onto this unit's outcome.
 *
 * `runWorkflowSteps` is reached through a lazy dynamic import: a static one
 * would close the cycle native-executor -> child-workflow -> run-workflow ->
 * native-executor, and most runs compose no child at all.
 */

import { randomUUID } from "node:crypto";
import { TransientError } from "../../core/errors";
import { type WorkflowRunRow, withWorkflowRunsRepo } from "../../storage/repositories/workflow-runs-repository";
import { validateWorkflowParams } from "../ir/params";
import { canonicalPlanJson } from "../ir/plan-hash";
import type { FrozenChildWorkflowTarget } from "../plan";
import { workflowRunExportedResult } from "../runtime/run-outputs";
import { frozenStepRows } from "../runtime/run-plan";
import { computeChildInvocationKey } from "./child-invocation";
import type { UnitOutcome } from "./step-work";
import type { UnitDispatcher, UnitDispatchRequest } from "./unit-dispatch";

/**
 * The subset of `native-executor.ts`'s `StepExecutionContext` this module
 * reads, defined locally so this module never imports `native-executor.ts`.
 */
export interface DriveChildWorkflowContext {
  readonly runId: string;
  readonly signal?: AbortSignal;
  readonly dispatcher?: UnitDispatcher;
  readonly maxConcurrency?: number;
  readonly eventSource?: string;
  /** Unread here; named so an inline test `ctx` mirroring `StepExecutionContext` type-checks. */
  readonly workflowRef?: string;
  readonly params?: Record<string, unknown>;
  readonly evidence?: Record<string, Record<string, unknown> | undefined>;
}

/** The subset of `run-workflow.ts`'s `RunWorkflowOptions` a child drive passes. */
export interface ChildWorkflowDriveOptions {
  readonly target: string;
  readonly signal?: AbortSignal;
  readonly dispatcher?: UnitDispatcher;
  readonly maxConcurrency?: number;
  readonly eventSource?: string;
  readonly disposeDispatchResources?: () => void | Promise<void>;
}

/** The real engine, via a dynamic import (see the module doc). The caller re-reads the child row afterward. */
async function driveWithRealEngine(options: ChildWorkflowDriveOptions): Promise<void> {
  const { runWorkflowSteps } = await import("./run-workflow");
  await runWorkflowSteps(options);
}

export interface DriveChildWorkflowInput {
  /** `unitId` is the parent unit's `journalBaseId`. */
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

/** Another live process holds the child run's lock file (run-workflow.ts). */
function isLeaseBusyError(err: unknown): boolean {
  return err instanceof TransientError && err.code === "RUN_LEASE_HELD";
}

/** The `child_workflow_failed` message. */
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

/** Param validation and the deterministic invocation key, or a `child_workflow_publish_failed` outcome. */
function precheckAndDeriveInvocationKey(
  input: Pick<DriveChildWorkflowInput, "request" | "target" | "ctx" | "childParams" | "inputHash">,
): { ok: true; invocationKey: string } | { ok: false; outcome: UnitOutcome } {
  const { request, target, ctx, childParams, inputHash } = input;

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
 * Publish the child run idempotently and return the pre-drive row. Runs with
 * no transaction open on this connection (reached from the dispatch seam).
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
 * Drive the published child run with the real engine unless it is already
 * `blocked`/`failed` (never re-driven). Returns the final re-read row, or a
 * `child_workflow_busy` / `child_workflow_drive_failed` outcome.
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
    // The parent's own `finally` owns the process-lifecycle drain; no maxSteps/maxRetries.
    disposeDispatchResources: () => {},
  };
  try {
    // The re-read stays inside this try: an escaped throw would skip the
    // parent attempt's finish and leave its row `running` with a false
    // "not dispatched" diagnostic.
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
    // Every other throw (a repository error mid-drive, a status race) maps
    // to child_workflow_drive_failed — never rethrown into the scheduler.
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

/** The one child drive. Every failure before the drive produces `child_workflow_publish_failed`. */
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

  // Checked against the re-read status, so an already-terminal child is never misreported as aborted.
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
      // A driven child left non-terminal (its own gate loop exhausted) fails
      // the unit, so the parent never advances on an unresolved child.
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
