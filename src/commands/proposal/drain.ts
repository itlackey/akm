// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Deterministic proposal-drain engine (Proposal-Queue Triage, Phase 1).
 *
 * Drains the *standing pending backlog* of proposals using a deterministic,
 * no-LLM policy keyed on generator (proposal `source`) and diff size. This is
 * the engine behind `akm proposal drain` and (later) the `triage` improve
 * pre-pass.
 *
 * Design:
 *   - Reuses `listProposals` (no source filter — generator filtering is
 *     in-memory) and the `akmProposalAccept` / `akmProposalReject` wrappers from
 *     `proposal.ts` so the standard `promoted` / `rejected` events are emitted.
 *     Deterministic by design; only the configured drain policy decides.
 *   - Backlog-only: `excludeIds` removes this-run's fresh proposals so triage
 *     never re-adjudicates a current run's output (decision #2).
 *   - Hard guardrails enforced in code: a `maxAccepts` ceiling checked *before*
 *     the promote loop (remainder → `skippedByCap`); `maxDiffLines` defers large
 *     accepts; `applyMode: "queue"` (the safe default) never promotes (stage
 *     only); `rejectEmpty` rejects empty / near-empty diffs.
 *   - The judgment tier (Phase 3) adjudicates the deferred items: when a
 *     `judgment` RunnerSpec is supplied the engine pre-fetches context (the live
 *     asset + sibling pending proposals for the same ref) into a prompt,
 *     dispatches it through the shared resolved/lowered execution boundary,
 *     and performs the resulting accept / reject *itself* (the runner only
 *     judges).
 *     Items the runner cannot resolve — and any deferred items when no runner is
 *     configured — surface a `triage_deferred` event so "enabled, no agent"
 *     never silently looks like full success.
 *
 * The promote / reject functions and the runner dispatch are injectable
 * (mirrors reflect's dual test seams) so tests can run the full engine without
 * touching the filesystem or spawning a process.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assetPathForName, stashDirFor } from "../../core/asset/asset-placement";
import { computeNormalizedContentHash, parseFrontmatter } from "../../core/asset/frontmatter";
import { parseRefInput } from "../../core/asset/resolve-ref";
import type { AkmConfig } from "../../core/config/config";
import { ConfigError } from "../../core/errors";
import type { EventsContext } from "../../core/events";
import { appendEvent } from "../../core/events";
import { escapeJsonStringControls, stripCodeFences, stripThinkBlocks } from "../../core/parse";
import { info, warn } from "../../core/warn";
import type { LoweringNotice } from "../../execution/resolved-request";
import {
  acquireLoweredExecutionDispatchLease,
  type DispatchLoweredExecutionOptions,
  dispatchLoweredExecutionRequest,
  disposeLoweredExecutionDispatchLease,
  type LoweredExecutionDispatchLease,
  lowerResolvedExecutionRequestWithRunner,
} from "../../integrations/agent/execution-lowering";
import { prepareInlineExecutionWithRunner } from "../../integrations/agent/inline-execution";
import type { RunnerSpec } from "../../integrations/agent/runner";
import { akmProposalAccept, akmProposalReject, type ProposalRejectResult } from "./proposal";
import { STALE_TARGET_GATE_REASON } from "./proposal-types";
import {
  listProposals,
  listProposalsReadOnly,
  type Proposal,
  type ProposalGateDecision,
  preflightProposalPromotion,
  proposalContent,
  recordGateDecision,
} from "./repository";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single accept rule within a {@link DrainPolicy}. */
export interface DrainAcceptRule {
  /** Generator (proposal `source`) this rule matches, e.g. "extract". */
  generator: string;
  /** Accept only when the proposed content is <= this many lines. */
  maxDiffLines?: number;
  /** Accept only when the proposed content has >= this many body lines. */
  minContentLines?: number;
  /**
   * When set, the rule matches only if the proposal's frontmatter `type` field
   * equals this value (e.g. "lesson"). Absent = match any type (backward-compat).
   */
  requireType?: string;
}

/** A deterministic triage policy: which generators auto-accept / defer. */
export interface DrainPolicy {
  name: string;
  /** Generators (with optional size bounds) whose proposals auto-accept. */
  accept: DrainAcceptRule[];
  /** Reject proposals whose diff is empty / near-empty. */
  rejectEmpty: boolean;
  /**
   * Generators whose mid-band / ambiguous items are deferred to the judgment
   * tier (Phase 3). For Phase 1 these simply land in `deferred[]` unprocessed.
   */
  defer: string[];
}

export type DrainDeferReason = "mid-band" | "possible-dup";

/**
 * Gate-decision context the engine stamps onto each proposal it adjudicates
 * (#577). Captures the reason token plus the thresholds that were in effect, so
 * `akm proposal show` can later reconstruct a comparison like "210 > 200".
 */
export interface DrainGateContext {
  reason: string;
  /**
   * The value this gate measured and compared against the threshold (the
   * proposed content's line count for `max-diff-lines`, the non-empty body-line
   * count for `min-content-lines`), so `akm proposal show` can render a full
   * comparison like "210 > 200" rather than only the bound (#577).
   */
  measured?: number;
  thresholds?: { maxDiffLines?: number; minContentLines?: number };
}

