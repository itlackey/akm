// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { parseBundleRef } from "../../../core/asset/asset-ref";
import { UsageError } from "../../../core/errors";
import type { InputContract, TaskInputBinding } from "../../../execution/input-contract";
import { prepareTaskV3Execution } from "../../../tasks/prepare/prepare";
import { parseTaskSource } from "../../../tasks/source/parse-task-source";
import { projectTaskSourceV4 } from "../../../tasks/source/project-v4";
import type { FrozenWorkflowShellTarget, FrozenWorkflowTarget, WorkflowExec } from "../../plan";
import { workflowShellCommand } from "../../source-semantics";
import { freezeEnvironment, resolveOwnedAsset, workflowExecutionSource } from "../environment";
import { gitIdentity } from "../identity";
import {
  type BaseUnit,
  declaredParamNames,
  earlierStepIds,
  type FreezeStep,
  freezeExecSpec,
  type ResolutionContext,
  type ResolvedDispatch,
} from "../step-values";
import { freezeTaskInputBindings } from "../task-bindings";
import { childWorkflowDispatch } from "./child-workflow";
import { commandResult } from "./command";
import { scriptResult } from "./script";

/** The rejection for a `with:` on a task that declares no inputs (or does not resolve). */
function noDeclaredInputsError(stepId: string, ref: string): UsageError {
  return new UsageError(
    `Workflow step ${stepId} cannot pass with: to task target ${ref}; ${ref} declares no inputs.`,
    "COMPOSITION_INVALID",
  );
}

interface ResolvedTaskForComposition {
  readonly owned: Awaited<ReturnType<typeof resolveOwnedAsset>>;
  readonly task: Parameters<typeof prepareTaskV3Execution>[0];
  /** The composed task's own declared `inputs:`; undefined when it declares none. */
  readonly contract: InputContract | undefined;
}

/**
 * Resolve and parse the composed task. An authored `with:` whose target does
 * not even resolve cannot be proven a valid binding surface, so it is refused
 * the same no-declared-inputs way; a genuine defect in the resolved task's own
 * source propagates unchanged.
 */
async function resolveTaskForComposition(
  source: FreezeStep,
  refInput: string,
  context: ResolutionContext,
): Promise<ResolvedTaskForComposition> {
  let owned: Awaited<ReturnType<typeof resolveOwnedAsset>>;
  let yaml: string;
  try {
    owned = await resolveOwnedAsset(refInput, "task", context);
    yaml = fs.readFileSync(owned.file, "utf8");
  } catch (cause) {
    if (source.with !== undefined) throw noDeclaredInputsError(source.id, refInput);
    throw cause;
  }
  const parsed = parseTaskSource({ yaml, filePath: owned.file, workspaceRoot: owned.root });
  return { owned, task: projectTaskSourceV4(parsed.v4), contract: parsed.v4.inputs };
}

export async function taskDispatch(
  source: FreezeStep,
  baseUnit: BaseUnit,
  refInput: string,
  context: ResolutionContext,
): Promise<ResolvedDispatch> {
  const { owned, task, contract } = await resolveTaskForComposition(source, refInput, context);

  // Any authored `with:` (even `{}`) on a task that declares no inputs is COMPOSITION_INVALID.
  if (source.with !== undefined && contract === undefined) {
    throw noDeclaredInputsError(source.id, refInput);
  }

  // This step's own `with:` against this task's own declared inputs (none → no bindings).
  const bindings = freezeTaskInputBindings({
    stepId: source.id,
    targetRef: refInput,
    with: source.with,
    contract: contract ?? {},
    earlierStepIds: earlierStepIds(context.plan, source.id),
    declaredParamNames: declaredParamNames(context.plan),
  });

  const prepared = await prepareTaskV3Execution(task, {
    taskId: parseBundleRef(owned.ref).conceptId.slice("tasks/".length),
    taskRef: owned.ref,
    bundleName: owned.bundle,
    bundleRoot: owned.root,
    config: context.config,
    commandSourceLoader: (ref, kind) => workflowExecutionSource(ref, kind, context),
    resolveAsset: async ({ ref, type }) => {
      const target = await resolveOwnedAsset(ref, type, context);
      return { file: target.file, bundleRoot: target.root };
    },
  });
  if (prepared.kind === "workflow") {
    // A task whose own target is a workflow composes it as a child. This
    // task's effective inputs, already classified against its own contract,
    // are re-bound against the child's `params:` — never round-tripped through
    // the `with:` grammar, which would reinterpret a literal shaped like
    // `{from: ...}` as a reference.
    return childWorkflowDispatch({
      source,
      baseUnit,
      childRefInput: prepared.ref,
      context,
      via: "task",
      taskRef: prepared.taskRef,
      authoredInputs: { kind: "bindings", value: bindings },
    });
  }
  const taskLiterals = Object.entries(prepared.environment).map(([name, value]) =>
    Object.freeze({ kind: "literal" as const, name, value }),
  );
  if (prepared.kind === "command") {
    return withInputBindings(commandResult(source, baseUnit, prepared.invocation, context, taskLiterals), bindings);
  }
  if (prepared.kind === "shell") {
    const authoredExec: WorkflowExec = {
      command: workflowShellCommand(prepared.shell, prepared.command),
      ...(prepared.cwdIdentity.realCwd !== prepared.cwdIdentity.realRoot
        ? { cwd: path.relative(prepared.cwdIdentity.realRoot, prepared.cwdIdentity.realCwd) }
        : {}),
    };
    const exec = freezeExecSpec(source, authoredExec, context);
    const environment = Object.freeze([...taskLiterals, ...freezeEnvironment(source, authoredExec, context)]);
    const target: FrozenWorkflowShellTarget = Object.freeze({
      kind: "shell",
      contentHash: "",
      exec,
      cwdIdentity: prepared.cwdIdentity,
      ...gitIdentity(baseUnit, prepared.cwdIdentity.realRoot),
    });
    return withInputBindings(
      {
        target,
        environment,
        unit: { ...baseUnit, exec: authoredExec },
        instructions: source.instructions ?? `Run task ${owned.ref}.`,
      },
      bindings,
    );
  }
  return withInputBindings(scriptResult(source, baseUnit, prepared, context, taskLiterals), bindings);
}

/** Attach the frozen inputBindings to whichever target shape taskDispatch produced. Absent, never [], when empty. */
function withInputBindings(resolved: ResolvedDispatch, bindings: readonly TaskInputBinding[]): ResolvedDispatch {
  if (bindings.length === 0) return resolved;
  return {
    ...resolved,
    target: Object.freeze({ ...resolved.target, inputBindings: bindings }) as FrozenWorkflowTarget,
  };
}
