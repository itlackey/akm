// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The proposal drain behind `akm proposal drain` and improve's triage pre-pass.
 * One rule decides the pending backlog:
 *   - an empty diff is rejected;
 *   - a proposal whose quality judge passed on this exact content (a `staged`
 *     gate decision carrying its content hash) is accepted, unless its target
 *     changed since mint — then it is auto-rejected as `stale-target`, never
 *     overwritten;
 *   - everything else needs a judge: the judgment tier decides it when a runner
 *     is configured, and whatever stays undecided is left for review
 *     (`review_needed` in the improve ledger).
 * `maxAccepts` caps promotions across both tiers; `applyMode: "queue"` never
 * promotes; `excludeIds` keeps this run's fresh proposals out; a proposal the
 * distill quality gate routed to a human is left for that human.
 */

import fs from "node:fs";
import path from "node:path";
import { assetPathForName, stashDirFor } from "../../core/asset/asset-placement";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { parseRefInput } from "../../core/asset/resolve-ref";
import type { AkmConfig } from "../../core/config/config";
import { ConfigError } from "../../core/errors";
import { appendEvent, type EventsContext } from "../../core/events";
import { escapeJsonStringControls, stripCodeFences, stripThinkBlocks } from "../../core/parse";
import { info, warn } from "../../core/warn";
import type { LoweringNotice } from "../../execution/resolved-request";
import { buildExecution, resolveExecution } from "../../integrations/agent/execution";
import type { RunnerSpec } from "../../integrations/agent/runner";
import {
  assertRunnerCredentials,
  type RunExecutionOptions,
  runExecution,
} from "../../integrations/agent/runner-dispatch";
import { errMessage, noticeSet } from "../improve/stage";
import { akmProposalAccept, akmProposalReject, type ProposalRejectResult } from "./proposal";
import { STALE_TARGET_GATE_REASON } from "./proposal-types";
import {
  listProposals,
  listProposalsReadOnly,
  type Proposal,
  preflightProposalPromotion,
  proposalContent,
  proposalContentHash,
  readFreshProposalTarget,
  recordGateDecision,
} from "./repository";

export type DrainDeferReason = "needs-judgment";

/** The gate label on every decision the drain records. */
const DRAIN_GATE = "triage";

export interface DrainOptions {
  stashDir: string;
  /** Frozen destination for every promotion. */
  target?: string;
  /** Frozen config snapshot paired with {@link target}. */
  config?: AkmConfig;
  /** "queue" (the safe default) never promotes; "promote" accepts. */
  applyMode: "queue" | "promote";
  /** Promotions per run, across both tiers. */
  maxAccepts: number;
  /** Writes nothing, but runs the same preflight a promotion would. */
  dryRun: boolean;
  /** This run's fresh proposals, left alone. */
  excludeIds?: Set<string>;
  /** The judgment tier's runner; absent leaves undecided proposals for review. */
  judgment?: RunnerSpec | null;
  eventsCtx?: EventsContext;
}

export interface DrainResult {
  promoted: string[];
  rejected: string[];
  /** Left undecided (for review). */
  deferred: Array<{ id: string; reason: DrainDeferReason }>;
  /** Accepts dropped by the `maxAccepts` ceiling. */
  skippedByCap: string[];
  /** Judged "accept" in queue mode: decided, staged for a later promote run. */
  staged: string[];
  /** Attempted and could not complete; they stay pending. */
  failed: Array<{ id: string; reason: string; detail: string }>;
  notices?: readonly Readonly<LoweringNotice>[];
}

export type PromoteFn = typeof akmProposalAccept;
export type RejectFn = (
  options: Parameters<typeof akmProposalReject>[0],
) => ProposalRejectResult | Promise<ProposalRejectResult>;

export interface JudgmentVerdict {
  decision: "accept" | "reject" | "defer";
  reason: string;
}

/** Test seams for the judgment dispatch (LLM, agent and SDK transports). */
export interface JudgmentSeams {
  chat?: (
    config: Extract<RunnerSpec, { kind: "llm" }>,
    messages: Parameters<NonNullable<RunExecutionOptions["chat"]>>[1],
  ) => Promise<string>;
  runAgentFn?: NonNullable<RunExecutionOptions["runAgent"]>;
  runSdkFn?: NonNullable<RunExecutionOptions["runSdk"]>;
}

