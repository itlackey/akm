// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type {
  AkmConfig,
  ImproveProcessConfig,
  ImproveProfileConfig,
  LlmConnectionConfig,
} from "../../core/config/config";
import { ConfigError } from "../../core/errors";
import {
  type CredentialDescriptor,
  materializeLlmConnection,
  type ResolvedLlmUse,
  resolveEngine,
  resolveLlmEngineUse,
} from "./engine-resolution";
import { resolveModel } from "./model-aliases";
import type { AgentProfile } from "./profiles";

export type ProcessSection = "improve" | "index" | "search" | string;

export type RunnerSpec =
  | {
      kind: "llm";
      engine?: string;
      connection: LlmConnectionConfig;
      credential?: CredentialDescriptor;
      timeoutMs?: number | null;
    }
  | { kind: "agent"; engine?: string; profile: AgentProfile; timeoutMs?: number | null }
  | {
      kind: "sdk";
      engine?: string;
      profile: AgentProfile;
      fallbackConnection?: LlmConnectionConfig;
      fallbackCredential?: CredentialDescriptor;
      fallbackTimeoutMs?: number | null;
      timeoutMs?: number | null;
    };

export type DispatchedLlmRunner = Omit<Extract<RunnerSpec, { kind: "llm" }>, "connection"> & {
  connection: LlmConnectionConfig;
};

/** Resolve the current credential value for one frozen LLM runner at dispatch. */
export function materializeLlmRunnerConnection(runner: Extract<RunnerSpec, { kind: "llm" }>): LlmConnectionConfig {
  const connectionWithLegacyTimeout = runner.connection as LlmConnectionConfig;
  const timeoutMs =
    runner.timeoutMs !== undefined
      ? runner.timeoutMs
      : Object.hasOwn(connectionWithLegacyTimeout, "timeoutMs")
        ? (connectionWithLegacyTimeout.timeoutMs ?? null)
        : null;
  return materializeLlmConnection({
    engine: runner.engine ?? "unnamed",
    connection: runner.connection,
    ...(runner.credential ? { credential: runner.credential } : {}),
    timeoutMs,
  });
}

export function runnerIsLlm(runner: RunnerSpec): runner is Extract<RunnerSpec, { kind: "llm" }> {
  return runner.kind === "llm";
}

export function runnerSupportsFileWrite(runner: RunnerSpec): runner is Extract<RunnerSpec, { kind: "agent" | "sdk" }> {
  return runner.kind !== "llm";
}

/** Resolve the configured LLM default without ever consulting retired profiles. */
export function resolveDefaultLlmRunner(config: AkmConfig, timeoutMs?: number | null): RunnerSpec | null {
  const resolved = resolveLlmEngineUse(config, [], { optional: true });
  if (!resolved) return null;
  return {
    kind: "llm",
    engine: resolved.engine,
    connection: resolved.connection,
    ...(resolved.credential ? { credential: resolved.credential } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : { timeoutMs: resolved.timeoutMs }),
  };
}

/** Resolve a triage judgment using judgment -> triage -> strategy -> defaults.llmEngine precedence. */
export function resolveTriageJudgmentRunner(
  judgment: Pick<ImproveProcessConfig, "engine" | "model" | "timeoutMs" | "llm"> | undefined,
  config: AkmConfig,
  triage?: Pick<ImproveProcessConfig, "engine" | "model" | "timeoutMs" | "llm">,
  strategy?: Pick<ImproveProfileConfig, "engine" | "model" | "timeoutMs" | "llm">,
): RunnerSpec | null {
  const layers = [strategy ?? {}, triage ?? {}, judgment ?? {}];
  const selectedEngine = judgment?.engine ?? triage?.engine ?? strategy?.engine ?? config.defaults?.llmEngine;
  if (selectedEngine) {
    const runner = resolveEngine(selectedEngine, config);
    if (runner.kind === "llm") {
      const resolved = resolveLlmEngineUse(config, layers);
      return {
        kind: "llm",
        engine: resolved.engine,
        connection: resolved.connection,
        ...(resolved.credential ? { credential: resolved.credential } : {}),
        timeoutMs: resolved.timeoutMs,
      };
    }
    const effectiveLlmOverrides = [...layers].reverse().find((layer) => layer.llm !== undefined)?.llm;
    if (effectiveLlmOverrides) {
      throw new ConfigError(
        `Triage judgment engine "${selectedEngine}" is an agent engine and cannot receive llm overrides.`,
        "INVALID_CONFIG_FILE",
      );
    }
    const model = [...layers].reverse().find((layer) => layer.model !== undefined)?.model;
    const profile = model
      ? {
          ...runner.profile,
          model: resolveModel(
            model,
            runner.profile.platform ?? runner.profile.name,
            runner.profile.modelAliases,
            runner.profile.globalModelAliases,
          ),
          modelIsExact: true,
        }
      : runner.profile;
    const timeoutLayer = [...layers].reverse().find((layer) => Object.hasOwn(layer, "timeoutMs"));
    return {
      ...runner,
      profile,
      ...(timeoutLayer ? { timeoutMs: timeoutLayer.timeoutMs ?? null } : {}),
    };
  }
  return null;
}

/** Resolve an improve process through the active strategy and process overlays. */
export function resolveImproveProcessLlmUse(
  config: AkmConfig,
  strategy: ImproveProfileConfig | undefined,
  processName: string,
  options: { optional: true },
): ResolvedLlmUse | undefined;
export function resolveImproveProcessLlmUse(
  config: AkmConfig,
  strategy: ImproveProfileConfig | undefined,
  processName: string,
  options?: { optional?: false },
): ResolvedLlmUse;
export function resolveImproveProcessLlmUse(
  config: AkmConfig,
  strategy: ImproveProfileConfig | undefined,
  processName: string,
  options: { optional?: boolean } = {},
): ResolvedLlmUse | undefined {
  const process = (strategy?.processes as Record<string, ImproveProcessConfig | undefined>)?.[processName];
  const layers = strategy ? [strategy, process ?? {}] : [];
  return options.optional
    ? resolveLlmEngineUse(config, layers, { optional: true })
    : resolveLlmEngineUse(config, layers);
}

/** Resolve the LLM runner selected by an improve strategy and process without reading credentials. */
export function resolveImproveProcessRunner(
  strategy: ImproveProfileConfig | undefined,
  processName: string,
  config: AkmConfig,
): Extract<RunnerSpec, { kind: "llm" }> | null {
  if (!strategy) return null;
  const resolved = resolveImproveProcessLlmUse(config, strategy, processName, { optional: true });
  if (!resolved) return null;
  return {
    kind: "llm",
    engine: resolved.engine,
    connection: resolved.connection,
    ...(resolved.credential ? { credential: resolved.credential } : {}),
    timeoutMs: resolved.timeoutMs,
  };
}

export { isProcessEnabled } from "../../llm/feature-gate";
