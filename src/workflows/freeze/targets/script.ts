// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { prepareScriptTarget } from "../../../tasks/prepare/prepare-script-target";
import type { PreparedTaskV3Execution } from "../../../tasks/prepare/prepared-execution";
import type { FrozenWorkflowEnvironmentBinding, FrozenWorkflowScriptTarget } from "../../ir/schema-v4";
import type { ProgramExec, ProgramUnit } from "../../program/schema";
import type { WorkflowSourceStep } from "../../source-ir/schema";
import { captureOwned, freezeEnvironment, resolveOwnedAsset } from "../environment";
import { gitIdentity, scriptExecutable } from "../identity";
import { freezeExecSpec, type ResolutionContext, type ResolvedDispatch } from "../step-values";

export async function directScript(
  source: WorkflowSourceStep,
  baseUnit: ProgramUnit,
  refInput: string,
  context: ResolutionContext,
): Promise<ResolvedDispatch> {
  const owned = await resolveOwnedAsset(refInput, "script", context);
  captureOwned(owned, context.collector);
  // Typed preparer (P1b spec §4.3) — no synthetic task YAML, no parseTaskV3Yaml
  // call, no fabricated schedule/filePath/taskId/taskRef. The script's own
  // owned identity (ref/file/bundleRoot) is all prepareScriptTarget needs.
  const captured = prepareScriptTarget({
    ref: owned.ref,
    file: owned.file,
    bundleRoot: owned.root,
    readFile: () => context.collector.readBytes(owned.file, owned.root),
  });
  return scriptResult(
    source,
    baseUnit,
    {
      sourceRef: captured.ref,
      interpreter: captured.interpreter,
      extension: captured.extension,
      bytesBase64: captured.bytesBase64,
      byteLength: captured.byteLength,
      sha256: captured.sha256,
      cwdIdentity: captured.cwdIdentity,
    },
    context,
    [],
  );
}

/**
 * The subset of a script projection scriptResult() actually reads — shared by
 * taskDispatch's prepareTaskV3Execution-produced PreparedTaskV3Script (which
 * structurally satisfies this narrower shape) and directScript's
 * prepareScriptTarget()-produced PreparedScriptTarget above (field-mapped:
 * PreparedScriptTarget.ref -> sourceRef).
 */
type FrozenScriptCapture = Pick<
  Extract<PreparedTaskV3Execution, { kind: "script" }>,
  "sourceRef" | "interpreter" | "extension" | "bytesBase64" | "byteLength" | "sha256" | "cwdIdentity"
>;

export function scriptResult(
  source: WorkflowSourceStep,
  baseUnit: ProgramUnit,
  prepared: FrozenScriptCapture,
  context: ResolutionContext,
  literals: readonly FrozenWorkflowEnvironmentBinding[],
): ResolvedDispatch {
  const authoredExec: ProgramExec = { command: [scriptExecutable(prepared.interpreter), "<frozen-script>"] };
  const exec = freezeExecSpec(source, authoredExec, context);
  const environment = Object.freeze([...literals, ...freezeEnvironment(source, authoredExec, context)]);
  const target: FrozenWorkflowScriptTarget = Object.freeze({
    kind: "script",
    ref: prepared.sourceRef,
    contentHash: prepared.sha256,
    exec,
    interpreter: prepared.interpreter,
    extension: prepared.extension,
    bytesBase64: prepared.bytesBase64,
    byteLength: prepared.byteLength,
    cwdIdentity: prepared.cwdIdentity,
    materialization: "ephemeral-0700-delete",
    ...gitIdentity(baseUnit, prepared.cwdIdentity.realRoot),
  });
  return {
    target,
    environment,
    unit: { ...baseUnit, exec: authoredExec },
    instructions: source.instructions ?? `Run script ${prepared.sourceRef}.`,
  };
}
