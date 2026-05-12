/**
 * `akm propose <type> <name> --task ...` — proposal-producing agent
 * command (#226).
 *
 * Mirrors {@link akmReflect} but for fresh authoring. The agent receives a
 * task description plus per-asset-type schema hints and is asked to author
 * a brand-new asset payload. The output lands ONLY in the proposal queue.
 *
 * Failures use the same {@link AgentFailureReason} discriminants as
 * `akm reflect`. `propose_invoked` is emitted at command entry.
 */

import { parseAssetRef } from "../core/asset-ref";
import { TYPE_DIRS } from "../core/asset-spec";
import { resolveStashDir } from "../core/common";
import { ConfigError, UsageError } from "../core/errors";
import { appendEvent } from "../core/events";
import { type CreateProposalInput, createProposal, type Proposal, type ProposalsContext } from "../core/proposals";
import {
  type AgentConfig,
  type AgentFailureReason,
  type AgentProfile,
  type AgentRunResult,
  type RunAgentOptions,
  runAgent,
} from "../integrations/agent";
import { runProposalAgentPipeline } from "../integrations/agent/pipeline";
import { buildProposePrompt, parseAgentProposalPayload } from "../integrations/agent/prompts";
import { baseFailureFields, enoentHintMessage, isEnoentFailure, resolveAgentProfile } from "./agent-support";

export interface AkmProposeOptions {
  type: string;
  name: string;
  task: string;
  profile?: string;
  timeoutMs?: number;
  stashDir?: string;
  agentProfile?: AgentProfile;
  runAgentOptions?: Pick<RunAgentOptions, "spawn" | "setTimeoutFn" | "clearTimeoutFn">;
  agentConfig?: AgentConfig;
  ctx?: ProposalsContext;
}

export interface AkmProposeFailure {
  schemaVersion: 1;
  ok: false;
  reason: AgentFailureReason;
  error: string;
  type: string;
  name: string;
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
}

export interface AkmProposeSuccess {
  schemaVersion: 1;
  ok: true;
  proposal: Proposal;
  ref: string;
  agentProfile: string;
  durationMs: number;
}

export type AkmProposeResult = AkmProposeSuccess | AkmProposeFailure;

function failureEnvelope(
  result: AgentRunResult,
  type: string,
  name: string,
  fallbackReason: AgentFailureReason = "non_zero_exit",
): AkmProposeFailure {
  return {
    ...baseFailureFields(result, fallbackReason),
    type,
    name,
  };
}

