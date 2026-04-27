/**
 * `akm reflect [ref]` — proposal-producing agent command (#226).
 *
 * Pipeline:
 *
 *   1. Emit `reflect_invoked` event at command entry (always, even on failure).
 *   2. If `ref` is provided, look the asset up via the FTS index and read its
 *      content. Pull recent feedback (`feedback` events for that ref) and
 *      lesson-lint findings to surface as schema hints.
 *   3. Build the prompt via {@link buildReflectPrompt}.
 *   4. Spawn the configured agent profile via {@link runAgent}.
 *   5. Parse the agent's stdout into a {@link AgentProposalPayload}.
 *   6. Insert into the proposal queue via {@link createProposal} with
 *      `source: "reflect"`.
 *
 * Failures are surfaced as structured envelopes carrying an
 * {@link AgentFailureReason} discriminant. Reflect NEVER calls
 * `writeAssetToSource` directly — the proposal queue is the only path to
 * a committed asset, and the `accept` flow is the bridge.
 */

import fs from "node:fs";
import { parseAssetRef } from "../core/asset-ref";
import { resolveStashDir } from "../core/common";
import { loadConfig } from "../core/config";
import { ConfigError, UsageError } from "../core/errors";
import { appendEvent, readEvents } from "../core/events";
import { lintLessonContent } from "../core/lesson-lint";
import { type CreateProposalInput, createProposal, type Proposal, type ProposalsContext } from "../core/proposals";
import { lookup } from "../indexer/indexer";
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
import { buildReflectPrompt, parseAgentProposalPayload } from "../integrations/agent/prompts";

export interface AkmReflectOptions {
  /** Optional asset ref (`type:name`) to focus on. */
  ref?: string;
  /** Override the agent profile name (defaults to `agent.default`). */
  profile?: string;
  /** Override the spawn timeout. */
  timeoutMs?: number;
  /** Test seam: override the stash dir. */
  stashDir?: string;
  /** Test seam: override the resolved agent profile (skips config lookup). */
  agentProfile?: AgentProfile;
  /** Test seam: forwarded to runAgent for fake spawn / timers. */
  runAgentOptions?: Pick<RunAgentOptions, "spawn" | "setTimeoutFn" | "clearTimeoutFn">;
  /** Test seam: pre-resolved AgentConfig (skips config load). */
  agentConfig?: AgentConfig;
  /** Test seam: stable id / clock for proposal creation. */
  ctx?: ProposalsContext;
}

export interface AkmReflectFailure {
  schemaVersion: 1;
  ok: false;
  reason: AgentFailureReason;
  error: string;
  ref?: string;
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
}

export interface AkmReflectSuccess {
  schemaVersion: 1;
  ok: true;
  proposal: Proposal;
  ref: string;
  agentProfile: string;
  durationMs: number;
}

export type AkmReflectResult = AkmReflectSuccess | AkmReflectFailure;

const MAX_FEEDBACK_LINES = 10;

/**
 * Pull recent `feedback` events for `ref` from events.jsonl. Best-effort —
 * a missing or empty events stream returns `[]`.
 */
function readRecentFeedback(ref: string): string[] {
  try {
    const result = readEvents({ type: "feedback", ref });
    const lines: string[] = [];
    for (const event of result.events.slice(-MAX_FEEDBACK_LINES)) {
      const md = (event.metadata ?? {}) as Record<string, unknown>;
      const signal = typeof md.signal === "string" ? md.signal : "?";
      const note = typeof md.note === "string" ? md.note : typeof md.reason === "string" ? md.reason : "";
      lines.push(note ? `[${signal}] ${note}` : `[${signal}]`);
    }
    return lines;
  } catch {
    return [];
  }
}

/**
 * Build schema/lint hints for the prompt. For lesson refs, run the lesson
 * lint over the current content and surface any findings — they are a
 * concrete starting point for the agent's revision.
 */
function buildSchemaHints(type: string, content: string | undefined): string[] {
  if (!content) return [];
  if (type !== "lesson") return [];
  const report = lintLessonContent(content, "reflect");
  return report.findings.map((f) => `[${f.kind}] ${f.message}`);
}

