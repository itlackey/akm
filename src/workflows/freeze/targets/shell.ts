// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { FrozenWorkflowShellTarget } from "../../plan";
import { freezeEnvironment } from "../environment";
import {
  type BaseUnit,
  type FreezeStep,
  freezeExecSpec,
  type ResolutionContext,
  type ResolvedDispatch,
} from "../step-values";

export function directShell(source: FreezeStep, baseUnit: BaseUnit, context: ResolutionContext): ResolvedDispatch {
  const authoredExec = baseUnit.exec;
  if (!authoredExec) throw new Error(`workflow shell step ${source.id} has no argv`);
  const exec = freezeExecSpec(source, authoredExec, context);
  const environment = Object.freeze(freezeEnvironment(source, authoredExec, context));
  const target: FrozenWorkflowShellTarget = Object.freeze({
    kind: "shell",
    contentHash: "",
    exec,
  });
  return {
    target,
    environment,
    unit: { ...baseUnit, exec },
    instructions: source.instructions ?? `Run ${authoredExec.command.join(" ")}.`,
  };
}
