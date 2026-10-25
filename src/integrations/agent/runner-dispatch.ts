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
import { UsageError } from "../../core/errors";
import type { LlmInference } from "../../core/llm-inference";
import { collectSensitiveValues, isEnvPassthroughValueSafeToExpose, redactSensitiveText } from "../../core/redaction";
import type { ExecutionJsonObject } from "../../execution/json";
import { type ChatCompletionConfig, chatCompletion, LlmCallError } from "../../llm/client";
import { emitLlmUsage, type LlmUsageErrorCode } from "../../llm/usage-telemetry";
import { getHarness } from "../harnesses";
import { modelFromArgs } from "../harnesses/harness";
import { closeOpencodeSdk } from "../harnesses/opencode/embedded/host";
import { runOpencodeSdk } from "../harnesses/opencode/embedded/run";
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
  readonly runAgent?: (profile: AgentProfile, opts: RunAgentOptions) => Promise<AgentRunResult>;
  /** Internal runtime dispatch; defaults to {@link runOpencodeSdk}. */
  readonly runSdk?: (
    profile: AgentProfile,
    prompt: string,
    opts: RunAgentOptions,
    connection: ChatCompletionConfig,
  ) => Promise<AgentRunResult>;
  /** Cancels the dispatch: a child gets SIGTERM then SIGKILL, a chat or runtime session is interrupted. */
  readonly signal?: AbortSignal;
  /** Stamped into the child env as `AKM_EVENT_SOURCE` (usage-event provenance). */
  readonly eventSource?: string;
}

/**
 * Every value that can reach one dispatch and must never be echoed back: credentials and unsafe passthrough env.
 * A request's own `env` is configuration; a caller's secret values are redacted through its own sensitive set.
 */
export function collectDispatchSensitiveValues(
  runner: RunnerSpec,
  envSource: NodeJS.ProcessEnv = process.env,
): string[] {
  const values: (string | undefined)[] = [];
  if (runner.kind === "connection") {
    values.push(resolveApiKey(runner.apiKey, runner.name, envSource, true));
  } else {
    for (const name of harnessProfile(runner).envPassthrough) {
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
  /** Model work that runs an agent: a CLI it spawns runs in a scratch directory. */
  readonly confined?: boolean;
}

/** `llm` is given for a direct chat; without it a connection runs akm's internal runtime. */
async function dispatchRunner(
  { runner, profile, inference, confined }: DispatchTarget,
  prompt: string,
  opts: RunAgentOptions,
  seams: RunExecutionOptions,
  llm?: LlmCall,
): Promise<AgentRunResult> {
  const secrets = collectDispatchSensitiveValues(runner);
  let result: AgentRunResult;
  if (runner.kind === "harness") {
    const harnessRunProfile = profile ?? harnessProfile(runner);
    // A harness may run a captured request in akm's process (OpenCode 2, embedded); an interactive launch
    // hands the terminal to its CLI, and a test's `runAgent` seam stands for the CLI.
    const inProcess =
      seams.runAgent === undefined && opts.stdio !== "interactive"
        ? getHarness(runner.platform)?.runInProcess?.(harnessRunProfile, prompt, opts)
        : undefined;
    const spawn = (spawnOpts: RunAgentOptions) => (seams.runAgent ?? runAgent)(harnessRunProfile, spawnOpts);
    result = await (inProcess ?? (confined ? inScratchDirectory(opts, spawn) : spawn(opts)));
  } else {
    const connection = materializeConnection(runner, inference);
    if (connection.apiKey) secrets.push(connection.apiKey);
    result = llm
      ? await llm(connection, opts)
      : await (seams.runSdk ?? runOpencodeSdk)(profile ?? runtimeProfile(runner), prompt, opts, connection);
  }
  return redactResult(result, collectSensitiveValues(secrets));
}

/**
 * Run `work` in a scratch working directory that akm creates for it and removes
 * after, so the edit that model work on a CLI harness cannot be denied never
 * reaches the stash.
 */
async function inScratchDirectory(
  opts: RunAgentOptions,
  work: (opts: RunAgentOptions) => Promise<AgentRunResult>,
): Promise<AgentRunResult> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "akm-model-work-"));
  try {
    return await work({ ...opts, cwd: scratch });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Whether this execution is model work that runs an agent (not a direct chat). */
function isConfinedAgentWork(execution: BuiltExecution): boolean {
  return execution.request.modelWork && execution.messages === undefined;
}

/** A model-work reply must end with an answer: an agent that stops with none (opencode at its step limit, for one) has failed. */
function modelWorkAnswer(runner: RunnerSpec, result: AgentRunResult): AgentRunResult {
  if (result.stdout.trim() !== "") return result;
  return { ...result, ok: false, reason: "parse_error", error: `"${runner.name}" returned no answer.` };
}

/**
 * Run a built execution. Credentials are read here, once per call, and never
 * returned. Model work on a harness runs confined: in a scratch working
 * directory when it is a CLI (the OpenCode 2 harness runs in its own fixed one),
 * and it must end with an answer: an agent that stops with none (opencode at its
 * step limit, for one) has failed with `parse_error`.
 */
export async function runExecution(
  execution: BuiltExecution,
  options: RunExecutionOptions = {},
): Promise<AgentRunResult> {
  const confined = isConfinedAgentWork(execution);
  const opts: RunAgentOptions = { ...execution.options };
  if (options.signal) opts.signal = options.signal;
  // Model work is akm's own traffic: its reads and its agents' commands are the improve pipeline's, never the
  // user's demand. A caller's source (a task, say) wins, as does one the unit's own `env:` binds.
  const eventSource =
    options.eventSource ??
    (execution.request.modelWork && execution.options.env?.AKM_EVENT_SOURCE === undefined ? "improve" : undefined);
  if (eventSource !== undefined) {
    opts.env = { ...execution.options.env, AKM_EVENT_SOURCE: eventSource };
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
      confined,
    },
    execution.prompt,
    opts,
    options,
    llm,
  );
  if (confined && result.ok) result = modelWorkAnswer(execution.runner, result);
  // The LLM transport records each HTTP attempt itself.
  if (llm === undefined) recordDispatchUsage(execution, result);
  return result;
}

