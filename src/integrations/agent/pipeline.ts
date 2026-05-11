/**
 * Shared proposal-agent pipeline for `akm propose` and `akm reflect`.
 *
 * Both commands share the same core spawn step: resolve a profile, build a
 * prompt, run the agent, and return a structured result. This module extracts
 * that shared step so the two command implementations stay focused on their
 * own pre-processing (prompt building) and post-processing (proposal creation).
 */

import type { LlmConnectionConfig } from "../../core/config";
import type { AgentProfile } from "./profiles";
import { runAgentSdk } from "./sdk-runner";
import { runAgent } from "./spawn";

export interface ProposalPipelineOptions {
  profile: AgentProfile;
  prompt: string;
  draftFilePath?: string;
  timeoutMs?: number;
  /** LLM connection config for endpoint/apiKey inheritance when sdkMode is true. */
  llmConfig?: LlmConnectionConfig;
}

export interface ProposalPipelineResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  exitCode: number | null;
  error?: string;
  reason?: string;
}

/**
 * Run the agent for a proposal-producing command (propose or reflect).
 *
 * When `profile.sdkMode` is true, routes to {@link runAgentSdk} (no CLI
 * binary required). Otherwise, when `draftFilePath` is set the agent is
 * spawned in interactive mode so it can use its file tools to write the draft
 * directly. When no draft path is provided the agent is spawned in captured
 * mode and output is read from stdout.
 */
export async function runProposalAgentPipeline(opts: ProposalPipelineOptions): Promise<ProposalPipelineResult> {
  if (opts.profile.sdkMode) {
    const result = await runAgentSdk(
      opts.profile,
      opts.prompt,
      opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {},
      opts.llmConfig,
    );
    return {
      ok: result.ok,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      error: result.error,
      reason: result.reason,
    };
  }

  const result = await runAgent(opts.profile, opts.prompt, {
    stdio: opts.draftFilePath ? "interactive" : "captured",
    parseOutput: "text",
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  return {
    ok: result.ok,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    error: result.error,
    reason: result.reason,
  };
}
