// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm agent [--engine <name>] [--prompt <text>]`
 *
 * Dispatch an agent by named engine, optionally injecting an inline prompt.
 * Stored commands execute only through `akm command run`; workflows execute
 * only through the workflow runtime.
 *
 * When no prompt, agent selector, or model is given, the
 * native agent is launched interactively with no dispatch payload.
 *
 * Every noninteractive arm uses the canonical command invocation path. The
 * prompt-free arm uses the shared payload-free interactive execution lowerer.
 */

import type { AkmConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { warn } from "../../core/warn";
import type { LoweringNotice } from "../../execution/resolved-request";
import { isPortableExecutionAgentSelector, type UnresolvedExecutionDefaults } from "../../execution/source";
import {
  fallbackAnnouncement,
  NO_ENGINE_MESSAGE_SUFFIX,
  NO_ENGINE_REMEDY,
  withEngineFallback,
} from "../../integrations/agent/engine-fallback";
import { executeInteractiveAgentInvocation } from "../../integrations/agent/runner-dispatch";
import { executeCommandInvocation, type PrepareCommandInvocationOptions } from "../command/command-execution";

export interface AkmAgentDispatchOptions {
  engine?: string;
  prompt?: string;
  /** Portable agent asset ref used by the canonical command path. */
  agentRef?: string;
  agentConfig?: AkmConfig;
  timeoutMs?: number;
  /**
   * Working directory resolved into the canonical execution runtime. The SDK
   * forwards it as its per-session directory query.
   */
  cwd?: string;
  /** Current invocation-layer selections consumed by the execution cascade. */
  selection?: Pick<UnresolvedExecutionDefaults, "model" | "inference" | "outputSchema" | "tools">;
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
  /**
   * Non-fatal announcements — today only the implicit `opencode-sdk` engine
   * fallback (`integrations/agent/engine-fallback.ts`), surfaced here so JSON
   * consumers see it alongside the stderr `warn()`.
   */
  warnings?: readonly string[];
  /** Secret-free optimistic-lowering diagnostics from the selected engine adapter. */
  notices?: readonly Readonly<LoweringNotice>[];
}

function canonicalCurrent(options: AkmAgentDispatchOptions): UnresolvedExecutionDefaults {
  const current: Record<string, unknown> = {};
  if (options.agentRef !== undefined) current.agent = options.agentRef;
  if (options.engine !== undefined) current.engine = options.engine;
  if (options.selection?.model !== undefined) current.model = options.selection.model;
  if (Object.hasOwn(options.selection ?? {}, "inference")) current.inference = options.selection?.inference;
  if (options.selection?.outputSchema !== undefined) current.outputSchema = options.selection.outputSchema;
  if (options.selection?.tools !== undefined) current.tools = options.selection.tools;
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
    throw new UsageError("agent requires a valid config with an agent engine.", "MISSING_REQUIRED_ARGUMENT");

  rejectInvalidAgentRef(options.agentRef);

  const hasResolvedSelection = options.agentRef !== undefined || options.selection !== undefined;
  if (options.prompt !== undefined || hasResolvedSelection) {
    if (options.prompt === undefined) {
      throw new UsageError(
        "Agent persona/model/tool/schema/inference selection requires an explicit task from --prompt or --prompt-stdin; it cannot fabricate an empty command. Omit those selections for a prompt-free interactive launch.",
        "MISSING_REQUIRED_ARGUMENT",
      );
    }
    return delegateCanonicalCommand(options, seams, { content: options.prompt });
  }

  // Same implicit opencode-sdk fallback the workflow and task surfaces apply,
  // so an engine-less install is usable everywhere or nowhere — not a mix.
  const { config: agentConfig, fallbackEngineName } = withEngineFallback(options.agentConfig);
  const engineName = options.engine ?? agentConfig.defaults?.engine;
  // Announced, never silent: `options.engine` outranks the default, so the
  // fallback is only reportable when it is the engine actually selected.
  const engineAnnouncement = fallbackAnnouncement(fallbackEngineName, engineName);
  if (engineAnnouncement) warn(engineAnnouncement);
  if (!engineName)
    throw new UsageError(`agent ${NO_ENGINE_MESSAGE_SUFFIX} ${NO_ENGINE_REMEDY}`, "MISSING_REQUIRED_ARGUMENT");
  const executeInteractive = seams.executeInteractive ?? executeInteractiveAgentInvocation;
  const execution = await executeInteractive({
    config: agentConfig,
    engine: engineName,
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
    ...(engineAnnouncement ? { warnings: [engineAnnouncement] } : {}),
  };
}
