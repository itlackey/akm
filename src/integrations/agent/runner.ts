// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AkmConfig, ImproveProcessConfig, LlmConnectionConfig } from "../../core/config/config";
import { ConfigError } from "../../core/errors";
import { warn } from "../../core/warn";
import type { AgentProfile } from "./profiles";

export type ProcessSection = "improve" | "index" | "search" | string;

export type RunnerSpec =
  | { kind: "llm"; engine?: string; connection: LlmConnectionConfig; timeoutMs?: number | null }
  | { kind: "agent"; engine?: string; profile: AgentProfile; timeoutMs?: number | null }
  | {
      kind: "sdk";
      engine?: string;
      profile: AgentProfile;
      fallbackConnection?: LlmConnectionConfig;
      timeoutMs?: number | null;
    };

// ── RunnerSpec capability predicates (H1) ───────────────────────────────────
// The `RunnerSpec` union is dispatched ad-hoc across the improve slice. These
// predicates co-locate the capability questions with the union definition so
// callers stop hand-inlining `kind !== "llm"` (which couples the call site to
// the exact shape of the union). They are typed as TypeScript type guards so
// narrowing flows through to the `connection` / `profile` accessors.

/** The in-tree LLM HTTP runner (`chatCompletion`); has no filesystem access. */
export function runnerIsLlm(runner: RunnerSpec): runner is Extract<RunnerSpec, { kind: "llm" }> {
  return runner.kind === "llm";
}

/**
 * Whether this runner can honour the file-write contract. Agent CLI + OpenCode
 * SDK runners both have filesystem access; the direct LLM HTTP runner does NOT
 * (see `src/llm/call-ai.ts`). Equivalent to `!runnerIsLlm(runner)` but names
 * the capability the callers actually care about.
 */
export function runnerSupportsFileWrite(runner: RunnerSpec): runner is Extract<RunnerSpec, { kind: "agent" | "sdk" }> {
  return runner.kind !== "llm";
}

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
/**
 * Shared resolution path for the `validation` and `triage judgment` tiers,
 * both of which take a `{ mode?, profile?, timeoutMs? }`-shaped block, attempt
 * to resolve it via {@link resolveImproveProcessRunnerFromProfile}, and
 * otherwise fall back to an `llm` runner built from `defaults.llm`.
 *
 * @param block          the `{ mode?, profile?, timeoutMs? }` subset to resolve.
 * @param config         the active AKM config.
 * @param opts.fallbackTimeoutMs  timeout applied to the `defaults.llm` fallback
 *        runner (validation passes `undefined`; triage forwards `block.timeoutMs`).
 * @param opts.suppressLlmFallbackForExplicitMode  when `true` and the block
 *        explicitly sets `mode: "agent"` or `"sdk"`, do NOT silently fall back
 *        to `defaults.llm` if the profile resolver returns `null` or throws —
 *        return `null` instead and emit a `warn(...)` (see FIX 8). Validation
 *        passes `false` to preserve its always-fallback behavior.
 */
function resolveProcessRunnerWithLlmFallback(
  block: { mode?: "llm" | "agent" | "sdk"; profile?: string; timeoutMs?: number | null } | undefined,
  config: AkmConfig,
  opts: { fallbackTimeoutMs: number | null | undefined; suppressLlmFallbackForExplicitMode: boolean },
): RunnerSpec | null {
  const explicitNonLlmMode = block?.mode === "agent" || block?.mode === "sdk";

  if (block && (block.mode || block.profile)) {
    try {
      const spec = resolveImproveProcessRunnerFromProfile(block, config);
      if (spec) return spec;
    } catch {
      // Fall through to defaults.llm below (unless suppressed for explicit modes).
    }

    // FIX 8: an EXPLICIT agent/sdk request must not be silently downgraded to
    // llm. When the profile resolver could not produce a runner, surface the
    // misconfiguration and let callers skip this tier rather than substituting
    // an llm judge.
    if (opts.suppressLlmFallbackForExplicitMode && explicitNonLlmMode) {
      warn(
        `[akm] Could not resolve the "${block?.mode}" judgment profile; ` +
          `skipping the judgment tier instead of falling back to an llm judge. ` +
          `Check profiles.agent and the judgment profile/mode configuration.`,
      );
      return null;
    }
  }

  const defaultLlm = config.defaults?.llm;
  if (defaultLlm) {
    try {
      return buildLlmRunnerSpec(defaultLlm, opts.fallbackTimeoutMs, config);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Build the tool-less HTTP runner from `defaults.llm`, or `null` when unset.
 * The unattended-improve reflect pin (meta-review 07 Chain-G / P1.3) uses this
 * as the mandatory downgrade target when config would otherwise hand reflect a
 * tool-capable (agent/SDK) runner in a scheduled run. Throws ConfigError when
 * `defaults.llm` names a profile that does not exist.
 */
export function resolveDefaultLlmRunner(config: AkmConfig, timeoutMs?: number | null): RunnerSpec | null {
  const name = config.defaults?.llm;
  if (!name) return null;
  return buildLlmRunnerSpec(name, timeoutMs, config);
}

export function resolveValidationRunner(config: AkmConfig): RunnerSpec | null {
  const validation = config.profiles?.improve?.default?.processes?.validation;
  const block = validation && validation.enabled !== false ? validation : undefined;
  return resolveProcessRunnerWithLlmFallback(block, config, {
    fallbackTimeoutMs: undefined,
    suppressLlmFallbackForExplicitMode: false,
  });
}

/**
 * Resolve the runner for the triage judgment tier (Proposal-Queue Triage,
 * Phase 3). The `judgment` block is a `{ mode?, profile?, timeoutMs? }` subset
 * compatible with {@link ImproveProcessConfig}, so it resolves through the same
 * {@link resolveImproveProcessRunnerFromProfile} path.
 *
 * Mirrors {@link resolveValidationRunner}'s `defaults.llm` fallback only for
 * the unset/`llm` case: when the block sets neither `mode` nor `profile` (so
 * the profile resolver returns `null`) or `mode: "llm"`, fall back to an `llm`
 * runner built from `defaults.llm` so `judgment.mode: llm` defaults are honored
 * (§14). However (FIX 8) when the caller EXPLICITLY sets `mode: "agent"` or
 * `"sdk"` and the profile resolver returns `null` or throws, do NOT downgrade
 * to an llm judge — return `null` (callers skip the judgment tier and emit
 * `triage_deferred`) and emit a `warn(...)`. Returns `null` when nothing is
 * configured.
 */
export function resolveTriageJudgmentRunner(
  judgment: { mode?: "llm" | "agent" | "sdk"; profile?: string; timeoutMs?: number | null } | undefined,
  config: AkmConfig,
): RunnerSpec | null {
  return resolveProcessRunnerWithLlmFallback(judgment, config, {
    fallbackTimeoutMs: judgment?.timeoutMs,
    suppressLlmFallbackForExplicitMode: true,
  });
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

// Re-export `isProcessEnabled` from feature-gate.ts so callers that previously
// imported it from runner.ts continue to work.
export { isProcessEnabled } from "../../llm/feature-gate";
