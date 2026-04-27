/**
 * Parser + resolver for the optional `agent` config block (v1 spec §12).
 *
 * The on-disk shape is:
 *
 * ```jsonc
 * {
 *   "agent": {
 *     "default": "opencode",
 *     "timeoutMs": 60000,
 *     "profiles": {
 *       "opencode": { "bin": "opencode", "args": ["--non-interactive"], ... }
 *     }
 *   }
 * }
 * ```
 *
 * Unknown keys at any level under `agent` are warn-and-ignored — this is the
 * v1 §9.2 contract. Missing `agent` block disables agent commands; callers
 * should reach for {@link requireAgentConfig} to surface a stable
 * `ConfigError` with a hint pointing at setup.
 *
 * No LLM SDK is imported here. The runtime path is shell-out only (see
 * `./spawn.ts`).
 */
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

/** Keys recognised at the top level of an `agent` config block. */
const KNOWN_AGENT_KEYS = new Set(["default", "timeoutMs", "profiles"]);

/** Keys recognised on a profile entry. */
const KNOWN_PROFILE_KEYS = new Set(["bin", "args", "stdio", "env", "envPassthrough", "timeoutMs", "parseOutput"]);

/**
 * Default hard timeout for an agent CLI. Spec §12.2 calls for a hard
 * timeout; 60s matches the example value in `docs/configuration.md`.
 */
export const DEFAULT_AGENT_TIMEOUT_MS = 60_000;

/**
 * Persisted form of `agent.profiles[<name>]`. Every field is optional so
 * users can override one piece of a built-in without re-stating the rest.
 */
export interface AgentProfileConfig {
  bin?: string;
  args?: string[];
  stdio?: AgentStdioMode;
  env?: Record<string, string>;
  envPassthrough?: string[];
  timeoutMs?: number;
  parseOutput?: AgentParseMode;
}

/** Persisted form of the `agent` block. */
export interface AgentConfig {
  default?: string;
  timeoutMs?: number;
  profiles?: Record<string, AgentProfileConfig>;
}

/**
 * Parse a raw value (typically `rawConfig.agent` from `JSON.parse`) into a
 * normalised {@link AgentConfig}. Returns `undefined` when the value is not
 * an object (i.e. the block is absent or malformed at the root level — for
 * malformed roots we emit a warning).
 *
 * Unknown keys (top-level and per-profile) are warn-and-ignore. Type errors
 * on individual fields are warn-and-ignore so a bad `timeoutMs` does not
 * break the rest of the block.
 */
export function parseAgentConfig(value: unknown): AgentConfig | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    warn('[akm] Ignoring "agent" config: expected an object.');
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const out: AgentConfig = {};

  for (const key of Object.keys(raw)) {
    if (!KNOWN_AGENT_KEYS.has(key)) {
      warn(`[akm] Ignoring unknown agent config key: "${key}"`);
    }
  }

  if ("default" in raw) {
    if (typeof raw.default === "string" && raw.default.trim()) {
      out.default = raw.default.trim();
    } else if (raw.default !== undefined) {
      warn("[akm] Ignoring agent.default: expected a non-empty string.");
    }
  }

  if ("timeoutMs" in raw) {
    if (
      typeof raw.timeoutMs === "number" &&
      Number.isFinite(raw.timeoutMs) &&
      Number.isInteger(raw.timeoutMs) &&
      raw.timeoutMs > 0
    ) {
      out.timeoutMs = raw.timeoutMs;
    } else {
      warn("[akm] Ignoring agent.timeoutMs: expected a positive integer (milliseconds).");
    }
  }

  if ("profiles" in raw) {
    const profiles = parseAgentProfilesMap(raw.profiles);
    if (profiles) out.profiles = profiles;
  }

  return out;
}

