// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { parseBundleRef } from "../../../core/asset/asset-ref";
import { UsageError } from "../../../core/errors";
import type { InputContract, TaskInputBinding } from "../../../execution/input-contract";
import { prepareTaskV3Execution } from "../../../tasks/prepare/prepare";
import { parseTaskSource } from "../../../tasks/source/parse-task-source";
import { projectTaskSourceV4 } from "../../../tasks/source/project-v4";
import type { FrozenWorkflowShellTarget, FrozenWorkflowTarget } from "../../ir/schema-v4";
import type { ProgramExec, ProgramUnit } from "../../program/schema";
import { workflowShellCommand } from "../../source-ir/program";
import type { WorkflowSourceStep } from "../../source-ir/schema";
import { captureOwned, freezeEnvironment, guardedExecutionSource, resolveOwnedAsset } from "../environment";
import { gitIdentity } from "../identity";
import {
  declaredParamNames,
  earlierStepIds,
  freezeExecSpec,
  type ResolutionContext,
  type ResolvedDispatch,
} from "../step-values";
import { freezeTaskInputBindings } from "../task-bindings";
import { childWorkflowDispatch } from "./child-workflow";
import { commandResult } from "./command";
import { scriptResult } from "./script";

/** The one message shared by every "cannot prove this is a valid binding surface" rejection (A-N5). */
function noDeclaredInputsError(stepId: string, ref: string): UsageError {
  return new UsageError(
    `Workflow step ${stepId} cannot pass with: to task target ${ref}; ${ref} declares no inputs.`,
    "COMPOSITION_INVALID",
  );
}

interface ResolvedTaskForComposition {
  readonly owned: Awaited<ReturnType<typeof resolveOwnedAsset>>;
  readonly task: Parameters<typeof prepareTaskV3Execution>[0];
  /** The composed task's OWN declared inputs: contract. Undefined = declares no inputs at all (A-N5). */
  readonly contract: InputContract | undefined;
}

/**
 * A-N6 (spec docs/plans/specs/p2b-input-bindings.md §1.7): LC-N1's
 * peek-and-throw (p2a §1.5) is GONE — a version: 4 target now composes.
 * `parseTaskSource` parses the YAML ONCE and routes on the SAME {root,
 * lineAt} the v3 arm always used, so a v3 composition stays byte-identical
 * (B-07, B-08). `contract` is undefined for a v3 task (which can never
 * declare `inputs:`, P2a §1.2 D2) or a v4 task with no `inputs:` key at all —
 * either way, "no declared inputs" (A-N5).
 *
 * RECORDED TENSION (spec §0, Review log): A-N5's "no declared inputs"
 * rejection is reasoned from the target's PARSED `inputs:` contract, which
 * needs the target to resolve — yet `tests/workflows/with-rejection.test.ts`
 * B-02b pins `COMPOSITION_INVALID` (not an asset-resolution error) for an
 * UNRESOLVABLE task ref with an authored `with:`. Reconciled here: an
 * authored `with:` whose target cannot even be resolved/parsed "cannot be
 * proven a valid binding surface", so it is refused the same
 * no-declared-inputs way — a `with:`-free step's resolution failure is
 * untouched and propagates as before.
 *
 * Code-review finding: that reconciliation must stay scoped to ASSET
 * resolution (`resolveOwnedAsset`/`captureOwned`) only. Once the target
 * resolves to a real file, `parseTaskSource`/`projectTaskSourceV4` reports a
 * genuine, path-and-line-anchored defect in the composed task's OWN source
 * (e.g. `TASK_SOURCE_INVALID` for an unsupported `inputs.<name>` field) —
 * that is never "cannot be proven a valid binding surface" and must not be
 * repainted as `noDeclaredInputsError`. Parsing therefore happens OUTSIDE
 * the try/catch below, so its errors propagate unchanged regardless of
 * whether this step authored a `with:`.
 */
async function resolveTaskForComposition(
  source: WorkflowSourceStep,
  refInput: string,
  context: ResolutionContext,
): Promise<ResolvedTaskForComposition> {
  const { owned, retained } = await resolveAndCaptureTaskAsset(source, refInput, context);
  const parsed = parseTaskSource({ yaml: retained.content, filePath: owned.file, workspaceRoot: owned.root });
  const contract = parsed.v4.inputs;
  const task = projectTaskSourceV4(parsed.v4);
  return { owned, task, contract };
}