export async function akmPropose(options: AkmProposeOptions): Promise<AkmProposeResult> {
  if (!options.type?.trim()) {
    throw new UsageError("propose: <type> is required.", "MISSING_REQUIRED_ARGUMENT");
  }
  if (!options.name?.trim()) {
    throw new UsageError("propose: <name> is required.", "MISSING_REQUIRED_ARGUMENT");
  }
  if (!options.task?.trim()) {
    throw new UsageError("propose: --task is required.", "MISSING_REQUIRED_ARGUMENT");
  }
  if (!TYPE_DIRS[options.type]) {
    throw new UsageError(
      `propose: unknown asset type "${options.type}". Known types: ${Object.keys(TYPE_DIRS).sort().join(", ")}.`,
      "INVALID_FLAG_VALUE",
    );
  }

  const stash = options.stashDir ?? resolveStashDir();

  // 1. Always emit `propose_invoked` at entry so observers see the attempt.
  appendEvent({
    eventType: "propose_invoked",
    ref: `${options.type}:${options.name}`,
    metadata: {
      type: options.type,
      name: options.name,
      task: options.task,
      ...(options.profile ? { profile: options.profile } : {}),
    },
  });

  // 2. Resolve profile.
  let profile: AgentProfile;
  try {
    profile = resolveAgentProfile(options);
  } catch (err) {
    if (err instanceof ConfigError || err instanceof UsageError) throw err;
    throw err;
  }

  // 3. Build prompt.
  // Synthesize a temp draft path so opencode can write the asset content
  // directly using its file tools rather than returning JSON via stdout.
  const draftFilePath = import("node:os").then((os) =>
    import("node:path").then((path) =>
      path.join(
        os.tmpdir(),
        `akm-propose-${options.type}-${options.name.replace(/[^a-z0-9_-]/gi, "_")}-${Date.now()}.md`,
      ),
    ),
  );
  const resolvedDraftPath = await draftFilePath;

  const prompt = buildProposePrompt({
    type: options.type,
    name: options.name,
    task: options.task,
    draftFilePath: resolvedDraftPath,
  });

  // 4. Spawn the agent.
  // Real agent runs use interactive mode so file tools can write the draft.
  // Injected/custom spawns still need captured stdout for JSON payload tests.
  // Use callAi for the unified AI dispatch path (agent CLI preferred, LLM HTTP fallback).
  const useCustomSpawn = Boolean(options.runAgentOptions?.spawn);
  let result: AgentRunResult;
  if (useCustomSpawn) {
    // Test seam: use raw runAgent with injected spawn so tests remain deterministic.
    const runOptions: RunAgentOptions = {
      stdio: "captured",
      parseOutput: "text",
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.runAgentOptions ?? {}),
    };
    result = await runAgent(profile, prompt, runOptions);
  } else {
    // Production path: route through runProposalAgentPipeline (shared logic).
    const pipelineResult = await runProposalAgentPipeline({
      profile,
      prompt,
      draftFilePath: resolvedDraftPath,
      timeoutMs: options.timeoutMs,
    });
    result = {
      ok: pipelineResult.ok,
      exitCode: pipelineResult.exitCode,
      stdout: pipelineResult.stdout,
      stderr: pipelineResult.stderr,
      durationMs: pipelineResult.durationMs,
      error: pipelineResult.error,
      reason: pipelineResult.reason as AgentFailureReason | undefined,
    };
  }

  if (!result.ok) {
    // B3: ENOENT / not-found gives an actionable hint.
    if (isEnoentFailure(result)) {
      return { ...failureEnvelope(result, options.type, options.name), error: enoentHintMessage(profile.bin) };
    }
    return failureEnvelope(result, options.type, options.name);
  }

  // 5. Resolve the proposal content.
  // Path A: opencode wrote the draft file — read it directly (no stdout parse).
  // Path B: fallback to stdout JSON parse for non-file-writing agents.
  const fs = await import("node:fs");
  let payload: ReturnType<typeof parseAgentProposalPayload>;

  if (fs.existsSync(resolvedDraftPath)) {
    const draftContent = fs.readFileSync(resolvedDraftPath, "utf8");
    fs.unlinkSync(resolvedDraftPath);
    payload = {
      ref: `${options.type}:${options.name}`,
      content: draftContent,
    };
  } else {
    // B1: When interactive mode was used and stdout is empty, the agent did not
    // write the draft file and stdout was not captured — surface an actionable error.
    const stdioWasInteractive = !useCustomSpawn;
    if (stdioWasInteractive && (result.stdout ?? "") === "") {
      return {
        schemaVersion: 1,
        ok: false,
        reason: "parse_error",
        error:
          "Agent did not write draft file and stdout was not captured (interactive mode). Check that the agent CLI understood the file-write instruction, or configure a headless profile with stdio: 'captured'.",
        type: options.type,
        name: options.name,
        exitCode: result.exitCode,
        ...(result.stderr ? { stderr: result.stderr } : {}),
      };
    }
    try {
      payload = parseAgentProposalPayload(result.stdout ?? "");
    } catch (err) {
      return {
        schemaVersion: 1,
        ok: false,
        reason: "parse_error",
        error: err instanceof Error ? err.message : String(err),
        type: options.type,
        name: options.name,
        exitCode: result.exitCode,
        stdout: result.stdout,
        ...(result.stderr ? { stderr: result.stderr } : {}),
      };
    }
  }

  // 6. Insert the proposal. Note: we allow the agent's `ref` to normalise the
  // asset name (e.g. path-cleanup), but only after validating that the ref is
  // well-formed and the type still matches the requested type.
  const expectedRef = `${options.type}:${options.name}`;
  let ref = expectedRef;
  if (payload.ref) {
    let parsedRef: ReturnType<typeof parseAssetRef>;
    try {
      parsedRef = parseAssetRef(payload.ref);
    } catch (err) {
      return {
        schemaVersion: 1,
        ok: false,
        reason: "parse_error",
        error: err instanceof Error ? err.message : String(err),
        type: options.type,
        name: options.name,
        exitCode: result.exitCode,
        stdout: result.stdout,
        ...(result.stderr ? { stderr: result.stderr } : {}),
      };
    }
    if (parsedRef.type !== options.type) {
      return {
        schemaVersion: 1,
        ok: false,
        reason: "parse_error",
        error: `Agent returned ref type ${parsedRef.type} but expected ${options.type}`,
        type: options.type,
        name: options.name,
        exitCode: result.exitCode,
        stdout: result.stdout,
        ...(result.stderr ? { stderr: result.stderr } : {}),
      };
    }
    ref = `${parsedRef.type}:${parsedRef.name}`;
  }

  const createInput: CreateProposalInput = {
    ref,
    source: "propose",
    sourceRun: `propose-${Date.now()}`,
    payload: {
      content: payload.content,
      ...(payload.frontmatter ? { frontmatter: payload.frontmatter } : {}),
    },
  };
  const proposal = createProposal(stash, createInput, options.ctx);

  return {
    schemaVersion: 1,
    ok: true,
    proposal,
    ref: proposal.ref,
    agentProfile: profile.name,
    durationMs: result.durationMs,
  };
}