/** An empty diff: no non-blank body line outside the frontmatter. */
export function isEmptyDiff(proposal: Proposal): boolean {
  const content = proposalContent(proposal);
  if (content.trim().length === 0) return true;
  return !parseFrontmatter(content)
    .content.split("\n")
    .some((line) => line.trim().length > 0);
}

function categorizeDrainFailure(message: string, fallback: string): string {
  if (/target (?:changed after|was created after) proposal/.test(message)) return STALE_TARGET_GATE_REASON;
  if (/failed validation:/.test(message)) return "validation";
  return fallback;
}

type AcceptOutcome = "promoted" | "rejected" | { message: string };

/**
 * The one accept path both tiers share. A dry run exercises the same stamped
 * candidate, lint and freshness boundary a promotion would (tests that pass no
 * config keep the classification-only seam). A stale target is not a merit
 * rejection, so instead of failing identically every run it is auto-rejected
 * once; the ledger records `failed`, keeping the ref re-proposable.
 */
async function acceptProposal(
  opts: DrainOptions,
  proposal: Proposal | undefined,
  id: string,
  reason: string,
  promoteFn: PromoteFn,
  rejectFn: RejectFn,
): Promise<AcceptOutcome> {
  const gateDecision = { outcome: "auto-accepted" as const, reason, gate: DRAIN_GATE };
  try {
    if (!opts.dryRun) {
      await promoteFn({
        stashDir: opts.stashDir,
        id,
        ...(opts.target ? { target: opts.target } : {}),
        ...(opts.config ? { config: opts.config } : {}),
        gateDecision,
      });
    } else if (opts.config) {
      if (!proposal) throw new Error(`Proposal ${id} disappeared during drain preflight.`);
      const preflight = preflightProposalPromotion(opts.config, proposal, {
        ...(opts.target ? { target: opts.target } : {}),
        gateDecision,
      });
      readFreshProposalTarget(proposal, preflight.assetPath, preflight.stampedContent);
    }
    return "promoted";
  } catch (err) {
    const message = errMessage(err);
    if (categorizeDrainFailure(message, "") !== STALE_TARGET_GATE_REASON) return { message };
    if (opts.dryRun) return "rejected";
    try {
      await rejectFn({
        stashDir: opts.stashDir,
        id,
        reason: `stale-target: ${message}`,
        gateDecision: { outcome: "auto-rejected", reason: STALE_TARGET_GATE_REASON, gate: DRAIN_GATE },
      });
      return "rejected";
    } catch (rejectErr) {
      warn(`[triage] stale-target auto-reject failed for ${id}: ${errMessage(rejectErr)}`);
      return { message };
    }
  }
}

/** Reject one proposal (nothing in a dry run); the error message on failure. */
async function rejectProposal(
  opts: DrainOptions,
  id: string,
  reason: string,
  gateReason: string,
  rejectFn: RejectFn,
): Promise<string | undefined> {
  if (opts.dryRun) return undefined;
  try {
    await rejectFn({
      stashDir: opts.stashDir,
      id,
      reason,
      gateDecision: { outcome: "auto-rejected", reason: gateReason, gate: DRAIN_GATE },
    });
    return undefined;
  } catch (err) {
    return errMessage(err);
  }
}

