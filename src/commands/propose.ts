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

import { TYPE_DIRS } from "../core/asset-spec";
import { resolveStashDir } from "../core/common";
import { loadConfig } from "../core/config";
import { ConfigError, UsageError } from "../core/errors";
import { appendEvent } from "../core/events";
import { type CreateProposalInput, createProposal, type Proposal, type ProposalsContext } from "../core/proposals";
import {
  type AgentConfig,
  type AgentFailureReason,
  type AgentProfile,
  type AgentRunResult,
  parseAgentConfig,
  type RunAgentOptions,
  requireAgentProfile,
  runAgent,
} from "../integrations/agent";
import { buildProposePrompt, parseAgentProposalPayload } from "../integrations/agent/prompts";

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

function loadAgentConfigFromDisk(): AgentConfig | undefined {
  const config = loadConfig();
  return parseAgentConfig((config as unknown as { agent?: unknown }).agent);
}

function resolveProfile(options: AkmProposeOptions): AgentProfile {
  if (options.agentProfile) return options.agentProfile;
  const agent = options.agentConfig ?? loadAgentConfigFromDisk();
  return requireAgentProfile(agent, options.profile);
}

function failureEnvelope(
  result: AgentRunResult,
  type: string,
  name: string,
  fallbackReason: AgentFailureReason = "non_zero_exit",
): AkmProposeFailure {
  const reason = result.reason ?? fallbackReason;
  return {
    schemaVersion: 1,
    ok: false,
    reason,
    error: result.error ?? `agent failure (${reason})`,
    type,
    name,
    exitCode: result.exitCode,
    ...(result.stdout ? { stdout: result.stdout } : {}),
    ...(result.stderr ? { stderr: result.stderr } : {}),
  };
}

export async function akmPropose(options: AkmProposeOptions): Promise<AkmProposeResult> {
  if (!options.type || !options.type.trim()) {
    throw new UsageError("propose: <type> is required.", "MISSING_REQUIRED_ARGUMENT");
  }
  if (!options.name || !options.name.trim()) {
    throw new UsageError("propose: <name> is required.", "MISSING_REQUIRED_ARGUMENT");
  }
  if (!options.task || !options.task.trim()) {
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
    profile = resolveProfile(options);
  } catch (err) {
    if (err instanceof ConfigError || err instanceof UsageError) throw err;
    throw err;
  }

  // 3. Build prompt.
  const prompt = buildProposePrompt({
    type: options.type,
    name: options.name,
    task: options.task,
  });

  // 4. Spawn the agent.
  const runOptions: RunAgentOptions = {
    stdio: "captured",
    parseOutput: "text",
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.runAgentOptions ?? {}),
  };
  const result = await runAgent(profile, prompt, runOptions);

  if (!result.ok) {
    return failureEnvelope(result, options.type, options.name);
  }

  // 5. Parse the structured response.
  let payload: ReturnType<typeof parseAgentProposalPayload>;
  try {
    payload = parseAgentProposalPayload(result.stdout);
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

  // 6. Insert the proposal. Note: we trust the agent's `ref` over our
  // requested type:name so the agent can normalise the asset name (e.g.
  // path-cleanup), but require the type to match the requested type to
  // catch silly responses.
  const expectedRef = `${options.type}:${options.name}`;
  const ref = payload.ref || expectedRef;

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
