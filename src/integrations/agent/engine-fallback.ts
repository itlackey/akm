// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Implicit `opencode-sdk` engine fallback.
 *
 * The default engine is chosen from an ordered list: `defaults.engine`, then
 * `opencode-sdk` when the `opencode` binary is on PATH. The fallback carries no
 * model, endpoint, or credential, so `opencode serve` resolves provider, model,
 * and auth from opencode's own configuration. Resolution is by NAME only: a
 * task or workflow that explicitly names an unconfigured engine is an error and
 * is never rescued here. `setup/*` does not apply it, because setup's job is to
 * detect engines and write `defaults.engine`.
 */

import type { AkmConfig, EngineConfig } from "../../core/config/config";
import { defaultWhich, type WhichFn } from "./detect";
import { OPENCODE_SDK_SERVER_BIN } from "./profiles";

/** Engine name used for the synthesized entry; matches the platform id. */
export const FALLBACK_ENGINE_NAME = "opencode-sdk";

/** Announcement text, surfaced once per run/dispatch. */
export const FALLBACK_ANNOUNCEMENT =
  `No engine is configured; falling back to \`${FALLBACK_ENGINE_NAME}\` via the ` +
  `\`${OPENCODE_SDK_SERVER_BIN}\` binary on PATH — provider, model, and auth come ` +
  "from opencode's own configuration. " +
  "Run `akm setup`, or set `defaults.engine`, to choose explicitly.";

/** Failure suffix for every surface that needs an engine and found none. */
export const NO_ENGINE_MESSAGE_SUFFIX = `has no selected engine, and no usable \`${OPENCODE_SDK_SERVER_BIN}\` binary was found to fall back to.`;

/** Guidance used when the fallback itself is unavailable. */
export const NO_ENGINE_REMEDY =
  "Run `akm setup` to detect an installed agent, or set one explicitly: " +
  '`akm config set engines.claude \'{"kind":"agent","platform":"claude"}\'` ' +
  "then `akm config set defaults.engine claude`. " +
  `Installing the \`${OPENCODE_SDK_SERVER_BIN}\` binary also works ` +
  "(`npm i -g opencode-ai`) — akm falls back to it automatically.";

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

/**
 * The fallback engine when its `opencode` binary is present: an
 * operator-configured `opencode-sdk` entry (whose pinned `bin`, possibly
 * outside PATH, is what gets probed), else a bare opencode-sdk agent engine.
 */
export function fallbackEngineConfig(config: AkmConfig, whichFn: WhichFn = defaultWhich): EngineConfig | undefined {
  const existing = config.engines?.[FALLBACK_ENGINE_NAME];
  const bin = existing?.kind === "agent" ? existing.bin : undefined;
  if (!whichFn(bin ?? OPENCODE_SDK_SERVER_BIN)) return undefined;
  return existing ?? { kind: "agent", platform: "opencode-sdk" };
}

/**
 * For diagnostics that report the effective engine: a config whose
 * `defaults.engine` resolves, with the implicit `opencode-sdk` fallback when it
 * does not and an opencode binary is present. Never mutates `config`; returns
 * the same object when no fallback is needed.
 */
export function withEngineFallback(config: AkmConfig, whichFn: WhichFn = defaultWhich): EngineFallbackResult {
  if (config.defaults?.engine) return { config };
  const engine = fallbackEngineConfig(config, whichFn);
  if (!engine) return { config };
  return {
    config: {
      ...config,
      engines: { ...(config.engines ?? {}), [FALLBACK_ENGINE_NAME]: engine },
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