function loadAgentConfigFromDisk(): AgentConfig | undefined {
  const config = loadConfig();
  return parseAgentConfig((config as unknown as { agent?: unknown }).agent);
}

function resolveProfile(options: AkmReflectOptions): AgentProfile {
  if (options.agentProfile) return options.agentProfile;
  const agent = options.agentConfig ?? loadAgentConfigFromDisk();
  return requireAgentProfile(agent, options.profile);
}

function failureEnvelope(
  result: AgentRunResult,
  ref: string | undefined,
  fallbackReason: AgentFailureReason = "non_zero_exit",
): AkmReflectFailure {
  const reason = result.reason ?? fallbackReason;
  return {
    schemaVersion: 1,
    ok: false,
    reason,
    error: result.error ?? `agent failure (${reason})`,
    ...(ref ? { ref } : {}),
    exitCode: result.exitCode,
    ...(result.stdout ? { stdout: result.stdout } : {}),
    ...(result.stderr ? { stderr: result.stderr } : {}),
  };
}

export async function akmReflect(options: AkmReflectOptions = {}): Promise<AkmReflectResult> {
  const stash = options.stashDir ?? resolveStashDir();

  // 1. Always emit `reflect_invoked` at command entry — observers see the
  // attempt regardless of downstream success/failure.
  appendEvent({
    eventType: "reflect_invoked",
    ...(options.ref ? { ref: options.ref } : {}),
    metadata: {
      ...(options.profile ? { profile: options.profile } : {}),
    },
  });

  // 2. Resolve target asset content (if a ref is supplied).
  let assetContent: string | undefined;
  let parsedRef: { type: string; name: string } | undefined;
  if (options.ref) {
    parsedRef = parseAssetRef(options.ref);
    try {
      const entry = await lookup(parsedRef);
      if (entry?.filePath && fs.existsSync(entry.filePath)) {
        assetContent = fs.readFileSync(entry.filePath, "utf8");
      }
    } catch {
      // Index miss is non-fatal — the agent can still propose a fresh asset.
    }
  }

  // 3. Resolve agent profile. ConfigError surfaces as a thrown error so the
  // CLI dispatcher renders the standard envelope.
  let profile: AgentProfile;
  try {
    profile = resolveProfile(options);
  } catch (err) {
    if (err instanceof ConfigError || err instanceof UsageError) throw err;
    throw err;
  }

  // 4. Build the prompt.
  const feedback = options.ref ? readRecentFeedback(options.ref) : [];
  const schemaHints = buildSchemaHints(parsedRef?.type ?? "", assetContent);
  const prompt = buildReflectPrompt({
    ref: options.ref ?? "(unspecified)",
    type: parsedRef?.type ?? "unknown",
    name: parsedRef?.name ?? "unknown",
    ...(assetContent !== undefined ? { assetContent } : {}),
    ...(feedback.length > 0 ? { feedback } : {}),
    ...(schemaHints.length > 0 ? { schemaHints } : {}),
  });

  // 5. Spawn the agent. Force captured stdio + JSON parse so we can extract
  // the structured payload without confusing terminal control codes.
  const runOptions: RunAgentOptions = {
    stdio: "captured",
    parseOutput: "text",
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.runAgentOptions ?? {}),
  };
  const result = await runAgent(profile, prompt, runOptions);

  if (!result.ok) {
    return failureEnvelope(result, options.ref);
  }

  // 6. Parse stdout into a proposal payload.
  let payload: ReturnType<typeof parseAgentProposalPayload>;
  try {
    payload = parseAgentProposalPayload(result.stdout);
  } catch (err) {
    return {
      schemaVersion: 1,
      ok: false,
      reason: "parse_error",
      error: err instanceof Error ? err.message : String(err),
      ...(options.ref ? { ref: options.ref } : {}),
      exitCode: result.exitCode,
      stdout: result.stdout,
      ...(result.stderr ? { stderr: result.stderr } : {}),
    };
  }

  // 7. Create the proposal. The proposal queue is the ONLY thing reflect
  // writes — promotion to a real asset is gated by `akm proposal accept`.
  const createInput: CreateProposalInput = {
    ref: payload.ref,
    source: "reflect",
    sourceRun: `reflect-${Date.now()}`,
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
