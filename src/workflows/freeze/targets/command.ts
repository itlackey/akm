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
import { buildExecution, resolveExecution } from "../../../integrations/agent/execution";
import type { RunnerSpec } from "../../../integrations/agent/runner";
import type { FrozenWorkflowCommandTarget, FrozenWorkflowEnvironmentBinding } from "../../ir/schema-v4";
import type { ProgramUnit } from "../../program/schema";
import type { WorkflowSourceStep } from "../../source-ir/schema";
import { freezeEnvironment, guardedExecutionSource } from "../environment";
import { gitIdentity } from "../identity";
import {
  durableRequest,
  executionUnitValues,
  executionValues,
  type ResolutionContext,
  type ResolvedDispatch,
  targetConcurrency,
} from "../step-values";

function inlineWorkflowCommandAction(action: unknown, commandMode: WorkflowSourceStep["commandMode"]): unknown {
  if (commandMode !== "portable-template") return action;
  const parsed = parseBuiltinCommandAction(action);
  if (parsed.kind !== "inline") return action;
  return { content: parsed.content.split(PORTABLE_ARGUMENTS_PLACEHOLDER).join(parsed.arguments ?? "") };
}

export async function commandDispatch(
  source: WorkflowSourceStep,
  baseUnit: ProgramUnit,
  action: unknown,
  context: ResolutionContext,
): Promise<ResolvedDispatch> {
  const prepared = await prepareCommandInvocation({
    action: inlineWorkflowCommandAction(action, source.commandMode),
    config: context.config,
    ...(context.sourceIr.defaults
      ? { invocationDefaults: executionUnitValues(context.sourceIr.defaults, context.asset.sourcePath) }
      : {}),
    ...(source.commandMode === "literal" || source.commandMode === "portable-template"
      ? { inlineContentMode: "literal" as const }
      : {}),
    current: executionValues(source, context.asset.sourcePath),
    sourceLoader: (ref, kind) => guardedExecutionSource(ref, kind, context),
  });
  return commandResult(source, baseUnit, prepared, context);
}

export function inlineDispatch(
  source: WorkflowSourceStep,
  baseUnit: ProgramUnit,
  context: ResolutionContext,
): ResolvedDispatch {
  const content = source.instructions ?? `Execute workflow step ${source.id}.`;
  const prepared = resolveExecution({
    content,
    config: context.config,
    ...(context.sourceIr.defaults
      ? { invocationDefaults: executionUnitValues(context.sourceIr.defaults, context.asset.sourcePath) }
      : {}),
    current: executionValues(source, context.asset.sourcePath),
  });
  return commandResult(source, baseUnit, prepared, context);
}

export function commandResult(
  source: WorkflowSourceStep,
  baseUnit: ProgramUnit,
  prepared: PreparedCommandInvocation,
  context: ResolutionContext,
  literals: readonly FrozenWorkflowEnvironmentBinding[] = [],
): ResolvedDispatch {
  const request = durableRequest(prepared.request);
  const lowered = buildExecution(request, prepared.runner);
  const cwdIdentity = captureFrozenDirectoryIdentity(context.asset.sourcePath);
  const runner: RunnerSpec = lowered.runner;
  const unit: ProgramUnit = {
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
