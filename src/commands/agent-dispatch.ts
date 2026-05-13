/**
 * `akm agent <profile> [--prompt <text>] [--command <ref>] [--workflow <ref>] [args...]`
 *
 * Dispatch an agent by named profile, optionally injecting a prompt from
 * inline text, a stash command: asset, or a stash workflow: asset.
 *
 * When none of --prompt, --command, or --workflow are given, the agent is
 * launched interactively (no injected prompt).
 *
 * Template placeholders (`{{0}}`, `{{1}}`, ...) in the loaded asset body are
 * filled from the extra positional args in order.
 */

import fs from "node:fs";
import { parseAssetRef } from "../core/asset-ref";
import type { LlmConnectionConfig } from "../core/config";
import { NotFoundError, UsageError } from "../core/errors";
import type { AgentConfig } from "../integrations/agent/config";
import { requireAgentProfile } from "../integrations/agent/config";
import { runWithAgentRunner } from "../integrations/agent/runners";
import type { AgentRunResult } from "../integrations/agent/spawn";

export interface AkmAgentDispatchOptions {
  profileName: string;
  prompt?: string;
  commandRef?: string;
  workflowRef?: string;
  args?: string[];
  agentConfig?: AgentConfig;
  llmConfig?: LlmConnectionConfig;
  timeoutMs?: number;
}

export interface AkmAgentDispatchResult {
  schemaVersion: 1;
  ok: boolean;
  shape: "agent-result";
  profileName: string;
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
  const { lookup } = await import("../indexer/indexer.js");
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
  if (!options.profileName?.trim()) {
    throw new UsageError("agent: <profile> is required.", "MISSING_REQUIRED_ARGUMENT");
  }

  // Resolve the profile — throws ConfigError with an actionable hint when
  // agent config is absent or the profile is not found.
  const profile = requireAgentProfile(options.agentConfig, options.profileName.trim());

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

  const stdio = prompt === undefined && profile.sdkMode !== true ? ("interactive" as const) : profile.stdio;
  const result: AgentRunResult = await runWithAgentRunner({
    profile,
    prompt,
    llmConfig: options.llmConfig,
    runOptions: {
      stdio,
      parseOutput: "text",
      ...(options.args?.length && !options.commandRef && !options.workflowRef ? { args: options.args } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    },
  });

  return {
    schemaVersion: 1 as const,
    ok: result.ok,
    shape: "agent-result",
    profileName: profile.name,
    exitCode: result.exitCode,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs: result.durationMs,
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
  };
}
