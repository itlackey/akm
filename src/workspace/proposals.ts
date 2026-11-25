// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Proposals: the review queue, one proposal with its capped diff, the decisions, and the recent changes. */

import { diffLoadedProposal } from "../commands/proposal/accept";
import {
  akmProposalAccept,
  akmProposalAcceptMany,
  akmProposalReject,
  akmProposalReopen,
  akmProposalRevert,
  type ProposalAcceptResult,
} from "../commands/proposal/proposal";
import { isRetireProposal, type Proposal, proposalWaitingSince } from "../commands/proposal/proposal-types";
import { resolveProposalIdIn } from "../commands/proposal/repository";
import { validateProposal } from "../commands/proposal/validators/proposals";
import { parsePlacementRef } from "../core/asset/resolve-ref";
import { stateBundleId } from "../core/bundle-at-dir";
import { resolveStashDir } from "../core/common";
import { loadConfig } from "../core/config/config";
import { AkmError, NotFoundError, UsageError } from "../core/errors";
import { resolveWriteTarget } from "../core/write-source";
import { listStateProposals } from "../storage/repositories/proposals-repository";
import { classifyOutcome, decidedAt, weekOf } from "./derive";
import { readRecentCommits } from "./git-read";
import { interactive } from "./lease";
import { PROPOSAL_AGE_BANDS, proposalAgeBand, proposalBacklog } from "./metrics";
import { capSide, clampLimit, stateDbUnavailable, withReadonlyStateDb } from "./readers";

const MAX_REJECT_REASON = 2000;
const MAX_BATCH_IDS = 200;

export interface ListInput {
  /** `pending` (default) or `recent` (accepted, rejected or reverted). */
  status?: string;
  source?: string;
  age?: string;
  /** The proposals decided in one ISO week (`YYYY-MM-DD`, a Monday). */
  week?: string;
  /** One outcome class: judge, you, unknown, rejected or reverted. */
  class?: string;
  limit?: number;
}

function summary(proposal: Proposal) {
  const retirement = proposal.retirement;
  return {
    id: proposal.id,
    source: proposal.source,
    ref: proposal.ref,
    status: proposal.status,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    waitingSince: proposalWaitingSince(proposal),
    // A reverted proposal is dated by its accept, as the impact figures are.
    decidedAt: proposal.status === "pending" ? null : decidedAt(proposal),
    confidence: proposal.confidence ?? null,
    gateDecision: proposal.gateDecision ?? null,
    review: proposal.review ?? null,
    isRetire: isRetireProposal(proposal),
    // An accepted change can be undone when accept kept a backup of what it replaced; a created asset has none.
    revertable: proposal.status === "accepted" && typeof proposal.backupContent === "string",
    // Who decided: the judge ("triage"), a person, or unknown for a decision recorded before decidedBy existed.
    decider: proposal.review?.decidedBy ?? null,
    retirement: retirement
      ? {
          retiredRef: retirement.retiredRef,
          successorRef: retirement.successorRef,
          reason: retirement.reason,
          judgeLabel: retirement.judgeLabel,
          judgeReason: retirement.judgeReason,
          cosine: retirement.cosine,
          onlyInRetired: retirement.onlyInRetired ?? [],
          onlyInSuccessor: retirement.onlyInSuccessor ?? [],
          continuityRisk: retirement.continuityRisk ?? null,
        }
      : null,
  };
}

const RECENT_STATUSES = new Set(["accepted", "rejected", "reverted"]);

