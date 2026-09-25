// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { LlmConnectionConfig } from "../../core/config/config";
import { type CredentialDescriptor, materializeLlmConnection, type ResolvedLlmUse } from "./engine-resolution";
import type { AgentProfile } from "./profiles";

/**
 * The resolved engine. Credentials are symbolic (an env descriptor, a file
 * path, or a `secret://` reference) so this shape can be journaled; values are
 * read only at dispatch.
 */
export type RunnerSpec =
  | {
      kind: "llm";
      engine: string;
      connection: LlmConnectionConfig;
      credential?: CredentialDescriptor;
      apiKeyFile?: string;
      apiKeySecretRef?: string;
      timeoutMs?: number | null;
    }
  | { kind: "agent"; engine: string; profile: AgentProfile; timeoutMs?: number | null }
  | {
      kind: "sdk";
      engine: string;
      profile: AgentProfile;
      fallbackConnection?: LlmConnectionConfig;
      fallbackCredential?: CredentialDescriptor;
      fallbackApiKeyFile?: string;
      fallbackApiKeySecretRef?: string;
      fallbackTimeoutMs?: number | null;
      timeoutMs?: number | null;
    };

export type LlmRunner = Extract<RunnerSpec, { kind: "llm" }>;
export type SdkRunner = Extract<RunnerSpec, { kind: "sdk" }>;

export type DispatchedLlmRunner = Omit<LlmRunner, "connection"> & { connection: LlmConnectionConfig };

/** The symbolic LLM use behind one llm runner; nothing is read here. */
export function llmUseFromRunner(runner: LlmRunner): ResolvedLlmUse {
  return {
    engine: runner.engine,
    connection: runner.connection,
    ...(runner.credential ? { credential: runner.credential } : {}),
    ...(runner.apiKeyFile ? { apiKeyFile: runner.apiKeyFile } : {}),
    ...(runner.apiKeySecretRef ? { apiKeySecretRef: runner.apiKeySecretRef } : {}),
    timeoutMs: runner.timeoutMs ?? null,
  };
}

/** The symbolic LLM use behind an sdk runner's provider fallback, when it has one. */
export function sdkFallbackUseFromRunner(runner: SdkRunner): ResolvedLlmUse | undefined {
  if (!runner.fallbackConnection) return undefined;
  return {
    engine: runner.engine,
    connection: runner.fallbackConnection,
    ...(runner.fallbackCredential ? { credential: runner.fallbackCredential } : {}),
    ...(runner.fallbackApiKeyFile ? { apiKeyFile: runner.fallbackApiKeyFile } : {}),
    ...(runner.fallbackApiKeySecretRef ? { apiKeySecretRef: runner.fallbackApiKeySecretRef } : {}),
    timeoutMs:
      runner.fallbackTimeoutMs !== undefined ? runner.fallbackTimeoutMs : (runner.fallbackConnection.timeoutMs ?? null),
  };
}

/** Read the current credential and inject it: the dispatch boundary for one llm runner. */
export function materializeLlmRunnerConnection(
  runner: LlmRunner,
  envSource: NodeJS.ProcessEnv = process.env,
): LlmConnectionConfig {
  return materializeLlmConnection(llmUseFromRunner(runner), envSource);
}

/** The same for an sdk runner's provider fallback, when it has one. */
export function materializeSdkFallbackConnection(
  runner: SdkRunner,
  envSource: NodeJS.ProcessEnv = process.env,
): LlmConnectionConfig | undefined {
  const use = sdkFallbackUseFromRunner(runner);
  return use ? materializeLlmConnection(use, envSource) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read a journaled runner back. Tolerant: unknown keys are kept and missing
 * profile defaults are filled in; only a shape nothing could dispatch is refused.
 */
export function decodeFrozenRunnerSpec(value: unknown): RunnerSpec {
  if (!isRecord(value) || typeof value.engine !== "string") {
    throw new TypeError("a frozen runner must be an object with an engine name");
  }
  if (value.kind === "llm") {
    if (!isRecord(value.connection) || typeof value.connection.endpoint !== "string") {
      throw new TypeError("a frozen llm runner must carry connection.endpoint");
    }
    return value as unknown as RunnerSpec;
  }
  if (value.kind !== "agent" && value.kind !== "sdk") {
    throw new TypeError("a frozen runner's kind must be llm, agent, or sdk");
  }
  const profile = value.profile;
  if (!isRecord(profile) || typeof profile.name !== "string" || typeof profile.bin !== "string") {
    throw new TypeError("a frozen agent runner must carry profile.name and profile.bin");
  }
  return {
    ...value,
    profile: { args: [], envPassthrough: [], stdio: "captured", parseOutput: "text", ...profile },
  } as unknown as RunnerSpec;
}

export function runnerIsLlm(runner: RunnerSpec): runner is LlmRunner {
  return runner.kind === "llm";
}

export function runnerSupportsFileWrite(runner: RunnerSpec): runner is Extract<RunnerSpec, { kind: "agent" | "sdk" }> {
  return runner.kind !== "llm";
}
