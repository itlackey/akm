// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm proposal new <type> <name> --task ...` — proposal-producing command
 * (#226).
 *
 * Mirrors {@link akmReflect} but for fresh authoring. The engine, of any kind,
 * receives a task description plus per-asset-type schema hints and returns a
 * brand-new asset payload as JSON on stdout. The output lands ONLY in the
 * proposal queue.
 *
 * Failures use the same {@link AgentFailureReason} discriminants as
 * `akm reflect`. `propose_invoked` is emitted at command entry.
 */

import { placementTypes, stashDirFor } from "../../core/asset/asset-placement";
import { parseRefInput } from "../../core/asset/resolve-ref";
import { resolveStashDir } from "../../core/common";
import type { AkmConfig } from "../../core/config/config";
import { generatedContentRejection } from "../../core/content-safety";
import { UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { redactSensitiveText } from "../../core/redaction";
import { resolveStandardsContext } from "../../core/standards/resolve-standards-context";
import { type RunStructuredResult, runStructured } from "../../core/structured";
import { warn } from "../../core/warn";
import type { LoweringNotice } from "../../execution/resolved-request";
import { deriveEntryProvenance } from "../../indexer/installations";
import type { AgentFailureReason, AgentRunResult, RunAgentOptions } from "../../integrations/agent";
import { fallbackAnnouncement } from "../../integrations/agent/engine-fallback";
import { type BuiltExecution, buildExecution, resolveExecution } from "../../integrations/agent/execution";
import {
  type AgentProposalPayload,
  buildProposePrompt,
  PROPOSAL_JSON_SCHEMA,
  validateProposalPayload,
} from "../../integrations/agent/prompts";
import {
  assertRunnerCredentials,
  collectDispatchSensitiveValues,
  runExecution,
} from "../../integrations/agent/runner-dispatch";
import { getHarness } from "../../integrations/harnesses";
import { baseFailureFields, enoentHintMessage, isEnoentFailure } from "../agent/agent-support";
import {
  type CreateProposalInput,
  createProposal,
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
  runAgentOptions?: Pick<RunAgentOptions, "spawn" | "setTimeoutFn" | "clearTimeoutFn" | "envSource">;
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
  /** The last dispatch. */
  result: AgentRunResult;
  /** The proposal the engine returned, or why its last reply was not one; absent when a dispatch failed. */
  reply?: RunStructuredResult<AgentProposalPayload>;
  /** Every dispatch's duration. */
  durationMs: number;
  engineName: string;
  engineBin?: string;
  notices: readonly Readonly<LoweringNotice>[];
  /** Every secret this dispatch could expose; generated content echoing one is not persisted. */
  sensitiveValues: string[];
}

const DISPATCH_FAILED = Symbol("proposal-dispatch-failed");

/** A reply's text, unwrapped from its harness's framing (claude's `--output-format json` envelope). */
function replyText(execution: BuiltExecution, result: AgentRunResult): string {
  const runner = execution.runner;
  if (runner.kind !== "agent") return result.stdout;
  const extractor = getHarness(runner.profile.platform ?? runner.profile.name)?.resultExtractor;
  return extractor ? extractor(result).text : result.stdout;
}

/**
 * Resolve, lower, and dispatch the already-rendered proposal prompt with the
 * proposal's JSON Schema as its output schema, and capture the reply. A reply
 * that is not a proposal gets one corrective retry.
 */
async function dispatchProposalPrompt(
  prompt: string,
  config: AkmConfig,
  options: AkmProposeOptions,
  onDispatchReady: () => void,
): Promise<ProposalDispatchResult> {
  const current = {
    ...(options.engine !== undefined ? { engine: options.engine } : {}),
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    outputSchema: PROPOSAL_JSON_SCHEMA,
  };
  const lower = (content: string) => {
    const prepared = resolveExecution({ content, config, current });
    return { prepared, lowered: buildExecution(prepared.request, prepared.runner) };
  };
  const { prepared, lowered } = lower(prompt);
  const engineName = prepared.request.engine.name;
  const announcement = fallbackAnnouncement(prepared.fallbackEngineName, engineName);
  if (announcement) warn(announcement);

  // Validate every required symbolic credential before the entry event opens
  // durable state. Provider/runtime failures still occur after the event,
  // preserving the command-attempt observability contract. The dispatch reads
  // the same caller environment.
  const envSource = options.runAgentOptions?.envSource;
  assertRunnerCredentials(lowered.runner, envSource);
  onDispatchReady();
  options.onDispatchReady?.();
  // runStructured dispatches at least once, so a returned or DISPATCH_FAILED exchange has a result.
  const results: AgentRunResult[] = [];
  let reply: RunStructuredResult<AgentProposalPayload> | undefined;
  try {
    reply = await runStructured({
      dispatch: async (feedback) => {
        const execution = feedback ? lower(`${prompt}\n\n${feedback}`).lowered : lowered;
        const result = await runExecution(execution, { runOptions: options.runAgentOptions ?? {} });
        results.push(result);
        if (!result.ok) throw DISPATCH_FAILED;
        return replyText(execution, result);
      },
      validate: validateProposalPayload,
    });
  } catch (err) {
    if (err !== DISPATCH_FAILED) throw err;
  }
  return {
    result: results.at(-1) as AgentRunResult,
    ...(reply ? { reply } : {}),
    durationMs: results.reduce((total, result) => total + result.durationMs, 0),
    engineName,
    ...(lowered.runner.kind === "llm" ? {} : { engineBin: lowered.runner.profile.bin }),
    notices: lowered.notices,
    sensitiveValues: collectDispatchSensitiveValues(lowered.runner, {}, envSource),
  };
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
  // Standards "rulebook" for this target — wiki schema (wiki page) or stash
  // convention/meta facts (non-wiki asset); empty when neither fires.
  const standardsContext = resolveStandardsContext(`${options.type}:${options.name}`, stash);

  const prompt = buildProposePrompt({
    type: options.type,
    name: options.name,
    task: options.task,
    ...(standardsContext.trim() ? { standardsContext } : {}),
  });

  // 3. Preserve the fully-authored prompt as the terminal user content; the
  // proposal's JSON Schema crosses the shared resolved/lowered boundary as the
  // request's output schema, with no synthetic persona, conversation turn, or
  // tool selection.
  const dispatch = await dispatchProposalPrompt(prompt, config, options, () =>
    emitProposeInvoked(target.source, options),
  );
  const { result, reply, engineName, notices, sensitiveValues } = dispatch;
  if (!reply) {
    // B3: ENOENT / not-found gives an actionable hint.
    if (isEnoentFailure(result)) {
      return {
        ...failureEnvelope(result, options.type, options.name, engineName, notices),
        error: enoentHintMessage(dispatch.engineBin ?? engineName),
      };
    }
    return failureEnvelope(result, options.type, options.name, engineName, notices);
  }

  // 5. The proposal the engine returned on stdout, validated.
  if (!reply.ok) {
    return {
      schemaVersion: 2,
      ok: false,
      reason: "parse_error",
      error: `Engine "${engineName}" reply was not valid proposal JSON after ${reply.attempts} attempts: ${reply.errors.join("; ")}`,
      type: options.type,
      name: options.name,
      engine: engineName,
      exitCode: result.exitCode,
      stdout: result.stdout,
      ...(result.stderr ? { stderr: result.stderr } : {}),
      ...noticeFields(notices),
    };
  }
  const payload = reply.value;

  const unsafeContent = generatedContentRejection(
    payload.content,
    redactSensitiveText(payload.content, sensitiveValues),
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
    payload: {
      content: payload.content,
      ...(payload.frontmatter ? { frontmatter: payload.frontmatter } : {}),
    },
  };
  const proposal: Proposal = createProposal(stash, createInput, options.ctx);
  return {
    schemaVersion: 2,
    ok: true,
    proposal,
    ref: proposal.ref,
    engine: engineName,
    durationMs: dispatch.durationMs,
    ...noticeFields(notices),
  };
}
