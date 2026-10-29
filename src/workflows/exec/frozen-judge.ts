// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The gate judge built from the step's frozen judge target. Its outcome is
 * journaled (the gate row, or a blocked step's notes), so it goes through the
 * same dispatch redaction as every unit; its dispatch carries the real
 * run/step and gate unit ids the gate row records. A judge carries no `env:`
 * bindings (a step's environment belongs to the work, not the verifier).
 */

import { warn } from "../../core/warn";
import { mergeNotices } from "../../execution/notices";
import type { LoweringNotice } from "../../execution/resolved-request";
import type { FrozenWorkflowCommandTarget } from "../plan";
import { resolveRunBundleRoot } from "../runtime/workflow-asset-loader";
import type { JudgeCallIdentity, SummaryJudge } from "../validate-summary";
import { dispatchWorkflowExecution, type UnitDispatcher, type UnitDispatchRequest } from "./unit-dispatch";

/** The run/step a judge belongs to; a caller that journals a gate row also passes its exact identity per call. */
export interface JudgeOwner {
  runId: string;
  stepId: string;
}

/** The gate's node id — identical to what `journalGateEvaluationStart` writes. */
export function gateNodeId(stepId: string): string {
  return `${stepId}.gate`;
}

/**
 * The root of the bundle the run's workflow lives in, found when the judge is built (a bundle update moves it).
 * No frozen judge, no root needed. When the bundle does not resolve the judge is not built, and the error names the ref.
 */
export function resolveJudgeCwd(
  target: FrozenWorkflowCommandTarget | null | undefined,
  workflowRef: string,
): string | undefined {
  if (!target) return undefined;
  return resolveRunBundleRoot(workflowRef);
}

/** Identity for one judge dispatch: the caller's row identity, else the run/step with the gate node id. */
function dispatchIdentity(owner: JudgeOwner, identity: JudgeCallIdentity | undefined): JudgeCallIdentity {
  return identity ?? { ...owner, unitId: gateNodeId(owner.stepId) };
}

function warnLoweringNotices(notices: readonly Readonly<LoweringNotice>[] | undefined): void {
  for (const notice of mergeNotices(notices) ?? []) {
    warn(`Workflow judge lowering notice (${notice.code}; ${notice.adapter}; ${notice.field}): ${notice.message}`);
  }
}

/**
 * Build a gate judge from the frozen target without consulting live config; `eventSource` stamps it like a unit.
 * `cwd` is the root of the run's bundle, where the judge works like every other agent dispatch.
 */
export function frozenSummaryJudge(
  target: FrozenWorkflowCommandTarget | null | undefined,
  signal: AbortSignal | undefined,
  dispatcher: UnitDispatcher | undefined,
  owner: JudgeOwner,
  eventSource?: string,
  cwd?: string,
): SummaryJudge | null {
  if (!target) return null;
  const dispatch = dispatcher ?? dispatchWorkflowExecution;
  return async ({ system, user }, identity) => {
    const id = dispatchIdentity(owner, identity);
    const commonRequest = {
      runId: id.runId,
      stepId: id.stepId,
      unitId: id.unitId,
      nodeId: gateNodeId(id.stepId),
      ...(id.attempt !== undefined ? { attempt: id.attempt } : {}),
      ...(id.dispatchId !== undefined ? { dispatchId: id.dispatchId } : {}),
      prompt: user,
      systemPrompt: system,
      ...(signal ? { signal } : {}),
    };
    const request: UnitDispatchRequest = {
      ...commonRequest,
      frozenTarget: target,
      ...(cwd !== undefined ? { cwd } : {}),
      timeoutMs: target.runner.timeoutMs ?? null,
      ...(eventSource !== undefined ? { eventSource } : {}),
    };
    const outcome = await dispatch(request);
    if (outcome.usage && id.recordTokens) {
      id.recordTokens(
        (outcome.usage.inputTokens ?? 0) + (outcome.usage.outputTokens ?? 0) + (outcome.usage.reasoningTokens ?? 0),
      );
    }
    // The dispatcher lowers the request once, and its notices are the lowerer's own sanitized ones.
    warnLoweringNotices(outcome.notices);
    if (!outcome.ok) {
      throw new Error(outcome.error || `Verification judge "${target.request.target.name}" failed.`);
    }
    return outcome.text ?? "";
  };
}
