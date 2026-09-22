// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

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

import fs from "node:fs";
import { placementTypes, stashDirFor } from "../../core/asset/asset-placement";
import { parseRefInput } from "../../core/asset/resolve-ref";
import { resolveStashDir } from "../../core/common";
import type { AkmConfig } from "../../core/config/config";
import { generatedContentRejection } from "../../core/content-safety";
import { UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { resolveStandardsContext } from "../../core/standards/resolve-standards-context";
import { warn } from "../../core/warn";
import type { LoweringNotice } from "../../execution/resolved-request";
import { deriveEntryProvenance } from "../../indexer/installations";
import type { AgentFailureReason, AgentRunResult, RunAgentOptions } from "../../integrations/agent";
import { fallbackAnnouncement } from "../../integrations/agent/engine-fallback";
import {
  acquireLoweredExecutionDispatchLease,
  dispatchLoweredExecutionRequest,
  disposeLoweredExecutionDispatchLease,
  type LoweredExecutionDispatchLease,
  lowerResolvedExecutionRequest,
  redactWithLoweredExecutionDispatchLease,
} from "../../integrations/agent/execution-lowering";
import { prepareInlineExecution } from "../../integrations/agent/inline-execution";
import { buildProposePrompt, parseAgentProposalPayload } from "../../integrations/agent/prompts";
import { baseFailureFields, enoentHintMessage, isEnoentFailure } from "../agent/agent-support";
import {
  type CreateProposalInput,
  createProposal,
  isProposalSkipped,
  type Proposal,
  type ProposalsContext,
  resolveProposalQueueTarget,
} from "./repository";

export interface AkmProposeOptions {
  type: string;
  name: string;
  task: string;
  engine?: string;
  timeoutMs?: number;
  stashDir?: string;
  runAgentOptions?: Pick<RunAgentOptions, "spawn" | "setTimeoutFn" | "clearTimeoutFn">;
  agentConfig?: AkmConfig;
  ctx?: ProposalsContext;
  /** Test seam invoked after credential acquisition and before provider dispatch. */
  onDispatchReady?: () => void;
}

export interface AkmProposeFailure {
  schemaVersion: 2;
  ok: false;
  reason: AgentFailureReason;
  error: string;
  type: string;
  name: string;
  engine: string;
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  notices?: readonly Readonly<LoweringNotice>[];
}

export interface AkmProposeSuccess {
  schemaVersion: 2;
  ok: true;
  proposal: Proposal;
  ref: string;
  engine: string;
  durationMs: number;
  notices?: readonly Readonly<LoweringNotice>[];
}

export type AkmProposeResult = AkmProposeSuccess | AkmProposeFailure;

function failureEnvelope(
  result: AgentRunResult,
  type: string,
  name: string,
  engine: string,
  notices: readonly Readonly<LoweringNotice>[],
  fallbackReason: AgentFailureReason = "non_zero_exit",
): AkmProposeFailure {
  return {
    ...baseFailureFields(result, fallbackReason),
    schemaVersion: 2,
    type,
    name,
    engine,
    ...(notices.length > 0 ? { notices } : {}),
  };
}

function noticeFields(notices: readonly Readonly<LoweringNotice>[]): { notices?: readonly Readonly<LoweringNotice>[] } {
  return notices.length > 0 ? { notices } : {};
}

interface ProposalDispatchResult {
  result: AgentRunResult;
  engineName: string;
  engineBin?: string;
  notices: readonly Readonly<LoweringNotice>[];
  lease: LoweredExecutionDispatchLease;
  interactive: boolean;
}

/** Materialize required credentials through the real runner boundary, without provider I/O. */
async function preflightProposalDispatch(
  lowered: Parameters<typeof dispatchLoweredExecutionRequest>[0],
  runOptions: RunAgentOptions,
): Promise<LoweredExecutionDispatchLease> {
  return acquireLoweredExecutionDispatchLease(lowered, {
    ...(runOptions.envSource ? { envSource: runOptions.envSource } : {}),
  });
}

/** Resolve, lower, and dispatch the already-rendered proposal prompt. */
async function dispatchProposalPrompt(
  prompt: string,
  config: AkmConfig,
  options: AkmProposeOptions,
  onDispatchReady: () => void,
): Promise<ProposalDispatchResult> {
  const current = {
    ...(options.engine !== undefined ? { engine: options.engine } : {}),
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
  };
  const prepared = prepareInlineExecution({
    content: prompt,
    config,
    invocationKind: "direct",
    ...(Object.keys(current).length > 0 ? { current } : {}),
  });
  const engineName = prepared.request.engine.name;
  const announcement = fallbackAnnouncement(prepared.fallbackEngineName, engineName);
  if (announcement) warn(announcement);
  const lowered = lowerResolvedExecutionRequest(prepared.request, prepared.config);

  const interactive = !options.runAgentOptions?.spawn;
  const runOptions: RunAgentOptions = {
    stdio: interactive ? "interactive" : "captured",
    parseOutput: "text",
    ...(options.runAgentOptions ?? {}),
  };
  const lease = await preflightProposalDispatch(lowered, runOptions);
  // Materialize/validate every required symbolic credential before the entry
  // event opens durable state. Provider/runtime failures still occur after the
  // event, preserving the command-attempt observability contract.
  try {
    onDispatchReady();
    options.onDispatchReady?.();
    const result = await dispatchLoweredExecutionRequest(lowered, { runOptions, lease });
    return {
      result,
      engineName,
      ...(lowered.runner.kind === "llm" ? {} : { engineBin: lowered.runner.profile.bin }),
      notices: lowered.notices,
      lease,
      interactive,
    };
  } catch (error) {
    disposeLoweredExecutionDispatchLease(lease);
    throw error;
  }
}

/**
 * WI-8.5a — the fully-qualified `bundle//conceptId` item_ref for a proposal
 * target in `stashDir`. The conceptId is BUILT from the D-R2 static table
 * (`deriveEntryProvenance`), never looked up, so a propose target that does not
 * yet exist on disk still keys onto its final spelling; the bundle is the
 * write-target stash's installation id (same derivation the index write path
 * uses). Matches `createProposal`'s durable `proposals.ref` mint, so the entry
 * event, the fallback ref, and the stored proposal all carry one spelling.
 */
function proposeItemRef(bundleId: string, type: string, name: string): string {
  return deriveEntryProvenance({ bundleId, componentId: bundleId, adapterId: "akm" }, type, name).itemRef;
}

/**
 * The command-entry `propose_invoked` event. WI-8.5b: the ref carries the same
 * fully-qualified item_ref the durable proposal is minted under
 * (`proposeItemRef`), so the entry event and the stored proposal agree.
 */
function emitProposeInvoked(bundleId: string, options: AkmProposeOptions): void {
  appendEvent({
    eventType: "propose_invoked",
    ref: proposeItemRef(bundleId, options.type, options.name),
    metadata: {
      type: options.type,
      name: options.name,
      task: options.task,
      ...(options.engine ? { engine: options.engine } : {}),
    },
  });
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
  if (!stashDirFor(options.type)) {
    throw new UsageError(
      `propose: unknown asset type "${options.type}". Known types: ${[...placementTypes()].sort().join(", ")}.`,
      "INVALID_FLAG_VALUE",
    );
  }

  const stash = options.stashDir ?? resolveStashDir();

  // 1. Resolve the write target. Engine/model/inference resolution happens
  // exactly once below through the shared execution cascade.
  const config = options.agentConfig ?? (await import("../../core/config/config.js")).loadConfig();
  const target = resolveProposalQueueTarget(stash, config);

  // 2. Build terminal user content.
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

  // Standards "rulebook" for this target — wiki schema (wiki page) or stash
  // convention/meta facts (non-wiki asset); empty when neither fires.
  const standardsContext = resolveStandardsContext(`${options.type}:${options.name}`, stash);

  const prompt = buildProposePrompt({
    type: options.type,
    name: options.name,
    task: options.task,
    ...(standardsContext.trim() ? { standardsContext } : {}),
    draftFilePath: resolvedDraftPath,
  });

  // 3. Preserve the fully-authored prompt as the terminal user content;
  // no synthetic persona, conversation turn, schema, or tool selection is
  // introduced while it crosses the shared resolved/lowered boundary.
  const dispatch = await dispatchProposalPrompt(prompt, config, options, () =>
    emitProposeInvoked(target.source, options),
  );
  const { result, engineName, notices, lease } = dispatch;
  try {
    if (!result.ok) {
      // B3: ENOENT / not-found gives an actionable hint.
      if (isEnoentFailure(result)) {
        return {
          ...failureEnvelope(result, options.type, options.name, engineName, notices),
          error: enoentHintMessage(dispatch.engineBin ?? engineName),
        };
      }
      return failureEnvelope(result, options.type, options.name, engineName, notices);
    }

    // 5. Resolve the proposal content.
    // Path A: opencode wrote the draft file — read it directly (no stdout parse).
    // Path B: fallback to stdout JSON parse for non-file-writing agents.
    let payload: ReturnType<typeof parseAgentProposalPayload>;

    if (fs.existsSync(resolvedDraftPath)) {
      const draftContent = fs.readFileSync(resolvedDraftPath, "utf8");
      fs.unlinkSync(resolvedDraftPath);
      payload = {
        ref: proposeItemRef(target.source, options.type, options.name),
        content: draftContent,
      };
    } else {
      // B1: When interactive mode was used and stdout is empty, the agent did not
      // write the draft file and stdout was not captured — surface an actionable error.
      if (dispatch.interactive && (result.stdout ?? "") === "") {
        return {
          schemaVersion: 2,
          ok: false,
          reason: "parse_error",
          error:
            "Agent did not write draft file and stdout was not captured (interactive mode). Check that the agent CLI understood the file-write instruction, or configure a headless profile with stdio: 'captured'.",
          type: options.type,
          name: options.name,
          engine: engineName,
          exitCode: result.exitCode,
          ...(result.stderr ? { stderr: result.stderr } : {}),
          ...noticeFields(notices),
        };
      }
      try {
        payload = parseAgentProposalPayload(result.stdout ?? "");
      } catch (err) {
        return {
          schemaVersion: 2,
          ok: false,
          reason: "parse_error",
          error: err instanceof Error ? err.message : String(err),
          type: options.type,
          name: options.name,
          engine: engineName,
          exitCode: result.exitCode,
          stdout: result.stdout,
          ...(result.stderr ? { stderr: result.stderr } : {}),
          ...noticeFields(notices),
        };
      }
    }

    const unsafeContent = generatedContentRejection(
      payload.content,
      redactWithLoweredExecutionDispatchLease(lease, payload.content),
    );
    if (unsafeContent) {
      return {
        schemaVersion: 2,
        ok: false,
        reason: "parse_error",
        error: unsafeContent,
        type: options.type,
        name: options.name,
        engine: engineName,
        exitCode: result.exitCode,
        ...noticeFields(notices),
      };
    }

    // 6. Insert the proposal. Note: we allow the agent's `ref` to normalise the
    // asset name (e.g. path-cleanup), but only after validating that the ref is
    // well-formed and the type still matches the requested type.
    const expectedRef = proposeItemRef(target.source, options.type, options.name);
    let ref = expectedRef;
    if (payload.ref) {
      let parsedRef: ReturnType<typeof parseRefInput>;
      try {
        parsedRef = parseRefInput(payload.ref);
      } catch (err) {
        return {
          schemaVersion: 2,
          ok: false,
          reason: "parse_error",
          error: err instanceof Error ? err.message : String(err),
          type: options.type,
          name: options.name,
          engine: engineName,
          exitCode: result.exitCode,
          stdout: result.stdout,
          ...(result.stderr ? { stderr: result.stderr } : {}),
          ...noticeFields(notices),
        };
      }
      if (parsedRef.type !== options.type) {
        return {
          schemaVersion: 2,
          ok: false,
          reason: "parse_error",
          error: `Agent returned ref type ${parsedRef.type} but expected ${options.type}`,
          type: options.type,
          name: options.name,
          engine: engineName,
          exitCode: result.exitCode,
          stdout: result.stdout,
          ...(result.stderr ? { stderr: result.stderr } : {}),
          ...noticeFields(notices),
        };
      }
      ref = proposeItemRef(target.source, parsedRef.type, parsedRef.name);
    }

    const createInput: CreateProposalInput = {
      ref,
      source: "propose",
      sourceRun: `propose-${Date.now()}`,
      target,
      // User-initiated proposals always bypass dedup/cooldown guards — the
      // operator is explicitly asking for a new proposal.
      force: true,
      payload: {
        content: payload.content,
        ...(payload.frontmatter ? { frontmatter: payload.frontmatter } : {}),
      },
    };
    const proposalResult = createProposal(stash, createInput, options.ctx);

    // With force:true, the result is always a Proposal (never skipped).
    if (isProposalSkipped(proposalResult)) {
      // Should never happen when force:true, but be defensive.
      throw new Error(`Unexpected skip in propose command: ${proposalResult.message}`);
    }

    const proposal: Proposal = proposalResult;
    return {
      schemaVersion: 2,
      ok: true,
      proposal,
      ref: proposal.ref,
      engine: engineName,
      durationMs: result.durationMs,
      ...noticeFields(notices),
    };
  } finally {
    disposeLoweredExecutionDispatchLease(lease);
  }
}
