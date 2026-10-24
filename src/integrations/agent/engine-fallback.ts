// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Implicit `opencode-sdk` engine fallback.
 *
 * The default engine is chosen from an ordered list: `defaults.engine`, then
 * `opencode-sdk`, the OpenCode bundled with akm. The fallback carries no model,
 * endpoint, credential, or `llmEngine`, and an SDK engine gets an LLM connection
 * only from its own `llmEngine` (`defaults.llmEngine` never reaches it), so
 * OpenCode resolves provider, model, and auth from its own configuration. Resolution is by NAME only: a task or workflow that
 * explicitly names an unconfigured engine is an error and is never rescued
 * here. `setup/*` does not apply it, because setup's job is to detect engines
 * and write `defaults.engine`.
 */

import type { AkmConfig, EngineConfig } from "../../core/config/config";

/** Engine name used for the synthesized entry; matches the platform id. */
export const FALLBACK_ENGINE_NAME = "opencode-sdk";

/** Announcement text, surfaced once per run/dispatch. */
export const FALLBACK_ANNOUNCEMENT =
  `No engine is configured; using \`${FALLBACK_ENGINE_NAME}\`, the OpenCode bundled with akm. ` +
  "Provider, model, and auth come from OpenCode's own configuration. " +
  "Run `akm setup`, or set `defaults.engine`, to choose explicitly.";

export interface EngineFallbackResult {
  /** Config to resolve against — the input verbatim unless the fallback applied. */
  config: AkmConfig;
  /**
   * Name of the engine the fallback installed as `defaults.engine`, when it
   * applied. A candidate, not a decision: a nearer `engine:` still wins, so
   * callers announce only after observing that the engine they selected is
   * this one — see {@link fallbackAnnouncement}.
   */
  fallbackEngineName?: string;
}

/** The fallback engine: an operator-configured `opencode-sdk` entry, else a bare one. It needs no binary. */
export function fallbackEngineConfig(config: AkmConfig): EngineConfig {
  return config.engines?.[FALLBACK_ENGINE_NAME] ?? { kind: "agent", platform: "opencode-sdk" };
}

/**
 * For diagnostics that report the effective engine: a config whose
 * `defaults.engine` resolves, with the implicit `opencode-sdk` fallback when it
 * does not. Never mutates `config`; returns the same object when no fallback is
 * needed.
 */
export function withEngineFallback(config: AkmConfig): EngineFallbackResult {
  if (config.defaults?.engine) return { config };
  return {
    config: {
      ...config,
      engines: { ...(config.engines ?? {}), [FALLBACK_ENGINE_NAME]: fallbackEngineConfig(config) },
      defaults: { ...(config.defaults ?? {}), engine: FALLBACK_ENGINE_NAME },
    } as AkmConfig,
    fallbackEngineName: FALLBACK_ENGINE_NAME,
  };
}

/** The announcement, but only when the fallback candidate is the engine that actually won selection. */
export function fallbackAnnouncement(
  fallbackEngineName: string | undefined,
  selectedEngineName: string | undefined,
): string | undefined {
  if (!fallbackEngineName || selectedEngineName !== fallbackEngineName) return undefined;
  return FALLBACK_ANNOUNCEMENT;
}
