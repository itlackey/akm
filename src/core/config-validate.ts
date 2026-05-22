import type { AkmConfig, ImproveProcessConfig } from "./config";
import { ConfigError } from "./errors";

export interface ConfigValidationError {
  path: string;
  message: string;
}

function validateProcessEntry(
  entry: ImproveProcessConfig | undefined,
  path: string,
  config: AkmConfig,
  errors: ConfigValidationError[],
): void {
  if (!entry) return;
  const { mode, profile } = entry;
  if (!profile) return;

  // Determine effective mode
  let effectiveMode = mode;
  if (!effectiveMode) {
    if (config.profiles?.llm?.[profile]) {
      effectiveMode = "llm";
    } else if (config.profiles?.agent?.[profile]) {
      const agentProfile = config.profiles.agent[profile];
      effectiveMode = agentProfile.platform === "opencode-sdk" ? "sdk" : "agent";
    } else if (config.defaults?.llm) {
      effectiveMode = "llm";
    } else if (config.defaults?.agent) {
      effectiveMode = "agent";
    }
  }
  if (!effectiveMode) return;

  if (effectiveMode === "llm") {
    if (!config.profiles?.llm) {
      errors.push({ path, message: `mode "llm" requires profiles.llm to be configured, but none are defined.` });
      return;
    }
    if (!config.profiles.llm[profile]) {
      errors.push({
        path,
        message: `profile "${profile}" not found in profiles.llm (available: ${Object.keys(config.profiles.llm).join(", ") || "none"}).`,
      });
    }
    return;
  }
  if (effectiveMode === "agent") {
    if (!config.profiles?.agent) {
      errors.push({ path, message: `mode "agent" requires profiles.agent to be configured, but none are defined.` });
      return;
    }
    const agentProfile = config.profiles.agent[profile];
    if (!agentProfile) {
      errors.push({
        path,
        message: `profile "${profile}" not found in profiles.agent (available: ${Object.keys(config.profiles.agent).join(", ") || "none"}).`,
      });
    } else if (agentProfile.platform !== "opencode" && agentProfile.platform !== "claude") {
      errors.push({
        path,
        message: `mode "agent" requires platform "opencode" or "claude", but profiles.agent["${profile}"].platform is "${agentProfile.platform}".`,
      });
    }
    return;
  }
  if (effectiveMode === "sdk") {
    if (!config.profiles?.agent) {
      errors.push({ path, message: `mode "sdk" requires profiles.agent to be configured, but none are defined.` });
      return;
    }
    const agentProfile = config.profiles.agent[profile];
    if (!agentProfile) {
      errors.push({
        path,
        message: `profile "${profile}" not found in profiles.agent (available: ${Object.keys(config.profiles.agent).join(", ") || "none"}).`,
      });
    } else if (agentProfile.platform !== "opencode-sdk") {
      errors.push({
        path,
        message: `mode "sdk" requires platform "opencode-sdk", but profiles.agent["${profile}"].platform is "${agentProfile.platform}".`,
      });
    }
  }
}

export function validateConfig(config: AkmConfig): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];

  // Walk every improve profile's processes and validate any profile/mode bindings.
  const improveProfiles = config.profiles?.improve;
  if (improveProfiles) {
    for (const [profileName, profile] of Object.entries(improveProfiles)) {
      const processes = profile.processes as Record<string, ImproveProcessConfig | undefined> | undefined;
      if (!processes) continue;
      for (const [processName, processEntry] of Object.entries(processes)) {
        validateProcessEntry(processEntry, `profiles.improve.${profileName}.processes.${processName}`, config, errors);
      }
    }
  }

  // Validate defaults.llm points at a real profile (when set).
  const defaultLlm = config.defaults?.llm;
  if (defaultLlm && !config.profiles?.llm?.[defaultLlm]) {
    errors.push({
      path: "defaults.llm",
      message: `defaults.llm "${defaultLlm}" not found in profiles.llm (available: ${Object.keys(config.profiles?.llm ?? {}).join(", ") || "none"}).`,
    });
  }

  // Validate defaults.agent points at a real profile (when set).
  const defaultAgent = config.defaults?.agent;
  if (defaultAgent && !config.profiles?.agent?.[defaultAgent]) {
    errors.push({
      path: "defaults.agent",
      message: `defaults.agent "${defaultAgent}" not found in profiles.agent (available: ${Object.keys(config.profiles?.agent ?? {}).join(", ") || "none"}).`,
    });
  }

  return errors;
}

export function assertValidConfig(config: AkmConfig): void {
  const errors = validateConfig(config);
  if (errors.length === 0) return;

  const lines = errors.map((e) => `  - ${e.path}: ${e.message}`).join("\n");
  throw new ConfigError(
    `Configuration validation failed with ${errors.length} error${errors.length === 1 ? "" : "s"}:\n${lines}`,
    "INVALID_CONFIG_FILE",
    "Fix the errors listed above, or run `akm config migrate` to upgrade from v1 config shape.",
  );
}
