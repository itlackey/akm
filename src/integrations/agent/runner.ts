import type { AkmConfig, ImproveProcessConfig, LlmConnectionConfig, ProcessEntry } from "../../core/config";
import { ConfigError } from "../../core/errors";
import type { AgentProfile } from "./profiles";

export type ProcessSection = "improve" | "index" | "search" | string;

export type RunnerSpec =
  | { kind: "llm"; connection: LlmConnectionConfig; timeoutMs?: number }
  | { kind: "agent"; profile: AgentProfile; timeoutMs?: number }
  | { kind: "sdk"; profile: AgentProfile; timeoutMs?: number };

function normalizeEntry(raw: ProcessEntry | boolean): ProcessEntry & { enabled: boolean } {
  if (typeof raw === "boolean") return { enabled: raw };
  return { enabled: raw.enabled ?? true, ...raw };
}

function resolveEffectiveMode(
  entry: ProcessEntry,
  profileName: string | undefined,
  config: AkmConfig,
): "llm" | "agent" | "sdk" {
  if (entry.mode) return entry.mode;

  // Infer from profile pool when profile is specified
  if (profileName) {
    if (config.profiles?.llm?.[profileName]) return "llm";
    const agentProfile = config.profiles?.agent?.[profileName];
    if (agentProfile) {
      return agentProfile.platform === "opencode-sdk" ? "sdk" : "agent";
    }
  }

  // Fall back to defaults
  if (config.defaults?.llm) return "llm";
  if (config.defaults?.agent) return "agent";

  // Legacy fallback: check old config.llm
  if (config.llm) return "llm";
  if (config.agent) return "agent";

  return "llm";
}

function resolveProfileName(entry: ProcessEntry, mode: "llm" | "agent" | "sdk", config: AkmConfig): string {
  if (entry.profile) return entry.profile;
  if (mode === "llm") {
    const defaultName = config.defaults?.llm;
    if (defaultName) return defaultName;
    throw new ConfigError(
      `No LLM profile configured. Set defaults.llm in config or specify profile in the process entry.`,
      "LLM_NOT_CONFIGURED",
      'Run `akm setup` or `akm config set profiles.llm.default \'{"endpoint":"...","model":"..."}\'` to configure an LLM profile.',
    );
  }
  const defaultName = config.defaults?.agent;
  if (defaultName) return defaultName;
  throw new ConfigError(
    `No agent profile configured. Set defaults.agent in config or specify profile in the process entry.`,
    "INVALID_CONFIG_FILE",
    "Run `akm setup` to configure an agent profile, or add one under profiles.agent in config.",
  );
}

function buildLlmRunnerSpec(profileName: string, timeoutMs: number | null | undefined, config: AkmConfig): RunnerSpec {
  const profile = config.profiles?.llm?.[profileName];
  if (!profile) {
    // Fall back to legacy config.llm
    if (config.llm) {
      return {
        kind: "llm",
        connection: config.llm,
        ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
      };
    }
    throw new ConfigError(
      `LLM profile "${profileName}" not found in profiles.llm.`,
      "LLM_NOT_CONFIGURED",
      `Available profiles: ${Object.keys(config.profiles?.llm ?? {}).join(", ") || "none"}. Run \`akm setup\` to configure.`,
    );
  }
  return {
    kind: "llm",
    connection: profile,
    ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
  };
}

function buildAgentRunnerSpec(
  kind: "agent" | "sdk",
  profileName: string,
  timeoutMs: number | null | undefined,
  config: AkmConfig,
): RunnerSpec {
  const profileConfig = config.profiles?.agent?.[profileName];
  if (!profileConfig) {
    // Fall back to legacy agent config
    if (config.agent) {
      const { resolveProfileFromConfig } = require("./config") as typeof import("./config");
      const legacyProfile = resolveProfileFromConfig(profileName, config.agent);
      if (legacyProfile) {
        return {
          kind,
          profile: legacyProfile,
          ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
        };
      }
    }
    throw new ConfigError(
      `Agent profile "${profileName}" not found in profiles.agent.`,
      "INVALID_CONFIG_FILE",
      `Available profiles: ${Object.keys(config.profiles?.agent ?? {}).join(", ") || "none"}. Run \`akm setup\` to configure.`,
    );
  }

  // Validate mode/platform consistency
  if (kind === "sdk" && profileConfig.platform !== "opencode-sdk") {
    throw new ConfigError(
      `Mode "sdk" requires platform "opencode-sdk", but profiles.agent["${profileName}"].platform is "${profileConfig.platform}".`,
      "INVALID_CONFIG_FILE",
    );
  }
  if (kind === "agent" && profileConfig.platform === "opencode-sdk") {
    throw new ConfigError(
      `Mode "agent" requires platform "opencode" or "claude", but profiles.agent["${profileName}"].platform is "opencode-sdk".`,
      "INVALID_CONFIG_FILE",
    );
  }

  const agentProfile: AgentProfile = {
    name: profileName,
    bin: profileConfig.bin ?? profileName,
    args: profileConfig.args ?? [],
    stdio: "captured",
    envPassthrough: [],
    parseOutput: "text",
    ...(profileConfig.model ? { model: profileConfig.model } : {}),
    ...(profileConfig.workspace ? { workspace: profileConfig.workspace } : {}),
  };

  return {
    kind,
    profile: agentProfile,
    ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
  };
}