/** The judgment prompt: the proposal, the live asset it would overwrite, and same-ref siblings. */
export function buildJudgmentPrompt(
  proposal: Proposal,
  reason: DrainDeferReason,
  ctx: { liveAsset: string | undefined; siblings: Proposal[] },
): string {
  const sections: string[] = [
    "You are adjudicating a pending knowledge-base proposal no quality judge has",
    "passed yet. Decide whether to accept, reject, or defer it.",
    "",
    `Asset ref: ${proposal.ref}`,
    `Generator (source): ${proposal.source}`,
    `Left for judgment because: ${reason === "needs-judgment" ? "no quality judge has passed this content yet" : reason}`,
    "",
    "## Proposed content",
    "```",
    proposalContent(proposal),
    "```",
  ];
  if (ctx.liveAsset !== undefined) {
    sections.push("", "## Current live asset (would be overwritten on accept)", "```", ctx.liveAsset, "```");
  } else {
    sections.push("", "## Current live asset", "(none — this proposal would create a new asset)");
  }
  if (ctx.siblings.length > 0) {
    sections.push("", "## Other pending proposals for the same ref (dedup context)");
    for (const sib of ctx.siblings) {
      sections.push("", `### Sibling ${sib.id} (source: ${sib.source})`, "```", proposalContent(sib), "```");
    }
  }
  sections.push(
    "",
    "## Your task",
    'Return ONLY a JSON object: {"decision": "accept" | "reject" | "defer", "reason": "<short reason>"}.',
    "- accept: the proposed content is a correct, valuable update worth committing.",
    "- reject: the proposal is wrong, a duplicate, or contradicts the live asset.",
    "- defer: you cannot decide from the provided context (leave it pending).",
    "Output the JSON object and nothing else.",
  );
  return sections.join("\n");
}

/** A verdict from raw runner output (the first JSON object), or null. */
export function parseJudgmentVerdict(raw: string): JudgmentVerdict | null {
  const cleaned = escapeJsonStringControls(stripCodeFences(stripThinkBlocks(raw))).trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  const { decision, reason } = (obj ?? {}) as { decision?: unknown; reason?: unknown };
  if (decision !== "accept" && decision !== "reject" && decision !== "defer") return null;
  return { decision, reason: typeof reason === "string" ? reason : "" };
}

/** Lower the judgment prompt through the frozen runner and dispatch it. */
async function dispatchJudgment(
  runner: RunnerSpec,
  prompt: string,
  seams: JudgmentSeams,
): Promise<{ verdict: JudgmentVerdict | null; notices: readonly Readonly<LoweringNotice>[]; error?: string }> {
  let notices: readonly Readonly<LoweringNotice>[] = [];
  try {
    const prepared = resolveExecution({ content: prompt, runner });
    const lowered = buildExecution(prepared.request, prepared.runner);
    notices = lowered.notices;
    const chat = seams.chat;
    const llmRunner = lowered.runner.kind === "llm" ? lowered.runner : undefined;
    const result = await runExecution(lowered, {
      ...(seams.runAgentFn ? { runAgent: seams.runAgentFn } : {}),
      ...(seams.runSdkFn ? { runSdk: seams.runSdkFn } : {}),
      ...(chat && llmRunner
        ? { chat: async (connection, messages) => chat({ ...llmRunner, connection }, messages) }
        : {}),
    });
    if (!result.ok) return { verdict: null, notices, error: result.error ?? result.reason ?? "unknown error" };
    return { verdict: parseJudgmentVerdict(result.stdout), notices };
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    return { verdict: null, notices, error: errMessage(error) };
  }
}

/**
 * The judgment tier: the runner only judges; the drain performs the accept
 * (under `applyMode` and the remaining accept budget) or the reject. A defer, an
 * unparseable verdict or a runner error leaves the item undecided.
 */