/** The asset-resolution-only half of {@link resolveTaskForComposition} — the sole failure mode an authored `with:` on an unresolvable ref may repaint as `noDeclaredInputsError` (A-N5's `with-rejection.test.ts` B-02b). */
async function resolveAndCaptureTaskAsset(
  source: WorkflowSourceStep,
  refInput: string,
  context: ResolutionContext,
): Promise<{
  readonly owned: Awaited<ReturnType<typeof resolveOwnedAsset>>;
  readonly retained: ReturnType<typeof captureOwned>;
}> {
  try {
    const owned = await resolveOwnedAsset(refInput, "task", context);
    const retained = captureOwned(owned, context.collector);
    return { owned, retained };
  } catch (cause) {
    if (source.with !== undefined) throw noDeclaredInputsError(source.id, refInput);
    throw cause;
  }
}

export async function taskDispatch(
  source: WorkflowSourceStep,
  baseUnit: ProgramUnit,
  refInput: string,
  context: ResolutionContext,
): Promise<ResolvedDispatch> {
  const { owned, task, contract } = await resolveTaskForComposition(source, refInput, context);

  // A-N5: a with: on a target that declares no inputs: at all is
  // COMPOSITION_INVALID. Fires on ANY authored with: shape, including `{}`
  // (the check is `!== undefined`, not "non-empty").
  if (source.with !== undefined && contract === undefined) {
    throw noDeclaredInputsError(source.id, refInput);
  }

  // P3a (docs/plans/specs/p3a-plan-v5-child-freeze.md §4.2, row B-12): a task
  // whose OWN target is `uses: workflows/<ref>` used to fast-fail here,
  // before ever calling prepareTaskV3Execution. That rejection is REMOVED —
  // flow continues to the bindings computation and the prepare call exactly
  // as for any other task target, and `prepared.kind === "workflow"` below
  // routes to the ONE child-workflow resolver instead.

  // Lane A2 (§3.2-§3.5): normalize THIS step's own with: against THIS task's
  // OWN declared inputs — no merge across a composition chain (B-29). A task
  // with no inputs: has contract === undefined, so an empty {} contract is
  // used; freezeTaskInputBindings then produces no bindings for it (there is
  // nothing to bind, and the COMPOSITION_INVALID check above already fired
  // for any authored with:).
  const bindings = freezeTaskInputBindings({
    stepId: source.id,
    targetRef: refInput,
    with: source.with,
    contract: contract ?? {},
    earlierStepIds: earlierStepIds(context.sourceIr, source.id),
    declaredParamNames: declaredParamNames(context.sourceIr),
  });

  const prepared = await prepareTaskV3Execution(task, {
    taskId: parseBundleRef(owned.ref).conceptId.slice("tasks/".length),
    taskRef: owned.ref,
    bundleName: owned.bundle,
    bundleRoot: owned.root,
    config: context.config,
    commandSourceLoader: (ref, kind) => guardedExecutionSource(ref, kind, context),
    resolveAsset: async ({ ref, type }) => {
      const target = await resolveOwnedAsset(ref, type, context);
      captureOwned(target, context.collector);
      return { file: target.file, bundleRoot: target.root };
    },
    readFile: (file, root = owned.root) => context.collector.readBytes(file, root),
  });
  if (prepared.kind === "workflow") {
    // P3a (spec §4.2, rows B-12/B-13): routes to the ONE child-workflow
    // resolver instead of rejecting. `prepared.ref`/`prepared.taskRef` are
    // already qualified (§4.2 step 1 re-resolves and re-canonicalizes them
    // regardless). Always hands over the bindings just computed above — this
    // task's OWN effective inputs, already classified once against its own
    // contract — to be RE-bound against the child's declared `params:`
    // (never round-tripped through the `with:` grammar: doing so would let a
    // literal value shaped like `{from: ...}` be silently reinterpreted as a
    // reference, code-review finding). Task source v4 rejects `with:` on any
    // target but `uses: akm/command` (row B-28), so a workflow-target task
    // can no longer author `with:` at all — the `{kind:"with"}` arm this
    // ternary used to reach for a v3 task, or a v4 task with no `inputs:`,
    // is unreachable from here and deleted (P4 §3.2.7, row B-30).
    // `AuthoredChildInputs`'s `{kind:"with"}` member itself stays — the
    // DIRECT composition path (`resolve-steps.ts`) still produces it.
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
    const authoredExec: ProgramExec = {
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

/** Attach the frozen inputBindings (A-N7) to whichever target shape taskDispatch produced. Absent, never [], when empty. */
function withInputBindings(resolved: ResolvedDispatch, bindings: readonly TaskInputBinding[]): ResolvedDispatch {
  if (bindings.length === 0) return resolved;
  return {
    ...resolved,
    target: Object.freeze({ ...resolved.target, inputBindings: bindings }) as FrozenWorkflowTarget,
  };
}
