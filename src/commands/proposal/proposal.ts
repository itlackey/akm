// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm proposal {list,show,accept,reject,reopen,diff}` — review surface for the
 * proposal substrate (#225).
 *
 * Each function returns a plain JSON envelope; the CLI dispatcher in
 * `src/cli.ts` flows the result through the standard
 * `shapeForCommand` + `formatPlain` pipeline. There is no `JSON.stringify`
 * fallback in the output layer — every shape is registered explicitly in
 * `src/output/shapes.ts` and `src/output/text.ts`.
 */

import { resolveStashDir } from "../../core/common";
import type { AkmConfig } from "../../core/config/config";
import { loadConfig } from "../../core/config/config";
import { NotFoundError } from "../../core/errors";
import type { ResolvedWriteTarget } from "../../core/write-source";
import { resolveWriteTarget } from "../../core/write-source";
import { withAssetMutationLease } from "../../indexer/index-writer-lock";
import { isRetireProposal, proposalWaitingSince, type RetirementMetadata } from "./proposal-types";
import {
  diffProposal,
  listProposals,
  type Proposal,
  type ProposalGateDecision,
  type ProposalsContext,
  preflightProposalPromotion,
  promoteProposal,
  proposalContent,
  rejectProposalDurably,
  reopenProposals,
  resolveProposalId,
  revertProposal,
} from "./repository";
import { validateProposal } from "./validators/proposals";

// ── Shared helpers ──────────────────────────────────────────────────────────

function resolveStash(stashDir?: string): string {
  if (stashDir) return stashDir;
  return resolveStashDir();
}

interface ResolvedProposalQueue {
  stashDir: string;
  target?: ResolvedWriteTarget;
}

function resolveProposalQueue(
  stashDir: string | undefined,
  queue: string | undefined,
  config?: AkmConfig,
): ResolvedProposalQueue {
  if (stashDir) return { stashDir };
  if (!queue) return { stashDir: resolveStash() };
  const target = resolveWriteTarget(config ?? loadConfig(), queue);
  return { stashDir: target.source.path, target };
}

// ── list ────────────────────────────────────────────────────────────────────

export interface ProposalListOptions {
  stashDir?: string;
  queue?: string;
  config?: AkmConfig;
  status?: "pending" | "accepted" | "rejected" | "reverted";
  ref?: string;
  type?: string;
  includeArchive?: boolean;
  /** Match proposals whose `source` equals this generator (e.g. reflect, distill, consolidate-pair) — same filter `accept`/`reject --generator` already apply. */
  generator?: string;
}

export interface ProposalListResult {
  schemaVersion: 1;
  totalCount: number;
  proposals: Proposal[];
}

/**
 * Thin in-process read of the pending proposal queue, used by the health HTML
 * report builder (#582) so it never shells out to `akm proposal list`.
 *
 * Deliberately narrow (one optional arg, returns the storage-layer rows) so
 * the parallel proposal-storage-to-SQLite consolidation only has to swap this
 * one function's body.
 */
export function listPendingProposals(stashDir?: string): Proposal[] {
  return listProposals(resolveStash(stashDir), { status: "pending" });
}

export function akmProposalList(options: ProposalListOptions = {}): ProposalListResult {
  const { stashDir: stash } = resolveProposalQueue(options.stashDir, options.queue, options.config);
  // `--status accepted|rejected|reverted` implies archive-inclusion since the
  // live queue only ever contains pending entries.
  const includeArchive =
    options.includeArchive === true ||
    options.status === "accepted" ||
    options.status === "rejected" ||
    options.status === "reverted";
  const proposals = listProposals(stash, {
    includeArchive,
    status: options.status,
    ref: options.ref,
    type: options.type,
  }).filter((p) => options.generator === undefined || p.source === options.generator);
  return { schemaVersion: 1, totalCount: proposals.length, proposals };
}

// ── show ────────────────────────────────────────────────────────────────────

export interface ProposalShowOptions {
  stashDir?: string;
  queue?: string;
  config?: AkmConfig;
  id: string;
}

export interface ProposalShowResult {
  schemaVersion: 1;
  proposal: Proposal;
  validation: { ok: boolean; findings: { kind: string; message: string }[] };
}

export function akmProposalShow(options: ProposalShowOptions): ProposalShowResult {
  const queue = resolveProposalQueue(options.stashDir, options.queue, options.config);
  const stash = queue.stashDir;
  const proposal = resolveProposalId(stash, options.id);
  let validation = validateProposal(proposal);
  // An explicit stashDir without config is an in-process storage test seam; it
  // has no authenticated write-target context to preflight against. A retire
  // proposal writes no content — preflightProposalPromotion's stamp/lint
  // machinery is create/update-shaped and has nothing meaningful to check
  // here; `diff` already shows the body being retired.
  if (
    validation.ok &&
    proposal.status === "pending" &&
    !isRetireProposal(proposal) &&
    (options.config !== undefined || options.stashDir === undefined)
  ) {
    try {
      preflightProposalPromotion(options.config ?? loadConfig(), proposal, { queueTarget: queue.target });
    } catch (error) {
      validation = {
        ok: false,
        findings: [{ kind: "promotion", message: error instanceof Error ? error.message : String(error) }],
      };
    }
  }
  return {
    schemaVersion: 1,
    proposal,
    validation,
  };
}

// ── accept ──────────────────────────────────────────────────────────────────

export interface ProposalAcceptOptions {
  stashDir?: string;
  id: string;
  queue?: string;
  target?: string;
  /** Test seam — overrides config used for the write target. */
  config?: AkmConfig;
  /** Test seam — overrides clock / id source. */
  ctx?: ProposalsContext;
  /** Internal drain adjudication metadata, persisted with the terminal transition. */
  gateDecision?: Omit<ProposalGateDecision, "decidedAt"> & { decidedAt?: string };
}

export interface ProposalAcceptResult {
  schemaVersion: 1;
  ok: true;
  id: string;
  ref: string;
  assetPath: string;
  proposal: Proposal;
}

export async function akmProposalAccept(options: ProposalAcceptOptions): Promise<ProposalAcceptResult> {
  const config = options.config ?? loadConfig();
  const queue = resolveProposalQueue(options.stashDir, options.queue, config);
  const stash = queue.stashDir;
  const resolvedId = resolveProposalId(stash, options.id).id;
  const result = await promoteProposal(
    stash,
    config,
    resolvedId,
    { target: options.target, queueTarget: queue.target, gateDecision: options.gateDecision },
    options.ctx,
  );

  return {
    schemaVersion: 1,
    ok: true,
    id: result.proposal.id,
    ref: result.ref,
    assetPath: result.assetPath,
    proposal: result.proposal,
  };
}

// ── reject ──────────────────────────────────────────────────────────────────

export interface ProposalRejectOptions {
  stashDir?: string;
  id: string;
  queue?: string;
  reason?: string;
  ctx?: ProposalsContext;
  config?: AkmConfig;
  /** Internal drain adjudication metadata, persisted with the terminal transition. */
  gateDecision?: Omit<ProposalGateDecision, "decidedAt"> & { decidedAt?: string };
}

export interface ProposalRejectResult {
  schemaVersion: 1;
  ok: true;
  id: string;
  ref: string;
  reason?: string;
  proposal: Proposal;
}

export async function akmProposalReject(options: ProposalRejectOptions): Promise<ProposalRejectResult> {
  return withAssetMutationLease("proposal-reject", async () => {
    const config = options.config ?? loadConfig();
    const { stashDir: stash } = resolveProposalQueue(options.stashDir, options.queue, config);
    const proposalId = resolveProposalId(stash, options.id, options.ctx).id;
    const updated = rejectProposalDurably(stash, proposalId, options.reason, options.ctx, options.gateDecision);

    return {
      schemaVersion: 1,
      ok: true,
      id: updated.id,
      ref: updated.ref,
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
      proposal: updated,
    };
  });
}

// ── reopen ──────────────────────────────────────────────────────────────────

export interface ProposalReopenOptions {
  stashDir?: string;
  /** Proposal ids (full uuid) or asset refs; every one must be a rejected proposal. */
  ids: readonly string[];
  queue?: string;
  /** Why the rejection is being undone; kept in the proposal's review history. */
  reason?: string;
  ctx?: ProposalsContext;
  config?: AkmConfig;
}

/** One reopened proposal, in the envelope shape `reject` uses (`reason` here is the reopen reason). */
export interface ProposalReopenResult {
  schemaVersion: 1;
  ok: true;
  id: string;
  ref: string;
  reason?: string;
  proposal: Proposal;
}

/**
 * Put rejected proposals back in the queue as `pending` (#997) — the undo the
 * proposal queue lacked. All-or-nothing: see {@link reopenProposals}. An
 * archived proposal is found by its full id (a prefix only matches the pending
 * queue), the same as `revert`.
 */
export async function akmProposalReopen(options: ProposalReopenOptions): Promise<ProposalReopenResult[]> {
  return withAssetMutationLease("proposal-reopen", async () => {
    const config = options.config ?? loadConfig();
    const queue = resolveProposalQueue(options.stashDir, options.queue, config);
    const ids = options.ids.map((id) => {
      try {
        return resolveProposalId(queue.stashDir, id, options.ctx).id;
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
        throw new NotFoundError(
          error.message,
          error.code,
          "A rejected proposal is addressed by its full id (a prefix only matches pending proposals): `akm proposal list --status rejected` lists them.",
        );
      }
    });
    const reopened = reopenProposals(
      queue.stashDir,
      config,
      ids,
      { queueTarget: queue.target, ...(options.reason !== undefined ? { reason: options.reason } : {}) },
      options.ctx,
    );
    return reopened.map((proposal) => ({
      schemaVersion: 1 as const,
      ok: true as const,
      id: proposal.id,
      ref: proposal.ref,
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
      proposal,
    }));
  });
}

// ── diff ────────────────────────────────────────────────────────────────────

export interface ProposalDiffOptions {
  stashDir?: string;
  id: string;
  queue?: string;
  target?: string;
  config?: AkmConfig;
}

/** What a reviewer of a retire proposal needs to know that its diff (a file leaving) does not say. */
const RETIRE_DIFF_NOTE =
  "Accepting archives the retired file under .akm/memory-cleanup/archive/ (nothing is deleted); " +
  "`akm proposal revert` restores it byte-exactly.";

export interface ProposalDiffResult {
  schemaVersion: 1;
  id: string;
  ref: string;
  isNew: boolean;
  unified: string;
  targetPath?: string;
  /** `delete` on a retire proposal (accept archives its target); absent on a create or update. */
  op?: "delete";
  /**
   * The pair verdict behind a retire proposal, under the keys `proposal show`
   * reports it (`judgeReason` is the judge's text; the stored block's `reason`
   * is the tombstone vocabulary and is not repeated here). `continuityRisk`
   * appears when the retirement continuity check flagged the pair. Absent
   * unless `op` is `delete`.
   */
  retirement?: Pick<
    RetirementMetadata,
    "retiredRef" | "successorRef" | "judgeLabel" | "judgeReason" | "cosine" | "continuityRisk"
  >;
  /** Present with `op: "delete"`: what accept and revert do to the retired file. */
  note?: string;
}

/** The fields a retire proposal's diff result adds to an ordinary one (#997). */
function retireDiffFields(
  retirement: RetirementMetadata | undefined,
): Pick<ProposalDiffResult, "op" | "retirement" | "note"> {
  return {
    op: "delete",
    ...(retirement
      ? {
          retirement: {
            retiredRef: retirement.retiredRef,
            successorRef: retirement.successorRef,
            judgeLabel: retirement.judgeLabel,
            judgeReason: retirement.judgeReason,
            cosine: retirement.cosine,
            ...(retirement.continuityRisk ? { continuityRisk: retirement.continuityRisk } : {}),
          },
        }
      : {}),
    note: RETIRE_DIFF_NOTE,
  };
}

export function akmProposalDiff(options: ProposalDiffOptions): ProposalDiffResult {
  const config = options.config ?? loadConfig();
  const queue = resolveProposalQueue(options.stashDir, options.queue, config);
  const stash = queue.stashDir;
  const proposal = resolveProposalId(stash, options.id);
  const diff = diffProposal(stash, config, proposal.id, { target: options.target, queueTarget: queue.target });
  return {
    schemaVersion: 1,
    id: proposal.id,
    ref: proposal.ref,
    isNew: diff.isNew,
    unified: diff.unified,
    ...(diff.targetPath ? { targetPath: diff.targetPath } : {}),
    ...(isRetireProposal(proposal) ? retireDiffFields(proposal.retirement) : {}),
  };
}

// ── revert (Phase 6C / Advantage D6c) ────────────────────────────────────────

export interface ProposalRevertOptions {
  stashDir?: string;
  /** Proposal id (uuid / prefix) or asset ref. */
  id: string;
  /** Select the proposal queue by configured source name. */
  queue?: string;
  /** Override the write target by source name (same semantics as accept). */
  target?: string;
  /** Test seam — overrides config used for the write target. */
  config?: AkmConfig;
  /** Test seam — overrides clock / id source. */
  ctx?: ProposalsContext;
}

export interface ProposalRevertResult {
  schemaVersion: 1;
  ok: true;
  id: string;
  ref: string;
  assetPath: string;
  proposal: Proposal;
}

/**
 * Restore an accepted proposal's prior content from the backup captured at
 * promotion time (Advantage D6c / Phase 6C).
 *
 * Failure modes (all surface as typed errors so the CLI can map exit codes):
 *   - Proposal id does not resolve → `NotFoundError("FILE_NOT_FOUND")`
 *     (raised by `resolveProposalId` / `getProposal`).
 *   - Proposal is not `status === "accepted"` → `UsageError("INVALID_FLAG_VALUE")`
 *     with message `"only accepted proposals can be reverted ..."`.
 *   - No backup content on the record (new-asset proposals capture none) →
 *     `UsageError` with message `"no backup available for this proposal ..."`.
 *
 * On success, emits a `proposal_reverted` event for observability, mirroring
 * how `akmProposalAccept` emits `promoted` and `akmProposalReject` emits
 * `rejected`.
 */
export async function akmProposalRevert(options: ProposalRevertOptions): Promise<ProposalRevertResult> {
  const config = options.config ?? loadConfig();
  const queue = resolveProposalQueue(options.stashDir, options.queue, config);
  const stash = queue.stashDir;
  const resolvedId = resolveProposalId(stash, options.id).id;
  const result = await revertProposal(
    stash,
    config,
    resolvedId,
    { target: options.target, queueTarget: queue.target },
    options.ctx,
  );

  return {
    schemaVersion: 1,
    ok: true,
    id: result.proposal.id,
    ref: result.ref,
    assetPath: result.assetPath,
    proposal: result.proposal,
  };
}

// ── bulk adjudication (F-6 / #393) ──────────────────────────────────────────

export interface BulkAdjudicateOptions {
  stashDir?: string;
  queue?: string;
  /** Which way to adjudicate every matching pending proposal. */
  action: "accept" | "reject";
  /** Match proposals whose `source` equals this generator (required). */
  generator: string;
  /** Skip proposals whose payload content exceeds this many lines. */
  maxDiffLines?: number;
  /** Only adjudicate proposals older than this many milliseconds. */
  olderThanMs?: number;
  /** Record matches without mutating anything. */
  dryRun?: boolean;
  /** accept-only: forwarded to `akmProposalAccept`. */
  target?: string;
  /** reject-only: forwarded to `akmProposalReject`. */
  reason?: string;
  config?: AkmConfig;
}

export interface BulkAdjudicateResult {
  /** Number of proposals adjudicated (or matched, under dryRun). */
  count: number;
  /** Per-proposal outcomes: accept/reject envelopes, or dry-run records. */
  results: Array<
    ProposalAcceptResult | ProposalRejectResult | { id: string; ref: string; source: string; dryRun: true }
  >;
  /**
   * S4: `action: "accept"` only — pending proposals from this generator that
   * matched every other filter (`--max-diff-lines`, `--older-than`) but were
   * skipped because they carry `retirement.continuityRisk`, never bulk
   * accepted (only acceptable by id). Always 0 for `action: "reject"`.
   */
  skippedForContinuityRisk: number;
}

/** The retired file's current line count for `--max-diff-lines` (S6); unresolvable is never size-filtered here — the real accept/reject attempt fails cleanly on a genuinely stale target. */
function retiredTargetLineCount(
  stashDir: string,
  config: AkmConfig,
  proposal: Proposal,
  queueTarget?: ResolvedWriteTarget,
): number {
  try {
    const existing = diffProposal(stashDir, config, proposal.id, { queueTarget }).existing;
    return existing === null ? 0 : existing.split("\n").length;
  } catch {
    return 0;
  }
}

/**
 * Bulk accept/reject every pending proposal from one generator, applying the
 * shared `--max-diff-lines` / `--older-than` filters. Consolidates the two
 * near-identical loops that lived in `proposal-cli.ts` (Chunk 6 WI-6.6);
 * behavior is verbatim — same filter order, same per-item envelopes, same
 * dry-run record shape. The destructive-confirmation prompt stays CLI-side.
 */
export async function bulkAdjudicateProposals(options: BulkAdjudicateOptions): Promise<BulkAdjudicateResult> {
  const config = options.config ?? loadConfig();
  const { stashDir, target: queueTarget } = resolveProposalQueue(options.stashDir, options.queue, config);
  // Every filter EXCEPT the continuityRisk exclusion below — matched against
  // separately so its own count (S4) can be reported apart from an ordinary
  // --max-diff-lines/--older-than miss.
  const matched = listProposals(stashDir, { status: "pending" }).filter((p) => {
    if (p.source !== options.generator) return false;
    if (options.maxDiffLines !== undefined) {
      // S6: a retire proposal's own payload is empty (it deletes its
      // target) — proposalContent() would always read as 1 line, so
      // --max-diff-lines could never filter one out. Count the retired
      // file's own current line count instead.
      const lines = isRetireProposal(p)
        ? retiredTargetLineCount(stashDir, config, p, queueTarget)
        : proposalContent(p).split("\n").length;
      if (lines > options.maxDiffLines) return false;
    }
    if (options.olderThanMs !== undefined) {
      const age = Date.now() - new Date(proposalWaitingSince(p)).getTime();
      if (age < options.olderThanMs) return false;
    }
    return true;
  });
  // Item 1 (continuity check, alpha.9 plan §5.4, rule R3): a retire proposal
  // the check flagged is never bulk-accepted, by generator or any other
  // sweep — only a person accepting it by id can. Bulk reject is unaffected:
  // declining a risky proposal is never the unsafe direction.
  const isContinuityExcluded = (p: Proposal): boolean =>
    options.action === "accept" && Boolean(p.retirement?.continuityRisk);
  const skippedForContinuityRisk = matched.filter(isContinuityExcluded).length;
  const pending = matched.filter((p) => !isContinuityExcluded(p));
  const results: BulkAdjudicateResult["results"] = [];
  for (const proposal of pending) {
    if (options.dryRun) {
      results.push({ id: proposal.id, ref: proposal.ref, source: proposal.source, dryRun: true });
    } else if (options.action === "accept") {
      results.push(
        await akmProposalAccept({ stashDir, id: proposal.id, queue: options.queue, target: options.target, config }),
      );
    } else {
      results.push(
        await akmProposalReject({ stashDir, id: proposal.id, queue: options.queue, reason: options.reason, config }),
      );
    }
  }
  return { count: results.length, results, skippedForContinuityRisk };
}
