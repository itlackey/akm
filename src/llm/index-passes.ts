// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AkmConfig, IndexPassConfig } from "../core/config/config";
import { ConfigError } from "../core/errors";
import { cloneExecutionJsonObject } from "../execution/json";
import type { LoweringNotice } from "../execution/resolved-request";
import type { UnresolvedExecutionDefaults } from "../execution/source";
import { buildExecution, resolveExecution } from "../integrations/agent/execution";
import type { RunnerSpec } from "../integrations/agent/runner";

const NO_LOWERING_NOTICES: readonly Readonly<LoweringNotice>[] = Object.freeze([]);

/** One frozen standalone-index selection, including its safe lowering diagnostics. */
export interface ResolvedIndexPassExecution {
  readonly runner: RunnerSpec | undefined;
  readonly notices: readonly Readonly<LoweringNotice>[];
}

function own(value: object | undefined, key: PropertyKey): boolean {
  return value !== undefined && Object.hasOwn(value, key);
}

/** Adapt one index layer (the index-wide settings, or one pass's) into the shared execution vocabulary. */
function indexExecutionDefaults(layer: Partial<IndexPassConfig> | undefined): UnresolvedExecutionDefaults {
  if (!layer) return {};
  return {
    ...(own(layer, "connection") ? { connection: layer.connection } : {}),
    ...(own(layer, "model") ? { model: layer.model } : {}),
    ...(own(layer, "timeoutMs") ? { timeout: layer.timeoutMs } : {}),
    ...(own(layer, "llm") && layer.llm !== undefined
      ? { inference: cloneExecutionJsonObject(layer.llm, "index pass LLM inference") }
      : {}),
  };
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
      invocationDefaults: indexExecutionDefaults(config.index as Partial<IndexPassConfig> | undefined),
      current: indexExecutionDefaults(pass),
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
