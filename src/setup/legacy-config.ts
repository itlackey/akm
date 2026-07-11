// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Setup conversion helpers. The prompt steps return connection details, while
 * the persisted configuration always uses named engines.
 */

import type { AkmConfig, LlmConnectionConfig } from "../core/config/config";
import { getDefaultLlmConfig } from "../core/config/config";

/**
 * Snapshot used by the prompt UI before it is lowered into named engines.
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

/** Read the default agent engine for prompt UI display. */
export function getCurrentAgentBlock(config: AkmConfig): LegacyAgentBlockShape | undefined {
  if (!config.engines || !config.defaults?.engine) return undefined;
  const block: LegacyAgentBlockShape = {};
  const defaultEngine = config.engines[config.defaults.engine];
  if (defaultEngine?.kind === "agent") block.default = config.defaults.engine;
  if (config.engines) {
    const profiles: NonNullable<LegacyAgentBlockShape["profiles"]> = {};
    for (const [name, raw] of Object.entries(config.engines)) {
      if (raw.kind !== "agent") continue;
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

/** Apply an LLM connection as the deterministic `default` engine. */
export function applyLegacyLlm(config: AkmConfig, llm: LlmConnectionConfig | undefined): Partial<AkmConfig> {
  const name = config.defaults?.llmEngine ?? "default";
  if (!llm) {
    const remaining = { ...(config.engines ?? {}) };
    delete remaining[name];
    return {
      engines: remaining,
      defaults: { ...(config.defaults ?? {}), llmEngine: undefined },
    };
  }
  const endpoint = llm.endpoint.endsWith("/chat/completions")
    ? llm.endpoint
    : `${llm.endpoint.replace(/\/$/, "")}/chat/completions`;
  return {
    engines: { ...(config.engines ?? {}), [name]: { ...llm, kind: "llm", endpoint } },
    defaults: { ...(config.defaults ?? {}), llmEngine: name },
  };
}

/** Apply prompt UI agent choices as platform-selected engines. */
export function applyLegacyAgent(config: AkmConfig, agent: LegacyAgentBlockShape | undefined): Partial<AkmConfig> {
  if (!agent) {
    return {
      defaults: { ...(config.defaults ?? {}), engine: undefined },
    };
  }
  const engines = { ...(config.engines ?? {}) };
  for (const [name, profile] of Object.entries(agent.profiles ?? {})) {
    const platform = (profile.sdkMode ? "opencode-sdk" : name) as
      | "opencode"
      | "claude"
      | "codex"
      | "gemini"
      | "aider"
      | "copilot"
      | "pi"
      | "amazonq"
      | "openhands"
      | "opencode-sdk";
    engines[name] = {
      kind: "agent",
      platform,
      ...(profile.bin ? { bin: profile.bin } : {}),
      ...(profile.args ? { args: profile.args } : {}),
      ...(profile.model ? { model: profile.model } : {}),
    };
  }
  return {
    engines,
    defaults: { ...(config.defaults ?? {}), ...(agent.default ? { engine: agent.default } : {}) },
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