function parseAgentProfilesMap(value: unknown): Record<string, AgentProfileConfig> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    warn("[akm] Ignoring agent.profiles: expected an object.");
    return undefined;
  }
  const out: Record<string, AgentProfileConfig> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    const parsed = parseAgentProfileConfig(name, raw);
    if (parsed) out[name] = parsed;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseAgentProfileConfig(name: string, value: unknown): AgentProfileConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    warn(`[akm] Ignoring agent.profiles."${name}": expected an object.`);
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const out: AgentProfileConfig = {};

  for (const key of Object.keys(raw)) {
    if (!KNOWN_PROFILE_KEYS.has(key)) {
      warn(`[akm] Ignoring unknown agent.profiles."${name}" key: "${key}"`);
    }
  }

  if (typeof raw.bin === "string" && raw.bin.trim()) {
    out.bin = raw.bin.trim();
  } else if (raw.bin !== undefined) {
    warn(`[akm] Ignoring agent.profiles."${name}".bin: expected a non-empty string.`);
  }

  if (Array.isArray(raw.args)) {
    const args = raw.args.filter((a): a is string => typeof a === "string");
    if (args.length === raw.args.length) {
      out.args = args;
    } else {
      warn(`[akm] Ignoring non-string entries in agent.profiles."${name}".args.`);
      if (args.length > 0) out.args = args;
    }
  } else if (raw.args !== undefined) {
    warn(`[akm] Ignoring agent.profiles."${name}".args: expected an array of strings.`);
  }

  if (raw.stdio === "captured" || raw.stdio === "interactive") {
    out.stdio = raw.stdio;
  } else if (raw.stdio !== undefined) {
    warn(`[akm] Ignoring agent.profiles."${name}".stdio: expected "captured" or "interactive".`);
  }

  if (typeof raw.env === "object" && raw.env !== null && !Array.isArray(raw.env)) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.env)) {
      if (typeof v === "string") env[k] = v;
    }
    if (Object.keys(env).length > 0) out.env = env;
  } else if (raw.env !== undefined) {
    warn(`[akm] Ignoring agent.profiles."${name}".env: expected a string-valued object.`);
  }

  if (Array.isArray(raw.envPassthrough)) {
    const list = raw.envPassthrough.filter((s): s is string => typeof s === "string" && s.length > 0);
    if (list.length > 0) out.envPassthrough = list;
  } else if (raw.envPassthrough !== undefined) {
    warn(`[akm] Ignoring agent.profiles."${name}".envPassthrough: expected an array of strings.`);
  }

  if (
    typeof raw.timeoutMs === "number" &&
    Number.isFinite(raw.timeoutMs) &&
    Number.isInteger(raw.timeoutMs) &&
    raw.timeoutMs > 0
  ) {
    out.timeoutMs = raw.timeoutMs;
  } else if (raw.timeoutMs !== undefined) {
    warn(`[akm] Ignoring agent.profiles."${name}".timeoutMs: expected a positive integer.`);
  }

  if (raw.parseOutput === "text" || raw.parseOutput === "json") {
    out.parseOutput = raw.parseOutput;
  } else if (raw.parseOutput !== undefined) {
    warn(`[akm] Ignoring agent.profiles."${name}".parseOutput: expected "text" or "json".`);
  }

  return out;
}

/**
 * Merge a user override (from `agent.profiles[<name>]`) on top of the
 * built-in profile (if any) and return the resolved profile. If `name`
 * matches no built-in and the user override has no `bin`, returns
 * `undefined` — the profile is unusable.
 *
 * Used at the spawn site, never at config-load time. Keeping merge logic
 * here means the parser stays a pure shape-checker.
 */