/**
 * Narrow predicate matching the `ConfigError` thrown by `resolveProcessRunner`
 * when a feature is explicitly disabled (`enabled: false`). All ConfigErrors
 * from this module share the `INVALID_CONFIG_FILE` code, so we additionally
 * pattern-match the message to avoid swallowing unrelated misconfiguration
 * errors (missing profile, mode/pool mismatch, etc.).
 */
function isProcessDisabledError(e: unknown): boolean {
  return e instanceof ConfigError && /is disabled in config/.test(e.message);
}

/**
 * Resolve the runner used for "validation" passes on the `improve` section
 * (Advantage D3 / Phase 4B — third model tier).
 *
 * Look-up order:
 *   1. `features.improve.validation` ProcessEntry (preferred — lets users wire
 *      a lower-cost classifier model for staleness detection, confidence
 *      scoring, and lesson classification).
 *   2. `defaults.llm` as a final fallback so callers always get a usable
 *      runner when any LLM is configured.
 *
 * Returns `null` when neither is configured (callers may then skip the
 * validation pass rather than throwing).
 */
export function resolveValidationRunner(config: AkmConfig): RunnerSpec | null {
  if (isProcessEnabled("improve", "validation", config)) {
    try {
      return resolveProcessRunner("improve", "validation", config);
    } catch (e) {
      // Only swallow the expected "process is disabled" ConfigError so we can
      // fall through to defaults.llm. Any other error (mode/pool mismatch,
      // missing profile, malformed entry, etc.) is a real misconfiguration —
      // rethrow it so the caller sees the diagnostic instead of silently
      // degrading to a different runner.
      if (!isProcessDisabledError(e)) {
        throw e;
      }
      // Fall through to defaults.llm below.
    }
  }

  const defaultLlm = config.defaults?.llm;
  if (defaultLlm) {
    try {
      return buildLlmRunnerSpec(defaultLlm, undefined, config);
    } catch {
      return null;
    }
  }

  // Legacy fallback to top-level config.llm (matches buildLlmRunnerSpec).
  if (config.llm) {
    return { kind: "llm", connection: config.llm };
  }

  return null;
}

export function resolveProcessRunner(section: ProcessSection, processName: string, config: AkmConfig): RunnerSpec {
  const sectionMap = (
    config.features as Record<string, Record<string, ProcessEntry | boolean> | undefined> | undefined
  )?.[section];
  const raw = sectionMap?.[processName];

  // If not configured in features, use defaults
  const entry: ProcessEntry = raw === undefined ? {} : raw === true ? {} : raw === false ? { enabled: false } : raw;

  const normalized = normalizeEntry(entry);

  if (!normalized.enabled) {
    throw new ConfigError(
      `Process "${section}.${processName}" is disabled in config.`,
      "INVALID_CONFIG_FILE",
      `Set features.${section}.${processName} to true or an object with enabled: true to enable it.`,
    );
  }

  const mode = resolveEffectiveMode(normalized, normalized.profile, config);
  const profileName = resolveProfileName(normalized, mode, config);
  const timeoutMs = typeof normalized.timeoutMs === "number" ? normalized.timeoutMs : undefined;

  if (mode === "llm") return buildLlmRunnerSpec(profileName, timeoutMs, config);
  return buildAgentRunnerSpec(mode, profileName, timeoutMs, config);
}

export function resolveRunner(mode: "llm" | "agent" | "sdk", profileName: string, config: AkmConfig): RunnerSpec {
  if (mode === "llm") return buildLlmRunnerSpec(profileName, undefined, config);
  return buildAgentRunnerSpec(mode, profileName, undefined, config);
}

/**
 * Resolve a RunnerSpec from an improve-profile process entry. Returns `null`
 * when the entry is absent or provides no overrides — callers should fall
 * back to the default per-process runner resolution path.
 *
 * Only `mode` + `profile` are sufficient to build a spec: when `mode` is
 * "llm" we build an LLM runner; when `mode` is "agent" or "sdk" we build an
 * agent runner. `timeoutMs` is forwarded when present.
 */
export function resolveImproveProcessRunnerFromProfile(
  processConfig: ImproveProcessConfig | undefined,
  config: AkmConfig,
): RunnerSpec | null {
  if (!processConfig) return null;
  const { mode, profile, timeoutMs } = processConfig;
  if (!mode && !profile) return null;
  if (mode === "llm") {
    if (!profile) return null;
    return buildLlmRunnerSpec(profile, timeoutMs, config);
  }
  if (mode === "agent" || mode === "sdk") {
    if (!profile) return null;
    return buildAgentRunnerSpec(mode, profile, timeoutMs, config);
  }
  return null;
}

export function isProcessEnabled(section: ProcessSection, processName: string, config: AkmConfig): boolean {
  const sectionMap = (
    config.features as Record<string, Record<string, ProcessEntry | boolean> | undefined> | undefined
  )?.[section];
  const raw = sectionMap?.[processName];
  if (raw === undefined) return false;
  if (typeof raw === "boolean") return raw;
  return raw.enabled !== false;
}

export function getProcessOptions<T = Record<string, unknown>>(
  section: ProcessSection,
  processName: string,
  config: AkmConfig,
): T | undefined {
  const sectionMap = (
    config.features as Record<string, Record<string, ProcessEntry | boolean> | undefined> | undefined
  )?.[section];
  const raw = sectionMap?.[processName];
  if (!raw || typeof raw === "boolean") return undefined;
  return raw.options as T | undefined;
}
