// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import { prepareScriptTarget } from "../../../tasks/prepare/prepare-script-target";
import type { PreparedTaskV3Execution } from "../../../tasks/prepare/prepared-execution";
import type { FrozenWorkflowEnvironmentBinding, FrozenWorkflowScriptTarget, WorkflowExec } from "../../plan";
import { freezeEnvironment, resolveOwnedAsset } from "../environment";
import { gitIdentity, scriptExecutable } from "../identity";
import {
  type BaseUnit,
  type FreezeStep,
  freezeExecSpec,
  type ResolutionContext,
  type ResolvedDispatch,
} from "../step-values";

export async function directScript(
  source: FreezeStep,
  baseUnit: BaseUnit,
  refInput: string,
  context: ResolutionContext,
): Promise<ResolvedDispatch> {
  const owned = await resolveOwnedAsset(refInput, "script", context);
  const captured = prepareScriptTarget({
    ref: owned.ref,
    file: owned.file,
    bundleRoot: owned.root,
    readFile: () => fs.readFileSync(owned.file),
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

/** The fields of a captured script `scriptResult` reads (from a task's or a direct script's preparation). */
type FrozenScriptCapture = Pick<
  Extract<PreparedTaskV3Execution, { kind: "script" }>,
  "sourceRef" | "interpreter" | "extension" | "bytesBase64" | "byteLength" | "sha256" | "cwdIdentity"
>;

export function scriptResult(
  source: FreezeStep,
  baseUnit: BaseUnit,
  prepared: FrozenScriptCapture,
  context: ResolutionContext,
  literals: readonly FrozenWorkflowEnvironmentBinding[],
): ResolvedDispatch {
  const authoredExec: WorkflowExec = { command: [scriptExecutable(prepared.interpreter), "<frozen-script>"] };
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
