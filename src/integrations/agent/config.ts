// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Agent profile resolution for the 0.8.0 config shape.
 *
 * In 0.8.0 the legacy `agent` top-level config block was removed and replaced
 * with the unified `profiles.agent` map + `defaults.agent` name. This module
 * preserves the call-site API (`requireAgentProfile`, `resolveProcessAgentProfile`,
 * `listAgentProfileNames`, etc.) but reads exclusively from the new locations.
 *
 * No LLM SDK is imported here. The runtime path is shell-out only (see
 * `./spawn.ts`).
 */
import type { AgentProfileConfig, AkmConfig } from "../../core/config/config";
import { ConfigError } from "../../core/errors";
import {
  type AgentProfile,
  BUILTIN_AGENT_PROFILE_NAMES,
  getBuiltinAgentProfile,
  listBuiltinAgentProfiles,
} from "./profiles";

/**
 * Default hard timeout for an agent CLI (60s — matches the value used in
 * `docs/configuration.md`).
 */
export const DEFAULT_AGENT_TIMEOUT_MS = 60_000;

/**
 * Resolve the effective `AgentProfile` for `name` by merging the optional
 * user override (`profiles.agent[name]`) on top of the built-in profile (if
 * any). Returns `undefined` when neither yields a usable profile.
 */
export function resolveAgentProfile(name: string, overrides?: AgentProfileConfig): AgentProfile | undefined {
  const builtin = getBuiltinAgentProfile(name);
  const platform = overrides?.platform;
  // For opencode-sdk profiles, allow synthesizing without a built-in.
  const sdkMode = platform === "opencode-sdk";
  if (!builtin && !overrides?.bin && !sdkMode) return undefined;

  const base: AgentProfile =
    builtin ??
    ({
      name,
      bin: overrides?.bin ?? name,
      args: [],
      stdio: "captured",
      envPassthrough: [],
      parseOutput: "text",
      ...(sdkMode ? { sdkMode: true } : {}),
    } as AgentProfile);

  if (!overrides) return base;

  return {
    name,
    bin: overrides.bin ?? base.bin,
    args: overrides.args ?? base.args,
    stdio: base.stdio,
    env: base.env,
    envPassthrough: base.envPassthrough,
    // Honor a user-configured `profiles.agent.<name>.timeoutMs` override; fall
    // back to the built-in profile's value. (Previously always used base, so
    // the documented config override was silently ignored — callers had to pass
    // a CLI flag like `--timeout-ms`.) runAgent (spawn.ts) reads profile.timeoutMs
    // when no per-call timeout is supplied, so this makes the config knob work.
    timeoutMs: overrides.timeoutMs ?? base.timeoutMs,
    parseOutput: base.parseOutput,
    ...(sdkMode ? { sdkMode: true } : {}),
    model: overrides.model ?? base.model,
    endpoint: base.endpoint,
    apiKey: base.apiKey,
    commandBuilder: base.commandBuilder,
    modelAliases: base.modelAliases,
  };
}

/**
 * Resolve the runnable profile for `name`, or `undefined` if none is
 * available (no built-in and no user override).
 */
export function resolveProfileFromConfig(name: string, config?: AkmConfig): AgentProfile | undefined {
  return resolveAgentProfile(name, config?.profiles?.agent?.[name]);
}

/**
 * Return the names of every agent profile available in `config` — built-ins
 * plus any user-defined entries under `profiles.agent`. Sorted, deduplicated.
 */
export function listAgentProfileNames(config?: AkmConfig): string[] {
  const seen = new Set<string>(BUILTIN_AGENT_PROFILE_NAMES);
  for (const name of Object.keys(config?.profiles?.agent ?? {})) seen.add(name);
  return [...seen].sort();
}

/**
 * Resolve the default agent profile name. Order: explicit `requested` arg →
 * `config.defaults.agent` → undefined.
 */
export function resolveDefaultProfileName(config: AkmConfig | undefined, requested?: string): string | undefined {
  if (requested?.trim()) return requested.trim();
  const def = config?.defaults?.agent;
  if (typeof def === "string" && def.trim()) return def.trim();
  return undefined;
}

/**
 * Throw a stable `ConfigError` when the caller needs an agent profile but
 * none can be resolved.
 */
export function requireAgentProfile(config: AkmConfig | undefined, requested?: string): AgentProfile {
  if (!config) {
    throw new ConfigError(
      "agent commands are disabled: no agent configuration in config.json.",
      "INVALID_CONFIG_FILE",
      "Run `akm setup` to detect and configure an agent CLI, or add an entry under `profiles.agent` and set `defaults.agent`.",
    );
  }
  const name = resolveDefaultProfileName(config, requested);
  if (!name) {
    throw new ConfigError(
      "agent commands require a profile: pass --profile or set `defaults.agent` in config.json.",
      "INVALID_CONFIG_FILE",
      `Available profiles: ${listAgentProfileNames(config).join(", ")}.`,
    );
  }
  const profile = resolveProfileFromConfig(name, config);
  if (!profile) {
    throw new ConfigError(
      `agent profile "${name}" is not built-in and has no \`bin\` override.`,
      "INVALID_CONFIG_FILE",
      `Define profiles.agent."${name}".bin in config.json, or pick one of: ${listAgentProfileNames(config).join(", ")}.`,
    );
  }
  return profile;
}

/**
 * Resolve the agent profile bound to a named improve process. Reads from
 * `profiles.improve.default.processes.<processName>` for the profile binding,
 * then falls back to `defaults.agent`.
 */
export function resolveProcessAgentProfile(
  processName: string,
  config: AkmConfig | undefined,
): { profile: AgentProfile; timeoutMs: number | null | undefined } {
  const processEntry = config?.profiles?.improve?.default?.processes as
    | Record<string, { profile?: string; timeoutMs?: number | null } | undefined>
    | undefined;
  const entry = processEntry?.[processName];
  const profileName = entry?.profile;
  const profile = requireAgentProfile(config, profileName);
  let resolvedTimeoutMs: number | null | undefined;
  if (entry?.timeoutMs === null) {
    resolvedTimeoutMs = null;
  } else if (typeof entry?.timeoutMs === "number") {
    resolvedTimeoutMs = entry.timeoutMs;
  } else if (profile.timeoutMs !== undefined) {
    resolvedTimeoutMs = profile.timeoutMs;
  }
  return { profile, timeoutMs: resolvedTimeoutMs };
}

/**
 * Convenience: list every fully-resolved profile (built-ins merged with
 * user overrides). Used by setup detection to enumerate candidates.
 */
export function listResolvedAgentProfiles(config?: AkmConfig): AgentProfile[] {
  const resolved: AgentProfile[] = [];
  const builtins = listBuiltinAgentProfiles();
  for (const name of listAgentProfileNames(config)) {
    const profile = resolveProfileFromConfig(name, config) ?? builtins[name];
    if (profile) resolved.push(profile);
  }
  return resolved;
}
