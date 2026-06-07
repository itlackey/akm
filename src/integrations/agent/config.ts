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
import type { AgentProfileConfigV2, AkmConfig } from "../../core/config/config";
import { ConfigError } from "../../core/errors";
import { warn } from "../../core/warn";
import {
  type AgentParseMode,
  type AgentProfile,
  type AgentStdioMode,
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
 * Persisted form of `profiles.agent[<name>]` after the 0.8.0 migration.
 * Every field is optional so users can override one piece of a built-in
 * without re-stating the rest.
 */
export interface AgentProfileConfig {
  bin?: string;
  args?: string[];
  stdio?: AgentStdioMode;
  env?: Record<string, string>;
  envPassthrough?: string[];
  timeoutMs?: number;
  parseOutput?: AgentParseMode;
  /** Model to use when the platform is opencode-sdk. */
  model?: string;
  /** OpenAI-compatible endpoint when platform is opencode-sdk. */
  endpoint?: string;
  /** API key when platform is opencode-sdk. */
  apiKey?: string;
  /** Override which builder handles argv construction for this profile. */
  commandBuilder?: string;
  /** User-defined model aliases for this platform. Keys are lowercase alias strings. */
  modelAliases?: Record<string, string>;
}

/**
 * Backwards-compatible alias type. After 0.8.0, the "agent config" lives on
 * the loaded {@link AkmConfig} — there is no separate top-level `agent` block.
 * This type alias keeps the call-site API stable.
 */
export type AgentConfig = AkmConfig;

/**
 * Resolve the effective `AgentProfile` for `name` by merging the optional
 * user override (`profiles.agent[name]`) on top of the built-in profile (if
 * any). Returns `undefined` when neither yields a usable profile.
 */
export function resolveAgentProfile(name: string, overrides?: AgentProfileConfigV2): AgentProfile | undefined {
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
    timeoutMs: base.timeoutMs,
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

/**
 * Parse the v2 `profiles.agent` map (AgentProfileConfigV2 shape with required
 * `platform` field). Returns a map of profile name → AgentProfileConfigV2.
 */
export function parseAgentProfilesMapV2(value: unknown): Record<string, AgentProfileConfigV2> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, AgentProfileConfigV2> = {};
  const VALID_PLATFORMS = ["opencode", "claude", "opencode-sdk"] as const;
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      warn(`[akm] Ignoring profiles.agent["${name}"]: expected an object.`);
      continue;
    }
    const obj = raw as Record<string, unknown>;
    if (!VALID_PLATFORMS.includes(obj.platform as (typeof VALID_PLATFORMS)[number])) {
      warn(
        `[akm] Ignoring profiles.agent["${name}"]: missing or invalid "platform" (must be one of: ${VALID_PLATFORMS.join(", ")}).`,
      );
      continue;
    }
    const profile: AgentProfileConfigV2 = {
      platform: obj.platform as (typeof VALID_PLATFORMS)[number],
    };
    if (typeof obj.bin === "string" && obj.bin.trim()) profile.bin = obj.bin.trim();
    if (Array.isArray(obj.args) && obj.args.every((a) => typeof a === "string")) {
      profile.args = obj.args as string[];
    }
    if (typeof obj.workspace === "string" && obj.workspace.trim()) profile.workspace = obj.workspace.trim();
    if (typeof obj.model === "string" && obj.model.trim()) profile.model = obj.model.trim();
    out[name] = profile;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Stub kept for source-compat with callers that previously used the v1 agent
 * config parser. After 0.8.0 there is no separate `agent` block to parse — the
 * loaded `AkmConfig` already carries the agent data on `profiles.agent` and
 * `defaults.agent`. This function is a no-op alias for those callers.
 *
 * @deprecated v0.8.0 — the unified `AkmConfig` IS the agent config. Use the
 * profile/defaults accessors above instead.
 */
export function parseAgentConfig(_value: unknown): AgentConfig | undefined {
  // No-op: there is no separate agent block in 0.8.0. Callers should pass
  // their loaded `AkmConfig` directly to `requireAgentProfile` etc.
  return undefined;
}