async function runJudgmentTier(
  opts: DrainOptions & { judgment: RunnerSpec },
  result: DrainResult,
  pending: Proposal[],
  acceptBudget: number,
  promoteFn: PromoteFn,
  rejectFn: RejectFn,
  seams: JudgmentSeams,
): Promise<void> {
  const byId = new Map(pending.map((p) => [p.id, p]));
  const notices = noticeSet();
  const stillDeferred: DrainResult["deferred"] = [];
  const cappedBefore = result.skippedByCap.length;
  for (const item of result.deferred) {
    const proposal = byId.get(item.id);
    if (!proposal) {
      stillDeferred.push(item);
      continue;
    }
    const prompt = buildJudgmentPrompt(proposal, item.reason, {
      liveAsset: readLiveAssetContent(opts.stashDir, proposal.ref),
      siblings: pending.filter((p) => p.ref === proposal.ref && p.id !== proposal.id),
    });
    const dispatch = await dispatchJudgment(opts.judgment, prompt, seams);
    notices.add(dispatch.notices);
    if (dispatch.error) warn(`[triage] judgment dispatch failed for ${item.id}: ${dispatch.error}`);
    const verdict = dispatch.error ? null : dispatch.verdict;
    if (!verdict || verdict.decision === "defer") {
      stillDeferred.push(item);
      continue;
    }
    if (verdict.decision === "reject") {
      const failure = await rejectProposal(
        opts,
        item.id,
        verdict.reason || "judgment: reject",
        "judgment-reject",
        rejectFn,
      );
      if (failure === undefined) {
        result.rejected.push(item.id);
      } else {
        warn(`[triage] judgment reject failed for ${item.id}: ${failure}`);
        stillDeferred.push(item);
      }
      continue;
    }
    // Queue mode never writes the asset: the verdict is staged for a later promote run.
    if (opts.applyMode !== "promote") {
      if (opts.dryRun) {
        result.staged.push(item.id);
        continue;
      }
      try {
        recordGateDecision(opts.stashDir, item.id, {
          outcome: "staged",
          reason: "judgment-accept",
          contentHash: proposalContentHash(proposal),
          gate: DRAIN_GATE,
        });
        result.staged.push(item.id);
      } catch (err) {
        warn(`[triage] failed to stage judgment for ${item.id}: ${errMessage(err)}`);
        stillDeferred.push(item);
      }
      continue;
    }
    if (acceptBudget <= 0) {
      result.skippedByCap.push(item.id);
      continue;
    }
    const outcome = await acceptProposal(opts, proposal, item.id, "judgment-accept", promoteFn, rejectFn);
    if (outcome === "promoted") {
      result.promoted.push(item.id);
      acceptBudget -= 1;
    } else if (outcome === "rejected") {
      result.rejected.push(item.id);
    } else {
      warn(`[triage] judgment ${opts.dryRun ? "preflight" : "promote"} failed for ${item.id}: ${outcome.message}`);
      stillDeferred.push(item);
    }
  }
  const capped = result.skippedByCap.length - cappedBefore;
  if (capped > 0) {
    info(
      `[triage] accept ceiling reached in judgment tier: ${capped} judged-accept items skipped by cap (maxAccepts=${opts.maxAccepts})`,
    );
  }
  if (notices.list().length > 0) result.notices = notices.list();
  result.deferred = stillDeferred;
}

