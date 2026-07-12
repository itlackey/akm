// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AkmConfig, IndexPassConfig, LlmConnectionConfig } from "../core/config/config";
import { materializeLlmConnection, resolveLlmEngineUse } from "../integrations/agent/engine-resolution";

/**
 * Resolve standalone index passes from the index section only. Improve
 * strategies own improve-triggered calls and are intentionally not consulted.
 */
export function resolveIndexPassLLM(passName: string, config: AkmConfig): LlmConnectionConfig | undefined {
  const pass = config.index?.[passName] as IndexPassConfig | undefined;
  if (pass?.enabled === false) return undefined;
  const defaults = config.index?.defaults;
  const resolved = resolveLlmEngineUse(config, [defaults ?? {}, pass ?? {}], { optional: true });
  return resolved ? materializeLlmConnection(resolved) : undefined;
}
