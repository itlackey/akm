// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AkmConfig, IndexPassConfig } from "../core/config/config";
import { warn } from "../core/warn";
import { cloneExecutionJsonObject } from "../execution/json";
import type { LoweringNotice } from "../execution/resolved-request";
import type { UnresolvedExecutionDefaults } from "../execution/source";
import { buildExecution, resolveExecution } from "../integrations/agent/execution";
import type { StructuredLlmRunner } from "./structured-call";

const NO_LOWERING_NOTICES: readonly Readonly<LoweringNotice>[] = Object.freeze([]);

/** One frozen standalone-index selection, including its safe lowering diagnostics. */
export interface ResolvedIndexPassExecution {
  readonly runner: StructuredLlmRunner | undefined;
  readonly notices: readonly Readonly<LoweringNotice>[];
}

function own(value: object | undefined, key: PropertyKey): boolean {
  return value !== undefined && Object.hasOwn(value, key);
}

/** Adapt one index invocation layer into the shared execution vocabulary. */
function indexExecutionDefaults(layer: IndexPassConfig | undefined): UnresolvedExecutionDefaults {
  if (!layer) return {};
  return {
    ...(own(layer, "engine") ? { engine: layer.engine } : {}),
    ...(own(layer, "model") ? { model: layer.model } : {}),
    ...(own(layer, "timeoutMs") ? { timeout: layer.timeoutMs } : {}),
    ...(own(layer, "llm") && layer.llm !== undefined
      ? { inference: cloneExecutionJsonObject(layer.llm, "index pass LLM inference") }
      : {}),
  };
}

/**
 * Resolve standalone index passes from the index section only. Improve
 * strategies own improve-triggered calls and are intentionally not consulted.
 */
export function resolveIndexPassExecution(passName: string, config: AkmConfig): ResolvedIndexPassExecution {
  const pass = config.index?.[passName] as IndexPassConfig | undefined;
  if (pass?.enabled === false) return Object.freeze({ runner: undefined, notices: NO_LOWERING_NOTICES });
  const defaults = config.index?.defaults as IndexPassConfig | undefined;
  const fallbackLlmEngine = config.defaults?.llmEngine;
  const selectedEngine = pass?.engine ?? defaults?.engine ?? fallbackLlmEngine;
  if (!selectedEngine) return Object.freeze({ runner: undefined, notices: NO_LOWERING_NOTICES });

  const invocationDefaults = {
    ...indexExecutionDefaults(defaults),
    ...(!own(defaults, "engine") && fallbackLlmEngine ? { engine: fallbackLlmEngine } : {}),
  } satisfies UnresolvedExecutionDefaults;
  const prepared = resolveExecution({
    content: "",
    config,
    invocationDefaults,
    current: indexExecutionDefaults(pass),
  });
  const lowered = buildExecution(prepared.request, prepared.runner);
  if (lowered.runner.kind !== "llm") {
    warn("[akm] Index pass %s requires an LLM engine; %s is not one. Skipping this pass.", passName, selectedEngine);
    return Object.freeze({ runner: undefined, notices: NO_LOWERING_NOTICES });
  }
  return Object.freeze({ runner: lowered.runner, notices: lowered.notices });
}