/** The live asset a proposal would overwrite, if any. */
function readLiveAssetContent(stashDir: string, ref: string): string | undefined {
  try {
    const parsed = parseRefInput(ref);
    const typeDir = stashDirFor(parsed.type);
    if (!typeDir) return undefined;
    const assetPath = assetPathForName(parsed.type, path.join(stashDir, typeDir), parsed.name);
    return fs.existsSync(assetPath) ? fs.readFileSync(assetPath, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Drain the pending backlog. `promoteFn` / `rejectFn` / `judgmentSeams` are
 * test seams.
 */
export async function drainProposals(
  opts: DrainOptions,
  promoteFn: PromoteFn = akmProposalAccept,
  rejectFn: RejectFn = akmProposalReject,
  judgmentSeams: JudgmentSeams = {},
): Promise<DrainResult> {
  const exclude = opts.excludeIds ?? new Set<string>();
  // A judgment runner's credentials are validated before any live state
  // connection, so its classification reads an isolated snapshot.
  const pending = (opts.judgment ? listProposalsReadOnly : listProposals)(opts.stashDir, { status: "pending" }).filter(
    (proposal) => !exclude.has(proposal.id),
  );
  const result: DrainResult = { promoted: [], rejected: [], deferred: [], skippedByCap: [], staged: [], failed: [] };
  const accepts: Array<{ id: string; reason: string }> = [];
  const empties: string[] = [];
  for (const proposal of pending) {
    const decision = proposal.gateDecision;
    // Another gate's rejection stands; a human-review deferral from the distill
    // quality gate is left for that human.
    if (decision?.outcome === "auto-rejected" && !decision.gate?.startsWith(DRAIN_GATE)) continue;
    if (decision?.outcome === "deferred" && decision.gate === "quality-gate") continue;
    if (isEmptyDiff(proposal)) {
      empties.push(proposal.id);
    } else if (decision?.outcome === "staged" && decision.contentHash === proposalContentHash(proposal)) {
      accepts.push({ id: proposal.id, reason: decision.gate === "quality-gate" ? "judge-passed" : "judgment-accept" });
    } else {
      result.deferred.push({ id: proposal.id, reason: "needs-judgment" });
    }
  }

  if (opts.judgment && result.deferred.length > 0) {
    // Symbolic credentials are checked before any gate, reject or promote.
    const prepared = resolveExecution({
      content: "Validate the selected proposal judgment runner before mutation.",
      runner: opts.judgment,
    });
    assertRunnerCredentials(buildExecution(prepared.request, prepared.runner).runner);
  }

  for (const id of empties) {
    const failure = await rejectProposal(opts, id, "empty diff", "empty-diff", rejectFn);
    if (failure === undefined) {
      result.rejected.push(id);
    } else {
      result.failed.push({ id, reason: categorizeDrainFailure(failure, "reject-error"), detail: failure });
      warn(`[triage] reject failed for ${id}: ${failure}`);
    }
  }

  const cap = Math.max(0, opts.maxAccepts);
  const withinCap = accepts.slice(0, cap);
  result.skippedByCap = accepts.slice(cap).map((a) => a.id);
  if (result.skippedByCap.length > 0) {
    info(
      `[triage] accept ceiling reached: ${withinCap.length} promoted, ${result.skippedByCap.length} skipped by cap (maxAccepts=${opts.maxAccepts})`,
    );
  }
  let promotedHere = 0;
  if (opts.applyMode === "promote") {
    if (!opts.dryRun) info(`[triage] auto-promote active: ${withinCap.length} accepts allowed this run`);
    const byId = new Map(pending.map((proposal) => [proposal.id, proposal]));
    for (const { id, reason } of withinCap) {
      const outcome = await acceptProposal(opts, byId.get(id), id, reason, promoteFn, rejectFn);
      if (outcome === "promoted") {
        result.promoted.push(id);
        promotedHere += 1;
      } else if (outcome === "rejected") {
        result.rejected.push(id);
      } else {
        result.failed.push({
          id,
          reason: categorizeDrainFailure(outcome.message, "promote-error"),
          detail: outcome.message,
        });
        warn(`[triage] ${opts.dryRun ? "preflight" : "promote"} failed for ${id}: ${outcome.message}`);
      }
    }
  }

  if (opts.judgment && result.deferred.length > 0) {
    await runJudgmentTier(
      { ...opts, judgment: opts.judgment },
      result,
      pending,
      cap - promotedHere,
      promoteFn,
      rejectFn,
      judgmentSeams,
    );
  }
  // #577: whatever stays undecided is left for review (`review_needed` in the ledger).
  if (!opts.dryRun) {
    const reviewReason = opts.judgment ? "judgment-deferred" : "no-judge-configured";
    for (const item of result.deferred) {
      try {
        recordGateDecision(opts.stashDir, item.id, { outcome: "deferred", reason: reviewReason, gate: DRAIN_GATE });
      } catch (err) {
        warn(`[triage] failed to record gate decision for ${item.id}: ${errMessage(err)}`);
      }
    }
  }
  emitDrainEvents(opts, result);
  return result;
}

function emitDrainEvents(opts: DrainOptions, result: DrainResult): void {
  const deferredByReason: Record<string, number> = {};
  for (const d of result.deferred) deferredByReason[d.reason] = (deferredByReason[d.reason] ?? 0) + 1;
  appendEvent(
    {
      eventType: "triage_drained",
      metadata: {
        promoted: result.promoted.length,
        rejected: result.rejected.length,
        deferredByReason,
        skippedByCap: result.skippedByCap.length,
        ...(result.staged.length > 0 ? { staged: result.staged.length } : {}),
        applyMode: opts.applyMode,
        ...(opts.dryRun ? { dryRun: true } : {}),
      },
    },
    opts.eventsCtx ?? {},
  );
  // Undecided items must never look like full success. Staged accepts were decided.
  if (result.deferred.length > 0) {
    appendEvent(
      {
        eventType: "triage_deferred",
        metadata: {
          deferred: result.deferred.length,
          deferredByReason,
          reason: opts.judgment ? "judgment tier left items unresolved" : "no judgment runner configured",
        },
      },
      opts.eventsCtx ?? {},
    );
  }
}
