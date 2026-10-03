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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertNever } from "../../core/assert";
import type { AkmConfig, LlmConnectionConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import {
  collectSensitiveValues,
  isEnvPassthroughValueSafeToExpose,
  redactSensitiveText,
  redactSensitiveValue,
} from "../../core/redaction";
import { MODEL_WORK_POLICY_ID } from "../../execution/source";
import { chatCompletion, LlmCallError } from "../../llm/client";
import { emitLlmUsage, type LlmUsageErrorCode } from "../../llm/usage-telemetry";
import { getHarness } from "../harnesses";
import { closeServer as disposeOpencodeSdkServers, runOpencodeSdk } from "../harnesses/opencode-sdk/sdk-runner";
import { type AgentResultExtraction, modelFromArgs } from "./builder-shared";
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

const USAGE_ERROR_CODES: Partial<Record<AgentFailureReason, LlmUsageErrorCode>> = {
  timeout: "timeout",
  aborted: "aborted",
  parse_error: "parse_error",
  llm_rate_limit: "rate_limited",
};

/**
 * The model an agent or SDK dispatch ran: the request's, else the one an agent
 * CLI's own `args` select, which its command carries when the request names
 * none. An SDK server never sees `args`, so an SDK engine with no model named
 * has none to report: opencode picks it.
 */
function dispatchedModel({ request, runner }: BuiltExecution): string | undefined {
  return request.model?.resolved ?? (runner.kind === "agent" ? modelFromArgs(runner.profile.args) : undefined);
}

/**
 * One usage record for an agent or SDK dispatch, through the same sink and
 * ambient `withLlmStage` attribution as the LLM transport's per-HTTP-attempt
 * records: the model it ran, and tokens when the runner reported them.
 */
function recordDispatchUsage(execution: BuiltExecution, result: AgentRunResult): void {
  const { inputTokens, outputTokens, reasoningTokens } = result.usage ?? {};
  const reported = [inputTokens, outputTokens, reasoningTokens].filter((count) => count !== undefined);
  const model = dispatchedModel(execution);
  emitLlmUsage({
    outcome: result.ok ? "success" : "error",
    modelSource: "configured",
    ...(model ? { model } : {}),
    durationMs: result.durationMs,
    ...(inputTokens !== undefined ? { promptTokens: inputTokens } : {}),
    ...(outputTokens !== undefined ? { completionTokens: outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(reported.length > 0 ? { totalTokens: reported.reduce((sum, count) => sum + count, 0) } : {}),
    ...(result.ok ? {} : { errorCode: (result.reason && USAGE_ERROR_CODES[result.reason]) ?? "unknown_error" }),
  });
}

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

/**
 * The scratch working directory for one model-work dispatch on an agent or SDK
 * engine, so the edit the model-work tool policy grants never reaches the
 * stash.
 */
function createModelWorkDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "akm-model-work-"));
}

/**
 * Run a built execution. Credentials are read here, once per call, and never
 * returned. Model work on an agent or SDK engine runs in a scratch working
 * directory that akm creates for the dispatch and removes after it, and must
 * end with an answer: an agent that stops with none (opencode at its step
 * limit, for one) has failed with `parse_error`.
 */
export async function runExecution(
  execution: BuiltExecution,
  options: RunExecutionOptions = {},
): Promise<AgentRunResult> {
  const scratch =
    execution.runner.kind !== "llm" && execution.request.authorization.policy?.id === MODEL_WORK_POLICY_ID
      ? createModelWorkDirectory()
      : undefined;
  try {
    return await runBuiltExecution(execution, options, scratch);
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** A successful reply's text, unwrapped from its harness's framing (claude's `--output-format json` result envelope, for one). */
export function unwrapHarnessReply(runner: RunnerSpec, result: AgentRunResult): AgentResultExtraction {
  const extractor =
    runner.kind === "agent" ? getHarness(runner.profile.platform ?? runner.profile.name)?.resultExtractor : undefined;
  return extractor ? extractor(result) : { text: result.stdout };
}

/** A model-work reply's answer: its harness's framing stripped, and no answer is a `parse_error`. */
function modelWorkAnswer(runner: RunnerSpec, result: AgentRunResult): AgentRunResult {
  const extracted = unwrapHarnessReply(runner, result);
  const answer = {
    ...result,
    stdout: extracted.text,
    ...(extracted.sessionId ? { sessionId: extracted.sessionId } : {}),
  };
  if (extracted.text.trim() !== "") return answer;
  return { ...answer, ok: false, reason: "parse_error", error: `Engine "${runner.engine}" returned no answer.` };
}

/** `scratch` is the model-work working directory, set only for model work on an agent or SDK engine. */
async function runBuiltExecution(
  execution: BuiltExecution,
  options: RunExecutionOptions,
  scratch: string | undefined,
): Promise<AgentRunResult> {
  const opts: RunAgentOptions = { ...execution.options, ...(scratch ? { cwd: scratch } : {}) };
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
  let result = await dispatchRunner(execution.runner, execution.prompt, opts, options, llm);
  if (scratch !== undefined && result.ok) result = modelWorkAnswer(execution.runner, result);
  // The LLM transport records each HTTP attempt itself.
  if (execution.runner.kind !== "llm") recordDispatchUsage(execution, result);
  return result;
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
