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
import type { LoweringNotice } from "../../execution/resolved-request";
import type { FrozenWorkflowCommandTarget } from "../plan";
import type { JudgeCallIdentity, SummaryJudge } from "../validate-summary";
import { collectWorkflowDispatchSensitiveValues, withDispatchRedaction } from "./dispatch-redaction";
import {
  dispatchWorkflowExecution,
  prepareWorkflowExecution,
  type UnitDispatcher,
  type UnitDispatchRequest,
} from "./unit-dispatch";

/** The run/step a judge belongs to; a caller that journals a gate row also passes its exact identity per call. */
export interface JudgeOwner {
  runId: string;
  stepId: string;
}

/** The gate's node id — identical to what `journalGateEvaluationStart` writes. */
export function gateNodeId(stepId: string): string {
  return `${stepId}.gate`;
}

/** Identity for one judge dispatch: the caller's row identity, else the run/step with the gate node id. */
function dispatchIdentity(owner: JudgeOwner, identity: JudgeCallIdentity | undefined): JudgeCallIdentity {
  return identity ?? { ...owner, unitId: gateNodeId(owner.stepId) };
}

function warnLoweringNotices(...groups: readonly (readonly Readonly<LoweringNotice>[] | undefined)[]): void {
  const emitted = new Set<string>();
  for (const notices of groups) {
    for (const notice of notices ?? []) {
      const key = JSON.stringify([notice.code, notice.severity, notice.adapter, notice.field, notice.message]);
      if (emitted.has(key)) continue;
      emitted.add(key);
      warn(`Workflow judge lowering notice (${notice.code}; ${notice.adapter}; ${notice.field}): ${notice.message}`);
    }
  }
}

/** Build a gate judge from the frozen target without consulting live config; `eventSource` stamps it like a unit. */
export function frozenSummaryJudge(
  target: FrozenWorkflowCommandTarget | null | undefined,
  signal: AbortSignal | undefined,
  dispatcher: UnitDispatcher | undefined,
  owner: JudgeOwner,
  eventSource?: string,
): SummaryJudge | null {
  if (!target) return null;
  const dispatch = withDispatchRedaction(dispatcher ?? dispatchWorkflowExecution);
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
      timeoutMs: target.runner.timeoutMs ?? null,
      ...(eventSource !== undefined ? { eventSource } : {}),
    };
    // Lowering and authorization precede every live credential/passthrough
    // sample. The injected dispatcher may be a test seam, but it receives the
    // exact same already-validated request and redaction declaration.
    const lowered = prepareWorkflowExecution(
      request as UnitDispatchRequest & { frozenTarget: FrozenWorkflowCommandTarget },
    );
    const sensitiveValues = collectWorkflowDispatchSensitiveValues({ runner: target.runner }, undefined);
    const outcome = await dispatch({
      ...request,
      ...(sensitiveValues.length > 0 ? { sensitiveValues } : {}),
    });
    if (outcome.usage && id.recordTokens) {
      id.recordTokens(
        (outcome.usage.inputTokens ?? 0) + (outcome.usage.outputTokens ?? 0) + (outcome.usage.reasoningTokens ?? 0),
      );
    }
    // Only the common lowerer's own sanitized notices are loggable here. An
    // injected dispatcher is not trusted to supply prompt/body-free messages.
    warnLoweringNotices(lowered.notices);
    if (!outcome.ok) {
      throw new Error(outcome.error || `Verification engine "${target.request.engine.name}" failed.`);
    }
    return outcome.text ?? "";
  };
}
