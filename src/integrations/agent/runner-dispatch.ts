// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Run a built execution: the one place credentials are read. A direct LLM
 * goes to `chatCompletion`, an agent engine to `runAgent` (the harness builder
 * turns the request into argv), an SDK engine to `runOpencodeSdk`. Every
 * credential and passthrough value that could reach the child is redacted
 * from the result.
 */

import { assertNever } from "../../core/assert";
import type { AkmConfig, LlmConnectionConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import {
  collectSensitiveValues,
  isEnvPassthroughValueSafeToExpose,
  redactSensitiveText,
  redactSensitiveValue,
} from "../../core/redaction";
import { chatCompletion, LlmCallError } from "../../llm/client";
import { closeServer as disposeOpencodeSdkServers, runOpencodeSdk } from "../harnesses/opencode-sdk/sdk-runner";
import {
  lookupApiKeyFileValue,
  lookupApiKeySecretRefValue,
  lookupCredentialFromEnv,
  resolveEngine,
} from "./engine-resolution";
import type { BuiltExecution } from "./execution";
import type { AgentProfile } from "./profiles";
import { materializeLlmRunnerConnection, materializeSdkFallbackConnection, type RunnerSpec } from "./runner";
import { type AgentFailureReason, type AgentRunResult, type RunAgentOptions, runAgent } from "./spawn";

export interface RunExecutionOptions {
  /** Direct-LLM transport; defaults to {@link chatCompletion}. */
  readonly chat?: typeof chatCompletion;
  /** Direct-LLM retry telemetry. */
  readonly onRetryAttempt?: () => void;
  /** Agent spawn; defaults to {@link runAgent}. */
  readonly runAgent?: (profile: AgentProfile, prompt: string, opts: RunAgentOptions) => Promise<AgentRunResult>;
  /** OpenCode SDK dispatch; defaults to {@link runOpencodeSdk}. */
  readonly runSdk?: (
    profile: AgentProfile,
    prompt: string,
    opts: RunAgentOptions,
    fallbackConnection?: LlmConnectionConfig,
  ) => Promise<AgentRunResult>;
  /**
   * Operational overrides: stdio, parseOutput, signal, envSource, spawn,
   * timers and onEvent. The request's timeout, cwd and env are not replaced.
   */
  readonly runOptions?: Partial<RunAgentOptions>;
  /** Stamped into the child env as `AKM_EVENT_SOURCE` (usage-event provenance). */
  readonly eventSource?: string;
}

const OPERATIONAL_OPTIONS = [
  "stdio",
  "parseOutput",
  "signal",
  "envSource",
  "spawn",
  "setTimeoutFn",
  "clearTimeoutFn",
  "onEvent",
] as const;

/** Every value that can reach one dispatch and must never be echoed back: credentials and secret-looking env. */
export function collectDispatchSensitiveValues(
  runner: RunnerSpec,
  opts: RunAgentOptions,
  envSource: NodeJS.ProcessEnv = opts.envSource ?? process.env,
): string[] {
  const values: (string | undefined)[] = [];
  if (runner.kind === "llm") {
    values.push(
      runner.connection.apiKey,
      lookupCredentialFromEnv(runner.credential, envSource),
      runner.apiKeyFile ? lookupApiKeyFileValue(runner.apiKeyFile) : undefined,
      runner.apiKeySecretRef ? lookupApiKeySecretRefValue(runner.apiKeySecretRef) : undefined,
    );
  } else {
    if (runner.kind === "sdk") {
      values.push(
        runner.fallbackConnection?.apiKey,
        lookupCredentialFromEnv(runner.fallbackCredential, envSource),
        runner.fallbackApiKeyFile ? lookupApiKeyFileValue(runner.fallbackApiKeyFile) : undefined,
        runner.fallbackApiKeySecretRef ? lookupApiKeySecretRefValue(runner.fallbackApiKeySecretRef) : undefined,
      );
    }
    values.push(...Object.values(runner.profile.env ?? {}));
    for (const name of runner.profile.envPassthrough) {
      if (!isEnvPassthroughValueSafeToExpose(name, envSource[name])) values.push(envSource[name]);
    }
  }
  for (const [name, value] of Object.entries(opts.env ?? {})) {
    if (!isEnvPassthroughValueSafeToExpose(name, value)) values.push(value);
  }
  return collectSensitiveValues(values);
}

function redactResult(result: AgentRunResult, sensitiveValues: readonly string[]): AgentRunResult {
  return {
    ...result,
    stdout: redactSensitiveText(result.stdout, sensitiveValues),
    stderr: redactSensitiveText(result.stderr, sensitiveValues),
    ...(result.error !== undefined ? { error: redactSensitiveText(result.error, sensitiveValues) } : {}),
    ...(result.parsed !== undefined ? { parsed: redactSensitiveValue(result.parsed, sensitiveValues) } : {}),
  };
}

function llmFailureReason(error: unknown): AgentFailureReason {
  if (!(error instanceof LlmCallError)) return "spawn_failed";
  switch (error.code) {
    case "aborted":
      return "aborted";
    case "timeout":
      return "timeout";
    case "rate_limited":
      return "llm_rate_limit";
    case "parse_error":
    case "provider_html_error":
      return "parse_error";
    default:
      return "spawn_failed";
  }
}

type LlmCall = (connection: LlmConnectionConfig, opts: RunAgentOptions) => Promise<AgentRunResult>;

async function dispatchRunner(
  runner: RunnerSpec,
  prompt: string,
  opts: RunAgentOptions,
  seams: RunExecutionOptions,
  llm?: LlmCall,
): Promise<AgentRunResult> {
  const envSource = opts.envSource ?? process.env;
  const secrets = collectDispatchSensitiveValues(runner, opts, envSource);
  let result: AgentRunResult;
  switch (runner.kind) {
    case "llm": {
      if (!llm) throw new Error("an llm runner dispatches only a built execution's chat messages");
      const connection = materializeLlmRunnerConnection(runner, envSource);
      if (connection.apiKey) secrets.push(connection.apiKey);
      result = await llm(connection, opts);
      break;
    }
    case "agent":
      result = await (seams.runAgent ?? runAgent)(runner.profile, prompt, opts);
      break;
    case "sdk": {
      const fallbackConnection = materializeSdkFallbackConnection(runner, envSource);
      if (fallbackConnection?.apiKey) secrets.push(fallbackConnection.apiKey);
      result = await (seams.runSdk ?? runOpencodeSdk)(runner.profile, prompt, opts, fallbackConnection);
      break;
    }
    default:
      return assertNever(runner);
  }
  return redactResult(result, collectSensitiveValues(secrets));
}

/** Run a built execution. Credentials are read here, once per call, and never returned. */
export async function runExecution(
  execution: BuiltExecution,
  options: RunExecutionOptions = {},
): Promise<AgentRunResult> {
  const opts: RunAgentOptions = { ...execution.options };
  const operational = options.runOptions ?? {};
  for (const key of OPERATIONAL_OPTIONS) {
    if (operational[key] !== undefined) (opts as Record<string, unknown>)[key] = operational[key];
  }
  if (options.eventSource !== undefined) {
    opts.env = { ...execution.options.env, AKM_EVENT_SOURCE: options.eventSource };
  }
  const chat = options.chat ?? chatCompletion;
  const llm: LlmCall = async (connection, callOpts) => {
    const started = Date.now();
    try {
      const stdout = await chat(connection, [...(execution.messages ?? [])], {
        ...execution.chatOptions,
        ...(Object.hasOwn(callOpts, "timeoutMs") ? { timeoutMs: callOpts.timeoutMs } : {}),
        ...(callOpts.signal ? { signal: callOpts.signal } : {}),
        ...(options.onRetryAttempt ? { onRetryAttempt: options.onRetryAttempt } : {}),
      });
      return { ok: true, exitCode: 0, stdout, stderr: "", durationMs: Date.now() - started };
    } catch (error) {
      // Returned rather than thrown so the redaction below covers provider bodies.
      return {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
        reason: llmFailureReason(error),
        ...(error instanceof LlmCallError ? { llmErrorCode: error.code } : {}),
      };
    }
  };
  return dispatchRunner(execution.runner, execution.prompt, opts, options, llm);
}

export interface InteractiveAgentInvocationOptions {
  readonly config: AkmConfig;
  readonly engine: string;
  readonly timeoutMs?: number;
  readonly cwd?: string;
}

export interface InteractiveAgentInvocationResult {
  readonly engine: string;
  readonly result: AgentRunResult;
}

/** `akm agent`: launch an agent engine interactively, with no prompt of its own. */
export async function executeInteractiveAgentInvocation(
  input: InteractiveAgentInvocationOptions,
  seams: Pick<RunExecutionOptions, "runAgent" | "runSdk"> = {},
): Promise<InteractiveAgentInvocationResult> {
  const runner = resolveEngine(input.engine, input.config);
  if (runner.kind === "llm") {
    throw new UsageError(
      `Engine "${input.engine}" is an LLM engine; akm agent requires an agent engine.`,
      "INVALID_FLAG_VALUE",
    );
  }
  const opts: RunAgentOptions = {
    stdio: runner.kind === "sdk" ? runner.profile.stdio : "interactive",
    parseOutput: "text",
    ...(input.timeoutMs !== undefined
      ? { timeoutMs: input.timeoutMs }
      : runner.timeoutMs !== undefined
        ? { timeoutMs: runner.timeoutMs }
        : {}),
    ...(input.cwd ? { cwd: input.cwd } : runner.profile.workspace ? { cwd: runner.profile.workspace } : {}),
  };
  return { engine: input.engine, result: await dispatchRunner(runner, "", opts, seams) };
}

/**
 * Close the `opencode serve` children the SDK runner keeps for reuse. Its own
 * teardown hangs off `process.once("exit")`, which never fires while a child
 * holds the event loop open, so the CLI and workflow engine call this in
 * `finally` blocks. A no-op when no SDK server was started.
 */
export async function disposeDispatchResources(): Promise<void> {
  await disposeOpencodeSdkServers();
}

/**
 * Fail fast, before an operation makes any durable change, when `runner`'s
 * required credential is missing. Reads it and keeps nothing: every dispatch
 * reads it again.
 */
export function assertRunnerCredentials(runner: RunnerSpec, envSource?: NodeJS.ProcessEnv): void {
  if (runner.kind === "llm") materializeLlmRunnerConnection(runner, envSource);
  if (runner.kind === "sdk") materializeSdkFallbackConnection(runner, envSource);
}