export interface InteractiveAgentInvocationOptions {
  readonly config: AkmConfig;
  /** What to launch, by name; omitted means the default harness. */
  readonly connection?: string;
  readonly harness?: string;
  /** The model it starts with, as an alias or an exact name. */
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly cwd?: string;
}

export interface InteractiveAgentInvocationResult {
  /** What was launched: the name of the harness or connection. */
  readonly engine: string;
  readonly result: AgentRunResult;
}

/**
 * `akm agent` with no prompt: start the harness for a person to use, with the terminal
 * inherited and nothing to run (no `-p`, no empty turn). A connection has nothing
 * interactive to start, so it is refused rather than billed for an empty turn.
 */
export async function executeInteractiveAgentInvocation(
  input: InteractiveAgentInvocationOptions,
  seams: Pick<RunExecutionOptions, "runAgent"> = {},
): Promise<InteractiveAgentInvocationResult> {
  const runner = resolveTarget({
    config: input.config,
    layers: [
      ...(input.connection === undefined ? [] : [{ connection: input.connection }]),
      ...(input.harness === undefined ? [] : [{ harness: input.harness }]),
      ...(input.model === undefined ? [] : [{ model: input.model }]),
    ],
  });
  if (runner.kind === "connection") {
    throw new UsageError(
      `"${runner.name}" is a connection, which has nothing to start interactively. Pass --prompt, or name a harness.`,
      "MISSING_REQUIRED_ARGUMENT",
    );
  }
  const opts: RunAgentOptions = {
    stdio: "interactive",
    timeoutMs: input.timeoutMs ?? runner.timeoutMs,
    ...(input.cwd ? { cwd: input.cwd } : runner.workspace ? { cwd: runner.workspace } : {}),
    dispatch: { ...(runner.model ? { model: runner.model } : {}), ...(runner.agent ? { agent: runner.agent } : {}) },
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
