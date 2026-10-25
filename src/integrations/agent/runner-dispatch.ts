// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Run a built execution: the one place credentials are read. Model work on a
 * connection goes to `chatCompletion`, a harness to `runAgent` (the harness
 * builder turns the request into argv), and agent work on a connection to
 * `runOpencodeSdk`, akm's own runtime. Every credential and passthrough value
 * that could reach the child is redacted from the result.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AkmConfig } from "../../core/config/config";
import { resolveApiKey } from "../../core/config/credentials";
import type { LlmInference } from "../../core/llm-inference";
import {
  collectSensitiveValues,
  isEnvPassthroughValueSafeToExpose,
  redactSensitiveText,
  redactSensitiveValue,
} from "../../core/redaction";
import type { ExecutionJsonObject } from "../../execution/json";
import { type ChatCompletionConfig, chatCompletion, LlmCallError } from "../../llm/client";
import { emitLlmUsage, type LlmUsageErrorCode } from "../../llm/usage-telemetry";
import { getHarness } from "../harnesses";
import { closeOpencodeSdk } from "../harnesses/opencode/embedded/host";
import { runOpencodeSdk } from "../harnesses/opencode/embedded/run";
import { type AgentResultExtraction, modelFromArgs } from "./builder-shared";
import type { BuiltExecution } from "./execution";
import { type AgentProfile, harnessProfile, runtimeProfile } from "./profiles";
import { mergeLayerInference, resolveTarget } from "./resolution";
import type { ConnectionRunner, RunnerSpec } from "./runner";
import { type AgentFailureReason, type AgentRunResult, type RunAgentOptions, runAgent } from "./spawn";