export interface DrainOptions {
  stashDir: string;
  /** Frozen destination identity used by every promotion path. */
  target?: string;
  /** Frozen config snapshot paired with {@link target}. */
  config?: AkmConfig;
  policy: DrainPolicy;
  /** "queue" (default, safe) stages only and never promotes; "promote" accepts. */
  applyMode: "queue" | "promote";
  /** Hard per-run accept ceiling, enforced before the promote loop. */
  maxAccepts: number;
  /** When true, performs zero writes (no accept / reject). */
  dryRun: boolean;
  /** Fresh-this-run proposal ids to exclude (decision #2). */
  excludeIds?: Set<string>;
  /**
   * Optional global diff-line bound. Accepts whose content exceeds this are
   * deferred ("mid-band"), never promoted. Applied in addition to any per-rule
   * `maxDiffLines`.
   */
  maxDiffLines?: number;
  /**
   * Optional judgment tier (Phase 3). When a RunnerSpec is supplied the engine
   * adjudicates each deferred item through the runner and performs the resulting
   * accept / reject itself. `null` / absent leaves deferred items unresolved and
   * emits `triage_deferred`.
   */
  judgment?: RunnerSpec | null;
  eventsCtx?: EventsContext;
}

export interface DrainResult {
  /** Proposal ids promoted (accepted) this run. Empty in queue / dry-run mode. */
  promoted: string[];
  /** Proposal ids rejected (empty diffs) this run. Empty in dry-run mode. */
  rejected: string[];
  /** Proposals left for the judgment tier, with the reason they were deferred. */
  deferred: Array<{ id: string; reason: DrainDeferReason }>;
  /** Accept candidates dropped because the `maxAccepts` ceiling was reached. */
  skippedByCap: string[];
  /**
   * Items the judgment tier resolved as "accept" but that a queue-mode run did
   * not promote (staged for a follow-up promote run). These are RESOLVED — the
   * judge decided — and are deliberately NOT reported as "left unresolved" by
   * the `triage_deferred` event. Empty outside queue mode.
   */
  staged: string[];
  /**
   * Proposals the deterministic reject/promote/preflight loops attempted and
   * could not complete, with a stable reason code plus the raw error text.
   * These ids land in none of `promoted`/`rejected`/`deferred`/`staged` — they
   * stay pending, and this is the only place that fact is recorded anywhere
   * other than a stderr `warn()` line.
   */
  failed: Array<{ id: string; reason: string; detail: string }>;
  /** Stable, secret-free notices emitted while lowering judgment requests. */
  notices?: readonly Readonly<LoweringNotice>[];
}

// Injectable test seams (promoteFn/rejectFn overrides, mirroring reflect's).
export type PromoteFn = typeof akmProposalAccept;
export type RejectFn = (
  options: Parameters<typeof akmProposalReject>[0],
) => ProposalRejectResult | Promise<ProposalRejectResult>;

/** A single verdict the judgment runner returns for a deferred proposal. */
export interface JudgmentVerdict {
  decision: "accept" | "reject" | "defer";
  reason: string;
}

/**
 * Injectable runner seams for the judgment tier, mirroring reflect's dual test
 * seams (`chat` for the LLM HTTP path, `runAgentFn` for the spawn path). Tests
 * inject a fake `chat` (llm-mode) or `runAgentFn` (agent-mode) so the dispatch
 * switch runs deterministically without a network call or a real process.
 */
export interface JudgmentSeams {
  /** Test seam for the lowered direct-LLM transport. */
  chat?: (
    config: Extract<RunnerSpec, { kind: "llm" }>,
    messages: Parameters<NonNullable<DispatchLoweredExecutionOptions["chat"]>>[1],
  ) => Promise<string>;
  /** Test seam for the lowered agent transport. */
  runAgentFn?: NonNullable<DispatchLoweredExecutionOptions["runAgent"]>;
  /** Test seam for the lowered SDK transport. */
  runSdkFn?: NonNullable<DispatchLoweredExecutionOptions["runSdk"]>;
}

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

/** Number of non-empty body lines (frontmatter excluded). */
export function contentBodyLineCount(content: string): number {
  // Reuse the canonical frontmatter parser so CRLF / BOM are handled
  // consistently with the rest of the stash (parseFrontmatter returns the body
  // in `content`).
  return parseFrontmatter(content)
    .content.split("\n")
    .filter((line) => line.trim().length > 0).length;
}

/** Total line count of the proposed content (matches the bulk-accept measure). */
export function contentLineCount(content: string): number {
  return content.split("\n").length;
}

/** An empty / near-empty diff has no meaningful body content. */
export function isEmptyDiff(proposal: Proposal): boolean {
  const content = proposalContent(proposal);
  if (content.trim().length === 0) return true;
  return contentBodyLineCount(content) === 0;
}

/**
 * Decide a deterministic verdict for a single backlog proposal under `policy`.
 * Returns `null` when no rule applies (the proposal is left pending untouched).
 */
