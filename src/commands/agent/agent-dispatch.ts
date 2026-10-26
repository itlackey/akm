// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm agent [--connection <name> | --harness <name>] [--prompt <text>]`
 *
 * Dispatch an agent on a named harness (or connection), optionally injecting an inline prompt.
 * Stored commands execute only through `akm command run`; workflows execute
 * only through the workflow runtime.
 *
 * With a prompt the agent runs it and its reply is printed. Without one the harness
 * is started interactively (a model may be named); a connection has nothing to start,
 * and a persona, inference or output schema needs a task to apply to.
 *
 * The prompt arm uses the canonical command invocation path; the prompt-free arm starts
 * the harness itself (`executeInteractiveAgentInvocation`).
 */

import type { AkmConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { warn } from "../../core/warn";
import type { LoweringNotice } from "../../execution/resolved-request";
import { isPortableExecutionAgentSelector, type UnresolvedExecutionDefaults } from "../../execution/source";
import { executeInteractiveAgentInvocation } from "../../integrations/agent/runner-dispatch";
import { executeCommandInvocation, type PrepareCommandInvocationOptions } from "../command/command-execution";

export interface AkmAgentDispatchOptions {
  prompt?: string;
  /** Portable agent asset ref used by the canonical command path. */
  agentRef?: string;
  agentConfig?: AkmConfig;
  timeoutMs?: number;
  /**
   * Working directory resolved into the canonical execution runtime: the
   * directory the run's process starts in.
   */
  cwd?: string;
  /** Current invocation-layer selections consumed by the execution cascade. */
  selection?: Pick<
    UnresolvedExecutionDefaults,
    "connection" | "harness" | "engine" | "model" | "inference" | "outputSchema"
  >;
}

export interface AkmAgentDispatchSeams {
  readonly executeCommand?: (options: PrepareCommandInvocationOptions) => Promise<AkmAgentDispatchResult>;
  readonly executeInteractive?: typeof executeInteractiveAgentInvocation;
}

export interface AkmAgentDispatchResult {
  schemaVersion: 2;
  ok: boolean;
  shape: "agent-result";
  engine: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
  reason?: string;
  /** The harness's own session id when it exposes one (kept in the harness's history, #1100). */
  sessionId?: string;
  /** Non-fatal announcements, surfaced here so JSON consumers see them alongside the stderr `warn()`. */
  warnings?: readonly string[];
  /** Secret-free optimistic-lowering diagnostics from the selected harness adapter. */
  notices?: readonly Readonly<LoweringNotice>[];
}

function canonicalCurrent(options: AkmAgentDispatchOptions): UnresolvedExecutionDefaults {
  const current: Record<string, unknown> = {};
  if (options.agentRef !== undefined) current.agent = options.agentRef;
  if (options.selection?.connection !== undefined) current.connection = options.selection.connection;
  if (options.selection?.harness !== undefined) current.harness = options.selection.harness;
  if (options.selection?.engine !== undefined) current.engine = options.selection.engine;
  if (options.selection?.model !== undefined) current.model = options.selection.model;
  if (Object.hasOwn(options.selection ?? {}, "inference")) current.inference = options.selection?.inference;
  if (options.selection?.outputSchema !== undefined) current.outputSchema = options.selection.outputSchema;
  if (options.timeoutMs !== undefined) current.timeout = options.timeoutMs;
  if (options.cwd !== undefined) current.workspace = options.cwd;
  return current as UnresolvedExecutionDefaults;
}

function rejectInvalidAgentRef(agentRef: string | undefined): void {
  if (agentRef === undefined || isPortableExecutionAgentSelector(agentRef)) return;
  throw new UsageError(
    `agent expects an agent asset ref under agents/...; received ${JSON.stringify(agentRef)}.`,
    "INVALID_FLAG_VALUE",
  );
}

/**
 * Dispatch a `--prompt` / `--prompt-stdin` task through the canonical command
 * path. The prompt is a person's free text, not a template: it is sent to the
 * agent verbatim (`inlineContentMode: "literal"`), so prose containing `}}`
 * from compact JSON, a `$VAR`, a shell snippet, or an `@path` reaches the
 * agent instead of being rejected as an unsupported template construct.
 */
async function delegateCanonicalCommand(
  options: AkmAgentDispatchOptions,
  seams: AkmAgentDispatchSeams,
  action: { readonly content: string },
): Promise<AkmAgentDispatchResult> {
  const execute = seams.executeCommand ?? executeCommandInvocation;
  const result = await execute({
    action,
    inlineContentMode: "literal",
    config: options.agentConfig as AkmConfig,
    current: canonicalCurrent(options),
  });
  for (const message of result.warnings ?? []) warn(message);
  return result;
}

export async function akmAgentDispatch(
  options: AkmAgentDispatchOptions,
  seams: AkmAgentDispatchSeams = {},
): Promise<AkmAgentDispatchResult> {
  if (!options.agentConfig)
    throw new UsageError("agent requires a valid config with a harness or connection.", "MISSING_REQUIRED_ARGUMENT");

  rejectInvalidAgentRef(options.agentRef);

  if (options.prompt !== undefined) return delegateCanonicalCommand(options, seams, { content: options.prompt });

  // No prompt: the harness is started for a person. Only where and which model ride along; the rest needs a task.
  const { connection, harness, engine, model, ...needsTask } = options.selection ?? {};
  if (options.agentRef !== undefined || Object.keys(needsTask).length > 0) {
    throw new UsageError(
      "An agent persona, inference setting or output schema applies to a task: pass --prompt or --prompt-stdin. Without a prompt only the harness (and a model) is started.",
      "MISSING_REQUIRED_ARGUMENT",
    );
  }

  const executeInteractive = seams.executeInteractive ?? executeInteractiveAgentInvocation;
  const execution = await executeInteractive({
    config: options.agentConfig,
    ...(typeof connection === "string" ? { connection } : {}),
    ...(typeof harness === "string" ? { harness } : {}),
    ...(typeof engine === "string" ? { engine } : {}),
    ...(typeof model === "string" ? { model } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  });
  const result = execution.result;

  return {
    schemaVersion: 2 as const,
    ok: result.ok,
    shape: "agent-result",
    engine: execution.engine,
    exitCode: result.exitCode,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs: result.durationMs,
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
  };
}
