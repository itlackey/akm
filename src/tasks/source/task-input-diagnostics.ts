// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `TASK_INPUT_DIAGNOSTICS` — the task-side message/code vocabulary for
 * `materializeInputFlags` (spec docs/plans/specs/p2a-task-source-v4.md §1.5
 * D3-N3, §4.2, §5.1).
 *
 * `materializeInputFlags` (`src/execution/input-contract.ts`) contains no
 * literal user-facing string of its own — every message/code it raises comes
 * from a caller-supplied `InputFlagDiagnostics`. `src/workflows/ir/params.ts`
 * supplies `WORKFLOW_PARAMETER_DIAGNOSTICS` for workflow params; this module
 * is that same seam's task-side sibling, consumed by `akm task run`'s Stage 2
 * (`src/tasks/run/load-task.ts`). Mirrors `WORKFLOW_PARAMETER_DIAGNOSTICS`'s
 * shape exactly (`unknownFlag`'s declared-name enumeration in the SEPARATE
 * `hint`, not the message — `params.ts:65-72`) with task-flavored nouns and
 * the codes §5.1 binds: `UNKNOWN_FLAG` for an undeclared name,
 * `INPUT_BINDING_INVALID` for every value/contract failure.
 */

import { UsageError } from "../../core/errors";
import type { InputFlagDiagnostics } from "../../execution/input-contract";

function invalidTaskInput(name: string, detail: string): UsageError {
  return new UsageError(`Task input "--${name}" ${detail}.`, "INPUT_BINDING_INVALID");
}

/** The task-input message/code vocabulary for `materializeInputFlags` (D3-N3). */
export const TASK_INPUT_DIAGNOSTICS: InputFlagDiagnostics = {
  unknownFlag: (name, declared) => {
    const available = declared.map((n) => `--${n}`).join(", ");
    return new UsageError(
      `Unknown task input "--${name}". Input flags must exactly match a declared task input.`,
      "UNKNOWN_FLAG",
      available ? `Declared inputs: ${available}.` : "This task declares no inputs.",
    );
  },
  invalidValue: (name, detail) => invalidTaskInput(name, detail),
  contractViolation: (errors) =>
    new UsageError(
      `Task input flags do not satisfy the task's declared input schemas:\n${errors
        .map((error) => `  - ${error.replace(/^\$/, "inputs")}`)
        .join("\n")}`,
      "INPUT_BINDING_INVALID",
    ),
  duplicateNonArray: (name) => invalidTaskInput(name, "was provided more than once but is not declared as an array"),
  malformedJson: (name) => invalidTaskInput(name, "must contain valid JSON"),
};