export function classifyProposal(
  proposal: Proposal,
  policy: DrainPolicy,
  maxDiffLines?: number,
):
  | { verdict: "accept"; gate: DrainGateContext }
  | { verdict: "reject"; reason: string; gate: DrainGateContext }
  | { verdict: "defer"; reason: DrainDeferReason; gate: DrainGateContext }
  | null {
  const content = proposalContent(proposal);

  // Empty / near-empty diffs reject first (the reject-empty floor).
  if (policy.rejectEmpty && isEmptyDiff(proposal)) {
    return { verdict: "reject", reason: "empty diff", gate: { reason: "empty-diff" } };
  }

  const rule = policy.accept.find((r) => {
    if (r.generator !== proposal.source) return false;
    if (r.requireType !== undefined) {
      const fm = parseFrontmatter(proposalContent(proposal)).data;
      if (typeof fm.type !== "string" || fm.type !== r.requireType) return false;
    }
    return true;
  });
  if (rule) {
    const lines = contentLineCount(content);
    const body = contentBodyLineCount(content);
    // Per-rule and global diff bounds defer large accepts (no silent rewrites).
    const effectiveMax = Math.min(
      rule.maxDiffLines ?? Number.POSITIVE_INFINITY,
      maxDiffLines ?? Number.POSITIVE_INFINITY,
    );
    if (lines > effectiveMax) {
      return {
        verdict: "defer",
        reason: "mid-band",
        gate: { reason: "max-diff-lines", measured: lines, thresholds: { maxDiffLines: effectiveMax } },
      };
    }
    if (rule.minContentLines !== undefined && body < rule.minContentLines) {
      // Too little content to confidently auto-accept — leave for judgment.
      return {
        verdict: "defer",
        reason: "mid-band",
        gate: { reason: "min-content-lines", measured: body, thresholds: { minContentLines: rule.minContentLines } },
      };
    }
    return { verdict: "accept", gate: { reason: "policy-accept" } };
  }

  if (policy.defer.includes(proposal.source)) {
    const reason = deferReasonForSource(proposal.source);
    return { verdict: "defer", reason, gate: { reason } };
  }

  // No matching rule — leave pending, untouched.
  return null;
}

function deferReasonForSource(source: string): DrainDeferReason {
  return source === "distill" ? "possible-dup" : "mid-band";
}

/**
 * Map a thrown error's message to one of `DrainResult.failed`'s stable reason
 * codes, falling back to `fallback` for anything not specifically recognized.
 * Recognizes the write-time guards a proposal can trip during promotion
 * (see repository.ts's `promoteProposalWithLease` / `preflightProposalPromotion`).
 */
function categorizeDrainFailure(message: string, fallback: string): string {
  if (/target (?:changed after|was created after) proposal/.test(message)) return STALE_TARGET_GATE_REASON;
  if (/failed validation:/.test(message)) return "validation";
  return fallback;
}

function pushDrainFailure(result: DrainResult, id: string, err: unknown, fallbackReason: string): string {
  const message = err instanceof Error ? err.message : String(err);
  result.failed.push({ id, reason: categorizeDrainFailure(message, fallbackReason), detail: message });
  return message;
}

/**
 * A `stale-target` promote failure (STALE, R20) is not a merit rejection —
 * the guard tripped because the target changed after mint (often akm's own
 * bookkeeping), not because of anything wrong with the proposed content. So
 * instead of leaving the row pending to retry and fail identically every run,
 * the drain auto-rejects it once with a structured marker.
 * `checkFingerprintAndBackoff` (repository.ts) excludes this reason from
 * rejection-backoff, so the ref stays re-proposable against its current
 * content. Returns `true` when the reject succeeded (the caller should treat
 * the item as resolved, not failed); `false` leaves it to the caller's
 * existing failure handling.
 */
