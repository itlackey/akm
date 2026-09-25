// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { ConfigError, UsageError } from "../../core/errors";
import { NO_ENGINE_MESSAGE_SUFFIX } from "../../integrations/agent/engine-fallback";
import { resolveExecution } from "../../integrations/agent/execution";
import { sourceStepProgramUnit, sourceStepRef } from "../source-ir/program";
import type { WorkflowSourceStep } from "../source-ir/schema";
import { classifyWorkflowStepUses } from "../source-ir/semantics";
import { qualifyRef } from "./environment";
import type { ResolutionContext, ResolvedDispatch } from "./step-values";
import { childWorkflowDispatch } from "./targets/child-workflow";
import { commandDispatch, commandResult, inlineDispatch } from "./targets/command";
import { directScript } from "./targets/script";
import { directShell } from "./targets/shell";
import { taskDispatch } from "./targets/task";

export async function resolveStep(source: WorkflowSourceStep, context: ResolutionContext): Promise<ResolvedDispatch> {
  const baseUnit = sourceStepProgramUnit(source);
  if (source.exec || source.run !== undefined) return directShell(source, baseUnit, context);
  if (!source.uses) return inlineDispatch(source, baseUnit, context);
  const target = classifyWorkflowStepUses(source.uses);
  if (target.kind === "task") return taskDispatch(source, baseUnit, target.ref, context);
  // A direct `uses: workflows/<ref>` step (spec docs/plans/specs/
  // p3a-plan-v5-child-freeze.md §4.2, row B-01/B-04). `with:` on this target
  // IS a valid binding surface (A-N8) — unlike scripts/commands below,
  // `rejectNonTaskBindingWith` must NOT be extended to it.
  if (target.kind === "workflow") {
    return childWorkflowDispatch({
      source,
      baseUnit,
      childRefInput: target.ref,
      context,
      via: "direct",
      authoredInputs: { kind: "with", value: source.with },
    });
  }
  if (target.kind === "script") {
    rejectNonTaskBindingWith(source, target.ref, "script");
    return directScript(source, baseUnit, target.ref, context);
  }
  if (target.kind === "command" || target.kind === "builtin-command") {
    if (target.kind === "command") rejectNonTaskBindingWith(source, target.ref, "command");
    const action =
      target.kind === "builtin-command"
        ? source.with
        : { ref: qualifyRef(target.ref, "commands", context.asset, context.config) };
    return commandDispatch(source, baseUnit, action, context);
  }
  throw new UsageError(`Workflow target ${source.uses} is not executable in 0.9.2.`, "WORKFLOW_SOURCE_INVALID");
}

/**
 * A-N5 (spec docs/plans/specs/p2b-input-bindings.md §1.7): `commands/<ref>`
 * and `scripts/<ref>` are not binding surfaces — a `with:` authored on either
 * now fails closed instead of being silently dropped (the same defect P1a
 * closed for `tasks/<ref>`, now repeated for these two targets, B-22/B-23).
 * `akm/command`'s `with:` is its own argument bag
 * (`parseBuiltinCommandAction`) and never routes through here.
 */
function rejectNonTaskBindingWith(source: WorkflowSourceStep, ref: string, kind: "command" | "script"): void {
  if (source.with === undefined) return;
  const family = kind === "command" ? "commands" : "scripts";
  throw new UsageError(
    `Workflow step ${source.id} cannot pass with: to ${family} target ${ref}; a ${kind} ref is not a binding surface.`,
    "COMPOSITION_INVALID",
  );
}

const NO_ENGINE_AVAILABLE_MESSAGE = NO_ENGINE_MESSAGE_SUFFIX;

function isNoEngineAvailable(err: unknown): boolean {
  return err instanceof ConfigError && err.message.includes(NO_ENGINE_AVAILABLE_MESSAGE);
}

export function resolveJudge(source: WorkflowSourceStep, context: ResolutionContext): ResolvedDispatch | undefined {
  const configuredEngine = context.config.workflow?.judgeEngine;
  const content = source.gate?.rubric?.trim() ?? "Judge workflow completion.";
  try {
    const prepared = resolveExecution({
      content,
      config: context.config,
      ...(configuredEngine ? { current: { engine: configuredEngine } } : {}),
    });
    return commandResult(source, { onError: "fail", source: sourceStepRef(source) }, prepared, context);
  } catch (err) {
    if (configuredEngine || !isNoEngineAvailable(err)) throw err;
    return undefined;
  }
}