export function list(input: ListInput = {}) {
  const status = input.status || "pending";
  if (status !== "pending" && status !== "recent") {
    throw new UsageError(`Invalid status "${status}". Expected pending or recent.`, "INVALID_FLAG_VALUE");
  }
  const limit = clampLimit(input.limit, 100);
  const source = input.source || "";
  const age = input.age || "";
  if (age && !PROPOSAL_AGE_BANDS.some((band) => band === age)) {
    throw new UsageError("Invalid proposal age band.", "INVALID_FLAG_VALUE");
  }
  // Drill-down from a chart: the proposals decided in one ISO week (`week=YYYY-MM-DD`, a Monday) or of one outcome class.
  const week = input.week || "";
  if (week && !/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new UsageError("Invalid week.", "INVALID_FLAG_VALUE");
  const outcome = input.class || "";
  if (outcome && !["judge", "you", "unknown", "rejected", "reverted"].includes(outcome))
    throw new UsageError("Invalid outcome class.", "INVALID_FLAG_VALUE");
  const now = Date.now();
  return (
    withReadonlyStateDb((db) => {
      // A list shows summaries, so the proposed content is not read.
      const all = listStateProposals(db, { bundleId: stateBundleId(resolveStashDir()), withContent: false });
      const picked =
        status === "pending"
          ? all
              .filter((p) => p.status === "pending")
              .sort((a, b) => Date.parse(proposalWaitingSince(a)) - Date.parse(proposalWaitingSince(b)))
          : all
              .filter((p) => RECENT_STATUSES.has(p.status))
              .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      const bySource: Record<string, number> = {};
      for (const proposal of picked) bySource[proposal.source] = (bySource[proposal.source] ?? 0) + 1;
      const filtered = picked.filter(
        (p) =>
          (!source || p.source === source) &&
          (!age || proposalAgeBand(p, now) === age) &&
          (!week || weekOf(decidedAt(p)) === week) &&
          (!outcome || classifyOutcome(p) === outcome),
      );
      return {
        available: true as const,
        status,
        totalCount: filtered.length,
        fullCount: picked.length,
        bySource,
        backlog: proposalBacklog(picked, now),
        proposals: filtered.slice(0, limit).map(summary),
      };
    }, null) ?? stateDbUnavailable()
  );
}

/** True when the proposal's target is an env or secret asset, whose content never leaves the machine's files via the UI. */
function targetsSensitiveAsset(proposal: Proposal): boolean {
  const ref = proposal.changes[0]?.ref;
  if (ref === undefined) return false;
  try {
    const { type } = parsePlacementRef(ref);
    return type === "env" || type === "secret";
  } catch {
    return false;
  }
}

/**
 * The diff for the detail view: akm's unified text plus both sides, so the client can line them up itself.
 * `before`/`after` come from the same read as `unified` ({@link diffLoadedProposal}); they are `null` for a retire
 * proposal (the file leaves, nothing is proposed) and, with `redacted`, for an env or secret target.
 */
function proposalDiffView(proposal: Proposal) {
  const result = diffLoadedProposal(loadConfig(), proposal);
  const base = { isNew: result.isNew, targetPath: result.targetPath ?? null };
  if (targetsSensitiveAsset(proposal)) {
    return {
      unified: "Env and secret values are never shown in the UI.",
      ...base,
      before: null,
      after: null,
      truncated: false,
      redacted: true,
    };
  }
  if (isRetireProposal(proposal)) {
    return { unified: result.unified, ...base, before: null, after: null, truncated: false, redacted: false };
  }
  const before = capSide(result.existing);
  const after = capSide(result.proposed);
  return {
    unified: result.unified,
    ...base,
    before: before.text,
    after: after.text,
    truncated: before.truncated || after.truncated,
    redacted: false,
  };
}

export function get(input: { id: string }) {
  const { id } = input;
  const detail = withReadonlyStateDb((db) => {
    const proposal = resolveProposalIdIn(db, resolveStashDir(), id);
    let diff: ReturnType<typeof proposalDiffView> | null = null;
    let diffError: string | null = null;
    try {
      diff = proposalDiffView(proposal);
    } catch (error) {
      diffError = error instanceof Error ? error.message : String(error);
    }
    // Content lives in the diff; `backupContent` is "never shown" by contract and the accept intent is internal.
    const { backupContent: _backup, retireAcceptIntent: _intent, payload, changes, ...rest } = proposal;
    return {
      proposal: {
        ...summary(proposal),
        ...rest,
        payload: { frontmatter: payload.frontmatter ?? null },
        changes: changes.map((change) => ({ op: change.op, ref: change.ref })),
      },
      validation: validateProposal(proposal),
      diff,
      diffError,
    };
  }, null);
  if (!detail) throw new NotFoundError(`Proposal "${id}" not found: state.db is not available.`, "PROPOSAL_NOT_FOUND");
  return detail;
}

export async function recentChanges(input: { limit?: number } = {}) {
  const limit = clampLimit(input.limit);
  const target = resolveWriteTarget(loadConfig(), undefined, { requireWritable: false });
  const root = target.source.path;
  const read = root === undefined ? null : await readRecentCommits(root, limit);
  return {
    bundle: target.source.name,
    path: root ?? null,
    git: read !== null,
    commits: read?.commits ?? [],
    ...(read?.error ? { error: read.error } : {}),
  };
}

// ── Decisions ────────────────────────────────────────────────────────────────

function acceptedView(result: ProposalAcceptResult) {
  return { ...result, proposal: summary(result.proposal) };
}

function rejectReason(reason: unknown): string {
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new UsageError('A rejection needs a reason: {"reason": "..."}.', "MISSING_REQUIRED_ARGUMENT");
  }
  const trimmed = reason.trim();
  if (trimmed.length > MAX_REJECT_REASON) {
    throw new UsageError(`The reason is too long (${trimmed.length} characters; at most ${MAX_REJECT_REASON}).`);
  }
  return trimmed;
}

