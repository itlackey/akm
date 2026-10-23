// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Materialize a unit's frozen environment at dispatch. Env-file values are the
 * one deliberately live input to a frozen plan: freeze records each env ref;
 * the values (and the secrets and paths their `${ref}` tokens name) are read
 * here, per dispatch, through `resolveEnvBinding` — the same machinery `akm env
 * run` uses — and nothing is returned until every read has succeeded.
 */

import { resolveEnvBinding } from "../../commands/env/env-binding";
import type { FrozenWorkflowEnvironmentBinding } from "../plan";

export interface MaterializedFrozenWorkflowEnvironment {
  readonly values: Record<string, string>;
  /** Every value substituted from a `secrets/` ref: the only env values redacted from a dispatch. */
  readonly sensitiveValues: string[];
}

export function materializeFrozenWorkflowEnvironment(
  descriptors: readonly FrozenWorkflowEnvironmentBinding[],
): MaterializedFrozenWorkflowEnvironment {
  const values: Record<string, string> = {};
  const sensitive = new Set<string>();

  for (const descriptor of descriptors) {
    if (descriptor.kind === "literal") {
      values[descriptor.name] = descriptor.value;
      continue;
    }
    // `pass_env` names reach the exec child through its allowlist
    // (`execAllowlist`, exec-unit.ts), not as bindings. Their values are
    // deliberately not redacted, so they are neither read nor marked sensitive here.
    if (descriptor.kind === "pass-through") continue;
    const binding = resolveEnvBinding(descriptor.ref);
    Object.assign(values, binding.values);
    for (const secret of binding.secretValues) sensitive.add(secret);
  }
  return { values, sensitiveValues: [...sensitive] };
}