export function resolveAgentProfile(name: string, overrides?: AgentProfileConfig): AgentProfile | undefined {
  const builtin = getBuiltinAgentProfile(name);
  if (!builtin && !overrides?.bin) return undefined;

  const base: AgentProfile =
    builtin ??
    ({
      name,
      bin: overrides?.bin ?? name,
      args: [],
      stdio: "captured",
      envPassthrough: [],
      parseOutput: "text",
    } as AgentProfile);

  if (!overrides) return base;

  const merged: AgentProfile = {
    name,
    bin: overrides.bin ?? base.bin,
    args: overrides.args ?? base.args,
    stdio: overrides.stdio ?? base.stdio,
    env: overrides.env ?? base.env,
    envPassthrough: overrides.envPassthrough
      ? mergePassthrough(base.envPassthrough, overrides.envPassthrough)
      : base.envPassthrough,
    timeoutMs: overrides.timeoutMs ?? base.timeoutMs,
    parseOutput: overrides.parseOutput ?? base.parseOutput,
  };
  return merged;
}

function mergePassthrough(base: readonly string[], extra: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of [...base, ...extra]) {
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

/**
 * Resolve the runnable profile for `name`, or `undefined` if none is
 * available (no built-in and no user override with a `bin`).
 */
export function resolveProfileFromConfig(name: string, agent?: AgentConfig): AgentProfile | undefined {
  return resolveAgentProfile(name, agent?.profiles?.[name]);
}

/**
 * Return the names of every profile available in `agent` config (built-in
 * names plus any user-defined ones). Sorted, deduplicated.
 */
export function listAgentProfileNames(agent?: AgentConfig): string[] {
  const seen = new Set<string>(BUILTIN_AGENT_PROFILE_NAMES);
  for (const name of Object.keys(agent?.profiles ?? {})) seen.add(name);
  return [...seen].sort();
}

/**
 * Resolve the default profile name. Order: explicit `name` arg → config
 * `agent.default` → undefined.
 */
export function resolveDefaultProfileName(agent: AgentConfig | undefined, requested?: string): string | undefined {
  if (requested?.trim()) return requested.trim();
  if (agent?.default?.trim()) return agent.default.trim();
  return undefined;
}

/**
 * Throw a {@link ConfigError} with a stable hint when the caller needs
 * `agent` config but it is missing or unresolvable.
 *
 * Covers two cases per acceptance criteria:
 *
 * 1. The `agent` block is absent — agent commands are disabled.
 * 2. The block exists but no usable profile (no `default`, no requested
 *    name, or the named profile cannot be resolved).
 *
 * Use as `const profile = requireAgentProfile(config.agent, requestedName)`.
 */
export function requireAgentProfile(agent: AgentConfig | undefined, requested?: string): AgentProfile {
  if (!agent) {
    throw new ConfigError(
      "agent commands are disabled: no `agent` block in config.json.",
      "INVALID_CONFIG_FILE",
      'Run `akm setup` to detect and configure an agent CLI, or add an `agent` block manually (see docs/configuration.md "agent.*").',
    );
  }

  const name = resolveDefaultProfileName(agent, requested);
  if (!name) {
    throw new ConfigError(
      "agent commands require a profile: pass --profile or set `agent.default` in config.json.",
      "INVALID_CONFIG_FILE",
      `Available profiles: ${listAgentProfileNames(agent).join(", ")}.`,
    );
  }

  const profile = resolveProfileFromConfig(name, agent);
  if (!profile) {
    throw new ConfigError(
      `agent profile "${name}" is not built-in and has no \`bin\` override.`,
      "INVALID_CONFIG_FILE",
      `Define agent.profiles."${name}".bin in config.json, or pick one of: ${listAgentProfileNames(agent).join(", ")}.`,
    );
  }
  return profile;
}

/**
 * Convenience: list every fully-resolved profile (built-ins merged with
 * any user overrides). Used by setup detection to enumerate candidates.
 */
export function listResolvedAgentProfiles(agent?: AgentConfig): AgentProfile[] {
  const resolved: AgentProfile[] = [];
  const builtins = listBuiltinAgentProfiles();
  for (const name of listAgentProfileNames(agent)) {
    const profile = resolveProfileFromConfig(name, agent) ?? builtins[name];
    if (profile) resolved.push(profile);
  }
  return resolved;
}
