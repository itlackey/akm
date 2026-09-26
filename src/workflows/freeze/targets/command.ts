// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import { parseBuiltinCommandAction } from "../../../commands/command/builtin-action";
import { type PreparedCommandInvocation, prepareCommandInvocation } from "../../../commands/command/command-execution";
import { PORTABLE_ARGUMENTS_PLACEHOLDER } from "../../../commands/command/portable-template";
import { captureFrozenDirectoryIdentity } from "../../../execution/directory-identity";
import {
  canonicalResolvedExecutionRequest,
  type ResolvedExecutionRequestV1,
} from "../../../execution/resolved-request";
import { fallbackAnnouncement } from "../../../integrations/agent/engine-fallback";
import { buildExecution } from "../../../integrations/agent/execution";
import type { RunnerSpec } from "../../../integrations/agent/runner";
import type { FrozenWorkflowCommandTarget, FrozenWorkflowEnvironmentBinding, WorkflowCommandMode } from "../../plan";
import { freezeEnvironment, workflowExecutionSource } from "../environment";
import { gitIdentity } from "../identity";
import {
  type BaseUnit,
  durableRequest,
  executionUnitValues,
  type FreezeStep,
  type ResolutionContext,
  type ResolvedDispatch,
  targetConcurrency,
} from "../step-values";

function inlineWorkflowCommandAction(action: unknown, commandMode: WorkflowCommandMode | undefined): unknown {
  if (commandMode !== "portable-template") return action;
  const parsed = parseBuiltinCommandAction(action);
  if (parsed.kind !== "inline") return action;
  return { content: parsed.content.split(PORTABLE_ARGUMENTS_PLACEHOLDER).join(parsed.arguments ?? "") };
}

export async function commandDispatch(
  source: FreezeStep,
  baseUnit: BaseUnit,
  action: unknown,
  context: ResolutionContext,
): Promise<ResolvedDispatch> {
  const prepared = await prepareCommandInvocation({
    action: inlineWorkflowCommandAction(action, source.commandMode),
    config: context.config,
    ...(context.plan.defaults
      ? { invocationDefaults: executionUnitValues(context.plan.defaults, context.asset.sourcePath) }
      : {}),
    ...(source.commandMode === "literal" || source.commandMode === "portable-template"
      ? { inlineContentMode: "literal" as const }
      : {}),
    current: executionUnitValues(source.unit, context.asset.sourcePath),
    sourceLoader: (ref, kind) => workflowExecutionSource(ref, kind, context),
  });
  return commandResult(source, baseUnit, prepared, context);
}

export function commandResult(
  source: FreezeStep,
  baseUnit: BaseUnit,
  prepared: PreparedCommandInvocation,
  context: ResolutionContext,
  literals: readonly FrozenWorkflowEnvironmentBinding[] = [],
): ResolvedDispatch {
  const request = durableRequest(prepared.request);
  const lowered = buildExecution(request, prepared.runner);
  const cwdIdentity = captureFrozenDirectoryIdentity(context.asset.sourcePath);
  const runner: RunnerSpec = lowered.runner;
  const unit: BaseUnit = {
    ...baseUnit,
    engine: request.engine.name,
    ...(request.model ? { model: request.model.resolved } : {}),
    ...(Object.hasOwn(request.runtime, "timeoutMs") ? { timeoutMs: request.runtime.timeoutMs } : {}),
    ...(request.inference ? { llm: request.inference } : {}),
    ...(request.outputSchema ? { output: request.outputSchema } : {}),
  };
  const environment = Object.freeze([...literals, ...freezeEnvironment(source, undefined, context)]);
  const target: FrozenWorkflowCommandTarget = Object.freeze({
    kind: "command",
    ref: request.command.source?.ref ?? null,
    contentHash: createHash("sha256").update(request.command.content).digest("hex"),
    request: JSON.parse(canonicalResolvedExecutionRequest(request)) as ResolvedExecutionRequestV1,
    runner,
    ...(targetConcurrency(runner, context.config) ? { concurrency: targetConcurrency(runner, context.config) } : {}),
    cwdIdentity,
    ...gitIdentity(baseUnit, cwdIdentity.realRoot),
  });
  const engineAnnouncement = fallbackAnnouncement(prepared.fallbackEngineName, request.engine.name);
  return {
    target,
    environment,
    unit,
    instructions: request.command.content,
    ...(engineAnnouncement ? { engineAnnouncement } : {}),
  };
}
