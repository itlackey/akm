// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AkmConfig, ImproveProcessConfig, LlmConnectionConfig } from "../../core/config";
import { ConfigError } from "../../core/errors";
import type { AgentProfile } from "./profiles";

export type ProcessSection = "improve" | "index" | "search" | string;

export type RunnerSpec =
  | { kind: "llm"; connection: LlmConnectionConfig; timeoutMs?: number }
  | { kind: "agent"; profile: AgentProfile; timeoutMs?: number }
  | { kind: "sdk"; profile: AgentProfile; timeoutMs?: number };

function resolveEffectiveMode(
  entry: ImproveProcessConfig,
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

  return "llm";
}

function resolveProfileName(entry: ImproveProcessConfig, mode: "llm" | "agent" | "sdk", config: AkmConfig): string {
  if (entry.profile) return entry.profile;
  if (mode === "llm") {
    const defaultName = config.defaults?.llm;
    if (defaultName) return defaultName;
    throw new ConfigError(
      `No LLM profile configured. Set defaults.llm in config or specify profile in the process entry.`,
      "LLM_NOT_CONFIGURED",
      "Run `akm setup` or define a profile under `profiles.llm` and set `defaults.llm`.",
    );
  }
  const defaultName = config.defaults?.agent;
  if (defaultName) return defaultName;
  throw new ConfigError(
    `No agent profile configured. Set defaults.agent in config or specify profile in the process entry.`,
    "INVALID_CONFIG_FILE",
    "Run `akm setup` to configure an agent profile, or add one under `profiles.agent`.",
  );
}

function buildLlmRunnerSpec(profileName: string, timeoutMs: number | null | undefined, config: AkmConfig): RunnerSpec {
  const profile = config.profiles?.llm?.[profileName];
  if (!profile) {
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
 * Resolve the runner used for "validation" passes on the `improve` section
 * (Advantage D3 / Phase 4B — third model tier).
 *
 * Look-up order:
 *   1. `profiles.improve.default.processes.validation` (preferred — lets users
 *      wire a lower-cost classifier model for staleness detection, confidence
 *      scoring, and lesson classification).
 *   2. `defaults.llm` as a final fallback so callers always get a usable
 *      runner when any LLM is configured.
 *
 * Returns `null` when neither is configured (callers may then skip the
 * validation pass rather than throwing).
 */
export function resolveValidationRunner(config: AkmConfig): RunnerSpec | null {
  const validation = config.profiles?.improve?.default?.processes?.validation;
  if (validation && validation.enabled !== false && (validation.profile || validation.mode)) {
    try {
      const spec = resolveImproveProcessRunnerFromProfile(validation, config);
      if (spec) return spec;
    } catch {
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
  return null;
}

/**
 * Resolve the runner for the triage judgment tier (Proposal-Queue Triage,
 * Phase 3). The `judgment` block is a `{ mode?, profile?, timeoutMs? }` subset
 * compatible with {@link ImproveProcessConfig}, so it resolves through the same
 * {@link resolveImproveProcessRunnerFromProfile} path.
 *
 * Mirrors {@link resolveValidationRunner}'s `defaults.llm` fallback: when the
 * block sets neither `mode` nor `profile` (so the profile resolver returns
 * `null`), fall back to an `llm` runner built from `defaults.llm` so
 * `judgment.mode: llm` defaults are honored (§14). Returns `null` when nothing
 * is configured — callers then skip the judgment tier (and emit
 * `triage_deferred`).
 */
export function resolveTriageJudgmentRunner(
  judgment: { mode?: "llm" | "agent" | "sdk"; profile?: string; timeoutMs?: number | null } | undefined,
  config: AkmConfig,
): RunnerSpec | null {
  if (judgment && (judgment.mode || judgment.profile)) {
    try {
      const spec = resolveImproveProcessRunnerFromProfile(judgment, config);
      if (spec) return spec;
    } catch {
      // Fall through to defaults.llm below.
    }
  }

  const defaultLlm = config.defaults?.llm;
  if (defaultLlm) {
    try {
      return buildLlmRunnerSpec(defaultLlm, judgment?.timeoutMs, config);
    } catch {
      return null;
    }
  }
  return null;
}

export function resolveRunner(mode: "llm" | "agent" | "sdk", profileName: string, config: AkmConfig): RunnerSpec {
  if (mode === "llm") return buildLlmRunnerSpec(profileName, undefined, config);
  return buildAgentRunnerSpec(mode, profileName, undefined, config);
}

/**
 * Resolve a RunnerSpec from an improve-profile process entry. Returns `null`
 * when the entry is absent or provides no overrides — callers should fall
 * back to the default per-process runner resolution path.
 */
export function resolveImproveProcessRunnerFromProfile(
  processConfig: ImproveProcessConfig | undefined,
  config: AkmConfig,
): RunnerSpec | null {
  if (!processConfig) return null;
  const { mode: explicitMode, profile, timeoutMs } = processConfig;
  if (!explicitMode && !profile) return null;
  const mode = explicitMode ?? resolveEffectiveMode(processConfig, profile, config);
  const profileName = profile ?? resolveProfileName(processConfig, mode, config);
  if (mode === "llm") {
    return buildLlmRunnerSpec(profileName, timeoutMs, config);
  }
  if (mode === "agent" || mode === "sdk") {
    return buildAgentRunnerSpec(mode, profileName, timeoutMs, config);
  }
  return null;
}

/**
 * Convenience accessor for callers that previously read
 * `getProcessOptions("index", "staleness_detection", config).thresholdDays`.
 * After the 0.8.0 migration, those values live on first-class config keys —
 * see `config.index?.stalenessDetection?.thresholdDays` etc.
 */
export function getStalenessDetectionThresholdDays(config: AkmConfig): number | undefined {
  return config.index?.stalenessDetection?.thresholdDays;
}

// Re-export `isProcessEnabled` from feature-gate.ts so callers that previously
// imported it from runner.ts continue to work.
export { isProcessEnabled } from "../../llm/feature-gate";
