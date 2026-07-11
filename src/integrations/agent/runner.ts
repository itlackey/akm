// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AkmConfig, ImproveProcessConfig, LlmConnectionConfig } from "../../core/config/config";
import { materializeLlmConnection, resolveEngine, resolveLlmEngineUse } from "./engine-resolution";
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
  judgment: Pick<ImproveProcessConfig, "engine" | "timeoutMs"> | undefined,
  config: AkmConfig,
): RunnerSpec | null {
  if (judgment?.engine) {
    const runner = resolveEngine(judgment.engine, config);
    return judgment.timeoutMs === undefined ? runner : { ...runner, timeoutMs: judgment.timeoutMs };
  }
  return resolveDefaultLlmRunner(config, judgment?.timeoutMs);
}

/** Resolve one process engine. A missing process engine deliberately leaves selection to its caller. */
export function resolveImproveProcessRunnerFromProfile(
  processConfig: ImproveProcessConfig | undefined,
  config: AkmConfig,
): RunnerSpec | null {
  if (!processConfig?.engine) return null;
  const runner = resolveEngine(processConfig.engine, config);
  return processConfig.timeoutMs === undefined ? runner : { ...runner, timeoutMs: processConfig.timeoutMs };
}

export function resolveRunner(_mode: "llm" | "agent" | "sdk", engine: string, config: AkmConfig): RunnerSpec {
  return resolveEngine(engine, config);
}

export { isProcessEnabled } from "../../llm/feature-gate";
