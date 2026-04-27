/**
 * Per-pass LLM config resolution for `akm index`.
 *
 * Locked v1 contract (#208):
 * - There is exactly one provider/model configuration: `akm.llm`.
 * - Every LLM-using pass inside `akm index` defaults to that block.
 * - A pass can be opted out individually with `index.<passName>.llm = false`.
 * - Any attempt to supply provider/model fields under `index.<passName>` is
 *   rejected at config-load time by `parseIndexConfig` in
 *   {@link ../core/config.ts} (`ConfigError("INVALID_CONFIG_FILE")`).
 *
 * New passes (e.g. memory inference, graph extraction — issues #201, #207)
 * plug in by calling {@link resolveIndexPassLLM} with their pass name. They
 * do not read `config.llm` directly. This keeps the config surface small
 * and the wiring uniform.
 */

import type { AkmConfig, LlmConnectionConfig } from "../core/config";

/**
 * Resolve the {@link LlmConnectionConfig} a single index pass should use, or
 * `undefined` when the pass should run without an LLM.
 *
 * Returns `undefined` if any of:
 * - No top-level `akm.llm` block is configured.
 * - The pass is explicitly opted out (`index.<passName>.llm === false`).
 *
 * Otherwise returns the shared `akm.llm` config. There is no per-pass
 * provider override; that decision is locked by §9 of the v1 spec.
 */
export function resolveIndexPassLLM(passName: string, config: AkmConfig): LlmConnectionConfig | undefined {
  if (!config.llm) return undefined;

  const passConfig = config.index?.[passName];
  if (passConfig?.llm === false) return undefined;

  return config.llm;
}
