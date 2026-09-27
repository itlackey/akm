// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A child workflow run's idempotency key, derived from the parent unit's input
 * hash: `publishChildWorkflowRun` is idempotent on `(parent_run_id, invocation_key)`.
 */

import { createHash } from "node:crypto";
import { canonicalJson } from "../ir/plan-hash";

export interface ChildInvocationKeyInput {
  readonly parentRunId: string;
  /** The parent unit that spawns the child (the repository API calls it `spawnedByUnitId`). */
  readonly parentUnitId: string;
  /** The `hashVersion` 7 unit input hash of the parent unit that spawns the child. */
  readonly unitInputHash: string;
}

/** `sha256hex("akm.workflow.child-invocation\0v1\0" + canonicalJson({parentRunId, parentUnitId, unitInputHash}))`. */
export function computeChildInvocationKey(input: ChildInvocationKeyInput): string {
  return createHash("sha256")
    .update("akm.workflow.child-invocation\0v1\0")
    .update(
      canonicalJson({
        parentRunId: input.parentRunId,
        parentUnitId: input.parentUnitId,
        unitInputHash: input.unitInputHash,
      }),
    )
    .digest("hex");
}
