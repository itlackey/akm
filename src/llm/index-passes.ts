// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AkmConfig, IndexPassConfig } from "../core/config/config";
import { ConfigError } from "../core/errors";
import type { LoweringNotice } from "../execution/resolved-request";
import { executionDefaultsOf } from "../execution/source";
import { buildExecution, resolveExecution } from "../integrations/agent/execution";
import type { RunnerSpec } from "../integrations/agent/runner";

const NO_LOWERING_NOTICES: readonly Readonly<LoweringNotice>[] = Object.freeze([]);

/** One frozen standalone-index selection, including its safe lowering diagnostics. */
export interface ResolvedIndexPassExecution {
  readonly runner: RunnerSpec | undefined;
  readonly notices: readonly Readonly<LoweringNotice>[];
}

/**
 * Resolve standalone index passes from the index section only (the index-wide
 * settings, then the pass's own). Improve strategies own improve-triggered calls
 * and are intentionally not consulted. No runner when the pass is off or no
 * connection or harness is configured.
 */
export function resolveIndexPassExecution(passName: string, config: AkmConfig): ResolvedIndexPassExecution {
  const pass = config.index?.[passName] as IndexPassConfig | undefined;
  if (pass?.enabled === false) return Object.freeze({ runner: undefined, notices: NO_LOWERING_NOTICES });
  try {
    // Under the model-work tool policy: confined where the harness can be, unrestricted (with a notice) elsewhere.
    const prepared = resolveExecution({
      content: "",
      config,
      layers: [
        {
          id: "index",
          kind: "invocation-defaults",
          values: executionDefaultsOf(config.index as Partial<IndexPassConfig> | undefined),
        },
        { id: `index.${passName}`, kind: "invocation-defaults", values: executionDefaultsOf(pass) },
      ],
      modelWork: true,
    });
    const lowered = buildExecution(prepared.request, prepared.runner);
    return Object.freeze({ runner: lowered.runner, notices: lowered.notices });
  } catch (error) {
    if (error instanceof ConfigError && error.code === "LLM_NOT_CONFIGURED") {
      return Object.freeze({ runner: undefined, notices: NO_LOWERING_NOTICES });
    }
    throw error;
  }
}
