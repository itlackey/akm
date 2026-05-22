/**
 * Per-pass LLM config resolution for `akm index`.
 *
 * Locked contract:
 * - There is exactly one provider/model configuration per profile —
 *   `profiles.llm.<name>` — and exactly one default profile name (`defaults.llm`).
 * - Every LLM-using pass inside `akm index` defaults to the default profile.
 * - A pass can be opted out individually with `index.<passName>.llm = false`.
 * - Any attempt to supply provider/model fields under `index.<passName>` is
 *   rejected at config-load time by `parseIndexConfig`.
 *
 * Passes plug in by calling {@link resolveIndexPassLLM} with their pass
 * name (e.g. `"memory"` for the memory-inference pass, `"graph"` for the
 * graph-extraction pass). They do not read connection fields directly.
 */

import type { AkmConfig, IndexPassConfig, LlmConnectionConfig } from "../core/config";
import { getDefaultLlmConfig, getIndexPassConfig } from "../core/config";

/**
 * Resolve the {@link LlmConnectionConfig} a single index pass should use, or
 * `undefined` when the pass should run without an LLM.
 *
 * Returns `undefined` if any of:
 * - No default LLM profile is configured.
 * - The pass is explicitly opted out (`index.<passName>.llm === false`).
 */
export function resolveIndexPassLLM(passName: string, config: AkmConfig): LlmConnectionConfig | undefined {
  const llm = getDefaultLlmConfig(config);
  if (!llm) return undefined;

  const passConfig: IndexPassConfig | undefined = getIndexPassConfig(config.index, passName);
  if (passConfig?.llm === false) return undefined;

  return llm;
}
