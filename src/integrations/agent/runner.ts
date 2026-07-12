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
import { materializeLlmConnection, type ResolvedLlmUse, resolveEngine, resolveLlmEngineUse } from "./engine-resolution";
import { resolveModel } from "./model-aliases";
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
    connection: materializeLlmConnection(resolved),
    ...(timeoutMs !== undefined ? { timeoutMs } : { timeoutMs: resolved.timeoutMs }),
  };
}

/** Structural validation is engine-free; this compatibility-free helper only selects an LLM when one exists. */
export function resolveValidationRunner(config: AkmConfig): RunnerSpec | null {
  return resolveDefaultLlmRunner(config);
}

/** Resolve a triage judgment's final engine selection. Explicit wrong engines never fall back. */
export function resolveTriageJudgmentRunner(
  judgment: Pick<ImproveProcessConfig, "engine" | "model" | "timeoutMs" | "llm"> | undefined,
  config: AkmConfig,
): RunnerSpec | null {
  if (judgment?.engine) {
    const runner = resolveEngine(judgment.engine, config);
    if (runner.kind === "llm") {
      const resolved = resolveLlmEngineUse(config, [judgment]);
      return {
        kind: "llm",
        engine: resolved.engine,
        connection: materializeLlmConnection(resolved),
        timeoutMs: resolved.timeoutMs,
      };
    }
    if (judgment.llm) {
      throw new ConfigError(
        `Triage judgment engine "${judgment.engine}" is an agent engine and cannot receive llm overrides.`,
        "INVALID_CONFIG_FILE",
      );
    }
    const profile = judgment.model
      ? {
          ...runner.profile,
          model: resolveModel(
            judgment.model,
            runner.profile.platform ?? runner.profile.name,
            runner.profile.modelAliases,
            runner.profile.globalModelAliases,
          ),
          modelIsExact: true,
        }
      : runner.profile;
    return {
      ...runner,
      profile,
      ...(judgment.timeoutMs !== undefined ? { timeoutMs: judgment.timeoutMs } : {}),
    };
  }
  const resolved = resolveLlmEngineUse(config, judgment ? [judgment] : [], { optional: true });
  if (!resolved) return null;
  return {
    kind: "llm",
    engine: resolved.engine,
    connection: materializeLlmConnection(resolved),
    timeoutMs: resolved.timeoutMs,
  };
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

/** Materialize the LLM runner selected by an improve strategy and process. */
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
    connection: materializeLlmConnection(resolved),
    timeoutMs: resolved.timeoutMs,
  };
}

export function resolveRunner(_mode: "llm" | "agent" | "sdk", engine: string, config: AkmConfig): RunnerSpec {
  return resolveEngine(engine, config);
}

export { isProcessEnabled } from "../../llm/feature-gate";