async function autoRejectStaleTarget(
  stashDir: string,
  gateLabel: string,
  id: string,
  message: string,
  rejectFn: RejectFn,
): Promise<boolean> {
  try {
    await rejectFn({
      stashDir,
      id,
      reason: `stale-target: ${message}`,
      gateDecision: { outcome: "auto-rejected", reason: STALE_TARGET_GATE_REASON, gate: gateLabel },
    });
    return true;
  } catch (err) {
    warn(`[triage] stale-target auto-reject failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Mirror repository.ts's `promoteProposalWithLease` stale-target guard so a
 * dry-run preflight predicts the same refusal a real promote would hit,
 * without writing anything. `assetPath` is the path `preflightProposalPromotion`
 * already resolved for this proposal.
 */
function assertProposalTargetFresh(proposal: Proposal, assetPath: string): void {
  const backup = fs.existsSync(assetPath) ? fs.readFileSync(assetPath) : undefined;
  if (proposal.beforeHash !== undefined) {
    // STALE (R20): mirrors repository.ts's promote guard — a normalized
    // before-hash is insensitive to a same-run bookkeeping rewrite of the
    // target; a legacy proposal without one keeps the raw-hash check.
    const fresh =
      proposal.beforeHashNormalized !== undefined
        ? backup !== undefined &&
          computeNormalizedContentHash(backup.toString("utf8")) === proposal.beforeHashNormalized
        : backup !== undefined && createHash("sha256").update(backup).digest("hex") === proposal.beforeHash;
    if (!fresh) {
      throw new Error(
        `Proposal target changed after proposal ${proposal.id} was created; refusing to overwrite newer content.`,
      );
    }
  }
  if (
    proposal.beforeHash === undefined &&
    backup !== undefined &&
    proposal.changes.some((change) => change.op === "create")
  ) {
    throw new Error(
      `Proposal target was created after proposal ${proposal.id} was created; refusing to overwrite newer content.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Judgment tier (Phase 3)
// ---------------------------------------------------------------------------

/** Read the live on-disk content of a proposal's target asset, if it exists. */
function readLiveAssetContent(stashDir: string, ref: string): string | undefined {
  try {
    const parsed = parseRefInput(ref);
    const typeDir = stashDirFor(parsed.type);
    if (!typeDir) return undefined;
    const typeRoot = path.join(stashDir, typeDir);
    const assetPath = assetPathForName(parsed.type, typeRoot, parsed.name);
    if (!fs.existsSync(assetPath)) return undefined;
    return fs.readFileSync(assetPath, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Pre-fetch the context the judgment runner needs to adjudicate one deferred
 * proposal: the proposed content, the live asset it would overwrite, and the
 * sibling pending proposals for the same ref (so a dedup verdict can compare).
 */
function prefetchJudgmentContext(
  stashDir: string,
  proposal: Proposal,
  pending: Proposal[],
): { liveAsset: string | undefined; siblings: Proposal[] } {
  const liveAsset = readLiveAssetContent(stashDir, proposal.ref);
  const siblings = pending.filter((p) => p.ref === proposal.ref && p.id !== proposal.id);
  return { liveAsset, siblings };
}

/** Build the judgment prompt with the proposed content + pre-fetched context. */
export function buildJudgmentPrompt(
  proposal: Proposal,
  reason: DrainDeferReason,
  ctx: { liveAsset: string | undefined; siblings: Proposal[] },
): string {
  const proposed = proposalContent(proposal);
  const sections: string[] = [
    "You are adjudicating a pending knowledge-base proposal that the deterministic",
    "triage pass could not resolve. Decide whether to accept, reject, or defer it.",
    "",
    `Asset ref: ${proposal.ref}`,
    `Generator (source): ${proposal.source}`,
    `Deferred because: ${reason}`,
    "",
    "## Proposed content",
    "```",
    proposed,
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

/** Parse a {@link JudgmentVerdict} from raw runner output. Lenient. */
export function parseJudgmentVerdict(raw: string): JudgmentVerdict | null {
  const cleaned = escapeJsonStringControls(stripCodeFences(stripThinkBlocks(raw))).trim();
  if (!cleaned) return null;
  // Find the first balanced-looking JSON object in the output.
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const decision = (obj as { decision?: unknown }).decision;
  const reason = (obj as { reason?: unknown }).reason;
  if (decision !== "accept" && decision !== "reject" && decision !== "defer") return null;
  return { decision, reason: typeof reason === "string" ? reason : "" };
}

/**
 * Dispatch a single judgment prompt through a strict resolved request. The
 * runner is already frozen by the caller, so preparation and lowering are
 * config-free: no live alias, credential, or provider lookup can alter it.
 */
interface JudgmentDispatchResult {
  verdict: JudgmentVerdict | null;
  notices: readonly Readonly<LoweringNotice>[];
  error?: string;
}

async function dispatchJudgment(
  runner: RunnerSpec,
  prompt: string,
  seams: JudgmentSeams,
  lease: LoweredExecutionDispatchLease,
): Promise<JudgmentDispatchResult> {
  const prepared = prepareInlineExecutionWithRunner({
    content: prompt,
    runner,
    invocationKind: "direct",
  });
  const lowered = lowerResolvedExecutionRequestWithRunner(prepared.request, prepared.runner);
  const chat = seams.chat;
  const llmRunner = lowered.runner.kind === "llm" ? lowered.runner : undefined;
  const dispatchOptions: DispatchLoweredExecutionOptions = {
    lease,
    ...(seams.runAgentFn ? { runAgent: seams.runAgentFn } : {}),
    ...(seams.runSdkFn ? { runSdk: seams.runSdkFn } : {}),
    ...(chat && llmRunner
      ? {
          chat: async (connection, messages) => chat({ ...llmRunner, connection }, messages),
        }
      : {}),
  };
  let result: Awaited<ReturnType<typeof dispatchLoweredExecutionRequest>>;
  try {
    result = await dispatchLoweredExecutionRequest(lowered, dispatchOptions);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    return {
      verdict: null,
      notices: lowered.notices,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!result.ok) {
    return {
      verdict: null,
      notices: lowered.notices,
      error: result.error ?? result.reason ?? "unknown error",
    };
  }
  return { verdict: parseJudgmentVerdict(result.stdout), notices: lowered.notices };
}

/** Validate symbolic judgment credentials without contacting a provider. */
async function preflightJudgmentRunner(runner: RunnerSpec): Promise<LoweredExecutionDispatchLease> {
  const prepared = prepareInlineExecutionWithRunner({
    content: "Validate the selected proposal judgment runner before mutation.",
    runner,
    invocationKind: "direct",
  });
  const lowered = lowerResolvedExecutionRequestWithRunner(prepared.request, prepared.runner);
  return acquireLoweredExecutionDispatchLease(lowered);
}

interface JudgmentTierInput {
  stashDir: string;
  applyMode: "queue" | "promote";
  dryRun: boolean;
  runner: RunnerSpec;
  lease: LoweredExecutionDispatchLease;
  deferred: Array<{ id: string; reason: DrainDeferReason }>;
  pending: Proposal[];
  promoteFn: PromoteFn;
  rejectFn: RejectFn;
  seams: JudgmentSeams;
  target?: string;
  config?: AkmConfig;
  /**
   * Remaining accept budget so (deterministic promotions + judgment-tier
   * promotions) ≤ maxAccepts. Once exhausted, further judge-"accept" items are
   * routed to `skippedByCap` instead of being promoted. Only meaningful in
   * promote mode (queue mode promotes nothing). Defaults to unbounded.
   */
  remainingAcceptBudget: number;
  gateLabel: string;
}

function judgedContentHash(proposal: Proposal): string {
  return createHash("sha256").update(proposalContent(proposal), "utf8").digest("hex");
}

/**
 * Run the judgment tier over the deferred items. The runner only *judges*; the
 * engine performs the resulting accept (respecting `applyMode`) / reject write.
 * Returns the ids the engine promoted / rejected, the ids staged (judge said
 * "accept" but queue mode did not promote), the ids dropped by the accept cap,
 * and the items still unresolved (verdict "defer", parse failure, or a runner
 * error).
 */
async function runJudgmentTier(input: JudgmentTierInput): Promise<{
  promoted: string[];
  rejected: string[];
  staged: string[];
  skippedByCap: string[];
  stillDeferred: Array<{ id: string; reason: DrainDeferReason }>;
  notices: readonly Readonly<LoweringNotice>[];
}> {
  const byId = new Map(input.pending.map((p) => [p.id, p]));
  const promoted: string[] = [];
  const rejected: string[] = [];
  const staged: string[] = [];
  const skippedByCap: string[] = [];
  const stillDeferred: Array<{ id: string; reason: DrainDeferReason }> = [];
  const noticesByKey = new Map<string, Readonly<LoweringNotice>>();
  // Remaining accept budget shared with the deterministic promote loop.
  let acceptBudget = Math.max(0, input.remainingAcceptBudget);

  for (const item of input.deferred) {
    const proposal = byId.get(item.id);
    if (!proposal) {
      stillDeferred.push(item);
      continue;
    }
    const ctx = prefetchJudgmentContext(input.stashDir, proposal, input.pending);
    const prompt = buildJudgmentPrompt(proposal, item.reason, ctx);

    let dispatch: JudgmentDispatchResult;
    try {
      dispatch = await dispatchJudgment(input.runner, prompt, input.seams, input.lease);
    } catch (err) {
      if (err instanceof ConfigError) throw err;
      warn(`[triage] judgment dispatch failed for ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
      stillDeferred.push(item);
      continue;
    }
    for (const notice of dispatch.notices) {
      const key = JSON.stringify(notice);
      if (!noticesByKey.has(key)) noticesByKey.set(key, notice);
    }
    if (dispatch.error) {
      warn(`[triage] judgment dispatch failed for ${item.id}: ${dispatch.error}`);
      stillDeferred.push(item);
      continue;
    }
    const verdict = dispatch.verdict;

    if (!verdict || verdict.decision === "defer") {
      stillDeferred.push(item);
      continue;
    }

    if (verdict.decision === "reject") {
      if (input.dryRun) {
        rejected.push(item.id);
        continue;
      }
      try {
        await input.rejectFn({
          stashDir: input.stashDir,
          id: item.id,
          reason: verdict.reason || "judgment: reject",
          gateDecision: { outcome: "auto-rejected", reason: "judgment-reject", gate: input.gateLabel },
        });
        rejected.push(item.id);
      } catch (err) {
        warn(`[triage] judgment reject failed for ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
        stillDeferred.push(item);
      }
      continue;
    }

    // decision === "accept" — gated on applyMode, exactly like the
    // deterministic accept path (queue mode never writes).
    if (input.applyMode !== "promote") {
      // Staged: a queue-mode run never promotes, so the item stays pending but
      // is RESOLVED (the runner judged it). Track separately so it is NOT
      // reported as "left unresolved" and a follow-up promote run picks it up.
      staged.push(item.id);
      if (!input.dryRun) {
        try {
          recordGateDecision(input.stashDir, item.id, {
            outcome: "staged",
            reason: "judgment-accept",
            contentHash: judgedContentHash(proposal),
            gate: input.gateLabel,
          });
        } catch (err) {
          warn(`[triage] failed to stage judgment for ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
          staged.pop();
          stillDeferred.push(item);
        }
      }
      continue;
    }
    // Accept cap: once the shared budget is exhausted, route further accepts to
    // skippedByCap instead of promoting (keeps total promotions ≤ maxAccepts).
    if (acceptBudget <= 0) {
      skippedByCap.push(item.id);
      continue;
    }
    if (input.dryRun) {
      try {
        if (input.config) {
          preflightProposalPromotion(input.config, proposal, {
            ...(input.target ? { target: input.target } : {}),
            gateDecision: { outcome: "auto-accepted", reason: "judgment-accept", gate: input.gateLabel },
          });
        }
      } catch (err) {
        warn(`[triage] judgment preflight failed for ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
        stillDeferred.push(item);
        continue;
      }
      promoted.push(item.id);
      acceptBudget -= 1;
      continue;
    }
    try {
      await input.promoteFn({
        stashDir: input.stashDir,
        id: item.id,
        ...(input.target ? { target: input.target } : {}),
        ...(input.config ? { config: input.config } : {}),
        gateDecision: { outcome: "auto-accepted", reason: "judgment-accept", gate: input.gateLabel },
      });
      promoted.push(item.id);
      acceptBudget -= 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        categorizeDrainFailure(message, "promote-error") === STALE_TARGET_GATE_REASON &&
        (await autoRejectStaleTarget(input.stashDir, input.gateLabel, item.id, message, input.rejectFn))
      ) {
        rejected.push(item.id);
        continue;
      }
      warn(`[triage] judgment promote failed for ${item.id}: ${message}`);
      stillDeferred.push(item);
    }
  }

  return {
    promoted,
    rejected,
    staged,
    skippedByCap,
    stillDeferred,
    notices: Object.freeze([...noticesByKey.values()]),
  };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

interface DrainClassification {
  pending: Proposal[];
  acceptIds: string[];
  acceptGateReasons: Map<string, "policy-accept" | "judgment-accept">;
  rejectTargets: Array<{ id: string; reason: string }>;
  deferred: DrainResult["deferred"];
  deferredGateDecisions: Array<{ id: string; decision: Omit<ProposalGateDecision, "decidedAt"> }>;
  gateLabel: string;
  needsJudge: Set<string>;
}

/** Classify the queue without mutating proposal, event, or promotion state. */
function classifyPendingProposals(opts: DrainOptions): DrainClassification {
  const exclude = opts.excludeIds ?? new Set<string>();
  // A configured judgment runner must be credential-validated before any live
  // state connection or migration. Its classification pass therefore reads an
  // isolated SQLite snapshot; deterministic-only drains retain the historical
  // live/migrating queue read.
  const pending = (opts.judgment ? listProposalsReadOnly : listProposals)(opts.stashDir, {
    status: "pending",
  }).filter((proposal) => !exclude.has(proposal.id));
  const acceptIds: string[] = [];
  const acceptGateReasons = new Map<string, "policy-accept" | "judgment-accept">();
  const rejectTargets: Array<{ id: string; reason: string }> = [];
  const deferred: DrainResult["deferred"] = [];
  const deferredGateDecisions: DrainClassification["deferredGateDecisions"] = [];
  const gateLabel = `triage:${opts.policy.name}`;
  const needsJudge = new Set<string>();

  for (const proposal of pending) {
    // An authoritative rejection from another gate stays pending and is never
    // silently overwritten by this triage policy.
    if (proposal.gateDecision?.outcome === "auto-rejected" && !proposal.gateDecision.gate?.startsWith("triage:")) {
      continue;
    }
    // REVIEW: a `review_needed` distill/promote-memory row is stamped
    // `deferred`/`quality-gate` by `writeQualityRejection` (distill/quality-gate.ts)
    // precisely because the quality judge could not decide and wants a human,
    // not the judgment tier, to see it. Skip it here — before `classifyProposal`
    // would otherwise defer it to the judgment tier (which can auto-accept
    // under `applyMode: promote`) and before the policy-deferred re-stamp loop
    // in `drainProposals` would overwrite this stamp with a `triage:` one.
    if (proposal.gateDecision?.outcome === "deferred" && proposal.gateDecision.gate === "quality-gate") {
      continue;
    }
    if (
      proposal.gateDecision?.outcome === "staged" &&
      proposal.gateDecision.gate === gateLabel &&
      proposal.gateDecision.contentHash === judgedContentHash(proposal)
    ) {
      acceptIds.push(proposal.id);
      acceptGateReasons.set(proposal.id, "judgment-accept");
      continue;
    }

    const decision = classifyProposal(proposal, opts.policy, opts.maxDiffLines);
    if (decision === null) continue;
    if (decision.verdict === "defer") {
      deferredGateDecisions.push({
        id: proposal.id,
        decision: {
          outcome: "deferred",
          reason: decision.gate.reason,
          ...(decision.gate.measured !== undefined ? { measured: decision.gate.measured } : {}),
          ...(decision.gate.thresholds ? { thresholds: decision.gate.thresholds } : {}),
          gate: gateLabel,
        },
      });
      if (!decision.gate.thresholds) needsJudge.add(proposal.id);
    }

    if (decision.verdict === "accept") {
      acceptIds.push(proposal.id);
      acceptGateReasons.set(proposal.id, "policy-accept");
    } else if (decision.verdict === "reject") {
      rejectTargets.push({ id: proposal.id, reason: decision.reason });
    } else {
      deferred.push({ id: proposal.id, reason: decision.reason });
    }
  }

  return {
    pending,
    acceptIds,
    acceptGateReasons,
    rejectTargets,
    deferred,
    deferredGateDecisions,
    gateLabel,
    needsJudge,
  };
}

/**
 * Drain the standing pending backlog under a deterministic policy.
 *
 * @param opts       Drain options (policy, applyMode, ceilings, dry-run).
 * @param promoteFn  Injectable override for `akmProposalAccept` (test seam).
 * @param rejectFn   Injectable override for `akmProposalReject` (test seam).
 */
export async function drainProposals(
  opts: DrainOptions,
  promoteFn: PromoteFn = akmProposalAccept,
  rejectFn: RejectFn = akmProposalReject,
  judgmentSeams: JudgmentSeams = {},
): Promise<DrainResult> {
  const classification = classifyPendingProposals(opts);
  const { pending, acceptIds, acceptGateReasons, rejectTargets, deferredGateDecisions, gateLabel, needsJudge } =
    classification;
  const result: DrainResult = {
    promoted: [],
    rejected: [],
    deferred: classification.deferred,
    skippedByCap: [],
    staged: [],
    failed: [],
  };

  // A configured judgment runner makes every deferred item dispatch-eligible.
  // Validate its symbolic credentials before applying any deterministic gate,
  // reject, promote, or event mutation. Provider/runtime failures remain the
  // judgment tier's fail-soft responsibility after this configuration fence.
  const dispatchLease =
    opts.judgment && result.deferred.length > 0 ? await preflightJudgmentRunner(opts.judgment) : undefined;
  try {
    for (const { id, decision } of deferredGateDecisions) stampGateDecision(opts, id, decision);

    // --- Reject empties (independent of the accept ceiling / applyMode) ---
    for (const target of rejectTargets) {
      if (opts.dryRun) {
        result.rejected.push(target.id);
        continue;
      }
      try {
        await rejectFn({
          stashDir: opts.stashDir,
          id: target.id,
          reason: target.reason,
          gateDecision: { outcome: "auto-rejected", reason: "empty-diff", gate: gateLabel },
        });
        result.rejected.push(target.id);
      } catch (err) {
        const message = pushDrainFailure(result, target.id, err, "reject-error");
        warn(`[triage] reject failed for ${target.id}: ${message}`);
      }
    }

    // --- Accept ceiling: enforced BEFORE the promote loop ---
    const withinCap = acceptIds.slice(0, Math.max(0, opts.maxAccepts));
    result.skippedByCap = acceptIds.slice(Math.max(0, opts.maxAccepts));
    if (result.skippedByCap.length > 0) {
      info(
        `[triage] accept ceiling reached: ${withinCap.length} promoted, ${result.skippedByCap.length} skipped by cap (maxAccepts=${opts.maxAccepts})`,
      );
    }

    // --- Promotion gate: applyMode "queue" never promotes (stage only) ---
    // Count deterministic promotions so the judgment tier shares the same accept
    // budget (deterministic + judgment promotions ≤ maxAccepts).
    let deterministicPromoted = 0;
    if (opts.applyMode === "promote" && !opts.dryRun) {
      info(`[triage] auto-promote active: ${withinCap.length} accepts allowed this run`);
      for (const id of withinCap) {
        try {
          await promoteFn({
            stashDir: opts.stashDir,
            id,
            ...(opts.target ? { target: opts.target } : {}),
            ...(opts.config ? { config: opts.config } : {}),
            gateDecision: {
              outcome: "auto-accepted",
              reason: acceptGateReasons.get(id) ?? "policy-accept",
              gate: gateLabel,
            },
          });
          result.promoted.push(id);
          deterministicPromoted += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (
            categorizeDrainFailure(message, "promote-error") === STALE_TARGET_GATE_REASON &&
            (await autoRejectStaleTarget(opts.stashDir, gateLabel, id, message, rejectFn))
          ) {
            result.rejected.push(id);
            continue;
          }
          pushDrainFailure(result, id, err, "promote-error");
          warn(`[triage] promote failed for ${id}: ${message}`);
        }
      }
    } else if (opts.applyMode === "promote" && opts.dryRun) {
      // Exercise the same stamped candidate, lint, and stale-target boundary as
      // real promotion so a dry-run's predicted promotions match what a real
      // run would do. Tests that omit config retain the classification-only seam.
      const byId = new Map(pending.map((proposal) => [proposal.id, proposal]));
      for (const id of withinCap) {
        try {
          if (opts.config) {
            const proposal = byId.get(id);
            if (!proposal) throw new Error(`Proposal ${id} disappeared during drain preflight.`);
            const preflight = preflightProposalPromotion(opts.config, proposal, {
              ...(opts.target ? { target: opts.target } : {}),
              gateDecision: {
                outcome: "auto-accepted",
                reason: acceptGateReasons.get(id) ?? "policy-accept",
                gate: gateLabel,
              },
            });
            assertProposalTargetFresh(proposal, preflight.assetPath);
          }
          result.promoted.push(id);
          deterministicPromoted += 1;
        } catch (err) {
          const message = pushDrainFailure(result, id, err, "promote-error");
          warn(`[triage] preflight failed for ${id}: ${message}`);
        }
      }
    }
    // applyMode "queue": leave accept candidates pending (staged). No promotion.

    // Remaining accept budget for the judgment tier: maxAccepts minus what was
    // actually promoted deterministically. Bounds the TOTAL promotions, not just
    // the deterministic path. Moot in queue mode (it promotes nothing).
    const remainingAcceptBudget = Math.max(0, Math.max(0, opts.maxAccepts) - deterministicPromoted);

    // --- Judgment tier (Phase 3): adjudicate the deferred items ---
    // Only runs when a RunnerSpec is configured. The runner returns a verdict; the
    // ENGINE performs the resulting accept (respecting applyMode) / reject write.
    if (opts.judgment && result.deferred.length > 0) {
      if (!dispatchLease) throw new TypeError("proposal judgment work requires an operation dispatch lease");
      const tier = await runJudgmentTier({
        stashDir: opts.stashDir,
        applyMode: opts.applyMode,
        dryRun: opts.dryRun,
        runner: opts.judgment,
        lease: dispatchLease,
        deferred: result.deferred,
        pending,
        promoteFn,
        rejectFn,
        seams: judgmentSeams,
        ...(opts.target ? { target: opts.target } : {}),
        ...(opts.config ? { config: opts.config } : {}),
        remainingAcceptBudget,
        gateLabel,
      });
      result.promoted.push(...tier.promoted);
      result.rejected.push(...tier.rejected);
      result.staged.push(...tier.staged);
      if (tier.notices.length > 0) result.notices = tier.notices;
      // Judgment-tier accepts dropped by the shared accept cap surface under
      // skippedByCap, same as deterministic cap drops.
      result.skippedByCap.push(...tier.skippedByCap);
      if (tier.skippedByCap.length > 0) {
        info(
          `[triage] accept ceiling reached in judgment tier: ${tier.skippedByCap.length} judged-accept items skipped by cap (maxAccepts=${opts.maxAccepts})`,
        );
      }
      // Replace the deferred list with only the items the judgment tier could NOT
      // resolve (verdict "defer", parse failure, or runner error). Staged
      // queue-mode accepts are RESOLVED and tracked in result.staged instead.
      result.deferred = tier.stillDeferred;
    } else if (result.deferred.length > 0) {
      // #577: no judgment runner configured — items deferred *because they need a
      // judge* (mid-band / possible-dup, no threshold reason) stay pending solely
      // for lack of one. Re-stamp those as `no-judge-configured` so the operator
      // sees a per-proposal reason instead of inferring it from the run-level
      // triage_deferred aggregate. Band-deferred items keep their specific reason
      // (e.g. `max-diff-lines`), which is more actionable than "no judge".
      for (const item of result.deferred) {
        if (needsJudge.has(item.id)) {
          stampGateDecision(opts, item.id, { outcome: "deferred", reason: "no-judge-configured", gate: gateLabel });
        }
      }
    }

    emitDrainEvents(opts, result);

    return result;
  } finally {
    if (dispatchLease) disposeLoweredExecutionDispatchLease(dispatchLease);
  }
}

/**
 * Persist a gate decision onto a proposal, honouring the dry-run contract
 * (a dry run performs zero writes, so it records nothing) and never letting a
 * persistence failure abort the drain (#577). Best-effort by design.
 */
function stampGateDecision(opts: DrainOptions, id: string, decision: Omit<ProposalGateDecision, "decidedAt">): void {
  if (opts.dryRun) return;
  try {
    recordGateDecision(opts.stashDir, id, decision);
  } catch (err) {
    warn(`[triage] failed to record gate decision for ${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function emitDrainEvents(opts: DrainOptions, result: DrainResult): void {
  const deferredByReason: Record<string, number> = {};
  for (const d of result.deferred) {
    deferredByReason[d.reason] = (deferredByReason[d.reason] ?? 0) + 1;
  }

  appendEvent(
    {
      eventType: "triage_drained",
      metadata: {
        promoted: result.promoted.length,
        rejected: result.rejected.length,
        deferredByReason,
        skippedByCap: result.skippedByCap.length,
        ...(result.staged.length > 0 ? { staged: result.staged.length } : {}),
        policy: opts.policy.name,
        applyMode: opts.applyMode,
        ...(opts.dryRun ? { dryRun: true } : {}),
      },
    },
    opts.eventsCtx ?? {},
  );

  // Surface any items the judge could NOT resolve after the (optional) judgment
  // tier so a backlog of deferred items never silently looks like full success.
  // This fires when no runner is configured OR the judgment tier ran but could
  // not resolve every item (verdict "defer", parse failure, or a runner error).
  // Queue-mode staged accepts are RESOLVED (the judge decided) and live in
  // result.staged, so they are deliberately excluded from this "unresolved" count.
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
