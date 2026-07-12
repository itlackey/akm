// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm agent [--engine <name>] [--prompt <text>] [--command <ref>] [--workflow <ref>] [args...]`
 *
 * Dispatch an agent by named engine, optionally injecting a prompt from
 * inline text, a stash command: asset, or a stash workflow: asset.
 *
 * When none of --prompt, --command, or --workflow are given, the agent is
 * launched interactively (no injected prompt).
 *
 * Template placeholders (`{{0}}`, `{{1}}`, ...) in the loaded asset body are
 * filled from the extra positional args in order.
 */

import fs from "node:fs";
import { parseAssetRef } from "../../core/asset/asset-ref";
import type { AkmConfig } from "../../core/config/config";
import { NotFoundError, UsageError } from "../../core/errors";
import type { AgentDispatchRequest } from "../../integrations/agent/builders";
import { resolveEngine } from "../../integrations/agent/engine-resolution";
import { executeRunner } from "../../integrations/agent/runner-dispatch";
import type { AgentRunResult } from "../../integrations/agent/spawn";

export interface AkmAgentDispatchOptions {
  engine?: string;
  prompt?: string;
  commandRef?: string;
  workflowRef?: string;
  args?: string[];
  agentConfig?: AkmConfig;
  timeoutMs?: number;
  /**
   * Working directory for the spawned agent CLI. Not honoured by the
   * opencode-sdk path (the SDK server is process-wide; see the plan's open
   * seam decision on per-call cwd).
   */
  cwd?: string;
  /**
   * When present, the platform-specific AgentCommandBuilder uses these fields
   * to construct the argv (system prompt, model alias, tool policy). When
   * absent, falls back to the legacy positional-prompt behaviour.
   */
  dispatch?: AgentDispatchRequest;
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
}

/**
 * Fill `{{0}}`, `{{1}}`, ... placeholders in `template` with the
 * corresponding entries in `args`. Any placeholder index that exceeds the
 * args array is left as-is.
 */
function fillPlaceholders(template: string, args: string[]): string {
  return template.replace(/\{\{(\d+)\}\}/g, (match, idx) => {
    const i = Number.parseInt(idx, 10);
    return i < args.length ? args[i] : match;
  });
}

/**
 * Resolve the body of an asset by ref string. The ref must parse as a
 * valid asset ref (e.g. `command:my-cmd`, `workflow:my-flow`). The file
 * must exist on disk (the index provides the file path).
 *
 * Throws `NotFoundError` when the ref cannot be resolved.
 */
async function resolveAssetBody(ref: string): Promise<string> {
  let parsed: ReturnType<typeof parseAssetRef>;
  try {
    parsed = parseAssetRef(ref);
  } catch (err) {
    throw new UsageError(
      `Invalid asset ref "${ref}": ${err instanceof Error ? err.message : String(err)}`,
      "INVALID_FLAG_VALUE",
    );
  }

  // Lazy import to avoid pulling the full indexer at startup.
  const { lookup } = await import("../../indexer/indexer.js");
  const entry = await lookup(parsed);
  if (!entry) {
    throw new NotFoundError(`Asset "${ref}" not found in the index. Run \`akm index\` to rebuild the index.`);
  }

  try {
    return fs.readFileSync(entry.filePath, "utf8");
  } catch (err) {
    throw new NotFoundError(
      `Asset "${ref}" is indexed but the file could not be read (${entry.filePath}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function akmAgentDispatch(options: AkmAgentDispatchOptions): Promise<AkmAgentDispatchResult> {
  if (!options.agentConfig)
    throw new UsageError("agent requires a valid config with an agent engine.", "MISSING_REQUIRED_ARGUMENT");
  const engineName = options.engine ?? options.agentConfig.defaults?.engine;
  if (!engineName) throw new UsageError("agent requires --engine or defaults.engine.", "MISSING_REQUIRED_ARGUMENT");
  const runner = resolveEngine(engineName, options.agentConfig);
  if (runner.kind === "llm") {
    throw new UsageError(
      `Engine "${engineName}" is an LLM engine; akm agent requires an agent engine.`,
      "INVALID_FLAG_VALUE",
    );
  }
  const profile = runner.profile;

  // Resolve the prompt text from whichever source was provided.
  let prompt: string | undefined;

  if (options.commandRef) {
    const body = await resolveAssetBody(options.commandRef);
    prompt = options.args?.length ? fillPlaceholders(body, options.args) : body;
  } else if (options.workflowRef) {
    const body = await resolveAssetBody(options.workflowRef);
    prompt = options.args?.length ? fillPlaceholders(body, options.args) : body;
  } else if (options.prompt !== undefined) {
    prompt = options.prompt;
  }
  // When prompt is undefined, the agent is launched interactively.

  const stdio = prompt === undefined && runner.kind !== "sdk" ? ("interactive" as const) : profile.stdio;
  // Build the final dispatch request: merge the caller-supplied dispatch with
  // the resolved prompt so the builder has all context in one place.
  const dispatchRequest: AgentDispatchRequest | undefined = options.dispatch
    ? { ...options.dispatch, prompt: prompt ?? options.dispatch.prompt }
    : undefined;

  const runOptions = {
    stdio,
    parseOutput: "text" as const,
    ...(options.args?.length && !options.commandRef && !options.workflowRef ? { args: options.args } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(dispatchRequest !== undefined ? { dispatch: dispatchRequest } : {}),
  };
  const result: AgentRunResult = await executeRunner(runner, prompt ?? "", runOptions);

  return {
    schemaVersion: 2 as const,
    ok: result.ok,
    shape: "agent-result",
    engine: engineName,
    exitCode: result.exitCode,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs: result.durationMs,
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
  };
}