export interface RunExecutionOptions {
  /** Direct-LLM transport; defaults to {@link chatCompletion}. */
  readonly chat?: typeof chatCompletion;
  /** Direct-LLM retry telemetry. */
  readonly onRetryAttempt?: () => void;
  /** Agent spawn; defaults to {@link runAgent}. */
  readonly runAgent?: (profile: AgentProfile, prompt: string, opts: RunAgentOptions) => Promise<AgentRunResult>;
  /** Internal runtime dispatch; defaults to {@link runOpencodeSdk}. */
  readonly runSdk?: (
    profile: AgentProfile,
    prompt: string,
    opts: RunAgentOptions,
    connection: ChatCompletionConfig,
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

/**
 * Every value that can reach one dispatch and must never be echoed back: credentials and unsafe passthrough env.
 * `opts.env` is configuration; a caller's secret values are redacted through its own sensitive set.
 */
export function collectDispatchSensitiveValues(
  runner: RunnerSpec,
  opts: RunAgentOptions,
  envSource: NodeJS.ProcessEnv = opts.envSource ?? process.env,
): string[] {
  const values: (string | undefined)[] = [];
  if (runner.kind === "connection") {
    values.push(resolveApiKey(runner.apiKey, runner.name, envSource, true));
  } else {
    const profile = harnessProfile(runner);
    values.push(...Object.values(profile.env ?? {}));
    for (const name of profile.envPassthrough) {
      if (!isEnvPassthroughValueSafeToExpose(name, envSource[name])) values.push(envSource[name]);
    }
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

type LlmCall = (connection: ChatCompletionConfig, opts: RunAgentOptions) => Promise<AgentRunResult>;

const USAGE_ERROR_CODES: Partial<Record<AgentFailureReason, LlmUsageErrorCode>> = {
  timeout: "timeout",
  aborted: "aborted",
  parse_error: "parse_error",
  llm_rate_limit: "rate_limited",
};

/**
 * The model an agent or runtime dispatch ran: the request's, else the one a
 * harness's own `args` select, which its command carries when the request names none.
 */
function dispatchedModel({ request, runner }: BuiltExecution): string | undefined {
  return request.model?.model ?? (runner.kind === "harness" ? modelFromArgs(runner.args) : undefined);
}

/**
 * One usage record for an agent or runtime dispatch, through the same sink and
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

/**
 * The chat connection a connection runner stands for: its key read now, and the
 * portable settings of the runner's choosing layers and of this call's request
 * (the request's nearer), which the client translates. The one place a
 * connection's key is read for a call.
 */
export function materializeConnection(
  runner: ConnectionRunner,
  inference?: LlmInference | null,
  envSource: NodeJS.ProcessEnv = process.env,
): ChatCompletionConfig {
  const apiKey = resolveApiKey(runner.apiKey, runner.name, envSource);
  const settings = mergeLayerInference([
    { inference: runner.inference as ExecutionJsonObject | undefined },
    { inference: inference as ExecutionJsonObject | null | undefined },
  ]) as LlmInference | null | undefined;
  return {
    endpoint: runner.endpoint,
    model: runner.model,
    request: runner.request,
    ...(settings ? { inference: settings } : {}),
    timeoutMs: runner.timeoutMs,
    ...(runner.contextLength !== undefined ? { contextLength: runner.contextLength } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}

/** What one dispatch needs: the runner, what it is spawned or run as, and the request's portable settings. */
interface DispatchTarget {
  readonly runner: RunnerSpec;
  readonly profile?: AgentProfile;
  readonly inference?: LlmInference | null;
}

/** `llm` is given for a direct chat; without it a connection runs akm's internal runtime. */
async function dispatchRunner(
  { runner, profile, inference }: DispatchTarget,
  prompt: string,
  opts: RunAgentOptions,
  seams: RunExecutionOptions,
  llm?: LlmCall,
): Promise<AgentRunResult> {
  const envSource = opts.envSource ?? process.env;
  const secrets = collectDispatchSensitiveValues(runner, opts, envSource);
  let result: AgentRunResult;
  if (runner.kind === "harness") {
    result = await (seams.runAgent ?? runAgent)(profile ?? harnessProfile(runner), prompt, opts);
  } else {
    const connection = materializeConnection(runner, inference, envSource);
    if (connection.apiKey) secrets.push(connection.apiKey);
    result = llm
      ? await llm(connection, opts)
      : await (seams.runSdk ?? runOpencodeSdk)(profile ?? runtimeProfile(runner), prompt, opts, connection);
  }
  return redactResult(result, collectSensitiveValues(secrets));
}

/**
 * The scratch working directory for one model-work dispatch on a harness or the
 * internal runtime, so the edit the model-work tool policy grants never reaches
 * the stash.
 */
function createModelWorkDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "akm-model-work-"));
}

/** Whether this execution is model work that runs an agent (not a direct chat), and so needs the scratch directory. */
function isConfinedAgentWork(execution: BuiltExecution): boolean {
  return execution.request.modelWork && execution.messages === undefined;
}

/**
 * Run a built execution. Credentials are read here, once per call, and never
 * returned. Model work on a harness or the internal runtime runs in a scratch
 * working directory that akm creates for the dispatch and removes after it, and
 * must end with an answer: an agent that stops with none (opencode at its step
 * limit, for one) has failed with `parse_error`.
 */
export async function runExecution(
  execution: BuiltExecution,
  options: RunExecutionOptions = {},
): Promise<AgentRunResult> {
  const scratch = isConfinedAgentWork(execution) ? createModelWorkDirectory() : undefined;
  try {
    return await runBuiltExecution(execution, options, scratch);
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** A successful reply's text, unwrapped from its harness's framing (claude's `--output-format json` result envelope, for one). */
export function unwrapHarnessReply(runner: RunnerSpec, result: AgentRunResult): AgentResultExtraction {
  const extractor = runner.kind === "harness" ? getHarness(runner.platform)?.resultExtractor : undefined;
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
  return { ...answer, ok: false, reason: "parse_error", error: `"${runner.name}" returned no answer.` };
}

/** `scratch` is the model-work working directory, set only for model work that runs an agent. */
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
  const llm: LlmCall | undefined =
    execution.messages === undefined
      ? undefined
      : async (connection, callOpts) => {
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
  let result = await dispatchRunner(
    {
      runner: execution.runner,
      ...(execution.profile ? { profile: execution.profile } : {}),
      inference: execution.request.inference as LlmInference | null | undefined,
    },
    execution.prompt,
    opts,
    options,
    llm,
  );
  if (scratch !== undefined && result.ok) result = modelWorkAnswer(execution.runner, result);
  // The LLM transport records each HTTP attempt itself.
  if (llm === undefined) recordDispatchUsage(execution, result);
  return result;
}

export interface InteractiveAgentInvocationOptions {
  readonly config: AkmConfig;
  /** The harness (or connection) to launch; omitted means the default. */
  readonly engine?: string;
  readonly timeoutMs?: number;
  readonly cwd?: string;
}

export interface InteractiveAgentInvocationResult {
  /** What was launched: the name of the harness or connection. */
  readonly engine: string;
  readonly result: AgentRunResult;
}

/** `akm agent`: launch an agent interactively, with no prompt of its own. */
export async function executeInteractiveAgentInvocation(
  input: InteractiveAgentInvocationOptions,
  seams: Pick<RunExecutionOptions, "runAgent" | "runSdk"> = {},
): Promise<InteractiveAgentInvocationResult> {
  const runner = resolveTarget({
    config: input.config,
    layers: input.engine === undefined ? [] : [{ engine: input.engine }],
  });
  const opts: RunAgentOptions = {
    stdio: runner.kind === "connection" ? "captured" : "interactive",
    parseOutput: "text",
    timeoutMs: input.timeoutMs ?? runner.timeoutMs,
    ...(input.cwd
      ? { cwd: input.cwd }
      : runner.kind === "harness" && runner.workspace
        ? { cwd: runner.workspace }
        : {}),
  };
  return { engine: runner.name, result: await dispatchRunner({ runner }, "", opts, seams) };
}

/**
 * Close the embedded OpenCode instances the internal runtime keeps for reuse. An
 * open one holds the event loop open, so the CLI and workflow engine call this
 * in `finally` blocks. A no-op when none was started.
 */
export async function disposeDispatchResources(): Promise<void> {
  await closeOpencodeSdk();
}