function batchIds(ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BATCH_IDS) {
    throw new UsageError(`"ids" must be a list of 1 to ${MAX_BATCH_IDS} proposal ids.`, "MISSING_REQUIRED_ARGUMENT");
  }
  for (const id of ids) {
    if (typeof id !== "string" || id.trim() === "" || id.length > 200) {
      throw new UsageError('Every entry of "ids" must be a non-empty proposal id string.');
    }
  }
  return [...new Set((ids as string[]).map((id) => id.trim()))];
}

/** Accept one proposal exactly as `akm proposal accept` does; the result carries the commit it made, or why none. */
export async function accept(input: { id: string }) {
  return interactive("ui-proposal-accept", async () => acceptedView(await akmProposalAccept({ id: input.id })));
}

export async function reject(input: { id: string; reason: string }) {
  const reason = rejectReason(input.reason);
  return interactive("ui-proposal-reject", async () => {
    const result = await akmProposalReject({ id: input.id, reason });
    return { ...result, proposal: summary(result.proposal) };
  });
}

export async function revert(input: { id: string }) {
  return interactive("ui-proposal-revert", async () => {
    const result = await akmProposalRevert({ id: input.id });
    return { ...result, proposal: summary(result.proposal) };
  });
}

export async function reopen(input: { id: string }) {
  return interactive("ui-proposal-reopen", async () => {
    const [result] = await akmProposalReopen({ ids: [input.id] });
    if (!result) throw new UsageError("The proposal was not reopened.");
    return { ...result, proposal: summary(result.proposal) };
  });
}

/** One shared reason; each proposal is decided on its own, so one failure leaves the rest rejected. */
export async function rejectMany(input: { ids: string[]; reason: string }) {
  const ids = batchIds(input.ids);
  const reason = rejectReason(input.reason);
  return interactive("ui-proposal-reject", async () => {
    const results: Array<Record<string, unknown>> = [];
    for (const id of ids) {
      try {
        const result = await akmProposalReject({ id, reason });
        results.push({ ok: true, id: result.id, ref: result.ref, proposal: summary(result.proposal) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          ok: false,
          id,
          error: message,
          code: error instanceof AkmError ? error.code : "INTERNAL_ERROR",
        });
      }
    }
    const rejected = results.filter((r) => r.ok).length;
    return { rejected, failed: results.length - rejected, results };
  });
}

export async function acceptMany(input: { ids: string[] }) {
  const ids = batchIds(input.ids);
  return interactive("ui-proposal-accept", async () => {
    const results = await akmProposalAcceptMany({ ids });
    const accepted = results.filter((r): r is ProposalAcceptResult => r.ok);
    return {
      accepted: accepted.length,
      failed: results.length - accepted.length,
      results: results.map((r) => (r.ok ? acceptedView(r) : { ...r, code: r.code ?? "ACCEPT_FAILED" })),
    };
  });
}
