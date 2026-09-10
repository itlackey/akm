// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { LlmConnectionConfig } from "../../core/config/config";
import {
  type CredentialDescriptor,
  materializeLlmConnection,
  materializeLlmConnectionWithCredential,
} from "./engine-resolution";
import type { AgentProfile } from "./profiles";

export type RunnerSpec =
  | {
      kind: "llm";
      engine: string;
      connection: LlmConnectionConfig;
      credential?: CredentialDescriptor;
      /** File-backed credential (#905), read lazily at dispatch. See engine-resolution.ts. */
      apiKeyFile?: string;
      /** Secret-store-backed credential reference (#953), read lazily at dispatch. */
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
      /** File-backed fallback credential (#905), read lazily at dispatch. */
      fallbackApiKeyFile?: string;
      /** Secret-store-backed fallback credential reference (#953), read lazily at dispatch. */
      fallbackApiKeySecretRef?: string;
      fallbackTimeoutMs?: number | null;
      timeoutMs?: number | null;
    };

export type DispatchedLlmRunner = Omit<Extract<RunnerSpec, { kind: "llm" }>, "connection"> & {
  connection: LlmConnectionConfig;
};

/** Resolve the current credential value for one frozen LLM runner at dispatch. */
export function materializeLlmRunnerConnection(runner: Extract<RunnerSpec, { kind: "llm" }>): LlmConnectionConfig {
  return materializeLlmConnection({
    engine: runner.engine,
    connection: runner.connection,
    ...(runner.credential ? { credential: runner.credential } : {}),
    ...(runner.apiKeyFile ? { apiKeyFile: runner.apiKeyFile } : {}),
    ...(runner.apiKeySecretRef ? { apiKeySecretRef: runner.apiKeySecretRef } : {}),
    timeoutMs: runner.timeoutMs ?? null,
  });
}

/** Inject an already-snapshotted credential without consulting live process state. */
export function materializeLlmRunnerConnectionWithCredential(
  runner: Extract<RunnerSpec, { kind: "llm" }>,
  credentialValue: string | undefined,
): LlmConnectionConfig {
  return materializeLlmConnectionWithCredential(
    {
      engine: runner.engine,
      connection: runner.connection,
      ...(runner.credential ? { credential: runner.credential } : {}),
      ...(runner.apiKeyFile ? { apiKeyFile: runner.apiKeyFile } : {}),
      ...(runner.apiKeySecretRef ? { apiKeySecretRef: runner.apiKeySecretRef } : {}),
      timeoutMs: runner.timeoutMs ?? null,
    },
    credentialValue,
  );
}

export function runnerIsLlm(runner: RunnerSpec): runner is Extract<RunnerSpec, { kind: "llm" }> {
  return runner.kind === "llm";
}

export function runnerSupportsFileWrite(runner: RunnerSpec): runner is Extract<RunnerSpec, { kind: "agent" | "sdk" }> {
  return runner.kind !== "llm";
}
