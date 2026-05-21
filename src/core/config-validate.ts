import type { AkmConfig, ProcessEntry } from "./config";
import { ConfigError } from "./errors";

export interface ConfigValidationError {
  path: string;
  message: string;
}

function isProcessEntryObject(value: ProcessEntry | boolean): value is ProcessEntry {
  return typeof value === "object";
}

function validateSectionEntries(
  section: Record<string, ProcessEntry | boolean> | undefined,
  sectionName: string,
  config: AkmConfig,
  errors: ConfigValidationError[],
): void {
  if (!section) return;

  for (const [processName, entry] of Object.entries(section)) {
    if (!isProcessEntryObject(entry)) continue;

    const { mode, profile } = entry;
    if (!profile) continue;

    const path = `features.${sectionName}.${processName}`;

    // Determine effective mode
    let effectiveMode = mode;
    if (!effectiveMode && profile) {
      // Infer from which pool the profile exists in
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

    if (!effectiveMode) continue;

    if (effectiveMode === "llm") {
      if (!config.profiles?.llm) {
        errors.push({ path, message: `mode "llm" requires profiles.llm to be configured, but none are defined.` });
        continue;
      }
      if (!config.profiles.llm[profile]) {
        errors.push({
          path,
          message: `profile "${profile}" not found in profiles.llm (available: ${Object.keys(config.profiles.llm).join(", ") || "none"}).`,
        });
      }
    } else if (effectiveMode === "agent") {
      if (!config.profiles?.agent) {
        errors.push({ path, message: `mode "agent" requires profiles.agent to be configured, but none are defined.` });
        continue;
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
    } else if (effectiveMode === "sdk") {
      if (!config.profiles?.agent) {
        errors.push({ path, message: `mode "sdk" requires profiles.agent to be configured, but none are defined.` });
        continue;
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
}

export function validateConfig(config: AkmConfig): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];

  if (!config.features) return errors;

  validateSectionEntries(config.features.improve, "improve", config, errors);
  validateSectionEntries(config.features.index, "index", config, errors);
  validateSectionEntries(config.features.search, "search", config, errors);

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
