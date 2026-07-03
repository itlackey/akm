// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * 0.8.0 config-shape adapters for the setup wizard.
 *
 * The wizard's internal logic uses the legacy mental model of a single
 * top-level `llm` + `agent` block; these helpers translate to and from the
 * new `profiles.*` + `defaults.*` config shape.
 */

import type { AkmConfig, LlmConnectionConfig } from "../core/config/config";
import { getDefaultLlmConfig } from "../core/config/config";
import { warn } from "../core/warn";
import { v1ProfilePlatform } from "../integrations/harnesses";

/**
 * Snapshot used by the setup wizard's internal logic — the legacy mental
 * model of a single top-level `llm` + `agent` block. Translated to the new
 * `profiles.*` + `defaults.*` shape when written via {@link applyLegacyLlm}
 * and {@link applyLegacyAgent}.
 */
export interface LegacyAgentBlockShape {
  default?: string;
  timeoutMs?: number;
  profiles?: Record<
    string,
    { sdkMode?: boolean; model?: string; endpoint?: string; apiKey?: string; bin?: string; args?: string[] }
  >;
}

/** Read the currently-configured LLM connection from a loaded config. */
export function getCurrentLlm(config: AkmConfig): LlmConnectionConfig | undefined {
  return getDefaultLlmConfig(config);
}

/** Read a synthesised legacy-shape agent block from the new-shape AkmConfig. */
export function getCurrentAgentBlock(config: AkmConfig): LegacyAgentBlockShape | undefined {
  if (!config.profiles?.agent && !config.defaults?.agent) return undefined;
  const block: LegacyAgentBlockShape = {};
  if (config.defaults?.agent) block.default = config.defaults.agent;
  if (config.profiles?.agent) {
    const profiles: NonNullable<LegacyAgentBlockShape["profiles"]> = {};
    for (const [name, raw] of Object.entries(config.profiles.agent)) {
      profiles[name] = {
        ...(raw.platform === "opencode-sdk" ? { sdkMode: true } : {}),
        ...(raw.model ? { model: raw.model } : {}),
        ...(raw.bin ? { bin: raw.bin } : {}),
        ...(raw.args ? { args: raw.args } : {}),
      };
    }
    block.profiles = profiles;
  }
  return block;
}

/** Apply an LLM connection patch onto the new-shape config. */
export function applyLegacyLlm(config: AkmConfig, llm: LlmConnectionConfig | undefined): Partial<AkmConfig> {
  if (!llm) {
    // Clear the default LLM profile.
    const name = config.defaults?.llm ?? "default";
    const remaining = { ...(config.profiles?.llm ?? {}) };
    delete remaining[name];
    return {
      profiles: { ...(config.profiles ?? {}), llm: remaining },
      defaults: { ...(config.defaults ?? {}), llm: undefined },
    };
  }
  const name = config.defaults?.llm ?? "default";
  return {
    profiles: {
      ...(config.profiles ?? {}),
      llm: { ...(config.profiles?.llm ?? {}), [name]: llm },
    },
    defaults: { ...(config.defaults ?? {}), llm: name },
  };
}

/** Apply a legacy-shape agent block onto the new-shape config. */
export function applyLegacyAgent(config: AkmConfig, agent: LegacyAgentBlockShape | undefined): Partial<AkmConfig> {
  if (!agent) {
    return {
      profiles: { ...(config.profiles ?? {}), agent: undefined },
      defaults: { ...(config.defaults ?? {}), agent: undefined },
    };
  }
  const v2Profiles: NonNullable<AkmConfig["profiles"]>["agent"] = { ...(config.profiles?.agent ?? {}) };
  for (const [name, profile] of Object.entries(agent.profiles ?? {})) {
    // #566: resolve the platform via the harness registry instead of the old
    // `name.includes("claude") ? "claude" : "opencode"` heuristic, which
    // silently mapped Cursor/Copilot/any new harness to "opencode". An explicit
    // sdkMode flag still wins; otherwise we ask the registry. A name the
    // registry does not recognize is surfaced (warn) rather than silently
    // misclassified, then kept as a best-effort "opencode" profile so the user
    // does not lose a profile they explicitly configured.
    let platform: "opencode" | "claude" | "opencode-sdk";
    if (profile.sdkMode) {
      platform = "opencode-sdk";
    } else {
      const resolved = v1ProfilePlatform(name) as "opencode" | "claude" | "opencode-sdk" | undefined;
      if (resolved) {
        platform = resolved;
      } else {
        warn(
          `[akm setup] Agent profile "${name}" did not match any known harness; ` +
            `defaulting its platform to "opencode". Set its platform explicitly in config if this is wrong.`,
        );
        platform = "opencode";
      }
    }
    v2Profiles[name] = {
      platform,
      ...(profile.bin ? { bin: profile.bin } : {}),
      ...(profile.args ? { args: profile.args } : {}),
      ...(profile.model ? { model: profile.model } : {}),
    };
  }
  return {
    profiles: { ...(config.profiles ?? {}), agent: v2Profiles },
    defaults: { ...(config.defaults ?? {}), agent: agent.default },
  };
}

/** Deep-ish clone of an LLM connection config (capabilities + extraParams). */
export function cloneLlmConfig(llm?: LlmConnectionConfig): LlmConnectionConfig | undefined {
  if (!llm) return undefined;
  return {
    ...llm,
    ...(llm.capabilities ? { capabilities: { ...llm.capabilities } } : {}),
    ...(llm.extraParams ? { extraParams: { ...llm.extraParams } } : {}),
  };
}
